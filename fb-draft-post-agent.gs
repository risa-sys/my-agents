/**
 * ============================================================
 * 「ふくしま市場」Facebookページに下書き投稿を自動作成するエージェント
 * ============================================================
 *
 * 毎朝、当日の話題(記念日・季節感など)と、ふくしま市場
 * (https://fukushima-ichiba.com/) の新着・売れ筋商品を組み合わせて
 * Facebook投稿文をGeminiに作らせ、Facebookページ
 * (https://www.facebook.com/fukushimaichiba/) に「下書き」として
 * 保存する。実際の公開はMeta Business Suite側で内容を確認してから
 * 手動で行う(このスクリプトが勝手に公開することはない)。
 *
 * 【セットアップ手順】
 * 1. https://script.google.com で daily-task-agent と同じプロジェクトを開く
 *    (このファイルを新しいスクリプトファイルとして追加)
 *
 * 2. スクリプト プロパティ(プロジェクトの設定 → スクリプト プロパティ)に
 *    以下を追加する
 *      - GEMINI_API_KEY        : 既存のものを流用(daily-task-agentと共通)
 *      - FB_PAGE_ID             : 対象Facebookページの数値ページID
 *      - FB_PAGE_ACCESS_TOKEN   : そのページに投稿できるページアクセストークン
 *
 *    ページID・アクセストークンの取得方法(初回のみ、手元のブラウザで、
 *    fukushimaichiba ページの管理者アカウントでログインして実施。
 *    自分でMetaアプリを作る必要はなく、Meta純正の「Graph API Explorer」
 *    デフォルトアプリを使うだけでよい):
 *      a. https://developers.facebook.com/tools/explorer/ を開く
 *      b. 画面上部の「Meta App」欄が "Graph API Explorer"(デフォルトアプリ)に
 *         なっていることを確認(自分でアプリを作成・選択する必要はない)
 *      c. 「User or Page」→ fukushimaichiba ページの管理者アカウントで
 *         Facebookにログイン
 *      d. 「Permissions」に pages_show_list, pages_manage_posts,
 *         pages_read_engagement を追加し、「Generate Access Token」で
 *         ユーザートークンを取得
 *      e. 同じExplorer上で `GET /me/accounts` を実行し、
 *         対象ページ(fukushimaichiba)の "id"(=FB_PAGE_ID)と
 *         "access_token"(=ページアクセストークン)を確認
 *      f. 取得したページアクセストークンは
 *         https://developers.facebook.com/tools/debug/accesstoken/ に貼り付け、
 *         「トークンを長期化(Extend Access Token)」で有効期限を延ばしておく
 *
 *    注意: この方法で取得したトークンは60日程度で失効します。切れると
 *    createFacebookDraftPost がGraph APIエラーで失敗するので、その際は
 *    上記a〜fを再実行してFB_PAGE_ACCESS_TOKENを更新してください
 *    (「切れると自動投稿が止まる/失敗メールも飛ばない」点に注意。
 *    完全放置したい場合はMeta Business Suiteの「システムユーザー」を使った
 *    無期限トークンへの切り替えを検討してください)
 *
 * 3. 関数選択で setupFacebookDraftTrigger を選び、実行(▶)
 *    → 初回は権限承認画面(外部通信の許可)が出るので許可する
 *
 * 4. トリガー画面で createFacebookDraftPost が毎日8:30近辺に
 *    登録されていることを確認
 *
 * 5. 動作確認として、関数選択で createFacebookDraftPost を選んで
 *    一度手動実行し、Meta Business Suite(https://business.facebook.com/
 *    latest/posts?tab=drafts など)の下書き一覧に投稿が入ることを確認する
 *
 * これで毎朝8:30に、その日の話題とふくしま市場の商品を絡めた下書き投稿が
 * 自動作成され、確認メールが risa@spacexone.com に届きます。
 * 内容を確認し、問題なければMeta Business Suiteから手動で公開してください。
 * ============================================================
 */

