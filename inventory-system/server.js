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
}
migrateDB();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
function genGrnNo(date) {
  const d = date.replace(/-/g, '');
  const count = db.prepare("SELECT COUNT(*) as c FROM inbound WHERE grn_no LIKE ?").get(`GRN-${d}%`).c;
  return `GRN-${d}-${String(count + 1).padStart(3, '0')}`;
}
function genGinNo(date) {
  const d = date.replace(/-/g, '');
  const count = db.prepare("SELECT COUNT(*) as c FROM outbound WHERE gin_no LIKE ?").get(`GIN-${d}%`).c;
  return `GIN-${d}-${String(count + 1).padStart(3, '0')}`;
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
  // 编码格式：前缀 + 3位序号（不足补零）
  return `${prefix}${String(nextSeq).padStart(3, '0')}`;
}

// 获取订单明细（用于入库时选择订单带出明细）
function getOrderLinesForInbound(poNo) {
  const lines = db.prepare(`
    SELECT ol.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM order_lines ol LEFT JOIN materials m ON ol.code = m.code
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
  }));
}

// ==================== API 路由 ====================

// --- 仪表盘 ---
app.get('/api/dashboard', (req, res) => {
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
app.get('/api/materials', (req, res) => {
  const rows = db.prepare("SELECT * FROM materials ORDER BY code").all();
  res.json(rows);
});

// 自动生成物料编码（按类别前缀）
app.get('/api/materials/next-code', (req, res) => {
  const category = req.query.category;
  if (!category) return res.status(400).json({ error: '请提供类别' });
  try {
    const code = genMaterialCode(category);
    res.json({ code });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/materials', (req, res) => {
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

app.put('/api/materials/:code', (req, res) => {
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

app.delete('/api/materials/:code', (req, res) => {
  try {
    db.prepare("DELETE FROM materials WHERE code=?").run(req.params.code);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 供应商 ---
app.get('/api/suppliers', (req, res) => {
  res.json(db.prepare("SELECT * FROM suppliers ORDER BY name").all());
});

app.post('/api/suppliers', (req, res) => {
  try {
    db.prepare("INSERT INTO suppliers (name,contact,phone,remarks) VALUES (@name,@contact,@phone,@remarks)").run(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/suppliers/:id', (req, res) => {
  try {
    db.prepare("UPDATE suppliers SET name=@name,contact=@contact,phone=@phone,remarks=@remarks WHERE id=@id").run({ ...req.body, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/suppliers/:id', (req, res) => {
  try {
    db.prepare("DELETE FROM suppliers WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 入库记录 ---
app.get('/api/inbound', (req, res) => {
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
app.post('/api/inbound', (req, res) => {
  const body = req.body;
  // 兼容：单行（有 code 字段）或多行（items 数组）
  const items = Array.isArray(body.items) ? body.items : [body];
  if (items.length === 0) return res.status(400).json({ error: '无数据' });
  try {
    const stmt = db.prepare(`INSERT INTO inbound (date,grn_no,code,qty,price,supplier,handler,location,remarks,po_no,contract_no,txn_type)
      VALUES (@date,@grn_no,@code,@qty,@price,@supplier,@handler,@location,@remarks,@po_no,@contract_no,@txn_type)`);
    const tx = db.transaction(() => {
      const results = [];
      items.forEach(r => {
        if (!r.code || !r.qty || !r.date) return; // 跳过空行
        if (!r.grn_no) r.grn_no = genGrnNo(r.date);
        if (!r.txn_type) r.txn_type = '采购入库';
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

app.put('/api/inbound/:id', (req, res) => {
  const r = req.body;
  try {
    if (!r.txn_type) r.txn_type = '采购入库';
    db.prepare(`UPDATE inbound SET date=@date,grn_no=@grn_no,code=@code,qty=@qty,price=@price,
      supplier=@supplier,handler=@handler,location=@location,remarks=@remarks,po_no=@po_no,contract_no=@contract_no,txn_type=@txn_type WHERE id=@id`).run({ ...r, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/inbound/:id', (req, res) => {
  try {
    db.prepare("DELETE FROM inbound WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 出库记录 ---
app.get('/api/outbound', (req, res) => {
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
app.post('/api/outbound', (req, res) => {
  const body = req.body;
  const items = Array.isArray(body.items) ? body.items : [body];
  if (items.length === 0) return res.status(400).json({ error: '无数据' });
  try {
    const stmt = db.prepare(`INSERT INTO outbound (date,gin_no,code,qty,destination,receiver,handler,location,remarks,cost_price,txn_type)
      VALUES (@date,@gin_no,@code,@qty,@destination,@receiver,@handler,@location,@remarks,@cost_price,@txn_type)`);
    const tx = db.transaction(() => {
      const results = [];
      items.forEach(r => {
        if (!r.code || !r.qty || !r.date) return; // 跳过空行
        if (!r.gin_no) r.gin_no = genGinNo(r.date);
        if (!r.txn_type) r.txn_type = '正常出库';
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

app.put('/api/outbound/:id', (req, res) => {
  const r = req.body;
  try {
    r.cost_price = computeCostPrice(r.code, r.qty, r.date);
    if (!r.txn_type) r.txn_type = '正常出库';
    db.prepare(`UPDATE outbound SET date=@date,gin_no=@gin_no,code=@code,qty=@qty,destination=@destination,
      receiver=@receiver,handler=@handler,location=@location,remarks=@remarks,cost_price=@cost_price,txn_type=@txn_type WHERE id=@id`).run({ ...r, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/outbound/:id', (req, res) => {
  try {
    db.prepare("DELETE FROM outbound WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 库存汇总 ---
app.get('/api/stock-summary', (req, res) => {
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
app.get('/api/ledger/:code', (req, res) => {
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
app.get('/api/location-stock', (req, res) => {
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
app.get('/api/purchase-orders', (req, res) => {
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

app.post('/api/purchase-orders', (req, res) => {
  const po = req.body;
  try {
    db.prepare("INSERT INTO purchase_orders (po_no,date,supplier,contract_no,project,expected_date,remarks,manual_status) VALUES (@po_no,@date,@supplier,@contract_no,@project,@expected_date,@remarks,@manual_status)").run(po);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/purchase-orders/:poNo', (req, res) => {
  const po = req.body;
  try {
    db.prepare("UPDATE purchase_orders SET date=@date,supplier=@supplier,contract_no=@contract_no,project=@project,expected_date=@expected_date,remarks=@remarks,manual_status=@manual_status WHERE po_no=@po_no").run({ ...po, po_no: req.params.poNo });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/purchase-orders/:poNo', (req, res) => {
  try {
    db.prepare("DELETE FROM order_lines WHERE po_no=?").run(req.params.poNo);
    db.prepare("DELETE FROM purchase_orders WHERE po_no=?").run(req.params.poNo);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 订单明细 ---
app.post('/api/order-lines', (req, res) => {
  const l = req.body;
  try {
    db.prepare("INSERT INTO order_lines (po_no,code,order_qty,order_price,remarks) VALUES (@po_no,@code,@order_qty,@order_price,@remarks)").run(l);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/order-lines/:id', (req, res) => {
  const l = req.body;
  try {
    db.prepare("UPDATE order_lines SET po_no=@po_no,code=@code,order_qty=@order_qty,order_price=@order_price,remarks=@remarks WHERE id=@id").run({ ...l, id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/order-lines/:id', (req, res) => {
  try {
    db.prepare("DELETE FROM order_lines WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 查询某个订单的明细带已到货数量（给入库选订单用）
app.get('/api/order-lines/by-po/:poNo', (req, res) => {
  try {
    res.json(getOrderLinesForInbound(req.params.poNo));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 订单明细跟踪（全量查询，支持筛选）
app.get('/api/order-tracking', (req, res) => {
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

app.post('/api/params/:type', (req, res) => {
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

app.delete('/api/params/:type/:id', (req, res) => {
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
