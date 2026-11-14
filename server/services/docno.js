/**
 * 单据编号生成（统一入口）
 *
 * 编号格式：{前缀}-{YYYYMMDD}-{序号}
 *  例：GRN-20261103-0001
 *
 * 设计要点：
 *  1. 前缀与序号位数保存在 params 表（key = 'doc_no_rules'），可在「参数设置」页修改，
 *     未配置时回落到下方默认值，因此历史库无需迁移即可运行。
 *  2. 默认前缀采用英文规范码：
 *     GRN 采购入库 / RET 采购退货 / RTS 零星退货 / GIN 正常出库 / GIT 领料退库 / ST 库存盘点
 *     注：库存调整（原 ADJ）已并入盘点，无独立单号。
 *  3. 序号取「同前缀同日期已有编号的最大号 +1」，不用 COUNT，
 *     删掉中间号后也不会与既有单号重复。
 */
const db = require('../db');

// 各单据类型的默认前缀
const DEFAULT_PREFIXES = {
  grn: 'GRN',
  ret: 'RET',
  rts: 'RTS',
  gin: 'GIN',
  git: 'GIT',
  st: 'ST',
  po: 'PO',
};

// 默认序号位数
const DEFAULT_PAD = 4;

// 每种单据类型的展示名与「查重用到的表 + 单号列」
const TYPES = {
  grn: { label: '采购入库', sources: [{ table: 'inbound_docs', col: 'doc_no' }] },
  ret: { label: '采购退货', sources: [{ table: 'inbound_docs', col: 'doc_no' }] },
  rts: { label: '零星退货', sources: [{ table: 'inbound_docs', col: 'doc_no' }] },
  gin: { label: '正常出库', sources: [{ table: 'outbound_docs', col: 'doc_no' }] },
  git: { label: '领料退库', sources: [{ table: 'outbound_docs', col: 'doc_no' }] },
  st: { label: '库存盘点', sources: [{ table: 'stocktakes', col: 'stocktake_no' }] },
  po: { label: '采购单', sources: [{ table: 'purchase_orders', col: 'po_no' }] },
};

const TYPE_KEYS = Object.keys(TYPES);

// 前缀合法字符：大写字母/数字，长度 1-8
const PREFIX_RE = /^[A-Z0-9]{1,8}$/;

// 读取当前生效的编号规则（默认值 + 用户配置合并）
function getRules() {
  let saved = {};
  try {
    const row = db.prepare("SELECT value FROM params WHERE key='doc_no_rules'").get();
    if (row && row.value) saved = JSON.parse(row.value) || {};
  } catch (e) { /* 配置损坏时回落到默认值 */ }

  const savedPrefixes = saved.prefixes || {};
  const prefixes = {};
  TYPE_KEYS.forEach(k => {
    const v = savedPrefixes[k];
    prefixes[k] = (typeof v === 'string' && v.trim()) ? v.trim().toUpperCase() : DEFAULT_PREFIXES[k];
  });

  const p = Number(saved.pad);
  const pad = (Number.isInteger(p) && p >= 1 && p <= 8) ? p : DEFAULT_PAD;

  return { prefixes, pad };
}

// 校验一组编号规则，返回错误信息（null 表示通过）
function validateRules(prefixes, pad) {
  if (!prefixes || typeof prefixes !== 'object') return '编号规则格式不正确';
  const normalized = {};
  for (const k of TYPE_KEYS) {
    const v = prefixes[k];
    if (typeof v !== 'string' || !PREFIX_RE.test(v.trim().toUpperCase())) {
      return `「${TYPES[k].label}」的前缀只能是大写字母或数字，长度 1-8`;
    }
    normalized[k] = v.trim().toUpperCase();
  }
  const used = new Set();
  for (const k of TYPE_KEYS) {
    if (used.has(normalized[k])) return `前缀「${normalized[k]}」被重复使用，请保证各单据前缀互不相同`;
    used.add(normalized[k]);
  }
  const p = Number(pad);
  if (!Number.isInteger(p) || p < 1 || p > 8) return '序号位数需为 1-8 的整数';
  return null;
}