const FB_CONFIG = {
  RECIPIENT_EMAIL: 'risa@spacexone.com',
  GEMINI_MODEL: 'gemini-2.0-flash',
  GRAPH_API_VERSION: 'v21.0',
  SHOP_BASE_URL: 'https://fukushima-ichiba.com',
  // 実在する商品だけを候補にするため、認証不要のShopify商品JSONを利用する
  PRODUCT_SOURCE_PATHS: [
    '/collections/new-1/products.json?limit=20',   // 新着
    '/collections/ranking_top10/products.json?limit=20' // 売れ筋
  ],
  PRODUCT_FALLBACK_PATH: '/products.json?limit=20',
  MAX_CANDIDATE_PRODUCTS: 30
};

/**
 * メインの処理。トリガーから毎朝呼び出される。
 * ふくしま市場の商品候補を取得 → Geminiで投稿文を生成 →
 * Facebookページに下書き(published=false)として保存する。
 */
function createFacebookDraftPost() {
  try {
    const pageId = PropertiesService.getScriptProperties().getProperty('FB_PAGE_ID');
    const pageToken = PropertiesService.getScriptProperties().getProperty('FB_PAGE_ACCESS_TOKEN');
    if (!pageId || !pageToken) {
      throw new Error('スクリプトプロパティ FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN が設定されていません。');
    }

    const products = collectCandidateProducts_();
    if (products.length === 0) {
      throw new Error('ふくしま市場の商品情報を取得できませんでした。サイト構成が変わっていないか確認してください。');
    }

    const draft = generateDraftWithGemini_(products);
    const product = products.find(p => p.handle === draft.product_handle) || products[0];
    const productUrl = `${FB_CONFIG.SHOP_BASE_URL}/products/${product.handle}`;

    const postId = createUnpublishedPagePost_(pageId, pageToken, draft.message, productUrl);

    notifyDraftCreated_(draft, product, productUrl, postId);
  } catch (e) {
    // アクセストークン失効などで失敗しても気づけるよう、必ずメールで知らせる
    notifyDraftFailed_(e);
    throw e;
  }
}

/**
 * ふくしま市場の新着・売れ筋商品をShopifyの公開JSONエンドポイントから取得し、
 * Geminiに渡すためのコンパクトな配列にまとめる(重複除去つき)。
 */
function collectCandidateProducts_() {
  const byId = {};

  FB_CONFIG.PRODUCT_SOURCE_PATHS.forEach(path => {
    fetchShopifyProducts_(path).forEach(p => { byId[p.id] = p; });
  });

  if (Object.keys(byId).length === 0) {
    fetchShopifyProducts_(FB_CONFIG.PRODUCT_FALLBACK_PATH).forEach(p => { byId[p.id] = p; });
  }

  return Object.values(byId).slice(0, FB_CONFIG.MAX_CANDIDATE_PRODUCTS);
}

/**
 * Shopifyの products.json 形式のエンドポイントを取得し、
 * 投稿文生成に必要な項目だけを抜き出す。
 */
function fetchShopifyProducts_(path) {
  const url = FB_CONFIG.SHOP_BASE_URL + path;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    return [];
  }

  let json;
  try {
    json = JSON.parse(response.getContentText());
  } catch (e) {
    return [];
  }

  const products = json.products || [];
  return products
    .filter(p => p.variants && p.variants.length > 0 && p.handle)
    .map(p => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      vendor: p.vendor,
      productType: p.product_type,
      tags: p.tags,
      price: p.variants[0].price
    }));
}

/**
 * Gemini APIを呼び出し、「今日の話題×商品」を絡めたFacebook投稿文を生成する。
 * 戻り値: { theme, product_handle, message }
 */
