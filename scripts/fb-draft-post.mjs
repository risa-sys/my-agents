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
 *   models  … Gemini APIで使えるFlash系モデルを一覧し、実際に呼び出せるか確かめる。
 *             Facebookへは一切通信しない。必要: GEMINI_API_KEY
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
  TOKEN_WARN_DAYS: 14, // トークンの残り日数がこれを切ったら Issue で知らせる
  // 投稿文のルール(公式Xアカウント https://x.com/fukushima_18 の雰囲気に合わせる)
  BODY_MIN_CHARS: 100, // 本文の文字数(改行・URL・ハッシュタグを除く)
  BODY_MAX_CHARS: 180,
  MAX_EMOJI: 2,
  // 誇張・不自然な宣伝文句。含まれていたら作り直させる
  NG_PHRASES: ['最高', '絶品', '今だけ', 'お見逃しなく', '見逃し厳禁', '必見', '激安', '間違いなし', 'ヤバい', 'やばい', '!!', '！！'],
  HASHTAGS: '#ふくしま市場 #福島県',
  MAX_IMAGES: 2,
  GEMINI_MAX_ATTEMPTS: 3, // ルールを外れた本文が返ってきたら、理由を添えて作り直させる
  // 参考にしたい公式Xの投稿文を置くと、文体の手本としてプロンプトに入る(投稿ごとに "---" 行で区切る)
  STYLE_EXAMPLES_FILE: 'data/fb-style-examples.txt',
  RECENT_OPENINGS_COUNT: 10 // 言い回しが続かないよう、直近の書き出しを避けさせる
};

const MODES = ['preview', 'check', 'draft', 'models'];
const MODE = process.env.MODE || 'preview';

