/**
 * 「ふくしま市場」Facebookページの投稿案を、翌週7日分まとめて作るエージェント
 *
 * 新商品(new-1)・人気ランキング(ranking_top10)を優先し、全商品からも候補を集めて7商品を選ぶ。
 * 各投稿日の記念日(雑学ネタ帳)と照らし合わせ、Gemini で投稿文を作る。
 * 結果は HTML プレビューと候補履歴に書き出すだけで、Facebook へは送信しない。
 *
 * MODE(環境変数):
 *   preview … 7日分の投稿案を作り、HTMLプレビュー(preview/fb-week-<開始日>.html)と
 *             候補履歴(data/fb-post-history.json)を書き出す(既定)。Facebookへは一切通信しない。
 *             必要: GEMINI_API_KEY / 任意: WEEK_START(YYYY-MM-DD。省略時は翌週の月曜日)
 *   models  … Gemini APIで使えるFlash系モデルを一覧し、実際に呼び出せるか確かめる。
 *             Facebookへは一切通信しない。必要: GEMINI_API_KEY
 *   check   … トークンとページの疎通だけ確認する(読み取りのみ)。必要: FB_PAGE_ACCESS_TOKEN
 *   draft   … 停止中。週次版の下書き保存が完成するまで使わない。
 *
 * 安全装置:
 *   - Facebook への通信はすべて guardedFacebookFetch を通す。check の GET 以外はすべて遮断する
 *     (書き込みの経路は持たない)。
 *   - 商品サイト・雑学ネタ帳へのアクセスは politeFetch を通し、間隔を空け、429/503 のときは待って再試行する。
 *   - 投稿文の事実(産地・製法・数量など)は、Gemini に商品情報からの引用を添えさせ、コードで照合する。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RULES, unsupportedNumbers } from './fb-review-rules.mjs';
import { hashOf, reviewAssets, reviewBar, reviewRecordFromEntry, reviewWidget } from './fb-review-ui.mjs';

const CONFIG = {
  // 先頭から順に使う。2つ目以降は先頭が混雑・上限・通信エラーで使えないときの予備
  // (2026-11-08 に models モードで、一覧掲載と新APIキーでの呼び出しを確認したモデル。
  //  2026-11-09 の実データ実行では 3.8 / 3.7 が 429・503・時間切れを繰り返し、7件すべて 3.6 で生成できたため 3.6 を先頭にする)
  GEMINI_MODELS: process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.7-flash'],
  GEMINI_TIMEOUT_MS: Number(process.env.GEMINI_TIMEOUT_MS ?? 60000), // 1回の呼び出しの上限時間(応答が無ければ次のモデルへ)
  // すべてのモデルが混雑・通信エラーのとき、この時間だけ待って最初のモデルからやり直す(回数=要素数)
  GEMINI_RETRY_WAITS_MS: String(process.env.GEMINI_RETRY_WAITS_MS ?? '30000,60000').split(',').map(Number),
  GEMINI_OUTAGE_SLOTS: 2, // 混雑・通信エラーで生成できない日がこれだけ続いたら、残りの日は待たずに見送る
  // 同じモデルへの呼び出し間隔。上限は「プロジェクト×モデルごと」に数えられるため、モデル単位であける
  // (gemini-3.6-flash の上限は 1分5回=12秒に1回。2026-11-09 に AI Studio で確認。余裕をみて15秒)
  GEMINI_MIN_INTERVAL_MS: Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 15000),
  // 429 で示された待ち時間(retryDelay)がこれ以内なら、待って同じモデルでやり直す
  GEMINI_MAX_RETRY_DELAY_MS: Number(process.env.GEMINI_MAX_RETRY_DELAY_MS ?? 65000),
  // 1日の上限(gemini-3.6 / 3.8 とも1日20回。2026-11-09 に AI Studio で確認)を使い切らないよう、呼び出しを節約する
  GEMINI_CALL_BUDGET: Number(process.env.GEMINI_CALL_BUDGET ?? 20), // 1回の実行で Gemini を呼ぶ上限(失敗した呼び出しも数える)
  GEMINI_MAX_ATTEMPTS: 2, // ルールを外れた本文は、理由を添えて1回だけ作り直させる
  MAX_PRODUCT_SWITCHES: 1, // それでも直らないときに、予備の商品へ差し替える回数
  GRAPH_API_VERSION: 'v26.0',

  // 商品情報(Shopify の公開データ)
  SHOP_BASE_URL: 'https://fukushima-ichiba.com',
  RANKING_PATH: '/collections/ranking_top10/products.json?limit=250', // 人気ランキング(優先)
  NEW_PATH: '/collections/new-1/products.json?limit=250', // 新商品(優先)
  ALL_PATH: '/products.json?limit=250', // 全商品(&page=N で続きを取る)
  ALL_PAGE_SIZE: 250,
  ALL_MAX_PAGES: 4,
  MIN_DESCRIPTION_CHARS: 50, // 説明文がこれより短い商品は、根拠が足りないので候補にしない
  MAX_IMAGES: 2,
  // ジャンルの偏りを防ぐ。同じジャンルは1週間で原則この件数まで(候補が足りないときだけ超える)
  MAX_PER_GENRE: 2,
  // 商品名・種別・タグの言葉でジャンルを決める(上から順に判定。例: 桃ジュース→飲料、米こうじみそ→調味料)
  GENRE_RULES: [
    ['飲料・お酒', ['日本酒', '純米', '吟醸', '地酒', '清酒', 'にごり酒', '本醸造', '梅酒', '果実酒', '甘酒', 'どぶろく', 'ワイン', 'ビール', '焼酎', 'リキュール', 'シードル', 'ジュース', 'サイダー', '飲料', 'コーヒー', '珈琲', '紅茶', '緑茶', 'お茶']],
    ['お菓子・スイーツ', ['菓子', 'せんべい', '煎餅', '米菓', 'まんじゅう', '饅頭', '羊羹', 'ようかん', 'ゆべし', 'クッキー', 'ケーキ', 'チョコ', 'プリン', 'ゼリー', 'かりんとう', 'スイーツ', 'ままどおる', '最中', 'もなか']],
    ['調味料・加工品', ['みそ', '味噌', '醤油', 'しょうゆ', 'たれ', 'タレ', 'ドレッシング', 'ジャム', '漬物', '漬け', '佃煮', '缶詰', 'の素', 'つゆ', 'ソース', '干し', '凍み', '惣菜', 'レトルト']],
    ['麺類', ['ラーメン', 'らーめん', 'そば', '蕎麦', 'うどん', '冷麺', '麺']],
    ['お米', ['お米', '新米', '精米', '玄米', '無洗米', 'コシヒカリ', 'ひとめぼれ', 'ミルキークイーン', '天のつぶ', '里山のつぶ', 'にじのきらめき', '五百川', '福、笑い', 'つや姫', 'ササニシキ', 'あきたこまち', 'うるち米', 'もち米']],
    ['肉・魚', ['牛肉', '豚肉', '鶏肉', '地鶏', '和牛', '牛', '豚', 'ハム', 'ソーセージ', 'ベーコン', '鮭', '鯉', 'うなぎ', '魚', '肉']],
    ['果物', ['柿', 'りんご', '林檎', '桃', 'もも', '梨', 'ぶどう', '葡萄', 'シャインマスカット', 'いちご', '苺', 'さくらんぼ', 'メロン', 'ラ・フランス', '洋梨', 'ブルーベリー', 'フルーツ', '果物']],
    ['野菜・農産物', ['野菜', 'トマト', 'きゅうり', 'アスパラ', 'じゃがいも', 'かぼちゃ', '自然薯', 'きのこ', 'しいたけ', 'なめこ', 'ねぎ', '大豆', '豆', 'にんにく']]
  ],

  // 今日は何の日(雑学ネタ帳)
  ZATSUNETA_BASE_URL: 'https://zatsuneta.com',
  MAX_ANNIVERSARIES_PER_DAY: 40,

  // 外部サイトへのアクセス
  USER_AGENT: 'fukushima-ichiba-fb-preview/1.0 (+https://fukushima-ichiba.com/)',
  REQUEST_INTERVAL_MS: Number(process.env.REQUEST_INTERVAL_MS ?? 2000), // 同じサイトへの最短間隔
  RETRY_WAIT_MS: Number(process.env.RETRY_WAIT_MS ?? 10000), // 429/503 のときの待ち時間(回数に比例して延ばす)
  FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS ?? 30000), // 商品サイト・雑学ネタ帳・画像への1回の上限時間
  MAX_FETCH_RETRIES: 3,

  // 商品ページ・画像の確認(読み取りのみ)
  IMAGE_HOSTS: ['cdn.shopify.com'], // 商品画像はShopifyの画像配信サーバーのものだけ使う
  MOCK_IMAGE_HOSTS: ['images.mock.invalid'], // テスト用モックの画像(実在しないドメイン)
  MAX_VERIFY_FAILURES: 8, // 確認できない商品がこれだけ続いたら、それ以上は探さない(過度なアクセスを避ける)

  // 実データ(live)かテスト用モック(mock)か。mock はテスト用モックを読み込んだときだけ使える
  DATA_SOURCE: process.env.PREVIEW_DATA_SOURCE || 'live',

  // 週次の生成と履歴
  DAYS_PER_BATCH: 7,
  HISTORY_FILE: process.env.HISTORY_FILE || 'data/fb-post-history.json', // テストでは *.test.json しか使えない
  // candidate=プレビューで選んだ候補 / approved=承認した(修正して承認を含む) / rejected=不採用 / published=公開済み
  HISTORY_STATUSES: ['candidate', 'approved', 'rejected', 'published'],
  REUSE_BLOCK_DAYS: 30, // 投稿予定日の前後この日数に選ばれた商品は選ばない
  RECENT_PHRASES_COUNT: 14, // 書き出し・締めくくりが続かないよう、直近の分を避けさせる
  PREVIEW_DIR: 'preview',

  // 投稿文のルール(文字数・絵文字・誇張表現・定型表現・ハッシュタグは承認管理の修正チェックと共通: fb-review-rules.mjs)
  BODY_MIN_CHARS: RULES.BODY_MIN_CHARS, // 本文の文字数の目安(改行・空白・URL・ハッシュタグを除く)。下回っても作り直さない
  BODY_MAX_CHARS: RULES.BODY_MAX_CHARS, // 上回ったら作り直させる
  MAX_EMOJI: RULES.MAX_EMOJI,
  NG_PHRASES: RULES.NG_PHRASES,
  // 汎用的な締めの定型表現。本文に含まれていたら作り直させる
  STOCK_PHRASES: RULES.STOCK_PHRASES,
  // 投稿の切り口(Gemini にどれか1つを選ばせ、同じ週で偏らないようにする)
  FOCUS_TYPES: ['味', '食感', '香り', '食べ方・使い方', '製法', '産地・育ち', '生産者', '季節', 'その他'],
  // 週全体の類似チェック
  SIMILARITY_JACCARD: 0.6, // 見出し・最後の一文の「商品名を除いた言い回し」がこれ以上似ていたら類似
  SAME_ENDING_LIMIT: 2, // 文末(最後の4文字)が同じ投稿はこの件数まで
  SAME_STRUCTURE_LIMIT: 3, // 段落・文の組み立てが同じ投稿はこの件数まで
  SAME_FOCUS_LIMIT: 3, // 切り口が同じ投稿はこの件数まで(見出し・本文・締めの類似は別に確かめる)
  SAME_HEADLINE_SHAPE_LIMIT: 3, // 絵文字や「」を使う見出しで、形(絵文字の有無・「」の位置)が同じ投稿はこの件数まで
  MAX_EMOJI_HEADLINES: 4, // 絵文字で始まる見出しはこの件数まで(7件中)
  WEEK_REWRITE_LIMIT: 2, // 類似で書き直す投稿の上限(1回の実行あたり。呼び出し回数を節約する)
  WEEK_REWRITE_ATTEMPTS: 1, // 1投稿あたりの書き直し回数
  FIXED_HASHTAGS: RULES.FIXED_HASHTAGS,
  EXTRA_HASHTAGS: RULES.EXTRA_HASHTAGS, // 商品情報から選ぶハッシュタグの数(固定と合わせて4個)
  // 参考にしたい公式Xの投稿文を置くと、文体の手本としてプロンプトに入る(投稿ごとに "---" 行で区切る)
  STYLE_EXAMPLES_FILE: 'data/fb-style-examples.txt',

  TOKEN_WARN_DAYS: 14 // トークンの残り日数がこれを切ったら Issue で知らせる(check)
};

// 雰囲気の参考(2026-11 に共有された「会津みしらず柿」の修正版)。構成や締め方の型としては使わない
const STYLE_REFERENCE = `🍂 会津の秋の味覚「会津みしらず柿」

会津盆地特有の気候で育まれた、甘み豊かなみしらず柿。

収穫後、約2週間かけてじっくり渋抜きをすることで、とろりとした食感と濃密な甘みに仕上がります。

季節限定の味わいをぜひお楽しみください♪`;

const MODES = ['preview', 'models', 'check', 'draft'];
const MODE = process.env.MODE || 'preview';
const IS_MOCK = CONFIG.DATA_SOURCE === 'mock';
const IMAGE_HOSTS = IS_MOCK ? CONFIG.MOCK_IMAGE_HOSTS : CONFIG.IMAGE_HOSTS;
const MOCK_LABEL = 'テスト用データ・投稿不可';

const SOURCE_LABELS = { ranking: '人気ランキング', new: '新商品', all: '全商品' };
const AVAILABILITY_LABELS = { in_stock: '在庫あり', sold_out: '売り切れ', unknown: '在庫未確認' };
const STATUS_LABELS = { candidate: '候補', approved: '承認済み', rejected: '不採用', published: '公開済み' };

async function main() {
  if (!MODES.includes(MODE)) {
    throw new Error(`MODE は ${MODES.join(' / ')} のいずれかを指定してください(指定値: ${MODE})。`);
  }
  if (MODE === 'draft') {
    throw new Error('draft モードは週次版が完成するまで停止しています。Facebookへは何も送信していません。');
  }
  if (MODE === 'preview') return runWeeklyPreview();
  if (MODE === 'models') return checkGeminiModels();
  return runCheck();
}

// ---------------------------------------------------------------------------
// 週次プレビュー
// ---------------------------------------------------------------------------

/**
 * 実データとテスト用モックを取り違えないための確認。
 * - テスト用モック(globalThis.__FB_PREVIEW_MOCK__ を立てる)が読み込まれていれば、PREVIEW_DATA_SOURCE=mock が必須
 * - PREVIEW_DATA_SOURCE=mock はモックが読み込まれているときだけ使える(実データにテスト表示を付けない)
 * - テストの履歴は *.test.json だけ、実データの履歴は *.test.json 以外だけ
 */
