/**
 * 亦麟國際顧問｜企業介紹・永續快速健檢・諮詢預約
 * 網頁表單 → Notion ⇄ Google Sheets ＋ Email 通知（Apps Script）
 *
 * 使用前：
 * 1. Apps Script 編輯器 →「專案設定」→「指令碼屬性」新增：
 *      NOTION_TOKEN = 你的 Notion Integration Secret（ntn_... 或 secret_...）
 * 2. 在 Notion 的資料庫 → 右上「⋯」→「連結」→ 加入你的 integration
 *    （integration 需有「讀取／更新／插入內容」權限，才能自動新增缺少的欄位）
 * 3. 新增 HTML 檔，檔名 index，貼上 index.html 內容
 * 4. 依序執行 testNotifyMail()、testAddCustomer()、testHealthCheck()
 *    完成授權（Notion 連線＋寄信），確認 Notion 有新資料、信箱有收到通知
 * 5. 部署 →「管理部署作業」→ 編輯 → 版本選「新版本」
 *      類型：網頁應用程式　執行身分：我　誰可以存取：所有人
 */

/* ========== 設定 ========== */

// 「客戶資料」資料庫（諮詢預約寫這裡）
const NOTION_DATABASE_ID = '41934386b09480d7aae1e17d576963e3';

// 「永續快速健檢」資料庫：留空 = 一起寫進「客戶資料」，用「表單類型」欄位區分
// 若要分開存，在 Notion 建一個新資料庫、連結 integration，把它的 ID 貼在這裡
const HEALTH_DATABASE_ID = '';

const NOTION_VERSION = '2022-06-28';

// 收到新資料時通知的信箱（多個請用逗號分隔）
const NOTIFY_EMAIL = 'yilincoltd2023@gmail.com';

// 同步到試算表的分頁名稱
const SHEET_NAME = '客戶資料';
const HEALTH_SHEET_NAME = '永續健檢';

/* ========== 健檢題目（對應 YILIN-Notion-Questions.csv） ========== */

const HC_DIMS = [
  { name: '策略與治理', q: ['三至十年經營願景', '永續納入經營策略', '永續負責人及權責', '法規遵循及風險制度', '永續預算'] },
  { name: '財務與營運', q: ['產品或部門獲利分析', '能源及資源成本分析', '部門績效及營運KPI', '永續財務風險與機會', '營運持續及危機計畫'] },
  { name: '環境與碳管理', q: ['能源數據完整記錄', '組織溫室氣體盤查', '主要產品碳足跡', '減碳及能源改善目標', '水、廢棄物及污染管理'] },
  { name: '人才與社會責任', q: ['薪資福利及人權制度', '職業安全衛生制度', '員工教育訓練', '員工申訴及回饋', '關鍵人才流失風險'] },
  { name: '供應鏈與資訊揭露', q: ['客戶ESG及減碳要求', '供應商永續評估', '利害關係人溝通', '重大性議題分析', '永續資訊蒐集及揭露'] },
  { name: '組織制度與傳承', q: ['創辦人不在場仍可營運', '部門權責及授權', '核心流程及知識傳承SOP', '接班人才培育', '股權、經營權及文化傳承'] },
];
const HC_QUESTIONS = [];
HC_DIMS.forEach((d, di) => d.q.forEach((t, qi) => {
  const n = di * 5 + qi + 1;
  HC_QUESTIONS.push({ id: 'Q' + (n < 10 ? '0' + n : n), dim: d.name, text: t });
}));

const HC_BASIC = [
  ['company', '公司名稱'], ['contactName', '填寫人姓名'], ['contactTitle', '職稱'],
  ['phone', '聯繫電話'], ['email', 'Email'], ['date', '填寫日期'],
  ['industryProduct', '產業及產品'], ['foundedStaff', '成立年份／員工數'],
  ['revenueOwnership', '營業額／股權結構'], ['factory', '工廠所在地'],
  ['markets', '出口市場／主要客戶'], ['top3', '前三大客戶營收占比'],
  ['certs', '現有認證／盤查經驗'], ['customerReq', '客戶永續要求及期限'],
  ['owner', '永續負責人／報告經驗'], ['plans', '擴廠融資及接班計畫'],
];
const HC_THREE = [
  ['q1', '現在的企業是什麼？'],
  ['q2', '按照現況，未來企業會成為什麼？'],
  ['q3', '十年後希望企業成為什麼？現行流程能否支持？'],
];
const SCORE_LABEL = { '0': '0 未開始', '1': '1 認知', '2': '2 基礎', '3': '3 制度', '4': '4 績效', '5': '5 優化', NA: '不適用', UNK: '不清楚' };
const LEVELS = ['未開始', '認知', '基礎', '制度', '績效', '優化'];

