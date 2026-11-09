/**
 * 承認管理(承認 / 修正して承認 / 不採用)の画面部品。
 * 週次プレビュー(fb-draft-post.mjs)と、履歴から作る確認画面(fb-review.mjs page)の両方で使う。
 *
 * - HTML 上の操作はブラウザ内(localStorage)に一時保存するだけで、履歴(fb-history)は変えない
 * - 「決定内容を確認」→ 確認画面 →「JSONを保存」で決定内容ファイルを書き出す
 * - 反映はローカルコマンド(npm run fb:apply)で、内容を確かめてから行う
 * - APIキー・GitHubトークンなどの秘密は、HTML にも JSON にも入れない
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RULES, splitMessage } from './fb-review-rules.mjs';

/** 履歴の照合に使うハッシュ(先頭16文字) */
function hashOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 履歴の記録から、画面で使う情報を作る(承認管理に必要な情報が無い記録は null) */
function reviewRecordFromEntry(entry) {
  if (!entry || !entry.message || !entry.originalHash || !entry.source) return null;
  return {
    postDate: entry.postDate,
    week: entry.week,
    productId: String(entry.productId),
    title: entry.title,
    url: entry.url,
    generatedAt: entry.generatedAt,
    originalHash: entry.originalHash,
    sourceHash: entry.sourceHash,
    message: entry.message,
    source: entry.source,
    status: entry.status,
    factCheck: entry.factCheck
  };
}

function esc(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, c => map[c]);
}

/** <script type="application/json"> に安全に埋め込む */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * 投稿カードの下に置く判断欄。
 * blocked=true(承認不可)のときは「不採用」だけを選べる。
 */
function reviewWidget(record, { blocked = false } = {}) {
  if (!record) return '';
  const { body, hashtags } = splitMessage(record.message);
  const extra = hashtags.filter(t => !RULES.FIXED_HASHTAGS.includes(t));
  return `
    <div class="review" data-date="${esc(record.postDate)}">
      <div class="review-head"><b>判断</b> <span class="review-status">未判断</span>
        <span class="meta review-note">(まだ保存されていません。保存しても履歴はコマンドで反映するまで変わりません)</span></div>
      <div class="review-actions">
        ${blocked ? '' : '<button type="button" data-act="approve">承認</button>'}
        ${blocked ? '' : '<button type="button" data-act="edit">修正して承認</button>'}
        <button type="button" data-act="reject">不採用</button>
        <button type="button" data-act="clear" class="secondary">取り消し</button>
      </div>
      ${blocked ? '<p class="meta ng">事実確認・ルールに問題があるため、承認・修正はできません(不採用のみ)。</p>' : `
      <div class="review-edit" hidden>
        <label class="rv-label">本文(見出しを含む)
          <textarea class="rv-body" rows="9" data-original="${esc(body)}">${esc(body)}</textarea></label>
        <div class="rv-tags">ハッシュタグ:
          <span class="rv-fixed">${esc(RULES.FIXED_HASHTAGS.join(' '))}(固定)</span>
          <input class="rv-tag" data-i="0" value="${esc(extra[0] || '')}" aria-label="商品のハッシュタグ1">
          <input class="rv-tag" data-i="1" value="${esc(extra[1] || '')}" aria-label="商品のハッシュタグ2">
        </div>
        <p class="meta">商品(変更不可): ${esc(record.title)}<br>商品URL(変更不可): ${esc(record.url)}</p>
        <ul class="rv-checks"></ul>
        <div class="rv-diff-wrap"><b class="meta">元の投稿からの変更</b><div class="rv-diff"></div></div>
        <label class="rv-confirm-label"><input type="checkbox" class="rv-confirm"> 商品情報にない事実を追加していません</label>
        <div class="review-actions">
          <button type="button" data-act="edit-done">この内容で修正して承認</button>
          <button type="button" data-act="edit-cancel" class="secondary">やめる</button>
        </div>
      </div>`}
      <div class="review-reject" hidden>
        <label class="rv-label">不採用の理由(必須)
          <select class="rv-reason"><option value="">選んでください</option>${RULES.REJECT_REASONS.map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
        <label class="rv-label">メモ(任意)<textarea class="rv-note" rows="2"></textarea></label>
        <div class="review-actions">
          <button type="button" data-act="reject-done">不採用にする</button>
          <button type="button" data-act="reject-cancel" class="secondary">やめる</button>
        </div>
      </div>
    </div>`;
}