function assertDataSource() {
  const mockLoaded = globalThis.__FB_PREVIEW_MOCK__ === true;
  if (!['live', 'mock'].includes(CONFIG.DATA_SOURCE)) {
    throw new Error(`PREVIEW_DATA_SOURCE は live または mock を指定してください(指定値: ${CONFIG.DATA_SOURCE})。`);
  }
  if (mockLoaded && !IS_MOCK) {
    throw new Error('テスト用モックが読み込まれているため中止しました。実データ用のプレビュー・履歴は作りません(テストでは PREVIEW_DATA_SOURCE=mock を指定)。');
  }
  if (IS_MOCK && !mockLoaded) {
    throw new Error('PREVIEW_DATA_SOURCE=mock はテスト用モックと一緒にだけ使えます。中止しました。');
  }
  if (IS_MOCK && process.env.GITHUB_ACTIONS === 'true') {
    throw new Error('GitHub Actions ではテスト用モックを使えません。中止しました。');
  }
  const testHistory = CONFIG.HISTORY_FILE.endsWith('.test.json');
  if (IS_MOCK && !testHistory) {
    throw new Error(`テストでは本番用の履歴(${CONFIG.HISTORY_FILE})を使えません。HISTORY_FILE に *.test.json を指定してください。`);
  }
  if (!IS_MOCK && testHistory) {
    throw new Error(`実データの実行ではテスト用の履歴(${CONFIG.HISTORY_FILE})を使えません。`);
  }
}

async function runWeeklyPreview() {
  assertDataSource();
  const apiKey = requireEnv('GEMINI_API_KEY');
  const weekStart = resolveWeekStart();
  const dates = Array.from({ length: CONFIG.DAYS_PER_BATCH }, (_, i) => addDays(weekStart, i));
  log(`対象の週: ${dates[0]} 〜 ${dates.at(-1)}`);

  const history = loadHistory();
  // 承認済み・公開済みの日は作り直さない
  const lockedByDate = new Map(history.entries
    .filter(e => (e.status === 'approved' || e.status === 'published') && dates.includes(e.postDate))
    .map(e => [e.postDate, e]));
  const openDates = dates.filter(d => !lockedByDate.has(d));

  const { pool, stats } = await collectProducts(blockedProductIds(history, weekStart, dates));
  const anniversaries = await fetchAnniversaries(dates);

  // 商品ページ・商品データ・画像を確認できた商品だけを使う(予備も使う直前に確認する)
  // 承認済み・公開済みの日の商品も、ジャンルの上限に数える(記録のジャンルは古い判定のことがあるので、商品名から判定し直す)
  const lockedGenres = [...lockedByDate.values()].map(e => productGenre(String(e.title || ''), e.source?.productType || '', e.source?.tags || []));
  const nextVerified = createVerifiedProductSource(pool, stats, lockedGenres);
  const primary = [];
  while (primary.length < openDates.length) {
    const p = await nextVerified();
    if (!p) break;
    primary.push(p);
  }
  const { assignments, note: assignmentNote } = await assignProducts(apiKey, openDates, primary, anniversaries);

  const historyPhrases = recentPhrases(history, weekStart, dates);
  const avoid = { openings: [...historyPhrases.openings], closings: [...historyPhrases.closings] };
  const results = new Map();
  let outageStreak = 0;
  let stopReason = '';
  for (const [index, date] of openDates.entries()) {
    const a = assignments.find(x => x.date === date);
    if (!a) {
      results.set(date, { date, failed: true, error: '確認できた候補商品が足りませんでした' });
      continue;
    }
    if (outageStreak >= CONFIG.GEMINI_OUTAGE_SLOTS) {
      // 混雑・通信エラーが続いているときは、残りの日で長く待ち続けない
      nextVerified.release(a.product);
      results.set(date, { date, failed: true, transient: true, product: a.product, error: stopReason === 'daily'
        ? 'Gemini の1日の利用上限に達したため、この日は生成を見送りました(日本時間17時ごろにリセット)'
        : stopReason === 'budget'
          ? `この実行の Gemini 呼び出し上限(${CONFIG.GEMINI_CALL_BUDGET}回)に達したため、この日は生成を見送りました`
          : `Gemini の混雑・通信エラーが${outageStreak}日続いたため、この日は生成を見送りました` });
      continue;
    }
    const anniversary = await resolveAnniversary(date, a, anniversaries[date]);
    const weekPosts = [...results.values()].filter(p => !p.failed);
    // 残りの日(この日より後)に1回ずつ呼べる分は、作り直し・差し替えに使わない
    const reserve = openDates.length - index - 1;
    const post = await generateForSlot(apiKey, { date, product: a.product, anniversary, assignReason: a.reason, reserve }, nextVerified, avoid, weekPosts);
    if (!post.failed) {
      avoid.openings.push(post.opening);
      avoid.closings.push(post.closing);
    }
    // 1日の上限・この実行の呼び出し上限に達したときは、残りの日もすぐ見送る
    stopReason = post.dailyQuota ? 'daily' : post.budget ? 'budget' : '';
    outageStreak = post.failed && post.transient ? (stopReason ? CONFIG.GEMINI_OUTAGE_SLOTS : outageStreak + 1) : 0;
    results.set(date, post);
  }
  // 7件そろってから、見出し・最後の一文・構成・切り口の似すぎを確かめ、似すぎた投稿を書き直す
  const weekReview = await reviewWeek(apiKey, openDates.map(d => results.get(d)), historyPhrases, results);
  for (const [date, entry] of lockedByDate) results.set(date, { date, locked: true, entry });

  const posts = dates.map(d => results.get(d));
  for (const p of posts) {
    p.rejectedEntries = history.entries.filter(e => e.status === 'rejected' && e.week === weekStart && e.postDate === p.date);
  }
  const recorded = updateHistory(history, weekStart, dates, posts);
  if (recorded !== null) saveHistory(history);

  const file = resolve(CONFIG.PREVIEW_DIR, `fb-week-${weekStart}${IS_MOCK ? '-TEST' : ''}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderWeeklyHtml({ weekStart, dates, posts, stats, anniversaries, assignmentNote, recorded, weekReview }));

  const done = completeness(posts);
  summary([
    ...(IS_MOCK ? [`## ⚠ ${MOCK_LABEL}(テスト用モックで作成)`, ''] : []),
    `### 週次投稿案プレビュー ${formatDateJa(dates[0])} 〜 ${formatDateJa(dates.at(-1))}(Facebookには送信していません)`,
    ...(done.problems.length
      ? ['', `**⚠ 未完成: ${done.total}件中 ${done.ready}件のみ承認可能**`, ...done.problems.map(x => `- ${formatDateJa(x.date)}: ${x.title}${x.product ? `(${x.product})` : ''}`)]
      : []),
    '',
    '| 投稿日 | 商品 | ジャンル | 記念日 | 状態 |',
    '|---|---|---|---|---|',
    ...posts.map(p => `| ${formatDateJa(p.date)} | ${mdCell(slotTitle(p))} | ${mdCell(p.product?.genre || p.entry?.genre || '-')} | ${mdCell(slotAnniversary(p))} | ${slotStatus(p)} |`),
    '',
    `週全体の類似チェック: 似すぎ${weekReview.checked}件 → 書き直し${weekReview.rewritten.length}件 / 残り${weekReview.remaining}件`,
    geminiUsageSummary(),
    recorded === null
      ? '生成に成功した投稿がないため、候補履歴は変更していません'
      : `候補履歴に記録: ${recorded}件(${CONFIG.HISTORY_FILE})`,
    `プレビュー: ${pathToFileURL(file).href}`
  ].join('\n'));
}

function resolveWeekStart() {
  const value = process.env.WEEK_START;
  if (!value) return nextMondayJst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`WEEK_START は YYYY-MM-DD 形式で指定してください(指定値: ${value})。`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 商品情報
// ---------------------------------------------------------------------------

/**
 * 人気ランキングと新商品を交互に優先し、その後に全商品(公開日の新しい順)を並べる。
 * 売り切れ・画像なし・説明文不足・最近選んだ商品は候補から外し、理由を記録する。
 */
async function collectProducts(blockedIds) {
  const ranking = await fetchProductList(CONFIG.RANKING_PATH);
  const fresh = await fetchProductList(CONFIG.NEW_PATH);
  const all = { products: [], error: null };
  for (let page = 1; page <= CONFIG.ALL_MAX_PAGES; page++) {
    const r = await fetchProductList(`${CONFIG.ALL_PATH}&page=${page}`);
    if (r.error) {
      all.error = r.error;
      break;
    }
    all.products.push(...r.products);
    if (r.products.length < CONFIG.ALL_PAGE_SIZE) break;
  }

  const byId = new Map();
  const add = (p, source, rank = null) => {
    const existing = byId.get(p.id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (rank && !existing.rank) existing.rank = rank;
      return;
    }
    byId.set(p.id, { ...p, sources: [source], rank });
  };
  ranking.products.forEach((p, i) => add(p, 'ranking', i + 1));
  fresh.products.forEach(p => add(p, 'new'));
  all.products.forEach(p => add(p, 'all'));

  const prioritized = [];
  for (let i = 0; i < Math.max(ranking.products.length, fresh.products.length); i++) {
    if (ranking.products[i]) prioritized.push(byId.get(ranking.products[i].id));
    if (fresh.products[i]) prioritized.push(byId.get(fresh.products[i].id));
  }
  const rest = all.products.map(p => byId.get(p.id))
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));

  const excluded = { soldOut: [], noImage: [], shortDescription: [], recentlyUsed: [] };
  const seen = new Set();
  const pool = [];
  for (const p of [...prioritized, ...rest]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const reason = exclusionReason(p, blockedIds);
    if (reason) excluded[reason].push(p.title);
    else pool.push(p);
  }
  log(`候補商品: ${pool.length}件(ランキング${ranking.products.length} / 新商品${fresh.products.length} / 全商品${all.products.length})`);
  return {
    pool,
    stats: {
      counts: { ranking: ranking.products.length, new: fresh.products.length, all: all.products.length },
      errors: { ranking: ranking.error, new: fresh.error, all: all.error },
      excluded,
      eligible: pool.length
    }
  };
}

function exclusionReason(p, blockedIds) {
  if (p.availability === 'sold_out') return 'soldOut';
  if (p.images.length === 0) return 'noImage';
  if (compact(p.description).length < CONFIG.MIN_DESCRIPTION_CHARS) return 'shortDescription';
  if (blockedIds.has(p.id)) return 'recentlyUsed';
  return null;
}

async function fetchProductList(path) {
  try {
    const res = await politeFetch(CONFIG.SHOP_BASE_URL + path);
    if (!res.ok) return { products: [], error: `HTTP ${res.status}` };
    const json = await res.json();
    return { products: (json.products || []).filter(p => p && p.id && p.handle).map(normalizeProduct), error: null };
  } catch (e) {
    return { products: [], error: e.message };
  }
}

function normalizeProduct(p) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const knownStock = variants.filter(v => typeof v.available === 'boolean');
  let availability = 'unknown'; // 公開データに在庫情報が無い場合
  if (knownStock.some(v => v.available)) availability = 'in_stock';
  else if (knownStock.length > 0 && knownStock.length === variants.length) availability = 'sold_out';
  const tags = Array.isArray(p.tags) ? p.tags.map(String) : String(p.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  return {
    genre: productGenre(String(p.title || ''), String(p.product_type || ''), tags),
    id: String(p.id),
    title: String(p.title || ''),
    handle: p.handle,
    url: `${CONFIG.SHOP_BASE_URL}/products/${p.handle}`,
    vendor: String(p.vendor || ''),
    productType: String(p.product_type || ''),
    tags,
    description: htmlToText(p.body_html),
    images: (p.images || []).map(img => img && img.src).filter(Boolean).slice(0, CONFIG.MAX_IMAGES),
    price: variants[0]?.price ?? '',
    availability,
    publishedAt: p.published_at || ''
  };
}

/**
 * ジャンルを決める(説明文は使わない)。まず商品名だけで判定し、決まらないときだけ種別・タグを見る。
 * (ストアのタグには「米・麺類」のような複数ジャンルをまとめた分類があり、タグから先に見ると誤判定するため)
 * どれにも当たらなければ種別か「その他」。
 */
function productGenre(title, productType, tags) {
  const match = text => {
    const t = norm(text);
    if (!t) return null;
    for (const [genre, words] of CONFIG.GENRE_RULES) {
      if (words.some(w => t.includes(norm(w)))) return genre;
    }
    return null;
  };
  return match(title) || match(productType) || match(tags.join(' ')) || (productType ? `その他(${productType})` : 'その他');
}

/**
 * 候補を先頭から1件ずつ確認し、確認できた商品を返す関数を作る。
 * - 同じジャンルが MAX_PER_GENRE 件に達したら、そのジャンルの商品は後回しにする
 *   (候補を最後まで見ても足りないときだけ、後回しにした商品を使い、その旨を記録する)
 * - 確認できなかった商品は stats.verifyFailures に理由と一緒に残し、MAX_VERIFY_FAILURES 件で打ち切る
 * nextVerified.release(product) で、使わなかった商品のジャンルの枠を戻す。
 */
