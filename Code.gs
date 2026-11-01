/**
 * 亦麟國際｜官網報名表 → Google Sheet
 * 貼到：Google Sheet → 擴充功能 → Apps Script → Code.gs
 */

// 你的 Google Sheet ID（已填好）
const SHEET_ID = '1uFkkA-OpnWZubiu24OD1D8PfLkG9nGh9apgcpTZ5zIY';

// 報名資料寫入的工作表名稱（不存在會自動建立）
const SHEET_NAME = '報名資料';

// 收到報名時寄通知信到這個信箱；不需要通知就留空 ''
const NOTIFY_EMAIL = '';

// 欄位設定：[表單欄位 name, 試算表標題]
const FIELDS = [
  ['name',     '姓名'],
  ['company',  '公司／單位名稱'],
  ['title',    '職稱'],
  ['phone',    '聯絡電話'],
  ['email',    'Email'],
  ['industry', '產業別'],
  ['size',     '企業規模'],
  ['item',     '報名項目'],
  ['people',   '預計參加人數'],
  ['message',  '想了解的問題'],
  ['consent',  '個資同意'],
  ['page',     '來源頁面'],
];

const REQUIRED = ['name', 'company', 'phone', 'email', 'item', 'consent'];

/** 第一次請手動執行一次：建立工作表與標題列，並完成授權 */
function setup() {
  getSheet_();
}

/** 用瀏覽器打開網址時顯示，用來確認部署成功 */
function doGet() {
  return json_({ result: 'success', message: '亦麟國際報名表服務運作中' });
}

/** 接收網站報名表送出的資料 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const p = (e && e.parameter) || {};

    // 防機器人：隱藏欄位有值就直接當成功回應，不寫入
    if (p.website) return json_({ result: 'success' });

    // 必填檢查
    for (const key of REQUIRED) {
      if (!p[key] || String(p[key]).trim() === '') {
        return json_({ result: 'error', message: '有必填欄位未填寫，請確認後再送出。' });
      }
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
      return json_({ result: 'error', message: 'Email 格式不正確。' });
    }

    const sheet = getSheet_();
    const row = [new Date()].concat(FIELDS.map(([key]) => clean_(p[key])));
    sheet.appendRow(row);

    if (NOTIFY_EMAIL) {
      const body = FIELDS.map(([key, label]) => label + '：' + (p[key] || '')).join('\n');
      MailApp.sendEmail(NOTIFY_EMAIL, '【官網報名】' + (p.item || '') + '－' + (p.name || ''), body);
    }

    return json_({ result: 'success' });
  } catch (err) {
    return json_({ result: 'error', message: '系統忙碌中，請稍後再試。' });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 工具函式 ---------- */

function getSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    const headers = ['送出時間'].concat(FIELDS.map(f => f[1]));
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8efe9');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  }
  return sheet;
}

// 去除前後空白、限制長度，並防止以 = + - @ 開頭的內容被當成公式執行
function clean_(v) {
  let s = (v === undefined || v === null) ? '' : String(v).trim().slice(0, 1000);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
