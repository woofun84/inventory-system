/**
 * 审计埋点中间件
 *
 * 对所有 /api 下的写操作（POST/PUT/PATCH/DELETE）在响应结束时落一条审计日志：
 * 记录操作者、模块、动作、对象、路径、IP、HTTP 状态与请求摘要。
 * 只读请求（GET）不记录，避免噪音。
 */
const { record, summarize } = require('../services/audit');
const db = require('../db');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHOD_ACTION = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

// 路径末段若为这些词，视为"动作/子资源"，不算对象标识
const VERBS = ['confirm', 'load', 'batch'];
const NON_TARGET = new Set([...VERBS, 'login', 'change-password', 'next-no', 'next-code', 'docs', 'lines', 'no-rules', 'me', 'orders', 'contracts']);

// 路径首段 → 权限模块名（与 permissions.js 的模块键保持一致）
const PATH_MODULE = {
  auth: 'auth',
  users: 'users',
  materials: 'materials',
  suppliers: 'suppliers',
  inbound: 'inbound',
  'inbound-docs': 'inbound',
  outbound: 'outbound',
  'outbound-docs': 'outbound',
  returns: 'returns',
  purchase: 'purchase',
  stocktakes: 'stocktake',
  params: 'settings',
};

// 路径中无对象标识时，从请求体里找业务主键
const ID_FIELDS = ['doc_no', 'stocktake_no', 'po_no', 'contract_no', 'gin_no', 'grn_no', 'code', 'username'];

function pickTarget(segs, body) {
  for (let i = segs.length - 1; i >= 2; i--) {
    if (!NON_TARGET.has(segs[i])) return segs[i];
  }
  if (body && typeof body === 'object') {
    for (const f of ID_FIELDS) if (body[f]) return String(body[f]);
  }
  return '';
}

// 单据类型 → 审计归口模块
// 采购退货（入库账本）/ 领料退库（出库账本）统一记为 returns，
// 其余单据类型保持 inbound / outbound；历史审计记录不回溯改写。
const RETURN_TXN_TYPES = new Set(['采购退货', '领料退库']);
const DOC_TABLES = { 'inbound-docs': 'inbound_docs', 'outbound-docs': 'outbound_docs' };

function docTxnType(res0, segs, body) {
  const table = DOC_TABLES[res0];
  if (!table) return '';
  // 创建时单据号可能由服务端生成，先看请求体里的 txn_type
  const bodyType = body && typeof body.txn_type === 'string' ? body.txn_type : '';
  if (bodyType) return bodyType;

  // 其余按路径中的单据号查库（如 /api/inbound-docs/RET-xxx/confirm）
  let docNo = segs[2] && !NON_TARGET.has(segs[2]) ? segs[2] : '';
  if (!docNo && body && body.doc_no) docNo = String(body.doc_no);
  if (!docNo) return '';
  try {
    const row = db.prepare(`SELECT txn_type FROM ${table} WHERE doc_no=?`).get(docNo);
    return row ? row.txn_type : '';
  } catch (e) {
    return '';
  }
}

function resolveModule(res0, segs, body) {
  if (RETURN_TXN_TYPES.has(docTxnType(res0, segs, body))) return 'returns';
  return PATH_MODULE[res0] || res0;
}

function auditMiddleware(req, res, next) {
  if (!WRITE_METHODS.has(req.method) || !req.path.startsWith('/api/')) return next();
  // 设置页运维接口由路由自行写审计（含自动备份文件名），这里跳过避免重复/被清库覆盖
  if (req.path.startsWith('/api/settings/')) return next();
  res.on('finish', () => {
    try {
      const segs = req.path.split('/').filter(Boolean); // ['api','materials','CB-0001']
      // 更正确认由路由自行写审计（含原/新数量快照），避免重复记录
      if (segs[segs.length - 1] === 'confirm-correction') return;
      const res0 = segs[1] || '';
      const body = req.body;
      const module = resolveModule(res0, segs, body);

      let action = METHOD_ACTION[req.method] || req.method.toLowerCase();
      for (let i = segs.length - 1; i >= 2; i--) {
        if (VERBS.includes(segs[i])) { action = segs[i]; break; }
      }
      if (res0 === 'auth' && segs[2] === 'login') action = 'login';
      if (res0 === 'auth' && segs[2] === 'change-password') action = 'change-password';

      const u = req.user || {};
      record({
        user_id: u.id || null,
        username: u.username || (body && body.username) || '',
        name: u.name || '',
        role: u.role || '',
        module,
        action,
        target: pickTarget(segs, body),
        method: req.method,
        path: req.originalUrl.split('?')[0],
        ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        status: res.statusCode,
        detail: (action === 'login' || action === 'change-password') ? '' : summarize(body),
      });
    } catch (e) {
      console.error('审计埋点失败:', e.message);
    }
  });
  next();
}

module.exports = { auditMiddleware };
