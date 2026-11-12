# 开发文档

本文描述当前代码的实现结构：后端分层、数据库表、服务层职责、接口清单与前端组织方式。业务规则见 [业务说明](business.md)，成本算法见 [成本核算规则](costing.md)。

## 1. 架构总览

```
浏览器（public/，原生 SPA）
        │  fetch + Bearer JWT
        ▼
server.js
  ├─ config.js              环境变量校验（JWT_SECRET 等）
  ├─ middleware/audit.js    审计埋点（/api 写操作）
  ├─ middleware/auth.js     JWT 鉴权 → req.user / req.canViewPrice
  ├─ routes/*.js            参数校验 + 权限校验 + 事务编排
  └─ services/*.js          领域逻辑（成本、库存、编号、脱敏）
        │
        ▼
better-sqlite3（WAL）→ inventory.db
```

启动链路：

1. `server.js` 加载 `server/config.js`，缺少 `JWT_SECRET` 或长度不足 32 时打印提示并退出。
2. `require('./server/db')` 建立连接并执行建表 / 迁移，必要时创建初始管理员。
3. `costing.ensureOpeningBalances()` 把物料期初结存补成库存流水（业务日期 `1970-01-01`），保证余额可由流水完整推导。
4. 注册 `express.json()`、JSON 解析错误兜底、审计中间件、静态资源（禁用缓存）。
5. `/api/auth/login` 免鉴权，其余 `/api` 统一经过 `requireAuth`。
6. 挂载各路由模块，最后 `app.get('*')` 回落到 `public/index.html` 支持前端路由。

## 2. 目录与文件职责

### 后端

| 文件 | 职责 |
| --- | --- |
| `server.js` | 入口、中间件顺序、路由挂载、监听与局域网地址打印 |
| `server/config.js` | 读取 `.env` / 进程环境变量；导出 `DB_PATH`、`HOST`、`PORT`、`JWT_SECRET`、`JWT_EXPIRES`、初始管理员配置 |
| `server/db.js` | SQLite 连接、建表与增量迁移、初始管理员创建 |
| `server/permissions.js` | `ROLE_PERMISSIONS`、`MODULE_ACTIONS`、`grantsOf`、`canDo`、`PRICE_ROLES`、`canViewPrice` |
| `server/middleware/auth.js` | `requireAuth`（解析 JWT、校验账号状态、注入 `req.canViewPrice`）、`requirePerm`、`publicUser` |
| `server/middleware/audit.js` | 对 `/api` 写操作统一写 `audit_logs` |
| `server/routes/auth.js` | 登录、当前用户、修改密码 |
| `server/routes/users.js` | 用户增删改查，保护最后一个管理员 |
| `server/routes/dashboard.js` | 首页看板数据 |
| `server/routes/materials.js` | 物料档案与编码生成 |
| `server/routes/suppliers.js` | 供应商档案 |
| `server/routes/inbound.js` | 入库单（采购入库 / 零星入库 / 采购退货）及更正重开 |
| `server/routes/outbound.js` | 出库单（正常出库 / 领料退库）及更正重开 |
| `server/routes/returns.js` | 退货退库的只读聚合查询 |
| `server/routes/stock.js` | 库存汇总、物料台账、成本差异查询 |
| `server/routes/query.js` | 查询中心单据 / 领用人 / 分析与全局搜索 |
| `server/routes/stocktake.js` | 盘点建单、载入、录入、确认 |
| `server/routes/purchase.js` | 采购单、合同、采购明细、到货履历 |
| `server/routes/params.js` | 类别 / 单位 / 去向词库、单据编号规则 |
| `server/routes/settings-ops.js` | 备份下载、备份恢复、清业务数据、全清、成本差异结转 |
| `server/routes/audit.js` | 系统日志查询 |

### 服务层

