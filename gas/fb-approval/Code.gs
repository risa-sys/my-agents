/**
 * ふくしま市場 Facebook 投稿の「メール承認」(Google Apps Script)
 *
 * 流れ:
 *   1. GitHub Actions(fb-mail-draft.yml)が投稿案を1件作り、署名つきでここ(/exec)に送る → 保存してメールで知らせる
 *   2. メールのリンクから承認画面(/dev。プロジェクトの所有者しか開けない)を開き、承認・修正して承認・却下を選ぶ
 *   3. 承認(修正して承認)を確定すると、すぐに GitHub Actions(fb-mail-publish.yml)を起動する(7日分の予定つき投稿案は予定日時に公開)
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
  MAX_PROPERTY_BYTES: 8500,
  // 7日分(予定日時に自動公開): 各日 18:00(日本時間)。判断できるのは予定時刻まで
  BATCH_SIZE: 7,
  SCHEDULE_TIME: '18:00',
  SCHEDULE_EARLY_MS: 2 * 60 * 1000, // 予定時刻のこれだけ前から受け取れる(時計のずれ)
  SCHEDULE_WINDOW_MS: 2 * 60 * 60 * 1000, // 予定時刻からこの時間を過ぎたら公開しない(遅れて投稿しない)
  MIN_LEAD_MS: 12 * 60 * 60 * 1000 // 作成から最初の予定時刻までの最短(承認の時間を確保する)
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
  expired: '期限切れ',
  missed: '予定時刻までに承認されなかったため公開していません(確認待ち)'
};
const SCHEDULED_DONE_STATES = ['rejected', 'expired', 'missed'];
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
  // 予定日時のある投稿案: 未判断のまま予定時刻を過ぎたら「確認待ち」(公開しない)。承認済みは公開処理が受け取るまで残す
  if (d.scheduledAt && d.state === 'awaiting') return Date.now() >= d.scheduledAt;
  return OPEN_STATES.indexOf(d.state) >= 0 && Date.now() > d.expiresAt;
}

/** 'YYYY-MM-DD' の 18:00(日本時間)のミリ秒 */
function scheduledAtOf_(postDate) {
  return Date.parse(postDate + 'T' + APP.SCHEDULE_TIME + ':00+09:00');
}

function scheduleLabel_(d) {
  return d.scheduledAt ? Utilities.formatDate(new Date(d.scheduledAt), 'Asia/Tokyo', 'yyyy年M月d日') + '(' + '日月火水木金土'.charAt(Number(Utilities.formatDate(new Date(d.scheduledAt), 'Asia/Tokyo', 'u')) % 7) + ') ' + APP.SCHEDULE_TIME : '';
}

function stateOf_(d) {
  return isExpired_(d) ? (d.scheduledAt ? 'missed' : 'expired') : d.state;
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
  if (req.action === 'activeProducts') return apiActiveProducts_();
  if (req.action === 'createBatch') return apiCreateBatch_(req, cfg);
  if (req.action === 'claimScheduled') return apiClaimScheduled_(req, cfg);
  if (req.action === 'reschedule') return apiReschedule_(req, cfg);
  if (req.action === 'resendBatch') return apiResendBatch_(req, cfg);
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
      if (other && String(other.productId) === String(input.productId) && ['rejected', 'expired', 'missed'].indexOf(stateOf_(other)) < 0) {
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
    return { ok: true, content: takeApproved_(d) };
  });
}

/** 承認済みの内容を公開処理に渡す(受け取りは1回だけ。同じ依頼で二度公開しない) */
function takeApproved_(d) {
  d.state = 'publishing';
  d.publishingAt = Date.now();
  event_(d, '公開処理が内容を受け取りました');
  saveDraft_(d);
  return {
    draftId: d.id, pageId: APP.PAGE_ID, productId: d.productId, url: d.url, image: d.image, title: d.title, postDate: d.postDate,
    scheduledAt: d.scheduledAt || 0, batchId: d.batchId || '',
    message: d.finalMessage, hash: d.finalHash, action: d.decision.action,
    originalMessage: d.message, originalHash: d.originalHash, source: loadSource_(d.id)
  };
}

// ---------------------------------------------------------------------------
// 7日分(予定日時に自動公開)
// ---------------------------------------------------------------------------

/** 投稿案のある商品と、公開予定(終わっていないもの)の日付。7日分を作るときに重ならないようにする */
function apiActiveProducts_() {
  const productIds = [];
  const titles = [];
  const scheduledDates = [];
  for (const id of draftIds_()) {
    const d = loadDraft_(id);
    if (!d) continue;
    productIds.push(String(d.productId));
    titles.push(String(d.title));
    if (d.scheduledAt && SCHEDULED_DONE_STATES.indexOf(stateOf_(d)) < 0) scheduledDates.push(d.postDate);
  }
  return { ok: true, productIds: productIds, titles: titles, scheduledDates: scheduledDates };
}

