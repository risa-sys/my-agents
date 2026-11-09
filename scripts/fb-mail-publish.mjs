/**
 * メール承認からの公開(1件)。承認画面の「公開する」で fb-mail-publish.yml が起動され、これを実行する。
 *
 *   node scripts/fb-mail-publish.mjs publish --draft <投稿案ID>
 *
 * 流れ:
 *   1. Apps Script から承認済みの内容を受け取る(署名つき・受け取りは1回だけ。「公開する」が押された投稿案だけ)
 *   2. 内容・承認(承認/修正して承認)・投稿先・重複・商品(販売状況・商品ID・画像)を確かめる
 *   3. FB_MAIL_PUBLISH_ENABLED=true のときだけ、1件だけ即時公開する(fb-immediate.mjs。即時公開テストと同じ処理)
 *      それ以外は確認だけして、結果を「確認のみ」として知らせる
 *   4. 結果を fb-history の mailPosts に記録し、Apps Script に知らせる(承認画面とメールに表示される)
 *
 * 公開のログには、公開前の投稿案の中身(本文・商品名)を出さない(詳細は承認メールの宛先にだけ送る)。
 * 毎日の予約投稿(fb-publish.mjs)には組み込まない。
 *
 * 7日分(予定日時に自動公開):
 *   node scripts/fb-mail-publish.mjs scheduled [--date YYYY-MM-DD]
 *   fb-mail-scheduled.yml が毎日 18:00(日本時間)前後に実行する。18:00 より前に起動したら 18:00 まで待つ。
 *   その日の投稿案を Apps Script から受け取り(承認済みだけ・1回だけ)、上と同じ確認をしてから1件だけ公開する。
 *   未承認は Apps Script が「確認待ち」にして知らせる。18:00 から2時間を過ぎたら公開しない。
 *   公開するのは FB_MAIL_PUBLISH_ENABLED=true のときだけ(それ以外は確認のみ)。
 */
import { appendFileSync } from 'node:fs';
import { checkEdit, splitMessage } from './fb-review-rules.mjs';
import { hashOf } from './fb-review-ui.mjs';
import { createHistoryStore } from './fb-history-store.mjs';
import { callGas, checkGasUrl } from './fb-mail-sign.mjs';
import { jstDate, jstAt } from './fb-publish-core.mjs';
import {
  TEST, REMOTE, BRANCH, now, setupProblems, contentHash, validateContent, shopAvailable, createImmediateGraph, publishOnce
} from './fb-immediate.mjs';

const lines = [];
function log(m) {
  console.log(m);
  lines.push(m);
}
function summary() {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n\n') + '\n');
}
const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';

/** 公開前に断るときの理由(詳細はメールにだけ送る) */
class Refusal extends Error {}

/** 受け取った内容が、承認画面で確定したものと一致するか(承認・修正して承認のルールも確かめ直す) */
function checkApproved(c, draftId, pageId) {
  const errors = [];
  if (c.draftId !== draftId) errors.push('投稿案IDが一致しません');
  if (String(c.pageId) !== pageId) errors.push(`承認画面に表示した投稿先(${c.pageId})と、公開する投稿先が一致しません`);
  if (c.hash !== contentHash(c)) errors.push('承認用のハッシュが内容と一致しません');
  if (c.originalHash !== hashOf(c.originalMessage)) errors.push('元の投稿文のハッシュが一致しません');
  if (c.action === 'approve') {
    if (c.message !== c.originalMessage) errors.push('承認(修正なし)なのに投稿文が元の投稿文と違います');
  } else if (c.action === 'edit') {
    const parts = splitMessage(c.message);
    const r = checkEdit({ body: parts.body, extraTags: parts.hashtags.slice(2), original: c.originalMessage, source: c.source, postDate: c.postDate });
    if (r.errors.length) errors.push(`修正した投稿文がルールに合いません: ${r.errors.join(' / ')}`);
  } else {
    errors.push(`承認されていない投稿案です(${c.action})`);
  }
  return errors;
}