| 文件 | 职责 |
| --- | --- |
| `services/units.js` | 定点换算：数量 1e6、单价 1e8、金额 1e2；BigInt 运算与 `ROUND_HALF_UP` 舍入 |
| `services/scaled-db.js` | 包装 `better-sqlite3`：写入前把元 / 数量转成定点整数，查询后按列名把定点整数还原为可读数值 |
| `services/costing.js` | 库存流水与余额的唯一写入口：插入、重排、重算、过账、作废、重建、期初、更正留痕 |
| `services/stock.js` | 可用库存、负库存校验、退库可退量校验、到货核销、库存汇总 |
| `services/docno.js` | 单据编号 `{前缀}-{YYYYMMDD}-{序号}`、编号规则校验、更正号 `-R{n}` |
| `services/price-mask.js` | 无价格权限时按行删除价格 / 金额键 |
| `services/audit.js` | 审计日志记录 |
| `services/logdetail.js` | 单据操作日志的写入与结构化明细 |
| `services/sign.js` | 单据操作留痕辅助 |
| `services/time.js` | 时间字符串与业务日期辅助 |

## 3. 定点数值与 `scaled-db.js`

- 数量：整数，单位 `1e-6`（存 `1000000` 表示 1）。
- 单价：整数，单位 `1e-8`（存 `100000000` 表示 1）。
- 金额：整数，单位分（存 `100` 表示 1 元）。
- 金额由数量与单价推导：`CAST(ROUND(qty * price / 1e12) AS INTEGER)`。`inbound.amount`、`outbound.cost_amount`、`order_lines.order_amount` 是 SQLite `STORED` 生成列，直接由该表达式计算。
- 业务代码不直接读写定点整数：`scaled-db.js` 在 SQL 层按列名约定自动换算。新增涉及数量 / 单价 / 金额的列时，列名必须符合既有约定，否则会出现「单位被放大 1e6 / 1e8」的错误。

## 4. 数据库表

### 4.1 基础档案与参数

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `params` | `key` PK, `value` | 系统参数。`currency` 恒为 `¥`；`doc_no_rules` 存单据编号规则 JSON |
| `categories` | `id`, `name` UNIQUE, `prefix` | 物料类别 |
| `units` | `id`, `name` UNIQUE | 计量单位 |
| `destinations` | `id`, `name` UNIQUE | 领用去向词库 |
| `materials` | `id`, `code` UNIQUE, `name`, `spec`, `category`, `unit`, `opening_qty`, `opening_price`, `min_stock`, `brand`, `status` | 物料档案；`status='停用'` 不进入库存汇总与搜索 |
| `suppliers` | `id`, `name` UNIQUE, `contact`, `phone`, `remarks` | 供应商档案 |
| `users` | `id`, `username` UNIQUE, `password_hash`, `name`, `role`, `status`, `must_change_pwd`, `last_login` | 用户与角色 |

### 4.2 单据

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `inbound_docs` | `doc_no` PK, `date`, `txn_type`, `supplier`, `handler`, `po_no`, `contract_no`, `status`, `return_tier`, `origin_doc_no`, `return_ref_no`, `return_reason`, `voided_at/by`, `corrects_doc_no`, `corrected_by_doc_no` | 入库单头。`txn_type`：采购入库 / 零星入库 / 采购退货 |
| `inbound` | `id`, `date`, `grn_no`, `code`, `qty`, `price`, `amount`(生成列), `supplier`, `handler`, `po_no`, `contract_no`, `txn_type`, `doc_no`, `status`, `order_line_id`, `origin_line_id` | 入库明细行 |
| `inbound_doc_logs` | `id`, `doc_no`, `action`, `operator`, `detail`, `detail_json` | 入库单操作日志 |
| `outbound_docs` | `doc_no` PK, `date`, `txn_type`, `destination`, `receiver`, `handler`, `status`, `origin_doc_no`, `return_reason`, `voided_at/by`, `corrects_doc_no`, `corrected_by_doc_no` | 出库单头。`txn_type`：正常出库 / 领料退库 |
| `outbound` | `id`, `date`, `gin_no`, `code`, `qty`, `destination`, `receiver`, `handler`, `cost_price`, `cost_amount`(生成列), `txn_type`, `doc_no`, `status`, `origin_line_id` | 出库明细行；`cost_price` 由成本核算回写 |
| `outbound_doc_logs` | 同 `inbound_doc_logs` | 出库单操作日志 |
| `purchase_orders` | `id`, `po_no` UNIQUE, `date`, `supplier`, `contract_no`, `project`, `expected_date`, `manual_status`, `status` | 采购单头；`contract_no` 仅作明细默认合同 |
| `order_lines` | `id`, `po_no`, `code`, `order_qty`, `order_price`, `order_amount`(生成列), `contract_no` | 采购明细；合同真实归属以此列优先 |
| `contracts` | `id`, `contract_no` UNIQUE, `name`, `supplier`, `sign_date`, `amount`, `status`, `remarks` | 采购合同档案 |