/* ========== Notion 欄位 ========== */

// 兩種表單共用的欄位（缺少時自動建立）
const COMMON_COLUMNS = {
  '表單類型': { select: { options: [{ name: '諮詢預約', color: 'blue' }, { name: '永續健檢', color: 'green' }] } },
  'Email': { email: {} },
  '填寫時間': { date: {} },
};
// 諮詢預約用
const BOOKING_COLUMNS = {
  '諮詢服務': { rich_text: {} },
  '可諮詢時段': { rich_text: {} },
  '諮詢內容': { rich_text: {} },
};
// 永續健檢用（每題答案與完整內容寫在 Notion 頁面內文）
const HEALTH_COLUMNS = (() => {
  const c = { '健檢總分': { number: { format: 'number' } } };
  HC_DIMS.forEach(d => (c[d.name] = { number: { format: 'number' } }));
  c['急迫風險'] = { rich_text: {} };
  c['職稱'] = { rich_text: {} };
  return c;
})();

// 試算表欄位順序
const BASE_COLUMNS = ['姓名', '公司名稱', '聯繫電話', '行業類別'];
const SHEET_COLUMNS = BASE_COLUMNS
  .concat(Object.keys(COMMON_COLUMNS), Object.keys(BOOKING_COLUMNS), Object.keys(HEALTH_COLUMNS));

/* ========== 網頁入口 ========== */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('亦麟國際顧問｜企業介紹・永續健檢・諮詢預約')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 外部網頁用 fetch POST 送資料進來；type = booking（預設）或 healthcheck */
function doPost(e) {
  let result;
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : '';
    let data;
    try { data = JSON.parse(body); } catch (_) { data = (e && e.parameter) || {}; }
    result = data.type === 'healthcheck' ? submitHealthCheck(data) : submitConsultation(data);
  } catch (err) {
    result = { ok: false, error: errMsg_(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========== 共用工具 ========== */

function errMsg_(err) { return String(err && err.message ? err.message : err); }
function str_(v) { return String(v === undefined || v === null ? '' : v).trim(); }
function nowIso_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function fmt_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm'); }

function getToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('請先在「指令碼屬性」設定 NOTION_TOKEN');
  return token;
}

function notionFetch_(path, method, payload) {
  const options = {
    method: method || 'get',
    headers: { Authorization: 'Bearer ' + getToken_(), 'Notion-Version': NOTION_VERSION },
    contentType: 'application/json',
    muteHttpExceptions: true,
  };
  if (payload) options.payload = JSON.stringify(payload);

  const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, options);
  const code = res.getResponseCode();
  const text = res.getContentText();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { message: text }; }
  if (code >= 300) throw new Error('Notion API 錯誤 ' + code + '：' + (body.message || text));
  return body;
}

/** 取得資料庫欄位；spec 裡缺少的欄位自動建立 */
function ensureSchema_(dbId, spec) {
  let db = notionFetch_('/databases/' + dbId);
  const missing = {};
  Object.keys(spec).forEach(col => { if (!db.properties[col]) missing[col] = spec[col]; });
  // 「表單類型」若已存在但缺選項，Notion 寫入 select 時會自動新增選項，不需處理
  if (Object.keys(missing).length) {
    db = notionFetch_('/databases/' + dbId, 'patch', { properties: missing });
  }
  return db.properties;
}

/* ---------- Notion 值轉換 ---------- */

