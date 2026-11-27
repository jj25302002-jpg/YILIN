/**
 * 亦麟國際顧問｜企業介紹＋諮詢預約＋企業經營者永續快速健檢
 * 網頁表單 → Notion「客戶資料」⇄ Google Sheets（Apps Script）
 *
 * 使用前：
 * 1. Apps Script 編輯器 →「專案設定」→「指令碼屬性」新增：
 *      NOTION_TOKEN = 你的 Notion Integration Secret（ntn_... 或 secret_...）
 * 2. 在 Notion 的「客戶資料」→ 右上「⋯」→「連結」→ 加入你的 integration
 *    （integration 需有「讀取／更新／插入內容」權限，才能自動新增缺少的欄位）
 * 3. 新增 HTML 檔，檔名 index，貼上 index.html 內容
 * 4. 執行一次 testAddCustomer() 完成授權（含寄信權限），確認寫得進 Notion、也收到通知信
 * 5. 部署 →「管理部署作業」→ 編輯 → 版本選「新版本」
 *      類型：網頁應用程式　執行身分：我　誰可以存取：所有人
 *
 * 健檢資料存放方式：
 *  - Notion 欄位「健檢總分」（數字）、「健檢摘要」（各構面平均）
 *  - 完整健檢內容（基本資料、三問、30 題分數與佐證、急迫風險）寫在該筆資料的頁面內文
 *  - 通知信附上完整健檢內容
 */

const NOTION_DATABASE_ID = '41934386b09480d7aae1e17d576963e3';
const NOTION_VERSION = '2022-06-28';
const SHEET_NAME = '客戶資料';

// 收到新預約時通知的信箱（多個請用逗號分隔）
const NOTIFY_EMAIL = 'yilincoltd2023@gmail.com';

// Notion 原有欄位
const BASE_COLUMNS = ['姓名', '公司名稱', '聯繫電話', '行業類別'];

// 預約表單需要、但 Notion 可能還沒有的欄位 → 第一次送出時自動建立
const EXTRA_COLUMNS = {
  '諮詢服務': { rich_text: {} },
  '可諮詢時段': { rich_text: {} },
  'Email': { email: {} },
  '諮詢內容': { rich_text: {} },
  '健檢總分': { number: { format: 'number' } },
  '健檢摘要': { rich_text: {} },
  '填寫時間': { date: {} },
};

// 試算表欄位順序
const COLUMNS = BASE_COLUMNS.concat(Object.keys(EXTRA_COLUMNS));

/* ========== 網頁入口 ========== */

/** 開啟網址時顯示 index.html */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('亦麟國際顧問｜企業諮詢預約與永續快速健檢')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 外部網頁（GitHub Pages、自架網站、本機檔案）用 fetch POST 送資料進來 */
function doPost(e) {
  let result;
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : '';
    let data;
    try { data = JSON.parse(body); } catch (_) { data = (e && e.parameter) || {}; }
    result = submitConsultation(data);
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========== 共用：呼叫 Notion API ========== */

function getToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('請先在「指令碼屬性」設定 NOTION_TOKEN');
  return token;
}

function notionFetch_(path, method, payload) {
  const options = {
    method: method || 'get',
    headers: {
      Authorization: 'Bearer ' + getToken_(),
      'Notion-Version': NOTION_VERSION,
    },
    contentType: 'application/json',
    muteHttpExceptions: true,
  };
  if (payload) options.payload = JSON.stringify(payload);

  const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, options);
  const code = res.getResponseCode();
  const text = res.getContentText();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { message: text }; }
  if (code >= 300) {
    throw new Error('Notion API 錯誤 ' + code + '：' + (body.message || text));
  }
  return body;
}

/** 取得資料庫欄位結構；缺少 EXTRA_COLUMNS 的欄位就自動建立 */
function getSchema_() {
  let db = notionFetch_('/databases/' + NOTION_DATABASE_ID);
  const missing = {};
  Object.keys(EXTRA_COLUMNS).forEach(col => {
    if (!db.properties[col]) missing[col] = EXTRA_COLUMNS[col];
  });
  if (Object.keys(missing).length) {
    db = notionFetch_('/databases/' + NOTION_DATABASE_ID, 'patch', { properties: missing });
  }
  return db.properties;
}

/* ========== 讀取：把 Notion 欄位值轉成純文字 ========== */