function createVerifiedProductSource(pool, stats, lockedGenres = []) {
  let index = 0;
  const genreCount = new Map();
  for (const g of lockedGenres) genreCount.set(g, (genreCount.get(g) || 0) + 1);
  const deferred = [];
  stats.verifyFailures = [];
  stats.genreDeferred = [];
  stats.genreRelaxed = [];
  const nextVerified = async function () {
    while (stats.verifyFailures.length < CONFIG.MAX_VERIFY_FAILURES) {
      let product;
      if (index < pool.length) {
        product = pool[index++];
        if ((genreCount.get(product.genre) || 0) >= CONFIG.MAX_PER_GENRE) {
          deferred.push(product);
          stats.genreDeferred.push({ title: product.title, genre: product.genre });
          continue;
        }
      } else if (deferred.length > 0) {
        product = deferred.shift();
        log(`ほかのジャンルの候補が足りないため、ジャンル上限を超えて使います: ${product.title}(${product.genre})`);
      } else {
        return null;
      }
      const result = await verifyProduct(product);
      if (result.ok) {
        if ((genreCount.get(product.genre) || 0) >= CONFIG.MAX_PER_GENRE) {
          stats.genreRelaxed.push({ title: product.title, genre: product.genre });
        }
        genreCount.set(product.genre, (genreCount.get(product.genre) || 0) + 1);
        return result.product;
      }
      stats.verifyFailures.push({ title: product.title, url: product.url, checks: result.checks });
      log(`確認できなかったため使いません: ${product.title}(${result.checks.filter(c => !c.ok).map(c => `${c.label}: ${c.detail}`).join(' / ')})`);
    }
    return null;
  };
  nextVerified.release = product => {
    genreCount.set(product.genre, Math.max(0, (genreCount.get(product.genre) || 0) - 1));
  };
  return nextVerified;
}

/**
 * 商品を3段階で確認する(読み取りのみ)。どれかに失敗したら使わない。
 * 1. 単品データ(/products/<handle>.js)を取り直し、一覧と ID・handle・商品名が一致するか
 * 2. 商品ページ(/products/<handle>)が商品ページとして表示されるか(HTTP 200 だけで判断しない)
 * 3. 画像が Shopify の画像配信サーバーのもので、同じ商品の画像として登録されていて、画像として読めるか
 * 返す商品の説明文・在庫・画像は、確認に使った同じ商品のデータだけで組み立てる。
 */
async function verifyProduct(listed) {
  const checks = [];
  const check = (label, ok, detail = '') => {
    checks.push({ label, ok, detail });
    return ok;
  };
  const fail = () => ({ ok: false, checks });

  // 1. 単品データとの照合
  let single;
  try {
    const res = await politeFetch(`${CONFIG.SHOP_BASE_URL}/products/${encodeURIComponent(listed.handle)}.js`);
    if (!check('商品データ', res.ok, `HTTP ${res.status}`)) return fail();
    single = await res.json();
  } catch (e) {
    check('商品データ', false, e.message);
    return fail();
  }
  const same = String(single.id) === listed.id && single.handle === listed.handle && norm(single.title) === norm(listed.title);
  if (!check('商品データの照合(ID・handle・商品名)', same, same
    ? `ID ${listed.id}`
    : `一覧 ${listed.id} / ${listed.handle} / ${listed.title} と 単品 ${single.id} / ${single.handle} / ${single.title} が一致しない`)) return fail();

  const product = { ...listed };
  if (typeof single.available === 'boolean') product.availability = single.available ? 'in_stock' : 'sold_out';
  if (!check('在庫', product.availability !== 'sold_out', AVAILABILITY_LABELS[product.availability])) return fail();
  const description = htmlToText(single.description);
  if (description) product.description = description; // 同じ商品IDの単品データの説明文を正とする
  if (!check('説明文', compact(product.description).length >= CONFIG.MIN_DESCRIPTION_CHARS,
    `${compact(product.description).length}文字`)) return fail();

  // 2. 商品ページの表示
  const page = await checkProductPage(product);
  if (!check('商品ページ', page.ok, page.detail)) return fail();

  // 3. 画像(Shopifyの画像配信サーバー・同じ商品の画像・画像として読める)
  const registered = new Set((single.images || []).map(imageFileName).filter(Boolean));
  const images = [];
  for (const src of listed.images) {
    const host = safeHost(src);
    if (!IMAGE_HOSTS.includes(host)) {
      check('画像', false, `Shopifyの画像配信サーバー以外の画像は使いません: ${host || src}`);
      continue;
    }
    if (!registered.has(imageFileName(src))) {
      check('画像', false, `単品データに登録されていない画像: ${imageFileName(src)}`);
      continue;
    }
    const r = await checkImage(src);
    check('画像', r.ok, r.ok ? imageFileName(src) : `${imageFileName(src)}: ${r.detail}`);
    if (r.ok) images.push(src);
  }
  if (images.length === 0) {
    check('使える画像', false, '確認できた画像がありません');
    return fail();
  }
  product.images = images;
  product.verification = checks;
  // 画像の一部が使えないだけなら商品は使う(使えた画像だけを表示する)
  return { ok: true, product, checks };
}

/** 商品ページが「その商品のページ」として表示されるかを、HTML の中身で確かめる */
async function checkProductPage(product) {
  let res;
  let html = '';
  try {
    res = await politeFetch(product.url);
    html = res.ok ? await res.text() : '';
  } catch (e) {
    return { ok: false, detail: e.message };
  }
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  const type = res.headers?.get?.('content-type') || '';
  if (!type.includes('text/html')) return { ok: false, detail: `HTMLではありません(${type || '不明'})` };
  const finalPath = decodeURIComponent(new URL(res.url || product.url).pathname);
  if (!finalPath.endsWith(`/products/${product.handle}`)) return { ok: false, detail: `別のページに転送されました: ${finalPath}` };

  const titleTag = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const ogTitle = decodeEntities(metaContent(html, 'og:title'));
  const ogType = metaContent(html, 'og:type');
  if (/ページが見つかりません|見つかりませんでした|404|not found/i.test(titleTag)) {
    return { ok: false, detail: `「見つかりません」ページでした(${compactSpaces(titleTag).slice(0, 60)})` };
  }
  if (ogType !== 'product') return { ok: false, detail: `商品ページの目印(og:type=product)がありません(${ogType || 'なし'})` };
  if (!norm(ogTitle + titleTag).includes(norm(product.title))) {
    return { ok: false, detail: `ページの商品名が一致しません(${compactSpaces(ogTitle || titleTag).slice(0, 60)})` };
  }
  return { ok: true, detail: '商品名・商品ページの目印を確認' };
}

/**
 * 画像を読み取りで確認する(HEAD。使えない場合だけ GET)。
 * アクセス制限(429/503)のときは再試行せず、以後その実行では画像の確認をやめてエラーにする。
 */
let imageHostLimited = false;
async function checkImage(src) {
  if (imageHostLimited) return { ok: false, detail: 'アクセス制限中のため確認していません' };
  try {
    let res = await politeFetch(src, { method: 'HEAD', retry: false });
    if (res.status === 405 || res.status === 403) res = await politeFetch(src, { retry: false });
    if (res.status === 429 || res.status === 503) {
      imageHostLimited = true;
      return { ok: false, detail: `アクセス制限(HTTP ${res.status})のため確認できませんでした(再試行しません)` };
    }
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const type = res.headers?.get?.('content-type') || '';
    if (!type.startsWith('image/')) return { ok: false, detail: `画像ではありません(${type || '不明'})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function metaContent(html, property) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (new RegExp(`(property|name)=["']${property}["']`, 'i').test(tag)) {
      return (tag.match(/content=["']([^"']*)["']/i) || [])[1] || '';
    }
  }
  return '';
}

/** 画像URLのファイル名(?v= などは除く)。一覧と単品データで同じ画像かを比べるのに使う */
function imageFileName(src) {
  try {
    return new URL(String(src), 'https://example.invalid').pathname.split('/').pop() || '';
  } catch {
    return '';
  }
}

function safeHost(src) {
  try {
    return new URL(String(src)).host;
  } catch {
    return '';
  }
}

/** 投稿文の根拠として使ってよい商品情報の文章 */
function productSourceText(p) {
  return [p.title, p.vendor, p.productType, p.tags.join(' '), p.description].join('\n');
}

// ---------------------------------------------------------------------------
// 今日は何の日(雑学ネタ帳)
// ---------------------------------------------------------------------------

async function fetchAnniversaries(dates) {
  const result = {};
  const robots = await zatsunetaRobotsAllows('/archives/');
  for (const date of dates) {
    if (!robots.allowed) {
      result[date] = { ok: false, items: [], error: robots.reason };
      continue;
    }
    const [, mm, dd] = date.split('-');
    const url = `${CONFIG.ZATSUNETA_BASE_URL}/archives/a${mm}${dd}.html`;
    try {
      const res = await politeFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseAnniversaryList(await res.text(), Number(mm), Number(dd));
      result[date] = items.length
        ? { ok: true, items, url }
        : { ok: false, items: [], url, error: '記念日を読み取れませんでした(ページ構成が変わった可能性)' };
    } catch (e) {
      result[date] = { ok: false, items: [], url, error: e.message };
    }
  }
  return result;
}

/** 日付ページのリンク(title="記念日名(M月D日 記念日)")から、その日の記念日を取り出す */
function parseAnniversaryList(html, month, day) {
  const items = [];
  const re = /<a\s+href="([^"]+)"\s+title="([^"]+?)（(\d+)月(\d+)日 記念日）"/g;
  for (const m of html.matchAll(re)) {
    if (Number(m[3]) !== month || Number(m[4]) !== day) continue;
    const name = decodeEntities(m[2]).trim();
    if (!items.some(i => i.name === name)) items.push({ name, url: m[1] });
  }
  return items.slice(0, CONFIG.MAX_ANNIVERSARIES_PER_DAY);
}

/** 記念日の個別ページから冒頭の説明(text_intro)を取り出す。取れなければ null */
async function fetchAnniversaryDetail(url) {
  if (!url.startsWith(`${CONFIG.ZATSUNETA_BASE_URL}/archives/`)) return null;
  try {
    const res = await politeFetch(url);
    if (!res.ok) return null;
    const m = (await res.text()).match(/<div id="text_intro">([\s\S]*?)<\/div>/);
    const text = m ? htmlToText(m[1]).slice(0, 300) : '';
    return text || null;
  } catch {
    return null;
  }
}

async function resolveAnniversary(date, assignment, day) {
  if (!assignment.anniversaryName) return null;
  const item = day?.items.find(i => i.name === assignment.anniversaryName);
  if (!item) return null;
  const description = await fetchAnniversaryDetail(item.url);
  if (!description) {
    log(`${date} の記念日「${item.name}」の説明を取得できなかったため使用しません`);
    return null;
  }
  return { name: item.name, url: item.url, description };
}

let robotsCache = null;
async function zatsunetaRobotsAllows(path) {
  if (robotsCache) return robotsCache;
  try {
    const res = await politeFetch(`${CONFIG.ZATSUNETA_BASE_URL}/robots.txt`);
    if (res.status === 404) return (robotsCache = { allowed: true });
    if (!res.ok) return (robotsCache = { allowed: false, reason: `robots.txt を確認できませんでした(HTTP ${res.status})` });
    const disallows = parseRobotsDisallows(await res.text());
    const blocked = disallows.some(d => d === '/' || path.startsWith(d));
    return (robotsCache = blocked
      ? { allowed: false, reason: 'robots.txt で取得が許可されていません' }
      : { allowed: true });
  } catch (e) {
    return (robotsCache = { allowed: false, reason: `robots.txt を確認できませんでした(${e.message})` });
  }
}

/** User-agent: * のグループの Disallow を取り出す(空の Disallow は「すべて許可」なので除く) */
function parseRobotsDisallows(text) {
  const disallows = [];
  let applies = false;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!inAgents) applies = false;
      inAgents = true;
      if (m[2].trim() === '*') applies = true;
      continue;
    }
    inAgents = false;
    if (applies && key === 'disallow' && m[2].trim()) disallows.push(m[2].trim());
  }
  return disallows;
}

// ---------------------------------------------------------------------------
// 商品の割り当てと投稿文の生成(Gemini)
// ---------------------------------------------------------------------------

/**
 * 選んだ商品を各日付に割り当てる。記念日と自然につながる商品があればその日に置く。
 * 返ってきた内容が不正なら、記念日なしで順番に割り当てる。
 */
async function assignProducts(apiKey, dates, products, anniversaries) {
  const slots = dates.slice(0, products.length);
  const fallback = note => ({
    assignments: slots.map((date, i) => ({ date, product: products[i], anniversaryName: '', reason: '' })),
    note
  });
  if (slots.length === 0) return { assignments: [], note: null };

  const prompt = `
あなたは「ふくしま市場」(福島県産品のオンラインストア)のSNS担当者です。
次の商品を、各投稿日に1つずつ割り当ててください(すべての商品を1回ずつ使う)。

各日の記念日リストに、商品と強く自然に関連するもの(例: 商品そのものや原材料の記念日)があれば、
その日にその商品を置き、記念日名を anniversary に入れる。
関連が弱い・こじつけになる場合は anniversary を空文字にする。記念日はリストにある名前だけを使う。

投稿日と記念日:
${slots.map(d => `- ${d}(${weekdayJa(d)}): ${anniversaries[d]?.ok ? anniversaries[d].items.map(i => i.name).join('、') : '(記念日情報なし)'}`).join('\n')}

商品:
${products.map(p => `- 商品ID: ${p.id} / ${p.title} / 種別: ${p.productType || '-'} / タグ: ${p.tags.join('、') || '-'} / 説明: ${compactSpaces(p.description).slice(0, 120)}`).join('\n')}

出力は次のJSON形式のみ。
{"assignments": [{"date": "YYYY-MM-DD", "product_id": "商品ID", "anniversary": "記念日名または空文字", "reason": "記念日を使う/使わない理由を一言"}]}
`;
  let data;
  try {
    ({ data } = await callGeminiJson(apiKey, prompt));
  } catch (e) {
    log('商品の割り当てに失敗したため、記念日なしで順番に割り当てます: ' + e.message);
    return fallback('Gemini による割り当てに失敗したため、記念日なしで順番に割り当てました');
  }

  const list = Array.isArray(data.assignments) ? data.assignments : [];
  const used = new Set();
  const assignments = [];
  for (const date of slots) {
    const a = list.find(x => String(x.date) === date);
    const product = a && products.find(p => p.id === String(a.product_id));
    if (!product || used.has(product.id)) {
      return fallback('Gemini の割り当て結果が不正だったため、記念日なしで順番に割り当てました');
    }
    used.add(product.id);
    const name = String(a.anniversary || '');
    const valid = name && anniversaries[date]?.items.some(i => i.name === name);
    assignments.push({ date, product, anniversaryName: valid ? name : '', reason: String(a.reason || '') });
  }
  return { assignments, note: null };
}

