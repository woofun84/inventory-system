#!/usr/bin/env node
/**
 * 提交前 JS 语法自检：递归编译 public/js、server、tools 下的 .js 以及两个入口文件。
 * 只检查语法（vm.Script 编译），不执行代码，不依赖 shell 的 for/glob 语法。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, 'public/js')),
  ...walk(path.join(ROOT, 'server')),
  ...walk(path.join(ROOT, 'tools')),
  path.join(ROOT, 'server.js'),
  path.join(ROOT, 'init-db.js'),
].filter(p => fs.existsSync(p));

let failed = 0;
for (const file of files) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (e) {
    failed++;
    console.error(`[check-syntax] ${path.relative(ROOT, file)}: ${e.message}`);
  }
}

console.log(`[check-syntax] 检查=${files.length} 失败=${failed}`);
process.exit(failed ? 1 : 0);
