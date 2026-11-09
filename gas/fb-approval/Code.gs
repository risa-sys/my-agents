/**
 * ふくしま市場 Facebook 投稿の「メール承認」(Google Apps Script)
 *
 * 流れ:
 *   1. GitHub Actions(fb-mail-draft.yml)が投稿案を1件作り、署名つきでここ(/exec)に送る → 保存してメールで知らせる
 *   2. メールのリンクから承認画面(/dev。プロジェクトの所有者しか開けない)を開き、承認・修正して承認・却下を選ぶ
 *   3. 承認した場合は、最終的な投稿内容を確かめて「公開する」を押したときだけ、GitHub Actions(fb-mail-publish.yml)を起動する
 *   4. fb-mail-publish.yml が署名つきで承認済みの内容を受け取り、Facebook に1件だけ公開して、結果を署名つきで知らせる
 *
 * 安全のしくみ:
 *   - 承認画面は /dev(テスト用URL)で開く。Google がプロジェクトの編集者(=所有者)以外を止める。
 *     さらにコードでもログイン中のアカウントが OWNER_EMAIL と一致するか確かめる(/exec を開かれても画面は出さない)
 *   - メールのリンクには投稿案ごとの鍵が付く(保存するのはハッシュだけ・72時間で期限切れ)
 *   - 画面を開いただけでは何も変わらない。判断の保存・公開の開始はボタン操作のときだけ
 *   - /exec(だれでも呼べる)の受付は、署名(HMAC・共有の秘密 ACTIONS_SECRET)が合う要求だけを受け付ける。
 *     受付でできるのは「投稿案の登録」「失敗の連絡」「公開を頼まれた内容の受け取り(1回だけ)」「結果の連絡」だけで、
 *     承認・公開の開始は承認画面からしかできない
 *   - 投稿案・判断はこのプロジェクトのスクリプト プロパティにだけ保存する(公開の GitHub には置かない)
 *
 * スクリプト プロパティ(プロジェクトの設定で登録。値は画面やログに出さない):
 *   OWNER_EMAIL     … 承認する人(このプロジェクトの所有者)のメールアドレス。メールの送り先
 *   ACTIONS_SECRET  … GitHub Actions との共有の秘密(GitHub Secrets の FB_MAIL_SECRET と同じ値)
 *   GITHUB_TOKEN    … 公開処理の起動に使う GitHub のトークン(このリポジトリだけ・Actions の読み書きのみ)
 *   GITHUB_REPO     … risa-sys/my-agents
 *   UI_URL          … 承認画面のURL(https://script.google.com/macros/s/<スクリプトID>/dev)
 *
 * Rules.gs / ReviewUi.gs は自動生成(node scripts/build-gas-approval.mjs)。既存の承認画面・ルールと同じもの。
 */

const APP = {
  PAGE_ID: '277404605612561',
  PAGE_NAME: '福島県産品オンラインストア ふくしま市場',
  WORKFLOW: 'fb-mail-publish.yml',
  REF: 'main',
  DRAFT_TTL_MS: 72 * 60 * 60 * 1000, // メールのリンクの有効期限
  PUBLISH_REQUEST_TTL_MS: 30 * 60 * 1000, // 「公開する」のあと、この時間内に公開処理が始まらなければ取り消す
  MAX_SKEW_MS: 5 * 60 * 1000, // 署名の時刻のずれの上限
  SOURCE_MAX_CHARS: 2500, // 保存する商品説明の上限(スクリプト プロパティの容量のため)
  KEEP_DAYS: 30, // 終わった投稿案を残す日数
  MAX_PROPERTY_BYTES: 8500
};

const STATE_LABELS = {
  awaiting: '判断待ち',
  decided: '承認済み(まだ公開していません)',
  rejected: '却下(投稿しません)',
  publish_requested: '公開を開始しました',
  publishing: '公開処理中',
  published: '公開済み',
  unverified: '投稿は作られましたが公開を確認できません',
  needs_check: '公開されたか確認できません(要確認・自動では送り直しません)',
  expired: '期限切れ'
};
const OPEN_STATES = ['awaiting', 'decided'];
const REPORT_STATES = { published: 'published', unverified: 'unverified', unknown: 'needs_check', not_published: 'decided', dry_run: 'decided', refused: 'decided' };

// ---------------------------------------------------------------------------
// 設定・保存
// ---------------------------------------------------------------------------

function config_() {
  const p = PropertiesService.getScriptProperties();
  const get = k => String(p.getProperty(k) || '');
  return {
    owner: get('OWNER_EMAIL').trim().toLowerCase(),
    secret: get('ACTIONS_SECRET'),
    githubToken: get('GITHUB_TOKEN'),
    repo: get('GITHUB_REPO'),
    uiUrl: get('UI_URL')
  };
}

function store_() {
  return PropertiesService.getScriptProperties();
}

