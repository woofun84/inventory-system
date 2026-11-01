# 库存管理系统（Web 版）

由 Excel《库存进出库管理》复刻而来的 Web 库存管理系统。数据库后端 + 网页前端。

## 启动

```bash
cd inventory-system
node server.js
# 打开 http://localhost:3000
```

首次初始化数据库（可选，会清空并重建）：

```bash
node init-db.js
```

## 目录结构

```
inventory-system/
├── server.js          Express 后端，全部 REST API 路由
├── init-db.js         数据库初始化脚本（从 Excel 提取的种子数据）
├── inventory.db       SQLite 数据库
├── package.json
└── public/
    ├── index.html     入口页面
    ├── app.js         应用主逻辑：i18n、主题、11 个页面渲染、通用组件函数
    └── style.css      全部样式（CSS 变量主题系统）
```

## 技术栈

- **后端**：Node.js + Express + SQLite（better-sqlite3）
- **前端**：原生 HTML / CSS / JavaScript，无框架、无构建步骤
- **图表**：Chart.js（CDN 引入）

改完前端代码直接刷新浏览器即可生效，无需打包。

## 功能模块

| 页面 | 说明 |
|------|------|
| 仪表盘 | 库存总览、进出库趋势图、分类占比、TOP 物料 |
| 物料档案 | 物料基础信息维护，含期初库存/单价/最低库存/库位 |
| 入库记录 | 采购入库流水，支持多关键字 + 日期段实时筛选 |
| 出库记录 | 出库流水，成本单价按加权平均法计算 |
| 库存汇总 | 实时库存、库存金额、缺货/补货预警 |
| 查询中心 | 多条件组合查询（物料/日期/供应商/经手人/去向/订单号） |
| 物料台账 | 单个物料的完整进出流水台账 + 期初/期末结存 |
| 位置库存 | 按物料或按库位查看分布 |
| 采购订单 | 订单及明细行，到货状态跟踪、逾期天数统计 |
| 供应商档案 | 供应商基础信息 |
| 参数设置 | 物料分类、计量单位、库位、去向等基础参数维护 |

## 交互特性

- 中英文实时切换、暗色/亮色主题（记忆用户偏好）
- 表格点击表头排序、分页（10/15/20/50/全部条）
- 表单内联校验、错误提示随输入自动消除
- 删除二次确认弹窗、操作结果 toast 提示
- 多关键字模糊筛选（空格分隔多个关键字，AND 关系）
- 日期段范围筛选
- 数据表格：工具栏与表头固定顶部、分页条固定底部，仅数据区滚动

## 开发约定

### 前端表格页面的 DOM 结构（重要）

数据类页面统一使用 `.data-page` 三段式布局：

```
.data-page (flex column, height:100%)
  ├── .data-toolbar  (flex-shrink:0)  新增按钮 + 筛选框 + 日期段
  ├── .data-summary  (flex-shrink:0)  统计汇总行
  ├── .data-scroll   (flex:1, overflow:auto)  表格，thead sticky 生效
  └── .data-pager    (flex-shrink:0)  分页条
```

`renderXxx()` 只渲染一次整体结构；`renderXxxTable()` 只重设 `#xxx-scroll` 与 `#xxx-pager`。
**不要重设包含工具栏的容器**——中文输入法（IME）的组合状态会被打断，导致无法输入中文。

### i18n

`I18N` 字典里 `zh` 和 `en` 的 key 必须一一对应。新增界面文案时两边都要补。

### 表格状态

`App.tableStates[tableId]` 存 `{ sortKey, sortDir, page, pageSize }`；
`App._tableRenderers[tableId]` 存重渲染回调，排序/翻页时调用。

### 验证语法

```bash
node -c public/app.js
```

## 待办

- 用户管理 + 权限控制（不同用户不同权限）
  - 后端：users 表 + bcrypt 加密 + JWT 登录
  - 前端：登录页 + 权限路由 + 按角色显隐菜单/按钮
