/**
 * 本番ページへの「1件だけの即時公開テスト」専用(毎日の予約投稿 fb-publish.mjs とは別。そちらには組み込まない)。
 *
 *   node scripts/fb-test-publish.mjs plan <内容.json>
 *       テスト投稿の内容を確認し、承認用のハッシュを表示する(Facebook には通信しない)
 *   node scripts/fb-test-publish.mjs check
 *       投稿先のページID・ページ名を読み取りだけで確認する
 *   node scripts/fb-test-publish.mjs publish <内容.json>
 *       次の3つがすべて一致したときだけ、1件だけ即時公開する:
 *         FB_TEST_CONFIRM_PAGE_ID = 投稿先のページID(FB_PAGE_ID)
 *         FB_TEST_CONFIRM_HASH    = plan で表示した内容のハッシュ
 *         FB_TEST_CONFIRM_TEXT    = 「今すぐ公開する」
 *       公開後に投稿ID・投稿URLを取得し、公開されたことを読み取りで確かめる。結果は fb-history の testPosts に記録する。
 *       テスト投稿は1回だけ(記録があれば、送れなかったことが確かな失敗のときを除いて二度と送らない)
 *
 * 送れる操作は「画像1枚+本文の写真投稿(POST /{page-id}/photos, published=true)」1回だけ。
 * 送る値(画像URL・本文)は承認した内容と完全に一致するものに限る。それ以外の送信はすべて遮断する。
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RULES, splitMessage } from './fb-review-rules.mjs';
import { createHistoryStore, remoteIsLocalTest } from './fb-history-store.mjs';
import { jstIso, jstLabel } from './fb-publish-core.mjs';

const GRAPH_API_VERSION = 'v26.0';
const CONFIRM_TEXT = '今すぐ公開する';
const TEST = process.env.FB_PUBLISH_TEST === '1';
const REMOTE = process.env.FB_HISTORY_REMOTE || 'origin';
const BRANCH = process.env.FB_HISTORY_BRANCH || 'fb-history';
const isLoopback = u => {
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
const now = () => (nowBase === null ? Date.now() : nowBase + (Date.now() - startedAt));
const TIMEOUT_MS = TEST && process.env.FB_GRAPH_TIMEOUT_MS ? Number(process.env.FB_GRAPH_TIMEOUT_MS) : 30000;

const lines = [];
function log(m) {
  console.log(m);
  lines.push(m);
}
function summary() {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n\n') + '\n');
}

function setupProblems() {
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

function loadContent(path) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c?.kind !== 'fb-test-post' || c.version !== 1) throw new Error('テスト投稿の内容ファイルの形式が違います(kind: fb-test-post, version: 1)');
  return { productId: String(c.productId || ''), url: String(c.url || ''), image: String(c.image || ''), message: String(c.message || '') };
}

/** 承認用のハッシュ(本文・画像・商品URL・商品IDのどれかが変われば変わる) */
export function contentHash(c) {
  return createHash('sha256').update(JSON.stringify([c.productId, c.url, c.image, c.message])).digest('hex').slice(0, 16);
}

function validateContent(c, history) {
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
    const used = history.entries.filter(e => String(e.productId) === c.productId && e.status !== 'rejected');
    if (used.length) errors.push(`この商品は投稿の記録があるため使いません(${used.map(e => `${e.postDate} ${e.status}`).join(', ')})。承認済みの投稿とは別の商品にしてください`);
  }
  return errors;
}