function loadDraft_(id) {
  const raw = store_().getProperty('draft:' + id);
  return raw ? JSON.parse(raw) : null;
}

function saveDraft_(d) {
  const json = JSON.stringify(d);
  if (Utilities.newBlob(json).getBytes().length > APP.MAX_PROPERTY_BYTES) throw new Error('投稿案が大きすぎて保存できません');
  store_().setProperty('draft:' + d.id, json);
}

function loadSource_(id) {
  const raw = store_().getProperty('src:' + id);
  return raw ? JSON.parse(raw) : null;
}

function draftIds_() {
  return store_().getKeys().filter(k => k.indexOf('draft:') === 0).map(k => k.slice(6));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function event_(d, text) {
  d.events = (d.events || []).concat([{ at: new Date().toISOString(), text: text }]).slice(-20);
}

function isExpired_(d) {
  return OPEN_STATES.indexOf(d.state) >= 0 && Date.now() > d.expiresAt;
}

function stateOf_(d) {
  return isExpired_(d) ? 'expired' : d.state;
}

/** 終わった投稿案のうち、古いものを消す */
function cleanup_() {
  const limit = Date.now() - APP.KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const id of draftIds_()) {
    const d = loadDraft_(id);
    if (d && d.createdAt < limit && ['awaiting', 'decided', 'publish_requested', 'publishing'].indexOf(d.state) < 0) {
      store_().deleteProperty('draft:' + id);
      store_().deleteProperty('src:' + id);
    }
  }
}

// ---------------------------------------------------------------------------
// ハッシュ・署名
// ---------------------------------------------------------------------------

