/**
 * 日志详情结构化
 *
 * 写入方只给「文案 key + 参数」：
 *   { key: 'audit_detail_ib_confirm', params: { n: 3 } }
 * 数据库存结构化 JSON（detail_json），前端按当前语言渲染；
 * 旧记录 / 动态文本（错误信息、请求摘要）仍按纯文本原样写入 detail，读到时原样显示。
 */
function packDetail(detail) {
  if (detail && typeof detail === 'object' && typeof detail.key === 'string' && detail.key) {
    return { text: '', json: JSON.stringify({ key: detail.key, params: detail.params || {} }) };
  }
  return { text: detail == null ? '' : String(detail), json: '' };
}

module.exports = { packDetail };