function apiCreateBatch_(req, cfg) {
  if (!cfg.owner || !cfg.uiUrl) throw apiError_('OWNER_EMAIL / UI_URL が設定されていません', 'not_configured');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/dev$/.test(cfg.uiUrl)) throw apiError_('UI_URL は承認画面(…/dev)のURLにしてください', 'not_configured');
  const items = req.items;
  if (!Array.isArray(items) || items.length !== APP.BATCH_SIZE) throw apiError_(APP.BATCH_SIZE + '件そろっていません', 'invalid');
  const errors = [];
  items.forEach((it, i) => {
    const e = validateDraftInput_(it && it.draft, it && it.source);
    if (e.length) errors.push((i + 1) + '件目: ' + e.join(' / '));
  });
  if (errors.length) throw apiError_('投稿案が不正です: ' + errors.join(' | '), 'invalid');
  const products = items.map(it => String(it.draft.productId));
  const dates = items.map(it => String(it.draft.postDate));
  if (new Set(products).size !== products.length) throw apiError_('同じ商品が含まれています', 'duplicate');
  if (new Set(dates).size !== dates.length) throw apiError_('同じ日付が含まれています', 'duplicate');
  const now = Date.now();
  for (const date of dates) {
    const at = scheduledAtOf_(date);
    if (!(at > now + APP.MIN_LEAD_MS)) throw apiError_('公開予定が近すぎるか過ぎています: ' + date, 'invalid');
  }
  return withLock_(() => {
    cleanup_();
    const active = apiActiveProducts_();
    const dupProducts = products.filter(p => active.productIds.indexOf(p) >= 0);
    if (dupProducts.length) throw apiError_('すでに投稿案のある商品が含まれています(' + dupProducts.join(', ') + ')', 'duplicate');
    const dupDates = dates.filter(x => active.scheduledDates.indexOf(x) >= 0);
    if (dupDates.length) throw apiError_('すでに公開予定のある日付です(' + dupDates.join(', ') + ')', 'duplicate');
    const batchId = randomHex_();
    const saved = [];
    try {
      for (const it of items) {
        const input = it.draft;
        const srcIn = it.source;
        const source = {
          title: String(srcIn.title), vendor: String(srcIn.vendor || ''), productType: String(srcIn.productType || ''),
          tags: (srcIn.tags || []).map(String).slice(0, 30), description: String(srcIn.description).slice(0, APP.SOURCE_MAX_CHARS)
        };
        const id = randomHex_();
        const key = randomHex_() + randomHex_();
        const scheduledAt = scheduledAtOf_(String(input.postDate));
        const d = {
          id: id, keyHash: sha256Hex_(key), state: 'awaiting', createdAt: now, expiresAt: scheduledAt + APP.SCHEDULE_WINDOW_MS,
          batchId: batchId, scheduledAt: scheduledAt,
          productId: String(input.productId), handle: String(input.handle || ''), title: String(input.title), url: String(input.url),
          image: String(input.image), message: String(input.message), originalHash: String(input.originalHash),
          postDate: String(input.postDate), generatedAt: String(input.generatedAt || ''), genre: String(input.genre || ''),
          factCheck: 'passed', sourceHash: hashOf_(JSON.stringify(source))
        };
        event_(d, '投稿案を受け付けました(7日分・公開予定 ' + scheduleLabel_(d) + ')');
        saveDraft_(d);
        store_().setProperty('src:' + id, JSON.stringify(source));
        saved.push({ d: d, key: key });
      }
      sendBatchMail_(saved, cfg);
    } catch (err) {
      for (const s of saved) {
        store_().deleteProperty('draft:' + s.d.id);
        store_().deleteProperty('src:' + s.d.id);
      }
      throw apiError_('7日分の投稿案を保存・送信できませんでした: ' + err.message, 'mail_failed');
    }
    return { ok: true, batchId: batchId, draftIds: saved.map(s => s.d.id) };
  });
}

/**
 * 7日分の公開予定日を変える(商品・投稿文・画像・判断はそのまま)。
 * req.dates は今の公開予定の早い順に対応する新しい日付。承認画面のリンクは作り直し、承認メールを送り直す(古いリンクは使えなくなる)。
 */