function hex_(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function sha256Hex_(text) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

function hmacHex_(secret, text) {
  return hex_(Utilities.computeHmacSha256Signature(text, secret, Utilities.Charset.UTF_8));
}

function randomHex_() {
  return Utilities.getUuid().replace(/-/g, '').toLowerCase();
}

function safeEqual_(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 元の投稿文の照合用(scripts/fb-review-ui.mjs の hashOf と同じ) */
function hashOf_(text) {
  return sha256Hex_(String(text)).slice(0, 16);
}

/** 承認用のハッシュ(scripts/fb-immediate.mjs の contentHash と同じ) */
function contentHash_(productId, url, image, message) {
  return sha256Hex_(JSON.stringify([productId, url, image, message])).slice(0, 16);
}

/** 署名つきの封筒(scripts/fb-mail-sign.mjs と同じ形式) */
function sealEnvelope_(secret, payload) {
  const ts = Date.now();
  const nonce = randomHex_();
  const body = JSON.stringify(payload);
  return { v: 1, ts: ts, nonce: nonce, body: body, sig: hmacHex_(secret, 'fb-mail.v1.' + ts + '.' + nonce + '.' + body) };
}

function openEnvelope_(secret, env) {
  if (!env || env.v !== 1 || typeof env.body !== 'string' || typeof env.sig !== 'string' || !/^[0-9a-f]{32}$/.test(String(env.nonce)) || typeof env.ts !== 'number') {
    throw new Error('形式が不正です');
  }
  if (!safeEqual_(hmacHex_(secret, 'fb-mail.v1.' + env.ts + '.' + env.nonce + '.' + env.body), env.sig)) throw new Error('署名が一致しません');
  if (Math.abs(Date.now() - env.ts) > APP.MAX_SKEW_MS) throw new Error('署名の時刻が古すぎるか、先の時刻です');
  // 同じ要求の使い回しを断る(時刻の許容幅より長く覚えておく)
  const cache = CacheService.getScriptCache();
  if (cache.get('nonce:' + env.nonce)) throw new Error('使用済みの要求です');
  cache.put('nonce:' + env.nonce, '1', 1200);
  return JSON.parse(env.body);
}

// ---------------------------------------------------------------------------
// 受付(/exec): GitHub Actions からの署名つきの要求だけ
// ---------------------------------------------------------------------------

function doPost(e) {
  const cfg = config_();
  if (!cfg.secret) return ContentService.createTextOutput('not configured');
  let env;
  let req;
  try {
    env = JSON.parse(e.postData.contents);
    req = openEnvelope_(cfg.secret, env);
  } catch (err) {
    // 署名が合わない要求には、中身のある応答を返さない
    return ContentService.createTextOutput('unauthorized');
  }
  let reply;
  try {
    reply = handleApi_(req, cfg);
  } catch (err) {
    reply = { ok: false, error: String((err && err.message) || err), code: (err && err.code) || '' };
  }
  reply.reqNonce = env.nonce;
  return ContentService.createTextOutput(JSON.stringify(sealEnvelope_(cfg.secret, reply))).setMimeType(ContentService.MimeType.JSON);
}

function apiError_(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function handleApi_(req, cfg) {
  if (req.action === 'createDraft') return apiCreateDraft_(req, cfg);
  if (req.action === 'draftFailed') return apiDraftFailed_(req, cfg);
  if (req.action === 'getApproved') return apiGetApproved_(req);
  if (req.action === 'report') return apiReport_(req, cfg);
  throw apiError_('不明な要求です', 'unknown_action');
}

function validateDraftInput_(d, src) {
  const errors = [];
  const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!d || typeof d !== 'object') return ['投稿案がありません'];
  if (!/^\d{1,20}$/.test(String(d.productId))) errors.push('商品IDが不正です');
  if (!/^https:\/\/fukushima-ichiba\.com\/products\/[A-Za-z0-9_\-%.]+$/.test(String(d.url))) errors.push('商品URLが不正です');
  if (!/^https:\/\/cdn\.shopify\.com\/[^\s"'<>]+$/.test(String(d.image))) errors.push('画像は cdn.shopify.com のものだけです');
  if (!str(d.title, 300)) errors.push('商品名がありません');
  if (!str(d.message, 3000)) errors.push('投稿文がありません');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.postDate))) errors.push('日付が不正です');
  if (d.factCheck !== 'passed') errors.push('事実確認に通っていない投稿案です');
  if (str(d.message, 3000)) {
    const parts = splitMessage(d.message);
    if (parts.url !== d.url) errors.push('投稿文の商品URLが一致しません');
    if (parts.hashtags.length !== 4 || RULES.FIXED_HASHTAGS.some((t, i) => parts.hashtags[i] !== t)) errors.push('ハッシュタグの形が不正です');
    if (d.originalHash !== hashOf_(d.message)) errors.push('投稿文のハッシュが一致しません');
  }
  if (!src || typeof src !== 'object' || !str(src.title, 300) || typeof src.description !== 'string') errors.push('商品情報がありません');
  return errors;
}

function apiCreateDraft_(req, cfg) {
  if (!cfg.owner || !cfg.uiUrl) throw apiError_('OWNER_EMAIL / UI_URL が設定されていません', 'not_configured');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/dev$/.test(cfg.uiUrl)) throw apiError_('UI_URL は承認画面(…/dev)のURLにしてください', 'not_configured');
  const input = req.draft;
  const srcIn = req.source;
  const errors = validateDraftInput_(input, srcIn);
  if (errors.length) throw apiError_('投稿案が不正です: ' + errors.join(' / '), 'invalid');
  const source = {
    title: String(srcIn.title), vendor: String(srcIn.vendor || ''), productType: String(srcIn.productType || ''),
    tags: (srcIn.tags || []).map(String).slice(0, 30), description: String(srcIn.description).slice(0, APP.SOURCE_MAX_CHARS)
  };
  return withLock_(() => {
    cleanup_();
    // 同じ商品で、まだ終わっていない投稿案があれば作らない
    for (const id of draftIds_()) {
      const other = loadDraft_(id);
      if (other && String(other.productId) === String(input.productId) && ['rejected', 'expired'].indexOf(stateOf_(other)) < 0) {
        throw apiError_('同じ商品の投稿案がすでにあります', 'duplicate');
      }
    }
    const id = randomHex_();
    const key = randomHex_() + randomHex_();
    const now = Date.now();
    const d = {
      id: id, keyHash: sha256Hex_(key), state: 'awaiting', createdAt: now, expiresAt: now + APP.DRAFT_TTL_MS,
      productId: String(input.productId), handle: String(input.handle || ''), title: String(input.title), url: String(input.url),
      image: String(input.image), message: String(input.message), originalHash: String(input.originalHash),
      postDate: String(input.postDate), generatedAt: String(input.generatedAt || ''), genre: String(input.genre || ''),
      factCheck: 'passed', sourceHash: hashOf_(JSON.stringify(source))
    };
    event_(d, '投稿案を受け付けました');
    saveDraft_(d);
    store_().setProperty('src:' + id, JSON.stringify(source));
    try {
      sendDraftMail_(d, key, cfg);
    } catch (err) {
      store_().deleteProperty('draft:' + id);
      store_().deleteProperty('src:' + id);
      throw apiError_('メールを送れませんでした: ' + err.message, 'mail_failed');
    }
    return { ok: true, draftId: id };
  });
}

function apiDraftFailed_(req, cfg) {
  if (!cfg.owner) throw apiError_('OWNER_EMAIL が設定されていません', 'not_configured');
  const reason = String(req.reason || '').slice(0, 300);
  const detail = String(req.detail || '').slice(0, 3000);
  MailApp.sendEmail({
    to: cfg.owner,
    subject: '[ふくしま市場] 投稿案を作れませんでした',
    name: 'ふくしま市場 投稿承認',
    body: '投稿案を作れませんでした(Facebook には何も送っていません)。\n\n' + reason + '\n\n' + detail,
    htmlBody: '<p>投稿案を作れませんでした(Facebook には何も送っていません)。</p><p><b>' + esc(reason) + '</b></p><pre style="white-space:pre-wrap">' + esc(detail) + '</pre>'
  });
  return { ok: true };
}