async function main() {
  if (!MODES.includes(MODE)) {
    throw new Error(`MODE は ${MODES.join(' / ')} のいずれかを指定してください(指定値: ${MODE})。`);
  }
  if (MODE === 'preview') {
    await runPreview();
    return;
  }
  if (MODE === 'models') {
    await checkGeminiModels();
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
  recordProductAsPosted(product.handle, draft.opening);
  log(`Facebook下書き作成完了: ${postId}`);

  summary([
    '### Facebook下書きを作成しました',
    `- 記念日: ${describeAnniversary(draft)}`,
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
    `- 記念日: ${describeAnniversary(draft)}`,
    `- 商品: ${product.title}(${product.price}円)`,
    `- 商品ページ: ${productUrl}`,
    `- 画像: ${product.images.join(' , ') || '(なし)'}`,
    `- 本文: ${draft.bodyChars}文字 / 絵文字${draft.emojiCount}個`,
    ...draft.warnings.map(w => `- ⚠ ${w}`),
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

/**
 * 投稿の構成: 導入+商品紹介(Geminiが作る本文)→「▼詳細はこちら」→ 商品URL → ハッシュタグ。
 * URLとハッシュタグは誤りが出ないようコード側で付ける。
 */
async function composePost(products) {
  const draft = await generateDraftWithGemini(products);
  const product = products.find(p => p.handle === draft.product_handle) || products[0];
  const productUrl = `${CONFIG.SHOP_BASE_URL}/products/${product.handle}`;
  draft.message = `${draft.body}\n\n▼詳細はこちら\n${productUrl}\n\n${CONFIG.HASHTAGS}`;
  return { draft, product, productUrl };
}

function describeAnniversary(draft) {
  if (!draft.anniversary) return 'なし(通常の商品紹介)';
  return String(draft.anniversary_used) === 'true'
    ? `${draft.anniversary}(使用)`
    : `${draft.anniversary}(関連が弱いため不使用)`;
}

function renderPreviewHtml({ draft, product, productUrl, candidateCount }) {
  const generatedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const paramRows = Object.entries(draftPostParams(draft.message, productUrl))
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="pre">${esc(v)}</td></tr>`).join('');
  const messageHtml = esc(draft.message).replace(esc(productUrl), `<a href="${esc(productUrl)}" target="_blank" rel="noopener">${esc(productUrl)}</a>`);
  const images = product.images.slice(0, CONFIG.MAX_IMAGES);
  const photos = images.length
    ? `<div class="photos n${images.length}">${images.map(src => `<img src="${esc(src)}" alt="${esc(product.title)}">`).join('')}</div>`
    : '<div class="noimg">画像なし</div>';
  const rangeOk = draft.bodyChars >= CONFIG.BODY_MIN_CHARS && draft.bodyChars <= CONFIG.BODY_MAX_CHARS;
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
  .photos { display:grid; gap:2px; }
  .photos.n2 { grid-template-columns:1fr 1fr; }
  .photos img { display:block; width:100%; aspect-ratio:1/1; object-fit:cover; background:var(--line); }
  .photos.n1 img { aspect-ratio:auto; max-height:560px; }
  .noimg { aspect-ratio:1.91/1; display:grid; place-items:center; color:var(--sub); background:var(--link); }
  .ok { color:#2e7d32; } .ng { color:#c62828; font-weight:600; }
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
    <div class="message">${messageHtml}</div>
    ${photos}
  </article>

  <h2>チェック</h2>
  <table>
    <tr><th>本文の文字数<br>(URL・ハッシュタグ・改行を除く)</th><td class="${rangeOk ? 'ok' : 'ng'}">${draft.bodyChars}文字(目安 ${CONFIG.BODY_MIN_CHARS}〜${CONFIG.BODY_MAX_CHARS})</td></tr>
    <tr><th>絵文字</th><td class="${draft.emojiCount <= CONFIG.MAX_EMOJI ? 'ok' : 'ng'}">${draft.emojiCount}個(上限 ${CONFIG.MAX_EMOJI})</td></tr>
    <tr><th>記念日</th><td>${esc(describeAnniversary(draft))}${draft.anniversary_reason ? `<br><span class="meta">${esc(draft.anniversary_reason)}</span>` : ''}</td></tr>
    <tr><th>注意</th><td class="${draft.warnings.length ? 'ng' : 'ok'}">${draft.warnings.length ? draft.warnings.map(esc).join('<br>') : 'なし'}</td></tr>
  </table>

  <h2>商品</h2>
  <table>
    <tr><th>商品</th><td>${esc(product.title)}(${esc(product.price)}円)</td></tr>
    <tr><th>販売者</th><td>${esc(product.vendor)}</td></tr>
    <tr><th>商品ページ</th><td><a href="${esc(productUrl)}" target="_blank" rel="noopener">${esc(productUrl)}</a></td></tr>
    <tr><th>画像URL</th><td>${images.length ? images.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener">${esc(src)}</a>`).join('<br>') : '(なし)'}</td></tr>
    <tr><th>候補商品数</th><td>${candidateCount}件</td></tr>
  </table>

  <h2>draft モードで送信される場合のパラメータ(今回は未送信)</h2>
  <table>${paramRows}<tr><th>access_token</th><td>(表示しません)</td></tr></table>
  <p class="meta">現在の draft モードはリンク投稿(画像はFacebookが商品ページから自動取得)で、上の画像1〜2枚の添付には未対応です。</p>
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
  if (MODE === 'preview' || MODE === 'models') {
    throw new Error(`${MODE} モードではFacebookへの通信は禁止されています。`);
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
        description: htmlToText(p.body_html).slice(0, 300),
        images: (p.images || []).map(img => img.src).filter(Boolean).slice(0, CONFIG.MAX_IMAGES)
      }));
  } catch {
    return [];
  }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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

function getRecentOpenings() {
  return loadHistory().map(e => e.opening).filter(Boolean).slice(-CONFIG.RECENT_OPENINGS_COUNT);
}

