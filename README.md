# my-agents

Google Apps Script で動く、いくつかの自動化エージェントをまとめたリポジトリ。

GitHub の `main` ブランチに push すると、GitHub Actions が [clasp](https://github.com/google/clasp) 経由で
自動的に(同じ)Google Apps Script プロジェクトへデプロイします(実行自体は各エージェントの
Google Apps Script トリガーが担当します)。

## エージェント一覧

- `daily-task-agent.gs` — 前日のメールから「今日やることリスト」を作成し、自分宛に送信
- `scripts/fb-draft-post.mjs`(手元または GitHub Actions で手動実行。自動実行はしない) — ふくしま市場([fukushima-ichiba.com](https://fukushima-ichiba.com/))の
  新商品([collections/new-1](https://fukushima-ichiba.com/collections/new-1))・人気ランキング([collections/ranking_top10](https://fukushima-ichiba.com/collections/ranking_top10))を優先し、
  全商品からも候補を集めて、Facebookページ([facebook.com/fukushimaichiba](https://www.facebook.com/fukushimaichiba/))用の
  **翌週7日分の投稿案**を作り、HTMLプレビューで確認できるようにする。Facebookへは送信しない(下書き保存は停止中)。
  詳しくは下の「Facebook投稿案エージェント」を参照。

## セットアップ(初回のみ・手元の端末で実施)

ブラウザでの Google 認可が必要なため、この手順は自分のPCで一度だけ行ってください。

1. Apps Script API を有効化
   - https://script.google.com/home/usersettings を開き、「Google Apps Script API」を ON にする

2. clasp をインストールしてログイン
   ```
   npm install -g @google/clasp
   clasp login
   ```
   → ブラウザが開くのでGoogleアカウントを認可。成功すると `~/.clasprc.json` が作成されます。

3. Apps Script プロジェクトを用意
   - すでに script.google.com 上に手動で作った daily-task-agent プロジェクトがある場合:
     ```
     clasp clone <そのプロジェクトのスクリプトID>
     ```
   - まだ無ければ新規作成:
     ```
     clasp create --title "daily-task-agent" --type standalone --rootDir .
     ```
   - どちらも `.clasp.json`(scriptId 入り)がカレントディレクトリに作られます(このファイルは `.gitignore` 済みでリポジトリには含めません)。

4. スクリプトプロパティに Gemini の API キーを設定
   ```
   clasp open
   ```
   で開いたエディタの「プロジェクトの設定」→「スクリプト プロパティ」で
   `GEMINI_API_KEY` を追加(値は https://aistudio.google.com/apikey で発行したキー)。

5. 初回だけ手動で日次トリガーを作成
   - エディタの関数選択で `setupDailyTrigger` を選んで実行(初回は権限承認あり)
   - 「トリガー」画面で `sendDailyTaskList` が毎日7:00に登録されていることを確認

6. GitHub Actions 用の Secrets を登録
   ```
   gh secret set CLASP_CREDENTIALS < ~/.clasprc.json
   gh secret set CLASP_SCRIPT_ID -b"<.clasp.json の scriptId>"
   ```

## 以降の運用

- 各 `.gs` ファイルを編集して `main` に push すると、GitHub Actions が自動で
  Apps Script プロジェクトへ反映します(`.github/workflows/deploy.yml`)。
- 実際の毎日の実行は Apps Script 側の時間主導トリガー
  (`setupDailyTrigger` / `setupFacebookDraftTrigger` で登録済み)が担当します。
  GitHub Actions は「コードを最新に保つ」役割です。

## Facebook投稿案エージェント(GitHub Actions)

`scripts/fb-draft-post.mjs` を手元または `.github/workflows/fb-draft-post.yml`(手動実行のみ・cron なし)で動かす。
Apps Script は使わない。

| MODE | 内容 | Facebookへの通信 |
|---|---|---|
| `preview`(既定) | 翌週(月〜日)7日分の投稿案を作り、`preview/fb-week-<開始日>.html` と候補履歴を書き出す | なし(コード上で遮断) |
| `models` | Gemini で使えるモデルの確認 | なし(コード上で遮断) |
| `check` | トークンとページの疎通確認 | 読み取り(GET)のみ |
| `draft` | 停止中(週次版の下書き保存が完成するまで) | なし |

### 0. 手元でプレビューする(Facebookには送信しない)

```
$env:GEMINI_API_KEY = "<キー>"   # PowerShell の場合
$env:WEEK_START = "2026-11-16"   # 省略すると翌週の月曜日から7日分
npm run fb:preview
```

表示された `preview/fb-week-<開始日>.html` をブラウザで開く。

### 商品の選び方

- 公開データ(`products.json`)から、人気ランキング・新商品・全商品を取得する(サイトへは2秒以上の間隔を空け、
  429/503 のときは待って再試行する)
- 人気ランキングと新商品を交互に優先し、足りなければ全商品(公開日の新しい順)から補う。7件はすべて別の商品
- 売り切れ・画像なし・説明文50文字未満の商品は選ばない。在庫情報が無い商品は「在庫未確認」と表示する
- 投稿予定日の前後30日に履歴がある商品(候補・承認済み・公開済みのいずれも)は選ばない
- 同じジャンル(お米・果物・野菜・お菓子・飲料/お酒・調味料/加工品・麺類・肉/魚)は1週間で原則2件まで。
  ジャンルはまず商品名で判定し、商品名で決まらないときだけ種別・タグを見る(タグには「米・麺類」のようなまとめた分類があるため)。
  上限に達したジャンルの商品は後回しにし、ほかのジャンルの候補が足りないときだけ使う(プレビューに表示)
- 使う商品は、次の3点を読み取りで確認できたものだけ(確認できなければ予備の商品に切り替え、足りなければその日はエラー)
  1. 単品データ(`/products/<handle>.js`)を取り直し、一覧と商品ID・handle・商品名が一致する
  2. 商品ページが、転送されずに「その商品のページ」として表示される(HTTP 200 に加え、og:type=product・商品名・「見つかりません」でないこと)
  3. 画像が `cdn.shopify.com` のもので、単品データに登録された同じ商品の画像で、画像として読める(アクセス制限時は再試行しない)
- 商品名・URL・画像・説明文は、確認に使った同じ商品IDのデータだけで組み立てる。架空の値で補わない

### 今日は何の日

[雑学ネタ帳](https://zatsuneta.com/category/anniversary.html)の日付ページ(`/archives/aMMDD.html`)から記念日名を取り、
商品と強く関連するときだけ、その記念日の説明(個別ページの冒頭)を根拠に投稿で使う。
robots.txt を確認し、取得できない日は通常の商品紹介にする。アクセスは週に十数回程度。

### 投稿文のルール

ふくしま市場のSNS担当者が自分の言葉で紹介するように書く。「会津みしらず柿」の文(`STYLE_REFERENCE`)は雰囲気の参考で、
構成や締め方の型にはしない。設定は `scripts/fb-draft-post.mjs` の `CONFIG`。

- 形: 見出し1行 → 本文1〜3段落 →「▼詳細はこちら」→ 商品URL → ハッシュタグ4個
  (「▼詳細はこちら」以降はコード側で付ける。ハッシュタグは `#ふくしま市場 #福島県` +商品情報にある言葉2個)
- 商品ごとに伝える切り口(味・食感・香り・食べ方・製法・産地・生産者・季節)を1〜2つ選び、構成も商品に合わせて変える
- 締めの一文は必須ではない。締める場合は商品説明に根拠のある食べ方・使い道で締める
- 「お楽しみください」「おすすめです」「いかがでしょうか」などの定型表現(`STOCK_PHRASES`)は作り直させる
  (直らなければ注意として表示し、商品は差し替えない)
- 見出しの形は商品に合わせて変える(商品名から/特徴から/食べ方から など)。絵文字は商品に合うものがあるときだけ使う
- ハッシュタグは固定2個+商品に関連する2個。商品情報に書かれている言葉なら「#米」のような広い言葉もよい(句読点の違いは無視して照合)
- 7件そろったら、見出し・最後の一文の言い回し(商品名を除く)、文末、構成、切り口、見出しの形(絵文字の有無・「」の位置。同じ形は3件まで、
  絵文字で始まる見出しは4件まで)を比べ、似すぎた投稿を書き直す
  (最大4件・各2回。書き直し案がルール・事実確認に通り、ほかと似ていない場合だけ採用。結果はプレビューの「週全体の類似チェック」に表示)
- 本文は改行・URL・ハッシュタグを除いて100〜180文字が目安(180超は作り直し、100未満は注意表示のみ)、
  絵文字は2個まで、誇張表現(`NG_PHRASES`)は使わない
- 産地・製法・生産者・数量などの事実は商品情報だけを根拠にする。Gemini に根拠の引用を添えさせ、
  引用が商品情報に無い場合や、本文の数字が商品情報に無い場合は作り直させる。3回で直らなければ予備の商品に差し替え、
  それでも駄目なら「要確認」としてプレビューに警告を出す
- 書き出し・締めくくりは、同じ週と直近の履歴と似ないようにする
- 改行は「見出しの後」「段落の間」「▼詳細はこちらの前」「ハッシュタグの前」だけ空行1つ。行末の空白・連続する空行は取り除く
- プレビューの「投稿文をコピー」で、見出し〜ハッシュタグ4個をそのままコピーできる(プレビューの表示も同じ文章から作るので改行が一致する)
- 公式Xの投稿文を `data/fb-style-examples.txt` に貼ると(投稿ごとに `---` だけの行で区切る)、文体の手本として使われる

### 履歴(`data/fb-post-history.json`)

`{"version": 2, "entries": [...]}` の形で、各投稿に `productId` / `postDate` / `week` / `status` を持つ。

- `candidate`: プレビューで選んだ候補(preview が自動で記録。生成に失敗・要確認の投稿は記録しない)
- `approved`: 投稿すると決めたもの / `published`: 公開済み(どちらも今は手で書き換える)
- 同じ週のプレビューを作り直すと、その週の `candidate` は置き換わる(重複しない)。承認済み・公開済みの日は作り直さない
- 1件も生成できなかったときは履歴を変更しない
- 候補として記録するのは事実確認に通った投稿だけ(`"factCheck": "passed"`)。事実確認・ルールに問題がある投稿は「承認不可」とし、コピーもできない
- GitHub Actions では main に自動コミットしない。履歴は専用ブランチ `fb-history`(履歴ファイルだけを持つ独立したブランチ)に保存し、
  次回の実行の最初にそこから復元する(`scripts/fb-history-branch.sh`)。書き込み権限を持つのは保存用の `save-history` job だけ。
  プレビューと履歴は Artifacts(`fb-weekly-preview`)にも保存する

### Gemini のエラーと未完成の表示

- モデルは gemini-3.6-flash → 3.8-flash → 3.7-flash の順に使う
- 混雑(503など)・上限(429)・通信エラー・60秒の時間切れのときは、3つのモデルを順に試し、すべて駄目なら30秒・60秒待ってやり直す
- 混雑・通信エラーで生成できない日が2日続いたら、残りの日は待たずに見送る(実行全体は50分で打ち切り)
- 7件のうち承認できない日(エラー・承認不可)が1件でもあれば、プレビューの先頭に「未完成」と、日付・理由を表示する

### テスト用モックとの区別

- テスト用モックは `globalThis.__FB_PREVIEW_MOCK__` を立てる。この目印があると `PREVIEW_DATA_SOURCE=mock` 以外では動かず、
  逆に `PREVIEW_DATA_SOURCE=mock` は目印が無いと動かない(GitHub Actions では常に使えない)
- テストのプレビューは `fb-week-<開始日>-TEST.html` になり、画面上部と各投稿に「テスト用データ・投稿不可」と大きく表示する
- テストの履歴は `*.test.json` だけに書ける(`.gitignore` 済み)。実データの実行は `*.test.json` を使えず、
  履歴に `"dataSource": "mock"` の記録があれば中止する

### 1. トークンを用意する

[Meta Business Suite](https://business.facebook.com/settings) → ビジネスポートフォリオ(スペースワン) →
「ユーザー」→「システムユーザー」で、システムユーザーに **fukushimaichiba ページ**(コンテンツの作成・管理)と
投稿用Metaアプリ(アプリを管理)を割り当てる。続けて「新しいトークンを生成」を押し、有効期限「なし(Never)」と
権限 `pages_manage_posts` / `pages_read_engagement` / `pages_show_list` を選んで生成する。
生成したトークンは [アクセストークンデバッガー](https://developers.facebook.com/tools/debug/accesstoken) で、
有効期限が Never であること、3つの権限が入っていること、「有効」と表示されることを確認する。

### 2. GitHub Secrets に登録する

```
gh secret set FB_PAGE_ACCESS_TOKEN   # 実行するとトークンの入力を求められる(チャットや履歴に残らない)
gh secret set FB_PAGE_ID             # Facebookページの「設定」→「ページの情報」で確認できる
gh secret set GEMINI_API_KEY         # https://aistudio.google.com/apikey
```

### 3. 動作を確認する(どのモードでも公開はされない)

```
gh workflow enable fb-draft-post.yml                 # ワークフローは普段は無効にしてある
gh workflow run fb-draft-post.yml -f mode=preview   # 翌週7日分の投稿案(-f week_start=YYYY-MM-DD で週を指定)
gh run watch                                        # 結果を見る(一覧は実行結果の Summary にも出る)
gh run download <run-id> -n fb-weekly-preview -D preview/
gh workflow disable fb-draft-post.yml               # 終わったら無効に戻す
```

`check` / `models` も同じ手順で `-f mode=check` / `-f mode=models` を指定する。

下書き保存(`draft`)は週次版が完成するまで停止中。`DRAFT` 指定の下書きが Business Suite の下書き一覧に
表示されることは保証されていない点にも注意。

### うまくいかないとき

- エラー190(トークン無効・期限切れ): 手順1でトークンを作り直し、`FB_PAGE_ACCESS_TOKEN` を差し替える
- エラー200や10(権限不足): システムユーザーへのページ・アプリの割り当てと、トークンの権限を確認する
- 実行が失敗すると、GitHub から失敗通知メールが届く
