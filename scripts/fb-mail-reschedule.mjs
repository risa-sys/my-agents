#!/usr/bin/env node
/**
 * 7日分の投稿案(メール承認)の公開予定日を変える。商品・投稿文・画像・判断はそのまま。
 * Apps Script が承認画面のリンクを作り直し、承認メールを送り直す。Facebook へは一切通信しない。
 *
 *   BATCH_ID=<まとめID> DATES=2026-11-10,2026-11-11,... node scripts/fb-mail-reschedule.mjs
 *   DATES は今の公開予定の早い順に対応する新しい日付(件数も同じ)。
 *   必要: FB_MAIL_GAS_URL / FB_MAIL_SECRET。fb-history(data/fb-post-history.json)は読むだけ。
 */
import { existsSync, readFileSync } from 'node:fs';
import { callGas } from './fb-mail-sign.mjs';

const HISTORY_FILE = process.env.HISTORY_FILE || 'data/fb-post-history.json';
// 候補(未承認)と却下は公開されないので、日付は重なってよい(公開直前にも同じ日付の確認をする)
const FREE_STATUSES = ['candidate', 'rejected'];

async function main() {
  const batchId = String(process.env.BATCH_ID || '').trim();
  const dates = String(process.env.DATES || '').split(/[\s,]+/).filter(Boolean);
  if (!/^[0-9a-f]{32}$/.test(batchId)) throw new Error('BATCH_ID が不正です');
  if (!dates.length || dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error('DATES が不正です(YYYY-MM-DD をカンマ区切り)');
  if (new Set(dates).size !== dates.length) throw new Error('DATES に同じ日付があります');
  const url = process.env.FB_MAIL_GAS_URL;
  const secret = process.env.FB_MAIL_SECRET;
  if (!url || !secret) throw new Error('FB_MAIL_GAS_URL / FB_MAIL_SECRET がありません');

  const history = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : { entries: [] };
  const clash = [];
  for (const e of history.entries || []) {
    if (dates.includes(e.postDate) && !FREE_STATUSES.includes(e.status)) clash.push(`${e.postDate}(${e.status})`);
  }
  for (const p of history.mailPosts || []) {
    if (p.scheduled && dates.includes(p.postDate)) clash.push(`${p.postDate}(メール承認で公開済み)`);
  }
  if (clash.length) throw new Error('投稿履歴の日付と重なります: ' + clash.join(', '));

  const res = await callGas({ url, secret, action: 'reschedule', payload: { batchId, dates } });
  console.log(`### 公開予定日を変更し、承認メールを送り直しました(まとめID: ${batchId})`);
  for (const it of res.items) console.log(`- ${it.postDate} 18:00(日本時間) … ${it.state}`);
  console.log('Facebook には何も送っていません。');
}

main().catch(err => {
  console.error('公開予定日を変更できませんでした: ' + err.message);
  process.exit(1);
});