function recordProductAsPosted(handle, opening) {
  const cutoff = Date.now() - CONFIG.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const history = loadHistory().filter(e => e.postedAt >= cutoff);
  history.push({ handle, opening, postedAt: Date.now() });
  writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history.slice(-CONFIG.HISTORY_MAX_ENTRIES), null, 2) + '\n');
}

async function generateDraftWithGemini(products) {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const dateText = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
  }).format(new Date());

  const productListText = products.map(p =>
    `- タイトル: ${p.title} / 価格: ${p.price}円 / 販売者(生産者): ${p.vendor} / 種別: ${p.productType} / タグ: ${p.tags} / handle: ${p.handle}\n  説明: ${p.description || '(なし)'}`
  ).join('\n');
  const examples = loadStyleExamples();
  const recentOpenings = getRecentOpenings();

  const prompt = `
あなたは「ふくしま市場」(福島県産品のオンラインストア、https://fukushima-ichiba.com/)の
SNS担当者です。公式Xアカウント(@fukushima_18)の投稿のような、シンプルで読みやすい
Facebook投稿の本文を書いてください。

今日の日付: ${dateText}

手順:
1. 下記の商品候補リストから紹介する商品を1つ選ぶ。リストに無い商品は絶対に登場させない。
2. 今日が記念日・行事の日で、選んだ商品と自然な関連がある場合だけ、それを導入に使う。
   - 広く知られていて確信が持てる記念日だけを使う
   - 関連が弱い・こじつけになる場合は使わず、通常の商品紹介にする(無理に結びつけない)
   - 使う場合も、記念日の説明は短く一言で済ませる
3. 本文を書く。

本文の構成:
1行目: 商品や記念日に関する短い導入
続けて2〜4行: 商品名・産地・生産者・特徴を簡潔に、魅力は具体的に(味・食感・食べ方・量など)

本文のルール:
- 日本語。改行・URL・ハッシュタグを除いて${CONFIG.BODY_MIN_CHARS}〜${CONFIG.BODY_MAX_CHARS}文字
- 絵文字は0〜${CONFIG.MAX_EMOJI}個
- 誇張表現や不自然な宣伝文句(「最高」「絶品」「今だけ」「お見逃しなく」など)は使わない
- 商品名・産地・生産者など、リストに無い情報を捏造しない(分からない項目は書かない)
- 「▼詳細はこちら」、URL、ハッシュタグは本文に入れない(後から自動で付ける)
- 毎回同じ言い回しにならないよう、書き出しや文の組み立てを変える
${recentOpenings.length ? `- 最近の投稿の書き出しは次のとおり。これらと似た書き出しは避ける:\n${recentOpenings.map(o => `  ・${o}`).join('\n')}` : ''}
${examples.length ? `\n公式Xの投稿例(雰囲気の参考。文章をそのまま流用しない):\n${examples.map(e => `---\n${e}`).join('\n')}\n---\n` : ''}
出力は次のJSON形式のみ。前後に説明文やコードブロック記号は一切つけないこと。
{"anniversary": "検討した今日の記念日(無ければ空文字)", "anniversary_used": true または false, "anniversary_reason": "使った/使わなかった理由を一言", "product_handle": "選んだ商品のhandle", "body": "本文"}

商品候補リスト:
${productListText}
`;

  let draft;
  let feedback = '';
  for (let attempt = 1; attempt <= CONFIG.GEMINI_MAX_ATTEMPTS; attempt++) {
    draft = await callGemini(apiKey, prompt + feedback);
    draft.body = cleanBody(draft.body);
    draft.bodyChars = countBodyChars(draft.body);
    draft.emojiCount = countEmoji(draft.body);
    draft.opening = draft.body.split('\n')[0].slice(0, 40);
    draft.warnings = checkBodyRules(draft);
    if (draft.warnings.length === 0) break;
    log(`投稿文がルールを外れたため作り直します(${attempt}回目): ${draft.warnings.join(' / ')}`);
    feedback = `\n\n前回の本文は次の点がルール違反でした。直して書き直してください: ${draft.warnings.join(' / ')}\n前回の本文:\n${draft.body}\n`;
  }
  return draft;
}

