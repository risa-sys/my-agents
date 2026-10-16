# my-agents

Google Apps Script で動く、いくつかの自動化エージェントをまとめたリポジトリ。

GitHub の `main` ブランチに push すると、GitHub Actions が [clasp](https://github.com/google/clasp) 経由で
自動的に(同じ)Google Apps Script プロジェクトへデプロイします(実行自体は各エージェントの
Google Apps Script トリガーが担当します)。

## エージェント一覧

- `daily-task-agent.gs` — 前日のメールから「今日やることリスト」を作成し、自分宛に送信
- `scripts/fb-draft-post.mjs`(GitHub Actions で実行) — 毎朝8:30に、ふくしま市場([fukushima-ichiba.com](https://fukushima-ichiba.com/))の
  売れ筋ランキング([collections/ranking_top10](https://fukushima-ichiba.com/collections/ranking_top10))を基準に、
  新着([collections/new-1](https://fukushima-ichiba.com/collections/new-1))も含めた候補から1商品を選び、Geminiで投稿文を作って
  Facebookページ([facebook.com/fukushimaichiba](https://www.facebook.com/fukushimaichiba/))に
  **下書きとして保存**する。公開はしない(Meta Business Suiteで確認して手動で公開する)。
  直近30日以内に紹介した商品は除外する(履歴は `data/fb-posted-history.json` に自動コミット)。
  詳しくは下の「Facebook下書きエージェント」を参照。

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

## Facebook下書きエージェント(GitHub Actions)

`.github/workflows/fb-draft-post.yml` が毎朝8:30(JST)に `scripts/fb-draft-post.mjs` を実行する。
Apps Script は使わない。

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
gh workflow run fb-draft-post.yml -f mode=check     # トークンとページの疎通確認のみ
gh workflow run fb-draft-post.yml -f mode=dry-run   # 投稿文を生成して表示するだけ
gh workflow run fb-draft-post.yml -f mode=draft     # 実際に下書きとして保存
gh run watch                                        # 結果を見る(投稿文は実行結果の Summary にも出る)
```

下書きは [Meta Business Suite の下書き一覧](https://business.facebook.com/latest/posts?tab=drafts) で確認し、手動で公開する。

### うまくいかないとき

- エラー190(トークン無効・期限切れ): 手順1でトークンを作り直し、`FB_PAGE_ACCESS_TOKEN` を差し替える
- エラー200や10(権限不足): システムユーザーへのページ・アプリの割り当てと、トークンの権限を確認する
- 実行が失敗すると、GitHub から失敗通知メールが届く
