/**
 * 数据库出入口定点转换层
 *
 * 数据库中的数量/单价/金额一律为整数定点（见 services/units.js），
 * 而路由层、前端、业务计算继续使用「元 / 件」的普通数字。
 * 本层只做「出入口换算」，不参与任何业务判断：
 *   - 绑定参数：按列名（命名参数按参数名、位置参数按 INSERT/UPDATE 的列顺序）换算成整数；
 *   - 结果行：按列名把整数还原成普通数字。
 *
 * 约定：全系统列名语义唯一（qty 必为数量、price 必为单价、amount 必为金额），
 * 因此可以按列名安全换算。新增带金额/数量的字段时，必须同步登记到下面的集合。
 */

const units = require('./units');

const QTY_COLS = new Set([
  'qty', 'opening_qty', 'min_stock', 'order_qty',
  'book_qty', 'count_qty', 'diff_qty',
  'stock_qty', 'qty_in', 'qty_out', 'balance_qty', 'received_qty', 'total_qty',
  'qty_before', 'qty_after',
]);

const PRICE_COLS = new Set([
  'price', 'opening_price', 'cost_price', 'order_price',
  'avg_cost', 'unit_cost', 'balance_avg_cost',
]);

const AMOUNT_COLS = new Set([
  'amount', 'cost_amount', 'order_amount',
  'stock_amount', 'amount_in', 'amount_out', 'balance_amount', 'received_amount', 'total_amount',
  'amount_before', 'amount_after',
]);

function scaleOf(col) {
  if (QTY_COLS.has(col)) return units.QTY_DECIMALS;
  if (PRICE_COLS.has(col)) return units.PRICE_DECIMALS;
  if (AMOUNT_COLS.has(col)) return units.AMOUNT_DECIMALS;
  return -1;
}

function toStorage(col, value) {
  const d = scaleOf(col);
  if (d < 0) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Number(units.toScaled(value, d));
}

function toApiValue(col, value) {
  const d = scaleOf(col);
  if (d < 0) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== 'number') return value;
  return units.fromScaled(BigInt(value), d);
}

// 解析位置参数对应的列名（仅覆盖 INSERT ... VALUES(...) 与 UPDATE ... SET ...）
function positionalColumns(sql) {
  const ins = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`\[]?(\w+)["`\]]?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
  if (ins) {
    const cols = ins[2].split(',').map(s => s.trim().replace(/["`\[\]]/g, ''));
    const vals = ins[3].split(',').map(s => s.trim());
    return vals.map((v, i) => (v === '?' ? cols[i] : null));
  }
  const upd = /^\s*UPDATE\s+["`\[]?(\w+)["`\]]?\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+|$)/i.exec(sql);
  if (upd) {
    return upd[2].split(',').map(p => {
      const m = /^\s*(\w+)\s*=\s*\?\s*$/.exec(p);
      return m ? m[1] : null;
    });
  }
  return null;
}

const positionalCache = new Map();

function convertArgs(sql, args) {
  if (args.length === 0) return args;
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const src = args[0];
    let out = null;
    for (const key of Object.keys(src)) {
      if (scaleOf(key) < 0) continue;
      if (!out) out = { ...src };
      out[key] = toStorage(key, src[key]);
    }
    return [out || src];
  }
  let cols = positionalCache.get(sql);
  if (cols === undefined) {
    cols = positionalColumns(sql);
    positionalCache.set(sql, cols);
  }
  if (!cols) return args;
  let out = null;
  for (let i = 0; i < args.length; i++) {
    const col = cols[i];
    if (!col || scaleOf(col) < 0) continue;
    if (!out) out = args.slice();
    out[i] = toStorage(col, args[i]);
  }
  return out || args;
}

function convertRow(row) {
  if (!row || typeof row !== 'object') return row;
  let out = null;
  for (const key of Object.keys(row)) {
    if (scaleOf(key) < 0) continue;
    if (!out) out = { ...row };
    out[key] = toApiValue(key, row[key]);
  }
  return out || row;
}

function wrapStatement(stmt, sql) {
  return {
    run(...args) { return stmt.run(...convertArgs(sql, args)); },
    get(...args) { return convertRow(stmt.get(...convertArgs(sql, args))); },
    all(...args) {
      const rows = stmt.all(...convertArgs(sql, args));
      return rows.map(convertRow);
    },
    iterate(...args) {
      const it = stmt.iterate(...convertArgs(sql, args));
      return (function* () { for (const r of it) yield convertRow(r); })();
    },
    pluck() { return stmt.pluck(); },
    raw() { return stmt.raw(); },
    get source() { return stmt.source; },
    get reader() { return stmt.reader; },
    get database() { return stmt.database; },
  };
}

function wrapDb(raw) {
  return {
    prepare(sql) { return wrapStatement(raw.prepare(sql), sql); },
    exec(sql) { return raw.exec(sql); },
    pragma(...args) { return raw.pragma(...args); },
    transaction(fn) { return raw.transaction(fn); },
    get name() { return raw.name; },
    get open() { return raw.open; },
    get inTransaction() { return raw.inTransaction; },
    close() { return raw.close(); },
  };
}

module.exports = { wrapDb, toStorage, toApiValue, QTY_COLS, PRICE_COLS, AMOUNT_COLS };