function propToValue_(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return prop[prop.type].map(t => t.plain_text).join('');
    case 'number':
      return prop.number === null ? '' : prop.number;
    case 'phone_number':
      return prop.phone_number || '';
    case 'email':
      return prop.email || '';
    case 'url':
      return prop.url || '';
    case 'select':
      return prop.select ? prop.select.name : '';
    case 'multi_select':
      return prop.multi_select.map(s => s.name).join(', ');
    case 'date':
      return prop.date ? prop.date.start : '';
    case 'checkbox':
      return prop.checkbox;
    case 'created_time':
      return prop.created_time || '';
    default:
      return '';
  }
}

/* ========== 寫入：依 Notion 欄位類型轉換值 ========== */

function valueToProp_(type, value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  const text = [{ text: { content: s.slice(0, 2000) } }];
  switch (type) {
    case 'title':        return { title: text };
    case 'rich_text':    return { rich_text: text };
    case 'number': {
      // 保留小數點與負號（健檢總分如 2.45）
      const n = Number(s.replace(/[^\d.\-]/g, ''));
      return { number: s && !isNaN(n) ? n : null };
    }
    case 'phone_number': return { phone_number: s || null };
    case 'email':        return { email: s || null };
    case 'url':          return { url: s || null };
    case 'date':         return { date: s ? { start: s } : null };
    case 'select':       return { select: s ? { name: s.replace(/,/g, ' ').slice(0, 100) } : null };
    case 'multi_select': return { multi_select: s ? s.split(/[,，、\n]/).map(x => ({ name: x.trim().slice(0, 100) })).filter(x => x.name) : [] };
    default:             return null; // 公式、關聯等無法寫入的類型略過
  }
}

/* ========== 核心：寫入一筆諮詢預約 ========== */

/**
 * @param {Object} d { name, company, phone, industry, email, service, message, slots,
 *                     healthcheck, healthSummary, healthScore }
 * 網頁（google.script.run 或 doPost）都呼叫這個函式
 */
function submitConsultation(d) {
  d = d || {};
  const name = String(d.name || '').trim();
  const company = String(d.company || '').trim();
  const phone = String(d.phone || '').trim();
  if (!name) throw new Error('請填寫姓名');
  if (!company) throw new Error('請填寫公司名稱');
  if (!phone) throw new Error('請填寫聯繫電話');

  const record = {
    name: name,
    company: company,
    phone: phone,
    industry: String(d.industry || '').trim(),
    service: String(d.service || '').trim(),
    slots: String(d.slots || '').trim(),
    email: String(d.email || '').trim(),
    message: String(d.message || '').trim(),
    healthcheck: String(d.healthcheck || '').trim().slice(0, 50000),
    healthSummary: String(d.healthSummary || '').trim(),
    healthScore: String(d.healthScore || '').trim(),
    time: new Date(),
  };

  // 1. 寫入 Notion
  let page = null, notionError = null;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    page = writeToNotion_(record);
  } catch (err) {
    notionError = String(err && err.message ? err.message : err);
    Logger.log('Notion 寫入失敗：' + notionError);
  } finally {
    lock.releaseLock();
  }

  // 2. 寄通知信（Notion 失敗也照寄，資料不會遺失）
  let mailError = null;
  try {
    sendNotifyMail_(record, page, notionError);
  } catch (err) {
    mailError = String(err && err.message ? err.message : err);
    Logger.log('通知信寄送失敗：' + mailError);
  }

  // Notion 與通知信都失敗才回報錯誤；至少一邊成功就算收到
  if (notionError && mailError) {
    throw new Error('資料暫時無法送出，請稍後再試（' + notionError + '）');
  }
  return {
    ok: true,
    id: page ? page.id : null,
    url: page ? page.url : null,
    notion: !notionError,
    mailed: !mailError,
  };
}

/** 把長文字切成 Notion 段落區塊（每段 ≤ 1900 字，依換行切） */
function textToBlocks_(text) {
  const blocks = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: buf } }] },
    });
    buf = '';
  };
  text.split('\n').forEach(line => {
    // 「■」開頭的行當作小標題
    if (/^■/.test(line)) {
      flush();
      blocks.push({
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: line.replace(/^■\s*/, '').slice(0, 1900) } }] },
      });
      return;
    }
    while (line.length > 1900) { flush(); buf = line.slice(0, 1900); flush(); line = line.slice(1900); }
    if ((buf + '\n' + line).length > 1900) flush();
    buf = buf ? buf + '\n' + line : line;
  });
  flush();
  return blocks.slice(0, 100); // Notion 單次最多 100 個區塊
}