async function shopAvailable(c) {
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

class GraphError extends Error {
  constructor(message, kind, code) {
    super(message);
    this.kind = kind; // 'ambiguous' … 公開されたか分からない / 'definite' … 公開されていない
    this.code = code;
  }
}

function createTestGraph({ token, pageId, approved }) {
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
      if (posted) throw new Error('遮断しました: テスト投稿は1回だけです');
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
  const errors = validateContent(c, history);
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
  const g = createTestGraph({ token, pageId, approved: {} });
  const page = await g.page();
  log(`### 投稿先のページ(読み取りのみ)\n- ページ名: ${page.name}\n- ページID: ${page.id}`);
  if (!path) return;

  // 公開前の商品の確認(読み取りのみ): 内容・承認済みの商品との重複・販売状況・商品ID・画像の紐づけ
  const c = loadContent(path);
  const { history } = createHistoryStore({ remote: REMOTE, branch: BRANCH, dryRun: true }).load();
  const errors = validateContent(c, history);
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
  const errors = validateContent(c, history);
  const previous = (history.testPosts || []).filter(t => t.result !== 'not_published');
  if (previous.length) errors.push(`テスト投稿はすでに行われています(${previous.map(t => `${t.at} ${t.result}`).join(', ')})。二度目は送りません`);
  if (errors.length) throw new Error(`送ってよい条件を満たさないため、何も送っていません:\n${errors.map(e => `- ${e}`).join('\n')}`);
  const shop = await shopAvailable(c);
  if (shop) throw new Error(`商品の確認NGのため、何も送っていません: ${shop}`);

  const g = createTestGraph({ token, pageId, approved: c });
  const page = await g.page();
  log(`投稿先: ${page.name}(${page.id})`);

  // 送る前に記録する(応答が途切れても、二度目を送らないため)
  const at = jstIso(now());
  const record = { at, hash, productId: c.productId, pageId, result: 'publishing' };
  store.update({ apply: h => { h.testPosts = [...(h.testPosts || []), record]; }, message: 'Record immediate test post (before sending)' });
  const setResult = fields => store.update({
    apply: h => {
      const t = (h.testPosts || []).find(x => x.at === at && x.hash === hash);
      if (!t) return false;
      Object.assign(t, fields);
    },
    message: `Record immediate test post result (${fields.result})`
  });

  let postId = '';
  try {
    const r = await g.publishPhoto();
    postId = String(r.post_id || '');
    if (!postId) postId = `${pageId}_${r.id}`;
  } catch (e) {
    if (e instanceof GraphError && e.kind === 'definite') {
      setResult({ result: 'not_published', error: e.message });
      throw new Error(`公開できませんでした(投稿は作られていません): ${e.message}`);
    }
    // 公開されたか分からない → 送り直さず、公開済みの投稿から探す
    log(`応答が途切れました(${e.message})。送り直さずに、公開済みの投稿を確認します`);
    let found = null;
    try {
      const list = (await g.published(Math.floor(now() / 1000) - 600)).data || [];
      found = list.find(p => String(p.message || '').trim() === c.message.trim()) || null;
    } catch {}
    if (!found) {
      setResult({ result: 'unknown', error: e.message });
      throw new Error('公開されたか確認できませんでした。送り直しはしません。Facebook ページの投稿を直接確認してください');
    }
    postId = String(found.id);
  }

  // 公開の確認(読み取り)
  const post = await g.post(postId);
  const ok = post.is_published !== false;
  setResult({ result: ok ? 'published' : 'unverified', fbPostId: postId, permalink: post.permalink_url || '', publishedAt: post.created_time ? jstIso(Date.parse(post.created_time)) : '' });
  log([
    ok ? '### ✓ 公開しました(Facebook 上で確認済み)' : '### ⚠ 投稿は作られましたが、公開を確認できません',
    `- 投稿ID: ${postId}`,
    `- 投稿URL: ${post.permalink_url || '(取得できませんでした)'}`,
    `- 公開日時: ${post.created_time ? jstLabel(Date.parse(post.created_time)) : '-'}`
  ].join('\n'));
  if (!ok) process.exitCode = 1;
}

const [cmd, arg] = process.argv.slice(2);
try {
  const problems = setupProblems();
  if (problems.length) throw new Error(problems.join('\n'));
  if (cmd === 'plan' && arg) cmdPlan(arg);
  else if (cmd === 'check') await cmdCheck(arg);
  else if (cmd === 'publish' && arg) await cmdPublish(arg);
  else throw new Error('使い方: node scripts/fb-test-publish.mjs plan|publish <内容.json> / check');
} catch (e) {
  log(`エラー: ${e.message}`);
  process.exitCode = 1;
} finally {
  summary();
}
