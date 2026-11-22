/**
 * 入库/出库单据鉴权中间件工厂
 *
 * 两类单据的读写、草稿保存、发起更正与更正确认规则完全一致，
 * 差异只在单据头/明细表名、默认业务类型，以及退货（退库）归属哪个权限模块。
 * 路由通过 createDocPermissions({...}) 注入这些差异，避免两套逐行重复的实现。
 */
const db = require('../db');
const { hasGrant } = require('../permissions');

// 表名由路由内部常量注入，仍做一次白名单校验，避免拼接出意外 SQL
const TABLE_NAME = /^[a-z][a-z0-9_]*$/i;

function permDenied(res, code) {
  return res.status(403).json({ error: '权限不足：无该操作权限', code: code || 'PERM_FORBIDDEN' });
}

function checkLogin(req, res) {
  if (req.user) return true;
  res.status(401).json({ error: '未登录' });
  return false;
}

function createDocPermissions({ docTable, lineTable, defaultTxnType, moduleOfTxnType }) {
  if (!TABLE_NAME.test(docTable) || !TABLE_NAME.test(lineTable)) {
    throw new Error('createDocPermissions: 表名不合法');
  }
  if (typeof moduleOfTxnType !== 'function') {
    throw new Error('createDocPermissions: 缺少 moduleOfTxnType');
  }

  const docByNo = docNo => db.prepare(`SELECT txn_type FROM ${docTable} WHERE doc_no=?`).get(docNo);
  const moduleOfDoc = doc => moduleOfTxnType(doc && doc.txn_type);

  // 新建单：按提交的 txn_type 选择模块（退货/退库 → returns，其余 → 本模块）
  function requireTypeAction(action) {
    return (req, res, next) => {
      if (!checkLogin(req, res)) return;
      const txnType = (req.body && req.body.txn_type) || defaultTxnType;
      if (!hasGrant(req.grants, moduleOfTxnType(txnType), action)) return permDenied(res);
      next();
    };
  }

  // 单据读写：按库里的 txn_type 选择模块；单据不存在时交给路由返回 404
  function requireDocAction(action, code) {
    return (req, res, next) => {
      if (!checkLogin(req, res)) return;
      const doc = docByNo(req.params.docNo);
      if (!doc) return next();
      if (!hasGrant(req.grants, moduleOfDoc(doc), action)) return permDenied(res, code);
      next();
    };
  }

  // 下一单号预览：只读，退货/退库归 returns.view，其余归本模块 view
  function requireNextNoView(req, res, next) {
    if (!checkLogin(req, res)) return;
    const txnType = req.query.txnType || defaultTxnType;
    if (!hasGrant(req.grants, moduleOfTxnType(txnType), 'view')) return permDenied(res);
    next();
  }

  // 更正草稿的明细保存与普通草稿共用同一张表：更正草稿按 correct 或 void 放行
  // （void-only 用户需先删空全部明细），普通草稿仍要求 manage，与前端判定一致。
  function requireDocEditOrCorrect(req, res, next) {
    if (!checkLogin(req, res)) return;
    const doc = db.prepare(`SELECT txn_type, corrects_doc_no FROM ${docTable} WHERE doc_no=?`)
      .get(req.params.docNo);
    if (!doc) return next();
    const mod = moduleOfDoc(doc);
    const isCorrDraft = !!String(doc.corrects_doc_no || '').trim();
    const ok = hasGrant(req.grants, mod, 'manage')
      || (isCorrDraft && (hasGrant(req.grants, mod, 'correct') || hasGrant(req.grants, mod, 'void')));
    if (!ok) return permDenied(res);
    next();
  }

  // 发起更正：correct 或 void 均可。void-only 用户走「发起更正 → 删空明细 → 零行确认作废」
  function requireCorrectionStart(req, res, next) {
    if (!checkLogin(req, res)) return;
    const doc = docByNo(req.params.docNo);
    if (!doc) return next();
    const mod = moduleOfDoc(doc);
    if (!hasGrant(req.grants, mod, 'correct') && !hasGrant(req.grants, mod, 'void')) {
      return permDenied(res, 'CORRECT_FORBIDDEN');
    }
    next();
  }

  // 更正草稿确认：有明细 = 更正重开（correct），零行 = 整单作废（void）
  function requireCorrectionAction(req, res, next) {
    if (!checkLogin(req, res)) return;
    const doc = docByNo(req.params.docNo);
    if (!doc) return next();
    const n = db.prepare(`SELECT COUNT(*) c FROM ${lineTable} WHERE doc_no=?`).get(req.params.docNo).c;
    const action = n > 0 ? 'correct' : 'void';
    if (!hasGrant(req.grants, moduleOfDoc(doc), action)) {
      return permDenied(res, action === 'void' ? 'VOID_FORBIDDEN' : 'CORRECT_FORBIDDEN');
    }
    next();
  }

  return {
    requireTypeAction,
    requireDocAction,
    requireNextNoView,
    requireDocEditOrCorrect,
    requireCorrectionStart,
    requireCorrectionAction,
  };
}

module.exports = { createDocPermissions };
