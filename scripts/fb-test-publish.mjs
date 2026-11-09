/**
 * 本番ページへの「1件だけの即時公開テスト」専用(毎日の予約投稿 fb-publish.mjs とは別。そちらには組み込まない)。
 *
 *   node scripts/fb-test-publish.mjs plan <内容.json>
 *       テスト投稿の内容を確認し、承認用のハッシュを表示する(Facebook には通信しない)
 *   node scripts/fb-test-publish.mjs check [<内容.json>]
 *       投稿先のページID・ページ名を読み取りだけで確認する。内容ファイルを渡すと、商品(販売状況・商品ID・画像)も確かめる
 *   node scripts/fb-test-publish.mjs publish <内容.json>
 *       次の3つがすべて一致したときだけ、1件だけ即時公開する:
 *         FB_TEST_CONFIRM_PAGE_ID = 投稿先のページID(FB_PAGE_ID)
 *         FB_TEST_CONFIRM_HASH    = plan で表示した内容のハッシュ
 *         FB_TEST_CONFIRM_TEXT    = 「今すぐ公開する」
 *       公開後に投稿ID・投稿URLを取得し、公開されたことを読み取りで確かめる。結果は fb-history の testPosts に記録する。
 *       テスト投稿は1回だけ(記録があれば、送れなかったことが確かな失敗のときを除いて二度と送らない)
 *
 * 送信・確認の処理は fb-immediate.mjs(メール承認からの公開と共通)。
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { createHistoryStore } from './fb-history-store.mjs';
import {
  REMOTE, BRANCH, setupProblems, contentHash, validateContent, shopAvailable, createImmediateGraph, publishOnce
} from './fb-immediate.mjs';

const CONFIRM_TEXT = '今すぐ公開する';

const lines = [];
function log(m) {
  console.log(m);
  lines.push(m);
}
function summary() {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n\n') + '\n');
}

function loadContent(path) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c?.kind !== 'fb-test-post' || c.version !== 1) throw new Error('テスト投稿の内容ファイルの形式が違います(kind: fb-test-post, version: 1)');
  return { productId: String(c.productId || ''), url: String(c.url || ''), image: String(c.image || ''), message: String(c.message || '') };
}

// テスト投稿の記録は「すでに行われています」で知らせるので、商品の重複の確認からは除く
const notTestPost = history => t => (history.testPosts || []).includes(t);

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

function cmdPlan(path) {
  const c = loadContent(path);
  let history = null;
  try {
    history = createHistoryStore({ remote: REMOTE, branch: BRANCH, dryRun: true }).load().history;
  } catch (e) {
    log(`(履歴を読めなかったため、承認済みの商品との重複は確認していません: ${e.message})`);
  }
  const errors = validateContent(c, history, history ? { ignore: notTestPost(history) } : {});
  log('### 即時公開テストの内容(Facebook には通信していません)');
  log(`- 商品ID: ${c.productId}\n- 商品URL: ${c.url}\n- 画像(1枚): ${c.image}\n- 本文:\n${c.message.split('\n').map(l => `    ${l}`).join('\n')}`);
  if (errors.length) {
    log(`✗ 内容に問題があります:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  log(`✓ 内容の確認OK。承認用のハッシュ: ${contentHash(c)}`);
}

async function cmdCheck(path) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = String(process.env.FB_PAGE_ID || '');
  if (!token || !/^\d+$/.test(pageId)) throw new Error('FB_PAGE_ACCESS_TOKEN / FB_PAGE_ID がありません');
  const g = createImmediateGraph({ token, pageId, approved: {} });
  const page = await g.page();
  log(`### 投稿先のページ(読み取りのみ)\n- ページ名: ${page.name}\n- ページID: ${page.id}`);
  if (!path) return;

  // 公開前の商品の確認(読み取りのみ): 内容・承認済みの商品との重複・販売状況・商品ID・画像の紐づけ
  const c = loadContent(path);
  const { history } = createHistoryStore({ remote: REMOTE, branch: BRANCH, dryRun: true }).load();
  const errors = validateContent(c, history, { ignore: notTestPost(history) });
  const previous = (history.testPosts || []).filter(t => t.result !== 'not_published');
  if (previous.length) errors.push(`テスト投稿はすでに行われています(${previous.map(t => `${t.at} ${t.result}`).join(', ')})`);
  const shop = await shopAvailable(c);
  if (shop) errors.push(`商品の確認NG: ${shop}`);
  log(`### 公開予定の内容の確認(読み取りのみ)\n- 商品ID: ${c.productId}\n- 商品URL: ${c.url}\n- 画像: ${c.image}\n- 承認用のハッシュ: ${contentHash(c)}`);
  if (errors.length) {
    log(`✗ 公開できない状態です:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  log('✓ 販売中・商品IDと商品URLが一致・画像はこの商品に登録済み・承認済みの商品との重複なし');
}

async function cmdPublish(path) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = String(process.env.FB_PAGE_ID || '');
  if (!token || !/^\d+$/.test(pageId)) throw new Error('FB_PAGE_ACCESS_TOKEN / FB_PAGE_ID がありません');
  const c = loadContent(path);
  const hash = contentHash(c);
  // 明示的な承認(3つすべての一致)が無ければ何もしない
  const confirmErrors = [];
  if (process.env.FB_TEST_CONFIRM_TEXT !== CONFIRM_TEXT) confirmErrors.push(`confirm_text に「${CONFIRM_TEXT}」と入力してください`);
  if (process.env.FB_TEST_CONFIRM_PAGE_ID !== pageId) confirmErrors.push('confirm_page_id が投稿先のページIDと一致しません');
  if (process.env.FB_TEST_CONFIRM_HASH !== hash) confirmErrors.push(`confirm_hash が内容のハッシュと一致しません(内容: ${hash})`);
  if (confirmErrors.length) throw new Error(`承認の確認が一致しないため、何も送っていません:\n${confirmErrors.map(e => `- ${e}`).join('\n')}`);

  const store = createHistoryStore({ remote: REMOTE, branch: BRANCH, dryRun: false, log });
  const { history } = store.load();
  const errors = validateContent(c, history, { ignore: notTestPost(history) });
  const previous = (history.testPosts || []).filter(t => t.result !== 'not_published');
  if (previous.length) errors.push(`テスト投稿はすでに行われています(${previous.map(t => `${t.at} ${t.result}`).join(', ')})。二度目は送りません`);
  if (errors.length) throw new Error(`送ってよい条件を満たさないため、何も送っていません:\n${errors.map(e => `- ${e}`).join('\n')}`);
  const shop = await shopAvailable(c);
  if (shop) throw new Error(`商品の確認NGのため、何も送っていません: ${shop}`);

  const g = createImmediateGraph({ token, pageId, approved: c });
  const page = await g.page();
  log(`投稿先: ${page.name}(${page.id})`);
  const r = await publishOnce({ graph: g, content: c, hash, pageId, store, listKey: 'testPosts', log });
  if (r.result !== 'published') process.exitCode = 1;
}

const [cmd, arg] = process.argv.slice(2);
try {
  const problems = setupProblems();
  if (problems.length) throw new Error(problems.join('\n'));
  if (cmd === 'plan' && arg) cmdPlan(arg);
  else if (cmd === 'check') await cmdCheck(arg);
  else if (cmd === 'publish' && arg) await cmdPublish(arg);
  else throw new Error('使い方: node scripts/fb-test-publish.mjs plan|publish <内容.json> / check [<内容.json>]');
} catch (e) {
  log(`エラー: ${e.message}`);
  process.exitCode = 1;
} finally {
  summary();
}
