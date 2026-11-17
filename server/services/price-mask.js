/**
 * 价格字段脱敏
 * - 权限口径复用 requireAuth 写入的 req.canViewPrice（price:view，admin 恒真），这里不重新判角色；
 * - 无权限时直接把键删掉（不返回 0/null），数量类字段不动；
 * - 有权限时原样返回，键名与层级保持不变。
 */
function dropKeys(row, keys) {
  if (row && typeof row === 'object') keys.forEach(k => { delete row[k]; });
  return row;
}

function maskRows(req, rows, keys) {
  if (req.canViewPrice || !Array.isArray(rows)) return rows;
  rows.forEach(r => dropKeys(r, keys));
  return rows;
}

// ==================== 价格写入校验 ====================
// 没有 price:edit 的用户不允许提交价格类字段。
// 口径：字段存在且数值大于 0 才算「试图写价格」；0 / 空值视为未填（导入模板的期初单价列默认为空）。
// 只认这些明确的价格/金额键名，避免把数量、比率等无关字段误判。
const PRICE_WRITE_KEYS = new Set([
  'price', 'cost_price', 'unit_price', 'order_price', 'opening_price', 'avg_price', 'avg_cost',
  'amount', 'order_amount', 'cost_amount', 'total_amount', 'received_amount', 'ledger_amount',
  'ledger_price', 'stock_value', 'receive_rate', 'cost_basis',
]);

function findPriceWrite(value, path, depth) {
  if (value === null || value === undefined || depth > 6) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findPriceWrite(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (PRICE_WRITE_KEYS.has(k)) {
      const n = Number(v);
      if (v !== '' && v !== null && Number.isFinite(n) && Math.abs(n) > 0) return p;
    }
    const hit = findPriceWrite(v, p, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 挂在写接口上的中间件：无价格编辑权限却提交了价格字段 → 403（拒绝，不静默丢弃）
function requirePriceEdit(req, res, next) {
  if (req.canEditPrice) return next();
  if (!findPriceWrite(req.body, '', 0)) return next();
  return res.status(403).json({
    code: 'PRICE_EDIT_FORBIDDEN',
    error: '无价格编辑权限，不能提交价格或金额字段',
    error_en: 'You do not have permission to set prices or amounts.',
  });
}

module.exports = { maskRows, requirePriceEdit };
