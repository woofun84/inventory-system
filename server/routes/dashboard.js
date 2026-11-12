/**
 * 仪表盘
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const { getStockSummary, stripSummaryPrice, RECEIVED_BY_LINE } = require('../services/stock');
const time = require('../services/time');

const router = express.Router();

// 成本差异阈值：|累计未结转差异| 超过库存总金额的 5% 时，前端标黄提示。
// 需要调整口径时只改这一个常量（0.05 = 5%）。
const COST_VARIANCE_ALERT_RATIO = 0.05;

// --- 仪表盘 ---
router.get('/api/dashboard', requirePerm('dashboard', 'view'), (req, res) => {
  const summary = getStockSummary();
  const totalItems = summary.length;
  const totalValue = summary.reduce((s, m) => s + m.stock_value, 0);

  // 本月入库金额
  const now = new Date();
  const monthStart = time.toLocalDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = time.toLocalDate(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const monthInAmount = db.prepare("SELECT COALESCE(SUM(amount),0) as amount FROM inbound WHERE date>=? AND date<? AND status='posted'").get(monthStart, monthEnd).amount;
  const monthOutAmount = db.prepare("SELECT COALESCE(SUM(cost_amount),0) as amount FROM outbound WHERE date>=? AND date<? AND status='posted'").get(monthStart, monthEnd).amount;
  const monthInCount = db.prepare("SELECT COUNT(*) as c FROM inbound WHERE date>=? AND date<? AND status='posted'").get(monthStart, monthEnd).c;
  const monthOutCount = db.prepare("SELECT COUNT(*) as c FROM outbound WHERE date>=? AND date<? AND status='posted'").get(monthStart, monthEnd).c;

  // 本月业务构成：一次查询拿到入库侧/出库侧的分组，再在内存里归并为固定六行。
  // 出库侧按 outbound_docs.origin_doc_no 是否为空区分「领料退库（有/无原单）」。
  const breakdownRaw = db.prepare(`
    SELECT 'in' AS side, t.txn_type AS txn_type, -1 AS has_origin,
           COUNT(DISTINCT t.doc_no) AS doc_count,
           COALESCE(SUM(t.qty),0) AS qty,
           COALESCE(SUM(t.amount),0) AS amount
    FROM inbound t
    WHERE t.date>=? AND t.date<? AND t.status='posted'
    GROUP BY t.txn_type
    UNION ALL
    SELECT 'out' AS side, t.txn_type AS txn_type,
           CASE WHEN COALESCE(d.origin_doc_no,'')='' THEN 0 ELSE 1 END AS has_origin,
           COUNT(DISTINCT t.doc_no) AS doc_count,
           COALESCE(SUM(t.qty),0) AS qty,
           COALESCE(SUM(t.cost_amount),0) AS amount
    FROM outbound t
    LEFT JOIN outbound_docs d ON d.doc_no = t.doc_no
    WHERE t.date>=? AND t.date<? AND t.status='posted'
    GROUP BY t.txn_type, CASE WHEN COALESCE(d.origin_doc_no,'')='' THEN 0 ELSE 1 END
  `).all(monthStart, monthEnd, monthStart, monthEnd);

  const compAgg = {};
  for (const r of breakdownRaw) {
    let key = null;
    if (r.side === 'in') {
      key = ({ '采购入库': 'purchase_in', '零星入库': 'misc_in', '采购退货': 'purchase_return' })[r.txn_type] || null;
    } else if (r.txn_type === '正常出库') {
      key = 'normal_out';
    } else if (r.txn_type === '领料退库') {
      key = r.has_origin === 1 ? 'return_with' : 'return_without';
    }
    if (!key) continue;
    if (!compAgg[key]) compAgg[key] = { doc_count: 0, qty: 0, amount: 0 };
    // 方向化有符号口径：入库照存储值，出库取反（正常出库为负、退库为正）
    const sign = r.side === 'out' ? -1 : 1;
    compAgg[key].doc_count += r.doc_count;
    compAgg[key].qty += r.qty * sign;
    compAgg[key].amount += r.amount * sign;
  }
  const compKeys = ['purchase_in', 'misc_in', 'purchase_return', 'normal_out', 'return_with', 'return_without'];
  const monthBreakdown = compKeys.map(k => {
    const v = compAgg[k] || { doc_count: 0, qty: 0, amount: 0 };
    return {
      key: k,
      doc_count: v.doc_count,
      qty: Math.round(v.qty * 1000) / 1000,
      amount: Math.round(v.amount * 100) / 100
    };
  });
  const monthBreakdownTotal = monthBreakdown.reduce((s, r) => ({
    doc_count: s.doc_count + r.doc_count,
    qty: Math.round((s.qty + r.qty) * 1000) / 1000,
    amount: Math.round((s.amount + r.amount) * 100) / 100
  }), { doc_count: 0, qty: 0, amount: 0 });

  const alerts = summary.filter(m => m.stock_status === '补货' || m.stock_status === '缺货');

  // 近6个月趋势
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const msStr = time.toLocalDate(ms);
    const meStr = time.toLocalDate(me);
    const inAmt = db.prepare("SELECT COALESCE(SUM(amount),0) as amount FROM inbound WHERE date>=? AND date<? AND status='posted'").get(msStr, meStr).amount;
    const outAmt = db.prepare("SELECT COALESCE(SUM(cost_amount),0) as amount FROM outbound WHERE date>=? AND date<? AND status='posted'").get(msStr, meStr).amount;
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

  // 逾期采购订单：到货数量/金额统一走采购明细行级口径（services/stock.js RECEIVED_BY_LINE），
  // 与采购模块的「已到货 / 未到货」判断保持一致（退货按有符号数量净扣）。
  const overdueOrders = db.prepare(`
    SELECT po.po_no, po.supplier, po.expected_date, po.project,
           (SELECT COUNT(*) FROM order_lines ol WHERE ol.po_no = po.po_no) as line_count,
           (SELECT COALESCE(SUM(ol.order_qty),0) FROM order_lines ol WHERE ol.po_no = po.po_no) as order_qty,
           (SELECT COALESCE(SUM(ol.order_amount),0) FROM order_lines ol WHERE ol.po_no = po.po_no) as order_amount,
           (SELECT COALESCE(SUM(${RECEIVED_BY_LINE}),0) FROM order_lines ol WHERE ol.po_no = po.po_no) as received_qty
    FROM purchase_orders po
    WHERE po.manual_status NOT IN ('已关闭','已取消')
      AND po.expected_date != '' AND po.expected_date < date('now')
    ORDER BY po.expected_date ASC
  `).all().map(po => {
    const received = Number(po.received_qty || 0);
    const ordered = Number(po.order_qty || 0);
    let deliveryStatus;
    if (po.line_count === 0) deliveryStatus = '无明细';
    else if (received <= 0) deliveryStatus = '未到货';
    else if (received + 0.0001 < ordered) deliveryStatus = '部分到货';
    else deliveryStatus = '已到货';
    const overdueDays = Math.floor((Date.now() - new Date(po.expected_date).getTime()) / 86400000);
    return { ...po, delivery_status: deliveryStatus, overdue_days: overdueDays };
  }).filter(po => po.delivery_status === '未到货' || po.delivery_status === '部分到货');

  // 累计成本差异（未结转）：数量归零时被抹平的账面残值，正负都算差异
  // 别名与金额列同名，scaled-db 会把「分」换算成「元」
  const cvAgg = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
    FROM cost_variances WHERE status='open'`).get();
  const costVarianceTotal = Math.round(Number(cvAgg.amount) * 100) / 100;
  const costVarianceCount = Number(cvAgg.count);
  const stockValueTotal = Math.round(totalValue * 100) / 100;

  // 全站统一人民币：库中历史值可能是文档示例里的外币代码（如 SAR），对外一律按 ¥ 返回，不写库
  const currency = '¥';
  const vp = req.canViewPrice;

  // 无价格权限：金额 / 占比 / 趋势金额 / 类目金额整组不下发，数量与笔数口径保持不变
  const body = {
    total_items: totalItems,
  };
  if (vp) {
    body.total_value = Math.round(totalValue * 100) / 100;
    body.month_in_amount = Math.round(monthInAmount * 100) / 100;
    body.month_out_amount = Math.round(monthOutAmount * 100) / 100;
  }
  body.month_txn_count = monthInCount + monthOutCount;
  body.month_breakdown = vp
    ? monthBreakdown
    : monthBreakdown.map(r => ({ key: r.key, doc_count: r.doc_count, qty: r.qty }));
  body.month_breakdown_total = vp
    ? monthBreakdownTotal
    : { doc_count: monthBreakdownTotal.doc_count, qty: monthBreakdownTotal.qty };
  body.alert_count = alerts.length;
  body.alerts = (vp ? alerts : alerts.map(stripSummaryPrice)).slice(0, 10);
  body.months_trend = vp ? months : months.map(m => ({ label: m.label }));
  if (vp) {
    body.category_values = categoryValues;
    body.top_items = topItems;
    body.overdue_orders = overdueOrders;
    body.cost_variance = {
      total: costVarianceTotal,
      count: costVarianceCount,
      stock_value: stockValueTotal,
      ratio: COST_VARIANCE_ALERT_RATIO,
      exceeded: Math.abs(costVarianceTotal) > stockValueTotal * COST_VARIANCE_ALERT_RATIO,
    };
  } else {
    body.overdue_orders = overdueOrders.map(po => {
      const o = { ...po };
      delete o.order_amount;
      return o;
    });
  }
  body.currency = currency;
  res.json(body);
});


module.exports = router;
