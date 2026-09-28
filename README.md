# my-agents

Google Apps Script で動く、いくつかの自動化エージェントをまとめたリポジトリ。

GitHub の `main` ブランチに push すると、GitHub Actions が [clasp](https://github.com/google/clasp) 経由で
自動的に(同じ)Google Apps Script プロジェクトへデプロイします(実行自体は各エージェントの
Google Apps Script トリガーが担当します)。

## エージェント一覧

- `daily-task-agent.gs` — 前日のメールから「今日やることリスト」を作成し、自分宛に送信
- `fb-draft-post-agent.gs` — 毎朝、ふくしま市場([fukushima-ichiba.com](https://fukushima-ichiba.com/))の
  新着・売れ筋商品と当日の話題を絡めたFacebook投稿文をGeminiで生成し、
  Facebookページ([facebook.com/fukushimaichiba](https://www.facebook.com/fukushimaichiba/))に
  **下書き(未公開投稿)として保存**する。自動公開はせず、Meta Business Suiteで内容確認後に手動公開する。
  セットアップ手順はファイル冒頭のコメントを参照。

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

6. `fb-draft-post-agent.gs` を使う場合は、追加でスクリプトプロパティに
   `FB_PAGE_ID` / `FB_PAGE_ACCESS_TOKEN` を設定し、
   関数選択で `setupFacebookDraftTrigger` を実行して毎朝8:30のトリガーを作成する
   - トークンの取得は、fukushimaichibaページの管理者アカウントで
     [Graph API Explorer](https://developers.facebook.com/tools/explorer/)(Meta純正のデフォルトアプリ、
     自分でアプリを作る必要なし)を開き、権限に `pages_show_list` / `pages_manage_posts` /
     `pages_read_engagement` を追加してトークン取得 → `GET /me/accounts` でページID・
     ページアクセストークンを確認、という流れ(詳細はファイル冒頭のコメント参照)
   - このトークンは60日程度で失効するため、失効時は同じ手順で取り直して
     `FB_PAGE_ACCESS_TOKEN` を更新する(失効時は失敗通知メールが届きます)

7. GitHub Actions 用の Secrets を登録
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
