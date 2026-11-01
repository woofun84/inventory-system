/**
 * 库存进出库管理系统 - 后端服务器
 */
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DB_PATH = path.join(__dirname, 'inventory.db');
const PORT = 3000;
const JWT_SECRET = 'inventory-system-secret-key-2026';
const JWT_EXPIRES = '7d';

// 自动初始化数据库
if (!fs.existsSync(DB_PATH)) {
  console.log('数据库不存在，正在初始化...');
  require('./init-db.js');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== 数据库迁移（给已有库加字段） ====================
function migrateDB() {
  // inbound 加 txn_type 字段（采购入库 / 退库入库）
  try {
    db.exec("ALTER TABLE inbound ADD COLUMN txn_type TEXT DEFAULT ''");
    console.log('迁移: inbound.txn_type 已添加');
  } catch(e) { /* 字段已存在 */ }

  // outbound 加 txn_type 字段（正常出库 / 退货出库）
  try {
    db.exec("ALTER TABLE outbound ADD COLUMN txn_type TEXT DEFAULT ''");
    console.log('迁移: outbound.txn_type 已添加');
  } catch(e) { /* 字段已存在 */ }

  // 给已有的 inbound 记录补默认值
  try {
    db.exec("UPDATE inbound SET txn_type = '采购入库' WHERE txn_type = '' OR txn_type IS NULL");
    db.exec("UPDATE outbound SET txn_type = '正常出库' WHERE txn_type = '' OR txn_type IS NULL");
  } catch(e) {}

  // 迁移：退库入库 → 采购退货（移到 inbound 表，qty/price 转负数）
  //        退货出库 → 退库出库（移到 outbound 表，qty 转负数）
  // 注意：amount/cost_amount 是 GENERATED 列，随 qty*price 自动计算，无需单独更新
  try {
    // inbound 表中已有的"退库入库"改为"采购退货"，qty 和 price 转负数（amount 自动跟着变）
    db.exec("UPDATE inbound SET txn_type = '采购退货', qty = -ABS(qty), price = -ABS(price) WHERE txn_type = '退库入库'");
    // outbound 表中已有的"退货出库"改为"退库出库"，qty 转负数（cost_amount 自动跟着变）
    db.exec("UPDATE outbound SET txn_type = '退库出库', qty = -ABS(qty) WHERE txn_type = '退货出库'");
  } catch(e) { console.log('迁移 txn_type 值更新:', e.message); }

  // 用户表
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT DEFAULT '',
    role TEXT DEFAULT 'operator',
    status TEXT DEFAULT 'active',
    must_change_pwd INTEGER DEFAULT 0,
    last_login TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // 初始管理员账号
  const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  if (adminCount === 0) {
    db.prepare(`INSERT INTO users (username, password_hash, name, role, must_change_pwd)
                VALUES (?,?,?,?,1)`).run('admin', bcrypt.hashSync('admin123', 10), '系统管理员', 'admin');
    console.log('已创建初始管理员账号: admin / admin123 (首次登录需修改密码)');
  }
}
migrateDB();

// ==================== 角色与权限矩阵 ====================
// 角色：admin 管理员 / manager 主管 / operator 操作员 / viewer 只读
// 权限粒度：模块 + 操作（view 查看 / create 新增 / edit 修改 / delete 删除）
// 规则：
//   admin — 全部权限
//   manager — 业务全权（入出库/物料/订单/供应商/订单跟踪/参数设置），不含用户管理
//   operator — 只能新增入库和出库，不能编辑/删除已录入记录，不能新增物料/订单/供应商
//   viewer — 纯只读
const ROLE_PERMISSIONS = {
  admin: ['*'],
  manager: {
    dashboard: ['view'],
    inbound: ['view', 'create', 'edit', 'delete'],
    outbound: ['view', 'create', 'edit', 'delete'],
    materials: ['view', 'create', 'edit', 'delete'],
    suppliers: ['view', 'create', 'edit', 'delete'],
    orders: ['view', 'create', 'edit', 'delete'],
    orderTracking: ['view', 'create', 'edit', 'delete'],
    stockSummary: ['view'], query: ['view'], ledger: ['view'],
    locationStock: ['view'],
    settings: ['view', 'create', 'edit', 'delete'],
  },
  operator: {
    dashboard: ['view'],
    inbound: ['view', 'create'],
    outbound: ['view', 'create'],
    materials: ['view'],
    suppliers: ['view'],
    orders: ['view'],
    orderTracking: ['view'],
    stockSummary: ['view'], query: ['view'], ledger: ['view'],
    locationStock: ['view'],
  },
  viewer: {
    dashboard: ['view'], inbound: ['view'], outbound: ['view'], materials: ['view'],
    suppliers: ['view'], orders: ['view'], orderTracking: ['view'], stockSummary: ['view'],
    query: ['view'], ledger: ['view'], locationStock: ['view'],
  },
};

// 计算某角色的授权表（前端据此控制菜单与按钮显隐）
function grantsOf(role) {
  const p = ROLE_PERMISSIONS[role];
  if (!p) return {};
  if (Array.isArray(p)) {
    const g = {};
    ['dashboard', 'inbound', 'outbound', 'materials', 'suppliers', 'orders', 'orderTracking',
     'stockSummary', 'query', 'ledger', 'locationStock', 'settings', 'users']
      .forEach(m => g[m] = ['view', 'create', 'edit', 'delete']);
    return g;
  }
  return p;
}

function canDo(role, module, action) {
  const p = ROLE_PERMISSIONS[role];
  if (!p) return false;
  if (Array.isArray(p)) return p.includes('*');
  const m = p[module];
  return Array.isArray(m) && m.includes(action);
}

// ==================== 鉴权中间件 ====================
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: '未登录或登录已过期' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = db.prepare('SELECT id,username,name,role,status,must_change_pwd FROM users WHERE id=?').get(payload.id);
    if (!u) return res.status(401).json({ error: '用户不存在' });
    if (u.status !== 'active') return res.status(403).json({ error: '账号已被停用' });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function requirePerm(module, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!canDo(req.user.role, module, action)) {
      return res.status(403).json({ error: '权限不足：无该操作权限' });
    }
    next();
  };
}

