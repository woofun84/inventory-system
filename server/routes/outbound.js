/**
 * 出库相关接口（单据列表、明细、草稿/确认/作废、冲销）
 *
 * 与入库保持一致：outbound_docs 是单据头，outbound 明细行通过 doc_no 关联；
 * 草稿态明细行 status='draft' 不计入库存，确认过账后 status='posted' 才纳入库存。
 */
const express = require('express');
const db = require('../db');
const { requirePerm } = require('../middleware/auth');
const {
  validateOutboundStock,
  computeCostPrice,
  getAvailableStock,
  getReturnableLines,
  validateReturnAgainstOrigin,
  loadReturnableOrigin,
} = require('../services/stock');
const docno = require('../services/docno');
const time = require('../services/time');
const sign = require('../services/sign');

const router = express.Router();

// --- 出库记录（明细流水，查询中心/库存台账使用，仅返回已过账行） ---
router.get('/api/outbound', requirePerm('outbound', 'view'), (req, res) => {
  const { code, startDate, endDate, destination, receiver, handler, keyword, txnType } = req.query;
  let sql = `SELECT o.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM outbound o LEFT JOIN materials m ON o.code = m.code WHERE o.status='posted'`;
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

// 批量出库：支持一次提交多行（兼容入口，直接生成已过账流水）
router.post('/api/outbound', requirePerm('outbound', 'create'), (req, res) => {
  const body = req.body;
  const raw = Array.isArray(body.items) ? body.items : [body];
  if (raw.length === 0) return res.status(400).json({ error: '无数据' });
  // 管理员/主管可强制放行超量出库（仅限正常出库，退库出库不受影响）
  const forceAllow = body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);
  try {
    const stmt = db.prepare(`INSERT INTO outbound (date,gin_no,doc_no,code,qty,destination,receiver,handler,remarks,cost_price,txn_type,status)
      VALUES (@date,@gin_no,@doc_no,@code,@qty,@destination,@receiver,@handler,@remarks,@cost_price,@txn_type,'posted')`);

    // 先规整出「有效行」：校验与写入必须基于同一批行
    // 只按物料筛选，数量缺失交给 sign.normalizeQty 显式报错，避免 0/空行被静默丢弃
    const items = raw
      .filter(r => r && r.code)
      .map(r => ({ ...r, date: r.date || body.date || '' }))
      .filter(r => r.date);
    if (items.length === 0) return res.status(400).json({ error: '没有有效的出库行（缺少物料或日期）' });

    // 统一规范化：补默认字段 + 按类型推导数量符号（校验前完成，保证口径一致）
    const firstItem = items[0];
    if (!firstItem.txn_type) firstItem.txn_type = '正常出库';
    const sharedGinNo = genOutboundDocNo(firstItem.date, firstItem.txn_type);
    items.forEach(r => {
      if (!r.gin_no) r.gin_no = sharedGinNo;
      if (!r.doc_no) r.doc_no = r.gin_no;
      if (!r.txn_type) r.txn_type = '正常出库';
      r.qty = sign.normalizeQty(r.txn_type, r.qty);
      if (!r.destination) r.destination = '';
      if (!r.receiver) r.receiver = '';
      if (!r.handler) r.handler = '';
      if (!r.remarks) r.remarks = '';
    });

    const tx = db.transaction(() => {
      // 库存校验放在事务内，保证「校验 → 写入」原子性
      if (!forceAllow) {
        validateOutboundStock(items);
      }
      const results = [];
      items.forEach(r => {
        r.cost_price = computeCostPrice(r.code, r.qty, r.date);
        const info = stmt.run(r);
        results.push({ id: Number(info.lastInsertRowid), gin_no: r.gin_no, cost_price: r.cost_price });
      });
      return results;
    });

    const results = tx();
    res.json({ success: true, count: results.length, results, forced: forceAllow });
  } catch (e) {
    if (e.stockError) {
      return res.status(400).json({
        error: `库存不足：${e.details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
        code: 'INSUFFICIENT_STOCK',
        details: e.details
      });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/outbound/:id', requirePerm('outbound', 'edit'), (req, res) => {
  const body = req.body;
  const forceAllow = body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);
  try {
    // 读取原记录：缺失的可选字段回退到原值，避免 SQL 参数缺失导致整个编辑失败
    const old = db.prepare('SELECT * FROM outbound WHERE id=?').get(req.params.id);
    if (!old) return res.status(404).json({ error: '出库记录不存在' });
    const oldType = old.txn_type || '正常出库';
    const txnType = body.txn_type || oldType;
    const qty = body.qty !== undefined && body.qty !== ''
      ? sign.normalizeQty(txnType, body.qty)
      : (txnType === oldType ? old.qty : sign.normalizeQty(txnType, sign.absQty(old.qty)));
    const r = {
      date: body.date || old.date,
      gin_no: body.gin_no !== undefined ? body.gin_no : old.gin_no,
      code: body.code || old.code,
      qty,
      destination: body.destination !== undefined ? body.destination : old.destination,
      receiver: body.receiver !== undefined ? body.receiver : old.receiver,
      handler: body.handler !== undefined ? body.handler : old.handler,
      remarks: body.remarks !== undefined ? body.remarks : old.remarks,
      txn_type: txnType
    };
    // 编辑场景：排除本条记录自身的扣减量后再校验
    if (!forceAllow) {
      validateOutboundStock([r], req.params.id);
    }
    r.cost_price = computeCostPrice(r.code, r.qty, r.date);
    db.prepare(`UPDATE outbound SET date=@date,gin_no=@gin_no,code=@code,qty=@qty,destination=@destination,
      receiver=@receiver,handler=@handler,remarks=@remarks,cost_price=@cost_price,txn_type=@txn_type WHERE id=@id`).run({ ...r, id: req.params.id });
    res.json({ success: true, id: Number(req.params.id), forced: forceAllow });
  } catch (e) {
    if (e.stockError) {
      return res.status(400).json({
        error: `库存不足：${e.details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
        code: 'INSUFFICIENT_STOCK',
        details: e.details
      });
    }
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/outbound/:id', requirePerm('outbound', 'delete'), (req, res) => {
  try {
    db.prepare("DELETE FROM outbound WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== 出库单据（草稿/确认/作废 状态流转） ====================

// 生成出库单据号（正常出库 GIN / 退库出库 GIT，规则见 services/docno.js，前缀可在参数设置中修改）
function genOutboundDocNo(date, txnType) {
  return docno.genDocNo(txnType === '退库出库' ? 'git' : 'gin', date);
}

// 生成出库冲销单号（RV，入库/出库共用一套序号，规则见 services/docno.js）
function genOutboundReversalDocNo(date) {
  return docno.genDocNo('rv', date);
}

// 记录单据操作日志
function logOutboundDoc(docNo, action, operator, detail) {
  db.prepare("INSERT INTO outbound_doc_logs (doc_no, action, operator, detail) VALUES (?, ?, ?, ?)")
    .run(docNo, action, operator || '', detail || '');
}

// 出库单据列表（支持按状态/关键字/日期/类型筛选；excludeType 用于列表排除某类单据）
router.get('/api/outbound-docs', requirePerm('outbound', 'view'), (req, res) => {
  const { status, keyword, dateFrom, dateTo, txnType, excludeType } = req.query;
  let sql = `SELECT d.*,
    (SELECT COUNT(*) FROM outbound o WHERE o.doc_no = d.doc_no) as line_count,
    (SELECT COALESCE(SUM(qty),0) FROM outbound o WHERE o.doc_no = d.doc_no) as total_qty,
    (SELECT COALESCE(SUM(cost_amount),0) FROM outbound o WHERE o.doc_no = d.doc_no) as total_amount
    FROM outbound_docs d WHERE 1=1`;
  const params = [];
  if (status) { sql += " AND d.status=?"; params.push(status); }
  if (txnType) { sql += " AND d.txn_type=?"; params.push(txnType); }
  if (excludeType) {
    const types = String(excludeType).split(',').map(s => s.trim()).filter(Boolean);
    if (types.length) {
      sql += ' AND d.txn_type NOT IN (' + types.map(() => '?').join(',') + ')';
      params.push(...types);
    }
  }
  if (dateFrom) { sql += " AND d.date>=?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND d.date<?"; params.push(dateTo + ' 23:59:59'); }
  if (keyword) {
    sql += " AND (d.doc_no LIKE ? OR d.destination LIKE ? OR d.receiver LIKE ? OR d.handler LIKE ? OR d.remarks LIKE ?)";
    const kw = '%' + keyword + '%';
    params.push(kw, kw, kw, kw, kw);
  }
  sql += " ORDER BY d.date DESC, d.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

// 获取下一个出库单据号
router.get('/api/outbound-docs/next-no', requirePerm('outbound', 'view'), (req, res) => {
  const date = req.query.date || time.todayLocal();
  const txnType = req.query.txnType || '正常出库';
  res.json({ doc_no: genOutboundDocNo(date, txnType) });
});

// 创建出库单据（草稿态）
router.post('/api/outbound-docs', requirePerm('outbound', 'create'), (req, res) => {
  const body = req.body;
  const date = body.date || time.todayLocal();
  const txnType = body.txn_type || '正常出库';
  const docNo = body.doc_no || genOutboundDocNo(date, txnType);
  // 2C：只有领用退库允许关联原出库单；其他类型忽略该字段
  const originDocNo = txnType === '退库出库' ? String(body.origin_doc_no || '').trim() : '';
  try {
    const exist = db.prepare("SELECT doc_no FROM outbound_docs WHERE doc_no=?").get(docNo);
    if (exist) return res.status(400).json({ error: '单据号已存在: ' + docNo });

    if (originDocNo) loadReturnableOrigin(originDocNo);

    // 先规整明细行（保留原行关联），再整体校验可退量
    const preparedLines = (Array.isArray(body.lines) ? body.lines : [])
      .filter(l => l && l.code)
      .map(l => ({
        code: l.code,
        qty: sign.normalizeQty(txnType, l.qty),
        origin_line_id: Number(l.origin_line_id) || 0,
        remarks: l.remarks || '',
      }));
    if (originDocNo && preparedLines.length) {
      validateReturnAgainstOrigin(preparedLines, originDocNo, docNo);
    }

    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO outbound_docs (doc_no, date, txn_type, destination, receiver, handler, status, remarks, created_by, origin_doc_no)
        VALUES (@doc_no, @date, @txn_type, @destination, @receiver, @handler, 'draft', @remarks, @created_by, @origin_doc_no)`)
        .run({
          doc_no: docNo, date, txn_type: txnType,
          destination: body.destination || '', receiver: body.receiver || '',
          handler: body.handler || '', remarks: body.remarks || '',
          created_by: req.user?.name || req.user?.username || '',
          origin_doc_no: originDocNo,
        });

      const stmt = db.prepare(`INSERT INTO outbound (date, gin_no, doc_no, code, qty, destination, receiver, handler, remarks, cost_price, txn_type, status, origin_line_id)
        VALUES (@date, @gin_no, @doc_no, @code, @qty, @destination, @receiver, @handler, @remarks, 0, @txn_type, 'draft', @origin_line_id)`);
      preparedLines.forEach(l => {
        stmt.run({
          date, gin_no: docNo, doc_no: docNo, code: l.code, qty: l.qty,
          destination: body.destination || '', receiver: body.receiver || '',
          handler: body.handler || '', remarks: l.remarks, txn_type: txnType,
          origin_line_id: l.origin_line_id,
        });
      });

      logOutboundDoc(docNo, 'create', req.user?.name || req.user?.username,
        originDocNo ? `创建退库单据，关联原出库单 ${originDocNo}` : '创建出库单据');
    });
    tx();
    res.json({ success: true, doc_no: docNo });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// 出库单据详情（含明细行 + 操作日志 + 冲销关联信息）
router.get('/api/outbound-docs/:docNo', requirePerm('outbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });

  const lines = db.prepare(`SELECT o.*, m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM outbound o LEFT JOIN materials m ON o.code = m.code
    WHERE o.doc_no=? ORDER BY o.id ASC`).all(docNo);

  const logs = db.prepare("SELECT * FROM outbound_doc_logs WHERE doc_no=? ORDER BY id ASC").all(docNo);

  // 冲销关联信息
  const reversals = [];
  if (doc.reversal_of) {
    reversals.push({ type: 'original', doc_no: doc.reversal_of });
  } else {
    const revDocs = db.prepare(`
      SELECT doc_no, status, date,
        (SELECT COUNT(*) FROM outbound o WHERE o.doc_no = d.doc_no) as line_count,
        (SELECT COALESCE(SUM(ABS(qty)),0) FROM outbound o WHERE o.doc_no = d.doc_no) as total_qty
      FROM outbound_docs d WHERE d.reversal_of=? ORDER BY d.created_at DESC
    `).all(docNo);
    revDocs.forEach(r => reversals.push({ type: 'reversal', ...r }));
  }

  // 汇总
  const summary = {
    line_count: lines.length,
    total_qty: lines.reduce((s, l) => s + Number(l.qty || 0), 0),
    total_amount: lines.reduce((s, l) => s + Number(l.cost_amount || 0), 0)
  };

  res.json({ ...doc, lines, logs, summary, reversals });
});

// 原出库单的可退明细（2C）：仅已过账/部分冲销的「正常出库」单可作为退库来源
// excludeDocNo: 当前正在编辑的退库单，避免把自己的占用算进已退量
router.get('/api/outbound-docs/:docNo/returnable', requirePerm('outbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  try {
    const lines = getReturnableLines(docNo, String(req.query.excludeDocNo || '').trim());
    const doc = db.prepare('SELECT status, destination, date FROM outbound_docs WHERE doc_no=?').get(docNo);
    res.json({ doc_no: docNo, status: doc.status, destination: doc.destination, date: doc.date, lines });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

// 保存出库单据明细行（草稿态可操作）—— 整体替换
router.put('/api/outbound-docs/:docNo/lines', requirePerm('outbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '已过账/作废的单据不能修改明细', code: 'DOC_NOT_DRAFT' });

  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  // 2C：退库单可维护原出库单关联（不传则沿用原值）
  const originDocNo = doc.txn_type === '退库出库'
    ? (req.body.origin_doc_no !== undefined ? String(req.body.origin_doc_no || '').trim() : (doc.origin_doc_no || ''))
    : '';

  // 先规整明细（原行关联 + 符号推导），再校验可退量；校验与写入基于同一批行
  try {
    const preparedLines = lines.filter(l => l && l.code).map(l => ({
      code: l.code,
      qty: sign.normalizeQty(doc.txn_type, l.qty),
      origin_line_id: Number(l.origin_line_id) || 0,
      remarks: l.remarks || ''
    }));
    if (originDocNo && preparedLines.length) {
      validateReturnAgainstOrigin(preparedLines, originDocNo, docNo);
    }
    const tx = db.transaction(() => {
      // 先删旧行
      db.prepare("DELETE FROM outbound WHERE doc_no=?").run(docNo);
      // 再插新行
      const stmt = db.prepare(`INSERT INTO outbound (date, gin_no, doc_no, code, qty, destination, receiver, handler, remarks, cost_price, txn_type, status, origin_line_id)
        VALUES (@date, @gin_no, @doc_no, @code, @qty, @destination, @receiver, @handler, @remarks, 0, @txn_type, 'draft', @origin_line_id)`);
      preparedLines.forEach(l => {
        stmt.run({
          date: doc.date, gin_no: docNo, doc_no: docNo,
          code: l.code, qty: l.qty,
          destination: doc.destination, receiver: doc.receiver, handler: doc.handler,
          remarks: l.remarks, txn_type: doc.txn_type, origin_line_id: l.origin_line_id
        });
      });
      // 更新单据头的部分字段（允许跟着明细一起改）
      const updateFields = {};
      if (req.body.destination !== undefined) updateFields.destination = req.body.destination;
      if (req.body.receiver !== undefined) updateFields.receiver = req.body.receiver;
      if (req.body.handler !== undefined) updateFields.handler = req.body.handler;
      if (req.body.remarks !== undefined) updateFields.remarks = req.body.remarks;
      if (req.body.date !== undefined) updateFields.date = req.body.date;
      if (doc.txn_type === '退库出库') updateFields.origin_doc_no = originDocNo;
      if (Object.keys(updateFields).length > 0) {
        const sets = Object.keys(updateFields).map(k => `${k}=@${k}`).join(', ');
        db.prepare(`UPDATE outbound_docs SET ${sets} WHERE doc_no=@doc_no`).run({ ...updateFields, doc_no: docNo });
      }
      logOutboundDoc(docNo, 'edit', req.user?.name || req.user?.username,
        `保存明细 ${preparedLines.length} 行${originDocNo ? `，关联原出库单 ${originDocNo}` : ''}`);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// 确认出库（过账）—— 草稿 → posted，明细行 status → posted，库存流水生效
router.post('/api/outbound-docs/:docNo/confirm', requirePerm('outbound', 'edit'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '只有草稿单据可以确认', code: 'DOC_NOT_DRAFT' });

  const lines = db.prepare("SELECT * FROM outbound WHERE doc_no=?").all(docNo);
  if (lines.length === 0) return res.status(400).json({ error: '单据没有明细行，无法确认' });

  const forceAllow = req.body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);

  // 2C：退库单必须再次校验可退量（期间可能有其他退库单占用原行），并回写原行成本
  const originDocNo = doc.txn_type === '退库出库' ? (doc.origin_doc_no || '') : '';
  if (originDocNo) {
    try {
      validateReturnAgainstOrigin(
        lines.map(l => ({ code: l.code, qty: sign.absQty(l.qty), origin_line_id: l.origin_line_id })),
        originDocNo, docNo);
    } catch (e) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
  }

  try {
    const tx = db.transaction(() => {
      // 库存校验（草稿行不计入库存，因此校验基于其他已过账流水）
      if (!forceAllow) {
        validateOutboundStock(lines);
      }
      // 过账：逐行计算成本单价后置为 posted
      // 领用退库关联原出库行的，成本一律取原行 cost_price，不再取当日加权平均
      const upd = db.prepare("UPDATE outbound SET status='posted', cost_price=@cost_price WHERE id=@id");
      lines.forEach(l => {
        let costPrice;
        if (originDocNo && l.origin_line_id) {
          const orig = db.prepare('SELECT cost_price FROM outbound WHERE id=?').get(Number(l.origin_line_id));
          costPrice = sign.storedAbs(orig && orig.cost_price);
        } else {
          costPrice = computeCostPrice(l.code, l.qty, l.date);
        }
        upd.run({ id: l.id, cost_price: costPrice });
      });
      // 单据头过账
      db.prepare("UPDATE outbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now') WHERE doc_no=?")
        .run(req.user?.name || req.user?.username || '', docNo);
      logOutboundDoc(docNo, 'confirm', req.user?.name || req.user?.username, `确认出库，${lines.length} 行已过账`);
    });
    tx();
    res.json({ success: true, line_count: lines.length, forced: forceAllow });
  } catch (e) {
    if (e.stockError) {
      return res.status(400).json({
        error: `库存不足：${e.details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
        code: 'INSUFFICIENT_STOCK',
        details: e.details
      });
    }
    res.status(400).json({ error: e.message });
  }
});

// 作废出库单据 —— 草稿 → cancelled（明细行一起删除，不产生库存影响）
router.post('/api/outbound-docs/:docNo/cancel', requirePerm('outbound', 'delete'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '只有草稿单据可以作废', code: 'DOC_NOT_DRAFT' });

  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM outbound WHERE doc_no=?").run(docNo);
      db.prepare("UPDATE outbound_docs SET status='cancelled', cancelled_by=?, cancelled_at=datetime('now') WHERE doc_no=?")
        .run(req.user?.name || req.user?.username || '', docNo);
      logOutboundDoc(docNo, 'cancel', req.user?.name || req.user?.username, '作废出库单据');
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 删除出库单据（草稿态可删除，连同明细行一起）
router.delete('/api/outbound-docs/:docNo', requirePerm('outbound', 'delete'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'draft') return res.status(400).json({ error: '已过账/作废的单据不能删除', code: 'DOC_NOT_DRAFT' });
  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM outbound WHERE doc_no=?").run(docNo);
      db.prepare("DELETE FROM outbound_docs WHERE doc_no=?").run(docNo);
      // 删除后该单据号可能被后续新建单据复用，必须一并清理操作日志，
      // 否则复用同一单号的新单据会显示已被删除单据的历史日志。
      db.prepare("DELETE FROM outbound_doc_logs WHERE doc_no=?").run(docNo);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== 出库冲销 ====================
// 设计要点：
//  1. 冲销单是一张独立的 outbound_docs，txn_type='出库冲销'，reversal_of 指向原单号
//  2. 冲销单明细行 qty 为负数（反向回补库存），reversal_of 指向原明细行 ID
//  3. 原单状态自动更新：posted → partially_reversed → reversed
//  4. 仅允许冲销正数出库行（数量为正的正常出库行）

// 获取原单某明细行的累计已冲销数量
function getOutboundReversedQty(lineId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(ABS(o.qty)),0) as v FROM outbound o
    JOIN outbound_docs d ON o.doc_no = d.doc_no
    WHERE o.reversal_of = ? AND d.status = 'posted'
  `).get(String(lineId));
  return r ? r.v : 0;
}

// 根据冲销单的过账结果，自动更新原单状态
function updateOriginalOutboundDocStatus(originalDocNo) {
  const origLines = db.prepare("SELECT id, qty FROM outbound WHERE doc_no=? AND status='posted'").all(originalDocNo);
  if (origLines.length === 0) return;

  const allReversed = origLines.every(l => getOutboundReversedQty(l.id) >= sign.absQty(l.qty));

  if (allReversed) {
    db.prepare("UPDATE outbound_docs SET status='reversed' WHERE doc_no=?").run(originalDocNo);
    logOutboundDoc(originalDocNo, 'reverse', 'system', '所有明细已全部冲销，单据状态更新为已全部冲销');
  } else {
    db.prepare("UPDATE outbound_docs SET status='partially_reversed' WHERE doc_no=?").run(originalDocNo);
    logOutboundDoc(originalDocNo, 'reverse', 'system', '部分明细已冲销，单据状态更新为部分冲销');
  }
}

// 获取原单明细的可冲销信息
router.get('/api/outbound-docs/:docNo/reversal-info', requirePerm('outbound', 'view'), (req, res) => {
  const docNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(docNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'posted' && doc.status !== 'partially_reversed')
    return res.status(400).json({ error: '只有已过账或部分冲销的单据可以冲销', code: 'DOC_NOT_REVERSIBLE' });

  // 正数出库行和退库出库负数行都可冲销，冲销方向由原行符号决定
  const lines = db.prepare(`
    SELECT o.id, o.code, o.qty, o.cost_price, o.remarks,
           m.name as material_name, m.spec as material_spec, m.unit as material_unit, m.brand as material_brand
    FROM outbound o LEFT JOIN materials m ON o.code = m.code
    WHERE o.doc_no=? AND o.status='posted'
    ORDER BY o.id ASC
  `).all(docNo);

  const lineInfos = lines.map(l => {
    const origQty = sign.absQty(l.qty);
    const reversedQty = getOutboundReversedQty(l.id);
    return {
      id: l.id,
      code: l.code,
      qty: origQty,
      cost_price: l.cost_price,
      reversed_qty: reversedQty,
      remaining: origQty - reversedQty,
      material_name: l.material_name,
      material_spec: l.material_spec,
      material_unit: l.material_unit,
      material_brand: l.material_brand,
      remarks: l.remarks
    };
  });

  const reversals = db.prepare(`
    SELECT d.doc_no, d.date, d.status, d.remarks, d.created_by, d.created_at, d.confirmed_by, d.confirmed_at,
      (SELECT COUNT(*) FROM outbound o WHERE o.doc_no = d.doc_no) as line_count,
      (SELECT COALESCE(SUM(ABS(qty)),0) FROM outbound o WHERE o.doc_no = d.doc_no) as total_qty
    FROM outbound_docs d WHERE d.reversal_of=? ORDER BY d.created_at DESC
  `).all(docNo);

  res.json({
    doc_no: docNo,
    status: doc.status,
    lines: lineInfos.filter(l => l.remaining > 0),
    all_lines: lineInfos,
    reversals: reversals
  });
});

// 创建冲销单（草稿态）
// body: { date, reason, lines: [{ line_id, qty }] } — qty 为正数（本次冲销量）
router.post('/api/outbound-docs/:docNo/reversal', requirePerm('outbound', 'edit'), (req, res) => {
  const originalDocNo = req.params.docNo;
  const doc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(originalDocNo);
  if (!doc) return res.status(404).json({ error: '出库单据不存在' });
  if (doc.status !== 'posted' && doc.status !== 'partially_reversed')
    return res.status(400).json({ error: '只有已过账或部分冲销的单据可以冲销', code: 'DOC_NOT_REVERSIBLE' });

  const body = req.body;
  const reqLines = Array.isArray(body.lines) ? body.lines : [];
  if (reqLines.length === 0)
    return res.status(400).json({ error: '请至少选择一行进行冲销', code: 'NO_LINES' });

  const date = body.date || time.todayLocal();
  const reason = body.reason || '';
  const revDocNo = genOutboundReversalDocNo(date);
  const operator = req.user?.name || req.user?.username || '';

  try {
    const tx = db.transaction(() => {
      // 创建冲销单头
      db.prepare(`INSERT INTO outbound_docs
        (doc_no, date, txn_type, destination, receiver, handler, status, remarks, created_by, reversal_of)
        VALUES (?, ?, '出库冲销', ?, ?, ?, 'draft', ?, ?, ?)`)
        .run(revDocNo, date,
          doc.destination || '', doc.receiver || '', doc.handler || '',
          reason || ('冲销原单 ' + originalDocNo), operator,
          originalDocNo);

      // 创建冲销明细行：符号由原行方向决定（正数原行 → 存负回补；退库出库负数原行 → 存正扣减）
      const stmt = db.prepare(`INSERT INTO outbound
        (date, gin_no, doc_no, code, qty, destination, receiver, handler, remarks, cost_price, txn_type, status, reversal_of)
        VALUES (@date, @gin_no, @doc_no, @code, @qty, @destination, @receiver, @handler, @remarks, @cost_price, '出库冲销', 'draft', @reversal_of)`);

      const lineDescs = [];
      reqLines.forEach(rl => {
        const lineId = parseInt(rl.line_id, 10);
        if (!lineId) throw new Error('冲销明细缺少原明细行 ID');

        const origLine = db.prepare("SELECT * FROM outbound WHERE id=?").get(lineId);
        if (!origLine || origLine.doc_no !== originalDocNo) throw new Error(`明细行 ${lineId} 不属于原单 ${originalDocNo}`);

        const storedQty = sign.normalizeQty('出库冲销', rl.qty, { originalQty: origLine.qty });
        const revQty = sign.absQty(storedQty);

        const alreadyReversed = getOutboundReversedQty(lineId);
        const origQty = sign.absQty(origLine.qty);
        if (alreadyReversed + revQty > origQty + 0.0001) {
          throw new Error(`物料 ${origLine.code}：累计冲销量 ${alreadyReversed + revQty} 超过原出库量 ${origQty}（本次最多可冲 ${origQty - alreadyReversed}）`);
        }

        stmt.run({
          date, gin_no: revDocNo, doc_no: revDocNo,
          code: origLine.code, qty: storedQty,
          destination: doc.destination || '', receiver: doc.receiver || '', handler: doc.handler || '',
          remarks: rl.remarks || ('冲销物料 ' + origLine.code),
          cost_price: sign.storedAbs(origLine.cost_price),
          reversal_of: String(lineId)
        });

        lineDescs.push(`${origLine.code} × ${revQty}`);
      });

      if (lineDescs.length === 0) throw new Error('没有有效的冲销明细行');

      logOutboundDoc(revDocNo, 'create', operator, `创建冲销单，关联原单 ${originalDocNo}；明细：${lineDescs.join('，')}`);
      logOutboundDoc(originalDocNo, 'reverse', operator, `创建冲销单 ${revDocNo}（草稿态，尚未回补库存）`);
    });
    tx();
    res.json({ success: true, doc_no: revDocNo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 确认冲销（冲销单草稿 → posted）
// 冲销行符号随原行方向：冲销正常出库 → 存负回补库存（不校验）；冲销退库出库 → 存正扣减库存（需校验）
router.post('/api/outbound-docs/:docNo/reversal-confirm', requirePerm('outbound', 'edit'), (req, res) => {
  const revDocNo = req.params.docNo;
  const revDoc = db.prepare("SELECT * FROM outbound_docs WHERE doc_no=?").get(revDocNo);
  if (!revDoc) return res.status(404).json({ error: '冲销单不存在' });
  if (revDoc.txn_type !== '出库冲销') return res.status(400).json({ error: '该单据不是冲销单', code: 'NOT_REVERSAL' });
  if (revDoc.status !== 'draft') return res.status(400).json({ error: '只有草稿态的冲销单可以确认', code: 'DOC_NOT_DRAFT' });

  const originalDocNo = revDoc.reversal_of;
  if (!originalDocNo) return res.status(400).json({ error: '冲销单缺少原单关联' });

  const lines = db.prepare("SELECT * FROM outbound WHERE doc_no=? AND reversal_of != ''").all(revDocNo);
  if (lines.length === 0) return res.status(400).json({ error: '冲销单没有明细行' });

  const forceAllow = req.body.force_allow === true && ['admin', 'manager'].includes(req.user?.role);
  const operator = req.user?.name || req.user?.username || '';

  // 只有正数量的冲销行（冲销退库出库）会占用库存，需要校验
  const demandMap = new Map();
  lines.forEach(l => {
    const qty = Number(l.qty);
    if (qty <= 0) return;
    demandMap.set(l.code, (demandMap.get(l.code) || 0) + sign.absQty(qty));
  });

  const stockErrors = [];
  demandMap.forEach((needQty, code) => {
    const available = getAvailableStock(code);
    if (needQty > available + 0.0001) {
      stockErrors.push({ code, requested: needQty, available });
    }
  });

  if (stockErrors.length > 0 && !forceAllow) {
    return res.status(400).json({
      error: `库存不足，无法冲销：${stockErrors.map(d => `${d.code} 需冲 ${d.requested}，可用 ${d.available}`).join('；')}`,
      code: 'INSUFFICIENT_STOCK',
      details: stockErrors
    });
  }

  try {
    const tx = db.transaction(() => {
      // 冲销行过账（保持成本单价不变，为回补/扣减库存的成本）
      const upd = db.prepare("UPDATE outbound SET status='posted', cost_price=@cost_price WHERE id=@id");
      lines.forEach(l => {
        const origLine = db.prepare("SELECT cost_price FROM outbound WHERE id=?").get(parseInt(l.reversal_of, 10));
        const costPrice = sign.storedAbs(origLine?.cost_price ?? l.cost_price);
        upd.run({ id: l.id, cost_price: costPrice });
      });
      // 冲销单头过账
      db.prepare("UPDATE outbound_docs SET status='posted', confirmed_by=?, confirmed_at=datetime('now') WHERE doc_no=?")
        .run(operator, revDocNo);

      logOutboundDoc(revDocNo, 'confirm', operator, `确认冲销，${lines.length} 行已过账`);
      logOutboundDoc(originalDocNo, 'reverse', operator, `冲销单 ${revDocNo} 已确认`);

      // 自动更新原单状态
      updateOriginalOutboundDocStatus(originalDocNo);
    });
    tx();
    res.json({ success: true, line_count: lines.length, forced: forceAllow });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


module.exports = router;
