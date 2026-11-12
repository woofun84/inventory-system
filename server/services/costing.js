/**
 * 统一库存成本核算服务（唯一入口）
 *
 * 规则依据《库存成本核算统一规则及开发要求》第 3 / 5 / 6 章：
 *  - 所有库存变化必须生成流水（stock_ledger），结存只能由流水推导（stock_balance 仅为快照）
 *  - 核算顺序：业务日期 → 过账时间 → 行 id（同物料内重排为 posting_sequence）
 *  - 采购入库/零星入库：按采购单价入账
 *  - 采购退货：按原采购入库成本冲减（行价即原入库价）
 *  - 正常出库：按出库时点的移动加权平均成本
 *  - 有原单领料退库：按原领料出库行的实际成本恢复库存价值
 *  - 无原单领料退库：按退库时点的移动加权平均成本
 *  - 库存调整（盘盈/盘亏）：按调整时点均价，均价不变
 *
 * 所有金额（分）、数量（1e6）、单价（1e8）在内部一律用 BigInt 定点计算；
 * 对数据库读写沿用普通数字，由 services/scaled-db.js 在出入口换算。
 *
 * 事实源边界：本服务只写 stock_ledger / stock_balance，不反向写业务单据的 cost_price。
 * 业务单据字段与流水的一致性在「更正重算」（第三段）统一处理。
 */

const db = require('../db');
const units = require('./units');

const { toQtyInt, toPriceInt, toAmountInt, fromQtyInt, fromPriceInt, fromAmountInt, qtyMulPriceToAmount, amountDivQtyToPrice } = units;

const RETURN_OUT = '领料退库';

// 成本依据：写入 stock_ledger.cost_basis，供台账/单据详情标识
const COST_BASIS = {
  CURRENT: 'CURRENT_AVG',      // 当前结存数量 > 0，取当前移动平均
  HISTORICAL: 'HISTORICAL_AVG', // 当前结存为 0，回退最近一次正库存的结存均价
  NONE: 'NO_BASIS',            // 从未有过正库存，成本 0，需显式确认
};

/** 无成本依据时的错误：过账须由管理员显式确认，不允许静默通过 */
function noBasisError(code, row) {
  const e = new Error(`物料 ${code} 从未有过正库存，本次按 0 成本入账需管理员确认`);
  e.code = 'NO_COST_BASIS';
  e.status = 400;
  e.details = [{
    code,
    doc_no: row.source_doc_id || '',
    business_type: row.business_type || '',
    source_type: row.source_type || '',
  }];
  return e;
}

/** 结存为 0 时的取价：最近一次正库存均价 → 从未有过则 0（带依据标记） */
function pickFallbackCost(balQty, avg, lastPositiveAvg) {
  if (balQty > 0n) return { cost: avg, basis: COST_BASIS.CURRENT };
  if (lastPositiveAvg !== null) return { cost: lastPositiveAvg, basis: COST_BASIS.HISTORICAL };
  return { cost: 0n, basis: COST_BASIS.NONE };
}

