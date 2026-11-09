/**
 * メール承認(Google Apps Script)と GitHub Actions のあいだの通信。
 *
 * - やりとりはすべて「署名つきの封筒」で行う: { v, ts, nonce, body(JSON文字列), sig }
 *   sig = HMAC-SHA256(共有の秘密, "fb-mail.v1.<ts>.<nonce>.<body>") の16進
 *   GAS 側(gas/fb-approval/Code.gs の sealEnvelope_ / openEnvelope_)と同じ形式
 * - 時刻のずれが5分を超える封筒・使い回された nonce(GAS 側で記録)は受け付けない
 * - 応答も署名つき。応答の body には要求の nonce(reqNonce)が入っていて、別の要求への応答とは取り違えない
 * - 共有の秘密は GitHub Secrets(FB_MAIL_SECRET)と GAS のスクリプト プロパティ(ACTIONS_SECRET)だけに置く。出力しない
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ENVELOPE_MAX_SKEW_MS = 5 * 60 * 1000;
const GAS_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

function signature(secret, ts, nonce, body) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(`fb-mail.v1.${ts}.${nonce}.${body}`, 'utf8').digest('hex');
}

export function sealEnvelope(secret, payload, now = Date.now()) {
  const ts = now;
  const nonce = randomBytes(16).toString('hex');
  const body = JSON.stringify(payload);
  return { v: 1, ts, nonce, body, sig: signature(secret, ts, nonce, body) };
}

/** 封筒を確かめて中身を返す。不正なら例外 */
export function openEnvelope(secret, env, now = Date.now()) {
  if (!env || env.v !== 1 || typeof env.body !== 'string' || typeof env.sig !== 'string' || !/^[0-9a-f]{32}$/.test(String(env.nonce))) {
    throw new Error('署名つきの応答の形式が不正です');
  }
  const expected = Buffer.from(signature(secret, env.ts, env.nonce, env.body), 'hex');
  const got = Buffer.from(env.sig, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('署名が一致しません');
  if (!Number.isFinite(env.ts) || Math.abs(now - env.ts) > ENVELOPE_MAX_SKEW_MS) throw new Error('署名の時刻が古すぎるか、先の時刻です');
  return JSON.parse(env.body);
}

/** GAS の受付URLか(テストではローカルのモックだけ許す) */
export function checkGasUrl(url, { allowLoopback = false, allowMock = false } = {}) {
  if (GAS_URL_PATTERN.test(url)) return;
  let u;
  try {
    u = new URL(url);
  } catch {}
  if (allowLoopback && u && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return;
  if (allowMock && url === 'https://gas.mock.invalid/exec') return;
  throw new Error('FB_MAIL_GAS_URL が Apps Script の受付URL(https://script.google.com/macros/s/…/exec)ではありません');
}

/**
 * GAS に署名つきで要求し、署名つきの応答を確かめて返す。
 * 応答が無い・署名が合わないときは例外(kind: 'ambiguous' … 届いたか分からない / 'definite' … 断られた)
 */
export async function callGas({ url, secret, action, payload = {}, timeoutMs = 30000, now = () => Date.now() }) {
  const env = sealEnvelope(secret, { action, ...payload }, now());
  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    text = await res.text();
  } catch (e) {
    throw Object.assign(new Error(`Apps Script から応答がありませんでした(${e.name === 'TimeoutError' ? '時間切れ' : '通信エラー'})`), { kind: 'ambiguous' });
  }
  let reply;
  try {
    reply = openEnvelope(secret, JSON.parse(text), now());
  } catch (e) {
    throw Object.assign(new Error(`Apps Script の応答を確かめられませんでした(HTTP ${res.status}: ${e.message})`), { kind: 'ambiguous' });
  }
  if (reply.reqNonce !== env.nonce) throw Object.assign(new Error('Apps Script の応答が、この要求への応答ではありません'), { kind: 'ambiguous' });
  if (!reply.ok) throw Object.assign(new Error(`Apps Script が断りました: ${reply.error || '理由不明'}`), { kind: 'definite', code: reply.code || '' });
  return reply;
}
