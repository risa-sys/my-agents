/**
 * 投稿予約のルール(時刻・送ってよい投稿の条件・状態)。通信はしない。
 *
 * 時刻はすべて日本時間(Asia/Tokyo、UTC+9・夏時間なし)で扱う。
 *
 * 状態の流れ:
 *   approved ─▶ scheduling ─▶ scheduled ─▶ published
 *       │            │              ├─▶ cancelled      (18:35 の確認で売り切れ → 取り消し成功 / Facebook 上で取り消し済み)
 *       │            │              ├─▶ cancel_failed  (取り消しに失敗。至急、手動での取り消しを依頼)
 *       │            │              └─▶ needs_check    (公開時刻を過ぎても公開を確認できない)
 *       │            └─▶ needs_check (送信の応答が途切れ、予約されたか分からない。自動では再送しない)
 *       ├─▶ skipped (売り切れ・期限切れ・確認NG。送らない)
 *       └─▶ failed  (トークン・権限などで送れなかった。自動では再試行しない)
 */
import { RULES, splitMessage } from './fb-review-rules.mjs';
import { hashOf } from './fb-review-ui.mjs';

export const PUBLISH = {
  POST_CLOCK: '19:00', // 公開時刻(日本時間)
  SCHEDULE_FROM: '16:00', // この時刻より前は予約しない(販売状況の確認を公開の直前に近づけるため)
  SCHEDULE_DEADLINE: '18:40', // これを過ぎたら予約しない(遅れて投稿しない。Meta の「10分後以降」にも余裕を持たせる)
  RECHECK_FROM: '18:00', // 予約済みの投稿の販売状況を確認し直す時間帯
  CANCEL_DEADLINE: '18:58', // これを過ぎたら自動では取り消さない(公開と取り消しが重なるのを避ける)
  VERIFY_AFTER_MIN: 5, // 公開時刻からこれだけ過ぎたら、Facebook 上で公開されたかを確認する
  VERIFY_GIVE_UP_MIN: 60, // 公開時刻からこれだけ過ぎても公開を確認できなければ、確認を依頼する
  MAX_ATTEMPTS: 3, // 回数制限などで送れなかったときに、同じ日に試す上限
  SHOP_ORIGIN: 'https://fukushima-ichiba.com',
  IMAGE_HOSTS: ['cdn.shopify.com'],
  MAX_IMAGES: 4
};

export const STATUS_LABELS = {
  candidate: '候補',
  approved: '承認済み',
  rejected: '不採用',
  scheduling: '予約処理中',
  scheduled: '予約済み',
  published: '公開済み',
  cancelled: '予約取り消し',
  cancel_failed: '取り消し失敗',
  needs_check: '要確認',
  skipped: '見送り',
  failed: '送信失敗'
};
export const ALL_STATUSES = Object.keys(STATUS_LABELS);
/** 投稿の処理が始まった(または終わった)状態。生成し直しの対象にしない */
export const LOCKED_STATUSES = ALL_STATUSES.filter(s => !['candidate', 'rejected'].includes(s));
/** 同じ日に、これらの状態の記録が2件以上あってはいけない */
const POSTING_STATUSES = ['approved', 'scheduling', 'scheduled', 'published', 'cancel_failed', 'needs_check'];

export const MOCK_MARKER = '__FB_PREVIEW_MOCK__';

// ---------------------------------------------------------------------------
// 日本時間
// ---------------------------------------------------------------------------

const JST_MS = 9 * 60 * 60 * 1000;
/** その時刻の日本時間の日付(YYYY-MM-DD) */
export const jstDate = ms => new Date(ms + JST_MS).toISOString().slice(0, 10);
/** その時刻の日本時間の時:分(HH:MM) */
export const jstClock = ms => new Date(ms + JST_MS).toISOString().slice(11, 16);
/** 日本時間の日付と時:分 → 時刻(ミリ秒) */
export const jstAt = (ymd, hm) => Date.parse(`${ymd}T${hm}:00+09:00`);
/** 時刻を日本時間の表記にする(例 2026-11-16T19:00:00+09:00) */
export const jstIso = ms => new Date(ms + JST_MS).toISOString().replace(/\.\d{3}Z$/, '+09:00');
export const jstLabel = ms => `${jstDate(ms)} ${jstClock(ms)}(日本時間)`;

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 投稿日の公開時刻(日本時間 19:00) */
export const postTimeOf = postDate => jstAt(postDate, PUBLISH.POST_CLOCK);

// ---------------------------------------------------------------------------
// 送ってよい投稿か
// ---------------------------------------------------------------------------

export const entryKey = e => `${e.postDate}|${e.productId}`;
export const findEntry = (history, key) => history.entries.find(e => entryKey(e) === key);

function handleOf(url) {
  const m = String(url || '').match(/^https:\/\/fukushima-ichiba\.com\/products\/([A-Za-z0-9_\-%.]+)$/);
  return m ? decodeURIComponent(m[1]) : '';
}
export { handleOf };