/** 重算改写历史流水单价时留痕（不新增表，写入 inventory_recalc_logs） */
const logCostChangeStmt = () => db.prepare(`INSERT INTO inventory_recalc_logs
  (task_id, kind, original_doc, new_doc, code, start_sequence, end_sequence,
   qty_before, amount_before, qty_after, amount_after, affected_rows, operator, status, message)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
function logCostChange(row, seq, oldCost, newCost, oldQty, oldAmount, newQty, newAmount, basis, triggerDoc) {
  const taskId = `cost-change:${row.code}:${seq}:${oldCost}->${newCost}`;
  if (db.prepare('SELECT 1 AS ok FROM inventory_recalc_logs WHERE task_id=? LIMIT 1').get(taskId)) return;
  logCostChangeStmt().run(
    taskId, 'cost-change', row.source_doc_id || '', triggerDoc || '', row.code, seq, seq,
    fromQtyInt(oldQty), fromAmountInt(oldAmount), fromQtyInt(newQty), fromAmountInt(newAmount), 1,
    '', 'ok',
    `成本依据 ${basis || '-'}：单价 ${fromPriceInt(oldCost)} → ${fromPriceInt(newCost)}`,
  );
}

function materialIdOf(code) {
  const m = db.prepare('SELECT id FROM materials WHERE code=?').get(code);
  return m ? Number(m.id) : 0;
}

/** 写一条流水：入参一律为「元 / 件」普通数字，由 scaled-db 在出入口换算成整数定点 */
function insertLedger(row) {
  const info = db.prepare(`INSERT INTO stock_ledger
    (material_id, code, source_type, source_doc_id, source_line_id, business_type,
     business_date, effective_date, posting_time, posting_sequence,
     qty_in, qty_out, amount_in, amount_out, unit_cost,
     balance_qty, balance_amount, balance_avg_cost, status, correction_of, return_source_line_id)
    VALUES
    (@material_id, @code, @source_type, @source_doc_id, @source_line_id, @business_type,
     @business_date, @effective_date, @posting_time, 0,
     @qty_in, @qty_out, @amount_in, @amount_out, @unit_cost,
     0, 0, 0, 'active', @correction_of, @return_source_line_id)`)
    .run({
      material_id: materialIdOf(row.code),
      code: row.code,
      source_type: row.sourceType,
      source_doc_id: row.sourceDocId || '',
      source_line_id: Number(row.sourceLineId || 0),
      business_type: row.businessType || '',
      business_date: row.businessDate,
      effective_date: row.businessDate,
      posting_time: row.postingTime || '',
      qty_in: Number(row.qtyIn || 0),
      qty_out: Number(row.qtyOut || 0),
      amount_in: Number(row.amountIn || 0),
      amount_out: Number(row.amountOut || 0),
      unit_cost: Number(row.unitCost || 0),
      correction_of: row.correctionOf || '',
      return_source_line_id: Number(row.returnSourceLineId || 0),
    });
  return Number(info.lastInsertRowid);
}

/**
 * 差异原因分类：按「触发清零的那笔流水」归类。
 * 差额本身由数量归零时的残留金额产生，但残留的成因不同，分开统计才看得懂。
 */
function varianceReason(row) {
  if (row.source_type === 'inbound') return row.business_type === '采购退货' ? 'purchase_return' : 'inbound';
  if (row.source_type === 'outbound') return row.business_type === RETURN_OUT ? 'return_in' : 'outbound';
  if (row.source_type === 'adjust') return 'adjust';
  if (row.source_type === 'opening') return 'opening';
  return 'other';
}

/**
 * 记录 / 更新一条成本差异。
 *
 * 口径：「未结转差异」永远等于该流水行当前核算出来的残值，减去这条流水历史上已结转的金额。
 *  - 平时（tail > 0、未结转）：写入一条 open 记录；
 *  - 已结转后又因补录/更正导致残值变化：只把「增量」写成新的一条 open 记录，
 *    已结转的历史快照不动，避免把旧账翻出来重记；
 *  - 残值回到 0：删掉未结转记录（已结转的快照保留）。
 *
 * 入参单位：tail 为分（BigInt，可负），avgPriceInt 为 1e8 定点单价，qtyInt 为 1e6 定点数量。
 */
function recordVariance(row, tail, avgPriceInt, qtyInt, reasonOverride) {
  const ledgerId = Number(row.id);
  // 该流水行已结转的金额合计（别名与金额列同名，scaled-db 会按分→元换算）
  const settled = db.prepare(`SELECT COALESCE(SUM(amount),0) AS amount FROM cost_variances
    WHERE ledger_id=? AND status='settled'`).get(ledgerId);
  const settledCents = toAmountInt(settled ? settled.amount : 0);
  const openAmount = tail - settledCents;
  const open = db.prepare("SELECT id FROM cost_variances WHERE ledger_id=? AND status='open'").get(ledgerId);

  if (openAmount === 0n) {
    if (open) db.prepare('DELETE FROM cost_variances WHERE id=?').run(open.id);
    return;
  }

  const payload = {
    ledger_id: ledgerId,
    code: row.code,
    source_type: row.source_type,
    source_doc_id: row.source_doc_id || '',
    source_line_id: Number(row.source_line_id) || 0,
    business_type: row.business_type || '',
    business_date: row.business_date || '',
    qty: fromQtyInt(qtyInt),
    unit_cost: fromPriceInt(toPriceInt(row.unit_cost)),
    avg_cost: fromPriceInt(avgPriceInt),
    amount: fromAmountInt(openAmount),
    reason: reasonOverride || varianceReason(row),
  };

  if (open) {
    db.prepare(`UPDATE cost_variances SET
      code=@code, source_type=@source_type, source_doc_id=@source_doc_id, source_line_id=@source_line_id,
      business_type=@business_type, business_date=@business_date, qty=@qty, unit_cost=@unit_cost,
      avg_cost=@avg_cost, amount=@amount, reason=@reason, updated_at=datetime('now')
      WHERE id=@id`).run({ ...payload, id: open.id });
  } else {
    db.prepare(`INSERT INTO cost_variances
      (ledger_id, code, source_type, source_doc_id, source_line_id, business_type, business_date,
       qty, unit_cost, avg_cost, amount, reason, status, created_at, updated_at)
      VALUES (@ledger_id, @code, @source_type, @source_doc_id, @source_line_id, @business_type, @business_date,
       @qty, @unit_cost, @avg_cost, @amount, @reason, 'open', datetime('now'), datetime('now'))`).run(payload);
  }
}

// 从指定序号起重排序号（只更新与目标序号不一致的行，之前的行不动）
function renumberFrom(code, fromSequence = 1) {
  const rows = db.prepare(`SELECT id, posting_sequence FROM stock_ledger
    WHERE code=? AND status='active'
    ORDER BY business_date, posting_time, id`).all(code);
  const upd = db.prepare('UPDATE stock_ledger SET posting_sequence=? WHERE id=?');
  const start = Math.max(1, Number(fromSequence) || 1);
  for (let i = start - 1; i < rows.length; i++) {
    const seq = i + 1;
    if (Number(rows[i].posting_sequence) !== seq) upd.run(seq, rows[i].id);
  }
}

/**
 * 从指定序号起重算某物料的全部有效流水，并刷新余额快照
 * opts.strictIds：本次过账新插入的流水 id；只有这些行落成 NO_BASIS 时才拦截
 * opts.acceptNoBasis：管理员已确认按 0 成本入账
 * opts.triggerDoc：触发本次重算的来源单据号（写变更留痕用）
 */
function recomputeFrom(code, fromSequence = 1, opts = {}) {
  const rows = db.prepare(`SELECT * FROM stock_ledger
    WHERE code=? AND status='active' ORDER BY posting_sequence, id`).all(code);

  let balQty = 0n;
  let balAmount = 0n;
  let lastSeq = 0;
  let affected = 0;
  // 最近一次结存数量 > 0 时的结存均价：结存归零后回退取价用
  let lastPositiveAvg = null;
  const strictIds = opts.strictIds || null;
  const acceptNoBasis = opts.acceptNoBasis === true;
  const triggerDoc = opts.triggerDoc || '';

  const upd = db.prepare(`UPDATE stock_ledger SET
    amount_in=@amount_in, amount_out=@amount_out, unit_cost=@unit_cost,
    balance_qty=@balance_qty, balance_amount=@balance_amount, balance_avg_cost=@balance_avg_cost,
    cost_basis=@cost_basis
    WHERE id=@id`);

  // 业务表成本单价随流水同步（流水是唯一事实源，单据展示直接读回写后的值）
  const updLineCost = db.prepare('UPDATE outbound SET cost_price=? WHERE id=?');

  // 原出库行 id → 本次重算后的实际计价单价（供有原单退库恢复价值时引用）
  const outboundCostByLine = new Map();
  // 本次重算中已记录尾差的流水序号（避免同一笔重复写日志）
  const tailLogged = new Set();
  // 当前物料所有差异（含已结转）对应的流水行，用于在重算后撤销/冲回已不成立的差异
  const varianceLedgerIds = new Set(
    db.prepare("SELECT DISTINCT ledger_id FROM cost_variances WHERE code=?").all(code)
      .map(x => Number(x.ledger_id))
  );

  const start = Math.max(1, Number(fromSequence) || 1);
  for (const r of rows) {
    const seq = Number(r.posting_sequence);
    lastSeq = seq;
    if (seq < start) {
      balQty = toQtyInt(r.balance_qty);
      balAmount = toAmountInt(r.balance_amount);
      // 起点之前的历史：记住最近一次正库存均价，供结存归零后回退取价
      if (balQty > 0n) lastPositiveAvg = toPriceInt(r.balance_avg_cost);
      continue;
    }

    const prevQtyBefore = balQty;
    const prevAmountBefore = balAmount;
    const qIn = toQtyInt(r.qty_in);
    const qOut = toQtyInt(r.qty_out);
    const avg = balQty > 0n ? amountDivQtyToPrice(balAmount, balQty) : 0n;
    let amountIn = toAmountInt(r.amount_in);
    let amountOut = toAmountInt(r.amount_out);
    let unitCost = toPriceInt(r.unit_cost);
    let costBasis = String(r.cost_basis || '');

    // 新插入的流水在本次过账里才拦截 NO_BASIS；历史行重放不阻断其它单据
    const isNewRow = !!(strictIds && strictIds.has(Number(r.id)));

    if (r.source_type === 'outbound') {
      if (r.business_type === RETURN_OUT) {
        const srcLineId = Number(r.return_source_line_id);
        let cost = avg;
        if (srcLineId > 0) {
          if (outboundCostByLine.has(srcLineId)) {
            // 原出库行在本次重算范围内且已算过：直接用重算后的实际计价单价
            cost = outboundCostByLine.get(srcLineId);
          } else {
            // 原出库行在重算起点之前（或排序异常）：读它已定稿的流水单价
            const origLedger = db.prepare(`SELECT unit_cost FROM stock_ledger
              WHERE source_type='outbound' AND source_line_id=? AND status='active'
              ORDER BY posting_sequence DESC LIMIT 1`).get(srcLineId);
            if (origLedger) {
              cost = toPriceInt(origLedger.unit_cost);
            } else {
              const orig = db.prepare('SELECT cost_price FROM outbound WHERE id=?').get(srcLineId);
              if (orig) cost = toPriceInt(orig.cost_price);
            }
          }
          // 有原单：沿用原领料成本，不打结存回退标记
          unitCost = cost;
          costBasis = '';
        } else {
          // 无原单：结存 >0 取当前均价；结存为 0 回退最近一次正库存均价；从未有过则需确认
          const pick = pickFallbackCost(balQty, avg, lastPositiveAvg);
          unitCost = pick.cost;
          costBasis = pick.basis;
          if (pick.basis === COST_BASIS.NONE && isNewRow && !acceptNoBasis) {
            throw noBasisError(code, r);
          }
        }
        amountIn = qtyMulPriceToAmount(qIn, unitCost);
        amountOut = 0n;
      } else {
        unitCost = avg;
        amountOut = qtyMulPriceToAmount(qOut, avg);
        amountIn = 0n;
        costBasis = '';
        if (Number(r.source_line_id) > 0) outboundCostByLine.set(Number(r.source_line_id), unitCost);
      }
    } else if (r.source_type === 'adjust') {
      // 方向已在写流水时拆分到 qty_in / qty_out
      if (qIn > 0n) {
        // 盘盈：结存为 0 时与无原单退库同一套回退规则
        const pick = pickFallbackCost(balQty, avg, lastPositiveAvg);
        unitCost = pick.cost;
        costBasis = pick.basis;
        if (pick.basis === COST_BASIS.NONE && isNewRow && !acceptNoBasis) {
          throw noBasisError(code, r);
        }
      } else {
        // 盘亏：按当前均价冲减
        unitCost = avg;
        costBasis = COST_BASIS.CURRENT;
      }
      amountIn = qtyMulPriceToAmount(qIn, unitCost);
      amountOut = qtyMulPriceToAmount(qOut, unitCost);
    } else {
      // 入库类：按行价固定入账（采购退货 qty_out 同样按原采购价冲减）
      amountIn = qtyMulPriceToAmount(qIn, unitCost);
      amountOut = qtyMulPriceToAmount(qOut, unitCost);
      costBasis = '';
    }

    const prevQty = balQty;
    balQty += qIn - qOut;
    balAmount += amountIn - amountOut;

    // 负库存硬拦：任一有效流水核算后为负，整笔业务（含更正重算）回滚
    if (balQty < 0n) {
      const e = new Error(`物料 ${code} 在 ${r.business_date} 核算后库存为负（${fromQtyInt(balQty)}），已阻止过账`);
      e.code = 'INSUFFICIENT_STOCK';
      e.status = 400;
      e.stockError = true;
      e.details = [{ code, requested: fromQtyInt(qOut), available: fromQtyInt(prevQty) }];
      throw e;
    }

    // 尾差：数量归零时金额必须归零。差额并入本笔金额并留痕，不篡改历史单价。
    if (balQty === 0n && balAmount !== 0n) {
      const tail = balAmount;
      // 差异台账：先记下这笔残值（来源、数量、原单价、当时均价），再抹平账面
      recordVariance(r, tail, avg, qIn > 0n ? qIn : qOut);
      if (qOut > 0n) amountOut += tail;
      else amountIn += tail;
      balAmount = 0n;
      if (!tailLogged.has(seq)) {
        const tk = `tail:${code}:${seq}`;
        const exists = db.prepare('SELECT 1 AS ok FROM inventory_recalc_logs WHERE task_id=? LIMIT 1').get(tk);
        if (!exists) {
          db.prepare(`INSERT INTO inventory_recalc_logs
            (task_id, kind, code, start_sequence, end_sequence, amount_after, message)
            VALUES (?,?,?,?,?,?,?)`).run(tk, 'tail-diff', code, seq, seq, fromAmountInt(tail), '库存数量归零，尾差并入本笔金额');
        }
        tailLogged.add(seq);
      }
    } else if (varianceLedgerIds.has(Number(r.id))) {
      // 重算后这笔不再把数量清零（如补录/更正）：撤销原差异；
      // 若该笔历史上已结转，则自动生成一条负数差异把已结转金额冲回。
      recordVariance(r, 0n, avg, qIn > 0n ? qIn : qOut, 'recalc');
    }

    // 出库/退库行的业务表成本单价回写为流水实际计价单价
    if (r.source_type === 'outbound' && Number(r.source_line_id) > 0) {
      updLineCost.run(fromPriceInt(unitCost), Number(r.source_line_id));
    }

    const balAvg = balQty > 0n ? amountDivQtyToPrice(balAmount, balQty) : 0n;

    // 变更留痕：重算改写了历史流水单价时记一条，便于追溯（新插入的行不算改写）
    const oldUnitCost = toPriceInt(r.unit_cost);
    if (!isNewRow && oldUnitCost !== unitCost) {
      logCostChange(r, seq, oldUnitCost, unitCost, prevQtyBefore, prevAmountBefore, balQty, balAmount, costBasis, triggerDoc);
    }

    upd.run({
      id: r.id,
      amount_in: fromAmountInt(amountIn),
      amount_out: fromAmountInt(amountOut),
      unit_cost: fromPriceInt(unitCost),
      balance_qty: fromQtyInt(balQty),
      balance_amount: fromAmountInt(balAmount),
      balance_avg_cost: fromPriceInt(balAvg),
      cost_basis: costBasis,
    });
    // 供后续行回退取价：最近一次结存数量 > 0 时的均价
    if (balQty > 0n) lastPositiveAvg = balAvg;
    affected++;
  }

  // 作废的流水不再产生残值：撤销其未结转差异；已结转的生成负数差异冲回
  for (const ledgerId of varianceLedgerIds) {
    const lr = db.prepare('SELECT * FROM stock_ledger WHERE id=?').get(ledgerId);
    if (!lr) {
      db.prepare("DELETE FROM cost_variances WHERE ledger_id=? AND status='open'").run(ledgerId);
    } else if (lr.status !== 'active') {
      const q = toQtyInt(lr.qty_in) > 0n ? toQtyInt(lr.qty_in) : toQtyInt(lr.qty_out);
      recordVariance(lr, 0n, 0n, q, 'recalc');
    }
  }

  db.prepare(`INSERT INTO stock_balance (code, material_id, stock_qty, stock_amount, avg_cost, last_posting_sequence, updated_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      stock_qty=excluded.stock_qty, stock_amount=excluded.stock_amount,
      avg_cost=excluded.avg_cost, last_posting_sequence=excluded.last_posting_sequence,
      updated_at=datetime('now')`)
    .run(code, materialIdOf(code), fromQtyInt(balQty), fromAmountInt(balAmount),
      fromPriceInt(balQty > 0n ? amountDivQtyToPrice(balAmount, balQty) : 0n), lastSeq);

  return {
    code, affected,
    qty: fromQtyInt(balQty),
    amount: fromAmountInt(balAmount),
    avg: fromPriceInt(balQty > 0n ? amountDivQtyToPrice(balAmount, balQty) : 0n),
    lastSequence: lastSeq,
  };
}

/**
 * 新插入流水后归位：按「业务日期 → 过账时间 → 流水 id」找到插入位置，
 * 只从该位置起重排序号与重算，之前的流水不动。
 * 注：同一秒过账的单据按流水 id（即过账先后）排序，不能用业务明细行 id ——
 * 入库行与出库行各自独立自增，跨表比大小会把出库排到入库前面。
 */
function settle(code, ledgerIds, opts = {}) {
  const ids = new Set(ledgerIds);
  const rows = db.prepare(`SELECT id FROM stock_ledger
    WHERE code=? AND status='active'
    ORDER BY business_date, posting_time, id`).all(code);
  let idx = rows.findIndex(r => ids.has(Number(r.id)));
  if (idx < 0) idx = 0;
  const startSeq = idx + 1;
  renumberFrom(code, startSeq);
  return recomputeFrom(code, startSeq, { ...opts, strictIds: ids });
}

// ==================== 各业务类型过账 ====================

/**
 * 入库单（采购入库 / 零星入库 / 采购退货），须在调用方事务内执行。
 * anchor：更正单传入原单的核算位置（businessDate/postingTime）与关联原单号，
 *         使替代业务在原单的核算位置生效，而不是排到当天末尾。
 */
function postInboundDoc(doc, lines, anchor = null) {
  const byCode = new Map();
  for (const l of lines) {
    const qtyInt = toQtyInt(l.qty);
    const priceInt = toPriceInt(l.price);
    const absQty = qtyInt < 0n ? -qtyInt : qtyInt;
    const amount = qtyMulPriceToAmount(absQty, priceInt);
    const id = insertLedger({
      code: l.code,
      sourceType: 'inbound',
      sourceDocId: doc.doc_no,
      sourceLineId: l.id,
      businessType: doc.txn_type,
      businessDate: anchor && anchor.businessDate ? anchor.businessDate : l.date,
      postingTime: anchor && anchor.postingTime ? anchor.postingTime : (l.created_at || doc.created_at || ''),
      qtyIn: qtyInt > 0n ? fromQtyInt(absQty) : 0,
      qtyOut: qtyInt < 0n ? fromQtyInt(absQty) : 0,
      amountIn: qtyInt > 0n ? fromAmountInt(amount) : 0,
      amountOut: qtyInt < 0n ? fromAmountInt(amount) : 0,
      unitCost: fromPriceInt(priceInt),
      correctionOf: (anchor && anchor.correctionOf) || '',
    });
    if (!byCode.has(l.code)) byCode.set(l.code, []);
    byCode.get(l.code).push(id);
  }
  const result = [];
  for (const [code, ids] of byCode) result.push(settle(code, ids));
  return result;
}

/** 出库单（正常出库 / 领料退库），须在调用方事务内执行；成本由重算确定 */
function postOutboundDoc(doc, lines, anchor = null, opts = {}) {
  const byCode = new Map();
  for (const l of lines) {
    const qtyInt = toQtyInt(l.qty);
    const absQty = qtyInt < 0n ? -qtyInt : qtyInt;
    const isReturn = doc.txn_type === RETURN_OUT;
    const id = insertLedger({
      code: l.code,
      sourceType: 'outbound',
      sourceDocId: doc.doc_no,
      sourceLineId: l.id,
      businessType: doc.txn_type,
      businessDate: anchor && anchor.businessDate ? anchor.businessDate : l.date,
      postingTime: anchor && anchor.postingTime ? anchor.postingTime : (l.created_at || doc.created_at || ''),
      qtyIn: isReturn ? fromQtyInt(absQty) : 0,
      qtyOut: isReturn ? 0 : fromQtyInt(absQty),
      amountIn: 0,
      amountOut: 0,
      unitCost: 0,
      returnSourceLineId: isReturn ? Number(l.origin_line_id || 0) : 0,
      correctionOf: (anchor && anchor.correctionOf) || '',
    });
    if (!byCode.has(l.code)) byCode.set(l.code, []);
    byCode.get(l.code).push(id);
  }
  const result = [];
  for (const [code, ids] of byCode) {
    result.push(settle(code, ids, { ...opts, triggerDoc: opts.triggerDoc || doc.doc_no }));
  }
  return result;
}

/** 库存调整（盘点盘盈/盘亏、手工调整）：本服务负责写调整单行 + 流水，调用方只传业务字段 */
function postAdjustment(adj, opts = {}) {
  const info = db.prepare(`INSERT INTO stock_adjustments
    (date, code, qty, adj_type, reason, remarks, handler, stocktake_no, created_by)
    VALUES (@date, @code, @qty, @adj_type, @reason, @remarks, @handler, @stocktake_no, @created_by)`)
    .run({
      date: adj.date,
      code: adj.code,
      qty: adj.qty,
      adj_type: adj.adj_type || '其它',
      reason: adj.reason || '',
      remarks: adj.remarks || '',
      handler: adj.handler || '',
      stocktake_no: adj.stocktake_no || '',
      created_by: adj.created_by || '',
    });
  const adjId = Number(info.lastInsertRowid);
  const saved = db.prepare('SELECT created_at FROM stock_adjustments WHERE id=?').get(adjId);
  const qtyInt = toQtyInt(adj.qty);
  const absQty = qtyInt < 0n ? -qtyInt : qtyInt;
  const id = insertLedger({
    code: adj.code,
    sourceType: 'adjust',
    sourceDocId: adj.stocktake_no || '',
    sourceLineId: adjId,
    businessType: adj.adj_type || '其它',
    businessDate: adj.date,
    postingTime: (saved && saved.created_at) || new Date().toISOString().slice(0, 19).replace('T', ' '),
    qtyIn: qtyInt > 0n ? fromQtyInt(absQty) : 0,
    qtyOut: qtyInt < 0n ? fromQtyInt(absQty) : 0,
    amountIn: 0,
    amountOut: 0,
    unitCost: 0,
  });
  return { adjustmentId: adjId, result: settle(adj.code, [id], { ...opts, triggerDoc: opts.triggerDoc || adj.stocktake_no || '' }) };
}

/**
 * 单据作废：原流水置无效，并从原位置起重算后续流水。
 * 返回原单的核算位置 anchor，供更正新单在原位生效使用。
 * opts.recompute === false 时只作废不重算（更正重开场景：等新单落位后一次性重算）。
 */
function voidDocLedger(sourceType, docNo, opts = {}) {
  const rows = db.prepare(`SELECT code, MIN(posting_sequence) AS seq FROM stock_ledger
    WHERE source_type=? AND source_doc_id=? AND status='active' GROUP BY code`).all(sourceType, docNo);
  const head = db.prepare(`SELECT business_date, posting_time FROM stock_ledger
    WHERE source_type=? AND source_doc_id=? AND status='active'
    ORDER BY posting_sequence LIMIT 1`).get(sourceType, docNo);
  if (rows.length === 0) return { codes: [], anchor: null, result: [] };
  const anchor = head ? { businessDate: head.business_date, postingTime: head.posting_time } : null;
  db.prepare(`UPDATE stock_ledger SET status='voided'
    WHERE source_type=? AND source_doc_id=? AND status='active'`).run(sourceType, docNo);
  const result = [];
  if (opts.recompute !== false) {
    for (const r of rows) {
      const startSeq = Math.max(1, Number(r.seq) || 1);
      renumberFrom(r.code, startSeq);
      result.push(recomputeFrom(r.code, startSeq));
    }
  }
  return { codes: rows.map(r => r.code), anchor, result };
}

/** 全库重建（初始化/校正用，显式调用） */
function rebuildAll() {
  const codes = db.prepare("SELECT DISTINCT code FROM stock_ledger WHERE status='active'").all().map(r => r.code);
  const tx = db.transaction(() => {
    for (const code of codes) {
      renumberFrom(code, 1);
      recomputeFrom(code, 1);
    }
    const stale = db.prepare('SELECT code FROM stock_balance').all().map(r => r.code)
      .filter(c => !codes.includes(c));
    for (const c of stale) db.prepare('DELETE FROM stock_balance WHERE code=?').run(c);
  });
  tx();
  return codes.length;
}

/**
 * 是否已经发生过期初以外的库存业务（含已作废单据）。
 * 期初业务日期固定 1970-01-01，必须排在回放最前面；一旦后续已有流水，
 * 再改期初会倒挂历史成本，因此据此锁定物料档案的期初数量/单价。
 */
function hasNonOpeningLedger(code) {
  return !!db.prepare("SELECT 1 AS ok FROM stock_ledger WHERE code=? AND source_type<>'opening' LIMIT 1").get(code);
}

/**
 * 物料保存时同步期初流水（须在调用方事务内执行）。
 *  - qty=0：删除该物料的期初流水，不保留 0 数量脏记录，并重算余额；
 *  - 已有期初流水：原位改数量/单价，再从序 1 重算，金额与均价随之一致；
 *  - 没有期初流水：按 1970-01-01 插入，settle() 保证排在回放最前面。
 * 同一物料只允许一条期初流水，重复调用是幂等的。
 */
function syncOpeningLedger(code, qty, price) {
  const q = Number(qty) || 0;
  const p = Number(price) || 0;
  const opening = db.prepare(`SELECT id FROM stock_ledger
    WHERE code=? AND source_type='opening' AND status='active' ORDER BY id LIMIT 1`).get(code);

  if (q === 0) {
    if (!opening) return { action: 'none' };
    db.prepare("DELETE FROM stock_ledger WHERE code=? AND source_type='opening'").run(code);
    renumberFrom(code, 1);
    recomputeFrom(code, 1);
    return { action: 'deleted' };
  }

  if (opening) {
    db.prepare(`UPDATE stock_ledger SET qty_in=@qty_in, qty_out=@qty_out, unit_cost=@unit_cost
      WHERE id=@id`).run({
      qty_in: q > 0 ? q : 0,
      qty_out: q < 0 ? -q : 0,
      unit_cost: p,
      id: opening.id,
    });
    // 期初固定 1970-01-01，重排后必然仍是 1 号；重算负责刷新金额、均价与余额
    renumberFrom(code, 1);
    recomputeFrom(code, 1);
    return { action: 'updated' };
  }

  const id = insertLedger({
    code,
    sourceType: 'opening',
    businessType: '期初结存',
    businessDate: '1970-01-01',
    postingTime: '1970-01-01 00:00:00',
    qtyIn: q > 0 ? q : 0,
    qtyOut: q < 0 ? -q : 0,
    unitCost: p,
  });
  settle(code, [id]);
  return { action: 'created' };
}

/**
 * 期初结存流水：为有期初数量的物料补一条最早的有效流水，
 * 保证「库存余额 = 全部有效流水累计」在期初不为零时依然成立。
 * 仅作历史数据兜底：已有期初流水的物料直接跳过，重复执行不会重复插入。
 */
function ensureOpeningBalances() {
  const mats = db.prepare('SELECT code, opening_qty, opening_price FROM materials WHERE COALESCE(opening_qty,0) <> 0').all();
  let created = 0;
  for (const m of mats) {
    const exists = db.prepare("SELECT 1 AS ok FROM stock_ledger WHERE code=? AND source_type='opening' LIMIT 1").get(m.code);
    if (exists) continue;
    const qty = Number(m.opening_qty) || 0;
    const id = insertLedger({
      code: m.code,
      sourceType: 'opening',
      businessType: '期初结存',
      businessDate: '1970-01-01',
      postingTime: '1970-01-01 00:00:00',
      qtyIn: qty > 0 ? qty : 0,
      qtyOut: qty < 0 ? -qty : 0,
      unitCost: m.opening_price || 0,
    });
    settle(m.code, [id]);
    created++;
  }
  return created;
}

/** 更正前余额快照（用于重算日志的前后对照） */
function captureBalances() {
  return db.prepare('SELECT code, stock_qty AS qty, stock_amount AS amount FROM stock_balance').all();
}

/** 记录更正重算日志（第 6.4 章）：成功/失败均留痕 */
function logCorrection({ kind, originalDoc, newDoc = '', operator = '', before = [], status = 'ok', message = '' }) {
  const codes = db.prepare(`SELECT code, MIN(posting_sequence) AS s, MAX(posting_sequence) AS e
    FROM stock_ledger WHERE source_doc_id IN (?, ?) GROUP BY code`).all(originalDoc, newDoc || '');
  if (codes.length === 0) return 0;
  const beforeMap = new Map((before || []).map(b => [b.code, b]));
  const ins = db.prepare(`INSERT INTO inventory_recalc_logs
    (task_id, kind, original_doc, new_doc, code, start_sequence, end_sequence,
     qty_before, amount_before, qty_after, amount_after, affected_rows, operator, status, message)
    VALUES (@task_id, @kind, @original_doc, @new_doc, @code, @start_sequence, @end_sequence,
     @qty_before, @amount_before, @qty_after, @amount_after, @affected_rows, @operator, @status, @message)`);
  const taskId = `${originalDoc}->${newDoc || 'void'}`;
  let n = 0;
  for (const c of codes) {
    const bal = db.prepare('SELECT stock_qty AS qty, stock_amount AS amount FROM stock_balance WHERE code=?').get(c.code)
      || { qty: 0, amount: 0 };
    const b = beforeMap.get(c.code) || { qty: 0, amount: 0 };
    const maxSeq = db.prepare("SELECT COALESCE(MAX(posting_sequence),0) AS m FROM stock_ledger WHERE code=? AND status='active'").get(c.code).m;
    const affected = db.prepare("SELECT COUNT(*) AS c FROM stock_ledger WHERE code=? AND status='active' AND posting_sequence>=?").get(c.code, c.s).c;
    ins.run({
      task_id: taskId, kind, original_doc: originalDoc, new_doc: newDoc || '', code: c.code,
      start_sequence: c.s, end_sequence: maxSeq || c.e,
      qty_before: b.qty, amount_before: b.amount, qty_after: bal.qty, amount_after: bal.amount,
      affected_rows: affected, operator, status, message,
    });
    n++;
  }
  return n;
}

module.exports = {
  COST_BASIS,
  insertLedger, renumberFrom, recomputeFrom, settle,
  postInboundDoc, postOutboundDoc, postAdjustment, voidDocLedger,
  rebuildAll, ensureOpeningBalances, syncOpeningLedger, hasNonOpeningLedger,
  captureBalances, logCorrection,
};
