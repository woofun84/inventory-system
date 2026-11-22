/**
 * 审计日志哈希链（纯函数，不依赖 db，供建库迁移与写入侧共用）
 *
 * 每行 hash = sha256(prev_hash + 分隔符 + 关键字段规范化串)。
 * 字段顺序固定，任何字段被改写都会导致该行及其后所有行校验失败。
 * 历史库升级前写入的记录 hash 为空，校验时视为「链前遗留」，跳过不报错。
 */
const crypto = require('crypto');

const HASH_FIELDS = [
  'created_at', 'user_id', 'username', 'name', 'role', 'module', 'action', 'target',
  'method', 'path', 'ip', 'status', 'detail', 'detail_json', 'level', 'source',
];

function canonical(row) {
  return HASH_FIELDS.map(f => {
    const v = row && row[f];
    return v == null ? '' : String(v);
  }).join('\u001f');
}

function computeHash(row, prevHash) {
  return crypto.createHash('sha256')
    .update(String(prevHash || '') + '\u001e' + canonical(row), 'utf8')
    .digest('hex');
}

module.exports = { HASH_FIELDS, canonical, computeHash };