/** 把一筆預約寫進 Notion */
function writeToNotion_(r) {
  const schema = getSchema_();
  const input = {
    '姓名': r.name,
    '公司名稱': r.company,
    '聯繫電話': r.phone,
    '行業類別': r.industry,
    '諮詢服務': r.service,
    '可諮詢時段': r.slots,
    'Email': r.email,
    '諮詢內容': r.message,
    '健檢總分': r.healthScore,
    '健檢摘要': r.healthSummary,
    '填寫時間': Utilities.formatDate(r.time, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX"),
  };

  const properties = {};
  Object.keys(input).forEach(col => {
    if (!schema[col]) return; // Notion 沒有這個欄位就略過
    const v = input[col];
    if (v === undefined || v === null || String(v).trim() === '') return;
    const prop = valueToProp_(schema[col].type, v);
    if (prop) properties[col] = prop;
  });

  // 標題欄位一定要有；若資料庫的標題欄不叫「姓名」，改寫到實際的標題欄
  const titleCol = Object.keys(schema).find(k => schema[k].type === 'title');
  if (titleCol && !properties[titleCol]) {
    properties[titleCol] = { title: [{ text: { content: r.name } }] };
  }

  const payload = {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: properties,
  };
  // 完整健檢內容寫在頁面內文
  if (r.healthcheck) payload.children = textToBlocks_(r.healthcheck);

  const page = notionFetch_('/pages', 'post', payload);
  Logger.log('已新增：' + r.name + '（' + page.url + '）');
  return page;
}

/* ========== 通知信 ========== */

function esc_(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}

function sendNotifyMail_(r, page, notionError) {
  if (!NOTIFY_EMAIL) return;
  const when = Utilities.formatDate(r.time, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
  const slotCount = r.slots ? r.slots.split('\n').filter(s => s && !/^備註：/.test(s)).length : 0;
  const rows = [
    ['姓名', r.name],
    ['公司名稱', r.company],
    ['聯繫電話', r.phone],
    ['Email', r.email || '（未填）'],
    ['行業類別', r.industry],
    ['諮詢服務', r.service || '（未填）'],
    ['可諮詢時段（' + slotCount + ' 個）', r.slots],
    ['諮詢內容', r.message || '（未填）'],
    ['永續快速健檢', r.healthcheck ? r.healthSummary : '（未填寫）'],
    ['填寫時間', when],
  ];

  const subject = (notionError ? '【需處理】' : '') +
    (r.healthcheck ? '【含健檢】' : '') +
    '新的企業諮詢預約：' + r.company + '／' + r.name;

  const statusLine = notionError
    ? '<p style="color:#B3402E"><b>⚠ 這筆資料沒有寫進 Notion，請手動補登。</b><br>錯誤：' + esc_(notionError) + '</p>'
    : (page ? '<p><a href="' + esc_(page.url) + '">在 Notion 開啟這筆資料</a></p>' : '');

  const hcBlock = r.healthcheck
    ? '<h3 style="margin:24px 0 8px">企業經營者永續快速健檢（完整內容）</h3>' +
      '<div style="background:#F7FAF8;border:1px solid #CBDAD5;padding:12px 16px;font-size:14px">' + esc_(r.healthcheck) + '</div>'
    : '';

  const html =
    '<div style="font-family:Arial,\'Microsoft JhengHei\',sans-serif;color:#12313A;line-height:1.7">' +
    '<h2 style="margin:0 0 12px">亦麟國際｜新的企業諮詢預約</h2>' +
    statusLine +
    '<table style="border-collapse:collapse;min-width:420px">' +
    rows.map(x =>
      '<tr><th style="text-align:left;vertical-align:top;padding:8px 12px;background:#F2F6F4;border:1px solid #CBDAD5;white-space:nowrap">' +
      esc_(x[0]) + '</th><td style="padding:8px 12px;border:1px solid #CBDAD5">' + esc_(x[1]) + '</td></tr>'
    ).join('') +
    '</table>' + hcBlock +
    '<p style="color:#4A6769;font-size:13px;margin-top:16px">此信由網站預約表單自動寄出。' +
    (r.email ? '直接回覆此信即可回信給客戶。' : '') + '</p></div>';

  const plain = rows.map(x => x[0] + '：' + x[1]).join('\n') +
    (r.healthcheck ? '\n\n' + r.healthcheck : '') +
    (notionError ? '\n\n⚠ Notion 寫入失敗：' + notionError : (page ? '\n\nNotion：' + page.url : ''));

  const options = { htmlBody: html, name: '亦麟國際網站預約' };
  if (r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) options.replyTo = r.email;

  MailApp.sendEmail(NOTIFY_EMAIL, subject, plain, options);
}

/** 只測試通知信（不寫 Notion） */
function testNotifyMail() {
  sendNotifyMail_({
    name: '王小明', company: '範例股份有限公司', phone: '0912345678', industry: '製造業',
    service: '企業經營者永續快速健檢', slots: '2026-11-30（一） 09:00–10:30\n2026-12-01（二） 13:30–15:00',
    email: 'test@example.com', message: '測試通知信', time: new Date(),
    healthcheck: '【企業經營者永續快速健檢】\n整體平均：2.4（基礎）｜已作答 30/30\n\n■ 急迫風險\n測試',
    healthSummary: '整體 2.4（30/30 題）', healthScore: '2.40',
  }, null, null);
  Logger.log('已寄出測試信到 ' + NOTIFY_EMAIL + '，今日剩餘額度：' + MailApp.getRemainingDailyQuota());
}

/** 舊介面保留：addCustomer(姓名, 公司名稱, 聯繫電話, 行業類別, 可諮詢時段) */
function addCustomer(name, company, phone, industry, slots) {
  return submitConsultation({ name, company, phone, industry, slots });
}

/* ========== 讀取全部資料 ========== */

/** 取得資料庫所有資料（自動處理分頁，每頁最多 100 筆） */
function getAllCustomers() {
  const rows = [];
  let cursor;
  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const data = notionFetch_('/databases/' + NOTION_DATABASE_ID + '/query', 'post', payload);

    data.results.forEach(page => {
      const row = {};
      COLUMNS.forEach(col => (row[col] = propToValue_(page.properties[col])));
      row.notionId = page.id;
      rows.push(row);
    });

    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

/* ========== 功能 1：測試連線 ========== */

function testConnection() {
  const db = notionFetch_('/databases/' + NOTION_DATABASE_ID);
  Logger.log('連線成功！資料庫名稱：' + db.title.map(t => t.plain_text).join(''));
  Logger.log('欄位：' + Object.keys(db.properties)
    .map(k => k + '(' + db.properties[k].type + ')').join(', '));
}

/* ========== 功能 2：Notion → Google Sheet ========== */

function syncNotionToSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('請從綁定的試算表開啟 Apps Script 再執行同步');
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  const customers = getAllCustomers();
  const header = COLUMNS.concat(['Notion ID']);
  const values = [header].concat(
    customers.map(c => COLUMNS.map(col => c[col]).concat([c.notionId]))
  );

  sheet.clearContents();
  // 電話欄設為純文字，保留開頭的 0
  sheet.getRange(1, COLUMNS.indexOf('聯繫電話') + 1, values.length, 1).setNumberFormat('@');
  sheet.getRange(1, 1, values.length, header.length).setValues(values);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sheet.setFrozenRows(1);

  Logger.log('已同步 ' + customers.length + ' 筆客戶資料');
}

/* ========== 測試 ========== */

/** 先執行這個：完成授權＋確認寫得進 Notion（會新增一筆測試資料） */
function testAddCustomer() {
  const res = submitConsultation({
    name: '王小明',
    company: '範例股份有限公司',
    phone: '0912345678',
    industry: '製造業',
    email: 'test@example.com',
    service: '企業經營者永續快速健檢',
    message: '測試資料，可刪除',
    slots: '2026-11-30（一） 09:00–10:30\n2026-12-01（二） 13:30–15:00',
    healthcheck: '【企業經營者永續快速健檢】\n整體平均：2.4（基礎）｜已作答 30/30\n\n■ 基本資料\n- 公司名稱：範例股份有限公司\n\n■ 急迫風險\n測試資料',
    healthSummary: '整體 2.4（30/30 題）｜策略治理 2.6／財務營運 2.2',
    healthScore: '2.40',
  });
  Logger.log(JSON.stringify(res));
}

/** 模擬外部網頁 POST，確認 doPost 正常 */
function testDoPost() {
  const out = doPost({ postData: { contents: JSON.stringify({
    name: '測試 doPost', company: '測試公司', phone: '0223456789', industry: '其他', slots: '測試時段',
  }) } });
  Logger.log(out.getContent());
}

/* ========== 試算表選單 ========== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Notion')
    .addItem('從 Notion 同步客戶資料', 'syncNotionToSheet')
    .addItem('測試連線', 'testConnection')
    .addToUi();
}