function apiReschedule_(req, cfg) {
  if (!cfg.owner || !cfg.uiUrl) throw apiError_('OWNER_EMAIL / UI_URL が設定されていません', 'not_configured');
  const batchId = String(req.batchId || '');
  const dates = Array.isArray(req.dates) ? req.dates.map(String) : [];
  if (!/^[0-9a-f]{32}$/.test(batchId)) throw apiError_('まとめIDが不正です', 'invalid');
  if (dates.some(x => !/^\d{4}-\d{2}-\d{2}$/.test(x) || isNaN(scheduledAtOf_(x)))) throw apiError_('日付が不正です', 'invalid');
  if (new Set(dates).size !== dates.length) throw apiError_('同じ日付が含まれています', 'duplicate');
  const now = Date.now();
  for (const date of dates) {
    if (!(scheduledAtOf_(date) > now + APP.MIN_LEAD_MS)) throw apiError_('公開予定が近すぎるか過ぎています: ' + date, 'invalid');
  }
  return withLock_(() => {
    const all = draftIds_().map(loadDraft_).filter(Boolean);
    const batch = all.filter(d => d.batchId === batchId).sort((a, b) => a.scheduledAt - b.scheduledAt);
    if (!batch.length) throw apiError_('まとめが見つかりません', 'not_found');
    if (batch.length !== dates.length) throw apiError_('日付の数(' + dates.length + ')が投稿案の数(' + batch.length + ')と合いません', 'invalid');
    const bad = batch.filter(d => ['awaiting', 'decided', 'rejected'].indexOf(stateOf_(d)) < 0);
    if (bad.length) throw apiError_('公開処理が始まった・終わった投稿案があるため変更できません(' + bad.map(d => d.postDate + ' ' + stateOf_(d)).join(', ') + ')', 'invalid_state');
    const others = all.filter(d => d.batchId !== batchId && d.scheduledAt && SCHEDULED_DONE_STATES.indexOf(stateOf_(d)) < 0).map(d => d.postDate);
    const clash = dates.filter(x => others.indexOf(x) >= 0);
    if (clash.length) throw apiError_('ほかの投稿案の公開予定と重なります(' + clash.join(', ') + ')', 'duplicate');
    const backup = batch.map(d => JSON.stringify(d));
    const saved = batch.map((d, i) => {
      const before = scheduleLabel_(d);
      const key = randomHex_() + randomHex_();
      d.postDate = dates[i];
      d.scheduledAt = scheduledAtOf_(dates[i]);
      d.expiresAt = d.scheduledAt + APP.SCHEDULE_WINDOW_MS;
      d.keyHash = sha256Hex_(key);
      event_(d, '公開予定を変更しました(' + before + ' → ' + scheduleLabel_(d) + ')。判断は引き継ぎ、承認画面のリンクを作り直しました');
      return { d: d, key: key };
    });
    try {
      saved.forEach(s => saveDraft_(s.d));
      sendBatchMail_(saved, cfg, { rescheduled: true });
    } catch (err) {
      backup.forEach(json => saveDraft_(JSON.parse(json)));
      throw apiError_('公開予定を変更できませんでした(元に戻しました): ' + err.message, 'mail_failed');
    }
    return { ok: true, batchId: batchId, items: saved.map(s => ({ draftId: s.d.id, postDate: s.d.postDate, state: s.d.state })) };
  });
}

/**
 * 7日分の承認メールを送り直す(内容・日付・判断はそのまま)。承認画面のリンクの鍵は作り直す(古いメールのリンクは使えなくなる)。
 */
function apiResendBatch_(req, cfg) {
  if (!cfg.owner || !cfg.uiUrl) throw apiError_('OWNER_EMAIL / UI_URL が設定されていません', 'not_configured');
  const batchId = String(req.batchId || '');
  if (!/^[0-9a-f]{32}$/.test(batchId)) throw apiError_('まとめIDが不正です', 'invalid');
  return withLock_(() => {
    const batch = draftIds_().map(loadDraft_).filter(d => d && d.batchId === batchId).sort((a, b) => a.scheduledAt - b.scheduledAt);
    if (!batch.length) throw apiError_('まとめが見つかりません', 'not_found');
    const backup = batch.map(d => JSON.stringify(d));
    const saved = batch.map(d => {
      const key = randomHex_() + randomHex_();
      d.keyHash = sha256Hex_(key);
      event_(d, '承認メールを送り直しました(承認画面のリンクを作り直しました)');
      return { d: d, key: key };
    });
    try {
      saved.forEach(x => saveDraft_(x.d));
      sendBatchMail_(saved, cfg, { resent: true });
    } catch (err) {
      backup.forEach(json => saveDraft_(JSON.parse(json)));
      throw apiError_('承認メールを送り直せませんでした(元に戻しました): ' + err.message, 'mail_failed');
    }
    return { ok: true, batchId: batchId, items: saved.map(x => ({ draftId: x.d.id, postDate: x.d.postDate, state: stateOf_(x.d) })) };
  });
}

