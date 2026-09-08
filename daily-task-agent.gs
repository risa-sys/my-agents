/**
 * ============================================================
 * 前日のメールから「今日やることリスト」を作成し、自分宛に送信するスクリプト
 * ============================================================
 *
 * 【セットアップ手順】
 * 1. https://script.google.com を開き、「新しいプロジェクト」を作成
 * 2. デフォルトの Code.gs の中身を全部消して、このファイルの内容を貼り付け
 * 3. 左メニューの歯車アイコン「プロジェクトの設定」→ 一番下の
 *    「スクリプト プロパティ」で、プロパティ名 GEMINI_API_KEY を追加し、
 *    値に Google AI Studio (https://aistudio.google.com/apikey) で
 *    発行した Gemini の API キーを設定
 * 4. 上部の関数選択ドロップダウンで setupDailyTrigger を選び、実行(▶）
 *    → 初回は権限承認画面が出るので、Gmailの読み取り・送信/外部通信を許可
 * 5. 左メニューの時計アイコン「トリガー」で、毎日7:00に
 *    sendDailyTaskList が登録されていることを確認
 * 6. 動作確認として、関数選択で sendDailyTaskList を選んで一度手動実行してみる
 *
 * これで毎朝7:00に、前日のメールから「今日やることリスト」が
 * risa@spacexone.com 宛に自動送信されます。
 * ============================================================
 */

const CONFIG = {
  RECIPIENT_EMAIL: 'risa@spacexone.com',
  GEMINI_MODEL: 'gemini-2.0-flash',
  MAX_EMAILS: 50,          // 一度に処理する最大件数
  GMAIL_SEARCH_QUERY: 'in:inbox'  // 必要に応じて '-category:promotions' 等を追加
};

/**
 * メインの処理。トリガーから毎日呼び出される。
 */
function sendDailyTaskList() {
  const { startDate, endDate } = getYesterdayRange_();
  const emails = collectYesterdaysEmails_(startDate, endDate);

  if (emails.length === 0) {
    GmailApp.sendEmail(
      CONFIG.RECIPIENT_EMAIL,
      `【今日やることリスト】${formatDate_(new Date())}`,
      '前日のメールが見つかりませんでした。'
    );
    return;
  }

  const taskListText = generateTaskListWithGemini_(emails);

  GmailApp.sendEmail(
    CONFIG.RECIPIENT_EMAIL,
    `【今日やることリスト】${formatDate_(new Date())}`,
    taskListText
  );
}

/**
 * 「前日」の00:00〜24:00の範囲を返す
 */
function getYesterdayRange_() {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { startDate, endDate };
}

/**
 * 前日に届いたメールを収集する
 */
function collectYesterdaysEmails_(startDate, endDate) {
  const query = `${CONFIG.GMAIL_SEARCH_QUERY} after:${formatDateForQuery_(startDate)} before:${formatDateForQuery_(endDate)}`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_EMAILS);

  const emails = [];
  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const date = message.getDate();
      if (date >= startDate && date < endDate) {
        emails.push({
          from: message.getFrom(),
          subject: message.getSubject(),
          body: message.getPlainBody().slice(0, 1500) // 長すぎるメールは切り詰め
        });
      }
    });
  });
  return emails;
}

/**
 * Gemini APIを呼び出し、メール一覧から「今日やることリスト」を生成する
 */
function generateTaskListWithGemini_(emails) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('スクリプトプロパティ GEMINI_API_KEY が設定されていません。プロジェクトの設定から追加してください。');
  }

  const emailsText = emails.map((e, i) =>
    `--- メール${i + 1} ---\n差出人: ${e.from}\n件名: ${e.subject}\n本文:\n${e.body}`
  ).join('\n\n');

  const prompt = `
あなたは優秀な秘書です。以下は前日に届いたメール一覧です。
これらの内容から、受信者が「今日中に対応すべきこと」を抽出し、
優先度が高い順に日本語の箇条書きリストとして出力してください。

ルール:
- 単なるメールの要約ではなく、具体的なアクション(誰に何をするか)として書く
- 返信が必要なメールは「〜へ返信する」という形にする
- 締切や日時が明記されている場合は明記する
- 対応不要な広告・通知・システム自動通知メールは除外する
- 出力は「・」で始まる箇条書きのみ。前置きや説明文、まとめは不要

--- メール一覧 ---
${emailsText}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }]
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const json = JSON.parse(response.getContentText());
  if (json.error) {
    throw new Error('Gemini APIエラー: ' + JSON.stringify(json.error));
  }
  return json.candidates[0].content.parts[0].text;
}

function formatDateForQuery_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy年M月d日');
}

/**
 * 【初回セットアップ用】毎日7:00に sendDailyTaskList を実行するトリガーを作成する。
 * 手動で一度だけ実行してください。再実行しても重複登録されないよう、
 * 既存の同名トリガーを削除してから作り直します。
 */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'sendDailyTaskList') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('sendDailyTaskList')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
}
