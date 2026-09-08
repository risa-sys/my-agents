# daily-task-agent

前日のメールから「今日やることリスト」を作成し、自分宛に送信する Google Apps Script エージェント。

GitHub の `main` ブランチに push すると、GitHub Actions が [clasp](https://github.com/google/clasp) 経由で
自動的に Google Apps Script プロジェクトへデプロイします(実行自体は Google Apps Script のトリガーが担当します)。

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

- `daily-task-agent.gs` を編集して `main` に push すると、GitHub Actions が自動で
  Apps Script プロジェクトへ反映します(`.github/workflows/deploy.yml`)。
- 実際の毎日の実行(メール収集・Gemini呼び出し・送信)は Apps Script 側の時間主導トリガー
  (`setupDailyTrigger` で登録済み)が担当します。GitHub Actions は「コードを最新に保つ」役割です。