function apiGetApproved_(req) {
  const id = String(req.draftId || '');
  if (!/^[0-9a-f]{32}$/.test(id)) throw apiError_('投稿案IDが不正です', 'invalid');
  return withLock_(() => {
    const d = loadDraft_(id);
    if (!d) throw apiError_('投稿案が見つかりません', 'not_found');
    if (d.state !== 'publish_requested') throw apiError_('公開を頼まれていない投稿案です(' + (STATE_LABELS[stateOf_(d)] || d.state) + ')', 'state_' + d.state);
    if (Date.now() - d.requestedAt > APP.PUBLISH_REQUEST_TTL_MS) {
      d.state = 'decided';
      event_(d, '公開の開始から時間がたちすぎたため、公開を取り消しました');
      saveDraft_(d);
      throw apiError_('公開の依頼から時間がたちすぎています。承認画面からもう一度「公開する」を押してください', 'request_expired');
    }
    // 受け取りは1回だけ(同じ依頼で二度公開しない)
    d.state = 'publishing';
    d.publishingAt = Date.now();
    event_(d, '公開処理が内容を受け取りました');
    saveDraft_(d);
    return {
      ok: true,
      content: {
        draftId: d.id, pageId: APP.PAGE_ID, productId: d.productId, url: d.url, image: d.image, title: d.title, postDate: d.postDate,
        message: d.finalMessage, hash: d.finalHash, action: d.decision.action,
        originalMessage: d.message, originalHash: d.originalHash, source: loadSource_(d.id)
      }
    };
  });
}

function apiReport_(req, cfg) {
  const id = String(req.draftId || '');
  const result = String(req.result || '');
  if (!/^[0-9a-f]{32}$/.test(id) || !REPORT_STATES[result]) throw apiError_('結果の連絡が不正です', 'invalid');
  return withLock_(() => {
    const d = loadDraft_(id);
    if (!d) throw apiError_('投稿案が見つかりません', 'not_found');
    if (d.state !== 'publishing') throw apiError_('公開処理中ではありません', 'state_' + d.state);
    d.state = REPORT_STATES[result];
    d.result = {
      result: result, at: new Date().toISOString(), fbPostId: String(req.fbPostId || ''), permalink: String(req.permalink || ''),
      publishedAt: String(req.publishedAt || ''), detail: String(req.detail || '').slice(0, 1000), runUrl: String(req.runUrl || '')
    };
    event_(d, '公開処理の結果: ' + result);
    saveDraft_(d);
    if (cfg.owner) sendResultMail_(d, cfg);
    return { ok: true, state: d.state };
  });
}

// ---------------------------------------------------------------------------
// メール
// ---------------------------------------------------------------------------

function messageHtml_(message, url) {
  return String(message).split(/\n{2,}/).map(p => '<p style="margin:0 0 10px">' + esc(p).replace(/\n/g, '<br>').replace(esc(url), '<a href="' + esc(url) + '">' + esc(url) + '</a>') + '</p>').join('');
}

function imageUrl_(src, width) {
  return src + (src.indexOf('?') >= 0 ? '&' : '?') + 'width=' + width;
}

function sendDraftMail_(d, key, cfg) {
  const link = cfg.uiUrl + '?d=' + d.id + '&k=' + key;
  const until = Utilities.formatDate(new Date(d.expiresAt), 'Asia/Tokyo', 'M月d日 HH:mm');
  MailApp.sendEmail({
    to: cfg.owner,
    subject: '[ふくしま市場] 投稿案の承認のお願い: ' + d.title,
    name: 'ふくしま市場 投稿承認',
    body: [
      'Facebook 投稿案の承認をお願いします(まだ投稿していません)。', '',
      '商品: ' + d.title, '商品URL: ' + d.url, '', '--- 投稿文 ---', d.message, '', '承認画面を開く: ' + link,
      '(' + until + 'まで有効。画面を開いただけでは投稿されません)'
    ].join('\n'),
    htmlBody:
      '<div style="font-family:sans-serif;max-width:600px;line-height:1.6">' +
      '<p>Facebook 投稿案の承認をお願いします(<b>まだ投稿していません</b>)。</p>' +
      '<p><b>' + esc(d.title) + '</b><br><a href="' + esc(d.url) + '">' + esc(d.url) + '</a></p>' +
      '<p><img src="' + esc(imageUrl_(d.image, 600)) + '" alt="' + esc(d.title) + '" width="300" style="max-width:100%;height:auto;border-radius:6px"></p>' +
      '<div style="border:1px solid #ced0d4;border-radius:8px;padding:12px">' + messageHtml_(d.message, d.url) + '</div>' +
      '<p style="margin-top:20px"><a href="' + esc(link) + '" style="display:inline-block;background:#1877f2;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">承認画面を開く</a></p>' +
      '<p style="color:#65676b;font-size:13px">投稿先: ' + esc(APP.PAGE_NAME) + '(ページID ' + APP.PAGE_ID + ')<br>' +
      'リンクの有効期限: ' + esc(until) + '<br>承認画面は、このプロジェクトの所有者の Google アカウントでログインしているときだけ開けます。画面を開いただけでは何も変わりません。<br>' +
      'このメールを転送しないでください(リンクに承認用の鍵が含まれています)。</p></div>'
  });
}

