/**
 * 「ふくしま市場」Facebookページに下書き投稿を自動作成するエージェント(GitHub Actions版)
 *
 * ふくしま市場の売れ筋ランキング(ranking_top10)を基準に、新着(new-1)も加えた候補から
 * 1商品を選び、Geminiで投稿文を作って Facebookページに「下書き」として保存する。
 * 公開はしない。Meta Business Suite の下書き一覧で内容を確認し、手動で公開する。
 *
 * MODE(環境変数):
 *   preview … 投稿文を生成し、ローカルのHTMLプレビューを書き出すだけ(既定)。
 *             Facebookへは一切通信しない(GET も含めて遮断する)。必要: GEMINI_API_KEY
 *   check   … トークンとページの疎通だけ確認する(読み取りのみ)。必要: FB_PAGE_ACCESS_TOKEN
 *   draft   … 投稿文を生成し、Facebookページに下書きとして保存する。
 *             FB_DRAFT_APPROVAL にページIDを明示的に入れたときだけ動く。
 *             必要: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN, GEMINI_API_KEY, FB_DRAFT_APPROVAL
 *
 * 安全装置:
 *   - Facebook への通信はすべて guardedFacebookFetch を通す。preview では全遮断、check では GET のみ、
 *     書き込みは draft かつ承認済みのときだけ、許可したページの /feed への POST に限る。
 *   - 下書きの送信パラメータは許可リスト方式で、published=false と
 *     unpublished_content_type=DRAFT 以外の値では送信しない(公開・予約投稿は送れない)。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG = {
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  GRAPH_API_VERSION: 'v26.0',
  // draft で書き込みを許可する唯一のページ(ふくしま市場)
  APPROVED_PAGE_ID: '277404605612561',
  PREVIEW_FILE: 'preview/fb-preview.html',
  SHOP_BASE_URL: 'https://fukushima-ichiba.com',
  PRODUCT_SOURCE_PATHS: [
    '/collections/ranking_top10/products.json?limit=20', // 基準: 売れ筋ランキング
    '/collections/new-1/products.json?limit=20'           // 補助: 新着
  ],
  PRODUCT_FALLBACK_PATH: '/products.json?limit=20',
  MAX_CANDIDATE_PRODUCTS: 30,
  // 直近で紹介済みの商品と被らないようにするための履歴(ワークフローがコミットして保存する)
  HISTORY_FILE: 'data/fb-posted-history.json',
  HISTORY_RETENTION_DAYS: 30,
  HISTORY_MAX_ENTRIES: 60,
  TOKEN_WARN_DAYS: 14 // トークンの残り日数がこれを切ったら Issue で知らせる
};

const MODES = ['preview', 'check', 'draft'];
const MODE = process.env.MODE || 'preview';

async function main() {
  if (!MODES.includes(MODE)) {
    throw new Error(`MODE は ${MODES.join(' / ')} のいずれかを指定してください(指定値: ${MODE})。`);
  }
  if (MODE === 'preview') {
    await runPreview();
    return;
  }
  if (MODE === 'draft') assertDraftApproved();

  const token = requireEnv('FB_PAGE_ACCESS_TOKEN');
  if (MODE === 'check') {
    // FB_PAGE_ID が未登録・誤りでも、登録すべきページIDが分かるようにする
    await warnIfTokenExpiresSoon(token);
    const me = await graphGet('me?fields=name,id', token);
    const pages = (await graphGet('me/accounts?fields=name,id', token)).data || [];
    summary([
      `### トークンの持ち主: ${me.name}`,
      `このトークンで扱えるページ(${pages.length}件):`,
      ...pages.map(p => `- ${p.name}: ${p.id}${p.id === process.env.FB_PAGE_ID ? ' ← FB_PAGE_ID と一致' : ''}`)
    ].join('\n'));
    if (!process.env.FB_PAGE_ID) return;
  }
  const pageId = requireEnv('FB_PAGE_ID');

  const page = await resolvePage(pageId, token);
  log(`Facebookページ確認OK: ${page.name} (${pageId})`);
  await warnIfTokenExpiresSoon(token);
  if (MODE === 'check') {
    summary(`### トークン確認OK\n- ページ: ${page.name} (${pageId})`);
    return;
  }

  const products = await collectProductsOrThrow();
  const { draft, product, productUrl } = await composePost(products);
  const postId = await createDraftPost(pageId, page.accessToken, draft.message, productUrl);
  recordProductAsPosted(product.handle);
  log(`Facebook下書き作成完了: ${postId}`);

  summary([
    '### Facebook下書きを作成しました',
    `- 話題: ${draft.theme}`,
    `- 商品: ${product.title}(${product.price}円)`,
    `- 商品ページ: ${productUrl}`,
    `- 投稿ID: ${postId}`,
    '',
    '```',
    draft.message,
    '```',
    '',
    'Meta Business Suite の下書きから確認して、問題なければ手動で公開してください: https://business.facebook.com/latest/posts?tab=drafts'
  ].join('\n'));
}

/**
 * Facebookに一切通信せず、投稿文を生成してローカルのHTMLプレビューに書き出す。
 * 紹介済み履歴も更新しない。
 */
