/**
 * 数据库初始化脚本 - 创建表结构并导入种子数据
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'inventory.db');
const SEED_PATH = path.join(__dirname, '..', 'seed_data.json');

// 删除旧数据库
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

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
INSERT INTO params VALUES ('currency', 'SAR');
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

// 存放位置
db.exec(`
CREATE TABLE locations (
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
  opening_qty REAL DEFAULT 0,
  opening_price REAL DEFAULT 0,
  min_stock REAL DEFAULT 0,
  default_location TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  status TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
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
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// 入库记录
db.exec(`
CREATE TABLE inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  grn_no TEXT NOT NULL,
  code TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  amount REAL GENERATED ALWAYS AS (qty * price) STORED,
  supplier TEXT DEFAULT '',
  handler TEXT DEFAULT '',
  location TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  po_no TEXT DEFAULT '',
  contract_no TEXT DEFAULT '',
  txn_type TEXT DEFAULT '采购入库',
  created_at TEXT DEFAULT (datetime('now','localtime')),
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
  qty REAL NOT NULL,
  destination TEXT DEFAULT '',
  receiver TEXT DEFAULT '',
  handler TEXT DEFAULT '',
  location TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  cost_price REAL DEFAULT 0,
  cost_amount REAL GENERATED ALWAYS AS (qty * cost_price) STORED,
  txn_type TEXT DEFAULT '正常出库',
  created_at TEXT DEFAULT (datetime('now','localtime')),
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
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// 订单明细
db.exec(`
CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL,
  code TEXT NOT NULL,
  order_qty REAL NOT NULL,
  order_price REAL NOT NULL,
  order_amount REAL GENERATED ALWAYS AS (order_qty * order_price) STORED,
  remarks TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (po_no) REFERENCES purchase_orders(po_no),
  FOREIGN KEY (code) REFERENCES materials(code)
);
`);

// ========== 导入种子数据 ==========

if (fs.existsSync(SEED_PATH)) {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8'));
  const p = seed.params;

  // 参数
  const catStmt = db.prepare('INSERT INTO categories (name, prefix) VALUES (?, ?)');
  p.categories.forEach((name, i) => catStmt.run(name, p.prefixes[i] || ''));
  p.units.forEach(name => db.prepare('INSERT INTO units (name) VALUES (?)').run(name));
  p.destinations.forEach(name => db.prepare('INSERT INTO destinations (name) VALUES (?)').run(name));
  p.locations.forEach(name => db.prepare('INSERT INTO locations (name) VALUES (?)').run(name));

  // 物料
  const matStmt = db.prepare(`INSERT INTO materials (code,name,spec,category,unit,opening_qty,opening_price,min_stock,default_location,brand,status) VALUES (@code,@name,@spec,@category,@unit,@opening_qty,@opening_price,@min_stock,@location,@brand,@status)`);
  seed.materials.forEach(m => matStmt.run(m));

  // 供应商
  const supStmt = db.prepare(`INSERT INTO suppliers (name,contact,phone,remarks) VALUES (@name,@contact,@phone,@remarks)`);
  seed.suppliers.forEach(s => supStmt.run(s));

  // 入库
  const inStmt = db.prepare(`INSERT INTO inbound (date,grn_no,code,qty,price,supplier,handler,location,remarks,po_no,contract_no,txn_type) VALUES (@date,@grn_no,@code,@qty,@price,@supplier,@handler,@location,@remarks,@po_no,@contract_no,@txn_type)`);
  seed.inbound.forEach(r => inStmt.run({ ...r, txn_type: r.txn_type || '采购入库' }));

  // 出库 - 计算成本单价（加权平均）
  // 先按日期排序
  const outboundSorted = [...seed.outbound].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  // 计算每个物料的加权平均单价
  const stockMap = {}; // code -> {qty, total_cost}
  seed.materials.forEach(m => {
    stockMap[m.code] = { qty: m.opening_qty || 0, total_cost: (m.opening_qty || 0) * (m.opening_price || 0) };
  });
  // 按日期排序的入库记录
  const inboundSorted = [...seed.inbound].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  // 合并入库和出库按日期排序
  const allTxns = [];
  inboundSorted.forEach(r => allTxns.push({ ...r, type: 'in' }));
  const outboundWithCost = outboundSorted.map(r => ({ ...r, type: 'out', cost_price: 0 }));
  outboundWithCost.forEach(r => allTxns.push(r));
  allTxns.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  for (const txn of allTxns) {
    if (txn.type === 'in') {
      const s = stockMap[txn.code];
      if (s) {
        s.total_cost += txn.qty * txn.price;
        s.qty += txn.qty;
      }
    } else {
      const s = stockMap[txn.code];
      if (s && s.qty > 0) {
        txn.cost_price = s.total_cost / s.qty;
      } else {
        txn.cost_price = 0;
      }
      s.qty -= txn.qty;
      s.total_cost -= txn.qty * txn.cost_price;
    }
  }

  const outStmt = db.prepare(`INSERT INTO outbound (date,gin_no,code,qty,destination,receiver,handler,location,remarks,cost_price,txn_type) VALUES (@date,@gin_no,@code,@qty,@destination,@receiver,@handler,@location,@remarks,@cost_price,@txn_type)`);
  outboundWithCost.forEach(r => outStmt.run({ ...r, txn_type: r.txn_type || '正常出库' }));

  // 采购订单
  const poStmt = db.prepare(`INSERT INTO purchase_orders (po_no,date,supplier,contract_no,project,expected_date,remarks,manual_status) VALUES (@po_no,@date,@supplier,@contract_no,@project,@expected_date,@remarks,@manual_status)`);
  seed.orders.forEach(o => poStmt.run(o));

  // 订单明细
  const olStmt = db.prepare(`INSERT INTO order_lines (po_no,code,order_qty,order_price,remarks) VALUES (@po_no,@code,@order_qty,@order_price,'')`);
  seed.order_lines.forEach(o => olStmt.run(o));

  console.log(`种子数据导入完成: ${seed.materials.length} 物料, ${seed.suppliers.length} 供应商, ${seed.inbound.length} 入库, ${seed.outbound.length} 出库, ${seed.orders.length} 采购订单`);
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
