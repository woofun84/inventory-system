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
  ├─ middleware/auth.js     JWT + sid 会话鉴权 → req.user / req.grants / req.canViewPrice
  ├─ routes/*.js            参数校验 + 权限校验 + 事务编排
  └─ services/*.js          领域逻辑（成本、库存、编号、会话、备份、脱敏）
        │
        ▼
better-sqlite3（WAL）→ inventory.db
```

启动链路：

1. `server.js` 加载 `server/config.js`，缺少 `JWT_SECRET` 或长度不足 32 时打印提示并退出。
2. `require('./server/db')` 建立连接并执行建表，必要时创建初始管理员；只为从未初始化过的用户按角色矩阵补一份默认授权。
3. 新建或修改物料时，`costing.syncOpeningLedger()` 与物料档案在同一事务内写入期初流水（业务日期 `1970-01-01`），保存后余额即可由流水推导。启动时的 `ensureOpeningBalances()` 只作为历史数据兜底，不再承担「保存期初」的职责。
4. `services/auto-backup.js` 启动定时器：读取 `params.auto_backup`，启动 3 秒后先判一次是否已错过周期（停机期间错过的会立即补跑）。
5. 注册 `express.json()`、JSON 解析错误兜底、审计中间件、静态资源（禁用缓存）。
6. `/api/health` 与 `/api/auth/login` 免鉴权，其余 `/api` 统一经过 `requireAuth`。
7. 挂载各路由模块，最后 `app.get('*')` 回落到 `public/index.html` 支持前端路由。

## 2. 目录与文件职责

### 后端

| 文件 | 职责 |
| --- | --- |
| `server.js` | 入口、中间件顺序、路由挂载、监听与局域网地址打印 |
| `server/config.js` | 读取 `.env` / 进程环境变量；导出 `DB_PATH`、`HOST`、`PORT`、`JWT_SECRET`、`JWT_EXPIRES`、初始管理员配置 |
| `server/db.js` | SQLite 连接、建表与唯一索引（含物料四字段唯一性预检）、初始管理员与用户默认授权 |
| `server/permissions.js` | `ROLE_PERMISSIONS`、`MODULES`、`MODULE_ACTIONS`、`actionsOf`、`grantsOf`、`hasGrant`、`PRICE_ROLES`、`canViewPrice` |
| `server/middleware/auth.js` | `requireAuth`（解析 JWT、校验 `sid` 会话、注入 `req.grants` / `req.canViewPrice`）、`requirePerm`、`publicUser` |
| `server/middleware/audit.js` | 对 `/api` 写操作统一写 `audit_logs` |
| `server/routes/auth.js` | 登录（签发 / 沿用会话）、当前用户、会话心跳、退出、修改密码 |
| `server/routes/users.js` | 用户增删改查、用户级权限保存、`GET /api/permissions/catalog`，保护最后一个管理员 |
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
| `server/routes/settings-ops.js` | 备份下载、备份恢复、自动备份设置与立即执行、清业务数据、全清、成本差异结转 |
| `server/routes/audit.js` | 系统日志查询、清空全部日志（仅管理员） |

### 服务层

| 文件 | 职责 |
| --- | --- |
| `services/units.js` | 定点换算：数量 1e6、单价 1e8、金额 1e2；BigInt 运算与 `ROUND_HALF_UP` 舍入 |
| `services/scaled-db.js` | 包装 `better-sqlite3`：写入前把元 / 数量转成定点整数，查询后按列名把定点整数还原为可读数值 |
| `services/costing.js` | 库存流水与余额的唯一写入口：插入、重排、重算、过账、作废、重建、期初、更正留痕 |
| `services/stock.js` | 可用库存、负库存校验、退库可退量校验、到货核销、库存汇总 |
| `services/docno.js` | 单据编号 `{前缀}-{YYYYMMDD}-{序号}`、编号规则校验、更正号 `-R{n}` |
| `services/session.js` | 单终端登录会话：`issueSession`（同终端沿用 `sid`）、`getSession`、`touchSession`（60 秒内不重复写）、`revokeSession` |
| `services/user-permissions.js` | 用户级授权的规范化、整表覆盖写入、按角色初始化与读取（`admin` 直接返回全量） |
| `services/auto-backup.js` | 自动覆盖式备份：设置读写、到期判断、`VACUUM INTO` 快照、状态查询、启动补跑 |
| `services/errors.js` | 写路径业务码英文文案、`SQLITE_BUSY` 识别、库存不足 / 业务异常的统一响应体 |
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
| `materials` | `id`, `code` UNIQUE, `name`, `spec`, `category`, `unit`, `opening_qty`, `opening_price`, `min_stock`, `brand`, `status` | 物料档案；`status='停用'` 不进入库存汇总与搜索；「类别+名称+规格+品牌」有唯一索引（去首尾空格、忽略大小写，空值按空串） |
| `suppliers` | `id`, `name` UNIQUE, `contact`, `phone`, `remarks` | 供应商档案 |
| `users` | `id`, `username` UNIQUE, `password_hash`, `name`, `role`, `status`, `must_change_pwd`, `last_login` | 用户与角色 |
| `user_permissions` | `user_id`, `module`, `action`，`PRIMARY KEY(user_id, module, action)` | 用户级授权；某用户的全部行就是最终授权集合（整表覆盖，不做增量合并） |
| `user_perm_state` | `user_id` PK, `seeded_at` | 标记该用户权限已初始化，避免「全部取消」后在重启时被角色默认值填回 |
| `user_sessions` | `user_id` PK, `sid`, `terminal`, `login_at`, `last_seen`, `ip`, `user_agent` | 单终端登录会话，每用户一行；后登录覆盖 `sid`，旧 token 因 `sid` 不匹配立即失效 |

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

- 唯一索引 `uq_materials_identity(category, name, spec, brand)`：列上使用 `lower(trim(COALESCE(...,'')))`，建索引前先检测重复组，有冲突直接阻断启动并列出记录。
- `inbound(code)`、`inbound(date)`、`inbound(grn_no)`、`inbound(doc_no)`、`inbound(order_line_id)`、`inbound(origin_line_id)`
- `outbound(code)`、`outbound(date)`、`outbound(gin_no)`、`outbound(doc_no)`、`outbound(origin_line_id)`
- `inbound_docs(status)`、`inbound_docs(corrects_doc_no)`、`inbound_docs(corrected_by_doc_no)`；`outbound_docs` 同组，另有 `outbound_docs(receiver)`
- `order_lines(po_no)`、`order_lines(code)`
- `stock_ledger(code, status, posting_sequence)`、`stock_ledger(source_type, source_doc_id)`、`stock_ledger(business_date)`、`stock_ledger(status, business_date)`
- `cost_variances(status)`、`cost_variances(code)`、唯一部分索引 `(ledger_id) WHERE status='open'`
- `audit_logs(created_at)`、`audit_logs(username)`、`audit_logs(module)`

## 5. 权限与中间件

- 授权存在库里：`user_permissions` 是某用户的最终授权集合，`user_perm_state` 标记已初始化。`ROLE_PERMISSIONS` 只用于建号、改角色或首次初始化的默认值；`grantsOf(role)` 负责展开 `admin: ['*']`。
- `hasGrant(grants, module, action)` 是唯一的判定函数；`requirePerm(module, action)` 在路由层返回 403。`admin` 恒定全量（`grantsForUser` 直接返回完整矩阵），不依赖授权表。
- `requireAuth` 解析 `Authorization: Bearer <token>`，查库确认用户存在且 `status='active'`，再比对 `user_sessions.sid`：缺 `sid` 或会话已撤销返回 `SESSION_REQUIRED`，`sid` 不一致返回 `SESSION_KICKED`。通过后挂载 `req.user`、`req.sessionSid`、`req.grants`、`req.canViewPrice`。
- 用户管理页通过 `GET /api/permissions/catalog` 取模块 / 动作全集与各角色默认值，`PUT /api/users/:id` 提交 `permissions` 时整表覆盖；`users` 模块本身不可勾选，避免非管理员获得用户管理入口。
- `canViewPrice` 仅在角色为 `admin` / `manager` 时为真；无权限的接口必须删除价格键（`price`、`amount`、`cost_price`、`cost_amount`、`total_amount`、`unit_cost`、`avg_cost`、`stock_value` 等），不能只依赖前端隐藏。
- 涉及已有库存与单据状态的写路径（过账、更正 / 作废、盘点确认、物料期初修改）统一用 `tx.immediate()`（`BEGIN IMMEDIATE`）：状态守卫、库存 / 可退量 / 超收校验与写流水在同一临界区；新物料建档这类没有并发争用的首次写入仍可用普通事务。`SQLITE_BUSY` 由 `services/errors.js` 转成 `DB_BUSY`。
- `auditMiddleware` 记录 `/api` 写操作；设置页运维接口在自身路由内写审计，并把备份文件名等写入 `detail`。

## 6. 主要接口一览

### 认证与用户

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/auth/login` | 公开 |
| GET | `/api/auth/me` | 登录 |
| GET | `/api/auth/session` | 登录；会话心跳，`sid` 失效时返回 401 `SESSION_KICKED` |
| POST | `/api/auth/logout` | 登录；只撤销当前 `sid` 的会话 |
| GET | `/api/health` | 公开；前端探测服务器是否可达 |
| POST | `/api/auth/change-password` | 登录 |
| GET/POST | `/api/users` | `users:view` / `users:create` |
| PUT/DELETE | `/api/users/:id` | `users:edit` / `users:delete` |
| GET | `/api/permissions/catalog` | `users:view`；模块 / 动作全集与角色默认值 |

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
| POST | `/api/inbound-docs/:docNo/confirm` | `inbound:edit` |
| POST | `/api/inbound-docs/:docNo/correction`、`/:docNo/confirm-correction` | `inbound:correct` |
| DELETE | `/api/inbound-docs/:docNo` | `inbound:delete` |

### 出库

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/outbound-docs`、`/api/outbound-docs/next-no` | `outbound:view` |
| POST | `/api/outbound-docs` | `outbound:create` |
| GET | `/api/outbound-docs/:docNo`、`/:docNo/returnable`、`/:docNo/correction-info` | `outbound:view` |
| PUT | `/api/outbound-docs/:docNo/lines` | `outbound:edit` |
| POST | `/api/outbound-docs/:docNo/confirm` | `outbound:edit` |
| POST | `/api/outbound-docs/:docNo/correction`、`/:docNo/confirm-correction` | `outbound:correct` |
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
| POST | `/api/settings/backup/restore` | 仅 `admin`；结构不一致返回 `BACKUP_SCHEMA_MISMATCH` |
| GET/PUT | `/api/settings/backup/auto` | 仅 `admin`；读取 / 保存自动覆盖式备份设置 |
| POST | `/api/settings/backup/auto/run` | 仅 `admin`；立即覆盖 `backups/auto-backup-latest.db` |
| POST | `/api/settings/cost-variance/settle` | 仅 `admin` |
| POST | `/api/settings/data/clear-business` | 仅 `admin` |
| POST | `/api/settings/data/reset` | 仅 `admin` |
| GET | `/api/dashboard` | `dashboard:view` |
| GET | `/api/audit-logs` | `audit:view` |
| DELETE | `/api/audit-logs` | 仅 `admin`；清空全部日志并保留一条本次清空记录 |

## 7. 前端组织

- `public/index.html` 按编号顺序加载 `00-i18n.js` 至 `14-connection.js`，全部挂到全局 `window.App`；同时通过 CDN 引入 Chart.js 4 用于看板图表。
- `public/login.html` 是独立登录页，加载 `public/css/base.css`、`components.css`、`theme-dark.css`，登录样式写在页内 `<style>`；登录成功后把 token 与用户信息写入 `localStorage`，并跳转 `/` 进入 SPA。登录时会带上 `localStorage.terminal_id`（首次登录生成并复用），用于区分终端：同一浏览器的多标签共享同一终端，不互相挤下线。`public/style.css` 为历史遗留主题，已无页面引用。
- `01-core.js` 负责：读取 / 保存 token、统一 `api()` 请求与 401 处理、hash 路由、`can(module, action)` / `canViewPrice` 前端判定、登录页，以及状态徽标与业务类型徽标的单一映射（`docStatusMeta`、`docTypeBadgeClass`、`statusBadge`）。
- `02-ui-kit.js` 提供通用表格、弹窗、Toast、分页、单据打印与 CSV 导出（UTF-8 BOM，Excel 中文不乱码）；表头排序按列类型传 `align`（数字右对齐、状态 / 类型 / 操作居中），表格容器统一 `overflow-x` 横向滚动，单元格 `nowrap` 不再被压缩；日期与时刻统一走 `fmtDateTime` / `fmtDocDate`，业务日期显示到分钟。
- `09-admin.js` 用户管理页从 `/api/permissions/catalog` 渲染模块动作勾选面板，`admin` 行只读；保存时随用户一起提交 `permissions`。
- 各业务脚本以 `App.xxx` 方法扩展，页面刷新通过 hash 路由重渲染，不做组件级状态管理。
- `14-connection.js` 负责「前端如何感知自己还能不能用」：轮询 `/api/health` 判断服务器是否可达（顶部横幅提示，恢复后自动消失并按需重渲染当前页），轮询 `/api/auth/session` 及时发现被其它终端挤下线（弹窗提示，不静默跳登录页）。
- 导航固定为五个分组：概览、业务办理、查询分析、基础资料、系统管理（`01-core.js` 的 `renderSidebar`），按 `view` 权限过滤。
- 语言切换即时重渲染；文本统一走 `t('key')`，中英词典各 1280 条且 key 必须对齐，新增文案需同时补两份。
- 主界面样式全部在 `public/css/` 的静态文件中，颜色只使用 `base.css` 的语义 token（`--success-*`、`--warning-*`、`--table-*` 等）；状态徽标、单号链接（`.pu-lk`）、确认弹窗、表格定义都只有一处定义，页面脚本不再运行时注入 `<style>`。打印预览是独立打印文档，样式随打印模板内联生成，不影响主界面。

## 8. 错误码约定

| 错误码 | 含义 |
| --- | --- |
| `INSUFFICIENT_STOCK` | 核算后库存为负或可用量不足，整笔过账回滚 |
| `NO_COST_BASIS` | 物料从未有过正库存，按 0 成本入账需管理员确认 |
| `DOC_NO_EXISTS` | 更正单号已存在 |
| `DOC_NO_CONFLICT` | 并发建单时单号刚被其它请求占用，本次未保存 |
| `DOC_STATE_CHANGED` | 单据已被其它请求处理（确认 / 作废），本次未生效，需刷新 |
| `STOCKTAKE_STATE_CHANGED` | 盘点单已被其它请求确认，本次未生效，需刷新 |
| `RETURN_QTY_EXCEEDED` | 退货 / 退库数量超过原单剩余可退量 |
| `RETURN_EXCEEDS_CORRECTED_QTY` | 原出库单被更正后，已确认的退库数量超过新数量，需先调整退库单 |
| `OVER_RECEIPT` | 到货数量超过采购单剩余量，需显式确认超收 |
| `MATERIAL_DUPLICATE` | 物料「类别+名称+规格+品牌」与已有物料重复（忽略大小写与首尾空格） |
| `MATERIAL_CODE_EXISTS` | 物料编码已存在 |
| `MATERIAL_OPENING_LOCKED` | 物料已有期初以外的流水，期初数量 / 单价不可再改 |
| `DB_BUSY` | 并发写冲突（`SQLITE_BUSY`），本次操作未生效，可稍后重试 |
| `SESSION_KICKED` | 该账号已在其它终端登录，旧会话失效（401） |
| `SESSION_REQUIRED` | 令牌不含 `sid` 或会话已撤销，需重新登录（401） |
| `BACKUP_SCHEMA_MISMATCH` | 备份的表 / 列结构或列类型与当前版本不一致，拒绝恢复 |
| `INVALID_BACKUP` | 上传文件不是有效 SQLite 库或不是本系统的备份 |
| `RESTORE_FAILED` | 结构校验通过但数据导入失败（如违反唯一约束），事务已回滚 |
| `AUTO_BACKUP_FAILED` | 自动 / 立即备份执行失败，原因写入 `last_error` 并返回 |
| `CONFIRM_MISMATCH` | 清库 / 恢复的确认短语不正确 |
| `FORBIDDEN` | 非管理员执行管理员操作 |

## 9. 开发约定

- 库存数量与金额只能由 `services/costing.js` 写 `stock_ledger` / `stock_balance`，其他模块不得直接改余额。
- 涉及已有库存与单据状态的写操作必须放在 `tx.immediate()` 事务内，并把状态守卫与库存 / 可退量 / 超收校验一起放进事务；错误统一走 `services/errors.js` 的 `businessError` / `stockBody`，不要直接把 SQLite 原文抛给用户。
- 物料期初只能通过物料保存接口修改，且必须与物料档案同事务调用 `syncOpeningLedger()`；已有非期初流水后期初字段锁定。
- 业务路由只做参数校验、权限校验与事务编排，跨模块计算放到 `services/`。
- 新增接口必须显式加 `requirePerm`；涉及金额的返回必须考虑 `req.canViewPrice`。
- 新增权限动作时同步更新 `MODULE_ACTIONS`，否则用户管理页不会出现该勾选项；新增角色时同步 `ROLE_PERMISSIONS`。
- 新增单据类型时，同步更新 `services/docno.js` 的 `TYPES` / 默认前缀与参数设置中的编号规则校验。
- 数据库结构变更直接改建表语句，不写兼容迁移；`init-db.js` 被 require 时不得产生副作用，直接执行时目标库已存在应拒绝，只有 `--force` 才改名备份后重建。
