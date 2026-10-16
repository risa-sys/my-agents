/**
 * 「ふくしま市場」Facebookページに下書き投稿を自動作成するエージェント(GitHub Actions版)
 *
 * ふくしま市場の売れ筋ランキング(ranking_top10)を基準に、新着(new-1)も加えた候補から
 * 1商品を選び、Geminiで投稿文を作って Facebookページに「下書き」として保存する。
 * 公開はしない。Meta Business Suite の下書き一覧で内容を確認し、手動で公開する。
 *
 * 必要な環境変数(GitHub Secrets から渡す):
 *   FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN, GEMINI_API_KEY
 *
 * MODE(環境変数):
 *   check   … トークンとページの疎通だけ確認する(投稿文の生成・投稿はしない)
 *   dry-run … 投稿文を生成してログに出すだけ(Facebookには何も作らない)
 *   draft   … 投稿文を生成し、Facebookページに下書きとして保存する(既定)
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const CONFIG = {
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  GRAPH_API_VERSION: 'v21.0',
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

const MODE = process.env.MODE || 'draft';

async function main() {
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

  const products = await collectCandidateProducts();
  if (products.length === 0) {
    throw new Error('ふくしま市場の商品情報を取得できませんでした。サイト構成が変わっていないか確認してください。');
  }

  const draft = await generateDraftWithGemini(products);
  const product = products.find(p => p.handle === draft.product_handle) || products[0];
  const productUrl = `${CONFIG.SHOP_BASE_URL}/products/${product.handle}`;

  let postId = '(dry-run のため未作成)';
  if (MODE === 'draft') {
    postId = await createDraftPost(pageId, page.accessToken, draft.message, productUrl);
    recordProductAsPosted(product.handle);
    log(`Facebook下書き作成完了: ${postId}`);
  }

  summary([
    `### ${MODE === 'draft' ? 'Facebook下書きを作成しました' : '投稿文プレビュー(dry-run)'}`,
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
        price: p.variants[0].price
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
 */
async function createDraftPost(pageId, pageToken, message, link) {
  const body = new URLSearchParams({
    message,
    link,
    published: 'false',
    unpublished_content_type: 'DRAFT',
    access_token: pageToken
  });
  const res = await fetch(`https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${pageId}/feed`, {
    method: 'POST',
    body
  });
  const json = await res.json();
  if (json.error) throw new Error('Facebook Graph APIエラー: ' + describeGraphError(json.error));
  return json.id;
}

async function graphGet(path, token) {
  const res = await fetch(`https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${path}`, {
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
