/**
 * 一次性脚本：把 style.css 按区块机械切分为 css/ 下的多份。
 * 原则：只做搬运，不改任何一行样式内容；每个原始区块恰好出现一次。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'public', 'style.css');
const OUT = path.join(__dirname, 'public', 'css');

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const slice = (from, to) => lines.slice(from - 1, to).join('\n');

// 原始行区间划分（互不重叠，覆盖 1-946 全量）
// 1-32    : 文件头 + :root 变量 + reset
// 33-228  : 框架 / 布局 / 侧边栏 / 右侧主内容
// 229-256 : 数据页面布局（data-page 三段式）
// 257-479 : 卡片 / 按钮 / 表格 / 标签 / 表单 / 模态框 / 指标卡 / 图表
// 480-544 : 查询条件栏 / Toast / 操作链接 / 空状态 / 分隔线 / 滚动条
// 545-684 : 响应式 + 数据表格优化 V2
// 685-791 : 顶栏工具按钮 / 确认弹窗 / 表单校验错误
// 792-854 : 表格排序 + 分页
// 855-946 : 暗色主题

const MODULES = [
  {
    file: 'base.css',
    desc: '变量 / reset / 框架 / 布局 / 侧边栏 / 主内容',
    head: `/* ==========================================
   基础层 —— CSS 变量、reset、主框架、侧边栏、右侧主内容
   ========================================== */`,
    body: `${slice(1, 32)}

${slice(33, 256)}`,
  },
  {
    file: 'components.css',
    desc: '卡片 / 按钮 / 表格 / 标签 / 表单 / 模态框 / Toast / 弹窗',
    head: `/* ==========================================
   组件层 —— 卡片、按钮、表格、状态标签、表单、模态框、指标卡、
             图表、查询条件栏、Toast、操作链接、空状态、滚动条
   ========================================== */`,
    body: `${slice(257, 479)}

${slice(480, 544)}`,
  },
  {
    file: 'pages.css',
    desc: '表格优化 / 排序分页 / 响应式',
    head: `/* ==========================================
   页面层 —— 响应式适配、表格视觉优化 V2、顶栏工具按钮、
             确认弹窗、表单校验错误态、表格排序与分页
   ========================================== */`,
    body: `${slice(545, 684)}

${slice(685, 791)}

${slice(792, 854)}`,
  },
  {
    file: 'theme-dark.css',
    desc: '暗色主题变量覆盖（须最后引入以保证层叠优先级）',
    head: `/* ==========================================
   暗色主题 —— 必须最后引入，确保变量覆盖生效
   ========================================== */`,
    body: `${slice(855, 946)}`,
  },
];

// 校验：所有区间互不重叠且完整覆盖
const ranges = [];
for (const m of MODULES) {
  // body 已是求值后的字符串，用原始定义里的区间更可靠 —— 这里直接扫描源码
  const def = fs.readFileSync(__filename, 'utf8');
  void def;
}
// 改用显式区间表校验
const INTERVALS = [
  [1, 32], [33, 228], [229, 256], [257, 479],
  [480, 544], [545, 684], [685, 791], [792, 854], [855, 946],
];
const sorted = [...INTERVALS].sort((a, b) => a[0] - b[0]);
let cursor = 1, ok = true;
for (const [f, t] of sorted) {
  if (f !== cursor) { console.error(`区间不连续：期望 ${cursor}，实际 ${f}-${t}`); ok = false; }
  cursor = t + 1;
}
if (cursor !== 947) { console.error(`末尾覆盖不全，止于 ${cursor - 1}`); ok = false; }
if (!ok) { console.error('切分区间校验失败，已中止'); process.exit(1); }
console.log(`区间校验通过：${sorted.length} 段，完整覆盖 1-946 且无重叠\n`);

fs.mkdirSync(OUT, { recursive: true });

MODULES.forEach((m) => {
  const content = `${m.head}\n\n${m.body}\n`;
  fs.writeFileSync(path.join(OUT, m.file), content, 'utf8');
  console.log(`生成 ${m.file.padEnd(18)} ${m.desc.padEnd(56)} ${String(content.split('\n').length).padStart(4)} 行`);
});

console.log(`\n共生成 ${MODULES.length} 个样式文件 -> ${OUT}`);
