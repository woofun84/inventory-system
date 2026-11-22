/**
 * 系统审计日志
 *
 * 记录"谁在什么时间做了什么"：登录、新增、修改、删除、确认、作废等。
 * 时间统一以 UTC 存储，前端按浏览器本地时区渲染。
 *
 * 完整性：每条日志带 prev_hash / hash 哈希链（sha256），任何字段被改写或中间行被删除，
 *   verifyChain() 都能定位第一个断点。存量库升级前写入的记录 hash 为空，按「链前遗留」跳过。
 * 独立留痕：清空类操作额外写一份只追加 JSON 行到数据目录 audit-evidence.log，
 *   即使日志表被清空，仍可从该文件追到「谁在何时清空了多少条、清空前的链尾」。
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { DB_PATH } = require('../config');
const { computeHash } = require('./audit-hash');
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

const EVIDENCE_FILE = path.join(path.dirname(DB_PATH), 'audit-evidence.log');
// 只追加留痕：失败不影响主流程（文件权限不足、磁盘满等）
function appendEvidence(entry) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(EVIDENCE_FILE, line, 'utf8');
    return true;
  } catch (e) {
    console.error('[audit] 独立留痕写入失败:', e.message);
    return false;
  }
}

// 当前链尾（最后一条有 hash 的记录）；用于清空前存档
function chainHead() {
  try {
    const row = db.prepare("SELECT id,hash FROM audit_logs WHERE hash IS NOT NULL AND hash != '' ORDER BY id DESC LIMIT 1").get();
    return row ? { id: row.id, hash: row.hash } : { id: 0, hash: '' };
  } catch (e) { return { id: 0, hash: '' }; }
}

function record(entry) {
  try {
    // detail 可传文案对象 {key, params}（结构化），也可传纯文本（请求摘要 / 动态信息）
    const { detail, ...rest } = entry || {};
    const d = packDetail(detail);
    const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const base = {
      user_id: null, username: '', name: '', role: '', module: '', action: '',
      target: '', method: '', path: '', ip: '', status: 200,
      level: 'info', source: 'user',
      ...rest,
      created_at: createdAt,
      detail: d.text,
      detail_json: d.json,
    };
    const last = db.prepare('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1').get();
    const prevHash = last && last.hash ? last.hash : '';
    base.prev_hash = prevHash;
    base.hash = computeHash(base, prevHash);
    db.prepare(`INSERT INTO audit_logs
      (created_at,user_id,username,name,role,module,action,target,method,path,ip,status,level,source,detail,detail_json,prev_hash,hash)
      VALUES (@created_at,@user_id,@username,@name,@role,@module,@action,@target,@method,@path,@ip,@status,@level,@source,@detail,@detail_json,@prev_hash,@hash)`)
      .run(base);
  } catch (e) {
    // 审计失败不能影响主流程
    console.error('审计日志写入失败:', e.message);
  }
}

// 完整性校验：按 id 顺序逐行重算 hash，并检查 prev_hash 与上一行是否衔接。
// 返回第一个断点；hash 为空的历史记录按「链前遗留」跳过，但参与 prev_hash 衔接判断。
function verifyChain() {
  const rows = db.prepare('SELECT id,created_at,user_id,username,name,role,module,action,target,method,path,ip,status,level,source,detail,detail_json,prev_hash,hash FROM audit_logs ORDER BY id').all();
  let prev = '';
  let checked = 0;
  let legacy = 0;
  for (const r of rows) {
    if (!r.hash) { legacy++; continue; }
    if (r.prev_hash !== prev || computeHash(r, r.prev_hash) !== r.hash) {
      return { ok: false, total: rows.length, checked, legacy, brokenId: r.id };
    }
    prev = r.hash;
    checked++;
  }
  return { ok: true, total: rows.length, checked, legacy, brokenId: null };
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

module.exports = { record, list, verifyChain, chainHead, appendEvidence, EVIDENCE_FILE, summarize, maskRowDetail };