/**
 * 画面上部の集計バーと、確認画面。
 * mail=true はメール承認(Apps Script の承認画面)用: 「JSONを保存」の代わりに「この判断で進む」で判断を送る
 */
function reviewBar({ mail = false } = {}) {
  if (mail) {
    return `
  <section class="panel review-bar" id="review-bar">
    <h2>判断(承認・修正して承認・不採用=却下)</h2>
    <p class="review-counts">読み込み中…</p>
    <p class="meta">判断を選び、「決定内容を確認」→「この判断で進む」で判断が保存されます。
      この時点では Facebook には投稿しません。承認した場合は、次の画面で最終的な投稿内容を確かめてから「公開する」を押したときだけ投稿します。</p>
    <div class="review-actions">
      <button type="button" id="review-open-confirm">決定内容を確認</button>
      <button type="button" id="review-clear-all" class="secondary">すべてクリア</button>
    </div>
  </section>
  <section class="panel review-confirm" id="review-confirm" hidden>
    <h2>決定内容の確認</h2>
    <div class="review-confirm-body"></div>
    <div class="review-actions">
      <button type="button" id="review-save-json">この判断で進む</button>
      <button type="button" id="review-close-confirm" class="secondary">戻る</button>
    </div>
    <p class="meta review-saved"></p>
  </section>`;
  }
  return `
  <section class="panel review-bar" id="review-bar">
    <h2>判断(承認・修正・不採用)</h2>
    <p class="review-counts">読み込み中…</p>
    <p class="meta">ここでの操作はこのブラウザに一時保存されるだけで、履歴(fb-history)は変わりません。
      「決定内容を確認」→「JSONを保存」で決定内容ファイルを作り、<code>npm run fb:apply -- ファイル名</code> で内容を確かめてから反映します。
      未判断の日は候補のまま残ります。</p>
    <div class="review-actions">
      <button type="button" id="review-open-confirm">決定内容を確認</button>
      <button type="button" id="review-clear-all" class="secondary">すべてクリア</button>
    </div>
  </section>
  <section class="panel review-confirm" id="review-confirm" hidden>
    <h2>決定内容の確認</h2>
    <div class="review-confirm-body"></div>
    <div class="review-actions">
      <button type="button" id="review-save-json">JSONを保存</button>
      <button type="button" id="review-close-confirm" class="secondary">戻る</button>
    </div>
    <p class="meta review-saved"></p>
  </section>`;
}

