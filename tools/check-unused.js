#!/usr/bin/env node
/**
 * 提交前死代码自检（低误报优先）
 *
 * 检查项：
 *   1) i18n：中英 key 是否成对、是否存在零引用 key —— 失败时阻断
 *   2) server 导出：module.exports 的导出名是否全项目零引用 —— 失败时阻断
 *   3) JS/HTML 生成的 class 与 CSS 选择器差异 —— 只输出报告，不阻断
 *
 * 设计取向：宁可漏报，不可误报。项目存在大量动态分发（t(variable)、内联 onclick、
 * data-* 事件委托、this[method]()、querySelector 钩子），因此引用判定一律保守：
 *   - i18n 只要 key 名作为子串出现在字典之外的源码/HTML 中就算被引用；
 *   - 后端导出只要导出名在导出声明之外的任何地方词匹配出现就算被引用；
 *   - CSS 差异仅供人工确认，不参与退出码。
 * 动态用法请登记到 tools/check-unused-allowlist.json，不要靠关闭检查解决。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOW_PATH = path.join(__dirname, 'check-unused-allowlist.json');
const allow = fs.existsSync(ALLOW_PATH)
  ? JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf8'))
  : {};
for (const k of ['i18nPrefixes', 'i18nKeys', 'exportNames', 'cssPrefixes', 'cssClasses']) {
  if (!Array.isArray(allow[k])) allow[k] = [];
}

const verbose = process.argv.includes('--verbose');
const problems = [];

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}
function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 去掉 JS 注释中的示例 class="..."，避免被当成真实类名。
// 采用「整行 // + 块注释」的保守处理：不碰模板字符串内部，避免嵌套 ${} 造成状态错位。
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

const jsFiles = [
  ...walk(path.join(ROOT, 'public/js'), '.js'),
  ...walk(path.join(ROOT, 'server'), '.js'),
  path.join(ROOT, 'server.js'),
  path.join(ROOT, 'init-db.js'),
].filter(p => fs.existsSync(p));
const htmlFiles = walk(ROOT, '.html').filter(p => !p.includes('node_modules'));
const cssFiles = walk(path.join(ROOT, 'public/css'), '.css');

// 跳过从 i 开始的一个带引号字符串（支持转义与模板字符串），返回结束后的下标
function skipQuoted(src, i) {
  const q = src[i++];
  while (i < src.length) {
    const c = src[i++];
    if (c === '\\') { i++; continue; }
    if (c === q) break;
  }
  return i;
}

// ---------- 1. i18n ----------
function blockAfter(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return '';
  let i = start + marker.length, depth = 1, quote = '';
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(start + marker.length, i - 1);
}
function i18nKeys(block) {
  // 只取「不在字符串值与注释内部」的 key: 形式，避免把英文句子/注释里的 "xxx:" 当成键
  const keys = new Set();
  let i = 0;
  while (i < block.length) {
    const c = block[i];
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(block, i); continue; }
    if (c === '/' && block[i + 1] === '/') { while (i < block.length && block[i] !== '\n') i++; continue; }
    if (c === '/' && block[i + 1] === '*') {
      i += 2;
      while (i < block.length && !(block[i] === '*' && block[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(block.slice(i));
    if (m) { keys.add(m[1]); i += m[0].length; continue; }
    i++;
  }
  return keys;
}
function usageText() {
  const files = [...jsFiles.filter(p => !p.endsWith('00-i18n.js')), ...htmlFiles];
  return files.map(read).join('\n');
}
function checkI18n() {
  const src = read(path.join(ROOT, 'public/js/00-i18n.js'));
  const zh = i18nKeys(blockAfter(src, 'zh: {'));
  const en = i18nKeys(blockAfter(src, 'en: {'));
  const text = usageText();
  const used = k => text.includes(k) || allow.i18nKeys.includes(k)
    || allow.i18nPrefixes.some(pre => k.startsWith(pre));

  const onlyZh = [...zh].filter(k => !en.has(k));
  const onlyEn = [...en].filter(k => !zh.has(k));
  const dead = [...new Set([...zh, ...en])].filter(k => !used(k));
  if (onlyZh.length || onlyEn.length) {
    problems.push(`i18n 中英不对齐：仅 zh=${onlyZh.join(', ') || '-'}；仅 en=${onlyEn.join(', ') || '-'}`);
  }
  if (dead.length) problems.push(`i18n 零引用 key（${dead.length}）：${dead.join(', ')}`);
  console.log(`i18n: zh=${zh.size} en=${en.size} 零引用=${dead.length} 单边=${onlyZh.length + onlyEn.length}`);
  if (verbose && dead.length) console.log('  ' + dead.join('\n  '));
}

// ---------- 2. server 导出 ----------
function exportNamesOf(src) {
  const names = new Set();
  const objRe = /module\.exports\s*=\s*\{([\s\S]*?)\};/g;
  let m;
  while ((m = objRe.exec(src))) {
    for (const part of m[1].split(/[,\n]/)) {
      const n = part.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|=|$)/);
      if (n) names.add(n[1]);
    }
  }
  const propRe = /module\.exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  while ((m = propRe.exec(src))) names.add(m[1]);
  return names;
}
function checkExports() {
  // 去掉导出声明本身，只统计「真正使用」的位置
  const sources = jsFiles.map(p => ({
    file: p,
    text: read(p).replace(/module\.exports\s*=\s*\{[\s\S]*?\};/g, '')
      .replace(/module\.exports\.[A-Za-z_$][A-Za-z0-9_$]*\s*=/g, ''),
  }));
  const all = new Map();
  for (const p of walk(path.join(ROOT, 'server'), '.js')) {
    for (const n of exportNamesOf(read(p))) {
      if (!all.has(n)) all.set(n, []);
      all.get(n).push(rel(p));
    }
  }
  const dead = [...all.keys()].filter(n =>
    !allow.exportNames.includes(n)
    && !sources.some(s => new RegExp('\\b' + escapeRe(n) + '\\b').test(s.text)));
  if (dead.length) {
    problems.push(`server 零引用导出（${dead.length}）：${dead.map(n => `${n} (${all.get(n).join(', ')})`).join('; ')}`);
  }
  console.log(`server exports: 检查=${all.size} 零引用=${dead.length}`);
  if (verbose && dead.length) console.log('  ' + dead.join('\n  '));
}

// ---------- 3. CSS 类（只报告） ----------
function checkCss() {
  const used = new Set();
  const attrRe = /class\s*=\s*(['"`])([^'"`]*)\1/g;
  for (const p of [...jsFiles.filter(f => f.startsWith(path.join(ROOT, 'public'))), ...htmlFiles]) {
    const src = p.endsWith('.js') ? stripJsComments(read(p)) : read(p);
    let m;
    while ((m = attrRe.exec(src))) {
      for (const c of m[2].split(/\s+/)) {
        if (c && !c.includes('$') && !c.includes('{')) used.add(c);
      }
    }
  }
  const defined = new Set();
  const cssSources = cssFiles.map(read);
  // 登录页等存在内联 <style>，一并作为类定义来源，避免把已定义的类误报为无样式
  for (const p of htmlFiles) {
    const src = read(p);
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(src))) cssSources.push(m[1]);
  }
  for (const src of cssSources) {
    const cleaned = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /\.(-?[_a-zA-Z][\w-]*)/g;
    let m;
    while ((m = re.exec(cleaned))) defined.add(m[1]);
  }
  const missing = [...used].filter(c => !defined.has(c)
    && !allow.cssClasses.includes(c)
    && !allow.cssPrefixes.some(pre => c.startsWith(pre)))
    .sort();
  console.log(`css classes: JS/HTML 生成=${used.size} CSS 定义=${defined.size} 无样式类=${missing.length}（仅报告，不阻断）`);
  if (missing.length) console.log((verbose ? '  ' : '  前 20 个：') + missing.slice(0, verbose ? undefined : 20).join(', '));
}

checkI18n();
checkExports();
checkCss();

if (problems.length) {
  console.error('\n[check-unused] FAIL');
  for (const p of problems) console.error(' - ' + p);
  console.error('确认是动态分发后，请登记到 tools/check-unused-allowlist.json（写明原因），不要关闭检查。');
  process.exit(1);
}
console.log('\n[check-unused] PASS');