### 4.3 盘点与调整

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `stocktakes` | `id`, `stocktake_no` UNIQUE, `date`, `status`, `category_filter`, `load_scope`, `handler`, `confirmed_at` | 盘点单头 |
| `stocktake_lines` | `id`, `stocktake_no`, `code`, `book_qty`, `count_qty`, `diff_qty`, `status`, `remarks`，`UNIQUE(stocktake_no, code)` | 盘点行；`book_qty` 为载入时账面快照，`count_qty=NULL` 表示未盘 |
| `stocktake_logs` | `id`, `stocktake_no`, `action`, `operator`, `detail`, `detail_json` | 盘点操作日志 |
| `stock_adjustments` | `id`, `date`, `code`, `qty`, `adj_type`, `reason`, `remarks`, `handler`, `stocktake_no` | 库存调整流水；由盘点确认自动生成 |

### 4.4 成本核算

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `stock_ledger` | `id`, `material_id`, `code`, `source_type`, `source_doc_id`, `source_line_id`, `business_type`, `business_date`, `effective_date`, `posting_time`, `posting_sequence`, `qty_in`, `qty_out`, `amount_in`, `amount_out`, `unit_cost`, `balance_qty`, `balance_amount`, `balance_avg_cost`, `status`, `correction_of`, `return_source_line_id`, `cost_basis` | 库存流水，成本核算的权威依据 |
| `stock_balance` | `code` PK, `material_id`, `stock_qty`, `stock_amount`, `avg_cost`, `last_posting_sequence`, `updated_at` | 最新余额快照，库存读取统一走此表 |
| `inventory_recalc_logs` | `id`, `task_id`, `kind`, `original_doc`, `new_doc`, `code`, `start_sequence`, `end_sequence`, `qty_before/after`, `amount_before/after`, `affected_rows`, `operator`, `status`, `message` | 重算与尾差留痕 |
| `cost_variances` | `id`, `ledger_id`, `code`, `source_type`, `source_doc_id`, `source_line_id`, `business_type`, `business_date`, `qty`, `unit_cost`, `avg_cost`, `amount`, `reason`, `status`, `settle_batch`, `settled_at` | 数量归零时的残值差异；`status` 为 `open` / `settled` |

### 4.5 审计

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `audit_logs` | `id`, `created_at`, `user_id`, `username`, `name`, `role`, `module`, `action`, `target`, `method`, `path`, `ip`, `status`, `detail`, `detail_json` | 系统审计日志；`created_at` 存 UTC，前端按本地时区渲染 |

### 4.6 主要索引

- `inbound(code)`、`inbound(date)`、`inbound(grn_no)`、`inbound(doc_no)`、`inbound(order_line_id)`、`inbound(origin_line_id)`
- `outbound(code)`、`outbound(date)`、`outbound(gin_no)`、`outbound(doc_no)`、`outbound(origin_line_id)`
- `inbound_docs(status)`、`inbound_docs(corrects_doc_no)`、`inbound_docs(corrected_by_doc_no)`；`outbound_docs` 同组，另有 `outbound_docs(receiver)`
- `order_lines(po_no)`、`order_lines(code)`
- `stock_ledger(code, status, posting_sequence)`、`stock_ledger(source_type, source_doc_id)`、`stock_ledger(business_date)`、`stock_ledger(status, business_date)`
- `cost_variances(status)`、`cost_variances(code)`、唯一部分索引 `(ledger_id) WHERE status='open'`
- `audit_logs(created_at)`、`audit_logs(username)`、`audit_logs(module)`

## 5. 权限与中间件

