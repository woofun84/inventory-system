/**
 * 系统审计日志
 *
 * 记录"谁在什么时间做了什么"：登录、新增、修改、删除、确认、作废等。
 * 时间统一以 UTC 存储（datetime('now')），前端按浏览器本地时区渲染。
 */
const db = require('../db');
const { packDetail } = require('./logdetail');
const { kwTokens, likeTerm } = require('../utils/search');

// 敏感字段（请求摘要中打码）
const SENSITIVE = /pass|pwd|secret|token/i;
// 价格类字段：没有 price:view 的用户也能看审计日志，读取时必须把摘要里的金额/单价打码，
// 否则等于从 detail 里把脱敏掉的价格又读回来。写入时保留原值，按查看者权限在读取时打码。
const PRICE_LIKE = /price|amount|cost|stock_value|receive_rate/i;

// 把请求体压缩成一行摘要："改了啥 / 删了啥" 的原始素材
function summarize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const out = {};
  Object.keys(body).forEach(k => {
    if (SENSITIVE.test(k)) { out[k] = '***'; return; }
    const v = body[k];
    if (Array.isArray(v)) out[k] = `[${v.length} 项]`;
    else if (v && typeof v === 'object') out[k] = '{…}';
    else out[k] = (typeof v === 'string' && v.length > 100) ? v.slice(0, 100) + '…' : v;
  });
  const s = JSON.stringify(out);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

// 递归把价格类键打码（保留键名，值置为 ***），用于读取时的按权限脱敏
function maskPriceKeys(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(maskPriceKeys);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = PRICE_LIKE.test(k) && (v === null || typeof v !== 'object') ? '***' : maskPriceKeys(v);
  }
  return out;
}

// 读取单条日志时按查看者权限处理 detail / detail_json：
// 请求摘要（JSON 文本）解析后按价格键打码；结构化参数同理；解析失败按原文返回
function maskRowDetail(row, canViewPrice) {
  if (!row || canViewPrice) return row;
  const maskText = (text) => {
    const s = String(text || '').trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return text;
    try { return JSON.stringify(maskPriceKeys(JSON.parse(s))); } catch (e) { return text; }
  };
  row.detail = maskText(row.detail);
  if (row.detail_json) row.detail_json = maskText(row.detail_json);
  return row;
}


function record(entry) {
  try {
    // detail 可传文案对象 {key, params}（结构化），也可传纯文本（请求摘要 / 动态信息）
    const { detail, ...rest } = entry || {};
    const d = packDetail(detail);
    db.prepare(`INSERT INTO audit_logs
      (created_at,user_id,username,name,role,module,action,target,method,path,ip,status,detail,detail_json)
      VALUES (datetime('now'),@user_id,@username,@name,@role,@module,@action,@target,@method,@path,@ip,@status,@detail,@detail_json)`)
      .run({
        user_id: null, username: '', name: '', role: '', module: '', action: '',
        target: '', method: '', path: '', ip: '', status: 200,
        ...rest, detail: d.text, detail_json: d.json,
      });
  } catch (e) {
    // 审计失败不能影响主流程
    console.error('审计日志写入失败:', e.message);
  }
}

// 查询（服务端分页）
// q: { module, action, keyword, fromUtc, toUtc, page, pageSize }
// fromUtc / toUtc 由前端按其本地时区换算出的 UTC 边界（YYYY-MM-DD HH:MM:SS）
// opts.canViewPrice：查看者是否有 price:view，无权限时把摘要里的价格类字段打码
function list(q = {}, opts = {}) {
  const where = [];
  const args = {};
  if (q.module) { where.push('module=@module'); args.module = q.module; }
  if (q.action) { where.push('action=@action'); args.action = q.action; }
  if (q.keyword) {
    kwTokens(q.keyword).forEach((tk, i) => {
      const key = 'kw' + i;
      // 与全站口径一致：% / _ / \ 按字面量匹配，避免关键字里的通配符放大搜索结果
      const like = likeTerm(tk, true);
      where.push(`(username LIKE @${key} ESCAPE '\\' OR name LIKE @${key} ESCAPE '\\' OR target LIKE @${key} ESCAPE '\\' OR detail LIKE @${key} ESCAPE '\\' OR detail_json LIKE @${key} ESCAPE '\\' OR path LIKE @${key} ESCAPE '\\')`);
      args[key] = like;
    });
  }
  if (q.fromUtc) { where.push('created_at >= @fromUtc'); args.fromUtc = q.fromUtc; }
  if (q.toUtc) { where.push('created_at <= @toUtc'); args.toUtc = q.toUtc; }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) c FROM audit_logs' + w).get(args).c;
  const page = Math.max(1, parseInt(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize) || 50));
  const rows = db.prepare(
    `SELECT * FROM audit_logs${w} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
  ).all(args).map(r => maskRowDetail(r, !!opts.canViewPrice));
  return { rows, total, page, pageSize };
}

module.exports = { record, list, summarize, maskRowDetail };
