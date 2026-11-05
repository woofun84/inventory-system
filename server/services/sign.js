/**
 * 单据数量/单价符号统一推导
 *
 * 约定（全系统唯一入口，路由层只取参与鉴权，不再各自写 Math.abs / 取负）：
 *  - 前端一律输入正数；符号由本模块按「单据类型 + 是否冲销 + 原单方向」推导。
 *  - 入库账本：采购入库/零星入库 存正；采购退货 存负；入库冲销 = 原行符号取反。
 *  - 出库账本：正常出库 存正；退库出库 存负；出库冲销 = 原行符号取反。
 *  - 单价永远为正；金额（qty * price）的符号完全由数量符号决定。
 */

const INBOUND_SIGN = {
  '采购入库': 1,
  '零星入库': 1,
  '采购退货': -1,
};

const OUTBOUND_SIGN = {
  '正常出库': 1,
  '退库出库': -1,
};

const REVERSAL_LEDGER = {
  '入库冲销': 'inbound',
  '出库冲销': 'outbound',
};

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  e.status = 400;
  return e;
}

// 解析出正数数量：拒绝 0、负数、非数字、空值
function toPositiveQty(raw, field) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw fail('INVALID_QTY', `${field || '数量'}必须为正数，不能为空或 0`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw fail('INVALID_QTY', `${field || '数量'}不是有效数字`);
  }
  if (n <= 0) {
    throw fail('INVALID_QTY', `${field || '数量'}必须为正数，不能为 0 或负数`);
  }
  return n;
}

/**
 * 推导并返回「存储用」数量。
 * @param {string} txnType 单据类型
 * @param {number|string} rawQty 前端输入的正数
 * @param {{originalQty?: number}} [opts] 冲销时必传：原明细行的存储数量（可为负）
 * @returns {number} 带符号的存储数量
 */
function normalizeQty(txnType, rawQty, opts) {
  const qty = toPositiveQty(rawQty);
  const ledger = REVERSAL_LEDGER[txnType];
  if (ledger) {
    const origin = Number(opts && opts.originalQty);
    if (!Number.isFinite(origin) || origin === 0) {
      throw fail('INVALID_REVERSAL_ORIGIN', '冲销单缺少有效的原单数量，无法推导符号');
    }
    // 对正数量原单冲销 → 存负；对负数量原单（采购退货/领用退库）冲销 → 存正
    return -Math.sign(origin) * qty;
  }
  const sign = INBOUND_SIGN[txnType] ?? OUTBOUND_SIGN[txnType];
  if (sign === undefined) {
    throw fail('INVALID_TXN_TYPE', `不支持的单据类型：${txnType}`);
  }
  return sign * qty;
}

// 单价统一取正：允许 0（赠品/无成本），拒绝负数与非数字
function normalizePrice(rawPrice) {
  if (rawPrice === null || rawPrice === undefined || String(rawPrice).trim() === '') return 0;
  const n = Number(rawPrice);
  if (!Number.isFinite(n)) {
    throw fail('INVALID_PRICE', '单价不是有效数字');
  }
  if (n < 0) {
    throw fail('INVALID_PRICE', '单价不能为负数');
  }
  return n;
}

// 读取历史/原单上已存储的金额或单价时统一取绝对值（仅用于展示/换算，不参与符号推导）
function storedAbs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

// 数量绝对值（用于累计冲销、可冲销量比较）
function absQty(value) {
  return storedAbs(value);
}

function isReversalType(txnType) {
  return Boolean(REVERSAL_LEDGER[txnType]);
}

function ledgerOf(txnType) {
  if (REVERSAL_LEDGER[txnType]) return REVERSAL_LEDGER[txnType];
  if (INBOUND_SIGN[txnType] !== undefined) return 'inbound';
  if (OUTBOUND_SIGN[txnType] !== undefined) return 'outbound';
  return '';
}

module.exports = {
  normalizeQty,
  normalizePrice,
  storedAbs,
  absQty,
  isReversalType,
  ledgerOf,
};