async function runPreview() {
  const products = await collectProductsOrThrow();
  const { draft, product, productUrl } = await composePost(products);
  const file = resolve(CONFIG.PREVIEW_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderPreviewHtml({ draft, product, productUrl, candidateCount: products.length }));

  summary([
    '### 投稿文プレビュー(Facebookには送信していません)',
    `- 話題: ${draft.theme}`,
    `- 商品: ${product.title}(${product.price}円)`,
    `- 商品ページ: ${productUrl}`,
    `- 画像: ${product.image || '(なし)'}`,
    '',
    '```',
    draft.message,
    '```',
    '',
    `プレビュー: ${pathToFileURL(file).href}`
  ].join('\n'));
}

async function collectProductsOrThrow() {
  const products = await collectCandidateProducts();
  if (products.length === 0) {
    throw new Error('ふくしま市場の商品情報を取得できませんでした。サイト構成が変わっていないか確認してください。');
  }
  return products;
}

async function composePost(products) {
  const draft = await generateDraftWithGemini(products);
  const product = products.find(p => p.handle === draft.product_handle) || products[0];
  const productUrl = `${CONFIG.SHOP_BASE_URL}/products/${product.handle}`;
  return { draft, product, productUrl };
}

function renderPreviewHtml({ draft, product, productUrl, candidateCount }) {
  const generatedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const paramRows = Object.entries(draftPostParams(draft.message, productUrl))
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="pre">${esc(v)}</td></tr>`).join('');
  const domain = new URL(productUrl).hostname.toUpperCase();
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Facebook投稿プレビュー</title>
<style>
  :root { --bg:#f0f2f5; --card:#fff; --text:#050505; --sub:#65676b; --line:#ced0d4; --link:#f0f2f5; --warn:#fff4e5; --warn-line:#f0b45a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#18191a; --card:#242526; --text:#e4e6eb; --sub:#b0b3b8; --line:#3e4042; --link:#3a3b3c; --warn:#3a2d17; --warn-line:#a87b2f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  a { color:#1877f2; }
  .notice { background:var(--warn); border:1px solid var(--warn-line); border-radius:8px; padding:10px 12px; font-size:14px; margin-bottom:16px; }
  .post { background:var(--card); border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,.2); overflow:hidden; }
  .head { display:flex; gap:8px; align-items:center; padding:12px 16px 0; }
  .avatar { width:40px; height:40px; border-radius:50%; background:#1877f2; color:#fff; display:grid; place-items:center; font-weight:700; }
  .name { font-weight:600; font-size:15px; }
  .meta { color:var(--sub); font-size:13px; }
  .message { padding:12px 16px; white-space:pre-wrap; font-size:15px; line-height:1.4; overflow-wrap:anywhere; }
  .card { display:block; color:inherit; text-decoration:none; border-top:1px solid var(--line); }
  .card img { display:block; width:100%; aspect-ratio:1.91/1; object-fit:cover; background:var(--line); }
  .card .noimg { aspect-ratio:1.91/1; display:grid; place-items:center; color:var(--sub); background:var(--link); }
  .card .info { background:var(--link); padding:10px 12px; }
  .card .domain { color:var(--sub); font-size:12px; }
  .card .title { font-weight:600; font-size:16px; margin-top:2px; }
  h2 { font-size:15px; margin:24px 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:13px; background:var(--card); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; vertical-align:top; padding:6px 10px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  th { width:34%; color:var(--sub); font-weight:500; }
  td.pre { white-space:pre-wrap; }
</style>
</head>
<body>
<main>
  <div class="notice">これはローカルのプレビューです。Facebookには何も送信していません。</div>
  <article class="post">
    <div class="head">
      <div class="avatar">ふ</div>
      <div><div class="name">ふくしま市場</div><div class="meta">プレビュー · ${esc(generatedAt)}</div></div>
    </div>
    <div class="message">${esc(draft.message)}</div>
    <a class="card" href="${esc(productUrl)}" target="_blank" rel="noopener">
      ${product.image ? `<img src="${esc(product.image)}" alt="${esc(product.title)}">` : '<div class="noimg">画像なし</div>'}
      <div class="info"><div class="domain">${esc(domain)}</div><div class="title">${esc(product.title)}</div></div>
    </a>
  </article>

  <h2>内容</h2>
  <table>
    <tr><th>話題</th><td>${esc(draft.theme)}</td></tr>
    <tr><th>商品</th><td>${esc(product.title)}(${esc(product.price)}円)</td></tr>
    <tr><th>商品ページ</th><td><a href="${esc(productUrl)}" target="_blank" rel="noopener">${esc(productUrl)}</a></td></tr>
    <tr><th>画像URL</th><td>${product.image ? `<a href="${esc(product.image)}" target="_blank" rel="noopener">${esc(product.image)}</a>` : '(なし)'}</td></tr>
    <tr><th>文字数</th><td>${[...draft.message].length}文字</td></tr>
    <tr><th>候補商品数</th><td>${candidateCount}件</td></tr>
  </table>

  <h2>draft モードで送信される場合のパラメータ(今回は未送信)</h2>
  <table>${paramRows}<tr><th>access_token</th><td>(表示しません)</td></tr></table>
  <p class="meta">画像はFacebookがリンク先ページから自動取得するため、実際の表示はこのプレビューと異なる場合があります。</p>
</main>
</body>
</html>
`;
}