- `ROLE_PERMISSIONS` 定义四个角色的模块动作集合；`admin` 为 `['*']`，展开时按 `MODULE_ACTIONS` / `DEFAULT_MODULE_ACTIONS` 生成完整授权表。
- `canDo(role, module, action)` 是唯一的判定函数；`requirePerm(module, action)` 在路由层返回 403。
- `requireAuth` 解析 `Authorization: Bearer <token>`，查库确认用户存在且 `status='active'`，然后挂载 `req.user` 与 `req.canViewPrice`。
- `canViewPrice` 仅在角色为 `admin` / `manager` 时为真；无权限的接口必须删除价格键（`price`、`amount`、`cost_price`、`cost_amount`、`total_amount`、`unit_cost`、`avg_cost`、`stock_value` 等），不能只依赖前端隐藏。
- `auditMiddleware` 记录 `/api` 写操作；设置页运维接口在自身路由内写审计，并把备份文件名等写入 `detail`。

## 6. 主要接口一览

### 认证与用户

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/auth/login` | 公开 |
| GET | `/api/auth/me` | 登录 |
| POST | `/api/auth/change-password` | 登录 |
| GET/POST | `/api/users` | `users:view` / `users:create` |
| PUT/DELETE | `/api/users/:id` | `users:edit` / `users:delete` |

### 基础档案

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/materials`、`/api/materials/next-code` | `materials:view` |
| POST / PUT / DELETE | `/api/materials`、`/api/materials/:code` | `materials:create/edit/delete` |
| GET/POST | `/api/suppliers` | `suppliers:view/create` |
| PUT/DELETE | `/api/suppliers/:id` | `suppliers:edit/delete` |
| GET | `/api/params` | 登录 |
| POST | `/api/params/:type` | `settings:create` |
| DELETE | `/api/params/:type/:id` | `settings:delete` |
| PUT | `/api/params/doc-no-rules` | `settings:edit` |

`/api/params/:type` 的 `type` 为 `categories` / `units` / `destinations`。

### 入库

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/inbound-docs`、`/api/inbound-docs/next-no` | `inbound:view` |
| POST | `/api/inbound-docs` | `inbound:create` |
| GET | `/api/inbound-docs/:docNo`、`/:docNo/correction-info` | `inbound:view` |
| PUT | `/api/inbound-docs/:docNo/lines` | `inbound:edit` |
| POST | `/api/inbound-docs/:docNo/confirm`、`/:docNo/correction`、`/:docNo/confirm-correction` | `inbound:edit` |
| DELETE | `/api/inbound-docs/:docNo` | `inbound:delete` |

### 出库

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/outbound-docs`、`/api/outbound-docs/next-no` | `outbound:view` |
| POST | `/api/outbound-docs` | `outbound:create` |
| GET | `/api/outbound-docs/:docNo`、`/:docNo/returnable`、`/:docNo/correction-info` | `outbound:view` |
| PUT | `/api/outbound-docs/:docNo/lines` | `outbound:edit` |
| POST | `/api/outbound-docs/:docNo/confirm`、`/:docNo/correction`、`/:docNo/confirm-correction` | `outbound:edit` |
| DELETE | `/api/outbound-docs/:docNo` | `outbound:delete` |

### 退货退库

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/returns/docs`、`/api/returns/docs/:docNo` | `returns:view` |
| GET | `/api/returns/purchase/origins`、`/origin-lines` | `returns:view` |
| GET | `/api/returns/purchase/scope-options`、`/scope-lines` | `returns:view` |

退货退库为只读聚合接口；实际的采购退货与领料退库写入走入库 / 出库路由。

### 库存与查询中心

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/stock-summary` | `query:view` |
| GET | `/api/ledger/:code` | `query:view` |
| GET | `/api/query/docs` | `query:view` |
| GET | `/api/query/search` | `query:view` |
| GET | `/api/query/receivers`、`/api/query/receivers/:name` | `query:view` |
| GET | `/api/analysis/stagnant` | `query:view` |
| GET | `/api/analysis/abc` | `query:view` |
| GET | `/api/analysis/turnover` | `query:view` |
| GET | `/api/cost-variance` | `dashboard:view` |