function propToValue_(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
    case 'rich_text': return prop[prop.type].map(t => t.plain_text).join('');
    case 'number': return prop.number === null ? '' : prop.number;
    case 'phone_number': return prop.phone_number || '';
    case 'email': return prop.email || '';
    case 'url': return prop.url || '';
    case 'select': return prop.select ? prop.select.name : '';
    case 'multi_select': return prop.multi_select.map(s => s.name).join(', ');
    case 'date': return prop.date ? prop.date.start : '';
    case 'checkbox': return prop.checkbox;
    case 'created_time': return prop.created_time || '';
    default: return '';
  }
}

function valueToProp_(type, value) {
  if (type === 'number' && typeof value === 'number') return { number: isFinite(value) ? value : null };
  const s = str_(value);
  const text = rt_(s);
  switch (type) {
    case 'title': return { title: text };
    case 'rich_text': return { rich_text: text };
    case 'number': {
      const n = Number(s.replace(/\D/g, '')); // 文字型電話寫進數字欄
      return { number: s && !isNaN(n) ? n : null };
    }
    case 'phone_number': return { phone_number: s || null };
    case 'email': return { email: s || null };
    case 'url': return { url: s || null };
    case 'date': return { date: s ? { start: s } : null };
    case 'select': return { select: s ? { name: s.replace(/,/g, ' ').slice(0, 100) } : null };
    case 'multi_select': return { multi_select: s ? s.split(/[,，、\n]/).map(x => ({ name: x.trim().slice(0, 100) })).filter(x => x.name) : [] };
    default: return null; // 公式、關聯等無法寫入的類型略過
  }
}

/** 依資料庫欄位類型組出 properties；沒有的欄位略過 */
function buildProps_(schema, input, titleText) {
  const properties = {};
  Object.keys(input).forEach(col => {
    if (!schema[col]) return;
    const v = input[col];
    if (v === undefined || v === null || (typeof v !== 'number' && str_(v) === '')) return;
    const prop = valueToProp_(schema[col].type, v);
    if (prop) properties[col] = prop;
  });
  const titleCol = Object.keys(schema).find(k => schema[k].type === 'title');
  if (titleCol && !properties[titleCol]) properties[titleCol] = { title: rt_(titleText) };
  return properties;
}

/* ---------- Notion 頁面內文區塊 ---------- */

/** rich_text：每段最多 2000 字，最多 100 段 */
function rt_(text, bold) {
  const s = str_(text);
  const out = [];
  for (let i = 0; i < s.length && out.length < 100; i += 2000) {
    const o = { type: 'text', text: { content: s.slice(i, i + 2000) } };
    if (bold) o.annotations = { bold: true };
    out.push(o);
  }
  return out.length ? out : [{ type: 'text', text: { content: '' } }];
}
function h2_(t) { return { object: 'block', type: 'heading_2', heading_2: { rich_text: rt_(t) } }; }
function h3_(t) { return { object: 'block', type: 'heading_3', heading_3: { rich_text: rt_(t) } }; }
function p_(t) { return { object: 'block', type: 'paragraph', paragraph: { rich_text: rt_(t) } }; }
function li_(label, value) {
  return {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: rt_(label + '：', true).concat(value ? rt_(value) : []) },
  };
}
function callout_(t, emoji) {
  return { object: 'block', type: 'callout', callout: { rich_text: rt_(t), icon: { type: 'emoji', emoji: emoji || '📌' } } };
}
function table_(header, rows) {
  const row = cells => ({ object: 'block', type: 'table_row', table_row: { cells: cells.map(c => (str_(c) ? rt_(c) : [])) } });
  return {
    object: 'block', type: 'table',
    table: {
      table_width: header.length, has_column_header: true, has_row_header: false,
      children: [row(header)].concat(rows.map(row)),
    },
  };
}

/* ---------- 通知信 ---------- */

