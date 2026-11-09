// 自動生成(node scripts/build-gas-approval.mjs)。手で編集しないでください。元: scripts/fb-review-rules.mjs
/**
 * 投稿文のチェックルール(HTMLプレビューのブラウザ側と、ローカルコマンドの両方で使う)。
 * ブラウザにそのまま埋め込むため、import や Node.js の機能は使わない(末尾の export 行だけ取り除いて使う)。
 */

const RULES = {
  BODY_MIN_CHARS: 100, // 本文の文字数の目安(改行・空白・URL・ハッシュタグを除く)
  BODY_MAX_CHARS: 180,
  MAX_EMOJI: 2,
  // 誇張・不自然な宣伝文句(含まれていたら直す)
  NG_PHRASES: ['最高', '絶品', '今だけ', 'お見逃しなく', '見逃し厳禁', '必見', '激安', '間違いなし', 'ヤバい', 'やばい', '!!', '！！'],
  // 汎用的な締めの定型表現(できれば避ける)
  STOCK_PHRASES: ['お楽しみください', 'おすすめです', 'おすすめします', 'いかがでしょうか', 'いかがですか', 'ご賞味ください',
    'お試しください', '味わってみてください', '取り入れてみませんか', 'チェックしてみてください', 'ご覧ください', 'お届けします'],
  FIXED_HASHTAGS: ['#ふくしま市場', '#福島県'],
  EXTRA_HASHTAGS: 2,
  DETAIL_LABEL: '▼詳細はこちら',
  REJECT_REASONS: ['商品が合わない', '文章が合わない', '時期が合わない', 'その他']
};