function generateDraftWithGemini_(products) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('スクリプトプロパティ GEMINI_API_KEY が設定されていません。');
  }

  const today = new Date();
  const dateText = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy年M月d日(E)');

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
- 最後に購入を後押しする一文を入れる(例:「詳しくはプロフィールのリンクから」「下記リンクからチェックしてみてください」)
- 文末にハッシュタグを3〜5個つける(例: #ふくしま市場 #福島 #お取り寄せグルメ など商品に合わせて選ぶ)
- 全体で200〜400文字程度
- 商品名や産地など、リストに無い情報を捏造しない

出力は次のJSON形式のみ。前後に説明文やコードブロック記号(\`\`\`)は一切つけないこと。
{"theme": "選んだ話題", "product_handle": "選んだ商品のhandle", "message": "投稿本文"}

商品候補リスト:
${productListText}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${FB_CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const json = JSON.parse(response.getContentText());
  if (json.error) {
    throw new Error('Gemini APIエラー: ' + JSON.stringify(json.error));
  }

  const rawText = json.candidates[0].content.parts[0].text;
  const cleaned = rawText.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  let draft;
  try {
    draft = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Geminiの出力をJSONとして解析できませんでした: ' + rawText);
  }

  if (!draft.message || !draft.product_handle) {
    throw new Error('Geminiの出力に必要な項目(message / product_handle)がありません: ' + rawText);
  }
  return draft;
}

/**
 * Facebookページに未公開(下書き)投稿を作成する。
 * published=false のため、Meta Business Suiteの下書き一覧に入るのみで、
 * 自動的には公開されない。
 * 戻り値: 作成された投稿のID
 */
function createUnpublishedPagePost_(pageId, pageToken, message, link) {
  const url = `https://graph.facebook.com/${FB_CONFIG.GRAPH_API_VERSION}/${pageId}/feed`;
  const payload = {
    message: message,
    link: link,
    published: 'false',
    access_token: pageToken
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });

  const json = JSON.parse(response.getContentText());
  if (json.error) {
    throw new Error('Facebook Graph APIエラー: ' + JSON.stringify(json.error));
  }
  return json.id;
}

/**
 * 下書き作成完了をメールで通知する。
 */
function notifyDraftCreated_(draft, product, productUrl, postId) {
  const subject = `【ふくしま市場】Facebook下書きを作成しました(${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日')})`;
  const body = `
本日の話題: ${draft.theme}
紹介商品: ${product.title}(${product.price}円)
商品ページ: ${productUrl}
投稿ID: ${postId}

--- 投稿文(下書き) ---
${draft.message}
---

Meta Business Suiteの「下書き」から内容を確認し、問題なければ公開してください。
https://business.facebook.com/latest/posts?tab=drafts
`;
  GmailApp.sendEmail(FB_CONFIG.RECIPIENT_EMAIL, subject, body);
}

/**
 * 下書き作成の失敗をメールで通知する。
 * (アクセストークン失効など、Graph API Explorerで再取得が必要なケースが多い)
 */
function notifyDraftFailed_(error) {
  const subject = `【ふくしま市場】Facebook下書きの作成に失敗しました(${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日')})`;
  const body = `
createFacebookDraftPost の実行中にエラーが発生しました。

${error}

よくある原因: FB_PAGE_ACCESS_TOKEN の有効期限切れ(60日程度で失効します)。
その場合は https://developers.facebook.com/tools/explorer/ で
Graph API Explorer(デフォルトアプリ)からfukushimaichibaページの管理者アカウントで
再度トークンを取得し、スクリプトプロパティ FB_PAGE_ACCESS_TOKEN を更新してください。
`;
  GmailApp.sendEmail(FB_CONFIG.RECIPIENT_EMAIL, subject, body);
}

/**
 * 【初回セットアップ用】毎朝8:30(JST)近辺に createFacebookDraftPost を
 * 実行するトリガーを作成する。手動で一度だけ実行してください。
 * 再実行しても重複登録されないよう、既存の同名トリガーを削除してから作り直す。
 */
function setupFacebookDraftTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'createFacebookDraftPost') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('createFacebookDraftPost')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .nearMinute(30)
    .create();
}