/**
 * 1日分の投稿文を作る。ルールや事実確認に通らなければ作り直させ、それでも駄目なら予備の商品に差し替える。
 * どうしても通らない場合は、一番ましな案を「要確認(承認不可)」として返す(履歴には記録しない)。
 * 使わなかった商品はジャンルの枠を戻す。
 */
async function generateForSlot(apiKey, slot, nextVerified, avoid, weekPosts = []) {
  const tried = [];
  const finish = result => {
    for (const p of tried) if (result.failed || p !== result.product) nextVerified.release?.(p);
    return result;
  };
  const post = await generateForSlotInner(apiKey, slot, nextVerified, avoid, weekPosts, tried);
  return finish(post);
}

async function generateForSlotInner(apiKey, slot, nextVerified, avoid, weekPosts, tried) {
  const replaced = [];
  let best = null;
  let lastError = null;
  let transient = false;
  let dailyQuota = false;
  let budget = false;
  for (let s = 0; s <= CONFIG.MAX_PRODUCT_SWITCHES; s++) {
    if (s > 0 && geminiBudgetLeft() <= (slot.reserve || 0)) {
      log(`${slot.date}: Gemini の呼び出しを節約するため、予備の商品への差し替えはしません`);
      break;
    }
    const product = s === 0 ? slot.product : await nextVerified();
    if (!product) break;
    tried.push(product);
    let bestStyle = null;
    const anniversary = s === 0 ? slot.anniversary : null; // 差し替え後の商品には記念日を使わない
    const prompt = buildPostPrompt(slot.date, product, anniversary, avoid, weekPosts);
    let feedback = '';
    let errored = false;
    for (let attempt = 1; attempt <= CONFIG.GEMINI_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1 && geminiBudgetLeft() <= (slot.reserve || 0)) {
        log(`${slot.date} ${product.title}: Gemini の呼び出しを節約するため、作り直しはしません`);
        break;
      }
      let data;
      let model;
      try {
        ({ data, model } = await callGeminiJson(apiKey, prompt + feedback));
      } catch (e) {
        lastError = e.message;
        transient = Boolean(e.transient);
        dailyQuota = Boolean(e.dailyQuota);
        budget = Boolean(e.budget);
        errored = true;
        break;
      }
      const post = evaluatePost(data, slot.date, product, anniversary, avoid);
      Object.assign(post, { date: slot.date, product, anniversary, model, attempts: attempt, replaced: [...replaced] });
      if (post.ok && post.styleIssues.length === 0) return post;
      if (post.ok && (!bestStyle || post.styleIssues.length < bestStyle.styleIssues.length)) bestStyle = post;
      if (!best || problemCount(post) < problemCount(best)) best = post;
      const problems = [...post.issues, ...post.factIssues, ...post.styleIssues];
      feedback = `\n\n前回の本文には次の問題がありました。直して書き直してください:\n- ${problems.join('\n- ')}\n前回の本文:\n${post.body}\n`;
      log(`${slot.date} ${product.title}: 作り直します(${attempt}回目): ${problems.join(' / ')}`);
    }
    // ルール・事実確認に通った案があれば、言い回しの注意が残っていても商品は差し替えない
    if (bestStyle) return bestStyle;
    if (errored && !best) {
      // Gemini 自体のエラーは商品を替えても直らないことが多いので、この日は失敗にする
      return { date: slot.date, failed: true, transient, dailyQuota, budget, error: `Gemini APIエラー: ${lastError}`, product, replaced };
    }
    replaced.push({ title: product.title, reason: errored ? 'Gemini APIエラー' : 'ルール・事実確認を満たせなかった' });
  }
  if (best) return { ...best, ok: false, needsReview: true, replaced };
  return { date: slot.date, failed: true, transient, dailyQuota, budget, error: lastError ? `Gemini APIエラー: ${lastError}` : '確認できた候補商品が足りませんでした', replaced };
}

/** 失敗・要確認の理由を、プレビュー向けの短い説明にする */
function describeProblem(p) {
  if (p.failed) {
    const e = String(p.error || '');
    if (/呼び出し上限/.test(e)) return { title: `この実行の Gemini 呼び出し上限(${CONFIG.GEMINI_CALL_BUDGET}回)に達したため生成できませんでした`, detail: e };
    if (/1日の(利用)?上限/.test(e)) return { title: 'Gemini の1日の利用上限に達したため生成できませんでした', detail: e };
    if (/見送りました/.test(e)) return { title: 'Gemini の障害が続いたため生成を見送りました', detail: e };
    if (/応答がありませんでした|fetch failed/.test(e) && !/503|UNAVAILABLE/.test(e)) return { title: 'Gemini との通信エラーで生成できませんでした', detail: e };
    if (/混雑|503|UNAVAILABLE|RESOURCE_EXHAUSTED|429/.test(e)) return { title: 'Gemini が混雑していたため生成できませんでした', detail: e };
    if (/候補商品が足りません/.test(e)) return { title: '確認できた候補商品が足りませんでした', detail: e };
    return { title: '生成に失敗しました', detail: e };
  }
  if (p.needsReview) {
    const reasons = [...p.factIssues, ...p.issues];
    return { title: p.factIssues.length ? '事実確認に問題があるため承認できません' : 'ルールを満たせなかったため承認できません', detail: reasons.join(' / ') };
  }
  return null;
}

function problemCount(post) {
  return post.issues.length + post.factIssues.length * 2;
}

/**
 * 週全体の類似チェック。似すぎた組は後ろの投稿を書き直す(上限 WEEK_REWRITE_LIMIT 件)。
 * 書き直し案はルール・事実確認に通り、かつ他の投稿と似ていない場合だけ採用する。
 * 残った類似は各投稿の similarity に入れてプレビューに表示する(履歴の記録は止めない)。
 */
async function reviewWeek(apiKey, slotPosts, historyPhrases, results) {
  const usable = () => slotPosts.map(p => results.get(p.date)).filter(p => p && !p.failed);
  const before = findSimilarities(usable());
  const rewritten = [];
  const targets = [...before.keys()].slice(0, CONFIG.WEEK_REWRITE_LIMIT);
  for (const date of targets) {
    if (geminiBudgetLeft() <= 0) {
      log(`${date}: Gemini の呼び出しを節約するため、類似の書き直しはしません(注意として表示します)`);
      continue;
    }
    const post = results.get(date);
    const reasons = before.get(date);
    const others = usable().filter(p => p.date !== date);
    const avoid = {
      openings: [...historyPhrases.openings, ...others.map(p => p.opening)],
      closings: [...historyPhrases.closings, ...others.map(p => p.closing)]
    };
    const prompt = buildPostPrompt(date, post.product, post.anniversary, avoid, others);
    // 書き直しでも自然さを優先する(違いを出すための不自然な言い回しは使わない。採用されなければ元の投稿を残す)
    const rewriteRule = '見出しの言い回し・構成・切り口・終わり方を変えて書き直してください。ただし自然で読みやすい文章を優先し、違いを出すためだけの不自然な言い回しや文は使わないでください(事実は商品説明の範囲だけ)。';
    let feedback = `\n\nこの投稿は、同じ週のほかの投稿と次の点が似ています。${rewriteRule}\n- ${reasons.join('\n- ')}\n今の本文:\n${post.body}\n`;
    let adopted = null;
    for (let attempt = 1; attempt <= CONFIG.WEEK_REWRITE_ATTEMPTS && !adopted; attempt++) {
      let data;
      let model;
      try {
        ({ data, model } = await callGeminiJson(apiKey, prompt + feedback));
      } catch (e) {
        log(`${date} 類似の書き直しに失敗しました: ${e.message}`);
        break;
      }
      const candidate = evaluatePost(data, date, post.product, post.anniversary, avoid);
      const stillSimilar = findSimilarities([...others, { ...candidate, date, product: post.product }]).get(date) || [];
      if (candidate.ok && candidate.styleIssues.length === 0 && stillSimilar.length === 0) {
        adopted = Object.assign(candidate, {
          date, product: post.product, anniversary: post.anniversary, model, attempts: post.attempts,
          replaced: post.replaced, needsReview: post.needsReview && !candidate.ok, rewrittenFor: reasons
        });
      } else {
        const why = [...candidate.issues, ...candidate.factIssues, ...candidate.styleIssues, ...stillSimilar];
        feedback = `\n\nこの投稿は、同じ週のほかの投稿と似ているため書き直しています。${rewriteRule}\n書き直し案にはまだ次の問題があります:\n- ${why.join('\n- ')}\n書き直し案:\n${candidate.body}\n`;
        log(`${date} 類似の書き直し(${attempt}回目)を採用しませんでした: ${why.join(' / ')}`);
      }
    }
    if (adopted) {
      results.set(date, adopted);
      rewritten.push({ date, reasons });
      log(`${date} 似すぎていたため書き直しました: ${reasons.join(' / ')}`);
    }
  }
  const after = findSimilarities(usable());
  for (const p of usable()) p.similarity = after.get(p.date) || [];
  return { checked: before.size, rewritten, remaining: after.size, skipped: Math.max(0, before.size - CONFIG.WEEK_REWRITE_LIMIT) };
}

/**
 * 投稿どうしの似すぎを調べる。返り値は 日付 → 理由の配列(似ている組の後ろ側の投稿に付ける)。
 * - 見出し・最後の一文: 商品名などの固有の言葉を除いた言い回しが SIMILARITY_JACCARD 以上似ている
 * - 文末: 最後の一文の終わり4文字が同じ投稿が SAME_ENDING_LIMIT を超える
 * - 構成(段落数と各段落の文数)・切り口: 同じものがそれぞれの上限を超える
 */
function findSimilarities(posts) {
  const found = new Map();
  const add = (date, reason) => {
    if (!found.has(date)) found.set(date, []);
    if (!found.get(date).includes(reason)) found.get(date).push(reason);
  };
  const label = p => formatDateJa(p.date);
  for (let i = 0; i < posts.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = posts[j];
      const b = posts[i];
      if (jaccard(phraseTemplate(a.opening, a.product), phraseTemplate(b.opening, b.product)) >= CONFIG.SIMILARITY_JACCARD) {
        add(b.date, `見出しの言い回しが${label(a)}と似ている(「${a.opening}」/「${b.opening}」)`);
      }
      if (jaccard(phraseTemplate(a.lastSentence, a.product), phraseTemplate(b.lastSentence, b.product)) >= CONFIG.SIMILARITY_JACCARD) {
        add(b.date, `最後の一文が${label(a)}と似ている(「${a.lastSentence}」/「${b.lastSentence}」)`);
      }
    }
  }
  const overLimit = (key, limit, describe) => {
    const groups = new Map();
    for (const p of posts) {
      const k = key(p);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const [k, group] of groups) {
      if (group.length <= limit) continue;
      for (const p of group.slice(limit)) add(p.date, describe(k, group));
    }
  };
  overLimit(p => phraseKey(p.lastSentence).slice(-4), CONFIG.SAME_ENDING_LIMIT,
    (k, g) => `文末「…${k}」が${g.length}件で同じ(${g.map(label).join('、')})`);
  overLimit(p => p.signature, CONFIG.SAME_STRUCTURE_LIMIT,
    (k, g) => `構成(${k})が${g.length}件で同じ(${g.map(label).join('、')})`);
  overLimit(p => (p.focus && p.focus !== 'その他' ? p.focus : ''), CONFIG.SAME_FOCUS_LIMIT,
    (k, g) => `切り口「${k}」が${g.length}件で同じ(${g.map(label).join('、')})`);
  // 型になりやすい形(絵文字や「」を使う見出し)だけを数える。絵文字も「」もない素直な見出しは数えない
  // (言い回しの近さは上の見出しの比較で確かめる。自然な見出しを無理に絵文字・「」付きへ書き直させないため)
  overLimit(p => { const s = headlineShape(p.opening); return s === '絵文字なし・「」なし' ? '' : s; }, CONFIG.SAME_HEADLINE_SHAPE_LIMIT,
    (k, g) => `見出しの形(${k})が${g.length}件で同じ(${g.map(label).join('、')})`);
  overLimit(p => (startsWithEmoji(p.opening) ? '絵文字' : ''), CONFIG.MAX_EMOJI_HEADLINES,
    (k, g) => `絵文字で始まる見出しが${g.length}件(${CONFIG.MAX_EMOJI_HEADLINES}件まで)`);
  return found;
}

function startsWithEmoji(text) {
  return /^\s*\p{Extended_Pictographic}/u.test(String(text || ''));
}

/** 見出しの形: 絵文字で始まるか と 「」の位置(末尾・先頭・文中・なし) */
function headlineShape(text) {
  const s = String(text || '').replace(/^\s*[\p{Extended_Pictographic}️‍]+\s*/u, '').replace(/[。!！]+$/, '').trim();
  let quote = '「」なし';
  if (/^「[^」]+」/.test(s)) quote = '先頭が「」';
  else if (/「[^」]+」$/.test(s)) quote = '末尾が「」';
  else if (/「[^」]+」/.test(s)) quote = '文中に「」';
  return `${startsWithEmoji(text) ? '絵文字あり' : '絵文字なし'}・${quote}`;
}

/** 本文の形: 段落ごとの文の数(見出しは H)と、最後の一文 */
function bodyShape(body) {
  const paragraphs = String(body).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const sentencesOf = text => text.replace(/\n/g, '').split(/(?<=[。!?！？♪])/).map(s => s.trim()).filter(Boolean);
  const rest = paragraphs.slice(1);
  const signature = ['H', ...rest.map(p => sentencesOf(p).length)].join('-');
  const lastParagraph = paragraphs.at(-1) || '';
  const lastSentence = sentencesOf(lastParagraph).at(-1) || lastParagraph;
  return { signature, lastSentence };
}

/** 比較用の言い回し: 商品名・タグなどの固有の言葉と「」の中身を除き、記号・空白も除く */
function phraseTemplate(text, product) {
  let s = String(text || '').normalize('NFKC').replace(/「[^」]*」/g, '');
  const words = [product?.title, product?.vendor, product?.productType, ...(product?.tags || [])]
    .flatMap(w => String(w || '').normalize('NFKC').split(/[\s【】\[\]()（）「」・/,、]+/))
    .filter(w => w.length >= 2)
    .sort((x, y) => y.length - x.length);
  for (const w of words) s = s.split(w).join('');
  return phraseKey(s);
}