/** 照合用: 全角・半角をそろえ、空白を除く */
function norm(s) {
  return String(s || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

/** 比較用: 絵文字・記号・空白を除く */
function phraseKey(s) {
  return String(s || '').normalize('NFKC').replace(/[\p{Extended_Pictographic}\p{P}\p{S}\s]/gu, '');
}

function countBodyChars(body) {
  return [...String(body || '').replace(/\s/g, '')].length;
}

function countEmoji(text) {
  return (String(text || '').match(/\p{Extended_Pictographic}/gu) || []).length;
}

/** 改行を \n にそろえ、行末の空白と、2つ以上続く空行・前後の空行を取り除く */
function normalizeMessage(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(/[ \t　]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 投稿文を組み立てる: 本文 →「▼詳細はこちら」→ 商品URL → ハッシュタグ(固定2個+商品2個) */
function buildMessage(body, url, extraTags) {
  const tags = [...RULES.FIXED_HASHTAGS, ...extraTags];
  return normalizeMessage(`${body}\n\n${RULES.DETAIL_LABEL}\n${url}\n\n${tags.join(' ')}`);
}

/** 投稿文を 本文 / 商品URL / ハッシュタグ に分ける */
function splitMessage(message) {
  const text = normalizeMessage(message);
  const at = text.lastIndexOf(`\n\n${RULES.DETAIL_LABEL}\n`);
  if (at < 0) return { body: text, url: '', hashtags: [] };
  const body = text.slice(0, at).trim();
  const rest = text.slice(at + RULES.DETAIL_LABEL.length + 3).split('\n').map(s => s.trim()).filter(Boolean);
  const url = rest[0] || '';
  const hashtags = (rest.slice(1).join(' ').match(/[#＃][^\s#＃]+/g) || []).map(t => '#' + t.slice(1));
  return { body, url, hashtags };
}

/** 商品情報(商品名・販売者・種別・タグ・説明文)を1つの文章にする。事実の照合はこの文章に対して行う */
function sourceTextOf(source) {
  const s = source || {};
  return [s.title, s.vendor, s.productType, (s.tags || []).join(' '), s.description].filter(Boolean).join('\n');
}

// 数字のあとに続く単位(長いものから)。「3年熟成」なら 3年、「5kg」なら 5kg として照合する
const NUMBER_UNITS = ['年産', '年目', '周年', 'か月', 'ヶ月', 'カ月', 'ヵ月', '週間', '時間', '人前', '人分', '種類', '切れ',
  '年', '週', '日', '分', '秒', 'kg', 'mg', 'ml', 'cc', 'cm', 'mm', 'g', 'l', 'm', '%', '度', '個', '本', '枚', '袋', '箱',
  '房', '粒', '玉', '尾', '匹', '食', '合', '升', '位', '回', '倍', '円', '種', '品', '割', '代', '名'];

/**
 * 本文の数字のうち、照合用の文章(商品情報など)で確認できないものを返す。
 * 単位つきの数字(3年・5kg・14度 など)は「数字+単位」がそのまま照合用の文章にあるかを見る
 * (「3」だけなら別の箇所にあっても、「3年」が無ければ確認できないとする)。
 */
function unsupportedNumbers(text, allowedText) {
  const allowed = String(allowedText || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
  const body = String(text || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
  const found = [];
  const re = new RegExp(`(\\d+(?:[.,]\\d+)?)(${NUMBER_UNITS.map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})?`, 'g');
  for (const m of body.matchAll(re)) {
    const [, n, unit] = m;
    const token = unit ? n + unit : n;
    const ok = unit
      ? allowed.includes(token)
      : new RegExp(`(^|[^0-9.,])${n.replace(/[.,]/g, '\\$&')}($|[^0-9])`).test(allowed);
    if (!ok && !found.includes(token)) found.push(token);
  }
  return found;
}

/** 文に分ける(句点・感嘆符・疑問符・改行で区切る) */
function sentencesOf(text) {
  return String(text || '').replace(/\r/g, '').split(/(?<=[。!?！？♪])|\n+/).map(s => s.trim()).filter(Boolean);
}

/** 照合に使う言葉: 漢字・カタカナの2文字以上の並びと、英字3文字以上 */
function termsOf(text) {
  return [...new Set(String(text || '').normalize('NFKC').match(/[\p{Script=Han}\p{Script=Katakana}ー]{2,}|[A-Za-z]{3,}/gu) || [])];
}

/**
 * 人が修正した投稿の確認。
 * errors: 保存できない問題 / warnings: 確認が必要な点(保存前に必ず表示する)
 * - 本文に URL・ハッシュタグ・「▼詳細はこちら」を入れない(商品URLと固定タグは自動で付く)
 * - 商品ハッシュタグはちょうど2個。固定タグと重複せず、商品情報(または元の投稿)にある言葉
 * - 本文の数字は、商品情報・元の投稿・投稿日にあるものだけ
 * - 誇張表現は使わない
 * - 追加した文に、商品情報にも元の投稿にもない言葉があれば警告する(人が事実を確かめる)
 */
function checkEdit({ body, extraTags, original, source, postDate }) {
  const errors = [];
  const warnings = [];
  const text = normalizeMessage(body || '');
  const sourceText = sourceTextOf(source);
  const originalParts = splitMessage(original || '');
  const allowed = `${sourceText}\n${originalParts.body}`;

  if (!text) errors.push('本文が空です');
  if (/https?:\/\//.test(text)) errors.push('本文にURLは入れられません(商品URLは自動で付きます)');
  if (text.includes(RULES.DETAIL_LABEL)) errors.push(`本文に「${RULES.DETAIL_LABEL}」は入れられません(自動で付きます)`);
  if (/(^|\s)[#＃][^\s#＃]+/.test(text)) errors.push('本文にハッシュタグは入れられません(ハッシュタグ欄で編集してください)');

  const chars = countBodyChars(text);
  if (chars > RULES.BODY_MAX_CHARS) warnings.push(`本文が${chars}文字です(目安は${RULES.BODY_MAX_CHARS}文字まで)`);
  const emoji = countEmoji(text);
  if (emoji > RULES.MAX_EMOJI) warnings.push(`絵文字が${emoji}個です(${RULES.MAX_EMOJI}個まで)`);
  const ng = RULES.NG_PHRASES.filter(p => text.includes(p));
  if (ng.length) errors.push(`誇張・宣伝的な表現: ${ng.join('、')}`);
  const stock = RULES.STOCK_PHRASES.filter(p => text.includes(p));
  if (stock.length) warnings.push(`定型的な表現: ${stock.join('、')}`);

  // 数字(単位つきは「数字+単位」で照合)
  const [, mm, dd] = String(postDate || '').split('-').map(Number);
  for (const n of unsupportedNumbers(text, `${allowed}\n${mm}月${dd}日`)) errors.push(`商品情報にない数字: ${n}`);

  // ハッシュタグ
  const tags = (extraTags || []).map(t => String(t).trim()).filter(Boolean).map(t => (t.startsWith('#') || t.startsWith('＃') ? '#' + t.slice(1) : '#' + t));
  if (tags.length !== RULES.EXTRA_HASHTAGS) errors.push(`商品のハッシュタグは${RULES.EXTRA_HASHTAGS}個にしてください(今は${tags.length}個)`);
  const originalTags = originalParts.hashtags;
  for (const tag of tags) {
    if (!/^#[^\s#]+$/.test(tag)) errors.push(`ハッシュタグの形式が不正: ${tag}`);
    else if (RULES.FIXED_HASHTAGS.includes(tag)) errors.push(`固定のハッシュタグと重複: ${tag}`);
    else if (!originalTags.includes(tag) && !phraseKey(allowed).toLowerCase().includes(phraseKey(tag.slice(1)).toLowerCase())) {
      errors.push(`商品情報にない言葉のハッシュタグ: ${tag}`);
    }
  }
  if (new Set(tags).size !== tags.length) errors.push('ハッシュタグが重複しています');

  // 追加した文の言葉の照合(元の投稿にない文だけを見る)
  const originalSentences = new Set(sentencesOf(originalParts.body).map(phraseKey));
  const allowedNorm = norm(allowed);
  const unmatched = [];
  for (const s of sentencesOf(text)) {
    if (originalSentences.has(phraseKey(s))) continue;
    const missing = termsOf(s).filter(t => !allowedNorm.includes(norm(t)));
    if (missing.length) unmatched.push({ sentence: s, terms: missing });
  }
  for (const u of unmatched) warnings.push(`商品情報で確認できない言葉があります: 「${u.terms.join('」「')}」(${u.sentence})`);

  return { errors, warnings, unmatched, chars, emoji, tags, message: '' };
}

/** 2つの文章の差分(文字単位)。[{ type: 'same'|'add'|'del', text }] を返す */
function diffChars(a, b) {
  const x = [...String(a || '')];
  const y = [...String(b || '')];
  if (x.length * y.length > 400000) return [{ type: 'del', text: x.join('') }, { type: 'add', text: y.join('') }];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, ch) => {
    if (out.length && out[out.length - 1].type === type) out[out.length - 1].text += ch;
    else out.push({ type, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', x[i]); i++; }
    else { push('add', y[j]); j++; }
  }
  while (i < x.length) push('del', x[i++]);
  while (j < y.length) push('add', y[j++]);
  return out;
}

