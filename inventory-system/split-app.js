/**
 * 一次性脚本：把 app.js 按功能区块机械切分为 js/ 下的多个模块文件。
 * 原则：只做搬运，不改任何一行代码内容。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'public', 'app.js');
const OUT = path.join(__dirname, 'public', 'js');

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
// 行号 → 数组下标 (行号从 1 开始)
const L = (n) => lines[n - 1];

function slice(from, to) {
  return lines.slice(from - 1, to).join('\n');
}

// 各模块定义：文件头注释 + 从 app.js 中提取的区块（行号区间）
const MODULES = [
  {
    file: '00-i18n.js',
    desc: '国际化字典（zh / en）',
    head: `/**
 * 国际化字典 —— 中英文文案
 * 注意：zh 与 en 的 key 必须完全对齐，缺一条切换语言就会显示原始 key
 */`,
    body: slice(6, 192), // const I18N = { ... };
  },
  {
    file: '01-core.js',
    desc: '应用主体 / 状态 / 路由 / API / 权限',
    head: `/**
 * 应用主体 —— 状态、生命周期、主题语言、路由、API 封装、权限判定
 * 说明：App 是全局单例，各业务模块通过 Object.assign(App, {...}) 挂载方法，
 *      因此本文件必须最先加载。
 */`,
    body: `const App = {
${slice(196, 454)}
};`,
  },
  {
    file: '02-ui-kit.js',
    desc: '通用组件 —— 表格排序 / 分页 / 表单校验 / 筛选 / 弹窗',
    head: `/**
 * 通用 UI 组件 —— 表格排序、分页、表单校验、空状态、筛选、状态徽章、模态框
 */
Object.assign(App, {
${slice(455, 676)}
${slice(2087, 2100)}
});`,
  },
  {
    file: '03-dashboard.js',
    desc: '仪表盘',
    head: `/**
 * 仪表盘 —— 指标卡与 Chart.js 图表
 * 注意：主题切换时需 destroyCharts() 后重建，图表颜色动态取值
 */
Object.assign(App, {
${slice(677, 734)}
});`,
  },
  {
    file: '04-materials.js',
    desc: '物料档案',
    head: `/**
 * 物料档案 —— 列表、新增/编辑、类别联动
 */
Object.assign(App, {
${slice(735, 822)}
});`,
  },
  {
    file: '05-inbound.js',
    desc: '入库记录',
    head: `/**
 * 入库记录 —— 列表、批量入库表单、按订单号带出明细
 */
Object.assign(App, {
${slice(823, 1180)}
});`,
  },
  {
    file: '06-outbound.js',
    desc: '出库记录',
    head: `/**
 * 出库记录 —— 列表、批量出库表单
 */
Object.assign(App, {
${slice(1181, 1412)}
});`,
  },
  {
    file: '07-stock.js',
    desc: '库存汇总 / 物料台账 / 位置库存',
    head: `/**
 * 库存视图 —— 库存汇总、物料台账、位置库存
 */
Object.assign(App, {
${slice(1413, 1635)}
});`,
  },
  {
    file: '08-orders.js',
    desc: '采购订单 / 订单明细跟踪',
    head: `/**
 * 采购 —— 采购订单、订单明细、订单明细跟踪
 */
Object.assign(App, {
${slice(1636, 1999)}
});`,
  },
  {
    file: '09-admin.js',
    desc: '供应商档案 / 参数设置 / 用户管理',
    head: `/**
 * 管理页 —— 供应商档案、参数设置、用户管理
 */
Object.assign(App, {
${slice(2000, 2086)}
});`,
  },
];

fs.mkdirSync(OUT, { recursive: true });

MODULES.forEach((m) => {
  const content = `${m.head}\n\n${m.body}\n`;
  fs.writeFileSync(path.join(OUT, m.file), content, 'utf8');
  console.log(`生成 ${m.file.padEnd(18)} ${m.desc.padEnd(36)} ${String(content.split('\n').length).padStart(5)} 行`);
});

console.log(`\n共生成 ${MODULES.length} 个模块文件 -> ${OUT}`);