/** 承認したときの投稿文から変わっていないか(承認後に書き換えられていないか) */
function approvedIntegrity(e) {
  const action = e.decision?.action;
  if (e.approvedHash) return hashOf(e.message) === e.approvedHash ? '' : '承認後に投稿文が変わっています(承認時のハッシュと一致しません)';
  if (action === 'approve') return hashOf(e.message) === e.originalHash ? '' : '承認後に投稿文が変わっています(生成時のハッシュと一致しません)';
  // 修正して承認した投稿は、承認時のハッシュが無いと、承認後に書き換えられていないかを確かめられないため送らない
  if (action === 'edit') return '修正して承認した投稿文のハッシュ(approvedHash)がありません(npm run fb:seal で決定内容ファイルから記録してください)';
  return '承認の記録(承認・修正して承認)がありません';
}

/**
 * 承認済みの投稿を Facebook に送ってよいか(Shopify の確認の前に行う、記録だけでの確認)。
 * 1つでも満たさなければ送らない。
 */
export function checkEntryForPosting(e, history) {
  const errors = [];
  if (e.status !== 'approved') errors.push(`状態が承認済みではありません(${STATUS_LABELS[e.status] || e.status})`);
  if (!['approve', 'edit'].includes(e.decision?.action)) errors.push('承認の記録がありません');
  if (e.factCheck !== 'passed') errors.push('事実確認に合格していません');
  if (e.dataSource === 'mock' || String(e.message || '').includes(MOCK_MARKER) || /\.test\.json$/.test(String(e.historyFile || ''))) errors.push('テスト用データです');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.postDate || ''))) errors.push('投稿日が不正です');
  if (!/^\d+$/.test(String(e.productId || ''))) errors.push('商品IDが不正です');
  const handle = handleOf(e.url);
  if (!handle) errors.push(`商品URLが ${PUBLISH.SHOP_ORIGIN}/products/… の形ではありません`);
  const parts = splitMessage(e.message || '');
  if (!parts.body) errors.push('本文がありません');
  if (parts.url !== e.url) errors.push('投稿文の商品URLが記録の商品URLと一致しません');
  if (parts.hashtags.length !== RULES.FIXED_HASHTAGS.length + RULES.EXTRA_HASHTAGS
    || RULES.FIXED_HASHTAGS.some((t, i) => parts.hashtags[i] !== t)) errors.push('ハッシュタグが「固定2個+商品2個」の形ではありません');
  if (/https?:\/\//.test(parts.body)) errors.push('本文に商品URL以外のURLがあります');
  const ng = RULES.NG_PHRASES.filter(p => parts.body.includes(p));
  if (ng.length) errors.push(`誇張表現があります: ${ng.join('、')}`);
  const images = Array.isArray(e.images) ? e.images : [];
  if (images.length === 0) errors.push('画像がありません');
  if (images.length > PUBLISH.MAX_IMAGES) errors.push(`画像が多すぎます(${images.length}枚)`);
  for (const src of images) {
    let u;
    try {
      u = new URL(src);
    } catch {}
    if (!u || u.protocol !== 'https:' || !PUBLISH.IMAGE_HOSTS.includes(u.host)) errors.push(`Shopifyの画像配信サーバー以外の画像です: ${src}`);
  }
  const integrity = approvedIntegrity(e);
  if (integrity) errors.push(integrity);
  if (e.publish?.fbPostId) errors.push(`すでに Facebook の投稿ID(${e.publish.fbPostId})が記録されています`);
  const sameDay = history.entries.filter(x => x.postDate === e.postDate && POSTING_STATUSES.includes(x.status));
  if (sameDay.length > 1) errors.push(`同じ日(${e.postDate})に投稿予定の記録が${sameDay.length}件あります`);
  return errors;
}

/** Facebook の予約・公開済み投稿の中から、この記録の投稿を探す(本文と予約日時で照合) */
export function matchRemotePost(posts, e) {
  const want = normalizeForMatch(e.message);
  const at = Math.floor(postTimeOf(e.postDate) / 1000);
  return (posts || []).find(p => {
    const sameText = normalizeForMatch(p.message) === want;
    const t = Number(p.scheduled_publish_time) || (p.created_time ? Math.floor(Date.parse(p.created_time) / 1000) : 0);
    return sameText && Math.abs(t - at) <= 15 * 60;
  }) || null;
}

/** 同じ公開時刻の予約が別にあるか(本文は違っても、二重投稿の疑いとして扱う) */
export function sameTimeRemotePosts(posts, e) {
  const at = Math.floor(postTimeOf(e.postDate) / 1000);
  return (posts || []).filter(p => Number(p.scheduled_publish_time) === at);
}

function normalizeForMatch(s) {
  return String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t　]+$/gm, '').trim();
}

export function messageHash(message) {
  return hashOf(message);
}