### 盘点

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/stocktakes`、`/next-no`、`/candidates`、`/:no` | `stocktake:view` |
| POST | `/api/stocktakes` | `stocktake:create` |
| DELETE | `/api/stocktakes/:no` | `stocktake:create` |
| POST | `/api/stocktakes/:no/load`、`/lines` | `stocktake:create` |
| PUT | `/api/stocktakes/:no/lines` | `stocktake:create` |
| DELETE | `/api/stocktakes/:no/lines/:id` | `stocktake:create` |
| POST | `/api/stocktakes/:no/confirm` | `stocktake:confirm` |

### 采购管理

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/purchase/orders`、`/orders/next-no`、`/orders/:poNo` | `purchase:view` |
| POST | `/api/purchase/orders` | `purchase:create` |
| PUT | `/api/purchase/orders/:poNo` | `purchase:edit` |
| POST | `/api/purchase/orders/:poNo/confirm` | `purchase:edit` |
| DELETE | `/api/purchase/orders/:poNo` | `purchase:delete` |
| POST | `/api/purchase/lines/batch`、`/api/purchase/lines` | `purchase:create` |
| PUT/DELETE | `/api/purchase/lines/:id` | `purchase:edit/delete` |
| GET | `/api/purchase/lines`、`/lines/:id/inbound`、`/lines/by-po/:poNo`、`/lines/by-contract/:contractNo` | `purchase:view` |
| GET | `/api/purchase/pending-orders`、`/inbound-sources`、`/inbound-scope-lines` | `purchase:view` |
| GET | `/api/purchase/contracts`、`/contracts/:contractNo` | `purchase:view` |
| POST | `/api/purchase/contracts` | `purchase:create` |
| PUT/DELETE | `/api/purchase/contracts/:contractNo` | `purchase:edit/delete` |

### 运维与日志

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/settings/backup/download` | 仅 `admin` |
| POST | `/api/settings/backup/restore` | 仅 `admin` |
| POST | `/api/settings/cost-variance/settle` | 仅 `admin` |
| POST | `/api/settings/data/clear-business` | 仅 `admin` |
| POST | `/api/settings/data/reset` | 仅 `admin` |
| GET | `/api/dashboard` | `dashboard:view` |
| GET | `/api/audit-logs` | `audit:view` |

## 7. 前端组织

- `public/index.html` 按编号顺序加载 `00-i18n.js` 至 `13-returns.js`，全部挂到全局 `window.App`；同时通过 CDN 引入 Chart.js 4 用于看板图表。
- `public/login.html` 是独立登录页，使用 `public/style.css`；登录成功后把 token 与用户信息写入 `localStorage`，并跳转 `/` 进入 SPA。
- `01-core.js` 负责：读取 / 保存 token、统一 `api()` 请求与 401 处理、hash 路由、`canDo` / `canViewPrice` 前端判定、登录页。
- `02-ui-kit.js` 提供通用表格、弹窗、Toast、分页、单据打印与 CSV 导出（UTF-8 BOM，Excel 中文不乱码）。
- 各业务脚本以 `App.xxx` 方法扩展，页面刷新通过 hash 路由重渲染，不做组件级状态管理。
- 语言切换即时重渲染；文本统一走 `t('key')`，新增文案需同时补中英两份词典。

## 8. 错误码约定

| 错误码 | 含义 |
| --- | --- |
| `INSUFFICIENT_STOCK` | 核算后库存为负，整笔过账回滚 |
| `NO_COST_BASIS` | 物料从未有过正库存，按 0 成本入账需管理员确认 |
| `DOC_NO_EXISTS` | 更正单号已存在 |
| `CONFIRM_MISMATCH` | 清库 / 恢复的确认短语不正确 |
| `FORBIDDEN` | 非管理员执行管理员操作 |

## 9. 开发约定

- 库存数量与金额只能由 `services/costing.js` 写 `stock_ledger` / `stock_balance`，其他模块不得直接改余额。
- 业务路由只做参数校验、权限校验与事务编排，跨模块计算放到 `services/`。
- 新增接口必须显式加 `requirePerm`；涉及金额的返回必须考虑 `req.canViewPrice`。
- 新增单据类型时，同步更新 `services/docno.js` 的 `TYPES` / 默认前缀与参数设置中的编号规则校验。