function esc(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, c => map[c]);
}

/**
 * draft の実行には、FB_DRAFT_APPROVAL にページIDを明示的に入れる必要がある。
 * 入力ミスや既定値で下書きが作られないよう、対象ページも APPROVED_PAGE_ID に固定する。
 */
function assertDraftApproved() {
  const pageId = requireEnv('FB_PAGE_ID');
  if (pageId !== CONFIG.APPROVED_PAGE_ID) {
    throw new Error(`FB_PAGE_ID が許可されたページ(${CONFIG.APPROVED_PAGE_ID})と一致しないため、何も送信せずに中止しました。`);
  }
  if (process.env.FB_DRAFT_APPROVAL !== CONFIG.APPROVED_PAGE_ID) {
    throw new Error(`draft の実行には承認が必要です。FB_DRAFT_APPROVAL に ${CONFIG.APPROVED_PAGE_ID} を指定してください。何も送信せずに中止しました。`);
  }
}

/**
 * Facebook への通信はすべてここを通す。
 * - preview: すべて遮断
 * - check: 読み取り(GET)のみ
 * - draft: GET と、承認済みページの /feed への下書き POST のみ
 */
async function guardedFacebookFetch(url, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  if (MODE === 'preview') {
    throw new Error('preview モードではFacebookへの通信は禁止されています。');
  }
  if (method === 'GET') return fetch(url, init);

  const feedUrl = `https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${CONFIG.APPROVED_PAGE_ID}/feed`;
  if (MODE !== 'draft' || method !== 'POST' || url !== feedUrl) {
    throw new Error(`許可されていないFacebookへの書き込みを遮断しました: ${method} ${url}`);
  }
  assertDraftApproved();
  assertDraftOnlyParams(init.body);
  return fetch(url, init);
}

/**
 * 下書き保存以外のパラメータ(公開・予約など)が含まれていたら送信しない。
 */
