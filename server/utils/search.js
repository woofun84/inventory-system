// 通用搜索工具：空格分隔多关键字，多个词之间为 AND（每个词都需命中）
// 后端所有关键字筛选统一走这里；前端对应入口是 filterByKeywords，规则保持一致。
const text = v => (v == null ? '' : String(v));

// 按空白拆分关键字，忽略空词
function kwTokens(q) {
  return text(q).trim().split(/\s+/).filter(Boolean);
}

// 单个关键字的 LIKE 参数；escape=true 时把 % _ \ 按字面量转义
function likeTerm(term, escape) {
  const v = text(term);
  return escape ? '%' + v.replace(/[\\%_]/g, c => '\\' + c) + '%' : '%' + v + '%';
}

// 生成多关键字 AND 条件（每个关键字需在任一谓词命中）
// predicates 为含 ? 占位符的 SQL 布尔表达式模板，一个模板内可有多个占位符
// （例如 EXISTS 子查询里同时匹配多个字段），全部按同一关键字填充。
function kwClauseExpr(predicates, q, opts = {}) {
  const tokens = kwTokens(q);
  if (!tokens.length) return { sql: '', params: [] };
  const esc = !!opts.escape;
  const sql = tokens
    .map(() => '(' + predicates.join(' OR ') + ')')
    .join(' AND ');
  const params = [];
  tokens.forEach(tk => {
    const like = likeTerm(tk, esc);
    predicates.forEach(p => {
      const n = (p.match(/\?/g) || []).length;
      for (let i = 0; i < n; i++) params.push(like);
    });
  });
  return { sql, params };
}

// 常见情形：每个字段一个 LIKE 谓词。fields 传完整列名（可带表别名）
function kwClause(fields, q, opts = {}) {
  const esc = !!opts.escape;
  return kwClauseExpr(
    fields.map(f => `${f} LIKE ?${esc ? " ESCAPE '\\'" : ''}`),
    q,
    opts
  );
}

// 内存过滤（已加载的候选集合）：每个关键字需在 values 任一字段命中，不区分大小写
function matchKeywords(values, q) {
  const tokens = kwTokens(q).map(t => t.toLowerCase());
  if (!tokens.length) return true;
  const hay = values.map(v => text(v).toLowerCase());
  return tokens.every(t => hay.some(h => h.includes(t)));
}

module.exports = { kwTokens, likeTerm, kwClause, kwClauseExpr, matchKeywords };
