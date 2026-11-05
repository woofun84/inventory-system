/**
 * 库存调整流水（只读查询）
 *
 * 说明（方案调整）：
 *   - 独立的「库存调整」业务模块已取消，不再提供手工新增 / 编辑 / 删除。
 *   - 调整流水全部由「库存盘点」确认时按差异自动生成，流水上记录来源盘点单
 *     （stocktake_no）、物料（code）、调整数量（qty）、操作人（handler / created_by）
 *     与时间（created_at），保证每次盘盈 / 盘亏都能追溯到来源。
 *   - 本路由仅保留只读查询，挂在 stocktake 模块的 view 权限下。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');

const router = express.Router();

// 列表：支持 物料 / 日期区间 / 调整类型 / 关键字 筛选
router.get('/api/stock-adjustments', requirePerm('stocktake', 'view'), (req, res) => {
  const { code, startDate, endDate, adjType, keyword } = req.query;
  let sql = `SELECT a.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit
    FROM stock_adjustments a LEFT JOIN materials m ON a.code = m.code WHERE 1=1`;
  const params = [];
  if (code) { sql += " AND a.code=?"; params.push(code); }
  if (startDate) { sql += " AND a.date>=?"; params.push(startDate); }
  if (endDate) { sql += " AND a.date<?"; params.push(endDate + ' 23:59:59'); }
  if (adjType) { sql += " AND a.adj_type=?"; params.push(adjType); }
  if (keyword) {
    sql += " AND (a.code LIKE ? OR m.name LIKE ? OR a.reason LIKE ? OR a.handler LIKE ? OR a.remarks LIKE ? OR a.stocktake_no LIKE ?)";
    const k = '%' + keyword + '%';
    params.push(k, k, k, k, k, k);
  }
  sql += " ORDER BY a.date DESC, a.id DESC";
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