function assertDraftOnlyParams(body) {
  if (!(body instanceof URLSearchParams)) throw new Error('下書きの送信パラメータの形式が不正です。');
  const allowed = new Set(['message', 'link', 'published', 'unpublished_content_type', 'access_token']);
  for (const key of new Set(body.keys())) {
    if (!allowed.has(key)) throw new Error(`許可されていないパラメータ "${key}" が含まれるため送信を中止しました。`);
    if (body.getAll(key).length !== 1) throw new Error(`パラメータ "${key}" が重複しているため送信を中止しました。`);
  }
  if (body.get('published') !== 'false') {
    throw new Error('published=false でないため送信を中止しました(公開投稿の防止)。');
  }
  if (body.get('unpublished_content_type') !== 'DRAFT') {
    throw new Error('unpublished_content_type=DRAFT でないため送信を中止しました(予約投稿などの防止)。');
  }
}

/**
 * トークンの有効期限が近いときに警告を出す。
 * 残り TOKEN_WARN_DAYS 日を切ったら GITHUB_OUTPUT に書き出し、ワークフロー側で Issue を立てて知らせる。
 */
async function warnIfTokenExpiresSoon(token) {
  let data;
  try {
    data = (await graphGet(`debug_token?input_token=${encodeURIComponent(token)}`, token)).data;
  } catch (e) {
    log('トークンの有効期限を確認できませんでした: ' + e.message);
    return;
  }
  if (!data || !data.expires_at) return; // 0 = 無期限
  const daysLeft = Math.floor((data.expires_at * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
  const expiresText = new Date(data.expires_at * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  log(`トークンの有効期限: ${expiresText}(残り${daysLeft}日)`);
  if (daysLeft <= CONFIG.TOKEN_WARN_DAYS) {
    console.log(`::warning::Facebookトークンの有効期限が近づいています: ${expiresText}(残り${daysLeft}日)`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `token_expires=${expiresText}\ntoken_days_left=${daysLeft}\n`);
    }
  }
}

/**
 * ページ名を取得してトークンの有効性を確認する。
 * システムユーザーのトークンが渡された場合は、ページアクセストークンに交換する。
 */
async function resolvePage(pageId, token) {
  const json = await graphGet(`${pageId}?fields=name,access_token`, token);
  return { name: json.name, accessToken: json.access_token || token };
}

async function collectCandidateProducts() {
  const byId = new Map();
  for (const path of CONFIG.PRODUCT_SOURCE_PATHS) {
    for (const p of await fetchShopifyProducts(path)) byId.set(p.id, p);
  }
  if (byId.size === 0) {
    for (const p of await fetchShopifyProducts(CONFIG.PRODUCT_FALLBACK_PATH)) byId.set(p.id, p);
  }

  const all = [...byId.values()];
  const posted = getPostedProductHandles();
  let candidates = all.filter(p => !posted.has(p.handle));

  if (candidates.length === 0) {
    // ranking_top10 / new-1 が軒並み紹介済みの場合は、カタログ全体まで候補を広げる
    const fallback = (await fetchShopifyProducts(CONFIG.PRODUCT_FALLBACK_PATH))
      .filter(p => !posted.has(p.handle));
    candidates = fallback.length > 0 ? fallback : all; // それでも無ければ重複を許容する
  }
  return candidates.slice(0, CONFIG.MAX_CANDIDATE_PRODUCTS);
}

async function fetchShopifyProducts(path) {
  try {
    const res = await fetch(CONFIG.SHOP_BASE_URL + path);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.products || [])
      .filter(p => p.variants && p.variants.length > 0 && p.handle)
      .map(p => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        vendor: p.vendor,
        productType: p.product_type,
        tags: Array.isArray(p.tags) ? p.tags.join(', ') : p.tags,
        price: p.variants[0].price,
        image: p.images?.[0]?.src || ''
      }));
  } catch {
    return [];
  }
}

