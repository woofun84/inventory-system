/**
 * 审计埋点中间件
 *
 * 对所有 /api 下的写操作（POST/PUT/PATCH/DELETE）在响应结束时落一条审计日志：
 * 记录操作者、模块、动作、对象、路径、IP、HTTP 状态与请求摘要。
 * 只读请求（GET）不记录，避免噪音。
 */
const { record, summarize } = require('../services/audit');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHOD_ACTION = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

// 路径末段若为这些词，视为"动作/子资源"，不算对象标识
const VERBS = ['confirm', 'cancel', 'reverse', 'load', 'batch'];
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

function auditMiddleware(req, res, next) {
  if (!WRITE_METHODS.has(req.method) || !req.path.startsWith('/api/')) return next();
  res.on('finish', () => {
    try {
      const segs = req.path.split('/').filter(Boolean); // ['api','materials','CB-0001']
      const res0 = segs[1] || '';
      const module = PATH_MODULE[res0] || res0;

      let action = METHOD_ACTION[req.method] || req.method.toLowerCase();
      for (let i = segs.length - 1; i >= 2; i--) {
        if (VERBS.includes(segs[i])) { action = segs[i]; break; }
      }
      if (res0 === 'auth' && segs[2] === 'login') action = 'login';
      if (res0 === 'auth' && segs[2] === 'change-password') action = 'change-password';

      const body = req.body;
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
