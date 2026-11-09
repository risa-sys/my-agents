/**
 * メール承認の Apps Script(gas/fb-approval/)に、既存の承認画面とルールをそのまま組み込む。
 *
 *   node scripts/build-gas-approval.mjs          … Rules.gs / ReviewUi.gs を作り直す
 *   node scripts/build-gas-approval.mjs --check  … 作り直しが必要か確かめる(必要なら終了コード1)
 *
 * - Rules.gs   ← scripts/fb-review-rules.mjs(投稿文のルール・修正の確認。export 行を除いてそのまま)
 * - ReviewUi.gs ← scripts/fb-review-ui.mjs(判断欄・確認画面・ブラウザ側の処理。関数はソースをそのまま、文字列は値で)
 * 手で編集しない(元のファイルを直してから作り直す)。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { REVIEW_CSS, esc, jsonForScript, reviewBar, reviewScript, reviewWidget } from './fb-review-ui.mjs';

const DIR = new URL('../gas/fb-approval/', import.meta.url);
const HEADER = src => `// 自動生成(node scripts/build-gas-approval.mjs)。手で編集しないでください。元: ${src}\n`;

function build() {
  // 改行コードは LF にそろえる(Windows の作業コピーは CRLF になることがあるため)
  const rules = readFileSync(new URL('./fb-review-rules.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    .split('\n').filter(line => !line.startsWith('export ')).join('\n');
  const ui = [
    `const REVIEW_CSS = ${JSON.stringify(REVIEW_CSS)};`,
    `const REVIEW_BAR_MAIL = ${JSON.stringify(reviewBar({ mail: true }))};`,
    `const REVIEW_SCRIPT = ${JSON.stringify(reviewScript().replace(/\r\n/g, '\n'))};`,
    esc.toString(),
    jsonForScript.toString(),
    reviewWidget.toString(),
    ''
  ].join('\n\n').replace(/\r\n/g, '\n'); // 関数のソース(toString)・埋め込むルールも LF にそろえる
  return {
    'Rules.gs': HEADER('scripts/fb-review-rules.mjs') + rules,
    'ReviewUi.gs': HEADER('scripts/fb-review-ui.mjs') + ui
  };
}

const files = build();
if (process.argv.includes('--check')) {
  const stale = Object.entries(files).filter(([name, text]) => {
    const url = new URL(name, DIR);
    return !existsSync(url) || readFileSync(url, 'utf8') !== text;
  });
  if (stale.length) {
    console.log(`作り直しが必要です: ${stale.map(([n]) => n).join(', ')}(node scripts/build-gas-approval.mjs)`);
    process.exitCode = 1;
  } else {
    console.log('gas/fb-approval の自動生成ファイルは最新です');
  }
} else {
  for (const [name, text] of Object.entries(files)) writeFileSync(new URL(name, DIR), text);
  console.log(`作り直しました: ${Object.keys(files).join(', ')}`);
}