function loadHistory() {
  if (!existsSync(CONFIG.HISTORY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CONFIG.HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function getPostedProductHandles() {
  const cutoff = Date.now() - CONFIG.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return new Set(loadHistory().filter(e => e.postedAt >= cutoff).map(e => e.handle));
}

function recordProductAsPosted(handle) {
  const cutoff = Date.now() - CONFIG.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const history = loadHistory().filter(e => e.postedAt >= cutoff);
  history.push({ handle, postedAt: Date.now() });
  writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history.slice(-CONFIG.HISTORY_MAX_ENTRIES), null, 2) + '\n');
}

async function generateDraftWithGemini(products) {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const dateText = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  }).format(new Date());

  const productListText = products.map(p =>
    `- タイトル: ${p.title} / 価格: ${p.price}円 / 販売者: ${p.vendor} / 種別: ${p.productType} / タグ: ${p.tags} / handle: ${p.handle}`
  ).join('\n');

  const prompt = `
あなたは「ふくしま市場」(福島県産品のオンラインストア、https://fukushima-ichiba.com/)の
公式FacebookページのSNS担当者です。
このFacebook投稿の目的は、読んだ人がふくしま市場のサイトを訪れて商品を購入したくなることです。

今日の日付: ${dateText}

手順:
1. 今日の日付にまつわる話題(記念日・行事・旬の食べ物・季節感など)の中から、
   福島や下記の商品と無理なく繋げられるものを1つ選ぶ。
   広く知られている一般的な話題だけを使い、確信が持てない記念日は使わない
   (不確かな場合は季節感や旬だけを使ってよい)。
2. 下記の商品候補リストの中から、その話題と最も相性が良い商品を1つ選ぶ。
   リストに無い商品は絶対に登場させない。
3. 選んだ話題と商品を絡めた、Facebookページ用の投稿文を書く。

投稿文の条件:
- 日本語。絵文字は控えめに1〜3個まで
- 冒頭数行で興味を引き、商品の魅力(産地・味わい・使い道など)を伝える
- 最後に購入を後押しする一文を入れる(例:「下記リンクからチェックしてみてください」)
- 文末にハッシュタグを3〜5個つける(例: #ふくしま市場 #福島 #お取り寄せグルメ など商品に合わせて選ぶ)
- 全体で200〜400文字程度
- 商品名や産地など、リストに無い情報を捏造しない

出力は次のJSON形式のみ。前後に説明文やコードブロック記号は一切つけないこと。
{"theme": "選んだ話題", "product_handle": "選んだ商品のhandle", "message": "投稿本文"}

商品候補リスト:
${productListText}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  const json = await res.json();
  if (json.error) throw new Error('Gemini APIエラー: ' + JSON.stringify(json.error));

  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = rawText.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  let draft;
  try {
    draft = JSON.parse(cleaned);
  } catch {
    throw new Error('Geminiの出力をJSONとして解析できませんでした: ' + rawText);
  }
  if (!draft.message || !draft.product_handle) {
    throw new Error('Geminiの出力に必要な項目(message / product_handle)がありません: ' + rawText);
  }
  return draft;
}

/**
 * Facebookページに下書き投稿を作成する(公開はしない)。
 * 送信前に guardedFacebookFetch が承認とパラメータを検査する。
 */
async function createDraftPost(pageId, pageToken, message, link) {
  const body = new URLSearchParams({ ...draftPostParams(message, link), access_token: pageToken });
  const res = await guardedFacebookFetch(`https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${pageId}/feed`, {
    method: 'POST',
    body
  });
  const json = await res.json();
  if (json.error) throw new Error('Facebook Graph APIエラー: ' + describeGraphError(json.error));
  return json.id;
}

function draftPostParams(message, link) {
  return { message, link, published: 'false', unpublished_content_type: 'DRAFT' };
}

async function graphGet(path, token) {
  const res = await guardedFacebookFetch(`https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (json.error) throw new Error('Facebook Graph APIエラー: ' + describeGraphError(json.error));
  return json;
}

function describeGraphError(error) {
  const hints = {
    190: 'トークン無効・期限切れ。システムユーザーでトークンを再生成し、FB_PAGE_ACCESS_TOKEN を差し替えてください',
    200: '権限不足。システムユーザーへのページ・アプリの割り当てと、トークンの権限を確認してください',
    10: '権限不足。システムユーザーへのページ・アプリの割り当てと、トークンの権限を確認してください'
  };
  const hint = hints[error.code] ? `\n→ ${hints[error.code]}` : '';
  return `${JSON.stringify(error)}${hint}`;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません(GitHub Secrets を確認してください)。`);
  return value;
}

function log(message) {
  console.log(message);
}

function summary(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