function setup() {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = String(process.env.FB_PAGE_ID || '');
  const gasUrl = process.env.FB_MAIL_GAS_URL || '';
  const secret = process.env.FB_MAIL_SECRET || '';
  const enabled = process.env.FB_MAIL_PUBLISH_ENABLED === 'true';
  if (!token || !/^\d+$/.test(pageId)) throw new Error('FB_PAGE_ACCESS_TOKEN / FB_PAGE_ID がありません');
  if (!secret) throw new Error('FB_MAIL_SECRET がありません');
  checkGasUrl(gasUrl, { allowLoopback: TEST });
  const gas = (action, payload) => callGas({ url: gasUrl, secret, action, payload, now });
  return { token, pageId, enabled, gas };
}

async function cmdPublish(draftId) {
  if (!/^[0-9a-f]{32}$/.test(String(draftId))) throw new Error('投稿案IDが不正です');
  const ctx = setup();
  log(`### メール承認からの公開(投稿案ID: ${draftId})${ctx.enabled ? '' : ' — 確認のみ(FB_MAIL_PUBLISH_ENABLED が true ではないため投稿しません)'}`);
  // 1. 承認済みの内容を受け取る(1回だけ)
  let c;
  try {
    c = (await ctx.gas('getApproved', { draftId })).content;
  } catch (e) {
    throw new Error(`承認済みの内容を受け取れなかったため、何も送っていません: ${e.message}`);
  }
  await publishApproved(ctx, c, draftId);
}

const SCHEDULE_CLOCK = '18:00';
const MAX_WAIT_MS = 30 * 60 * 1000; // 18:00 より前に起動したときに待つ上限

/** 予定日時の公開(7日分)。その日の承認済みの投稿案だけを公開する */
async function cmdScheduled(dateArg) {
  const date = dateArg || jstDate(now());
  if (!/^d{4}-d{2}-d{2}$/.test(date)) throw new Error('日付が不正です');
  const ctx = setup();
  const at = jstAt(date, SCHEDULE_CLOCK);
  log(`### 予定日時の公開(${date} ${SCHEDULE_CLOCK} 日本時間)${ctx.enabled ? '' : ' — 確認のみ(FB_MAIL_PUBLISH_ENABLED が true ではないため投稿しません)'}`);
  const wait = at - now();
  if (wait > MAX_WAIT_MS) {
    log('公開予定時刻より前のため、何もしません');
    return;
  }
  if (wait > 0) {
    log(`公開予定時刻まで ${Math.ceil(wait / 1000)} 秒待ちます`);
    await new Promise(r => setTimeout(r, wait + 1000));
  }
  let reply;
  try {
    reply = await ctx.gas('claimScheduled', { postDate: date });
  } catch (e) {
    throw new Error(`予定の投稿案を受け取れなかったため、何も送っていません: ${e.message}`);
  }
  const notes = {
    none: 'この日の公開予定の投稿案はありません',
    rejected: 'この日の投稿案は却下されているため、公開しません',
    not_approved: '予定時刻までに承認されなかったため公開しません(確認待ち。メールで知らせました)',
    too_late: '公開予定時刻から時間がたちすぎたため公開しません(メールで知らせました)',
    too_early: '公開予定時刻より前のため、何もしません',
    already: `この日の投稿案はすでに処理済みです(${reply.state || ''})`
  };
  if (reply.status !== 'claimed') {
    log(notes[reply.status] || `公開しません(${reply.status})`);
    return;
  }
  const c = reply.content;
  if (c.postDate !== date || Number(c.scheduledAt) !== at) throw new Error('受け取った投稿案の公開予定が一致しません(何も送っていません)');
  await publishApproved(ctx, c, c.draftId, { postDate: date, scheduled: true });
}

