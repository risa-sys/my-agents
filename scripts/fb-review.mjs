/**
 * 承認管理のローカルコマンド(Facebook・Gemini・商品サイトには通信しない。git で fb-history だけを読み書きする)
 *
 *   node scripts/fb-review.mjs page --week YYYY-MM-DD [--out ファイル]
 *       fb-history の候補から、承認・修正・不採用を選べる確認画面(HTML)を作る
 *   node scripts/fb-review.mjs apply <決定内容.json> [--yes]
 *       決定内容を検査して変更内容を表示する。--yes を付けたときだけ fb-history に反映する
 *   node scripts/fb-review.mjs migrate <過去のプレビューHTML> [--yes]
 *       承認管理に必要な情報(投稿文・商品情報)が無い候補に、その候補を作ったときのプレビューから補う。
 *       候補そのもの(商品・日付・状態)は変えない
 *
 * 環境変数: FB_HISTORY_REMOTE(既定 origin)/ FB_HISTORY_BRANCH(既定 fb-history)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RULES, buildMessage, checkEdit, diffChars, normalizeMessage, splitMessage } from './fb-review-rules.mjs';
import { esc, hashOf, reviewAssets, reviewBar, reviewRecordFromEntry, reviewWidget } from './fb-review-ui.mjs';

const REMOTE = process.env.FB_HISTORY_REMOTE || 'origin';
const BRANCH = process.env.FB_HISTORY_BRANCH || 'fb-history';
const HISTORY_PATH = 'data/fb-post-history.json';
const STATUS_LABELS = { candidate: '候補', approved: '承認済み', rejected: '不採用', published: '公開済み' };
const ACTION_LABELS = { approve: '承認', edit: '修正して承認', reject: '不採用' };

class UserError extends Error {}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 保存先が GitHub ではなく、ローカルのテスト用リポジトリか(テスト用データはここでだけ扱える) */
function remoteIsLocalTest() {
  if (/^(origin|https?:\/\/|git@|ssh:\/\/)/.test(REMOTE)) return false;
  return existsSync(REMOTE) && statSync(REMOTE).isDirectory();
}
const ALLOW_MOCK = process.env.FB_REVIEW_ALLOW_MOCK === '1' && remoteIsLocalTest();

/** fb-history の最新の履歴を読む(main やこのPCの data/ の履歴は使わない) */
function loadRemoteHistory() {
  try {
    git(['fetch', '--quiet', '--depth=1', REMOTE, BRANCH]);
  } catch (e) {
    throw new UserError(`${BRANCH} ブランチを取得できませんでした(${String(e.stderr || e.message).trim()})`);
  }
  const commit = git(['rev-parse', 'FETCH_HEAD']).trim();
  const history = JSON.parse(git(['show', `FETCH_HEAD:${HISTORY_PATH}`]));
  if (!history || !Array.isArray(history.entries)) throw new UserError(`${BRANCH} の履歴の形式が不正です`);
  return { history, commit };
}

