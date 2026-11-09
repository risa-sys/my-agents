/**
 * 1件だけの即時公開(写真投稿)の共通処理。
 * 即時公開テスト(fb-test-publish.mjs)とメール承認からの公開(fb-mail-publish.mjs)で使う。
 * 毎日の予約投稿(fb-publish.mjs)には組み込まない。
 *
 * - 送れる操作は「画像1枚+本文の写真投稿(POST /{page-id}/photos, published=true)」1回だけ。
 *   送る値(画像URL・本文)は承認した内容と完全に一致するものに限り、それ以外の送信はすべて遮断する
 * - 送る前に fb-history に記録する(応答が途切れても二度目を送らないため)
 * - 応答が途切れたら送り直さず、公開済みの投稿から探す
 * - 公開後は投稿を読み取り、公開されたことを確かめて記録する
 */
import { createHash } from 'node:crypto';
import { RULES, splitMessage } from './fb-review-rules.mjs';
import { remoteIsLocalTest } from './fb-history-store.mjs';
import { jstIso, jstLabel } from './fb-publish-core.mjs';

const GRAPH_API_VERSION = 'v26.0';
export const TEST = process.env.FB_PUBLISH_TEST === '1';
export const REMOTE = process.env.FB_HISTORY_REMOTE || 'origin';
export const BRANCH = process.env.FB_HISTORY_BRANCH || 'fb-history';
export const isLoopback = u => {
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
const GRAPH = TEST ? process.env.FB_GRAPH_BASE : 'https://graph.facebook.com';
const SHOP_BASE = TEST ? process.env.FB_SHOP_BASE : null;
const nowBase = TEST && process.env.FB_NOW ? Date.parse(process.env.FB_NOW) : null;
const startedAt = Date.now();
export const now = () => (nowBase === null ? Date.now() : nowBase + (Date.now() - startedAt));
const TIMEOUT_MS = TEST && process.env.FB_GRAPH_TIMEOUT_MS ? Number(process.env.FB_GRAPH_TIMEOUT_MS) : 30000;

/** テスト用の差し替え(モックサーバー・ローカルの履歴)は FB_PUBLISH_TEST=1 のときだけ使える */
export function setupProblems() {
  const p = [];
  if (!TEST) {
    for (const v of ['FB_GRAPH_BASE', 'FB_SHOP_BASE', 'FB_NOW', 'FB_GRAPH_TIMEOUT_MS']) if (process.env[v]) p.push(`${v} はテストでだけ使えます`);
  } else {
    if (!isLoopback(process.env.FB_GRAPH_BASE || '')) p.push('テストでは FB_GRAPH_BASE にモックサーバーを指定してください');
    if (!isLoopback(process.env.FB_SHOP_BASE || '')) p.push('テストでは FB_SHOP_BASE にモックサーバーを指定してください');
    if (!remoteIsLocalTest(REMOTE)) p.push('テストでは FB_HISTORY_REMOTE にローカルのテスト用リポジトリを指定してください');
  }
  return p;
}

// ---------------------------------------------------------------------------
// 内容の確認
// ---------------------------------------------------------------------------

/** 承認用のハッシュ(本文・画像・商品URL・商品IDのどれかが変われば変わる) */
export function contentHash(c) {
  return createHash('sha256').update(JSON.stringify([c.productId, c.url, c.image, c.message])).digest('hex').slice(0, 16);
}

/**
 * 商品が投稿・公開の記録にあるか(承認済みの週の投稿・即時公開テスト・メール承認からの公開)。
 * 不採用・「公開されていないことが確か」の記録は数えない。ignore(記録)は自分自身の記録を除くときに使う
 */
export function productUsage(history, productId, ignore = () => false) {
  const id = String(productId);
  return [
    ...history.entries.filter(e => String(e.productId) === id && e.status !== 'rejected').map(e => `${e.postDate} ${e.status}`),
    ...(history.testPosts || []).filter(t => String(t.productId) === id && t.result !== 'not_published' && !ignore(t)).map(t => `即時公開テスト ${t.result}`),
    ...(history.mailPosts || []).filter(t => String(t.productId) === id && t.result !== 'not_published' && !ignore(t)).map(t => `メール承認 ${t.result}`)
  ];
}

export function validateContent(c, history, { ignore } = {}) {
  const errors = [];
  if (!/^\d+$/.test(c.productId)) errors.push('商品IDが不正です');
  if (!/^https:\/\/fukushima-ichiba\.com\/products\/[A-Za-z0-9_\-%.]+$/.test(c.url)) errors.push('商品URLが https://fukushima-ichiba.com/products/… の形ではありません');
  let img;
  try {
    img = new URL(c.image);
  } catch {}
  if (!img || img.protocol !== 'https:' || img.host !== 'cdn.shopify.com') errors.push('画像は cdn.shopify.com の画像1枚だけにしてください');
  const parts = splitMessage(c.message);
  if (!parts.body) errors.push('本文がありません');
  if (parts.url !== c.url) errors.push('本文の「▼詳細はこちら」の商品URLが、指定の商品URLと一致しません');
  if (parts.hashtags.length !== 4 || RULES.FIXED_HASHTAGS.some((t, i) => parts.hashtags[i] !== t)) errors.push('ハッシュタグが「#ふくしま市場 #福島県 + 商品2個」の形ではありません');
  if (/https?:\/\//.test(parts.body)) errors.push('本文に商品URL以外のURLがあります');
  const ng = RULES.NG_PHRASES.filter(p => parts.body.includes(p));
  if (ng.length) errors.push(`誇張表現があります: ${ng.join('、')}`);
  if (history) {
    const used = productUsage(history, c.productId, ignore);
    if (used.length) errors.push(`この商品は投稿の記録があるため使いません(${used.join(', ')})。承認済みの投稿とは別の商品にしてください`);
  }
  return errors;
}

/** 公開直前の商品の確認(読み取りのみ)。問題が無ければ空文字 */
export async function shopAvailable(c) {
  const handle = c.url.split('/products/')[1];
  const base = SHOP_BASE || 'https://fukushima-ichiba.com';
  const res = await fetch(`${base}/products/${handle}.js`, { headers: { 'User-Agent': 'fukushima-ichiba-fb-publish/1.0 (+https://fukushima-ichiba.com/)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return `商品データを取得できませんでした(HTTP ${res.status})`;
  const p = await res.json();
  if (String(p.id) !== c.productId) return `商品IDが一致しません(現在 ${p.id})`;
  if (p.available !== true) return '売り切れ・販売停止です';
  const file = new URL(c.image).pathname.split('/').pop();
  if (!(p.images || []).some(s => String(s).split('?')[0].endsWith(`/${file}`))) return '画像がこの商品に登録されていません';
  return '';
}

// ---------------------------------------------------------------------------
// Facebook(この処理専用の、送れる内容を絞った通信)
// ---------------------------------------------------------------------------

export class GraphError extends Error {
  constructor(message, kind, code) {
    super(message);
    this.kind = kind; // 'ambiguous' … 公開されたか分からない / 'definite' … 公開されていない
    this.code = code;
  }
}

export function createImmediateGraph({ token, pageId, approved }) {
  let posted = false;
  // システムユーザーのトークンなら、このページのページアクセストークンに切り替えて使う(メモリ内のみ・出力しない)
  let activeToken = token;
  let resolved = false;
  async function resolvePageToken() {
    resolved = true;
    let me;
    try {
      me = await send('GET', 'me', { fields: 'id' });
    } catch {
      return;
    }
    if (String(me.id) === pageId) return;
    const page = await send('GET', pageId, { fields: 'access_token' });
    if (!page.access_token) throw new GraphError('このページのページアクセストークンを取得できませんでした(システムユーザーにページが割り当てられているか確認してください)', 'definite');
    // ページ用トークンは Secret ではないため GitHub が自動で伏せない。万一出力されても伏せられるよう登録する
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${page.access_token}`);
    activeToken = page.access_token;
  }
  async function call(method, path, params) {
    if (!resolved) await resolvePageToken();
    // 遮断: 読み取り3種と、承認した内容での写真投稿1回だけ
    const readable = [pageId, `${pageId}/published_posts`];
    if (method === 'GET') {
      if (!readable.includes(path) && !/^\d+_\d+$/.test(path)) throw new Error(`遮断しました: GET /${path}`);
    } else if (method === 'POST' && path === `${pageId}/photos`) {
      const keys = Object.keys(params).sort().join(',');
      if (keys !== 'caption,published,url') throw new Error('遮断しました: 写真投稿の指定が不正');
      if (params.published !== 'true' || params.url !== approved.image || params.caption !== approved.message) throw new Error('遮断しました: 承認した内容と一致しません');
      if (posted) throw new Error('遮断しました: 投稿は1回だけです');
      posted = true;
    } else {
      throw new Error(`遮断しました: ${method} /${path}`);
    }
    return send(method, path, params);
  }
  async function send(method, path, params) {
    const qs = new URLSearchParams(params);
    const url = `${GRAPH}/${GRAPH_API_VERSION}/${path}${method === 'GET' ? `?${qs}` : ''}`;
    const init = { method, headers: { Authorization: `Bearer ${activeToken}` } };
    if (method === 'POST') {
      init.body = qs;
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    let res;
    let text;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
    } catch (e) {
      throw new GraphError(`応答がありませんでした(${e.message})`, 'ambiguous');
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (json?.error) {
      const code = Number(json.error.code);
      throw new GraphError(`Facebook のエラー(code ${code}): ${String(json.error.message || '').slice(0, 200)}`, [1, 2].includes(code) ? 'ambiguous' : 'definite', code);
    }
    if (!res.ok || !json) throw new GraphError(`HTTP ${res.status}`, res.status >= 500 || !json ? 'ambiguous' : 'definite');
    return json;
  }
  return {
    page: () => call('GET', pageId, { fields: 'id,name' }),
    post: id => call('GET', id, { fields: 'id,is_published,created_time,permalink_url,message' }),
    published: since => call('GET', `${pageId}/published_posts`, { fields: 'id,message,created_time,permalink_url', since: String(since), limit: '25' }),
    publishPhoto: () => call('POST', `${pageId}/photos`, { url: approved.image, caption: approved.message, published: 'true' })
  };
}

/**
 * 承認した内容を1件だけ即時公開する(呼ぶ前に、承認・内容・商品・重複の確認を済ませておくこと)。
 * 送る前に history[listKey] に記録し、結果も同じ記録に書く。
 * 戻り値: { result: 'published' | 'unverified', postId, permalink, createdTime }
 * 公開されていないことが確かなとき・公開されたか分からないときは例外(e.result に 'not_published' / 'unknown')
 */
export async function publishOnce({ graph, content, hash, pageId, store, listKey, record = {}, log }) {
  const at = jstIso(now());
  store.update({
    apply: h => {
      h[listKey] = [...(h[listKey] || []), { at, hash, productId: content.productId, pageId, ...record, result: 'publishing' }];
    },
    message: `Record immediate ${listKey === 'testPosts' ? 'test ' : ''}post (before sending)`
  });
  const setResult = fields => store.update({
    apply: h => {
      const t = (h[listKey] || []).find(x => x.at === at && x.hash === hash);
      if (!t) return false;
      Object.assign(t, fields);
    },
    message: `Record immediate ${listKey === 'testPosts' ? 'test ' : ''}post result (${fields.result})`
  });

  let postId = '';
  try {
    const r = await graph.publishPhoto();
    postId = String(r.post_id || '');
    if (!postId) postId = `${pageId}_${r.id}`;
  } catch (e) {
    if (e instanceof GraphError && e.kind === 'definite') {
      setResult({ result: 'not_published', error: e.message });
      throw Object.assign(new Error(`公開できませんでした(投稿は作られていません): ${e.message}`), { result: 'not_published' });
    }
    // 公開されたか分からない → 送り直さず、公開済みの投稿から探す
    log(`応答が途切れました(${e.message})。送り直さずに、公開済みの投稿を確認します`);
    let found = null;
    try {
      const list = (await graph.published(Math.floor(now() / 1000) - 600)).data || [];
      found = list.find(p => String(p.message || '').trim() === content.message.trim()) || null;
    } catch {}
    if (!found) {
      setResult({ result: 'unknown', error: e.message });
      throw Object.assign(new Error('公開されたか確認できませんでした。送り直しはしません。Facebook ページの投稿を直接確認してください'), { result: 'unknown' });
    }
    postId = String(found.id);
  }

  // 公開の確認(読み取り)
  const post = await graph.post(postId);
  const ok = post.is_published !== false;
  const result = ok ? 'published' : 'unverified';
  const publishedAt = post.created_time ? jstIso(Date.parse(post.created_time)) : '';
  setResult({ result, fbPostId: postId, permalink: post.permalink_url || '', publishedAt });
  log([
    ok ? '### ✓ 公開しました(Facebook 上で確認済み)' : '### ⚠ 投稿は作られましたが、公開を確認できません',
    `- 投稿ID: ${postId}`,
    `- 投稿URL: ${post.permalink_url || '(取得できませんでした)'}`,
    `- 公開日時: ${post.created_time ? jstLabel(Date.parse(post.created_time)) : '-'}`
  ].join('\n'));
  return { result, postId, permalink: post.permalink_url || '', publishedAt };
}