/** 受け取った承認済みの内容を確かめ、1件だけ公開する(FB_MAIL_PUBLISH_ENABLED が true でなければ確認のみ) */
async function publishApproved({ token, pageId, enabled, gas }, c, draftId, extra = {}) {
  const report = async (result, fields = {}) => {
    try {
      await gas('report', { draftId, result, runUrl, ...fields });
    } catch (e) {
      log(`⚠ 結果を承認画面に知らせられませんでした(${e.message})。結果は fb-history とこの実行の記録で確認してください`);
    }
  };

  const content = { productId: String(c.productId), url: c.url, image: c.image, message: c.message };

  const store = createHistoryStore({ remote: REMOTE, branch: BRANCH, dryRun: !enabled, log });
  try {
    // 2. 確認(公開前)
    const errors = checkApproved({ ...c, pageId: c.pageId }, draftId, pageId);
    const { history } = store.load();
    errors.push(...validateContent(content, history));
    const same = (history.mailPosts || []).filter(t => t.draftId === draftId && t.result !== 'not_published');
    if (same.length) errors.push(`この投稿案はすでに公開処理の記録があります(${same.map(t => `${t.at} ${t.result}`).join(', ')})。二度目は送りません`);
    if (extra.postDate) {
      // 同じ日付への二重投稿を防ぐ(7日分の公開・毎日の予約投稿の記録)
      const sameDay = (history.mailPosts || []).filter(t => t.scheduled && t.postDate === extra.postDate && t.result !== 'not_published');
      if (sameDay.length) errors.push(`${extra.postDate} はすでに予定日時の公開の記録があります。二度目は送りません`);
      const daily = history.entries.filter(e => e.postDate === extra.postDate && !['candidate', 'rejected'].includes(e.status));
      if (daily.length) errors.push(`${extra.postDate} には毎日の予約投稿の記録(${daily.map(e => e.status).join(', ')})があります。同じ日には公開しません`);
    }
    if (errors.length) throw new Refusal(errors.join(' / '));
    const shop = await shopAvailable(content);
    if (shop) throw new Refusal(`商品の確認NG: ${shop}`);
    const g = createImmediateGraph({ token, pageId, approved: content });
    const page = await g.page();
    log(`投稿先: ${page.name}(${page.id})・承認用のハッシュ: ${c.hash}・判断: ${c.action === 'edit' ? '修正して承認' : '承認'}`);

    if (!enabled) {
      log('✓ 送信の条件はすべて満たしています(確認のみ。Facebook には投稿していません)');
      await report('dry_run', { detail: '確認のみ: 承認・内容・投稿先・商品(販売中・商品ID・画像)の確認はすべてOK。FB_MAIL_PUBLISH_ENABLED が true ではないため投稿していません' });
      return;
    }

    // 3. 1件だけ公開(送る前に記録・応答が途切れても送り直さない)
    let r;
    try {
      r = await publishOnce({ graph: g, content, hash: c.hash, pageId, store, listKey: 'mailPosts', record: { draftId, ...extra }, log });
    } catch (e) {
      // 送ったか分からないときは「要確認」にする(自動では送り直さない)
      e.result = e.result || 'unknown';
      await report(e.result, { detail: e.message });
      throw e;
    }
    await report(r.result, { fbPostId: r.postId, permalink: r.permalink, publishedAt: r.publishedAt, detail: r.result === 'published' ? 'Facebook 上で公開を確認しました' : '投稿は作られましたが、公開を確認できません' });
    if (r.result !== 'published') process.exitCode = 1;
  } catch (e) {
    if (e instanceof Refusal) {
      // 詳細(商品名などを含みうる)は承認画面とメールにだけ出す
      await report('refused', { detail: e.message });
      throw new Error('公開の条件を満たさないため、何も送っていません(理由は承認画面とメールに送りました)');
    }
    if (!e.result) await report('refused', { detail: `公開前に止まりました: ${e.message}` });
    throw e;
  }
}

const [cmd, flag, draftId] = process.argv.slice(2);
try {
  const problems = setupProblems();
  if (problems.length) throw new Error(problems.join('\n'));
  if (cmd === 'publish' && flag === '--draft') await cmdPublish(draftId);
  else if (cmd === 'scheduled' && (!flag || flag === '--date')) await cmdScheduled(draftId || '');
  else throw new Error('使い方: node scripts/fb-mail-publish.mjs publish --draft <投稿案ID> / scheduled [--date YYYY-MM-DD]');
} catch (e) {
  log(`エラー: ${e.message}`);
  process.exitCode = 1;
} finally {
  summary();
}