// ==================== 用户信息序列化 ====================
function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, status: u.status,
    must_change_pwd: !!u.must_change_pwd, last_login: u.last_login || '',
    grants: grantsOf(u.role),
  };
}

const app = express();
app.use(express.json({ limit: '10mb' }));
// 静态文件禁用缓存，确保浏览器每次加载最新 JS/CSS
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.js') || filepath.endsWith('.css') || filepath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// ==================== 认证接口（免鉴权） ====================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  try {
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
    if (!u) return res.status(401).json({ error: '用户名或密码错误' });
    if (!bcrypt.compareSync(String(password), u.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (u.status !== 'active') return res.status(403).json({ error: '账号已被停用，请联系管理员' });
    db.prepare("UPDATE users SET last_login=datetime('now','localtime') WHERE id=?").run(u.id);
    const token = jwt.sign({ id: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, user: publicUser(u) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 以下接口需要登录 ====================
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login') return next();
  return requireAuth(req, res, next);
});

// 当前登录用户信息
app.get('/api/auth/me', (req, res) => {
  res.json(publicUser(req.user));
});

// 修改自己的密码
app.post('/api/auth/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写原密码和新密码' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  try {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!bcrypt.compareSync(String(oldPassword), u.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    db.prepare('UPDATE users SET password_hash=?, must_change_pwd=0 WHERE id=?')
      .run(bcrypt.hashSync(String(newPassword), 10), req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 用户管理（仅管理员） ====================
app.get('/api/users', requirePerm('users', 'view'), (req, res) => {
  const rows = db.prepare(`SELECT id,username,name,role,status,must_change_pwd,last_login,created_at
                           FROM users ORDER BY id`).all();
  res.json(rows.map(r => ({ ...r, must_change_pwd: !!r.must_change_pwd })));
});

app.post('/api/users', requirePerm('users', 'create'), (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (!ROLE_PERMISSIONS[role]) return res.status(400).json({ error: '无效的角色' });
  try {
    const dup = db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim());
    if (dup) return res.status(400).json({ error: '用户名已存在' });
    const info = db.prepare(`INSERT INTO users (username,password_hash,name,role) VALUES (?,?,?,?)`)
      .run(String(username).trim(), bcrypt.hashSync(String(password), 10), String(name || '').trim(), role);
    const u = db.prepare('SELECT id,username,name,role,status,must_change_pwd,last_login,created_at FROM users WHERE id=?').get(info.lastInsertRowid);
    res.json({ ...u, must_change_pwd: !!u.must_change_pwd });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:id', requirePerm('users', 'edit'), (req, res) => {
  const id = Number(req.params.id);
  const { name, role, status, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (role && !ROLE_PERMISSIONS[role]) return res.status(400).json({ error: '无效的角色' });
  try {
    // 防止把最后一个管理员降级或停用
    if (u.role === 'admin' && (role && role !== 'admin' || status === 'disabled')) {
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").get().c;
      if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一个启用的管理员' });
    }
    if (name !== undefined) db.prepare('UPDATE users SET name=? WHERE id=?').run(String(name).trim(), id);
    if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    if (status) db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
      db.prepare('UPDATE users SET password_hash=?, must_change_pwd=1 WHERE id=?')
        .run(bcrypt.hashSync(String(password), 10), id);
    }
    const out = db.prepare('SELECT id,username,name,role,status,must_change_pwd,last_login,created_at FROM users WHERE id=?').get(id);
    res.json({ ...out, must_change_pwd: !!out.must_change_pwd });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requirePerm('users', 'delete'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的账号' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").get().c;
    if (admins <= 1) return res.status(400).json({ error: '系统至少需要保留一个启用的管理员' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ success: true });
});


// ==================== 辅助函数 ====================

// 计算库存汇总
function getStockSummary() {
  const materials = db.prepare(`
    SELECT m.code, m.name, m.spec, m.category, m.unit,
           m.opening_qty, m.opening_price, m.min_stock, m.brand, m.status,
           m.default_location
    FROM materials m
    WHERE m.status != '停用' OR m.status IS NULL OR m.status = ''
    ORDER BY m.code
  `).all();

  return materials.map(m => {
    const totalIn = db.prepare('SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE code=?').get(m.code).v;
    const totalOut = db.prepare('SELECT COALESCE(SUM(qty),0) as v FROM outbound WHERE code=?').get(m.code).v;
    const onHand = m.opening_qty + totalIn - totalOut;

    // 加权平均单价
    const inTotalCost = db.prepare('SELECT COALESCE(SUM(amount),0) as v FROM inbound WHERE code=?').get(m.code).v;
    const openingCost = m.opening_qty * m.opening_price;
    const totalQty = m.opening_qty + totalIn;
    const avgPrice = totalQty > 0 ? (openingCost + inTotalCost) / totalQty : 0;

    // 库存状态
    let stockStatus;
    if (m.status === '停用') stockStatus = '停用';
    else if (onHand <= 0) stockStatus = '缺货';
    else if (onHand <= m.min_stock) stockStatus = '补货';
    else stockStatus = '正常';

    return {
      ...m,
      total_in: totalIn,
      total_out: totalOut,
      on_hand: onHand,
      avg_price: Math.round(avgPrice * 10000) / 10000,
      stock_value: Math.round(onHand * avgPrice * 100) / 100,
      stock_status: stockStatus
    };
  });
}

// 计算出库成本单价（加权平均）
function computeCostPrice(code, qty, date) {
  const m = db.prepare('SELECT opening_qty, opening_price FROM materials WHERE code=?').get(code);
  if (!m) return 0;

  const inboundBefore = db.prepare(`
    SELECT qty, price FROM inbound
    WHERE code=? AND date < ?
    ORDER BY date ASC
  `).all(code, date);

  const outboundBefore = db.prepare(`
    SELECT qty FROM outbound
    WHERE code=? AND date < ?
    ORDER BY date ASC
  `).all(code, date);

  let stockQty = m.opening_qty;
  let stockCost = m.opening_qty * m.opening_price;

  // 合并按时间顺序
  const allTxns = [];
  inboundBefore.forEach(r => allTxns.push({ ...r, type: 'in' }));
  outboundBefore.forEach(r => allTxns.push({ ...r, type: 'out' }));
  allTxns.sort((a, b) => 0); // 已分别查询，按入库顺序处理

  // 先处理入库
  inboundBefore.forEach(r => {
    stockCost += r.qty * r.price;
    stockQty += r.qty;
  });
  // 再处理出库
  outboundBefore.forEach(r => {
    const cp = stockQty > 0 ? stockCost / stockQty : 0;
    stockQty -= r.qty;
    stockCost -= r.qty * cp;
  });

  return stockQty > 0 ? stockCost / stockQty : 0;
}

// 生成单号
// 生成单号（批量共享一个单号）
// 入库：采购入库 GRN-，采购退货 RET-
// 出库：正常出库 GIN-，退库出库 RKB-
function genGrnNo(date, txnType) {
  const d = date.replace(/-/g, '');
  const prefix = txnType === '采购退货' ? 'RET' : 'GRN';
  const count = db.prepare("SELECT COUNT(*) as c FROM inbound WHERE grn_no LIKE ?").get(`${prefix}-${d}%`).c;
  return `${prefix}-${d}-${String(count + 1).padStart(4, '0')}`;
}
function genGinNo(date, txnType) {
  const d = date.replace(/-/g, '');
  const prefix = txnType === '退库出库' ? 'RKB' : 'GIN';
  const count = db.prepare("SELECT COUNT(*) as c FROM outbound WHERE gin_no LIKE ?").get(`${prefix}-${d}%`).c;
  return `${prefix}-${d}-${String(count + 1).padStart(4, '0')}`;
}

// 自动生成物料编码：按类别前缀 + 序号
function genMaterialCode(category) {
  // 查类别对应的编码前缀
  const cat = db.prepare("SELECT prefix FROM categories WHERE name=?").get(category);
  let prefix = '';
  if (cat && cat.prefix) {
    prefix = cat.prefix;
  } else {
    // 无前缀的类别用类别首字母拼音简化处理，找不到就用 'IT'
    prefix = 'IT';
  }

  // 找已有同前缀编码的最大序号
  const like = prefix + '%';
  const rows = db.prepare("SELECT code FROM materials WHERE code LIKE ?").all(like);
  let maxSeq = 0;
  rows.forEach(r => {
    const numPart = r.code.replace(prefix, '');
    const n = parseInt(numPart);
    if (!isNaN(n) && n > maxSeq) maxSeq = n;
  });
  const nextSeq = maxSeq + 1;
  // 编码格式：前缀 + 4位序号（不足补零）
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

// 获取订单明细（用于入库时选择订单带出明细）
function getOrderLinesForInbound(poNo) {
  const lines = db.prepare(`
    SELECT ol.*, po.manual_status,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE ol.po_no=? ORDER BY ol.id
  `).all(poNo);
  // 查已入库数量
  const inboundByPo = db.prepare("SELECT code, SUM(qty) as qty FROM inbound WHERE po_no=? GROUP BY code").all(poNo);
  const receivedMap = {};
  inboundByPo.forEach(r => receivedMap[r.code] = r.qty);
  return lines.map(l => ({
    ...l,
    received_qty: receivedMap[l.code] || 0,
    unreceived_qty: l.order_qty - (receivedMap[l.code] || 0)
  })).filter(l => l.unreceived_qty > 0 && l.manual_status !== '已取消' && l.manual_status !== '已关闭');
}

// 按合同号获取订单明细（汇总该合同下所有采购订单的明细）
function getOrderLinesByContract(contractNo) {
  const lines = db.prepare(`
    SELECT ol.*, po.po_no, po.supplier, po.manual_status, po.contract_no,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE po.contract_no=? ORDER BY ol.po_no, ol.id
  `).all(contractNo);
  // 查已入库数量（按 po_no + code 维度）
  const receivedMap = {};
  lines.forEach(l => {
    if (!receivedMap[l.po_no]) receivedMap[l.po_no] = {};
    const received = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE po_no=? AND code=?").get(l.po_no, l.code).v;
    receivedMap[l.po_no][l.code] = received;
  });
  return lines.map(l => ({
    ...l,
    received_qty: (receivedMap[l.po_no] && receivedMap[l.po_no][l.code]) || 0,
    unreceived_qty: l.order_qty - ((receivedMap[l.po_no] && receivedMap[l.po_no][l.code]) || 0)
  })).filter(l => l.unreceived_qty > 0 && l.manual_status !== '已取消' && l.manual_status !== '已关闭');
}

// ==================== API 路由 ====================

// --- 仪表盘 ---
app.get('/api/dashboard', requirePerm('dashboard', 'view'), (req, res) => {
  const summary = getStockSummary();
  const totalItems = summary.length;
  const totalValue = summary.reduce((s, m) => s + m.stock_value, 0);

  // 本月入库金额
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);
  const monthInAmount = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM inbound WHERE date>=? AND date<?").get(monthStart, monthEnd).v;
  const monthOutAmount = db.prepare("SELECT COALESCE(SUM(cost_amount),0) as v FROM outbound WHERE date>=? AND date<?").get(monthStart, monthEnd).v;
  const monthInCount = db.prepare("SELECT COUNT(*) as c FROM inbound WHERE date>=? AND date<?").get(monthStart, monthEnd).c;
  const monthOutCount = db.prepare("SELECT COUNT(*) as c FROM outbound WHERE date>=? AND date<?").get(monthStart, monthEnd).c;

  const alerts = summary.filter(m => m.stock_status === '补货' || m.stock_status === '缺货');

  // 近6个月趋势
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const msStr = ms.toISOString().slice(0, 10);
    const meStr = me.toISOString().slice(0, 10);
    const inAmt = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM inbound WHERE date>=? AND date<?").get(msStr, meStr).v;
    const outAmt = db.prepare("SELECT COALESCE(SUM(cost_amount),0) as v FROM outbound WHERE date>=? AND date<?").get(msStr, meStr).v;
    months.push({
      label: `${ms.getFullYear()}-${String(ms.getMonth() + 1).padStart(2, '0')}`,
      in_amount: Math.round(inAmt * 100) / 100,
      out_amount: Math.round(outAmt * 100) / 100
    });
  }

  // 类别库存金额
  const categoryValues = {};
  summary.forEach(m => {
    if (!categoryValues[m.category]) categoryValues[m.category] = 0;
    categoryValues[m.category] += m.stock_value;
  });

  // Top 5 物料库存金额
  const topItems = [...summary].sort((a, b) => b.stock_value - a.stock_value).slice(0, 5).map(m => ({
    name: m.name, value: m.stock_value
  }));

  // 逾期采购订单
  const overdueOrders = db.prepare(`
    SELECT po.po_no, po.supplier, po.expected_date, po.project,
           (SELECT COUNT(*) FROM order_lines ol WHERE ol.po_no = po.po_no) as line_count,
           (SELECT COALESCE(SUM(order_amount),0) FROM order_lines ol WHERE ol.po_no = po.po_no) as order_amount,
           (SELECT COALESCE(SUM(amount),0) FROM inbound i WHERE i.po_no = po.po_no) as received_amount
    FROM purchase_orders po
    WHERE po.manual_status NOT IN ('已关闭','已取消')
      AND po.expected_date != '' AND po.expected_date < date('now')
    ORDER BY po.expected_date ASC
  `).all().map(po => {
    const received = po.received_amount;
    const ordered = po.order_amount;
    let deliveryStatus;
    if (po.line_count === 0) deliveryStatus = '无明细';
    else if (received === 0) deliveryStatus = '未到货';
    else if (received < ordered) deliveryStatus = '部分到货';
    else deliveryStatus = '已到货';
    const overdueDays = Math.floor((Date.now() - new Date(po.expected_date).getTime()) / 86400000);
    return { ...po, delivery_status: deliveryStatus, overdue_days: overdueDays };
  }).filter(po => po.delivery_status === '未到货' || po.delivery_status === '部分到货');

  const currency = db.prepare("SELECT value FROM params WHERE key='currency'").get().value;

  res.json({
    total_items: totalItems,
    total_value: Math.round(totalValue * 100) / 100,
    month_in_amount: Math.round(monthInAmount * 100) / 100,
    month_out_amount: Math.round(monthOutAmount * 100) / 100,
    month_txn_count: monthInCount + monthOutCount,
    alert_count: alerts.length,
    alerts: alerts.slice(0, 10),
    months_trend: months,
    category_values: categoryValues,
    top_items: topItems,
    overdue_orders: overdueOrders,
    currency
  });
});

// --- 物料档案 ---
app.get('/api/materials', requirePerm('materials', 'view'), (req, res) => {
  const rows = db.prepare("SELECT * FROM materials ORDER BY code").all();
  res.json(rows);
});

// 自动生成物料编码（按类别前缀）
app.get('/api/materials/next-code', requirePerm('materials', 'view'), (req, res) => {
  const category = req.query.category;
  if (!category) return res.status(400).json({ error: '请提供类别' });
  try {
    const code = genMaterialCode(category);
    res.json({ code });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/materials', requirePerm('materials', 'create'), (req, res) => {
  const m = req.body;
  try {
    // 如果 code 为空或 'auto'，自动生成
    if (!m.code || m.code === 'auto') {
      m.code = genMaterialCode(m.category);
    }
    db.prepare(`INSERT INTO materials (code,name,spec,category,unit,opening_qty,opening_price,min_stock,default_location,brand,status)
      VALUES (@code,@name,@spec,@category,@unit,@opening_qty,@opening_price,@min_stock,@default_location,@brand,@status)`).run(m);
    res.json({ success: true, code: m.code });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/materials/:code', requirePerm('materials', 'edit'), (req, res) => {
  const m = req.body;
  try {
    db.prepare(`UPDATE materials SET name=@name,spec=@spec,category=@category,unit=@unit,
      opening_qty=@opening_qty,opening_price=@opening_price,min_stock=@min_stock,
      default_location=@default_location,brand=@brand,status=@status,updated_at=datetime('now','localtime')
      WHERE code=@code`).run({ ...m, code: req.params.code });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/materials/:code', requirePerm('materials', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM materials WHERE code=?").run(req.params.code);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 供应商 ---
app.get('/api/suppliers', requirePerm('suppliers', 'view'), (req, res) => {
  res.json(db.prepare("SELECT * FROM suppliers ORDER BY name").all());
});

app.post('/api/suppliers', requirePerm('suppliers', 'create'), (req, res) => {
  try {
    db.prepare("INSERT INTO suppliers (name,contact,phone,remarks) VALUES (@name,@contact,@phone,@remarks)").run(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/suppliers/:id', requirePerm('suppliers', 'edit'), (req, res) => {
  try {
    db.prepare("UPDATE suppliers SET name=@name,contact=@contact,phone=@phone,remarks=@remarks WHERE id=@id").run({ ...req.body, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/suppliers/:id', requirePerm('suppliers', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM suppliers WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 入库记录 ---
app.get('/api/inbound', requirePerm('inbound', 'view'), (req, res) => {
  const { code, startDate, endDate, supplier, handler, poNo, contractNo, keyword, txnType } = req.query;
  let sql = `SELECT i.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM inbound i LEFT JOIN materials m ON i.code = m.code WHERE 1=1`;
  const params = [];
  if (code) { sql += " AND i.code=?"; params.push(code); }
  if (startDate) { sql += " AND i.date>=?"; params.push(startDate); }
  if (endDate) { sql += " AND i.date<?"; params.push(endDate + ' 23:59:59'); }
  if (supplier) { sql += " AND i.supplier LIKE ?"; params.push('%' + supplier + '%'); }
  if (handler) { sql += " AND i.handler LIKE ?"; params.push('%' + handler + '%'); }
  if (poNo) { sql += " AND i.po_no=?"; params.push(poNo); }
  if (contractNo) { sql += " AND i.contract_no=?"; params.push(contractNo); }
  if (txnType) { sql += " AND i.txn_type=?"; params.push(txnType); }
  if (keyword) {
    sql += " AND (i.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ? OR m.brand LIKE ?)";
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  sql += " ORDER BY i.date DESC, i.id DESC";
  res.json(db.prepare(sql).all(...params));
});

// 批量入库：支持一次提交多行
app.post('/api/inbound', requirePerm('inbound', 'create'), (req, res) => {
  const body = req.body;
  // 兼容：单行（有 code 字段）或多行（items 数组）
  const items = Array.isArray(body.items) ? body.items : [body];
  if (items.length === 0) return res.status(400).json({ error: '无数据' });
  try {
    const stmt = db.prepare(`INSERT INTO inbound (date,grn_no,code,qty,price,supplier,handler,location,remarks,po_no,contract_no,txn_type)
      VALUES (@date,@grn_no,@code,@qty,@price,@supplier,@handler,@location,@remarks,@po_no,@contract_no,@txn_type)`);
    const tx = db.transaction(() => {
      const results = [];
      // 一批共享一个单号
      const firstItem = items.find(r => r.code && r.qty && r.date);
      if (!firstItem) return results;
      if (!firstItem.txn_type) firstItem.txn_type = '采购入库';
      const sharedGrnNo = genGrnNo(firstItem.date, firstItem.txn_type);
      items.forEach(r => {
        if (!r.code || !r.qty || !r.date) return; // 跳过空行
        if (!r.grn_no) r.grn_no = sharedGrnNo;
        if (!r.txn_type) r.txn_type = '采购入库';
        // 采购退货：确保 qty 和 price 为负数
        if (r.txn_type === '采购退货') { r.qty = -Math.abs(r.qty); r.price = -Math.abs(r.price || 0); }
        if (!r.supplier) r.supplier = '';
        if (!r.handler) r.handler = '';
        if (!r.location) r.location = '';
        if (!r.remarks) r.remarks = '';
        if (!r.po_no) r.po_no = '';
        if (!r.contract_no) r.contract_no = '';
        if (!r.price) r.price = 0;
        stmt.run(r);
        results.push({ grn_no: r.grn_no });
      });
      return results;
    });
    const results = tx();
    res.json({ success: true, count: results.length, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/inbound/:id', requirePerm('inbound', 'edit'), (req, res) => {
  const r = req.body;
  try {
    if (!r.txn_type) r.txn_type = '采购入库';
    // 采购退货：确保 qty 和 price 为负数
    if (r.txn_type === '采购退货') { r.qty = -Math.abs(r.qty); r.price = -Math.abs(r.price || 0); }
    db.prepare(`UPDATE inbound SET date=@date,grn_no=@grn_no,code=@code,qty=@qty,price=@price,
      supplier=@supplier,handler=@handler,location=@location,remarks=@remarks,po_no=@po_no,contract_no=@contract_no,txn_type=@txn_type WHERE id=@id`).run({ ...r, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/inbound/:id', requirePerm('inbound', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM inbound WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 出库记录 ---
app.get('/api/outbound', requirePerm('outbound', 'view'), (req, res) => {
  const { code, startDate, endDate, destination, receiver, handler, keyword, txnType } = req.query;
  let sql = `SELECT o.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM outbound o LEFT JOIN materials m ON o.code = m.code WHERE 1=1`;
  const params = [];
  if (code) { sql += " AND o.code=?"; params.push(code); }
  if (startDate) { sql += " AND o.date>=?"; params.push(startDate); }
  if (endDate) { sql += " AND o.date<?"; params.push(endDate + ' 23:59:59'); }
  if (destination) { sql += " AND o.destination=?"; params.push(destination); }
  if (receiver) { sql += " AND o.receiver LIKE ?"; params.push('%' + receiver + '%'); }
  if (handler) { sql += " AND o.handler LIKE ?"; params.push('%' + handler + '%'); }
  if (txnType) { sql += " AND o.txn_type=?"; params.push(txnType); }
  if (keyword) {
    sql += " AND (o.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ? OR m.brand LIKE ?)";
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  sql += " ORDER BY o.date DESC, o.id DESC";
  res.json(db.prepare(sql).all(...params));
});

// 批量出库：支持一次提交多行
app.post('/api/outbound', requirePerm('outbound', 'create'), (req, res) => {
  const body = req.body;
  const items = Array.isArray(body.items) ? body.items : [body];
  if (items.length === 0) return res.status(400).json({ error: '无数据' });
  try {
    const stmt = db.prepare(`INSERT INTO outbound (date,gin_no,code,qty,destination,receiver,handler,location,remarks,cost_price,txn_type)
      VALUES (@date,@gin_no,@code,@qty,@destination,@receiver,@handler,@location,@remarks,@cost_price,@txn_type)`);
    const tx = db.transaction(() => {
      const results = [];
      // 一批共享一个单号
      const firstItem = items.find(r => r.code && r.qty && r.date);
      if (!firstItem) return results;
      if (!firstItem.txn_type) firstItem.txn_type = '正常出库';
      const sharedGinNo = genGinNo(firstItem.date, firstItem.txn_type);
      items.forEach(r => {
        if (!r.code || !r.qty || !r.date) return; // 跳过空行
        if (!r.gin_no) r.gin_no = sharedGinNo;
        if (!r.txn_type) r.txn_type = '正常出库';
        // 退库出库：确保 qty 为负数
        if (r.txn_type === '退库出库') r.qty = -Math.abs(r.qty);
        if (!r.destination) r.destination = '';
        if (!r.receiver) r.receiver = '';
        if (!r.handler) r.handler = '';
        if (!r.location) r.location = '';
        if (!r.remarks) r.remarks = '';
        r.cost_price = computeCostPrice(r.code, r.qty, r.date);
        stmt.run(r);
        results.push({ gin_no: r.gin_no, cost_price: r.cost_price });
      });
      return results;
    });
    const results = tx();
    res.json({ success: true, count: results.length, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/outbound/:id', requirePerm('outbound', 'edit'), (req, res) => {
  const r = req.body;
  try {
    if (!r.txn_type) r.txn_type = '正常出库';
    // 退库出库：确保 qty 为负数
    if (r.txn_type === '退库出库') r.qty = -Math.abs(r.qty);
    r.cost_price = computeCostPrice(r.code, r.qty, r.date);
    db.prepare(`UPDATE outbound SET date=@date,gin_no=@gin_no,code=@code,qty=@qty,destination=@destination,
      receiver=@receiver,handler=@handler,location=@location,remarks=@remarks,cost_price=@cost_price,txn_type=@txn_type WHERE id=@id`).run({ ...r, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/outbound/:id', requirePerm('outbound', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM outbound WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 库存汇总 ---
app.get('/api/stock-summary', requirePerm('stockSummary', 'view'), (req, res) => {
  const { keyword, category, status } = req.query;
  let summary = getStockSummary();
  if (keyword) {
    const kw = keyword.toLowerCase();
    summary = summary.filter(m =>
      m.code.toLowerCase().includes(kw) ||
      m.name.toLowerCase().includes(kw) ||
      (m.spec || '').toLowerCase().includes(kw) ||
      (m.brand || '').toLowerCase().includes(kw)
    );
  }
  if (category) summary = summary.filter(m => m.category === category);
  if (status) summary = summary.filter(m => m.stock_status === status);
  res.json(summary);
});

// --- 物料台账（单个物料进出库流水） ---
app.get('/api/ledger/:code', requirePerm('ledger', 'view'), (req, res) => {
  const code = req.params.code;
  const { startDate, endDate } = req.query;

  const m = db.prepare("SELECT * FROM materials WHERE code=?").get(code);
  if (!m) return res.status(404).json({ error: '物料不存在' });

  let inSql = "SELECT date, grn_no as doc_no, qty, price, supplier as party, handler, location, remarks, '入库' as type FROM inbound WHERE code=?";
  const params = [code];
  if (startDate) { inSql += " AND date>=?"; params.push(startDate); }
  if (endDate) { inSql += " AND date<?"; params.push(endDate + ' 23:59:59'); }

  let outSql = "SELECT date, gin_no as doc_no, qty, cost_price as price, destination || ' / ' || receiver as party, handler, location, remarks, '出库' as type FROM outbound WHERE code=?";
  const outParams = [code];
  if (startDate) { outSql += " AND date>=?"; outParams.push(startDate); }
  if (endDate) { outSql += " AND date<?"; outParams.push(endDate + ' 23:59:59'); }

  const txns = [
    ...db.prepare(inSql).all(...params),
    ...db.prepare(outSql).all(...outParams)
  ].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // 计算结余
  let balance = m.opening_qty;
  let totalIn = 0, totalOut = 0;
  const rows = [];

  // 期初行
  rows.push({
    seq: 0, date: '', doc_no: '', type: '期初',
    in_qty: '', out_qty: '',
    balance: m.opening_qty,
    price: m.opening_price,
    amount: Math.round(m.opening_qty * m.opening_price * 100) / 100,
    party: '', handler: '', location: m.default_location, remarks: ''
  });

  txns.forEach((t, i) => {
    if (t.type === '入库') {
      balance += t.qty;
      totalIn += t.qty;
    } else {
      balance -= t.qty;
      totalOut += t.qty;
    }
    rows.push({
      seq: i + 1,
      date: t.date,
      doc_no: t.doc_no,
      type: t.type,
      in_qty: t.type === '入库' ? t.qty : '',
      out_qty: t.type === '出库' ? t.qty : '',
      balance: Math.round(balance * 10000) / 10000,
      price: t.price,
      amount: Math.round(t.qty * t.price * 100) / 100,
      party: t.party || '',
      handler: t.handler || '',
      location: t.location || '',
      remarks: t.remarks || ''
    });
  });

  res.json({
    material: m,
    opening_qty: m.opening_qty,
    total_in: totalIn,
    total_out: totalOut,
    closing_qty: Math.round(balance * 10000) / 10000,
    rows
  });
});

// --- 位置库存 ---
app.get('/api/location-stock', requirePerm('locationStock', 'view'), (req, res) => {
  const { code, location } = req.query;
  const summary = getStockSummary();

  if (code) {
    // 按物料查看各位置库存
    const m = summary.find(s => s.code === code);
    if (!m) return res.json({});

    const locations = db.prepare("SELECT name FROM locations ORDER BY name").all().map(l => l.name);
    const result = locations.map(loc => {
      const opening = (m.default_location === loc ? m.opening_qty : 0);
      const inQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE code=? AND location=?").get(code, loc).v;
      const outQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM outbound WHERE code=? AND location=?").get(code, loc).v;
      const stock = opening + inQty - outQty;
      return { location: loc, opening, total_in: inQty, total_out: outQty, stock };
    }).filter(r => r.stock !== 0 || r.opening !== 0 || r.total_in !== 0 || r.total_out !== 0);

    res.json({ material: m, locations: result });
  } else if (location) {
    // 按位置查看物料库存
    const result = summary.filter(m => {
      const opening = (m.default_location === location ? m.opening_qty : 0);
      const inQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE code=? AND location=?").get(m.code, location).v;
      const outQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM outbound WHERE code=? AND location=?").get(m.code, location).v;
      const stock = opening + inQty - outQty;
      return stock !== 0;
    }).map(m => {
      const opening = (m.default_location === location ? m.opening_qty : 0);
      const inQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE code=? AND location=?").get(m.code, location).v;
      const outQty = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM outbound WHERE code=? AND location=?").get(m.code, location).v;
      return { ...m, location_stock: opening + inQty - outQty };
    });
    res.json({ location, items: result });
  } else {
    res.json({ error: '请提供 code 或 location 参数' });
  }
});

// --- 采购订单 ---
app.get('/api/purchase-orders', requirePerm('orders', 'view'), (req, res) => {
  const orders = db.prepare("SELECT * FROM purchase_orders ORDER BY date DESC").all();
  const result = orders.map(po => {
    const lines = db.prepare(`
      SELECT ol.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
      FROM order_lines ol LEFT JOIN materials m ON ol.code = m.code
      WHERE ol.po_no=? ORDER BY ol.id
    `).all(po.po_no);

    const orderAmount = lines.reduce((s, l) => s + l.order_amount, 0);
    const receivedAmount = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM inbound WHERE po_no=?").get(po.po_no).v;

    let deliveryStatus;
    if (po.manual_status === '已关闭' || po.manual_status === '已取消') {
      deliveryStatus = po.manual_status;
    } else if (lines.length === 0) {
      deliveryStatus = '无明细';
    } else if (receivedAmount === 0) {
      deliveryStatus = '未到货';
    } else if (receivedAmount < orderAmount) {
      deliveryStatus = '部分到货';
    } else {
      deliveryStatus = '已到货';
    }

    let overdueDays = 0;
    if (po.expected_date && (deliveryStatus === '未到货' || deliveryStatus === '部分到货')) {
      const diff = Math.floor((Date.now() - new Date(po.expected_date).getTime()) / 86400000);
      overdueDays = diff > 0 ? diff : 0;
    }

    return {
      ...po,
      lines,
      line_count: lines.length,
      order_amount: Math.round(orderAmount * 100) / 100,
      received_amount: Math.round(receivedAmount * 100) / 100,
      delivery_status: deliveryStatus,
      overdue_days: overdueDays
    };
  });
  res.json(result);
});

app.post('/api/purchase-orders', requirePerm('orders', 'create'), (req, res) => {
  const po = req.body;
  try {
    db.prepare("INSERT INTO purchase_orders (po_no,date,supplier,contract_no,project,expected_date,remarks,manual_status) VALUES (@po_no,@date,@supplier,@contract_no,@project,@expected_date,@remarks,@manual_status)").run(po);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/purchase-orders/:poNo', requirePerm('orders', 'edit'), (req, res) => {
  const po = req.body;
  try {
    db.prepare("UPDATE purchase_orders SET date=@date,supplier=@supplier,contract_no=@contract_no,project=@project,expected_date=@expected_date,remarks=@remarks,manual_status=@manual_status WHERE po_no=@po_no").run({ ...po, po_no: req.params.poNo });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/purchase-orders/:poNo', requirePerm('orders', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM order_lines WHERE po_no=?").run(req.params.poNo);
    db.prepare("DELETE FROM purchase_orders WHERE po_no=?").run(req.params.poNo);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 订单明细 ---
app.post('/api/order-lines', requirePerm('orders', 'create'), (req, res) => {
  const l = req.body;
  try {
    db.prepare("INSERT INTO order_lines (po_no,code,order_qty,order_price,remarks) VALUES (@po_no,@code,@order_qty,@order_price,@remarks)").run(l);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/order-lines/:id', requirePerm('orders', 'edit'), (req, res) => {
  const l = req.body;
  try {
    db.prepare("UPDATE order_lines SET po_no=@po_no,code=@code,order_qty=@order_qty,order_price=@order_price,remarks=@remarks WHERE id=@id").run({ ...l, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/order-lines/:id', requirePerm('orders', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM order_lines WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 查询某个订单的明细带已到货数量（给入库选订单用）
app.get('/api/order-lines/by-po/:poNo', requirePerm('orders', 'view'), (req, res) => {
  try {
    res.json(getOrderLinesForInbound(req.params.poNo));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/order-lines/by-contract/:contractNo', requirePerm('orders', 'view'), (req, res) => {
  try {
    res.json(getOrderLinesByContract(req.params.contractNo));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 订单明细跟踪（全量查询，支持筛选）
app.get('/api/order-tracking', requirePerm('orderTracking', 'view'), (req, res) => {
  const { poNo, supplier, keyword, deliveryStatus } = req.query;
  let sql = `SELECT ol.*, po.date as po_date, po.supplier as po_supplier, po.expected_date, po.manual_status,
    m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol
    LEFT JOIN purchase_orders po ON ol.po_no = po.po_no
    LEFT JOIN materials m ON ol.code = m.code
    WHERE 1=1`;
  const params = [];
  if (poNo) { sql += " AND ol.po_no=?"; params.push(poNo); }
  if (supplier) { sql += " AND po.supplier LIKE ?"; params.push('%' + supplier + '%'); }
  if (keyword) {
    sql += " AND (ol.code LIKE ? OR m.name LIKE ? OR m.spec LIKE ? OR m.brand LIKE ? OR ol.po_no LIKE ?)";
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  sql += " ORDER BY ol.po_no, ol.id";
  let rows = db.prepare(sql).all(...params);

  // 计算每行的到货情况
  rows = rows.map(l => {
    const received = db.prepare("SELECT COALESCE(SUM(qty),0) as v FROM inbound WHERE po_no=? AND code=?").get(l.po_no, l.code).v;
    const unreceived = l.order_qty - received;
    let lineStatus;
    if (l.manual_status === '已关闭' || l.manual_status === '已取消') {
      lineStatus = l.manual_status;
    } else if (received === 0) {
      lineStatus = '未到货';
    } else if (received < l.order_qty) {
      lineStatus = '部分到货';
    } else {
      lineStatus = '已到货';
    }
    let overdueDays = 0;
    if (l.expected_date && (lineStatus === '未到货' || lineStatus === '部分到货')) {
      const diff = Math.floor((Date.now() - new Date(l.expected_date).getTime()) / 86400000);
      overdueDays = diff > 0 ? diff : 0;
    }
    return {
      ...l,
      received_qty: received,
      unreceived_qty: unreceived,
      line_status: lineStatus,
      overdue_days: overdueDays
    };
  });

  // 按到货状态筛选
  if (deliveryStatus) {
    rows = rows.filter(r => r.line_status === deliveryStatus);
  }

  res.json(rows);
});

// --- 参数 ---
app.get('/api/params', (req, res) => {
  const currency = db.prepare("SELECT value FROM params WHERE key='currency'").get().value;
  const categories = db.prepare("SELECT * FROM categories ORDER BY id").all();
  const units = db.prepare("SELECT * FROM units ORDER BY id").all();
  const destinations = db.prepare("SELECT * FROM destinations ORDER BY id").all();
  const locations = db.prepare("SELECT * FROM locations ORDER BY id").all();
  res.json({ currency, categories, units, destinations, locations });
});

app.post('/api/params/:type', requirePerm('settings', 'create'), (req, res) => {
  const { name, prefix } = req.body;
  const type = req.params.type;
  const tableMap = { categories: 'categories', units: 'units', destinations: 'destinations', locations: 'locations' };
  const table = tableMap[type];
  if (!table) return res.status(400).json({ error: '无效类型' });
  try {
    if (table === 'categories') {
      db.prepare("INSERT INTO categories (name, prefix) VALUES (?, ?)").run(name, prefix || '');
    } else {
      db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/params/:type/:id', requirePerm('settings', 'delete'), (req, res) => {
  const tableMap = { categories: 'categories', units: 'units', destinations: 'destinations', locations: 'locations' };
  const table = tableMap[req.params.type];
  if (!table) return res.status(400).json({ error: '无效类型' });
  try {
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 前端路由 ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  库存进出库管理系统已启动`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
