/**
 * 时间工具
 *
 * 约定（全局统一）：
 *  1. 数据库中的"时刻"类字段（*_at / last_login）一律存 UTC，不带时区标记，
 *     由写入端使用 datetime('now') 或本文件的 nowUtc() 生成；
 *     展示时由前端按"浏览器本地时区"换算，因此不同时区的人看到的是各自的本地时间。
 *  2. 业务日期（date / expected_date）是"日历日"，不涉及时区换算，按操作者所在本机日期取值。
 */
function pad(n) { return String(n).padStart(2, '0'); }

// 把 Date 转成本机日历日期 YYYY-MM-DD
function toLocalDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 服务器本机的日历日期 YYYY-MM-DD（用于业务日期默认值）
function todayLocal() {
  return toLocalDate(new Date());
}

// 当前 UTC 时刻字符串 YYYY-MM-DD HH:MM:SS（与 datetime('now') 同口径）
function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// 本机相对 UTC 的偏移分钟数（东八区 = 480，UTC 本机 = 0）
function localOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

module.exports = { toLocalDate, todayLocal, nowUtc, localOffsetMinutes, pad };
