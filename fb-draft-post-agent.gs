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
 *    ページID・アクセストークンの取得方法(初回のみ、Business Managerの
 *    管理者権限で実施。Meta Business Suiteの「システムユーザー」を使い、
 *    有効期限「なし(Never)」のトークンを発行する方式):
 *      a. https://business.facebook.com/settings を開き、対象の
 *         ビジネスポートフォリオ(スペースワン)を選ぶ
 *      b. 左メニュー「ユーザー」→「システムユーザー」を開く。
 *         既存のシステムユーザーがあればそれを使う。無ければ「追加」で作成
 *         (名前例: fukushimaichiba-bot、役割は「管理者」か「従業員」)
 *      c. システムユーザーを選択 →「アセットを割り当てる」を開き、
 *         - ページ: fukushimaichiba を選び「コンテンツの作成・管理」権限
 *           (またはフルコントロール)を付与
 *         - アプリ: 投稿に使うMetaアプリを選び「アプリを管理」権限を付与
 *           (アプリが無ければ developers.facebook.com で作成しておく)
 *      d. 同じ画面で「新しいトークンを生成」→ アプリを選択 →
 *         トークンの有効期限は必ず「なし(Never)」を選択 →
 *         権限に pages_manage_posts, pages_read_engagement, pages_show_list
 *         をチェック → 生成されたトークンをコピー(この画面でしか表示されない)
 *      e. https://developers.facebook.com/tools/debug/accesstoken/ に
 *         コピーしたトークンを貼り付け、次の3点を確認する
 *           - Expires(有効期限)が Never
 *           - Scopes に上記3つの権限が入っている
 *           - 「有効」と表示される
 *      f. Graph API Explorer等で `GET /me/accounts` を実行し、
 *         fukushimaichibaページの "id"(=FB_PAGE_ID)を確認する
 *      → 取得した FB_PAGE_ID / トークン(=FB_PAGE_ACCESS_TOKEN)を
 *        Apps Scriptのスクリプトプロパティに設定する
 *
 *    この方式で発行したトークンは失効しないため、以後の再取得は基本不要。
 *    それでもエラーになる場合は:
 *      - エラー190(トークン無効・期限切れ) → 手順dからやり直す
 *      - エラー200/10(権限不足) → 手順cのアセット割り当てと
 *        手順dの権限チェックを再確認する
 *      - 投稿は成功したのにページに表示されない → Metaアプリが
 *        「開発モード」のままの可能性がある。developers.facebook.com で
 *        アプリを「ライブ」にする
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
  // 実在する商品だけを候補にするため、認証不要のShopify商品JSONを利用する。
  // ranking_top10(売れ筋)を基準とし、new-1(新着)を補助的な候補として加える
  PRODUCT_SOURCE_PATHS: [
    '/collections/ranking_top10/products.json?limit=20', // 基準: 売れ筋ランキング
    '/collections/new-1/products.json?limit=20'           // 補助: 新着
  ],
  PRODUCT_FALLBACK_PATH: '/products.json?limit=20',
  MAX_CANDIDATE_PRODUCTS: 30,
  // 直近で紹介済みの商品と被らないようにするための履歴設定
  HISTORY_PROPERTY_KEY: 'FB_POSTED_PRODUCT_HISTORY',
  HISTORY_RETENTION_DAYS: 30, // ranking_top10が入れ替わる程度の期間を想定
  HISTORY_MAX_ENTRIES: 60
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
    recordProductAsPosted_(product.handle);

    notifyDraftCreated_(draft, product, productUrl, postId);
  } catch (e) {
    // アクセストークン失効などで失敗しても気づけるよう、必ずメールで知らせる
    notifyDraftFailed_(e);
    throw e;
  }
}

/**
 * ふくしま市場の売れ筋・新着商品をShopifyの公開JSONエンドポイントから取得し、
 * Geminiに渡すためのコンパクトな配列にまとめる(重複除去・紹介済み除外つき)。
 * 直近 HISTORY_RETENTION_DAYS 日以内に紹介済みの商品は、ranking_top10が
 * 入れ替わるまで候補から外し、同じ商品が続けて登場しないようにする。
 */
function collectCandidateProducts_() {
  const byId = {};

  FB_CONFIG.PRODUCT_SOURCE_PATHS.forEach(path => {
    fetchShopifyProducts_(path).forEach(p => { byId[p.id] = p; });
  });

  if (Object.keys(byId).length === 0) {
    fetchShopifyProducts_(FB_CONFIG.PRODUCT_FALLBACK_PATH).forEach(p => { byId[p.id] = p; });
  }

  const all = Object.values(byId);
  const postedHandles = getPostedProductHandles_();
  let candidates = all.filter(p => !postedHandles.has(p.handle));

  if (candidates.length === 0) {
    // ranking_top10 / new-1 が軒並み紹介済みの場合は、カタログ全体まで候補を広げる
    const fallback = fetchShopifyProducts_(FB_CONFIG.PRODUCT_FALLBACK_PATH)
      .filter(p => !postedHandles.has(p.handle));
    candidates = fallback.length > 0 ? fallback : all; // それでも無ければ重複を許容する
  }

  return candidates.slice(0, FB_CONFIG.MAX_CANDIDATE_PRODUCTS);
}

/**
 * 直近 HISTORY_RETENTION_DAYS 日以内に紹介済みの商品handle一覧を取得する。
 */
function getPostedProductHandles_() {
  const raw = PropertiesService.getScriptProperties().getProperty(FB_CONFIG.HISTORY_PROPERTY_KEY);
  if (!raw) return new Set();

  let history;
  try {
    history = JSON.parse(raw);
  } catch (e) {
    return new Set();
  }

  const cutoff = Date.now() - FB_CONFIG.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return new Set(
    history.filter(entry => entry.postedAt >= cutoff).map(entry => entry.handle)
  );
}

/**
 * 紹介済み商品として履歴に記録する(期限切れ分は削除し、件数も上限まで間引く)。
 */
function recordProductAsPosted_(handle) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(FB_CONFIG.HISTORY_PROPERTY_KEY);

  let history = [];
  if (raw) {
    try {
      history = JSON.parse(raw);
    } catch (e) {
      history = [];
    }
  }

  const cutoff = Date.now() - FB_CONFIG.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  history = history.filter(entry => entry.postedAt >= cutoff);
  history.push({ handle: handle, postedAt: Date.now() });

  const trimmed = history.slice(-FB_CONFIG.HISTORY_MAX_ENTRIES);
  props.setProperty(FB_CONFIG.HISTORY_PROPERTY_KEY, JSON.stringify(trimmed));
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
 * (システムユーザーのアセット割り当て解除・アプリ側の問題などで失敗するケースが多い)
 */
function notifyDraftFailed_(error) {
  const subject = `【ふくしま市場】Facebook下書きの作成に失敗しました(${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日')})`;
  const body = `
createFacebookDraftPost の実行中にエラーが発生しました。

${error}

よくある原因と対処:
- エラー190(トークン無効・期限切れ) → https://business.facebook.com/settings の
  システムユーザーで、トークンを再生成する(有効期限は必ず「なし(Never)」)
- エラー200/10(権限不足) → 同画面でシステムユーザーへの
  ページ・アプリのアセット割り当てと権限チェックを再確認する
- 投稿は成功するがページに表示されない → Metaアプリが「開発モード」の
  可能性がある。developers.facebook.com でアプリを「ライブ」にする

取得し直したトークンは、Apps Scriptのスクリプトプロパティ
FB_PAGE_ACCESS_TOKEN に設定してください。詳しい手順は
fb-draft-post-agent.gs 冒頭のコメントを参照。
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