function sendResultMail_(d, cfg) {
  const r = d.result || {};
  const title = {
    published: '公開しました', unverified: '投稿は作られましたが公開を確認できません', unknown: '公開されたか確認できません(要確認)',
    not_published: '公開できませんでした(投稿されていません)', dry_run: '確認のみ(実際には投稿していません)', refused: '公開の条件を満たさないため、投稿しませんでした'
  }[r.result] || r.result;
  const rows = [
    ['結果', title], ['商品', d.title], ['Facebook 投稿ID', r.fbPostId || '-'], ['投稿URL', r.permalink || '-'],
    ['公開日時', r.publishedAt || '-'], ['詳細', r.detail || '-'], ['GitHub Actions', r.runUrl || '-']
  ];
  MailApp.sendEmail({
    to: cfg.owner,
    subject: '[ふくしま市場] 投稿の結果: ' + title + ' / ' + d.title,
    name: 'ふくしま市場 投稿承認',
    body: rows.map(x => x[0] + ': ' + x[1]).join('\n'),
    htmlBody: '<table style="font-family:sans-serif;border-collapse:collapse">' +
      rows.map(x => '<tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ddd">' + esc(x[0]) + '</th><td style="padding:4px 8px;border-bottom:1px solid #ddd">' +
        (/^https:\/\//.test(x[1]) ? '<a href="' + esc(x[1]) + '">' + esc(x[1]) + '</a>' : esc(x[1])) + '</td></tr>').join('') + '</table>'
  });
}

// ---------------------------------------------------------------------------
// 承認画面(/dev): 所有者だけ
// ---------------------------------------------------------------------------

function isOwner_(cfg) {
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  return !!cfg.owner && email === cfg.owner;
}

function requireOwner_(cfg) {
  if (!isOwner_(cfg)) throw new Error('この操作はできません(承認する人の Google アカウントでログインしてください)');
}

/** リンクの投稿案IDと鍵を確かめる。合わなければ null */
function authorizeDraft_(id, key) {
  if (!/^[0-9a-f]{32}$/.test(String(id)) || !/^[0-9a-f]{64}$/.test(String(key))) return null;
  const d = loadDraft_(id);
  if (!d || !safeEqual_(sha256Hex_(key), d.keyHash)) return null;
  return d;
}

function doGet(e) {
  const cfg = config_();
  if (!isOwner_(cfg)) return page_('表示できません', '<p>このページは表示できません。</p>');
  const p = (e && e.parameter) || {};
  const d = authorizeDraft_(p.d, p.k);
  if (!d) return page_('リンクが無効です', '<p class="ng">リンクが無効です(投稿案が見つからないか、リンクの鍵が一致しません)。</p>');
  return page_('投稿案の承認', draftPageHtml_(d, p.k));
}

function finalView_(d) {
  return {
    title: d.title, url: d.url, image: d.image, imageView: imageUrl_(d.image, 600), message: d.finalMessage,
    hash: d.finalHash, action: d.decision ? d.decision.action : '', pageName: APP.PAGE_NAME, pageId: APP.PAGE_ID
  };
}

function statusView_(d) {
  const state = stateOf_(d);
  return { state: state, label: STATE_LABELS[state] || state, result: d.result || null, final: d.state === 'decided' ? finalView_(d) : null };
}

function draftPageHtml_(d, key) {
  const state = stateOf_(d);
  const open = OPEN_STATES.indexOf(state) >= 0;
  const record = {
    postDate: d.postDate, week: 'mail-' + d.id, productId: d.productId, title: d.title, url: d.url, generatedAt: d.generatedAt,
    originalHash: d.originalHash, sourceHash: d.sourceHash, message: d.message, source: loadSource_(d.id), status: 'candidate', factCheck: 'passed'
  };
  const card =
    '<section class="panel"><h2>' + esc(d.title) + '</h2>' +
    '<p><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.url) + '</a></p>' +
    '<div class="post"><div class="message">' + messageHtml_(d.message, d.url) + '</div>' +
    '<div class="photos"><img src="' + esc(imageUrl_(d.image, 600)) + '" alt="' + esc(d.title) + '"></div></div>' +
    (open ? reviewWidget(record) : '') +
    '<details><summary>商品情報(事実確認の対象)</summary><pre>' + esc([record.source.title, record.source.description].join('\n')) + '</pre></details>' +
    '</section>';
  const status =
    '<section class="panel" id="status"><h2>状態: <span id="status-label">' + esc(STATE_LABELS[state] || state) + '</span></h2>' +
    '<div id="status-result">' + resultHtml_(d) + '</div></section>';
  const finalBox =
    '<section class="panel" id="final"' + (d.state === 'decided' && open ? '' : ' hidden') + '>' +
    '<h2>最終確認(この内容で公開します)</h2>' +
    '<p class="meta">投稿先: ' + esc(APP.PAGE_NAME) + '(ページID ' + APP.PAGE_ID + ')・即時公開・1件のみ</p>' +
    '<div class="post"><div class="message" id="final-message"></div><div class="photos"><img id="final-image" alt=""></div></div>' +
    '<p>商品URL: <a id="final-url" target="_blank" rel="noopener"></a></p>' +
    '<label class="rv-confirm-label"><input type="checkbox" id="publish-confirm"> 投稿先・本文・画像・商品URLを確認しました。この内容で今すぐ公開します</label>' +
    '<div class="review-actions final-actions"><button type="button" id="publish-btn" disabled>公開する</button></div>' +
    '<p class="meta" id="publish-msg"></p></section>';
  const ctx = { d: d.id, k: key, final: d.state === 'decided' && open ? finalView_(d) : null, state: state };
  return '<h1>Facebook 投稿案の承認</h1>' +
    '<div class="notice">この画面を開いただけでは何も変わりません。判断は「この判断で進む」で保存され、Facebook への投稿は最終確認で「公開する」を押したときだけ行います。却下した投稿案は投稿しません。</div>' +
    status +
    (open ? REVIEW_BAR_MAIL : '') +
    card + finalBox +
    '<script type="application/json" id="fb-review-data">' + jsonForScript({ week: record.week, dataSource: 'live', pageId: APP.PAGE_ID, records: open ? [record] : [], mode: 'mail' }) + '</script>' +
    '<script type="application/json" id="mail-ctx">' + jsonForScript(ctx) + '</script>' +
    (open ? '<script>' + REVIEW_SCRIPT + '</script>' : '') +
    '<script>' + MAIL_PAGE_SCRIPT_ + '</script>';
}

function resultHtml_(d) {
  const r = d.result;
  if (!r) return '';
  const link = r.permalink ? '<a href="' + esc(r.permalink) + '" target="_blank" rel="noopener">' + esc(r.permalink) + '</a>' : '-';
  return '<table><tr><th>結果</th><td>' + esc(r.result) + '</td></tr><tr><th>Facebook 投稿ID</th><td>' + esc(r.fbPostId || '-') + '</td></tr>' +
    '<tr><th>投稿URL</th><td>' + link + '</td></tr><tr><th>公開日時</th><td>' + esc(r.publishedAt || '-') + '</td></tr>' +
    '<tr><th>詳細</th><td>' + esc(r.detail || '-') + '</td></tr></table>';
}

const PAGE_CSS_ = [
  ':root { --bg:#f0f2f5; --card:#fff; --text:#050505; --sub:#65676b; --line:#ced0d4; --soft:#f0f2f5; --warn:#fff4e5; --warn-line:#f0b45a; --ok:#2e7d32; --ng:#c62828; --accent:#1877f2; }',
  '@media (prefers-color-scheme: dark) { :root { --bg:#18191a; --card:#242526; --text:#e4e6eb; --sub:#b0b3b8; --line:#3e4042; --soft:#3a3b3c; --warn:#3a2d17; --warn-line:#a87b2f; --ok:#81c784; --ng:#ef9a9a; --accent:#4599ff; } }',
  '* { box-sizing:border-box; }',
  'body { margin:0; background:var(--bg); color:var(--text); font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif; line-height:1.5; }',
  'main { max-width:760px; margin:0 auto; padding:16px; }',
  'a { color:var(--accent); } h1 { font-size:20px; margin:8px 0 4px; } h2 { font-size:17px; margin:0 0 6px; }',
  '.meta { color:var(--sub); font-size:13px; } .ok { color:var(--ok); } .ng { color:var(--ng); font-weight:600; } .warn { color:#a15c00; }',
  '.notice { background:var(--warn); border:1px solid var(--warn-line); border-radius:8px; padding:10px 12px; font-size:14px; margin:12px 0 16px; }',
  '.panel { background:var(--card); border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,.2); padding:12px 16px; margin-bottom:16px; }',
  'table { width:100%; border-collapse:collapse; font-size:13px; } th, td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }',
  '.post { border:1px solid var(--line); border-radius:8px; overflow:hidden; }',
  '.message { padding:10px 12px 12px; font-size:15px; line-height:1.6; overflow-wrap:anywhere; } .message p { margin:0 0 .7em; } .message p:last-child { margin-bottom:0; }',
  '.photos img { display:block; width:100%; max-width:420px; min-width:0; aspect-ratio:1/1; object-fit:cover; background:var(--line); }',
  'details { margin-top:8px; font-size:13px; } details pre { white-space:pre-wrap; background:var(--soft); padding:8px; border-radius:6px; overflow-wrap:anywhere; font-family:inherit; }',
  '.final-actions button { font:inherit; font-size:15px; padding:10px 20px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }',
  '.final-actions button:disabled { background:transparent; color:var(--sub); border-color:var(--line); cursor:not-allowed; }',
  '.review-note { display:none; }' // 週次の画面向けの注記(コマンドでの反映)は、メール承認では使わない
].join('\n');

function page_(title, inner) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + PAGE_CSS_ + '\n' + REVIEW_CSS + '</style></head><body><main>' + inner + '</main></body></html>'
  ).setTitle(title + ' | ふくしま市場').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 承認画面のブラウザ側(判断の送信・最終確認・公開の開始・状態の更新) */
const MAIL_PAGE_SCRIPT_ = `(() => {
  const CTX = JSON.parse(document.getElementById('mail-ctx').textContent);
  const $ = s => document.querySelector(s);
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const errText = e => (e && e.message) || String(e);
  let finalHash = '';
  function setStatus(v) {
    $('#status-label').textContent = v.label;
    if (v.result) {
      const r = v.result;
      $('#status-result').innerHTML = '<table><tr><th>結果</th><td>' + escHtml(r.result) + '</td></tr><tr><th>Facebook 投稿ID</th><td>' + escHtml(r.fbPostId || '-') +
        '</td></tr><tr><th>投稿URL</th><td>' + (r.permalink ? '<a target="_blank" rel="noopener" href="' + escHtml(r.permalink) + '">' + escHtml(r.permalink) + '</a>' : '-') +
        '</td></tr><tr><th>公開日時</th><td>' + escHtml(r.publishedAt || '-') + '</td></tr><tr><th>詳細</th><td>' + escHtml(r.detail || '-') + '</td></tr></table>';
    }
  }
  function showFinal(f) {
    if (!f) { $('#final').hidden = true; return; }
    finalHash = f.hash;
    $('#final-message').innerHTML = f.message.split(/\\n{2,}/).map(p => '<p>' + escHtml(p).replace(/\\n/g, '<br>') + '</p>').join('');
    $('#final-image').src = f.imageView;
    $('#final-image').alt = f.title;
    $('#final-url').href = f.url;
    $('#final-url').textContent = f.url;
    $('#publish-confirm').checked = false;
    $('#publish-btn').disabled = true;
    $('#final').hidden = false;
    $('#final').scrollIntoView({ behavior: 'smooth' });
  }
  function lockDecision() {
    document.querySelectorAll('.review button, #review-bar button, #review-confirm button').forEach(b => { b.disabled = true; });
  }
  window.__fbReviewSubmit = file => {
    const btn = $('#review-save-json');
    btn.disabled = true;
    $('.review-saved').textContent = '保存しています…';
    google.script.run
      .withSuccessHandler(r => {
        btn.disabled = false;
        setStatus(r);
        if (r.state === 'rejected') {
          $('.review-saved').textContent = '却下として保存しました。この投稿案は投稿しません。';
          $('#final').hidden = true;
          lockDecision();
        } else {
          $('.review-saved').textContent = '判断を保存しました(まだ投稿していません)。下の最終確認で内容を確かめてください。';
          showFinal(r.final);
        }
      })
      .withFailureHandler(e => { btn.disabled = false; $('.review-saved').textContent = 'エラー: ' + errText(e); })
      .submitDecision(CTX.d, CTX.k, file);
  };
  const confirmBox = $('#publish-confirm');
  if (confirmBox) confirmBox.addEventListener('change', () => { $('#publish-btn').disabled = !confirmBox.checked || !finalHash; });
  const publishBtn = $('#publish-btn');
  if (publishBtn) publishBtn.addEventListener('click', () => {
    if (!confirmBox.checked || !finalHash) return;
    publishBtn.disabled = true;
    confirmBox.disabled = true;
    $('#publish-msg').textContent = '公開処理を開始しています…';
    google.script.run
      .withSuccessHandler(r => {
        setStatus(r);
        lockDecision();
        $('#publish-msg').textContent = '公開処理を開始しました。数分で完了します。結果はこの画面とメールでお知らせします(この画面は閉じてもかまいません)。';
        poll(0);
      })
      .withFailureHandler(e => { confirmBox.disabled = false; publishBtn.disabled = !confirmBox.checked; $('#publish-msg').textContent = 'エラー: ' + errText(e); })
      .requestPublish(CTX.d, CTX.k, finalHash);
  });
  function poll(n) {
    if (n > 40) return;
    setTimeout(() => google.script.run.withSuccessHandler(v => {
      setStatus(v);
      if (['publish_requested', 'publishing'].includes(v.state)) poll(n + 1);
      else if (v.state === 'decided') { $('#publish-msg').textContent = '公開されませんでした(詳細は上の結果を確認してください)。内容を確かめて、もう一度「公開する」を押せます。'; showFinal(v.final); confirmBox.disabled = false; }
      else $('#publish-msg').textContent = '';
    }).getStatus(CTX.d, CTX.k), 15000);
  }
  if (CTX.final) showFinal(CTX.final);
  if (['publish_requested', 'publishing'].includes(CTX.state)) poll(0);
})();`;

// 承認画面から呼ぶ関数(google.script.run)。どれも所有者と鍵を確かめる

function submitDecision(id, key, file) {
  const cfg = config_();
  requireOwner_(cfg);
  return withLock_(() => {
    const d = authorizeDraft_(id, key);
    if (!d) throw new Error('リンクが無効です');
    const state = stateOf_(d);
    if (OPEN_STATES.indexOf(state) < 0) throw new Error('この投稿案はもう判断を変えられません(' + (STATE_LABELS[state] || state) + ')');
    const dec = file && file.kind === 'fb-decisions' && file.version === 1 && Array.isArray(file.decisions) && file.decisions.length === 1 ? file.decisions[0] : null;
    if (!dec) throw new Error('判断の形式が不正です');
    if (String(dec.productId) !== d.productId || dec.originalHash !== d.originalHash || dec.postDate !== d.postDate) throw new Error('判断の対象がこの投稿案と一致しません');
    const decidedAt = new Date().toISOString();
    if (dec.action === 'reject') {
      if (RULES.REJECT_REASONS.indexOf(dec.reason) < 0) throw new Error('却下の理由を選んでください');
      d.state = 'rejected';
      d.decision = { action: 'reject', reason: dec.reason, note: String(dec.note || '').slice(0, 500), decidedAt: decidedAt };
      delete d.finalMessage;
      delete d.finalHash;
      event_(d, '却下しました');
      saveDraft_(d);
      return statusView_(d);
    }
    let finalMessage;
    if (dec.action === 'approve') {
      finalMessage = d.message;
      d.decision = { action: 'approve', decidedAt: decidedAt };
    } else if (dec.action === 'edit') {
      if (dec.confirmNoNewFacts !== true) throw new Error('「商品情報にない事実を追加していません」の確認が必要です');
      const tags = Array.isArray(dec.hashtags) ? dec.hashtags.map(String) : [];
      const check = checkEdit({ body: String(dec.body || ''), extraTags: tags, original: d.message, source: loadSource_(d.id), postDate: d.postDate });
      if (check.errors.length) throw new Error('修正した投稿文に問題があります: ' + check.errors.join(' / '));
      finalMessage = buildMessage(normalizeMessage(String(dec.body)), d.url, check.tags);
      d.decision = { action: 'edit', body: normalizeMessage(String(dec.body)), hashtags: check.tags, warnings: check.warnings, decidedAt: decidedAt };
    } else {
      throw new Error('判断の種類が不正です');
    }
    const parts = splitMessage(finalMessage);
    if (parts.url !== d.url || parts.hashtags.length !== 4) throw new Error('最終的な投稿文の形が不正です');
    d.state = 'decided';
    d.finalMessage = finalMessage;
    d.finalHash = contentHash_(d.productId, d.url, d.image, finalMessage);
    event_(d, d.decision.action === 'edit' ? '修正して承認しました' : '承認しました');
    saveDraft_(d);
    return statusView_(d);
  });
}

function requestPublish(id, key, hash) {
  const cfg = config_();
  requireOwner_(cfg);
  return withLock_(() => {
    const d = authorizeDraft_(id, key);
    if (!d) throw new Error('リンクが無効です');
    const state = stateOf_(d);
    if (state !== 'decided') throw new Error('公開できる状態ではありません(' + (STATE_LABELS[state] || state) + ')');
    if (!d.finalHash || hash !== d.finalHash) throw new Error('確認した内容と保存されている内容が一致しません。画面を開き直してください');
    d.state = 'publish_requested';
    d.requestedAt = Date.now();
    delete d.result;
    event_(d, '「公開する」が押されました');
    saveDraft_(d);
    try {
      dispatchPublish_(cfg, d.id);
    } catch (err) {
      d.state = 'decided';
      event_(d, '公開処理を起動できませんでした');
      saveDraft_(d);
      throw new Error('GitHub の公開処理を起動できませんでした(投稿はしていません): ' + err.message);
    }
    return statusView_(d);
  });
}

function getStatus(id, key) {
  const cfg = config_();
  requireOwner_(cfg);
  const d = authorizeDraft_(id, key);
  if (!d) throw new Error('リンクが無効です');
  return statusView_(d);
}

function dispatchPublish_(cfg, draftId) {
  if (!cfg.githubToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repo)) throw new Error('GITHUB_TOKEN / GITHUB_REPO が設定されていません');
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + cfg.repo + '/actions/workflows/' + APP.WORKFLOW + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.githubToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ ref: APP.REF, inputs: { draft_id: draftId } }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) throw new Error('HTTP ' + res.getResponseCode() + '(ワークフローが無効になっていないか確認してください)');
}
