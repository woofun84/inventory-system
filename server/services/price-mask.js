/**
 * 价格字段脱敏
 * - 权限口径复用 requireAuth 写入的 req.canViewPrice（admin/manager 为真），这里不重新判角色；
 * - 无权限时直接把键删掉（不返回 0/null），数量类字段不动；
 * - 有权限时原样返回，键名与层级保持不变。
 */
function dropKeys(row, keys) {
  if (row && typeof row === 'object') keys.forEach(k => { delete row[k]; });
  return row;
}

function maskRow(req, row, keys) {
  return req.canViewPrice ? row : dropKeys(row, keys);
}

function maskRows(req, rows, keys) {
  if (req.canViewPrice || !Array.isArray(rows)) return rows;
  rows.forEach(r => dropKeys(r, keys));
  return rows;
}

module.exports = { dropKeys, maskRow, maskRows };