const REVIEW_CSS = `
  .review { border-top:1px dashed var(--line); margin-top:12px; padding-top:10px; }
  .review-head { margin-bottom:6px; }
  .review-status { display:inline-block; padding:1px 8px; border-radius:999px; background:var(--soft); color:var(--sub); font-size:13px; }
  .review-status.approve, .review-status.edit { background:#e8f5e9; color:#1b5e20; }
  .review-status.reject { background:#eceff1; color:#455a64; }
  @media (prefers-color-scheme: dark) { .review-status.approve, .review-status.edit { background:#1b3a1e; color:#a5d6a7; } .review-status.reject { background:#2b3236; color:#b0bec5; } }
  .review-actions { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; }
  .review button { font:inherit; font-size:14px; padding:6px 12px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  .review button.secondary, .review-bar button.secondary, .review-confirm button.secondary { background:transparent; color:var(--accent); }
  .review-bar button, .review-confirm button { font:inherit; font-size:14px; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  .review button:disabled, .review-confirm button:disabled { background:transparent; color:var(--sub); border-color:var(--line); cursor:not-allowed; }
  .review button:focus-visible, .review-bar button:focus-visible, .review-confirm button:focus-visible { outline:3px solid var(--warn-line); outline-offset:2px; }
  .rv-label { display:block; font-size:13px; color:var(--sub); margin:6px 0; }
  .rv-body, .rv-note { display:block; width:100%; margin-top:4px; font:inherit; font-size:15px; line-height:1.6; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--text); }
  .rv-tags { font-size:13px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0; }
  .rv-tag { font:inherit; font-size:14px; padding:4px 6px; border:1px solid var(--line); border-radius:6px; width:12em; max-width:100%; background:var(--card); color:var(--text); }
  .rv-fixed { color:var(--sub); }
  .rv-reason { font:inherit; font-size:14px; margin-left:6px; padding:4px; }
  .rv-checks { font-size:13px; margin:6px 0; padding-left:20px; }
  .rv-diff, .rc-diff { white-space:pre-wrap; font-size:14px; background:var(--soft); padding:8px; border-radius:6px; overflow-wrap:anywhere; }
  .rv-diff ins, .rc-diff ins { background:#c8e6c9; color:#1b5e20; text-decoration:none; }
  .rv-diff del, .rc-diff del { background:#ffcdd2; color:#b71c1c; }
  .rv-confirm-label { display:block; margin:8px 0; font-weight:600; }
  .review-confirm-body table { margin-bottom:8px; }
  .review-counts { font-weight:600; }
`;