/**
 * Gemini APIのモデル一覧からFlash系を抜き出し、それぞれ短い generateContent を1回呼んで
 * 実際に使えるかを確かめる(一覧に載っていても新規キーでは使えないモデルがあるため)。
 * APIキーはヘッダーでのみ送り、ログには出さない。
 */
async function checkGeminiModels() {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };

  const models = [];
  let pageToken = '';
  do {
    const res = await fetch(`${base}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers });
    const json = await res.json();
    if (json.error) throw new Error(`Gemini モデル一覧の取得に失敗しました: ${json.error.code} ${json.error.status} ${json.error.message}`);
    models.push(...(json.models || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);

  const flash = models.filter(m => /flash/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'));
  const targets = [...new Set([...flash.map(m => m.name.replace(/^models\//, '')), 'gemini-3.8-flash', CONFIG.GEMINI_MODEL])];

  const rows = [];
  for (const name of targets) {
    const listed = flash.some(m => m.name === `models/${name}`);
    const res = await fetch(`${base}/models/${name}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contents: [{ parts: [{ text: 'OKとだけ答えてください。' }] }] })
    });
    const json = await res.json();
    const result = json.error ? `× ${json.error.code} ${json.error.status}: ${String(json.error.message).slice(0, 120)}` : '○ 呼び出し成功';
    rows.push(`| ${name} | ${listed ? 'あり' : 'なし'} | ${result} |`);
  }

  summary([
    `### Gemini モデル確認(全${models.length}件中、generateContent 対応の Flash 系 ${flash.length}件)`,
    `現在のコードの既定: ${CONFIG.GEMINI_MODEL}`,
    '',
    '| モデル | 一覧に掲載 | 実際の呼び出し |',
    '|---|---|---|',
    ...rows
  ].join('\n'));
}

async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 1.0 }
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
  if (!draft.body || !draft.product_handle) {
    throw new Error('Geminiの出力に必要な項目(body / product_handle)がありません: ' + rawText);
  }
  return draft;
}

/** 本文に紛れ込んだ URL・ハッシュタグ・「▼詳細はこちら」を取り除く(後でコード側が付ける)。 */
function cleanBody(body) {
  return String(body)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/▼?\s*詳細はこちら/g, '')
    .replace(/(^|\s)#[^\s#]+/g, '$1')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countBodyChars(body) {
  return [...body.replace(/\s/g, '')].length;
}

function countEmoji(text) {
  return (text.match(/\p{Extended_Pictographic}/gu) || []).length;
}

function checkBodyRules(draft) {
  const warnings = [];
  if (draft.bodyChars < CONFIG.BODY_MIN_CHARS || draft.bodyChars > CONFIG.BODY_MAX_CHARS) {
    warnings.push(`本文が${draft.bodyChars}文字(目安 ${CONFIG.BODY_MIN_CHARS}〜${CONFIG.BODY_MAX_CHARS}文字)`);
  }
  if (draft.emojiCount > CONFIG.MAX_EMOJI) {
    warnings.push(`絵文字が${draft.emojiCount}個(上限 ${CONFIG.MAX_EMOJI}個)`);
  }
  const ng = CONFIG.NG_PHRASES.filter(p => draft.body.includes(p));
  if (ng.length) warnings.push(`誇張・宣伝的な表現: ${ng.join('、')}`);
  return warnings;
}

function loadStyleExamples() {
  if (!existsSync(CONFIG.STYLE_EXAMPLES_FILE)) return [];
  return readFileSync(CONFIG.STYLE_EXAMPLES_FILE, 'utf8')
    .split(/^---\s*$/m)
    .map(s => s.trim())
    .filter(Boolean);
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