function esc_(v) {
  return str_(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}
function htmlTable_(rows, header) {
  const th = 'text-align:left;vertical-align:top;padding:6px 10px;background:#F2F6F4;border:1px solid #CBDAD5;white-space:nowrap';
  const td = 'padding:6px 10px;border:1px solid #CBDAD5;vertical-align:top';
  let h = '<table style="border-collapse:collapse;margin:6px 0 16px">';
  if (header) h += '<tr>' + header.map(x => '<th style="' + th + '">' + esc_(x) + '</th>').join('') + '</tr>';
  h += rows.map(r => '<tr>' + r.map((c, i) =>
    '<' + (i === 0 && !header ? 'th' : 'td') + ' style="' + (i === 0 && !header ? th : td) + '">' + esc_(c) +
    '</' + (i === 0 && !header ? 'th' : 'td') + '>').join('') + '</tr>').join('');
  return h + '</table>';
}

function sendMail_(subject, sections, page, notionError, replyTo) {
  if (!NOTIFY_EMAIL) return;
  const status = notionError
    ? '<p style="color:#B3402E"><b>⚠ 這筆資料沒有寫進 Notion，請手動補登（完整內容如下）。</b><br>錯誤：' + esc_(notionError) + '</p>'
    : (page ? '<p><a href="' + esc_(page.url) + '">在 Notion 開啟這筆資料</a></p>' : '');
  const html =
    '<div style="font-family:Arial,\'Microsoft JhengHei\',sans-serif;color:#12313A;line-height:1.7;font-size:14px">' +
    '<h2 style="margin:0 0 10px">' + esc_(subject) + '</h2>' + status +
    sections.map(s => (s.title ? '<h3 style="margin:18px 0 4px">' + esc_(s.title) + '</h3>' : '') +
      (s.rows ? htmlTable_(s.rows, s.header) : '') + (s.text ? '<p>' + esc_(s.text) + '</p>' : '')).join('') +
    '<p style="color:#4A6769;font-size:12px;margin-top:16px">此信由亦麟國際網站表單自動寄出。' +
    (replyTo ? '直接回覆此信即可回信給客戶。' : '') + '</p></div>';
  const plain = sections.map(s => (s.title ? '【' + s.title + '】\n' : '') +
    (s.rows ? s.rows.map(r => r.join('｜')).join('\n') : '') + (s.text ? s.text : '')).join('\n\n') +
    (notionError ? '\n\n⚠ Notion 寫入失敗：' + notionError : (page ? '\n\nNotion：' + page.url : ''));
  const options = { htmlBody: html, name: '亦麟國際網站' };
  if (replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) options.replyTo = replyTo;
  MailApp.sendEmail(NOTIFY_EMAIL, (notionError ? '【需處理】' : '') + subject, plain, options);
}

/** 寫 Notion → 寄信；Notion 失敗也照寄，兩邊都失敗才回報錯誤 */
function saveAndNotify_(writeFn, mailFn) {
  let page = null, notionError = null, mailError = null;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { page = writeFn(); } catch (err) { notionError = errMsg_(err); Logger.log('Notion 寫入失敗：' + notionError); }
  finally { lock.releaseLock(); }
  try { mailFn(page, notionError); } catch (err) { mailError = errMsg_(err); Logger.log('通知信寄送失敗：' + mailError); }
  if (notionError && mailError) throw new Error('資料暫時無法送出，請稍後再試（' + notionError + '）');
  return { ok: true, id: page ? page.id : null, url: page ? page.url : null, notion: !notionError, mailed: !mailError };
}

/* ========== 表單 1：諮詢預約 ========== */

/**
 * @param {Object} d { name, company, phone, industry, email, service, message, slots }
 */
function submitConsultation(d) {
  d = d || {};
  const r = {
    name: str_(d.name), company: str_(d.company), phone: str_(d.phone),
    industry: str_(d.industry), service: str_(d.service), slots: str_(d.slots),
    email: str_(d.email), message: str_(d.message), time: new Date(),
  };
  if (!r.name) throw new Error('請填寫姓名');
  if (!r.company) throw new Error('請填寫公司名稱');
  if (!r.phone) throw new Error('請填寫聯繫電話');

  return saveAndNotify_(
    () => {
      const schema = ensureSchema_(NOTION_DATABASE_ID, Object.assign({}, COMMON_COLUMNS, BOOKING_COLUMNS));
      const page = notionFetch_('/pages', 'post', {
        parent: { database_id: NOTION_DATABASE_ID },
        properties: buildProps_(schema, {
          '姓名': r.name, '公司名稱': r.company, '聯繫電話': r.phone, '行業類別': r.industry,
          '表單類型': '諮詢預約', '諮詢服務': r.service, '可諮詢時段': r.slots,
          'Email': r.email, '諮詢內容': r.message, '填寫時間': nowIso_(r.time),
        }, r.name),
      });
      Logger.log('已新增預約：' + r.name + '（' + page.url + '）');
      return page;
    },
    (page, notionError) => {
      const n = r.slots ? r.slots.split('\n').filter(Boolean).length : 0;
      sendMail_('新的企業諮詢預約：' + r.company + '／' + r.name, [{
        rows: [
          ['姓名', r.name], ['公司名稱', r.company], ['聯繫電話', r.phone], ['Email', r.email || '（未填）'],
          ['行業類別', r.industry], ['諮詢服務', r.service || '（未填）'],
          ['可諮詢時段（' + n + ' 個）', r.slots], ['諮詢內容', r.message || '（未填）'], ['填寫時間', fmt_(r.time)],
        ],
      }], page, notionError, r.email);
    }
  );
}

/** 舊介面保留：addCustomer(姓名, 公司名稱, 聯繫電話, 行業類別, 可諮詢時段) */
function addCustomer(name, company, phone, industry, slots) {
  return submitConsultation({ name, company, phone, industry, slots });
}

/* ========== 表單 2：永續快速健檢 ========== */

/** 計分：0–5 才列入平均，不適用／不清楚不計 */
function scoreHealth_(answers) {
  const all = [];
  let unk = 0, na = 0;
  const dims = HC_DIMS.map(d => {
    const vals = [];
    HC_QUESTIONS.filter(q => q.dim === d.name).forEach(q => {
      const s = str_((answers[q.id] || {}).s);
      if (/^[0-5]$/.test(s)) { vals.push(+s); all.push(+s); }
      else if (s === 'UNK') unk++;
      else if (s === 'NA') na++;
    });
    return { name: d.name, avg: vals.length ? round1_(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
  });
  const overall = all.length ? round1_(all.reduce((a, b) => a + b, 0) / all.length) : null;
  return { dims, overall, unk, na };
}
function round1_(x) { return Math.round(x * 10) / 10; }

/**
 * @param {Object} d { basic:{company, contactName, phone, ...}, three:{q1,q2,q3},
 *                     answers:{Q01:{s:'0'~'5'|'NA'|'UNK', e:'佐證'}...}, urgent }
 */
function submitHealthCheck(d) {
  d = d || {};
  const basic = {};
  HC_BASIC.forEach(([k]) => (basic[k] = str_((d.basic || {})[k]).slice(0, 1500)));
  const three = {};
  HC_THREE.forEach(([k]) => (three[k] = str_((d.three || {})[k]).slice(0, 1500)));
  const answers = {};
  HC_QUESTIONS.forEach(q => {
    const a = (d.answers || {})[q.id] || {};
    const s = str_(a.s);
    answers[q.id] = { s: SCORE_LABEL[s] ? s : '', e: str_(a.e).slice(0, 300) };
  });
  const urgent = str_(d.urgent).slice(0, 1500);

  if (!basic.company) throw new Error('請填寫公司名稱');
  if (!basic.contactName) throw new Error('請填寫填寫人姓名');
  if (!basic.phone) throw new Error('請填寫聯繫電話');
  const missing = HC_QUESTIONS.filter(q => !answers[q.id].s).map(q => q.id);
  if (missing.length) throw new Error('自評還有 ' + missing.length + ' 題未作答（' + missing.join('、') + '）');

  const sc = scoreHealth_(answers);
  const time = new Date();
  const dbId = HEALTH_DATABASE_ID || NOTION_DATABASE_ID;
  const scoreText = v => (v === null ? '—' : v.toFixed(1));
  const lowItems = HC_QUESTIONS.filter(q => ['0', '1'].includes(answers[q.id].s));

  return saveAndNotify_(
    () => {
      const schema = ensureSchema_(dbId, Object.assign({}, COMMON_COLUMNS, HEALTH_COLUMNS));
      const input = {
        '姓名': basic.contactName, '公司名稱': basic.company, '聯繫電話': basic.phone,
        '行業類別': basic.industryProduct, 'Email': basic.email, '職稱': basic.contactTitle,
        '表單類型': '永續健檢', '填寫時間': nowIso_(time), '急迫風險': urgent,
        '健檢總分': sc.overall,
      };
      sc.dims.forEach(dm => (input[dm.name] = dm.avg));

      // 頁面內文：依《企業經營者永續快速健檢》範本排版
      const children = [
        callout_('企業機密；自評不等同正式查證。網站填寫於 ' + fmt_(time) + '。', '🔒'),
        h2_('基本資料'),
      ];
      HC_BASIC.forEach(([k, label]) => children.push(li_(label, basic[k])));
      children.push(h2_('經營者三問'));
      HC_THREE.forEach(([k, label]) => { children.push(h3_(label)); children.push(p_(three[k] || '（未填）')); });

      children.push(h2_('30題成熟度自評'));
      children.push(p_('0 未開始；1 認知；2 基礎；3 制度；4 績效；5 優化；不適用；不清楚。'));
      children.push(p_('整體平均 ' + scoreText(sc.overall) + ' 分' +
        (sc.overall !== null ? '（約「' + LEVELS[Math.round(sc.overall)] + '」階段）' : '') +
        '；不清楚 ' + sc.unk + ' 題、不適用 ' + sc.na + ' 題，未列入平均。'));
      HC_DIMS.forEach((dm, di) => {
        children.push(h3_(dm.name + '（平均 ' + scoreText(sc.dims[di].avg) + '）'));
        children.push(table_(['題號', '問題', '分數', '佐證'],
          HC_QUESTIONS.filter(q => q.dim === dm.name)
            .map(q => [q.id, q.text, SCORE_LABEL[answers[q.id].s] || '', answers[q.id].e])));
      });

      children.push(h2_('急迫風險'));
      children.push(p_('最急迫的法遵、職安、人權或客戶期限：' + (urgent || '（未填）')));

      children.push(h2_('顧問診斷'));
      if (lowItems.length) {
        children.push(callout_('自評 0–1 分題目：' + lowItems.map(q => q.id + ' ' + q.text).join('、'), '⚠️'));
      }
      ['管理缺口', '重大議題初篩', '90天行動／責任人／期限／KPI', '建議服務及追蹤']
        .forEach(t => children.push(li_(t, '')));
      children.push(p_('正式重大性分析銜接 ESG-02、03；完整診斷銜接 ESG-04。'));

      const page = notionFetch_('/pages', 'post', {
        parent: { database_id: dbId },
        icon: { type: 'emoji', emoji: '🌱' },
        properties: buildProps_(schema, input, basic.contactName),
        children: children,
      });
      Logger.log('已新增健檢：' + basic.company + '（' + page.url + '）');
      return page;
    },
    (page, notionError) => {
      sendMail_('新的永續快速健檢：' + basic.company + '／' + basic.contactName, [
        { title: '健檢結果', rows: [['整體平均', scoreText(sc.overall) + ' 分（不清楚 ' + sc.unk + '、不適用 ' + sc.na + '）']]
          .concat(sc.dims.map(dm => [dm.name, scoreText(dm.avg)])) },
        lowItems.length ? { title: '建議優先關注（0–1 分）', text: lowItems.map(q => q.id + ' ' + q.text + '（' + q.dim + '）').join('\n') } : null,
        { title: '急迫風險', text: urgent || '（未填）' },
        { title: '基本資料', rows: HC_BASIC.map(([k, label]) => [label, basic[k] || '（未填）']) },
        { title: '經營者三問', rows: HC_THREE.map(([k, label]) => [label, three[k] || '（未填）']) },
        { title: '30 題作答', header: ['題號', '構面', '問題', '分數', '佐證'],
          rows: HC_QUESTIONS.map(q => [q.id, q.dim, q.text, SCORE_LABEL[answers[q.id].s] || '', answers[q.id].e]) },
      ].filter(Boolean), page, notionError, basic.email);
    }
  );
}

/* ========== 同步到試算表 ========== */

function queryAll_(dbId, columns) {
  const rows = [];
  let cursor;
  do {
    const payload = { page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const data = notionFetch_('/databases/' + dbId + '/query', 'post', payload);
    data.results.forEach(page => {
      const row = {};
      columns.forEach(col => (row[col] = propToValue_(page.properties[col])));
      row.notionId = page.id;
      row.notionUrl = page.url;
      rows.push(row);
    });
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

/** 舊介面保留 */
function getAllCustomers() { return queryAll_(NOTION_DATABASE_ID, SHEET_COLUMNS); }

function writeSheet_(sheetName, columns, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('請從綁定的試算表開啟 Apps Script 再執行同步');
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  const header = columns.concat(['Notion 連結']);
  const values = [header].concat(rows.map(c => columns.map(col => c[col]).concat([c.notionUrl])));
  sheet.clearContents();
  const phoneIdx = columns.indexOf('聯繫電話');
  if (phoneIdx >= 0) sheet.getRange(1, phoneIdx + 1, values.length, 1).setNumberFormat('@'); // 保留開頭的 0
  sheet.getRange(1, 1, values.length, header.length).setValues(values);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  Logger.log(sheetName + '：已同步 ' + rows.length + ' 筆');
}

function syncNotionToSheet() {
  writeSheet_(SHEET_NAME, SHEET_COLUMNS, getAllCustomers());
  if (HEALTH_DATABASE_ID) {
    const cols = BASE_COLUMNS.concat(Object.keys(COMMON_COLUMNS), Object.keys(HEALTH_COLUMNS));
    writeSheet_(HEALTH_SHEET_NAME, cols, queryAll_(HEALTH_DATABASE_ID, cols));
  }
}

/* ========== 測試 ========== */

function testConnection() {
  [NOTION_DATABASE_ID, HEALTH_DATABASE_ID].filter(Boolean).forEach(id => {
    const db = notionFetch_('/databases/' + id);
    Logger.log('連線成功！資料庫：' + db.title.map(t => t.plain_text).join(''));
    Logger.log('欄位：' + Object.keys(db.properties).map(k => k + '(' + db.properties[k].type + ')').join(', '));
  });
}

/** 只測試寄信（不寫 Notion） */
function testNotifyMail() {
  sendMail_('測試通知信', [{ rows: [['說明', '收到這封信代表寄信設定正常']] }], null, null, null);
  Logger.log('已寄出測試信到 ' + NOTIFY_EMAIL + '，今日剩餘額度：' + MailApp.getRemainingDailyQuota());
}

/** 測試諮詢預約（會新增一筆測試資料，可在 Notion 刪除） */
function testAddCustomer() {
  Logger.log(JSON.stringify(submitConsultation({
    name: '王小明', company: '範例股份有限公司', phone: '0912345678', industry: '製造業',
    email: 'test@example.com', service: '企業健檢', message: '測試資料，可刪除',
    slots: '2026-11-30（一） 09:00–10:30\n2026-12-01（二） 13:30–15:00',
  })));
}

/** 測試永續健檢（會新增一筆測試資料，可在 Notion 刪除） */
function testHealthCheck() {
  const answers = {};
  const pick = ['0', '1', '2', '3', '4', '5', 'NA', 'UNK'];
  HC_QUESTIONS.forEach((q, i) => (answers[q.id] = { s: pick[i % 8], e: i % 3 === 0 ? '測試佐證' : '' }));
  Logger.log(JSON.stringify(submitHealthCheck({
    basic: {
      company: '範例股份有限公司', contactName: '王小明', contactTitle: '總經理', phone: '0912345678',
      email: 'test@example.com', date: '2026-11-27', industryProduct: '金屬加工／汽車零組件',
      foundedStaff: '1998／120 人', top3: '65%', customerReq: '客戶要求 2027 年前提供產品碳足跡',
    },
    three: { q1: '測試', q2: '測試', q3: '測試' },
    answers: answers,
    urgent: '測試資料，可刪除',
  })));
}

/* ========== 試算表選單 ========== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Notion')
    .addItem('從 Notion 同步資料', 'syncNotionToSheet')
    .addItem('測試連線', 'testConnection')
    .addToUi();
}