/** 文字の2-gram の重なり(0〜1)。短すぎる文は比べない */
function jaccard(a, b) {
  if (a.length < 4 || b.length < 4) return 0;
  const grams = s => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const x = grams(a);
  const y = grams(b);
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

function buildPostPrompt(date, product, anniversary, avoid, weekPosts = []) {
  const examples = loadStyleExamples();
  return `
あなたは「ふくしま市場」(福島県産品のオンラインストア)のSNS担当者です。
${formatDateJa(date)}に投稿するFacebook投稿の本文を、担当者が自分の言葉でこの商品を紹介するように書いてください。

雰囲気の参考(短く自然で読みやすい文章の例。構成・言い回し・締め方はまねしない):
<<<
${STYLE_REFERENCE}
>>>

書き方:
- まず商品説明を読み、この商品でいちばん伝えたい点を1〜2つに絞る。切り口は ${CONFIG.FOCUS_TYPES.join('・')} から、商品説明に書かれているものを選ぶ
- 構成は商品に合わせて決める。毎回「見出し→産地→特徴→締め」の順にしない
  (例: 食べ方から書き始める/製法の話を中心にする/特徴を1つだけ深く書く/背景を短く添えて特徴で終える)
- 締めの一文は必須ではない。魅力が伝わっていれば、特徴の説明で終えてよい。
  締める場合は、商品説明に根拠のある具体的な食べ方・使い道で締める
- 次のような定型表現に頼らない: ${CONFIG.STOCK_PHRASES.join('、')}
- 見出しは1行で、この商品ならではの言葉にする。「〜のご紹介」「〜が入荷しました」「〇〇の魅力」のような型にしない
- 見出しの形は商品に合わせて選ぶ。毎回「絵文字+特徴+「商品名」」にしない
  (例: 商品名から始める/特徴や味わいから始める/食べ方・使い道を伝える/産地や作り手から入る/「」を使わない)
  形を変えるために不自然な言い回しにはしない。読みやすさを優先する
- 絵文字は必須ではない。使う場合は商品そのものや原材料に合うものだけ(例: 柿に🍊、お米に🍜は使わない)。合うものがなければ使わない
- 商品説明の文をそのまま写さず、短く読みやすい言葉に言い換える(意味は変えない)
- 商品説明にない味・食感・香り・食べ方・使い道・産地・製法・生産者・数量・受賞歴・季節限定などは書かない(創作しない)
- 文字数を稼ぐための文は足さない。伝えることが少なければ短くてよい

改行のしかた:
- 見出しのあとに空行を1つ入れる
- 本文は1〜3段落。段落の間にだけ空行を1つ入れ、1文ごとに空行で区切らない。同じ段落の文は改行せずに続ける
- 空行を2つ以上続けない。行頭・行末に空白を入れない
${weekPosts.length ? `
この週のほかの投稿(見出しの言い回し・構成・切り口・終わり方が似ないようにする):
${weekPosts.map(w => `- 見出し「${w.opening}」(形: ${w.headlineShape || headlineShape(w.opening)})/ 最後の一文「${w.lastSentence}」/ 構成 ${w.signature} / 切り口 ${w.focus || '-'}`).join('\n')}
(この週の見出し: 絵文字で始まるもの ${weekPosts.filter(w => startsWithEmoji(w.opening)).length}件、「」で商品名などを囲むもの ${weekPosts.filter(w => /「[^」]+」/.test(w.opening)).length}件。多い形は避ける)
` : ''}${examples.length ? `\n公式Xの投稿例(雰囲気の参考。文章をそのまま流用しない):\n${examples.map(e => `---\n${e}`).join('\n')}\n---\n` : ''}
商品情報(事実はここに書かれていることだけを使う):
商品ID: ${product.id}
商品名: ${product.title}
販売者: ${product.vendor || '(なし)'}
種別: ${product.productType || '(なし)'}
タグ: ${product.tags.join('、') || '(なし)'}
商品説明:
<<<
${product.description.slice(0, 2500)}
>>>

${anniversary
    ? `この日の記念日: ${anniversary.name}
記念日の説明(雑学ネタ帳より):
${anniversary.description}
商品と自然につながる場合だけ、導入で短く触れてよい。記念日の事実は上の説明だけを根拠にする。
つながりが弱いと感じたら使わずに通常の商品紹介にし、anniversary_used を false にする。`
    : 'この日は記念日を使わず、通常の商品紹介にする(anniversary_used は false)。'}

ルール:
- 本文(見出しを含む)は改行・空白を除いて${CONFIG.BODY_MIN_CHARS}〜${CONFIG.BODY_MAX_CHARS}文字が目安。自然さを優先し、情報が少なければ無理に増やさない。${CONFIG.BODY_MAX_CHARS}文字は超えない
- 商品名・産地・製法・生産者・数量・特徴などの事実は、上の商品情報に書かれていることだけを使う。書かれていないことを推測で足さない
- 絵文字は0〜${CONFIG.MAX_EMOJI}個
- 誇張表現や不自然な宣伝文句(${CONFIG.NG_PHRASES.slice(0, 8).join('、')} など)は使わない
- 「▼詳細はこちら」、URL、ハッシュタグは本文に入れない(後から自動で付ける)
${avoid.openings.length ? `- 次の書き出しと似た1行目にしない:\n${avoid.openings.map(o => `  ・${o}`).join('\n')}` : ''}
${avoid.closings.length ? `- 次の締めくくりと似た最後の一言にしない:\n${avoid.closings.map(o => `  ・${o}`).join('\n')}` : ''}
- hashtags には ${CONFIG.FIXED_HASHTAGS.join(' ')} 以外のハッシュタグをちょうど${CONFIG.EXTRA_HASHTAGS}個入れる。
  商品名・産地・特徴・季節性などを考えて、この商品に関連の深い自然な言葉を選ぶ(「#米」のような広い言葉でも、商品に関連していればよい)。
  言葉は商品情報に書かれているものを使う
- claims には本文に書いた事実(特徴・産地・製法・数量・生産者など)を1つずつ挙げ、evidence に根拠となる商品情報の文を一字一句そのまま引用する

出力は次のJSON形式のみ。前後に説明文やコードブロック記号は一切つけないこと。
{"body": "本文", "hashtags": ["#...", "#..."], "focus": "選んだ切り口(${CONFIG.FOCUS_TYPES.join(' / ')} のどれか)", "anniversary_used": true または false, "anniversary_reason": "記念日を使った/使わなかった理由を一言", "claims": [{"text": "本文中の記述", "evidence": "商品情報からのそのままの引用"}]}
`;
}

/**
 * Gemini の出力を検査する。
 * issues: 作り直しが必要なルール違反 / factIssues: 根拠が確認できない記述 /
 * styleIssues: 定型表現・言い回しの重複(作り直させるが、直らなければ注意として残す) / notes: 参考の注意(作り直さない)
 */
function evaluatePost(data, date, product, anniversary, avoid) {
  const body = cleanBody(data.body);
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const opening = lines[0] || '';
  const shape = bodyShape(body);
  const closing = shape.lastSentence;
  const focus = CONFIG.FOCUS_TYPES.includes(String(data.focus)) ? String(data.focus) : 'その他';
  const bodyChars = countBodyChars(body);
  const emojiCount = countEmoji(body);
  const extraTags = (Array.isArray(data.hashtags) ? data.hashtags : [])
    .map(t => String(t).trim()).filter(Boolean)
    .map(t => (t.startsWith('#') || t.startsWith('＃') ? '#' + t.slice(1) : '#' + t));
  const hashtags = [...CONFIG.FIXED_HASHTAGS, ...extraTags];
  const issues = [];
  const factIssues = [];
  const styleIssues = []; // 定型表現・書き出し/締めの重複。作り直させるが、直らなくても商品は差し替えない
  const notes = [];

  if (!body) issues.push('本文が空です');
  if (bodyChars > CONFIG.BODY_MAX_CHARS) issues.push(`本文が${bodyChars}文字です(${CONFIG.BODY_MAX_CHARS}文字以内)`);
  if (body && bodyChars < CONFIG.BODY_MIN_CHARS) notes.push(`本文が${bodyChars}文字で目安(${CONFIG.BODY_MIN_CHARS}文字)より短め(魅力が伝わっていれば問題なし)`);
  if (emojiCount > CONFIG.MAX_EMOJI) issues.push(`絵文字が${emojiCount}個です(${CONFIG.MAX_EMOJI}個まで)`);
  const ng = CONFIG.NG_PHRASES.filter(p => body.includes(p));
  if (ng.length) issues.push(`誇張・宣伝的な表現: ${ng.join('、')}`);
  const stock = CONFIG.STOCK_PHRASES.filter(p => body.includes(p));
  if (stock.length) styleIssues.push(`定型表現: ${stock.join('、')}(商品ならではの言葉にするか、締めの一文をなくす)`);

  // ハッシュタグ: 固定2個+商品情報にある言葉2個
  const sourceNorm = norm(productSourceText(product));
  if (extraTags.length !== CONFIG.EXTRA_HASHTAGS) {
    issues.push(`追加のハッシュタグが${extraTags.length}個です(${CONFIG.EXTRA_HASHTAGS}個)`);
  }
  for (const tag of extraTags) {
    const word = tag.slice(1);
    if (!/^#[^\s#]+$/.test(tag)) issues.push(`ハッシュタグの形式が不正: ${tag}`);
    else if (CONFIG.FIXED_HASHTAGS.includes(tag)) issues.push(`固定のハッシュタグと重複: ${tag}`);
    // 句読点・記号の違いは無視して照合する(例: #福笑い と 商品名の「福､笑い」)
    else if (!phraseKey(productSourceText(product)).toLowerCase().includes(phraseKey(word).toLowerCase())) {
      issues.push(`商品情報にない言葉のハッシュタグ: ${tag}`);
    }
  }
  if (new Set(hashtags).size !== hashtags.length) issues.push('ハッシュタグが重複しています');

  // 事実確認: 引用が商品情報に含まれるか、本文の数字が商品情報(と記念日の説明・日付)にあるか
  const claims = (Array.isArray(data.claims) ? data.claims : []).map(c => {
    const evidence = String(c?.evidence || '');
    return { text: String(c?.text || ''), evidence, found: Boolean(evidence) && sourceNorm.includes(norm(evidence)) };
  });
  if (claims.length === 0) factIssues.push('根拠の引用(claims)がありません');
  for (const c of claims.filter(c => !c.found)) {
    factIssues.push(`根拠が商品情報に見つかりません: 「${c.text || c.evidence}」`);
  }
  const [, mm, dd] = date.split('-').map(Number);
  // 単位つきの数字(3年・5kg など)は「数字+単位」で照合する(承認管理の修正チェックと同じ)
  const numberSource = [productSourceText(product), anniversary?.name || '', anniversary?.description || '', `${mm}月${dd}日`].join('\n');
  for (const n of unsupportedNumbers(body, numberSource)) factIssues.push(`商品情報にない数字が本文にあります: ${n}`);

  // 記念日
  const anniversaryUsed = Boolean(anniversary) && String(data.anniversary_used) === 'true';
  if (String(data.anniversary_used) === 'true' && !anniversary) issues.push('記念日を使わない日に記念日が使われています');

  // 書き出し・締めくくりの重複
  if (avoid.openings.some(o => similarStart(o, opening))) styleIssues.push(`書き出しが他の投稿と似ています: ${opening}`);
  if (avoid.closings.some(c => similarEnd(c, closing))) styleIssues.push(`締めくくりが他の投稿と似ています: ${closing}`);

  // コピー用の投稿文そのもの(プレビューの表示もこの文字列から作る)
  const message = normalizeMessage(`${body}\n\n▼詳細はこちら\n${product.url}\n\n${hashtags.join(' ')}`);
  return {
    ok: issues.length === 0 && factIssues.length === 0,
    body, message, hashtags, opening, closing, bodyChars, emojiCount, claims, focus,
    lastSentence: shape.lastSentence, signature: shape.signature, headlineShape: headlineShape(opening),
    anniversaryUsed, anniversaryReason: String(data.anniversary_reason || ''),
    issues, factIssues, styleIssues, notes
  };
}

/** Gemini の呼び出し状況(プレビューと実行結果に表示する。APIキーなどの秘密は含めない) */
const geminiUsage = { calls: 0, byModel: {}, rateLimits: [], dailyExhausted: [] };
const geminiLastCallAt = new Map();

/** この実行であと何回 Gemini を呼べるか(1日の上限を使い切らないための、実行ごとの上限) */
function geminiBudgetLeft() {
  return CONFIG.GEMINI_CALL_BUDGET - geminiUsage.calls;
}

function countGemini(model, key) {
  geminiUsage.byModel[model] ??= { calls: 0, ok: 0, rateLimited: 0, unavailable: 0, timeout: 0, networkError: 0, badOutput: 0 };
  geminiUsage.byModel[model][key]++;
}

/**
 * 429 の詳細(どの上限か・待つべき秒数)を取り出す。
 * Gemini API は QuotaFailure(quotaId 例: GenerateRequestsPerMinutePerProjectPerModel-FreeTier)と
 * RetryInfo(retryDelay 例: "13s")を返すことがある。
 */
function rateLimitInfo(error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  const violations = details.find(d => String(d?.['@type'] || '').includes('QuotaFailure'))?.violations || [];
  const quotas = violations.map(v => ({ id: String(v.quotaId || v.quotaMetric || ''), value: v.quotaValue ?? '' })).filter(q => q.id);
  const delay = String(details.find(d => String(d?.['@type'] || '').includes('RetryInfo'))?.retryDelay || '');
  const seconds = /^(\d+(?:\.\d+)?)s$/.test(delay) ? Number(delay.slice(0, -1)) : null;
  const daily = quotas.some(q => /PerDay|per_day|PerProjectPerDay/i.test(q.id));
  return { quotas, retryAfterMs: seconds === null ? null : Math.ceil(seconds * 1000), daily };
}

/**
 * GEMINI_MODELS を先頭から試す。混雑(503など)・上限(429)・通信エラー・時間切れ・出力の崩れのときは次のモデルへ。
 * - 同じモデルへの呼び出しは GEMINI_MIN_INTERVAL_MS 以上あける(1分あたりの上限に当たりにくくする)
 * - 429 で「1日の上限」と分かったモデルは、この実行では使わない
 * - 429 で待つべき秒数(retryDelay)が示され、GEMINI_MAX_RETRY_DELAY_MS 以内なら、待って同じモデルで1回だけやり直す
 * - すべてのモデルで駄目なら GEMINI_RETRY_WAITS_MS だけ待って最初からやり直す(全モデルが1日の上限ならすぐ止める)
 * APIキーの誤りなど一時的でないエラーはすぐに止める。APIキーはヘッダーでのみ送り、ログには出さない。
 * 投げるエラーには transient(一時的な障害か)を付ける。
 */
async function callGeminiJson(apiKey, prompt) {
  const waits = [0, ...CONFIG.GEMINI_RETRY_WAITS_MS];
  let last = '';
  for (let round = 0; round < waits.length; round++) {
    const usable = CONFIG.GEMINI_MODELS.filter(m => !geminiUsage.dailyExhausted.includes(m));
    if (usable.length === 0) break;
    if (waits[round] > 0) {
      log(`Gemini が混雑・通信エラー・上限のため ${Math.round(waits[round] / 1000)} 秒待って再試行します(${round}/${waits.length - 1})`);
      await sleep(waits[round]);
    }
    for (const model of usable) {
      for (let sameModelTry = 0; sameModelTry < 2; sameModelTry++) {
        if (geminiUsage.dailyExhausted.includes(model)) break;
        if (geminiBudgetLeft() <= 0) {
          throw Object.assign(new Error(`この実行の Gemini 呼び出し上限(${CONFIG.GEMINI_CALL_BUDGET}回)に達しました`), { transient: true, budget: true });
        }
        const readyAt = (geminiLastCallAt.get(model) || 0) + CONFIG.GEMINI_MIN_INTERVAL_MS;
        while (Date.now() < readyAt) await sleep(readyAt - Date.now());
        geminiLastCallAt.set(model, Date.now());
        geminiUsage.calls++;
        countGemini(model, 'calls');
        let json;
        // 応答待ちが長引いたら打ち切る(本文の受信まで含めて GEMINI_TIMEOUT_MS)
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), CONFIG.GEMINI_TIMEOUT_MS);
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 1.0 }
            }),
            signal: controller.signal
          });
          json = await res.json();
        } catch (e) {
          if (controller.signal.aborted) e = controller.signal.reason;
          const timedOut = e?.name === 'TimeoutError';
          countGemini(model, timedOut ? 'timeout' : 'networkError');
          last = timedOut
            ? `(${model}) ${Math.round(CONFIG.GEMINI_TIMEOUT_MS / 1000)}秒以内に応答がありませんでした`
            : `(${model}) 通信エラー: ${e?.message || e}`;
          log(`Gemini ${last} → 次のモデルを試します`);
          break;
        } finally {
          clearTimeout(timer);
        }
        if (json.error) {
          last = `(${model}) ${json.error.code} ${json.error.status}: ${json.error.message}`;
          const transient = ['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED', 'INTERNAL'].includes(json.error.status)
            || [429, 500, 503, 504].includes(json.error.code);
          if (!transient) throw Object.assign(new Error(last), { transient: false });
          if (json.error.code === 429 || json.error.status === 'RESOURCE_EXHAUSTED') {
            countGemini(model, 'rateLimited');
            const info = rateLimitInfo(json.error);
            geminiUsage.rateLimits.push({ model, at: new Date().toISOString(), quotas: info.quotas, retryAfterMs: info.retryAfterMs });
            const which = info.quotas.length ? info.quotas.map(q => `${q.id}${q.value !== '' ? `=${q.value}` : ''}`).join(', ') : '上限の種類は不明';
            if (info.daily) {
              geminiUsage.dailyExhausted.push(model);
              log(`Gemini ${model} が1日の上限に達しました(${which})。この実行では使いません`);
              break;
            }
            if (sameModelTry === 0 && info.retryAfterMs !== null && info.retryAfterMs <= CONFIG.GEMINI_MAX_RETRY_DELAY_MS) {
              log(`Gemini ${model} が上限(429: ${which})のため、指示どおり ${Math.ceil(info.retryAfterMs / 1000)} 秒待って同じモデルでやり直します`);
              await sleep(info.retryAfterMs + 1000);
              continue;
            }
            log(`Gemini ${model} が上限(429: ${which})のため次のモデルを試します`);
            break;
          }
          countGemini(model, 'unavailable');
          log(`Gemini ${model} が一時的に使えないため次のモデルを試します: ${json.error.code} ${json.error.status}`);
          break;
        }
        const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = rawText.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
        try {
          const data = JSON.parse(cleaned);
          countGemini(model, 'ok');
          return { data, model };
        } catch {
          countGemini(model, 'badOutput');
          last = `(${model}) 出力をJSONとして解析できませんでした: ${rawText.slice(0, 120)}`;
          log(`Gemini ${last} → 次のモデルを試します`);
          break;
        }
      }
    }
  }
  if (CONFIG.GEMINI_MODELS.every(m => geminiUsage.dailyExhausted.includes(m))) {
    throw Object.assign(new Error(`すべての Gemini モデルが1日の上限に達しました(太平洋時間の0時=日本時間17時ごろにリセット)。最後: ${last}`), { transient: true, dailyQuota: true });
  }
  throw Object.assign(new Error(`混雑・通信エラー・上限が続いたため生成できませんでした(${waits.length}巡試行。最後: ${last})`), { transient: true });
}

