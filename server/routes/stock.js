/**
 * 库存汇总 & 物料台账
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { getStockSummary } = require('../services/stock');

const router = express.Router();

// --- 库存汇总 ---
router.get('/api/stock-summary', requirePerm('stockSummary', 'view'), (req, res) => {
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

// --- 物料台账（单个物料进出库流水 + 调整流水） ---
router.get('/api/ledger/:code', requirePerm('ledger', 'view'), (req, res) => {
  const code = req.params.code;
  const { startDate, endDate } = req.query;

  const m = db.prepare("SELECT * FROM materials WHERE code=?").get(code);
  if (!m) return res.status(404).json({ error: '物料不存在' });

  let inSql = "SELECT date, grn_no as doc_no, qty, price, supplier as party, handler, remarks, '入库' as type FROM inbound WHERE code=? AND status='posted'";
  const params = [code];
  if (startDate) { inSql += " AND date>=?"; params.push(startDate); }
  if (endDate) { inSql += " AND date<?"; params.push(endDate + ' 23:59:59'); }

  let outSql = "SELECT date, gin_no as doc_no, qty, cost_price as price, destination || ' / ' || receiver as party, handler, remarks, '出库' as type FROM outbound WHERE code=?";
  const outParams = [code];
  if (startDate) { outSql += " AND date>=?"; outParams.push(startDate); }
  if (endDate) { outSql += " AND date<?"; outParams.push(endDate + ' 23:59:59'); }

  // 调整流水：盘盈为正、盘亏为负。单独取 price=0 / amount=0，
  // 因为调整不参与成本核算（本期范围外）
  // 调整流水无独立单号，统一以来源盘点单号作为单据号追溯
  let adjSql = "SELECT date, stocktake_no as doc_no, qty, 0 as price, adj_type, reason, handler, remarks, '调整' as type FROM stock_adjustments WHERE code=?";
  const adjParams = [code];
  if (startDate) { adjSql += " AND date>=?"; adjParams.push(startDate); }
  if (endDate) { adjSql += " AND date<?"; adjParams.push(endDate + ' 23:59:59'); }

  const txns = [
    ...db.prepare(inSql).all(...params),
    ...db.prepare(outSql).all(...outParams),
    ...db.prepare(adjSql).all(...adjParams)
  ].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // 计算结余
  let balance = m.opening_qty;
  let totalIn = 0, totalOut = 0, totalAdj = 0;
  const rows = [];

  // 期初行
  rows.push({
    seq: 0, date: '', doc_no: '', type: '期初',
    in_qty: '', out_qty: '', adj_qty: '', adj_type: '',
    balance: m.opening_qty,
    price: m.opening_price,
    amount: Math.round(m.opening_qty * m.opening_price * 100) / 100,
    party: '', handler: '', remarks: ''
  });

  txns.forEach((t, i) => {
    if (t.type === '入库') {
      balance += t.qty;
      totalIn += t.qty;
    } else if (t.type === '出库') {
      balance -= t.qty;
      totalOut += t.qty;
    } else {
      // 调整：qty 已带符号（正=盘盈、负=盘亏），直接累加即可
      // 注意：不能落入上面的出库分支，否则负数盘亏会被反向加库存
      balance += t.qty;
      totalAdj += t.qty;
    }
    rows.push({
      seq: i + 1,
      date: t.date,
      doc_no: t.doc_no,
      type: t.type,
      in_qty: t.type === '入库' ? t.qty : '',
      out_qty: t.type === '出库' ? t.qty : '',
      adj_qty: t.type === '调整' ? t.qty : '',
      adj_type: t.type === '调整' ? (t.adj_type || '') : '',
      balance: Math.round(balance * 10000) / 10000,
      price: t.price,
      amount: Math.round(t.qty * t.price * 100) / 100,
      party: t.type === '调整' ? '' : (t.party || ''),
      handler: t.handler || '',
      remarks: t.type === '调整' ? ([t.reason, t.remarks].filter(Boolean).join(' / ')) : (t.remarks || '')
    });
  });

  res.json({
    material: m,
    opening_qty: m.opening_qty,
    total_in: totalIn,
    total_out: totalOut,
    total_adj: totalAdj,
    closing_qty: Math.round(balance * 10000) / 10000,
    rows
  });
});


module.exports = router;