/**
 * 予定日時の公開処理(fb-mail-scheduled.yml)が、その日の投稿案を受け取る。
 * 承認済みだけを渡す。未判断は「確認待ち」にして知らせ、却下・終わったものは渡さない。
 */
function apiClaimScheduled_(req, cfg) {
  const date = String(req.postDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw apiError_('日付が不正です', 'invalid');
  return withLock_(() => {
    const list = draftIds_().map(loadDraft_).filter(d => d && d.scheduledAt && d.postDate === date);
    const live = list.filter(d => ['rejected'].indexOf(d.state) < 0);
    if (!list.length) return { ok: true, status: 'none' };
    if (live.length > 1) throw apiError_('同じ日付の投稿案が複数あります(公開しません)', 'duplicate_date');
    if (!live.length) return { ok: true, status: 'rejected' };
    const d = live[0];
    const now = Date.now();
    if (now < d.scheduledAt - APP.SCHEDULE_EARLY_MS) return { ok: true, status: 'too_early', scheduledAt: d.scheduledAt };
    if (d.state === 'awaiting') {
      d.state = 'missed';
      event_(d, '予定時刻までに承認されなかったため、公開しませんでした');
      saveDraft_(d);
      if (cfg.owner) sendMissedMail_(d, cfg, '予定時刻までに承認されなかったため、公開していません(確認待ち)。');
      return { ok: true, status: 'not_approved' };
    }
    if (d.state !== 'decided') return { ok: true, status: 'already', state: d.state };
    if (now > d.scheduledAt + APP.SCHEDULE_WINDOW_MS) {
      d.state = 'expired';
      event_(d, '予定時刻から時間がたちすぎたため、公開しませんでした');
      saveDraft_(d);
      if (cfg.owner) sendMissedMail_(d, cfg, '承認済みですが、予定時刻から2時間以内に公開処理を始められなかったため、公開していません(遅れて投稿はしません)。');
      return { ok: true, status: 'too_late' };
    }
    return { ok: true, status: 'claimed', content: takeApproved_(d) };
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
      '(' + until + 'まで有効。画面を開いただけでは投稿されません。承認を確定すると、すぐに Facebook へ公開します)'
    ].join('\n'),
    htmlBody:
      '<div style="font-family:sans-serif;max-width:600px;line-height:1.6">' +
      '<p>Facebook 投稿案の承認をお願いします(<b>まだ投稿していません</b>)。承認画面で承認を確定すると、<b>すぐに Facebook へ公開</b>します。</p>' +
      '<p><b>' + esc(d.title) + '</b><br><a href="' + esc(d.url) + '">' + esc(d.url) + '</a></p>' +
      '<p><img src="' + esc(imageUrl_(d.image, 600)) + '" alt="' + esc(d.title) + '" width="300" style="max-width:100%;height:auto;border-radius:6px"></p>' +
      '<div style="border:1px solid #ced0d4;border-radius:8px;padding:12px">' + messageHtml_(d.message, d.url) + '</div>' +
      '<p style="margin-top:20px"><a href="' + esc(link) + '" style="display:inline-block;background:#1877f2;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">承認画面を開く</a></p>' +
      '<p style="color:#65676b;font-size:13px">投稿先: ' + esc(APP.PAGE_NAME) + '(ページID ' + APP.PAGE_ID + ')<br>' +
      'リンクの有効期限: ' + esc(until) + '<br>承認画面は、このプロジェクトの所有者の Google アカウントでログインしているときだけ開けます。画面を開いただけでは何も変わりません。<br>' +
      'このメールを転送しないでください(リンクに承認用の鍵が含まれています)。</p></div>'
  });
}