/** fb-history に保存する(読み込んだ後に fb-history が更新されていたら保存しない) */
function saveHistory(history, commit, message) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-review-'));
  try {
    const file = join(dir, 'fb-post-history.json');
    writeFileSync(file, JSON.stringify(history, null, 2) + '\n');
    const name = safeGitConfig('user.name');
    const email = safeGitConfig('user.email');
    const script = fileURLToPath(new URL('./fb-history-branch.sh', import.meta.url)).replace(/\\/g, '/');
    execFileSync('bash', [script, 'save'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        FB_HISTORY_SOURCE: file.replace(/\\/g, '/'),
        FB_HISTORY_EXPECT: commit,
        FB_HISTORY_MESSAGE: message,
        FB_HISTORY_ALLOW_MOCK: ALLOW_MOCK ? '1' : '',
        ...(name ? { FB_HISTORY_AUTHOR_NAME: name } : {}),
        ...(email ? { FB_HISTORY_AUTHOR_EMAIL: email } : {})
      }
    });
  } catch (e) {
    throw new UserError('fb-history への保存に失敗しました(履歴は変わっていません)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function safeGitConfig(key) {
  try {
    return git(['config', key]).trim();
  } catch {
    return '';
  }
}

function terminalDiff(a, b) {
  return diffChars(a, b).map(p => (p.type === 'same' ? p.text : p.type === 'add' ? `[+${p.text}+]` : `[-${p.text}-]`)).join('');
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function cmdApply(args) {
  const path = args.find(a => !a.startsWith('--'));
  const yes = args.includes('--yes');
  if (!path) throw new UserError('使い方: npm run fb:apply -- <決定内容.json> [--yes]');
  let file;
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UserError(`決定内容ファイルを読めませんでした: ${e.message}`);
  }
  if (file?.kind !== 'fb-decisions' || file.version !== 1) throw new UserError('決定内容ファイルの形式が違います(HTMLの「JSONを保存」で作ったファイルを指定してください)');
  if (file.dataSource !== 'live' && !ALLOW_MOCK) throw new UserError('テスト用データの決定内容は反映できません');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(file.week))) throw new UserError('決定内容ファイルの週が不正です');
  if (!Array.isArray(file.decisions) || file.decisions.length === 0) throw new UserError('決定内容がありません');

  const { history, commit } = loadRemoteHistory();
  const errors = [];
  const plan = [];
  const seen = new Set();
  for (const d of file.decisions) {
    const where = `${d.postDate} ${d.productId}`;
    if (seen.has(d.postDate)) { errors.push(`${where}: 同じ日の決定が2つあります`); continue; }
    seen.add(d.postDate);
    const entry = history.entries.find(e => e.week === file.week && e.postDate === d.postDate && String(e.productId) === String(d.productId));
    if (!entry) { errors.push(`${where}: 対象の候補が履歴にありません`); continue; }
    const label = `${d.postDate} ${entry.title}`;
    if (entry.status !== 'candidate') { errors.push(`${label}: ${STATUS_LABELS[entry.status] || entry.status}のため変更できません(上書きしません)`); continue; }
    if (entry.dataSource === 'mock' && !ALLOW_MOCK) { errors.push(`${label}: テスト用データの候補です`); continue; }
    if (!entry.originalHash || !entry.message || !entry.source) { errors.push(`${label}: 承認管理に必要な情報がありません(npm run fb:migrate で補ってください)`); continue; }
    if (hashOf(entry.message) !== entry.originalHash) { errors.push(`${label}: 履歴の投稿文が記録と一致しません`); continue; }
    if (entry.generatedAt !== d.generatedAt || entry.originalHash !== d.originalHash || (d.sourceHash && d.sourceHash !== entry.sourceHash)) {
      errors.push(`${label}: 候補が作り直されています(新しい確認画面で判断し直してください)`);
      continue;
    }
    if (d.action === 'approve') {
      if (entry.factCheck !== 'passed') { errors.push(`${label}: 事実確認に通っていないため承認できません`); continue; }
      plan.push({ entry, action: 'approve' });
    } else if (d.action === 'edit') {
      if (entry.factCheck !== 'passed') { errors.push(`${label}: 事実確認に通っていないため承認できません`); continue; }
      if (d.confirmNoNewFacts !== true) { errors.push(`${label}: 「商品情報にない事実を追加していません」の確認がありません`); continue; }
      const result = checkEdit({ body: d.body, extraTags: d.hashtags, original: entry.message, source: entry.source, postDate: entry.postDate });
      if (result.errors.length) { errors.push(...result.errors.map(x => `${label}: ${x}`)); continue; }
      // 商品URLと対象商品は履歴のものを使う(決定内容ファイルの値では変えない)
      const message = buildMessage(normalizeMessage(d.body), entry.url, result.tags);
      plan.push({ entry, action: message === entry.message ? 'approve' : 'edit', message, warnings: result.warnings });
    } else if (d.action === 'reject') {
      if (!RULES.REJECT_REASONS.includes(d.reason)) { errors.push(`${label}: 不採用の理由がありません`); continue; }
      plan.push({ entry, action: 'reject', reason: d.reason, note: String(d.note || '').slice(0, 500) });
    } else {
      errors.push(`${label}: 不明な判断「${d.action}」`);
    }
  }

  console.log(`決定内容: ${basename(path)}(週 ${file.week}、${file.decisions.length}件)/ 履歴: ${BRANCH} ${commit.slice(0, 8)}`);
  if (errors.length) {
    console.log('\n反映できない内容があるため、何も変更していません:');
    for (const e of errors) console.log(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n反映する内容:');
  for (const p of plan) {
    console.log(`\n■ ${p.entry.postDate} ${p.entry.title}: 候補 → ${p.action === 'reject' ? '不採用' : '承認済み'}(${ACTION_LABELS[p.action]})`);
    if (p.action === 'edit') {
      console.log('  変更([+追加+] [-削除-]):');
      console.log(terminalDiff(p.entry.message, p.message).split('\n').map(l => `    ${l}`).join('\n'));
      for (const w of p.warnings) console.log(`  ⚠ ${w}`);
    }
    if (p.action === 'reject') console.log(`  理由: ${p.reason}${p.note ? ` / メモ: ${p.note}` : ''}(同じ週の作り直しでは選ばれません。翌週以降は候補に戻ります)`);
  }
  const untouched = history.entries.filter(e => e.week === file.week && e.status === 'candidate' && !plan.some(p => p.entry === e));
  if (untouched.length) console.log(`\n未判断のまま候補として残る日: ${untouched.map(e => e.postDate).join(', ')}`);

  if (!yes) {
    console.log('\nこれは確認のみです(履歴は変わっていません)。この内容で反映するには --yes を付けて実行してください。');
    return;
  }
  const decidedAt = new Date().toISOString();
  for (const p of plan) {
    const e = p.entry;
    const decision = { action: p.action, decidedAt, decisionFile: basename(path) };
    if (p.action === 'reject') {
      e.status = 'rejected';
      e.decision = { ...decision, reason: p.reason, note: p.note };
    } else {
      e.status = 'approved';
      if (p.action === 'edit') {
        e.generatedMessage = e.message;
        e.message = p.message;
        e.edited = true;
        e.decision = { ...decision, confirmNoNewFacts: true, warnings: p.warnings };
      } else {
        e.decision = decision;
      }
    }
  }
  const count = a => plan.filter(p => p.action === a).length;
  saveHistory(history, commit, `Apply review decisions for week ${file.week} (approve ${count('approve')}, edit ${count('edit')}, reject ${count('reject')})`);
  console.log('反映しました。');
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

function decode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 過去の週次プレビューHTMLから、各日の投稿文・商品情報を読み取る */
function parsePreview(html) {
  const days = [];
  for (const sec of html.split('<section class="panel" id="d-').slice(1)) {
    const date = sec.slice(0, 10);
    const body = sec.split('</section>')[0];
    const message = body.match(/<textarea class="copy-src" readonly hidden>([\s\S]*?)<\/textarea>/);
    if (!message) continue;
    const product = body.match(/<tr><th>商品<\/th><td>([\s\S]*?)\(([^()]*?)円\)<br>/);
    const id = body.match(/商品データの照合\(ID・handle・商品名\): ID (\d+)/);
    const desc = body.match(/<details><summary>商品説明の全文[^<]*<\/summary><pre>([\s\S]*?)<\/pre><\/details>/);
    const photos = body.match(/<div class="photos n\d">([\s\S]*?)<\/div>/);
    days.push({
      date,
      message: normalizeMessage(decode(message[1])),
      title: product ? decode(product[1]) : '',
      productId: id ? id[1] : '',
      description: desc ? decode(desc[1]) : '',
      images: photos ? [...photos[1].matchAll(/<img src="([^"]+)"/g)].map(m => decode(m[1])) : []
    });
  }
  return days;
}

function cmdMigrate(args) {
  const path = args.find(a => !a.startsWith('--'));
  const yes = args.includes('--yes');
  if (!path) throw new UserError('使い方: npm run fb:migrate -- <過去のプレビューHTML> [--yes]');
  const html = readFileSync(path, 'utf8');
  if (html.includes('class="mock-banner"') || /-TEST\.html$/.test(path)) throw new UserError('テスト用のプレビューからは補えません');
  if (!html.includes('データ: 実データ')) throw new UserError('実データのプレビューではありません');
  const days = parsePreview(html);
  const { history, commit } = loadRemoteHistory();
  const filled = [];
  const skipped = [];
  for (const day of days) {
    const entry = history.entries.find(e => e.postDate === day.date && String(e.productId) === day.productId);
    const label = `${day.date} ${day.title || day.productId}`;
    if (!entry) { skipped.push(`${label}: 履歴に同じ商品の記録がありません`); continue; }
    if (entry.status !== 'candidate') { skipped.push(`${label}: ${STATUS_LABELS[entry.status]}のため変更しません`); continue; }
    if (entry.originalHash) { skipped.push(`${label}: すでに情報があります`); continue; }
    const parts = splitMessage(day.message);
    const firstLine = parts.body.split('\n')[0].trim();
    const checks = [
      [parts.url.endsWith(`/products/${entry.handle}`), `商品URLが履歴の商品(${entry.handle})と一致しない`],
      [firstLine === String(entry.opening || '').trim(), '見出しが履歴の記録と一致しない'],
      [!entry.closing || parts.body.includes(entry.closing), '最後の一文が履歴の記録と一致しない'],
      [day.title === entry.title, '商品名が履歴の記録と一致しない'],
      [Boolean(day.description), '商品説明が読み取れない'],
      [parts.hashtags.length === RULES.FIXED_HASHTAGS.length + RULES.EXTRA_HASHTAGS, 'ハッシュタグが4個でない']
    ];
    const failed = checks.filter(([ok]) => !ok).map(([, why]) => why);
    if (failed.length) { skipped.push(`${label}: ${failed.join(' / ')}`); continue; }
    const source = { title: day.title, vendor: '', productType: '', tags: [], description: day.description };
    filled.push({ entry, fields: {
      message: day.message, originalHash: hashOf(day.message), source, sourceHash: hashOf(source),
      url: parts.url, images: day.images,
      migratedFrom: { file: basename(path), at: new Date().toISOString(), note: '候補を作ったときのプレビューHTMLから補完(販売者・種別・タグは含まない)' }
    } });
  }
  console.log(`プレビュー: ${basename(path)}(${days.length}日分)/ 履歴: ${BRANCH} ${commit.slice(0, 8)}`);
  for (const f of filled) console.log(`  ✓ ${f.entry.postDate} ${f.entry.title}: 投稿文・商品情報・画像 ${f.fields.images.length}枚を補完(状態は候補のまま)`);
  for (const s of skipped) console.log(`  - ${s}`);
  if (filled.length === 0) { console.log('補う候補はありません(履歴は変わっていません)'); return; }
  if (!yes) {
    console.log('\nこれは確認のみです(履歴は変わっていません)。補うには --yes を付けて実行してください。');
    return;
  }
  for (const f of filled) Object.assign(f.entry, f.fields);
  saveHistory(history, commit, `Add review data to ${filled.length} candidates from ${basename(path)}`);
  console.log('補いました。');
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

function formatDateJa(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}月${d}日(${'日月火水木金土'[new Date(`${ymd}T00:00:00Z`).getUTCDay()]})`;
}

function messageHtml(message, url) {
  const link = `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  return normalizeMessage(message).split('\n\n')
    .map(block => `<p>${block.split('\n').map(line => (line === url ? link : esc(line))).join('<br>')}</p>`).join('');
}

function cmdPage(args) {
  const week = args[args.indexOf('--week') + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week))) throw new UserError('使い方: npm run fb:review-page -- --week YYYY-MM-DD [--out ファイル]');
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : `preview/fb-review-${week}.html`;
  const { history, commit } = loadRemoteHistory();
  const entries = history.entries.filter(e => e.week === week).sort((a, b) => a.postDate.localeCompare(b.postDate));
  if (entries.length === 0) throw new UserError(`${week} の週の記録がありません`);
  const mock = entries.some(e => e.dataSource === 'mock');
  if (mock && !ALLOW_MOCK) throw new UserError('テスト用データの記録が含まれています');
  const records = entries.filter(e => e.status === 'candidate').map(reviewRecordFromEntry).filter(Boolean);
  const pageId = `history-${commit.slice(0, 8)}`;
  const assets = reviewAssets({ week, dataSource: mock ? 'mock' : 'live', pageId, records });
  const missing = entries.filter(e => e.status === 'candidate' && !reviewRecordFromEntry(e));

  const cards = entries.map(e => {
    const record = reviewRecordFromEntry(e);
    const images = (e.images || []).map(src => `<img src="${esc(src)}" alt="${esc(e.title)}" loading="lazy">`).join('');
    const decision = e.decision
      ? `<p class="meta">${esc(ACTION_LABELS[e.decision.action] || '')}${e.decision.reason ? `(理由: ${esc(e.decision.reason)}${e.decision.note ? ` / ${esc(e.decision.note)}` : ''})` : ''} ${esc((e.decision.decidedAt || '').slice(0, 16))}</p>`
      : '';
    return `<section class="panel" id="d-${esc(e.postDate)}">
      <h2>${esc(formatDateJa(e.postDate))} <span class="badge${e.status === 'rejected' ? ' ng' : ''}">${esc(STATUS_LABELS[e.status] || e.status)}</span></h2>
      <p><b>${esc(e.title)}</b>${e.url ? `<br><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a>` : ''}</p>
      ${decision}
      ${e.message ? `<div class="post"><div class="message">${messageHtml(e.message, e.url)}</div>${images ? `<div class="photos n${(e.images || []).length}">${images}</div>` : ''}</div>` : '<p class="ng">投稿文の記録がありません(承認管理には npm run fb:migrate での補完が必要です)</p>'}
      ${e.status === 'candidate' && record ? reviewWidget(record, { blocked: e.factCheck !== 'passed' }) : ''}
      ${e.status === 'candidate' && record ? `<details><summary>商品情報(事実確認の対象)</summary><pre>${esc([e.source.title, e.source.description].join('\n'))}</pre></details>` : ''}
    </section>`;
  }).join('\n');

  const page = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${mock ? '【テスト用データ・投稿不可】' : ''}投稿案の判断 ${esc(week)}</title>
<style>
  :root { --bg:#f0f2f5; --card:#fff; --text:#050505; --sub:#65676b; --line:#ced0d4; --soft:#f0f2f5; --warn:#fff4e5; --warn-line:#f0b45a; --ok:#2e7d32; --ng:#c62828; --accent:#1877f2; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#18191a; --card:#242526; --text:#e4e6eb; --sub:#b0b3b8; --line:#3e4042; --soft:#3a3b3c; --warn:#3a2d17; --warn-line:#a87b2f; --ok:#81c784; --ng:#ef9a9a; --accent:#4599ff; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif; line-height:1.5; }
  main { max-width:760px; margin:0 auto; padding:16px; }
  a { color:var(--accent); }
  h1 { font-size:20px; margin:8px 0 4px; } h2 { font-size:17px; margin:0 0 6px; }
  .meta { color:var(--sub); font-size:13px; } .ok { color:var(--ok); } .ng { color:var(--ng); font-weight:600; } .warn { color:#a15c00; }
  .notice { background:var(--warn); border:1px solid var(--warn-line); border-radius:8px; padding:10px 12px; font-size:14px; margin:12px 0 16px; }
  .panel { background:var(--card); border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,.2); padding:12px 16px; margin-bottom:16px; }
  .badge { font-size:12px; padding:2px 8px; border-radius:999px; background:var(--soft); color:var(--sub); font-weight:500; }
  table { width:100%; border-collapse:collapse; font-size:13px; } th, td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  .post { border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .message { padding:10px 12px 12px; font-size:15px; line-height:1.6; overflow-wrap:anywhere; } .message p { margin:0 0 .7em; } .message p:last-child { margin-bottom:0; }
  .photos { display:grid; gap:2px; } .photos.n2 { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  .photos img { display:block; width:100%; min-width:0; aspect-ratio:1/1; object-fit:cover; background:var(--line); }
  details { margin-top:8px; font-size:13px; } details pre { white-space:pre-wrap; background:var(--soft); padding:8px; border-radius:6px; overflow-wrap:anywhere; font-family:inherit; }
  .mock-banner { background:#c62828; color:#fff; text-align:center; font-size:24px; font-weight:800; padding:12px; }
  ${assets.css}
</style>
</head>
<body>
${mock ? '<div class="mock-banner">⚠ テスト用データ・投稿不可</div>' : ''}
<main>
  <h1>投稿案の判断 ${esc(formatDateJa(week))}の週</h1>
  <div class="meta">fb-history(${esc(commit.slice(0, 8))})の記録から作成。この画面を作るときに Gemini・商品サイト・Facebook には通信していません。</div>
  <div class="notice">Facebook には何も送信しません。ここでの判断は「JSONを保存」→ <code>npm run fb:apply</code> で確認してから履歴に反映されます。</div>
  ${missing.length ? `<p class="ng">承認管理に必要な情報が無い候補が${missing.length}件あります(npm run fb:migrate で補ってください)。</p>` : ''}
  ${records.length ? reviewBar() : '<p class="meta">判断できる候補はありません。</p>'}
  ${cards}
</main>
${assets.data}
${records.length ? assets.script : ''}
</body>
</html>
`;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, page);
  console.log(`確認画面を作成しました: ${pathToFileURL(resolve(out)).href}`);
  console.log(`(候補 ${records.length}件・記録 ${entries.length}件。履歴は変わっていません)`);
}

// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'apply') cmdApply(rest);
  else if (command === 'migrate') cmdMigrate(rest);
  else if (command === 'page') cmdPage(rest);
  else throw new UserError('使い方: node scripts/fb-review.mjs page|apply|migrate ...');
} catch (e) {
  console.error(e instanceof UserError ? e.message : (e.stack || e));
  process.exitCode = 1;
}
