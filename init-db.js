/**
 * 数据库初始化（首次安装 / 空库）
 *
 * 安全约定：
 *  1. 本文件被 require 时不产生任何副作用，只有显式调用 initDatabase() 才建库；
 *  2. 目标库已存在时默认拒绝执行，绝不删除数据；
 *  3. 确需重建时用 --force：旧库整体改名为 .bak-时间戳 备份后，再建新库。
 *
 * 正常启动时 server/db.js 只在库文件不存在时调用 initDatabase()，无需手动执行本脚本。
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const { DB_PATH } = require('./server/config');
const SEED_PATH = path.join(__dirname, '..', 'seed_data.json');

const USAGE = `用法: npm run init-db [-- --force | --help]

  无参数          目标库不存在时建库；已存在则拒绝执行（不会改动任何数据）
  --force         目标库已存在时，先备份为 <库文件>.bak-<时间戳>，再重建
  --help, -h      显示本帮助

说明:
  · 重建不会删除旧数据：旧库及其 -wal / -shm 一并改名为备份文件，可随时找回。
  · 正常启动（npm start）时 server/db.js 会自动完成首次建库，通常不需要执行本脚本。`;

function backupExistingDatabase() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
  const bak = `${DB_PATH}.bak-${stamp}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = DB_PATH + suffix;
    if (fs.existsSync(src)) fs.renameSync(src, bak + suffix);
  }
  return bak;
}

function initDatabase({ force = false } = {}) {
  if (fs.existsSync(DB_PATH)) {
    if (!force) {
      throw new Error(
        `拒绝执行：数据库已存在（${DB_PATH}）。\n` +
        '  这是初始化脚本，默认不会覆盖已有数据。\n' +
        '  确需重建请执行: npm run init-db -- --force（旧库会先备份，不会删除）'
      );
    }
    const bak = backupExistingDatabase();
    console.log('已备份旧库: ' + bak);
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ========== 创建表结构 ==========

  // 参数表
  db.exec(`
CREATE TABLE params (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO params VALUES ('currency', '¥');
INSERT INTO params VALUES ('use_icons', '是');
`);

  // 物料类别
  db.exec(`
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  prefix TEXT
);
`);

  // 计量单位
  db.exec(`
CREATE TABLE units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
`);

  // 领用去向
  db.exec(`
CREATE TABLE destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
`);

  // 物料档案
  db.exec(`
CREATE TABLE materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  spec TEXT DEFAULT '',
  category TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  opening_qty INTEGER DEFAULT 0,
  opening_price INTEGER DEFAULT 0,
  min_stock INTEGER DEFAULT 0,
  brand TEXT DEFAULT '',
  status TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

  // 供应商档案
  db.exec(`
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

  // 入库记录
  db.exec(`
CREATE TABLE inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  grn_no TEXT NOT NULL,
  code TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  amount INTEGER GENERATED ALWAYS AS (CAST(ROUND(qty * price / 1000000000000.0) AS INTEGER)) STORED,
  supplier TEXT DEFAULT '',
  handler TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  po_no TEXT DEFAULT '',
  contract_no TEXT DEFAULT '',
  txn_type TEXT DEFAULT '采购入库',
  doc_no TEXT DEFAULT '',
  status TEXT DEFAULT 'posted',
  order_line_id INTEGER NOT NULL DEFAULT 0,
  origin_line_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (code) REFERENCES materials(code)
);
`);

  // 出库记录
  db.exec(`
CREATE TABLE outbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  gin_no TEXT NOT NULL,
  code TEXT NOT NULL,
  qty INTEGER NOT NULL,
  destination TEXT DEFAULT '',
  receiver TEXT DEFAULT '',
  handler TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  cost_price INTEGER DEFAULT 0,
  cost_amount INTEGER GENERATED ALWAYS AS (CAST(ROUND(qty * cost_price / 1000000000000.0) AS INTEGER)) STORED,
  txn_type TEXT DEFAULT '正常出库',
  doc_no TEXT DEFAULT '',
  status TEXT DEFAULT 'posted',
  origin_line_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (code) REFERENCES materials(code)
);
`);

  // 采购订单
  db.exec(`
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  supplier TEXT DEFAULT '',
  contract_no TEXT DEFAULT '',
  project TEXT DEFAULT '',
  expected_date TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  manual_status TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'posted',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

  // 订单明细
  db.exec(`
CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL,
  code TEXT NOT NULL,
  order_qty INTEGER NOT NULL,
  order_price INTEGER NOT NULL,
  order_amount INTEGER GENERATED ALWAYS AS (CAST(ROUND(order_qty * order_price / 1000000000000.0) AS INTEGER)) STORED,
  remarks TEXT DEFAULT '',
  contract_no TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (po_no) REFERENCES purchase_orders(po_no),
  FOREIGN KEY (code) REFERENCES materials(code)
);
`);

  // ========== 导入种子数据 ==========

  if (fs.existsSync(SEED_PATH)) {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8'));
    const p = seed.params;
    const units = require('./server/services/units');

    // 参数
    const catStmt = db.prepare('INSERT INTO categories (name, prefix) VALUES (?, ?)');
    p.categories.forEach((name, i) => catStmt.run(name, p.prefixes[i] || ''));
    p.units.forEach(name => db.prepare('INSERT INTO units (name) VALUES (?)').run(name));
    p.destinations.forEach(name => db.prepare('INSERT INTO destinations (name) VALUES (?)').run(name));

    // 物料档案（数量 1e6 / 单价 1e8 定点入库）
    const matStmt = db.prepare(`INSERT INTO materials (code,name,spec,category,unit,opening_qty,opening_price,min_stock,brand,status) VALUES (@code,@name,@spec,@category,@unit,@opening_qty,@opening_price,@min_stock,@brand,@status)`);
    seed.materials.forEach(m => matStmt.run({
      ...m,
      opening_qty: Number(units.toQtyInt(m.opening_qty || 0)),
      opening_price: Number(units.toPriceInt(m.opening_price || 0)),
      min_stock: Number(units.toQtyInt(m.min_stock || 0)),
    }));

    // 供应商
    const supStmt = db.prepare(`INSERT INTO suppliers (name,contact,phone,remarks) VALUES (@name,@contact,@phone,@remarks)`);
    seed.suppliers.forEach(s => supStmt.run(s));

    // 业务单据（入库/出库/采购单）不再随初始化导入：开发阶段库是空的，
    // 需要数据请通过界面或测试脚本建立，避免出现无法追溯的历史业务。
    console.log(`种子字典导入完成: ${p.categories.length} 类别, ${p.units.length} 单位, ${p.destinations.length} 去向, ${seed.materials.length} 物料, ${seed.suppliers.length} 供应商`);
  } else {
    console.log('未找到种子数据文件，跳过导入');
  }

  // 创建索引
  db.exec(`
CREATE INDEX idx_inbound_code ON inbound(code);
CREATE INDEX idx_inbound_date ON inbound(date);
CREATE INDEX idx_inbound_grn ON inbound(grn_no);
CREATE INDEX idx_outbound_code ON outbound(code);
CREATE INDEX idx_outbound_date ON outbound(date);
CREATE INDEX idx_outbound_gin ON outbound(gin_no);
CREATE INDEX idx_order_lines_po ON order_lines(po_no);
CREATE INDEX idx_order_lines_code ON order_lines(code);
`);

  db.close();
  console.log('数据库初始化完成: ' + DB_PATH);
}

module.exports = { initDatabase };

// 直接执行时才走 CLI；被 require 时只有导出，不产生任何副作用
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknown = args.filter(a => a !== '--force');
  if (unknown.length) {
    console.error(`未知参数: ${unknown.join(' ')}\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    initDatabase({ force: args.includes('--force') });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