function sendBatchMail_(saved, cfg, opts) {
  const re = !!(opts && opts.rescheduled);
  const resent = !!(opts && opts.resent);
  const btn = (href, label, color) => '<a href="' + esc(href) + '" style="display:inline-block;background:' + color + ';color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:bold;margin:0 6px 6px 0">' + label + '</a>';
  const overview = cfg.uiUrl + '?b=' + (saved[0].d.batchId || '');
  const first = saved[0].d;
  const last = saved[saved.length - 1].d;
  const range = Utilities.formatDate(new Date(first.scheduledAt), 'Asia/Tokyo', 'M/d') + '〜' + Utilities.formatDate(new Date(last.scheduledAt), 'Asia/Tokyo', 'M/d');
  const text = [];
  let html = '';
  saved.forEach((s, i) => {
    const d = s.d;
    const link = cfg.uiUrl + '?d=' + d.id + '&k=' + s.key;
    const st = stateOf_(d) !== 'awaiting' ? '(現在: ' + (STATE_LABELS[stateOf_(d)] || d.state) + ')' : '';
    text.push('■ ' + (i + 1) + '. 公開予定 ' + scheduleLabel_(d) + st, '商品: ' + d.title, '商品URL: ' + d.url, '画像: ' + d.image, '--- 投稿文 ---', d.message, '承認する: ' + link + '&a=approve', '修正する: ' + link + '&a=edit', '却下する: ' + link + '&a=reject', '');
    html +=
      '<div style="border:1px solid #ced0d4;border-radius:8px;padding:12px;margin:0 0 20px">' +
      '<p style="margin:0 0 6px;font-size:15px"><b>' + (i + 1) + '. 公開予定 ' + esc(scheduleLabel_(d)) + '</b>' + (st ? ' <span style="color:#1a7f37">' + esc(st) + '</span>' : '') + '</p>' +
      '<p style="margin:0 0 8px"><b>' + esc(d.title) + '</b><br><a href="' + esc(d.url) + '">' + esc(d.url) + '</a></p>' +
      '<p style="margin:0 0 8px"><img src="' + esc(imageUrl_(d.image, 600)) + '" alt="' + esc(d.title) + '" width="240" style="max-width:100%;height:auto;border-radius:6px"></p>' +
      '<div style="background:#f7f8fa;border-radius:6px;padding:10px">' + messageHtml_(d.message, d.url) + '</div>' +
      '<p style="margin:12px 0 0">' + btn(link + '&a=approve', '承認する', '#1877f2') + btn(link + '&a=edit', '修正する', '#5b6b7f') + btn(link + '&a=reject', '却下する', '#c62828') + '</p>' +
      '<p style="margin:0;font-size:12px;color:#65676b">ボタンを押すと確認画面が開きます。確認画面で確定するまで、判断は決まりません。</p></div>';
  });
  const note = '承認(または修正して承認)した投稿だけを、それぞれの公開予定日時に自動で公開します。却下・未判断の投稿は公開しません。' +
    '判断は各投稿の公開予定時刻まで変更できます。予定時刻までに判断がない投稿は「確認待ち」になり、公開しません。';
  const reNote = re ? '公開予定日を変更しました。商品・投稿文・画像は前回のメールと同じで、すでにした判断(承認・修正して承認・却下)は引き継いでいます。前回のメールのリンクは使えなくなりました。このメールのリンクから確認してください。'
    : resent ? '操作しやすい形式で送り直しました。商品・投稿文・画像・公開予定日は前回のメールと同じで、すでにした判断は引き継いでいます。前回のメールのリンクは使えなくなりました。このメールのボタンから操作してください。' : '';
  const how = '各投稿の「承認する」「修正する」「却下する」を押すと確認画面が開きます。確認画面で「この判断で確定する」を押したときだけ判断が保存されます(メールのボタンを押しただけでは何も決まりません)。';
  MailApp.sendEmail({
    to: cfg.owner,
    subject: '[ふくしま市場] ' + (re ? '【公開日変更】' : resent ? '【再送】' : '') + '7日分の投稿案の承認のお願い(' + range + ' 各日' + APP.SCHEDULE_TIME + ')',
    name: 'ふくしま市場 投稿承認',
    body: ['Facebook 投稿案7日分の承認をお願いします(まだ投稿していません)。'].concat(reNote ? [reNote] : []).concat([how, note, '7件の状態(承認済み・却下など)の一覧: ' + overview, '投稿先: ' + APP.PAGE_NAME + '(ページID ' + APP.PAGE_ID + ')', '']).concat(text).join('\n'),
    htmlBody:
      '<div style="font-family:sans-serif;max-width:640px;line-height:1.6">' +
      '<p>Facebook 投稿案<b>7日分</b>の承認をお願いします(<b>まだ投稿していません</b>)。</p>' +
      (reNote ? '<p style="background:#fff4e5;border-radius:6px;padding:8px 10px"><b>' + esc(reNote) + '</b></p>' : '') +
      '<p style="font-size:14px"><b>' + esc(how) + '</b></p>' +
      '<p style="font-size:13px;color:#444">' + esc(note) + '</p>' +
      '<p style="font-size:13px"><a href="' + esc(overview) + '">7件の状態(承認済み・却下など)を一覧で見る</a></p>' +
      '<p style="font-size:13px;color:#65676b">投稿先: ' + esc(APP.PAGE_NAME) + '(ページID ' + APP.PAGE_ID + ')</p>' + html +
      '<p style="color:#65676b;font-size:13px">承認画面は、このプロジェクトの所有者の Google アカウントでログインしているときだけ開けます。画面を開いただけでは何も変わりません。<br>' +
      'このメールを転送しないでください(リンクに承認用の鍵が含まれています)。</p></div>'
  });
}