/** 本文に紛れ込んだ URL・ハッシュタグ・「▼詳細はこちら」を取り除く(後でコード側が付ける)。 */
function cleanBody(body) {
  return String(body || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/▼?\s*詳細はこちら/g, '')
    .replace(/(^|\s)[#＃][^\s#＃]+/g, '$1')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 改行を \n にそろえ、行末の空白と、2つ以上続く空行・前後の空行を取り除く */
function normalizeMessage(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(/[ \t　]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countBodyChars(body) {
  return [...body.replace(/\s/g, '')].length;
}

function countEmoji(text) {
  return (text.match(/\p{Extended_Pictographic}/gu) || []).length;
}

/** 比較用: 絵文字・記号・空白を除く */
function phraseKey(s) {
  return String(s || '').normalize('NFKC').replace(/[\p{Extended_Pictographic}\p{P}\p{S}\s]/gu, '');
}

function similarStart(a, b) {
  const x = phraseKey(a);
  const y = phraseKey(b);
  return Boolean(x && y) && (x === y || (x.length >= 8 && y.length >= 8 && x.slice(0, 8) === y.slice(0, 8)));
}

function similarEnd(a, b) {
  const x = phraseKey(a);
  const y = phraseKey(b);
  return Boolean(x && y) && (x === y || (x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8)));
}

function loadStyleExamples() {
  if (!existsSync(CONFIG.STYLE_EXAMPLES_FILE)) return [];
  return readFileSync(CONFIG.STYLE_EXAMPLES_FILE, 'utf8')
    .split(/^---\s*$/m)
    .map(s => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 履歴(候補 / 承認済み / 公開済み)
// ---------------------------------------------------------------------------

function loadHistory() {
  if (!existsSync(CONFIG.HISTORY_FILE)) return { version: 2, entries: [] };
  const data = JSON.parse(readFileSync(CONFIG.HISTORY_FILE, 'utf8'));
  if (!data || !Array.isArray(data.entries)) {
    // 壊れた履歴を上書きして消さないよう、ここで止める
    throw new Error(`${CONFIG.HISTORY_FILE} の形式が不正です({"version":2,"entries":[...]} の形にしてください)。`);
  }
  for (const e of data.entries) {
    if (!CONFIG.HISTORY_STATUSES.includes(e.status)) {
      throw new Error(`${CONFIG.HISTORY_FILE} に不明な状態があります: ${e.status}(${CONFIG.HISTORY_STATUSES.join(' / ')})`);
    }
    // テストの記録が実データの履歴に紛れ込んでいたら、使わずに止める
    if (!IS_MOCK && e.dataSource === 'mock') {
      throw new Error(`${CONFIG.HISTORY_FILE} にテスト用データの記録(商品ID ${e.productId})が含まれているため中止しました。`);
    }
  }
  return data;
}

function saveHistory(history) {
  mkdirSync(dirname(resolve(CONFIG.HISTORY_FILE)), { recursive: true });
  writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
}

/**
 * 投稿予定日の前後 REUSE_BLOCK_DAYS 日に選ばれている商品ID。
 * - 作り直す週(と同じ日付)の「候補」は置き換えるので含めない
 * - 「不採用」は、その週の作り直しでだけ選ばない(翌週以降は候補に戻す)
 */
function blockedProductIds(history, weekStart, dates) {
  const from = addDays(dates[0], -CONFIG.REUSE_BLOCK_DAYS);
  const to = addDays(dates.at(-1), CONFIG.REUSE_BLOCK_DAYS);
  return new Set(history.entries
    .filter(e => !isReplacedCandidate(e, weekStart, dates))
    .filter(e => e.status !== 'rejected' || e.week === weekStart)
    .filter(e => e.postDate >= from && e.postDate <= to)
    .map(e => String(e.productId)));
}

function isReplacedCandidate(e, weekStart, dates) {
  return e.status === 'candidate' && (e.week === weekStart || dates.includes(e.postDate));
}

/**
 * 同じ週の候補を入れ替える。生成に成功した投稿だけを「候補」として記録する。
 * 1件も成功しなかったとき(Gemini の障害など)は、前回の候補を残すため履歴を変更しない(null を返す)。
 */
function updateHistory(history, weekStart, dates, posts) {
  const succeeded = posts.filter(p => p && !p.locked && !p.failed && p.ok);
  if (succeeded.length === 0) return null;
  const now = new Date().toISOString();
  history.entries = history.entries.filter(e => !isReplacedCandidate(e, weekStart, dates));
  let recorded = 0;
  for (const p of succeeded) {
    const source = {
      title: p.product.title, vendor: p.product.vendor, productType: p.product.productType,
      tags: p.product.tags, description: p.product.description
    };
    const entry = {
      productId: p.product.id,
      handle: p.product.handle,
      title: p.product.title,
      postDate: p.date,
      week: weekStart,
      status: 'candidate',
      dataSource: CONFIG.DATA_SOURCE,
      genre: p.product.genre,
      factCheck: 'passed', // 事実確認に通った投稿だけを記録する(承認できるのはこの記録だけ)
      opening: p.opening,
      closing: p.closing,
      generatedAt: now,
      // 承認管理(承認・修正・不採用)で使う。修正の事実確認は source と照合する
      message: p.message,
      originalHash: hashOf(p.message),
      url: p.product.url,
      images: p.product.images,
      source,
      sourceHash: hashOf(source)
    };
    history.entries.push(entry);
    p.reviewRecord = reviewRecordFromEntry(entry);
    recorded++;
  }
  history.entries.sort((a, b) => a.postDate.localeCompare(b.postDate) || String(a.productId).localeCompare(String(b.productId)));
  return recorded;
}

/** 直近の書き出し・締めくくり。作り直す週の候補は置き換えるので含めない。 */
function recentPhrases(history, weekStart, dates) {
  const recent = history.entries
    .filter(e => !isReplacedCandidate(e, weekStart, dates))
    .sort((a, b) => String(a.generatedAt || '').localeCompare(String(b.generatedAt || '')))
    .slice(-CONFIG.RECENT_PHRASES_COUNT);
  return {
    openings: recent.map(e => e.opening).filter(Boolean),
    closings: recent.map(e => e.closing).filter(Boolean)
  };
}

// ---------------------------------------------------------------------------
// HTML プレビュー
// ---------------------------------------------------------------------------

function slotTitle(p) {
  if (p.locked) return p.entry.title;
  if (p.failed) return p.product ? `(失敗)${p.product.title}` : '(失敗)';
  return p.product.title;
}

function slotAnniversary(p) {
  if (p.locked || p.failed) return '-';
  if (p.anniversaryUsed) return p.anniversary.name;
  return p.anniversary ? `不使用(${p.anniversary.name})` : 'なし';
}

function slotStatus(p) {
  if (p.locked) return `${STATUS_LABELS[p.entry.status]}(作り直さない)`;
  if (p.failed) return '失敗(履歴に記録しない)';
  if (p.needsReview) return '承認不可(履歴に記録しない)';
  return '候補として記録';
}

/** 承認できる投稿(承認済み・公開済みを含む)の数と、エラー・承認不可の日の一覧 */
function completeness(posts) {
  const problems = posts.filter(p => !p.locked && (p.failed || p.needsReview)).map(p => ({ date: p.date, product: p.product?.title || '', ...describeProblem(p) }));
  return { total: posts.length, ready: posts.length - problems.length, problems };
}

function renderWeeklyHtml({ weekStart, dates, posts, stats, anniversaries, assignmentNote, recorded, weekReview }) {
  // 承認管理: 今回「候補」として記録した投稿だけを判断の対象にする(履歴を変えなかった実行では表示しない)
  const records = posts.map(p => p.reviewRecord).filter(Boolean);
  const review = records.length
    ? reviewAssets({ week: weekStart, dataSource: CONFIG.DATA_SOURCE, pageId: `preview-${records[0].generatedAt}`, records })
    : null;
  const reviewRows = posts.filter(p => !p.locked && !p.failed).map(p => `
      <tr>
        <td><a href="#d-${p.date}">${esc(formatDateJa(p.date))}</a></td>
        <td>${esc(p.opening)}</td>
        <td>${esc(p.lastSentence)}</td>
        <td style="white-space:nowrap">${esc(p.signature)}</td>
        <td>${esc(headlineShape(p.opening))}</td>
        <td>${esc(p.focus)}</td>
        <td class="${p.similarity?.length ? 'ng' : 'ok'}">${p.similarity?.length ? `⚠ ${p.similarity.map(esc).join('<br>⚠ ')}` : '✓'}${p.rewrittenFor ? '<br><span class="meta">似すぎていたため書き直し済み</span>' : ''}</td>
      </tr>`).join('');
  const generatedAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const done = completeness(posts);
  const genreDeferred = stats.genreDeferred || [];
  const genreRelaxed = stats.genreRelaxed || [];
  const rows = posts.map(p => `
      <tr>
        <td><a href="#d-${p.date}">${esc(formatDateJa(p.date))}</a></td>
        <td>${esc(slotTitle(p))}</td>
        <td>${esc(p.product?.genre || p.entry?.genre || '-')}</td>
        <td>${esc(slotAnniversary(p))}</td>
        <td class="${p.failed || p.needsReview ? 'ng' : 'ok'}">${esc(slotStatus(p))}</td>
      </tr>`).join('');
  const excludedRows = Object.entries({
    soldOut: '売り切れ', noImage: '画像なし', shortDescription: `説明文が${CONFIG.MIN_DESCRIPTION_CHARS}文字未満`,
    recentlyUsed: `前後${CONFIG.REUSE_BLOCK_DAYS}日以内に選定済み`
  }).map(([k, label]) => `<li>${esc(label)}: ${stats.excluded[k].length}件${stats.excluded[k].length ? `<span class="meta">(${esc(stats.excluded[k].slice(0, 10).join('、'))}${stats.excluded[k].length > 10 ? ' ほか' : ''})</span>` : ''}</li>`).join('');
  const sourceErrors = Object.entries(stats.errors).filter(([, e]) => e)
    .map(([k, e]) => `<li class="ng">${esc(SOURCE_LABELS[k])}の取得に失敗: ${esc(e)}</li>`).join('');
  const verifyFailures = (stats.verifyFailures || []).map(f => `<li>${esc(f.title)}<span class="meta">(${esc(f.checks.filter(c => !c.ok).map(c => `${c.label}: ${c.detail}`).join(' / '))})</span></li>`).join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${IS_MOCK ? `【${MOCK_LABEL}】` : ''}${done.problems.length ? '【未完成】' : ''}週次投稿案プレビュー</title>
<style>
  :root { --bg:#f0f2f5; --card:#fff; --text:#050505; --sub:#65676b; --line:#ced0d4; --soft:#f0f2f5; --warn:#fff4e5; --warn-line:#f0b45a; --ok:#2e7d32; --ng:#c62828; --accent:#1877f2; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#18191a; --card:#242526; --text:#e4e6eb; --sub:#b0b3b8; --line:#3e4042; --soft:#3a3b3c; --warn:#3a2d17; --warn-line:#a87b2f; --ok:#81c784; --ng:#ef9a9a; --accent:#4599ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif; line-height:1.5; }
  main { max-width:760px; margin:0 auto; padding:16px; }
  a { color:var(--accent); }
  h1 { font-size:20px; margin:8px 0 4px; }
  h2 { font-size:17px; margin:0; }
  h3 { font-size:14px; margin:16px 0 6px; color:var(--sub); }
  .meta { color:var(--sub); font-size:13px; }
  .notice { background:var(--warn); border:1px solid var(--warn-line); border-radius:8px; padding:10px 12px; font-size:14px; margin:12px 0 16px; }
  .panel { background:var(--card); border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,.2); padding:12px 16px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  th { color:var(--sub); font-weight:500; }
  .kv th { width:32%; }
  .ok { color:var(--ok); } .ng { color:var(--ng); font-weight:600; }
  .badges { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0 10px; }
  .badge { font-size:12px; padding:2px 8px; border-radius:999px; background:var(--soft); color:var(--sub); }
  .badge.ng { background:transparent; border:1px solid var(--ng); }
  .post { border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .post .head { display:flex; gap:8px; align-items:center; padding:10px 12px 0; }
  .avatar { width:36px; height:36px; border-radius:50%; background:#1877f2; color:#fff; display:grid; place-items:center; font-weight:700; }
  .message { padding:10px 12px 12px; font-size:15px; line-height:1.6; overflow-wrap:anywhere; }
  .message p { margin:0 0 .7em; }
  .message p:last-child { margin-bottom:0; }
  .copy-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:10px 0 4px; }
  .copy-btn { font:inherit; font-size:14px; font-weight:600; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  .copy-btn:hover { filter:brightness(1.08); }
  .copy-btn:focus-visible { outline:3px solid var(--warn-line); outline-offset:2px; }
  .copy-btn.warn { background:transparent; color:var(--ng); border-color:var(--ng); }
  .warn { color:#a15c00; }
  ${review ? review.css : ''}
  .photos { display:grid; gap:2px; }
  .photos.n2 { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  .photos img { display:block; width:100%; min-width:0; aspect-ratio:1/1; object-fit:cover; background:var(--line); }
  .photos.n1 img { aspect-ratio:auto; max-height:480px; }
  ul.issues { margin:6px 0; padding-left:20px; font-size:13px; }
  details { margin-top:8px; font-size:13px; }
  details pre { white-space:pre-wrap; background:var(--soft); padding:8px; border-radius:6px; overflow-wrap:anywhere; font-family:inherit; }
  .mock-banner { position:sticky; top:0; z-index:10; background:#c62828; color:#fff; text-align:center; font-size:28px; font-weight:800; letter-spacing:.05em; padding:14px 12px; border-radius:0 0 8px 8px; box-shadow:0 2px 6px rgba(0,0,0,.3); }
  .mock-banner small { display:block; font-size:13px; font-weight:500; letter-spacing:0; }
  .mock-card { background:#c62828; color:#fff; font-size:18px; font-weight:800; text-align:center; padding:6px; border-radius:6px; margin:8px 0; }
  .post.mock { outline:4px dashed #c62828; outline-offset:-4px; }
  .incomplete { background:var(--card); border:3px solid var(--ng); border-radius:8px; padding:12px 16px; margin:0 0 16px; }
  .incomplete h2 { color:var(--ng); font-size:20px; }
  .incomplete li b { color:var(--ng); }
  .copy-btn:disabled { background:transparent; color:var(--sub); border-color:var(--line); cursor:not-allowed; filter:none; }
  @media (max-width: 480px) { main { padding:12px 16px; } .kv th { width:40%; } .mock-banner { font-size:22px; } }
</style>
</head>
<body>
${IS_MOCK ? `<div class="mock-banner">⚠ ${MOCK_LABEL}<small>テスト用モックで作成したプレビューです。商品・URL・画像・文章はすべて架空で、実際の商品ではありません。</small></div>` : ''}
<main>
  <h1>週次投稿案プレビュー</h1>
  <div class="meta">${esc(formatDateJa(dates[0]))} 〜 ${esc(formatDateJa(dates.at(-1)))} / 作成 ${esc(generatedAt)} / データ: ${IS_MOCK ? '<b class="ng">テスト用モック</b>' : `実データ(${esc(CONFIG.SHOP_BASE_URL)})`}</div>
  <div class="notice">これはローカルのプレビューです。Facebookには何も送信していません(公開・未公開・予約投稿のいずれも行っていません)。</div>
${done.problems.length ? `
  <section class="incomplete" id="incomplete">
    <h2>⚠ 未完成: ${done.total}件中 ${done.ready}件のみ承認可能</h2>
    <p class="meta">次の日は投稿案ができていないか、承認できない状態です。作り直してから確認してください。</p>
    <ul class="issues">
      ${done.problems.map(x => `<li><a href="#d-${x.date}">${esc(formatDateJa(x.date))}</a> <b>${esc(x.title)}</b>${x.product ? `(${esc(x.product)})` : ''}<br><span class="meta">${esc(x.detail)}</span></li>`).join('')}
    </ul>
  </section>` : ''}
  <section class="panel">
    <h2>7日分の一覧</h2>
    <table>
      <tr><th>投稿日</th><th>商品</th><th>ジャンル</th><th>記念日</th><th>状態</th></tr>${rows}
    </table>
    <p class="meta">${recorded === null
      ? '<span class="ng">生成に成功した投稿がないため、候補履歴は変更していません</span>'
      : `候補履歴に記録: ${recorded}件(${esc(CONFIG.HISTORY_FILE)}、週 ${esc(weekStart)})`}${assignmentNote ? `<br><span class="ng">${esc(assignmentNote)}</span>` : ''}</p>
  </section>
${review ? reviewBar() : ''}
  <section class="panel">
    <h2>週全体の類似チェック</h2>
    <p class="meta">見出し・最後の一文の言い回し(商品名を除く)、文末、構成(H=見出し、数字=各段落の文の数)、見出しの形(絵文字・「」の位置)、切り口を7件で比べています。
      似すぎ ${weekReview.checked}件 → 書き直し ${weekReview.rewritten.length}件 / 残り ${weekReview.remaining}件${weekReview.skipped ? `(上限を超えた${weekReview.skipped}件は書き直していません)` : ''}</p>
    <table>
      <tr><th>投稿日</th><th>見出し</th><th>最後の一文</th><th>構成</th><th>見出しの形</th><th>切り口</th><th>判定</th></tr>${reviewRows || '<tr><td colspan="7">対象なし</td></tr>'}
    </table>
  </section>

  ${renderGeminiUsage()}

  <section class="panel">
    <h2>商品情報の取得</h2>
    <ul class="issues">
      <li>人気ランキング ${stats.counts.ranking}件 / 新商品 ${stats.counts.new}件 / 全商品 ${stats.counts.all}件 → 候補 ${stats.eligible}件</li>
      ${sourceErrors}
    </ul>
    <h3>候補から外した商品</h3>
    <ul class="issues">${excludedRows}</ul>
    <h3>商品ページ・画像を確認できず使わなかった商品</h3>
    <ul class="issues">${verifyFailures || '<li>なし</li>'}</ul>
    <h3>ジャンルの偏りを避けるため後回しにした商品(同じジャンルは原則${CONFIG.MAX_PER_GENRE}件まで)</h3>
    <ul class="issues">${genreDeferred.length
      ? `<li>${genreDeferred.length}件<span class="meta">(${esc(genreDeferred.slice(0, 12).map(g => `${g.title}[${g.genre}]`).join('、'))}${genreDeferred.length > 12 ? ' ほか' : ''})</span></li>`
      : '<li>なし</li>'}${genreRelaxed.map(g => `<li class="ng">候補が足りないため上限を超えて使用: ${esc(g.title)}[${esc(g.genre)}]</li>`).join('')}</ul>
  </section>

  ${posts.map(p => renderSlot(p, anniversaries[p.date])).join('\n')}
</main>
<script>${COPY_SCRIPT}</script>
${review ? review.data + review.script : ''}
</body>
</html>
`;
}

function renderSlot(p, day) {
  const heading = `<h2>${esc(formatDateJa(p.date))}</h2>${IS_MOCK ? `<div class="mock-card">${MOCK_LABEL}</div>` : ''}`;
  if (p.locked) {
    const e = p.entry;
    const images = (e.images || []).map(src => `<img src="${esc(src)}" alt="${esc(e.title)}" loading="lazy">`).join('');
    return `<section class="panel" id="d-${p.date}">${heading}
      <div class="badges"><span class="badge">${esc(STATUS_LABELS[e.status])}</span>${e.edited ? '<span class="badge">修正して承認</span>' : ''}</div>
      <p>${esc(e.title)}</p>
      ${e.message ? `<div class="post"><div class="message">${renderMessageHtml(e.message, e.url)}</div>${images ? `<div class="photos n${(e.images || []).length}">${images}</div>` : ''}</div>
      <div class="copy-row"><button type="button" class="copy-btn">投稿文をコピー</button><span class="copy-status meta" role="status" aria-live="polite"></span>
      <textarea class="copy-src" readonly hidden>${esc(e.message)}</textarea></div>` : ''}
      <p class="meta">承認済み・公開済みの日は作り直しません。</p></section>`;
  }
  const rejectedNote = (p.rejectedEntries || []).map(e => `<p class="meta">この日は「${esc(e.title)}」を不採用にしています(理由: ${esc(e.decision?.reason || '')}${e.decision?.note ? ` / ${esc(e.decision.note)}` : ''})。同じ週では選びません。</p>`).join('');
  if (p.failed) {
    const why = describeProblem(p);
    return `<section class="panel" id="d-${p.date}">${heading}${rejectedNote}
      <div class="badges"><span class="badge ng">エラー・投稿案なし(履歴に記録しない)</span></div>
      <p class="ng">${esc(why.title)}</p>
      ${p.product ? `<p>予定していた商品: ${esc(p.product.title)}${p.product.genre ? `[${esc(p.product.genre)}]` : ''}</p>` : ''}
      <p class="meta">詳細: ${esc(why.detail)}</p>${renderReplaced(p.replaced)}</section>`;
  }

  const prod = p.product;
  const messageHtml = renderMessageHtml(p.message, prod.url);
  const copyLabel = IS_MOCK ? '投稿文をコピー(テスト用・投稿不可)' : '投稿文をコピー';
  const blocked = p.needsReview ? describeProblem(p) : null; // 事実確認・ルールに問題がある投稿は承認・コピーさせない
  const photos = prod.images.length
    ? `<div class="photos n${prod.images.length}">${prod.images.map(src => `<img src="${esc(src)}" alt="${esc(prod.title)}" loading="lazy">`).join('')}</div>`
    : '';
  const sources = prod.sources.map(s => s === 'ranking' && prod.rank ? `人気ランキング${prod.rank}位` : SOURCE_LABELS[s]);
  const anniversaryHtml = p.anniversaryUsed
    ? `<b>${esc(p.anniversary.name)}</b>(使用)<br><span class="meta">${esc(p.anniversaryReason)}</span><br><span class="meta">${esc(p.anniversary.description)}</span>`
    : `${p.anniversary ? `${esc(p.anniversary.name)}(関連が弱いため不使用)` : '使用しない'}${p.anniversaryReason ? `<br><span class="meta">${esc(p.anniversaryReason)}</span>` : ''}`;
  const dayInfo = day?.ok
    ? `<span class="meta">この日の記念日 ${day.items.length}件: ${esc(day.items.slice(0, 12).map(i => i.name).join('、'))}${day.items.length > 12 ? ' ほか' : ''}</span>`
    : `<span class="meta">記念日情報を取得できませんでした(${esc(day?.error || '不明')})</span>`;
  const claimRows = p.claims.map(c => `<tr><td>${esc(c.text)}</td><td>${esc(c.evidence)}</td><td class="${c.found ? 'ok' : 'ng'}">${c.found ? '✓ 一致' : '✗ 見つからない'}</td></tr>`).join('');
  const problems = [
    ...p.factIssues.map(i => ['ng', `事実確認: ${i}`]),
    ...p.issues.map(i => ['ng', i]),
    ...(p.styleIssues || []).map(i => ['ng', `言い回し: ${i}`]),
    ...(p.similarity || []).map(i => ['ng', `類似: ${i}`]),
    ...(p.rewrittenFor ? [['meta', `週全体の類似チェックで書き直し済み(${p.rewrittenFor.join(' / ')})`]] : []),
    ...p.notes.map(i => ['meta', i])
  ];

  return `<section class="panel" id="d-${p.date}">
    ${heading}
    <div class="badges">
      ${sources.map(s => `<span class="badge">${esc(s)}</span>`).join('')}
      <span class="badge">${esc(prod.genre)}</span>
      <span class="badge${prod.availability === 'unknown' ? ' ng' : ''}">${esc(AVAILABILITY_LABELS[prod.availability])}</span>
      <span class="badge${blocked ? ' ng' : ''}">${blocked ? '承認不可(履歴に記録しない)' : '候補として記録'}</span>
    </div>
    ${blocked ? `<p class="ng">${esc(blocked.title)}: ${esc(blocked.detail)}</p>` : ''}
    <div class="post${IS_MOCK ? ' mock' : ''}">
      <div class="head"><div class="avatar">ふ</div><div><b>ふくしま市場</b><div class="meta">${esc(formatDateJa(p.date))} 投稿予定</div></div></div>
      <div class="message">${messageHtml}</div>
      ${photos}
    </div>
    <div class="copy-row">
      ${blocked
        ? `<button type="button" class="copy-btn" disabled>承認不可のためコピーできません</button>`
        : `<button type="button" class="copy-btn${IS_MOCK ? ' warn' : ''}">${esc(copyLabel)}</button>
      <span class="copy-status meta" role="status" aria-live="polite"></span>
      <textarea class="copy-src" readonly hidden>${esc(p.message)}</textarea>`}
    </div>
    ${rejectedNote}
    ${p.reviewRecord ? reviewWidget(p.reviewRecord) : '<p class="meta">履歴に記録していないため、判断(承認・修正・不採用)の対象外です。</p>'}

    <h3>チェック</h3>
    <table class="kv">
      <tr><th>商品</th><td>${esc(prod.title)}(${esc(prod.price)}円)<br><a href="${esc(prod.url)}" target="_blank" rel="noopener">${esc(prod.url)}</a></td></tr>
      <tr><th>本文の文字数</th><td class="${p.bodyChars > CONFIG.BODY_MAX_CHARS ? 'ng' : 'ok'}">${p.bodyChars}文字(目安 ${CONFIG.BODY_MIN_CHARS}〜${CONFIG.BODY_MAX_CHARS}、改行・URL・ハッシュタグを除く)</td></tr>
      <tr><th>ハッシュタグ</th><td class="${p.hashtags.length === CONFIG.FIXED_HASHTAGS.length + CONFIG.EXTRA_HASHTAGS ? 'ok' : 'ng'}">${p.hashtags.length}個: ${esc(p.hashtags.join(' '))}</td></tr>
      <tr><th>絵文字</th><td class="${p.emojiCount <= CONFIG.MAX_EMOJI ? 'ok' : 'ng'}">${p.emojiCount}個</td></tr>
      <tr><th>記念日</th><td>${anniversaryHtml}<br>${dayInfo}</td></tr>
      <tr><th>Gemini</th><td>${esc(p.model)} / ${p.attempts}回目で作成</td></tr>
      <tr><th>商品ページ・画像の確認</th><td><ul class="issues">${(prod.verification || []).map(c => `<li class="${c.ok ? 'ok' : 'ng'}">${c.ok ? '✓' : '✗'} ${esc(c.label)}: ${esc(c.detail)}</li>`).join('')}</ul></td></tr>
      <tr><th>警告</th><td>${problems.length ? `<ul class="issues">${problems.map(([cls, t]) => `<li class="${cls}">${esc(t)}</li>`).join('')}</ul>` : '<span class="ok">なし</span>'}</td></tr>
    </table>
    ${renderReplaced(p.replaced)}

    <h3>根拠(本文の記述 → 商品情報からの引用)</h3>
    <table>
      <tr><th>本文の記述</th><th>引用</th><th>照合</th></tr>
      ${claimRows || '<tr><td colspan="3" class="ng">引用がありません</td></tr>'}
    </table>
    <details><summary>商品説明の全文(根拠の確認用)</summary><pre>${esc(prod.description)}</pre></details>
  </section>`;
}

/**
 * 投稿文の表示。空行で区切られたまとまりを段落(<p>)にし、段落内の改行は <br> にする。
 * 余白は段落の間だけに付くので、コピーされる文章(空行=段落の区切り)と見た目が一致する。
 */
function renderMessageHtml(message, url) {
  const link = `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  return message.split('\n\n')
    .map(block => `<p>${block.split('\n').map(line => (line === url ? link : esc(line))).join('<br>')}</p>`)
    .join('');
}

/** 「投稿文をコピー」ボタン。隠しテキストエリアの文章をそのまま(改行も含めて)コピーする */
const COPY_SCRIPT = `
document.addEventListener('click', async e => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const row = btn.closest('.copy-row');
  const text = row.querySelector('.copy-src').value;
  const status = row.querySelector('.copy-status');
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
  }
  status.textContent = ok ? 'コピーしました' : 'コピーできませんでした。文章を選択してコピーしてください';
  clearTimeout(btn._timer);
  btn._timer = setTimeout(() => { status.textContent = ''; }, 2500);
});
`;

/** Gemini の呼び出し回数・上限(429)の内訳。上限の実際の値は AI Studio のレート制限ページで確認できる */
function renderGeminiUsage() {
  const rows = Object.entries(geminiUsage.byModel).map(([model, c]) => `
      <tr><td>${esc(model)}${geminiUsage.dailyExhausted.includes(model) ? ' <span class="ng">(1日の上限)</span>' : ''}</td>
        <td>${c.calls}</td><td class="ok">${c.ok}</td><td class="${c.rateLimited ? 'ng' : ''}">${c.rateLimited}</td>
        <td>${c.unavailable}</td><td>${c.timeout}</td><td>${c.networkError + c.badOutput}</td></tr>`).join('');
  const quotas = new Map();
  for (const r of geminiUsage.rateLimits) {
    for (const q of r.quotas.length ? r.quotas : [{ id: '(種類不明)', value: '' }]) {
      const key = `${r.model} ${q.id}`;
      const prev = quotas.get(key) || { model: r.model, id: q.id, value: q.value, count: 0, retry: [] };
      prev.count++;
      if (r.retryAfterMs !== null) prev.retry.push(Math.ceil(r.retryAfterMs / 1000));
      quotas.set(key, prev);
    }
  }
  const quotaRows = [...quotas.values()].map(q => `<li>${esc(q.model)}: ${esc(q.id)}${q.value !== '' ? `(上限 ${esc(q.value)})` : ''} × ${q.count}回${q.retry.length ? `<span class="meta">(待ち時間の指示: ${esc([...new Set(q.retry)].join('・'))}秒)</span>` : ''}</li>`).join('');
  return `<section class="panel">
    <h2>Gemini の利用状況</h2>
    <p class="meta">呼び出し ${geminiUsage.calls}回。同じモデルへの呼び出しは ${Math.round(CONFIG.GEMINI_MIN_INTERVAL_MS / 1000)}秒以上あけています。
      上限の実際の値は <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noopener">AI Studio のレート制限ページ</a> で確認できます(1日の上限は日本時間17時ごろにリセット)。</p>
    <table>
      <tr><th>モデル</th><th>呼び出し</th><th>成功</th><th>上限(429)</th><th>混雑(503など)</th><th>時間切れ</th><th>通信エラー等</th></tr>${rows || '<tr><td colspan="7">呼び出しなし</td></tr>'}
    </table>
    ${quotaRows ? `<h3>上限(429)の内訳</h3><ul class="issues">${quotaRows}</ul>` : ''}
  </section>`;
}

function geminiUsageSummary() {
  const per = Object.entries(geminiUsage.byModel).map(([m, c]) => `${m}: ${c.calls}回(成功${c.ok}・429が${c.rateLimited}・混雑${c.unavailable}・時間切れ${c.timeout})`).join(' / ');
  const ids = [...new Set(geminiUsage.rateLimits.flatMap(r => r.quotas.map(q => `${r.model} ${q.id}${q.value !== '' ? `=${q.value}` : ''}`)))];
  return `Gemini: 呼び出し${geminiUsage.calls}回 — ${per || 'なし'}${ids.length ? ` / 429の内訳: ${ids.join(', ')}` : ''}${geminiUsage.dailyExhausted.length ? ` / 1日の上限: ${geminiUsage.dailyExhausted.join(', ')}` : ''}`;
}

function renderReplaced(replaced) {
  if (!replaced || replaced.length === 0) return '';
  return `<p class="meta">差し替えた商品: ${replaced.map(r => `${esc(r.title)}(${esc(r.reason)})`).join('、')}</p>`;
}

// ---------------------------------------------------------------------------
// 外部サイトへのアクセス
// ---------------------------------------------------------------------------

const lastRequestAt = new Map();

/**
 * 商品サイト・雑学ネタ帳・商品画像の配信サーバーだけに使う(読み取りのみ: GET / HEAD)。
 * 同じサイトへは間隔を空け、429/503 のときは待って再試行する(retry: false なら再試行しない)。
 */
async function politeFetch(url, { method = 'GET', retry = true } = {}) {
  const host = new URL(url).host;
  const allowed = [new URL(CONFIG.SHOP_BASE_URL).host, new URL(CONFIG.ZATSUNETA_BASE_URL).host, ...IMAGE_HOSTS];
  if (!allowed.includes(host)) throw new Error(`許可されていない宛先です: ${host}`);
  if (!['GET', 'HEAD'].includes(method)) throw new Error(`読み取り以外のアクセスはしません: ${method}`);
  for (let attempt = 0; ; attempt++) {
    const wait = (lastRequestAt.get(host) || 0) + CONFIG.REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
    const res = await fetch(url, { method, headers: { 'User-Agent': CONFIG.USER_AGENT }, signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS) });
    if (retry && (res.status === 429 || res.status === 503) && attempt < CONFIG.MAX_FETCH_RETRIES) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : CONFIG.RETRY_WAIT_MS * (attempt + 1);
      log(`${host} がアクセス制限中(HTTP ${res.status})のため ${Math.round(ms / 1000)} 秒待って再試行します`);
      await sleep(ms);
      continue;
    }
    return res;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// models / check
// ---------------------------------------------------------------------------

/**
 * Gemini API のモデル一覧(Flash 系)を表示する。一覧の取得は生成の回数に数えられないため、既定では生成の呼び出しはしない。
 * MODELS_PROBE=モデル名,モデル名 を指定したときだけ、そのモデルに短い generateContent を1回ずつ呼んで使えるか確かめる
 * (1日の上限を消費するため、必要なモデルだけに絞る)。
 */
async function checkGeminiModels() {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };

  const models = [];
  let pageToken = '';
  do {
    const res = await fetch(`${base}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers });
    const json = await res.json();
    if (json.error) throw new Error(`Gemini モデル一覧の取得に失敗しました: ${json.error.code} ${json.error.status} ${json.error.message}`);
    models.push(...(json.models || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);

  const flash = models.filter(m => /flash/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'));
  const probe = String(process.env.MODELS_PROBE || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
  const names = [...new Set([...flash.map(m => m.name.replace(/^models\//, '')), ...CONFIG.GEMINI_MODELS])];

  const rows = [];
  for (const name of names) {
    const listed = flash.some(m => m.name === `models/${name}`);
    let result = '(呼び出していません)';
    if (probe.includes(name)) {
      const res = await fetch(`${base}/models/${name}:generateContent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contents: [{ parts: [{ text: 'OKとだけ答えてください。' }] }] }),
        signal: AbortSignal.timeout(CONFIG.GEMINI_TIMEOUT_MS)
      });
      const json = await res.json();
      result = json.error ? `× ${json.error.code} ${json.error.status}: ${String(json.error.message).slice(0, 120)}` : '○ 呼び出し成功';
    }
    rows.push(`| ${name}${CONFIG.GEMINI_MODELS.includes(name) ? '(使用中)' : ''} | ${listed ? 'あり' : 'なし'} | ${result} |`);
  }

  summary([
    `### Gemini モデル確認(全${models.length}件中、generateContent 対応の Flash 系 ${flash.length}件)`,
    `現在のコードの設定(上から順に使用): ${CONFIG.GEMINI_MODELS.join(' → ')}`,
    probe.length ? `呼び出して確かめたモデル: ${probe.join(', ')}(1日の上限を1回ずつ消費)` : '生成の呼び出しはしていません(確かめるときは MODELS_PROBE=モデル名 を指定。最大3つ)',
    '',
    '| モデル | 一覧に掲載 | 実際の呼び出し |',
    '|---|---|---|',
    ...rows
  ].join('\n'));
}

async function runCheck() {
  const token = requireEnv('FB_PAGE_ACCESS_TOKEN');
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
  const pageId = process.env.FB_PAGE_ID;
  const page = await graphGet(`${pageId}?fields=name`, token);
  summary(`### トークン確認OK\n- ページ: ${page.name} (${pageId})`);
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
 * Facebook への通信はすべてここを通す。check の読み取り(GET)以外は遮断する。
 * 下書き保存(POST)の経路は、週次版が完成するまで持たない。
 */
async function guardedFacebookFetch(url, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  if (MODE !== 'check') throw new Error(`${MODE} モードではFacebookへの通信は禁止されています。`);
  if (method !== 'GET') throw new Error(`Facebookへの書き込みは停止中のため遮断しました: ${method} ${url}`);
  return fetch(url, init);
}

async function graphGet(path, token) {
  const res = await guardedFacebookFetch(`https://graph.facebook.com/${CONFIG.GRAPH_API_VERSION}/${path}`, {
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

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

function todayJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 翌週の月曜日(今日が月曜なら7日後) */
function nextMondayJst() {
  const today = todayJst();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, ((8 - dow) % 7) || 7);
}

function weekdayJa(ymd) {
  return '日月火水木金土'[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
}

function formatDateJa(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}月${d}日(${weekdayJa(ymd)})`;
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map(compactSpaces).filter(Boolean).join('\n');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function compactSpaces(s) {
  return String(s).replace(/[ \t　]+/g, ' ').trim();
}

/** 空白を除いた文字列(説明文の長さの判定用) */
function compact(s) {
  return String(s || '').replace(/\s/g, '');
}

/** 照合用: 全角・半角をそろえ、空白を除く */
function norm(s) {
  return String(s || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

function esc(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, c => map[c]);
}

function mdCell(s) {
  return String(s).replace(/\|/g, '\\|');
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
