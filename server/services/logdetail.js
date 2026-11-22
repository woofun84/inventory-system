/**
 * 日志详情结构化
 *
 * 写入方只给「文案 key + 参数」：
 *   { key: 'audit_detail_ib_confirm', params: { n: 3 } }
 * 数据库存结构化 JSON（detail_json），前端按当前语言渲染；
 * 旧记录 / 动态文本（错误信息、请求摘要）仍按纯文本原样写入 detail，读到时原样显示。
 *
 * 写入侧统一做值级脱敏：即便字段名不含 password/token，只要值里出现
 * 「password=xxx / Bearer xxx / token: xxx」这类模式也打码，避免自由文本泄密。
 */
const MAX_TEXT = 400;

// 敏感值模式：键=值 形式，或 Bearer 令牌
const SECRET_VALUE = /((?:pass(?:word)?|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;}'"]+)/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

function scrubText(s) {
  let out = String(s);
  out = out.replace(SECRET_VALUE, (_m, prefix) => prefix + '***');
  out = out.replace(BEARER, (_m, prefix) => prefix + '***');
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) + '…' : out;
}

function scrubValue(v, depth) {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return (depth < 4 ? v : []).map(x => scrubValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).slice(0, 100).forEach(k => { out[k] = scrubValue(v[k], depth + 1); });
    return out;
  }
  return v;
}

function packDetail(detail) {
  if (detail && typeof detail === 'object' && typeof detail.key === 'string' && detail.key) {
    const params = {};
    const src = detail.params || {};
    Object.keys(src).slice(0, 100).forEach(k => { params[k] = scrubValue(src[k], 0); });
    return { text: '', json: JSON.stringify({ key: detail.key, params }) };
  }
  return { text: detail == null ? '' : scrubText(detail), json: '' };
}

module.exports = { packDetail, scrubText };