function sendMissedMail_(d, cfg, reason) {
  MailApp.sendEmail({
    to: cfg.owner,
    subject: '[ふくしま市場] 公開しませんでした(' + scheduleLabel_(d) + ') / ' + d.title,
    name: 'ふくしま市場 投稿承認',
    body: reason + '\n\n公開予定: ' + scheduleLabel_(d) + '\n商品: ' + d.title + '\n' + d.url + '\n\nFacebook には何も送っていません。',
    htmlBody: '<div style="font-family:sans-serif;line-height:1.6"><p><b>' + esc(reason) + '</b></p><p>公開予定: ' + esc(scheduleLabel_(d)) + '<br>商品: ' + esc(d.title) +
      '<br><a href="' + esc(d.url) + '">' + esc(d.url) + '</a></p><p>Facebook には何も送っていません。</p></div>'
  });
}

function sendResultMail_(d, cfg) {
  const r = d.result || {};
  const title = {
    published: '公開しました', unverified: '投稿は作られましたが公開を確認できません', unknown: '公開されたか確認できません(要確認)',
    not_published: '公開できませんでした(投稿されていません)', dry_run: '確認のみ(実際には投稿していません)', refused: '公開の条件を満たさないため、投稿しませんでした'
  }[r.result] || r.result;
  const rows = [
    ['結果', title], ['商品', d.title], ['公開予定', d.scheduledAt ? scheduleLabel_(d) : '即時(「公開する」から)'], ['Facebook 投稿ID', r.fbPostId || '-'], ['投稿URL', r.permalink || '-'],
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
  // 一覧(表示だけ。判断はできない)
  if (p.b) return batchOverview_(String(p.b));
  // 画面を開いただけ(GET)では何も保存しない。a は画面で最初に開く操作の指定だけ
  const intent = ['approve', 'edit', 'reject'].indexOf(p.a) >= 0 ? p.a : '';
  const d = authorizeDraft_(p.d, p.k);
  if (!d) return page_('リンクが無効です', '<p class="ng">リンクが無効です(投稿案が見つからないか、リンクの鍵が一致しません)。</p>');
  return page_('投稿案の承認', draftPageHtml_(d, p.k, intent));
}

function finalView_(d) {
  return {
    title: d.title, url: d.url, image: d.image, imageView: imageUrl_(d.image, 600), message: d.finalMessage,
    hash: d.finalHash, action: d.decision ? d.decision.action : '', pageName: APP.PAGE_NAME, pageId: APP.PAGE_ID, scheduled: scheduleLabel_(d)
  };
}

function statusView_(d) {
  const state = stateOf_(d);
  return { state: state, label: STATE_LABELS[state] || state, result: d.result || null, final: d.state === 'decided' ? finalView_(d) : null };
}

function batchOverview_(batchId) {
  if (!/^[0-9a-f]{32}$/.test(batchId)) return page_('リンクが無効です', '<p class="ng">リンクが無効です。</p>');
  const list = draftIds_().map(loadDraft_).filter(d => d && d.batchId === batchId).sort((a, b) => a.scheduledAt - b.scheduledAt);
  if (!list.length) return page_('見つかりません', '<p class="ng">投稿案が見つかりません。</p>');
  const rows = list.map(d => {
    const st = stateOf_(d);
    const cls = st === 'decided' || st === 'published' ? 'ok' : ['rejected', 'missed', 'expired'].indexOf(st) >= 0 ? 'ng' : '';
    const edited = d.decision && d.decision.action === 'edit' && st === 'decided' ? '(修正して承認)' : '';
    return '<tr><td>' + esc(scheduleLabel_(d)) + '</td><td><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a></td><td class="' + cls + '">' + esc((STATE_LABELS[st] || st) + edited) + '</td></tr>';
  }).join('');
  return page_('7日分の状態', '<h1>7日分の投稿案の状態</h1><div class="notice">表示だけの画面です。判断は承認メールの「承認する」「修正する」「却下する」から行ってください。</div>' +
    '<section class="panel"><table><tr><th>公開予定(日本時間)</th><th>商品</th><th>状態</th></tr>' + rows + '</table></section>');
}

function draftPageHtml_(d, key, intent) {
  const state = stateOf_(d);
  const open = OPEN_STATES.indexOf(state) >= 0;
  const record = {
    postDate: d.postDate, week: 'mail-' + d.id, productId: d.productId, title: d.title, url: d.url, generatedAt: d.generatedAt,
    originalHash: d.originalHash, sourceHash: d.sourceHash, message: d.message, source: loadSource_(d.id), status: 'candidate', factCheck: 'passed'
  };
  const sched = scheduleLabel_(d);
  const card =
    '<section class="panel">' + (sched ? '<p class="schedule">公開予定日時: <b>' + esc(sched) + '</b>(日本時間・承認済みの場合だけ自動で公開)</p>' : '') +
    '<h2>' + esc(d.title) + '</h2>' +
    '<p><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.url) + '</a></p>' +
    '<div class="post"><div class="message">' + messageHtml_(d.message, d.url) + '</div>' +
    '<div class="photos"><img src="' + esc(imageUrl_(d.image, 600)) + '" alt="' + esc(d.title) + '"></div></div>' +
    (open ? reviewWidget(record) : '') +
    '<details><summary>商品情報(事実確認の対象)</summary><pre>' + esc([record.source.title, record.source.description].join('\n')) + '</pre></details>' +
    '</section>';
  const status =
    '<section class="panel" id="status"><h2>状態: <span id="status-label">' + esc(STATE_LABELS[state] || state) + '</span></h2>' +
    '<div id="status-result">' + resultHtml_(d) + '</div></section>';
  // 予定日時のある投稿案には「公開する」ボタンを出さない(公開は予定日時の自動処理だけ)
  const manual = !d.scheduledAt;
  const finalBox =
    '<section class="panel" id="final"' + (d.state === 'decided' && open ? '' : ' hidden') + '>' +
    (manual ? '<h2>最終確認(この内容で公開します)</h2>' : '<h2>承認済みの内容(予定日時に自動で公開します)</h2>') +
    '<p class="meta">投稿先: ' + esc(APP.PAGE_NAME) + '(ページID ' + APP.PAGE_ID + ')・' + (manual ? '即時公開・1件のみ' : '公開予定 ' + esc(sched) + '・1件のみ') + '</p>' +
    '<div class="post"><div class="message" id="final-message"></div><div class="photos"><img id="final-image" alt=""></div></div>' +
    '<p>商品URL: <a id="final-url" target="_blank" rel="noopener"></a></p>' +
    (manual ? '' : '<p class="ok">この内容で ' + esc(sched) + ' に自動で公開します。公開の直前に、商品の販売状況・商品ID・画像・投稿先をもう一度確認し、問題があれば公開しません。予定時刻までは判断を変更できます(却下すると公開しません)。</p>') +
    '<label class="rv-confirm-label"' + (manual ? '' : ' hidden') + '><input type="checkbox" id="publish-confirm"> 投稿先・本文・画像・商品URLを確認しました。この内容で今すぐ公開します</label>' +
    '<div class="review-actions final-actions"' + (manual ? '' : ' hidden') + '><button type="button" id="publish-btn" disabled>公開する</button></div>' +
    '<p class="meta" id="publish-msg"></p></section>';
  const ctx = { d: d.id, k: key, final: d.state === 'decided' && open ? finalView_(d) : null, state: state, intent: intent || '' };
  const INTENT_TEXT = { approve: '「承認する」', edit: '「修正する」', reject: '「却下する」' };
  const intentBox = intent ? '<div class="notice" id="intent-box"><b>メールの' + INTENT_TEXT[intent] + 'から開きました。まだ確定していません。</b><br>' +
    (!open ? 'この投稿案は「' + esc(STATE_LABELS[state] || state) + '」のため、判断はできません。'
      : intent === 'approve' && state === 'decided' ? 'この投稿案はすでに承認済みです(下の「承認済みの内容」)。変更するときは「修正して承認」または「却下」を選んでください。'
      : intent === 'approve' ? (manual ? '内容を確かめて、下の「この判断で進む」を押すと承認が確定し、すぐに Facebook へ公開します。' : '内容を確かめて、下の「この判断で確定する」を押すと承認が確定します。')
      : intent === 'edit' ? '下の編集欄で投稿文を直し、「この内容で修正して承認」→「この判断で確定する」で確定します。'
      : '下で却下の理由を選び、「却下にする」→「この判断で確定する」で確定します。却下した投稿は公開しません。') + '</div>' : '';
  return '<h1>Facebook 投稿案の承認</h1>' +
    '<div class="notice">' + (manual
      ? 'この画面を開いただけでは何も変わりません。<b>承認(または修正して承認)を「この判断で進む」で確定すると、すぐに Facebook へ公開します。</b>却下した投稿案は投稿しません。'
      : 'この画面を開いただけでは何も変わりません。判断は「この判断で確定する」を押したときだけ保存されます。承認(修正して承認)した投稿案だけを ' + esc(sched) + ' に自動で公開します。却下した投稿案・予定時刻までに判断がない投稿案は公開しません。') + '</div>' +
    intentBox + status +
    // メールのボタンから開いたときは、投稿の内容を先に見せてから確定の欄を出す
    (intent ? card.replace(/不採用/g, '却下') : '') +
    (open ? (manual ? REVIEW_BAR_MAIL : REVIEW_BAR_MAIL.replace(/この判断で進む/g, 'この判断で確定する')
      .replace('承認した場合は、次の画面で最終的な投稿内容を確かめてから「公開する」を押したときだけ投稿します。', '承認(修正して承認)した投稿だけを、公開予定日時に自動で公開します。')).replace(/不採用/g, '却下') : '') +
    (intent ? '' : card.replace(/不採用/g, '却下')) + finalBox +
    '<script type="application/json" id="fb-review-data">' + jsonForScript({ week: record.week, dataSource: 'live', pageId: APP.PAGE_ID, records: open ? [record] : [], mode: 'mail' }) + '</script>' +
    '<script type="application/json" id="mail-ctx">' + jsonForScript(ctx) + '</script>' +
    (open ? '<script>' + (manual ? REVIEW_SCRIPT : REVIEW_SCRIPT.replace(/この判断で進む/g, 'この判断で確定する')).replace("reject: '不採用'", "reject: '却下'").replace('・不採用 ', '・却下 ') + '</script>' : '') +
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
  '.schedule { margin:0 0 6px; font-size:15px; }',
  '[hidden] { display:none !important; }',
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
        } else if (['publish_requested', 'publishing'].includes(r.state)) {
          $('.review-saved').textContent = '承認しました。Facebook への公開を開始しました。数分で完了します(結果はこの画面とメールでお知らせします。この画面は閉じてもかまいません)。';
          lockDecision();
          poll(0);
        } else {
          $('.review-saved').textContent = r.publishError
            ? '承認は保存しましたが、' + r.publishError + '。下の最終確認から「公開する」でもう一度試せます。'
            : '判断を保存しました(まだ投稿していません)。下の最終確認で内容を確かめてください。';
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
  // メールのボタンから開いたとき: 操作の欄を開くだけ(確定は「この判断で確定する」を押したときだけ)
  const widget = document.querySelector('.review[data-date]');
  const press = sel => { const b = widget && widget.querySelector(sel); if (b && !b.disabled) b.click(); };
  const openConfirm = () => { const b = $('#review-open-confirm'); if (b && !b.disabled) b.click(); };
  if (widget && !(CTX.intent === 'approve' && CTX.state === 'decided')) {
    if (CTX.intent === 'approve') { press('[data-act="approve"]'); openConfirm(); }
    if (CTX.intent === 'edit') { press('[data-act="edit"]'); const t = widget.querySelector('.rv-body'); if (t) { widget.querySelector('.review-edit').scrollIntoView({ behavior: 'smooth' }); t.focus(); } }
    if (CTX.intent === 'reject') { press('[data-act="reject"]'); widget.querySelector('.review-reject').scrollIntoView({ behavior: 'smooth' }); }
  }
  // 修正・却下を決めたら、そのまま確定の確認を開く
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !widget) return;
    if (b.dataset.act === 'edit-done' && widget.querySelector('.review-edit').hidden) openConfirm();
    if (b.dataset.act === 'reject-done' && widget.querySelector('.review-reject').hidden) openConfirm();
  });
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
    if (d.scheduledAt && Date.now() >= d.scheduledAt - APP.SCHEDULE_EARLY_MS) throw new Error('公開予定時刻を過ぎたため、判断を変えられません');
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
    // 予定日時の無い投稿案は、承認を確定したらそのまま公開を始める(公開前の確認は fb-mail-publish.yml がもう一度行う)
    if (!d.scheduledAt) {
      d.state = 'publish_requested';
      d.requestedAt = Date.now();
      delete d.result;
      event_(d, '承認の確定により公開を開始しました');
      saveDraft_(d);
      try {
        dispatchPublish_(cfg, d.id);
      } catch (err) {
        d.state = 'decided';
        event_(d, '公開処理を起動できませんでした');
        saveDraft_(d);
        const v = statusView_(d);
        v.publishError = 'GitHub の公開処理を起動できませんでした(投稿はしていません): ' + err.message;
        return v;
      }
    }
    return statusView_(d);
  });
}

function requestPublish(id, key, hash) {
  const cfg = config_();
  requireOwner_(cfg);
  return withLock_(() => {
    const d = authorizeDraft_(id, key);
    if (!d) throw new Error('リンクが無効です');
    if (d.scheduledAt) throw new Error('この投稿案は予定日時(' + scheduleLabel_(d) + ')に自動で公開します。手動では公開できません');
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
