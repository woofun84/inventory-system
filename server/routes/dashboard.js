/**
 * 仪表盘
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { getStockSummary } = require('../services/stock');
const time = require('../services/time');

const router = express.Router();

// --- 仪表盘 ---
router.get('/api/dashboard', requirePerm('dashboard', 'view'), (req, res) => {
  const summary = getStockSummary();
  const totalItems = summary.length;
  const totalValue = summary.reduce((s, m) => s + m.stock_value, 0);

  // 本月入库金额
  const now = new Date();
  const monthStart = time.toLocalDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = time.toLocalDate(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const monthInAmount = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM inbound WHERE date>=? AND date<? AND status='posted'").get(monthStart, monthEnd).v;
  const monthOutAmount = db.prepare("SELECT COALESCE(SUM(cost_amount),0) as v FROM outbound WHERE date>=? AND date<?").get(monthStart, monthEnd).v;
  const monthInCount = db.prepare("SELECT COUNT(*) as c FROM inbound WHERE date>=? AND date<? AND status='posted'").get(monthStart, monthEnd).c;
  const monthOutCount = db.prepare("SELECT COUNT(*) as c FROM outbound WHERE date>=? AND date<?").get(monthStart, monthEnd).c;

  const alerts = summary.filter(m => m.stock_status === '补货' || m.stock_status === '缺货');

  // 近6个月趋势
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const msStr = time.toLocalDate(ms);
    const meStr = time.toLocalDate(me);
    const inAmt = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM inbound WHERE date>=? AND date<? AND status='posted'").get(msStr, meStr).v;
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
           (SELECT COALESCE(SUM(amount),0) FROM inbound i WHERE i.po_no = po.po_no AND i.status='posted') as received_amount
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


module.exports = router;
