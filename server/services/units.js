/**
 * 定点数值层（全系统唯一入口）
 *
 * 精度约定（数据库一律存整数）：
 *  - 数量：1e6（至少 6 位小数）
 *  - 单价 / 平均成本：1e8（至少 8 位小数）
 *  - 金额：1e2（人民币分，1 元 = 100 分）
 *
 * 计算一律用 BigInt 定点，避免 float64 精度损失与溢出；
 * 舍入统一 ROUND_HALF_UP（按绝对值四舍五入，负数对称）。
 * 前端仍然收发「元 / 件」的普通数字，转换只发生在服务端出入口。
 */

const QTY_DECIMALS = 6;
const PRICE_DECIMALS = 8;
const AMOUNT_DECIMALS = 2;

const QTY_SCALE = 10n ** BigInt(QTY_DECIMALS);       // 1_000_000
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);   // 100_000_000
const AMOUNT_SCALE = 10n ** BigInt(AMOUNT_DECIMALS); // 100

// 数量(1e6) × 单价(1e8) 的乘积是 1e14，要得到「分」(1e2) 需除以 1e12。
// 与 init-db.js 生成列的除数（1000000000000.0）及 qtyPriceProductToAmount 同口径。
const QTY_PRICE_TO_AMOUNT_DIV = (QTY_SCALE * PRICE_SCALE) / AMOUNT_SCALE; // 1e12

function fail(message) {
  const e = new Error(message);
  e.code = 'INVALID_NUMBER';
  e.status = 400;
  return e;
}

/**
 * 十进制字符串/数字 → 指定小数位的 BigInt 定点值（ROUND_HALF_UP）
 */
function toScaled(value, decimals) {
  if (value === null || value === undefined) return 0n;
  let s = typeof value === 'string' ? value.trim() : String(value);
  if (s === '') return 0n;
  if (!/^[+-]?\d*(\.\d+)?$/.test(s) || s === '+' || s === '-' || s === '.') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw fail(`无效数字：${value}`);
    s = n.toFixed(Math.min(decimals + 2, 12));
  }
  const neg = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  const [ip, fp = ''] = body.split('.');
  const frac = (fp + '0'.repeat(decimals + 1)).slice(0, decimals + 1);
  let big = BigInt((ip || '0') + frac.slice(0, decimals) || '0');
  if (frac[decimals] >= '5') big += 1n;
  return neg ? -big : big;
}

function fromScaled(big, decimals) {
  return Number(big) / Math.pow(10, decimals);
}

// 整数除法 + ROUND_HALF_UP（负数按绝对值对称进位）
function roundDiv(a, b) {
  if (b === 0n) throw fail('除数为 0');
  const neg = (a < 0n) !== (b < 0n);
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = absA / absB;
  const r = absA % absB;
  const rounded = r * 2n >= absB ? q + 1n : q;
  return neg ? -rounded : rounded;
}

// ==================== 进出口转换 ====================

const toQtyInt = (v) => toScaled(v, QTY_DECIMALS);
const toPriceInt = (v) => toScaled(v, PRICE_DECIMALS);
const toAmountInt = (v) => toScaled(v, AMOUNT_DECIMALS);

const fromQtyInt = (v) => fromScaled(v, QTY_DECIMALS);
const fromPriceInt = (v) => fromScaled(v, PRICE_DECIMALS);
const fromAmountInt = (v) => fromScaled(v, AMOUNT_DECIMALS);

// ==================== 核算运算 ====================

// 数量 × 单价 → 金额（分）
function qtyMulPriceToAmount(qtyInt, priceInt) {
  return roundDiv(BigInt(qtyInt) * BigInt(priceInt), QTY_PRICE_TO_AMOUNT_DIV);
}

// 金额 ÷ 数量 → 单价（1e8）；数量为 0 时返回 0
// amount(分) / qty(1e6) = 元/件；× 1e8 得定点单价
function amountDivQtyToPrice(amountCents, qtyInt) {
  const q = BigInt(qtyInt);
  if (q === 0n) return 0n;
  return roundDiv(BigInt(amountCents) * 10n ** 12n, q);
}

// 数量(1e6) × 单价(1e8) 的乘积(1e14) → 金额(1e2)
function qtyPriceProductToAmount(product) {
  return roundDiv(BigInt(product), 10n ** 12n);
}

// 业务便捷方法：以普通数字入参出参
function amountOf(qty, price) {
  return fromAmountInt(qtyMulPriceToAmount(toQtyInt(qty), toPriceInt(price)));
}

function unitPriceOf(amount, qty) {
  return fromPriceInt(amountDivQtyToPrice(toAmountInt(amount), toQtyInt(qty)));
}

// 金额归零判定（尾差处理用）
function isZeroAmount(v) {
  return toAmountInt(v) === 0n;
}

module.exports = {
  QTY_DECIMALS, PRICE_DECIMALS, AMOUNT_DECIMALS,
  QTY_SCALE, PRICE_SCALE, AMOUNT_SCALE,
  toScaled, fromScaled, roundDiv,
  toQtyInt, toPriceInt, toAmountInt,
  fromQtyInt, fromPriceInt, fromAmountInt,
  qtyMulPriceToAmount, amountDivQtyToPrice, qtyPriceProductToAmount,
  amountOf, unitPriceOf, isZeroAmount,
};