/** ブラウザ側の処理(チェックルールは fb-review-rules.mjs をそのまま埋め込む) */
function reviewScript() {
  const rules = readFileSync(new URL('./fb-review-rules.mjs', import.meta.url), 'utf8')
    .split('\n').filter(line => !line.startsWith('export ')).join('\n');
  return `(() => {
${rules}
  const DATA = JSON.parse(document.getElementById('fb-review-data').textContent);
  const RECORDS = new Map(DATA.records.map(r => [r.postDate, r]));
  const STORE_KEY = 'fb-review:' + DATA.week + ':' + DATA.pageId;
  const LABEL = { approve: '承認', edit: '修正して承認', reject: '不採用' };
  let state = {};
  try { state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { state = {}; }
  for (const d of Object.keys(state)) {
    const r = RECORDS.get(d);
    if (!r || state[d].originalHash !== r.originalHash) delete state[d]; // 候補が作り直されていたら捨てる
  }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {} render(); };
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const diffHtml = (a, b) => diffChars(a, b).map(p => p.type === 'same' ? escHtml(p.text) : '<' + (p.type === 'add' ? 'ins' : 'del') + '>' + escHtml(p.text) + '</' + (p.type === 'add' ? 'ins' : 'del') + '>').join('');

  function editCheck(widget, record) {
    const body = widget.querySelector('.rv-body').value;
    const tags = [...widget.querySelectorAll('.rv-tag')].map(i => i.value);
    const result = checkEdit({ body, extraTags: tags, original: record.message, source: record.source, postDate: record.postDate });
    return { body: normalizeMessage(body), tags: result.tags, result };
  }

  function renderEdit(widget, record) {
    const { body, result } = editCheck(widget, record);
    const list = widget.querySelector('.rv-checks');
    const items = [
      ...result.errors.map(e => '<li class="ng">✗ ' + escHtml(e) + '</li>'),
      ...result.warnings.map(w => '<li class="warn">⚠ ' + escHtml(w) + '</li>')
    ];
    list.innerHTML = items.length ? items.join('') : '<li class="ok">✓ 問題は見つかりませんでした(事実の確認は必ずご自身でも行ってください)</li>';
    list.insertAdjacentHTML('afterbegin', '<li class="meta">本文 ' + result.chars + '文字・絵文字 ' + result.emoji + '個</li>');
    const original = splitMessage(record.message).body;
    widget.querySelector('.rv-diff').innerHTML = body === original ? '<span class="meta">変更なし</span>' : diffHtml(original, body);
    const confirmed = widget.querySelector('.rv-confirm').checked;
    widget.querySelector('[data-act="edit-done"]').disabled = result.errors.length > 0 || !confirmed;
  }

  function render() {
    let counts = { approve: 0, edit: 0, reject: 0 };
    for (const widget of document.querySelectorAll('.review[data-date]')) {
      const date = widget.dataset.date;
      const s = state[date];
      const badge = widget.querySelector('.review-status');
      badge.className = 'review-status' + (s ? ' ' + s.action : '');
      badge.textContent = s ? LABEL[s.action] + (s.action === 'reject' ? '(' + s.reason + ')' : '') : '未判断';
      widget.querySelector('[data-act="clear"]').disabled = !s;
      if (s) counts[s.action]++;
    }
    const total = document.querySelectorAll('.review[data-date]').length;
    const decided = counts.approve + counts.edit + counts.reject;
    document.querySelector('.review-counts').textContent =
      '承認 ' + counts.approve + '・修正して承認 ' + counts.edit + '・不採用 ' + counts.reject + '・未判断 ' + (total - decided) + '(まだ保存されていません)';
    document.getElementById('review-open-confirm').disabled = decided === 0;
  }

  function buildFile() {
    const decisions = Object.entries(state).sort(([a], [b]) => a.localeCompare(b)).map(([date, s]) => {
      const r = RECORDS.get(date);
      const base = { postDate: date, productId: r.productId, generatedAt: r.generatedAt, originalHash: r.originalHash, sourceHash: r.sourceHash, action: s.action };
      if (s.action === 'edit') return { ...base, body: s.body, hashtags: s.tags, confirmNoNewFacts: s.confirm === true };
      if (s.action === 'reject') return { ...base, reason: s.reason, note: s.note || '' };
      return base;
    });
    return { kind: 'fb-decisions', version: 1, dataSource: DATA.dataSource, week: DATA.week, pageId: DATA.pageId, createdAt: new Date().toISOString(), decisions };
  }
  window.__fbReviewBuildFile = buildFile; // テスト用(画面の動作確認で使う)

  function renderConfirm() {
    const file = buildFile();
    const rows = file.decisions.map(d => {
      const r = RECORDS.get(d.postDate);
      let detail = '';
      if (d.action === 'edit') {
        const after = buildMessage(d.body, r.url, d.hashtags);
        detail = '<div class="rc-diff">' + diffHtml(r.message, after) + '</div>';
      } else if (d.action === 'reject') {
        detail = '理由: ' + escHtml(d.reason) + (d.note ? '<br>メモ: ' + escHtml(d.note) : '');
      } else {
        detail = '<span class="meta">生成された投稿文のまま承認</span>';
      }
      return '<tr><td>' + escHtml(d.postDate) + '<br>' + escHtml(r.title) + '</td><td>' + LABEL[d.action] + '</td><td>' + detail + '</td></tr>';
    }).join('');
    const box = document.querySelector('.review-confirm-body');
    box.innerHTML = (DATA.dataSource === 'mock' ? '<p class="ng">テスト用データの決定内容です(実際の履歴には反映できません)。</p>' : '') +
      '<table><tr><th>投稿日・商品</th><th>判断</th><th>内容(修正は 元 → 修正後 の差分)</th></tr>' + rows + '</table>' +
      (DATA.mode === 'mail'
        ? '<p class="meta">「この判断で進む」で判断が保存されます。この時点では Facebook には投稿しません。</p>'
        : '<p class="meta">未判断の日は候補のまま残ります。保存しただけでは履歴は変わりません。</p>');
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'review-open-confirm') { renderConfirm(); const c = document.getElementById('review-confirm'); c.hidden = false; c.scrollIntoView({ behavior: 'smooth' }); return; }
    if (btn.id === 'review-close-confirm') { document.getElementById('review-confirm').hidden = true; return; }
    if (btn.id === 'review-clear-all') { if (confirm('このページでの判断をすべて取り消しますか?(履歴には影響しません)')) { state = {}; save(); } return; }
    if (btn.id === 'review-save-json') {
      const file = buildFile();
      // メール承認の画面では、ファイルに保存せず Apps Script に送る(送り先は画面側で用意する)
      if (typeof window.__fbReviewSubmit === 'function') { window.__fbReviewSubmit(file); return; }
      const blob = new Blob([JSON.stringify(file, null, 2) + '\\n'], { type: 'application/json' });
      const a = document.createElement('a');
      const name = 'fb-decisions-' + DATA.week + (DATA.dataSource === 'mock' ? '-TEST' : '') + '.json';
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      document.querySelector('.review-saved').textContent = name + ' を保存しました。反映するには: npm run fb:apply -- ' + name + '(まず内容が表示され、--yes を付けたときだけ反映します)';
      return;
    }
    const widget = btn.closest('.review[data-date]');
    if (!widget) return;
    const date = widget.dataset.date;
    const record = RECORDS.get(date);
    const act = btn.dataset.act;
    const editBox = widget.querySelector('.review-edit');
    const rejectBox = widget.querySelector('.review-reject');
    if (act === 'approve') { state[date] = { action: 'approve', originalHash: record.originalHash }; if (editBox) editBox.hidden = true; rejectBox.hidden = true; save(); }
    if (act === 'clear') { delete state[date]; if (editBox) editBox.hidden = true; rejectBox.hidden = true; save(); }
    if (act === 'edit') {
      const s = state[date];
      if (s && s.action === 'edit') {
        widget.querySelector('.rv-body').value = s.body;
        widget.querySelectorAll('.rv-tag').forEach((i, n) => { i.value = s.tags[n] || ''; });
        widget.querySelector('.rv-confirm').checked = true;
      }
      editBox.hidden = false; rejectBox.hidden = true; renderEdit(widget, record);
    }
    if (act === 'edit-cancel') { editBox.hidden = true; }
    if (act === 'edit-done') {
      const { body, tags, result } = editCheck(widget, record);
      if (result.errors.length || !widget.querySelector('.rv-confirm').checked) return;
      state[date] = { action: 'edit', body, tags, confirm: true, originalHash: record.originalHash };
      editBox.hidden = true; save();
    }
    if (act === 'reject') { rejectBox.hidden = false; if (editBox) editBox.hidden = true; }
    if (act === 'reject-cancel') { rejectBox.hidden = true; }
    if (act === 'reject-done') {
      const reason = widget.querySelector('.rv-reason').value;
      if (!reason) { widget.querySelector('.rv-reason').focus(); return; }
      state[date] = { action: 'reject', reason, note: widget.querySelector('.rv-note').value.trim(), originalHash: record.originalHash };
      rejectBox.hidden = true; save();
    }
  });
  document.addEventListener('input', e => {
    const widget = e.target.closest('.review[data-date]');
    if (widget && e.target.closest('.review-edit')) renderEdit(widget, RECORDS.get(widget.dataset.date));
  });
  document.addEventListener('change', e => {
    const widget = e.target.closest('.review[data-date]');
    if (widget && e.target.classList.contains('rv-confirm')) renderEdit(widget, RECORDS.get(widget.dataset.date));
  });
  render();
})();`;
}

/** 画面に埋め込むデータ・CSS・スクリプト */
function reviewAssets({ week, dataSource, pageId, records }) {
  return {
    css: REVIEW_CSS,
    data: `<script type="application/json" id="fb-review-data">${jsonForScript({ week, dataSource, pageId, records })}</script>`,
    script: `<script>${reviewScript()}</script>`
  };
}

export { hashOf, reviewRecordFromEntry, reviewWidget, reviewBar, reviewAssets, esc, jsonForScript, reviewScript, REVIEW_CSS };
