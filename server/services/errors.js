/**
 * 写路径并发/业务错误的统一出口
 *
 * 背景：过账、更正、盘点等写操作统一使用 BEGIN IMMEDIATE 事务。
 * 并发实例同时写入时，SQLite 会抛 SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT；
 * 这类错误必须转成可读的中英文业务提示，不能把 "database is locked" 直接抛给用户。
 */

// 本次并发加固涉及的业务码英文文案
const ERROR_EN = {
  INSUFFICIENT_STOCK: 'Insufficient stock. The operation was rolled back and nothing was changed.',
  DOC_STATE_CHANGED: 'This document was already processed by another request. Nothing was changed; please refresh and try again.',
  STOCKTAKE_STATE_CHANGED: 'This stocktake was already confirmed by another request. Nothing was changed; please refresh and try again.',
  RETURN_QTY_EXCEEDED: 'The return quantity exceeds the remaining returnable quantity of the origin document.',
  RETURN_EXCEEDS_CORRECTED_QTY: 'Some confirmed returns exceed the corrected quantity. Update those return documents first.',
  DOC_NO_CONFLICT: 'The document number was just taken by another request. Nothing was saved; please retry.',
  OVER_RECEIPT: 'The received quantity exceeds the remaining purchase order quantity. Confirm over-receipt explicitly to proceed.',
  DB_BUSY: 'The system is busy handling another write. Nothing was changed; please retry in a moment.',
};

function isBusy(e) {
  const code = String((e && e.code) || '');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_BUSY_RECOVERY') return true;
  return /database (table )?is locked/i.test(String((e && e.message) || ''));
}

function busyBody() {
  return {
    code: 'DB_BUSY',
    error: '系统正被其他写操作占用（并发写入冲突），本次操作未生效，请稍后重试',
    error_en: ERROR_EN.DB_BUSY,
  };
}

// 构造带业务码的错误，供路由在事务内抛出
function businessError(code, message, details, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (details !== undefined) e.details = details;
  return e;
}

// 给响应体补英文文案（已有 error_en 时不覆盖）
function withEn(body) {
  if (body && body.code && !body.error_en && ERROR_EN[body.code]) {
    body.error_en = ERROR_EN[body.code];
  }
  return body;
}

// 库存不足（出库/退货/盘亏）统一响应体
function stockBody(e) {
  const details = Array.isArray(e && e.details) ? e.details : [];
  return withEn({
    code: 'INSUFFICIENT_STOCK',
    error: `库存不足：${details.map(d => `${d.code} 需 ${d.requested}，可用 ${d.available}`).join('；')}`,
    error_en: `Insufficient stock: ${details.map(d => `${d.code} needs ${d.requested}, available ${d.available}`).join('; ')}`,
    details,
  });
}

// 业务异常统一响应体
function bizBody(e, fallbackCode) {
  const body = { error: (e && e.message) || '操作失败', code: (e && e.code) || fallbackCode };
  if (e && e.details !== undefined) body.details = e.details;
  return withEn(body);
}

module.exports = {
  ERROR_EN,
  isBusy,
  busyBody,
  businessError,
  withEn,
  stockBody,
  bizBody,
};