// 保存编号规则（调用方需保证已通过权限校验）
function setRules(prefixes, pad) {
  const err = validateRules(prefixes, pad);
  if (err) { const e = new Error(err); e.invalid = true; throw e; }

  const normalized = {};
  TYPE_KEYS.forEach(k => { normalized[k] = String(prefixes[k]).trim().toUpperCase(); });
  const value = JSON.stringify({ prefixes: normalized, pad: Number(pad) });

  db.prepare(`INSERT INTO params (key, value) VALUES ('doc_no_rules', ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(value);
  return { prefixes: normalized, pad: Number(pad) };
}

// 生成单据号
// type: TYPES 的键（grn/ret/gin/git/st/po）
// date: 'YYYY-MM-DD' 或任何以其开头的字符串
function genDocNo(type, date) {
  const t = TYPES[type];
  if (!t) throw new Error('未知单据类型: ' + type);

  const { prefixes, pad } = getRules();
  const prefix = prefixes[type];
  const d = String(date || '').slice(0, 10).replace(/-/g, '');
  const like = `${prefix}-${d}-%`;

  let maxSeq = 0;
  t.sources.forEach(s => {
    const rows = db.prepare(`SELECT ${s.col} AS no FROM ${s.table} WHERE ${s.col} LIKE ?`).all(like);
    rows.forEach(r => {
      const n = parseInt(String(r.no || '').split('-').pop(), 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    });
  });

  return `${prefix}-${d}-${String(maxSeq + 1).padStart(pad, '0')}`;
}

// 拆分单号：{主单号, 修订号}；无 -R{n} 后缀时修订号为 0
function splitDocNo(value) {
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(.*)-R(\d+)$/);
  return m ? { base: m[1], rev: Number(m[2]) } : { base: s, rev: 0 };
}

// 更正单号：沿用原单的前缀与日期段，在末尾追加/递增 -R{n}
// 原单 GIN-20261110-0001 → -R1 → -R2 …，不占用正常流水号
function genRevisionDocNo(origDocNo) {
  const { base, rev } = splitDocNo(origDocNo);
  if (!base) throw new Error('原单号为空，无法生成更正单号');
  const candidate = `${base}-R${rev + 1}`;
  const clash = db.prepare(`SELECT doc_no FROM inbound_docs WHERE doc_no=?
    UNION ALL SELECT doc_no FROM outbound_docs WHERE doc_no=?`).get(candidate, candidate);
  if (clash) {
    const e = new Error('更正单号已存在: ' + candidate);
    e.code = 'DOC_NO_EXISTS';
    throw e;
  }
  return candidate;
}

// 单号比较：主单号相同时按修订号数字比较，保证 -R2 排在 -R10 之前
function compareDocNo(a, b) {
  const pa = splitDocNo(a);
  const pb = splitDocNo(b);
  const c = pa.base.localeCompare(pb.base);
  return c !== 0 ? c : pa.rev - pb.rev;
}

// 预览下一号：按「候选前缀 + 位数 + 指定日期」计算，不写库、不占用号段
// 供参数设置页在规则尚未保存时显示真实的下一号
function previewDocNo(type, date, prefix, pad) {
  const t = TYPES[type];
  if (!t) return '';
  const p = String(prefix || '').trim().toUpperCase();
  const d = String(date || '').slice(0, 10).replace(/-/g, '');
  if (!p || !d) return '';
  const like = `${p}-${d}-%`;

  let maxSeq = 0;
  t.sources.forEach(s => {
    const rows = db.prepare(`SELECT ${s.col} AS no FROM ${s.table} WHERE ${s.col} LIKE ?`).all(like);
    rows.forEach(r => {
      const n = parseInt(String(r.no || '').split('-').pop(), 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    });
  });

  const np = Number(pad);
  const width = (Number.isInteger(np) && np >= 1 && np <= 8) ? np : DEFAULT_PAD;
  return `${p}-${d}-${String(maxSeq + 1).padStart(width, '0')}`;
}

module.exports = {
  DEFAULT_PREFIXES,
  DEFAULT_PAD,
  TYPES,
  TYPE_KEYS,
  getRules,
  setRules,
  genDocNo,
  genRevisionDocNo,
  previewDocNo,
  compareDocNo,
};
