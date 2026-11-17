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
| `server/permissions.js` | `ROLE_PERMISSIONS`、`MODULES`、`MODULE_ACTIONS`、`actionsOf`、`grantsOf`、`hasGrant`、`canViewPrice`、`canEditPrice` |
| `server/middleware/auth.js` | `requireAuth`（解析 JWT、校验 `sid` 会话、注入 `req.grants` / `req.canViewPrice`）、`requirePerm`、`publicUser` |
| `server/middleware/audit.js` | 对 `/api` 写操作统一写 `audit_logs` |
| `server/routes/auth.js` | 登录（签发 / 沿用会话）、当前用户、会话心跳、退出、修改密码 |
| `server/routes/users.js` | 用户增删改查、用户级权限保存、`GET /api/permissions/catalog`，保护最后一个管理员 |
| `server/routes/dashboard.js` | 首页看板数据 |
| `server/routes/materials.js` | 物料档案、编码生成、图片上传 / 读取 / 删除、批量新增、CSV 导入预校验 |
| `server/routes/suppliers.js` | 供应商档案、软停用 / 启用、统一下拉数据源 |
| `server/routes/inbound.js` | 入库单（采购入库 / 零星入库 / 采购退货 / 零星退货）及更正重开、整单作废；确认时剔除 0 数量行；退货类单据的读写按 `txn_type` 切换到 `returns` 权限模块 |
| `server/routes/outbound.js` | 出库单（正常出库 / 领料退库）及更正重开、整单作废；领料退库的读写按 `txn_type` 切换到 `returns` 权限模块 |
| `server/routes/returns.js` | 退货退库的只读聚合与原单候选（采购 / 零星 / 出库三组） |
| `server/routes/stock.js` | 库存汇总、物料台账、成本差异查询 |
| `server/routes/query.js` | 查询中心单据 / 领用人 / 分析与全局搜索 |
| `server/routes/stocktake.js` | 盘点建单（全盘 / 按类别 / 按物料盘点）、候选查询、明细追加、录入、确认、行级差异更正 |
| `server/routes/purchase.js` | 采购单、合同、采购明细、到货履历 |
| `server/routes/params.js` | 类别 / 单位 / 去向词库、单据编号规则 |
| `server/routes/settings-ops.js` | 备份包下载 / 恢复、自动备份设置与立即执行、清业务数据、全清、成本差异结转 |
| `server/routes/audit.js` | 系统日志查询、清空全部日志（`audit:delete`，默认只给管理员） |
| `server/utils/search.js` | 关键字搜索统一工具：`kwTokens` 空格分词、`likeTerm` / `kwClause` / `kwClauseExpr` 词间 AND 的 SQL 片段（LIKE 带 `ESCAPE`）、`matchKeywords` 本地匹配；入库 / 出库 / 采购 / 查询中心 / 退货 / 库存 / 盘点与审计均复用 |

### 服务层

| 文件 | 职责 |
| --- | --- |
| `services/units.js` | 定点换算：数量 1e6、单价 1e8、金额 1e2；BigInt 运算与 `ROUND_HALF_UP` 舍入 |
| `services/scaled-db.js` | 包装 `better-sqlite3`：写入前把元 / 数量转成定点整数，查询后按列名把定点整数还原为可读数值 |
| `services/costing.js` | 库存流水与余额的唯一写入口：插入、重排、重算、过账、作废、重建、期初、更正留痕、补价重算（`updateInboundPrices` / `logPriceRecalc`） |
| `services/stock.js` | 可用库存、负库存校验、退库可退量校验、到货核销、库存汇总 |
| `services/docno.js` | 单据编号 `{前缀}-{YYYYMMDD}-{序号}`、编号规则校验、更正号 `-R{n}` |
| `services/session.js` | 单终端登录会话：`issueSession`（同终端沿用 `sid`）、`getSession`、`touchSession`（60 秒内不重复写）、`revokeSession` |
| `services/user-permissions.js` | 用户级授权的规范化、整表覆盖写入、按角色初始化与读取（`admin` 直接返回全量） |
| `services/auto-backup.js` | 自动覆盖式备份：设置读写、到期判断、`VACUUM INTO` 快照、打包 `images/` 与 `manifest.json`、状态查询、启动补跑 |
| `services/backup-package.js` | 备份包（`.zip`）的生成与解包、清单校验、图片目录同步、旧 `.db` 备份兼容 |
| `services/zip.js` | 无第三方依赖的最小 ZIP 读写（仅存储，不压缩） |
| `services/material-images.js` | 物料图片落盘：魔数识别、300KB 上限、按物料 id 命名、替换 / 删除 / 清空 |
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
- 别名校验的坑：换算按**结果列名**匹配，不解析表达式。`SUM(r.qty) AS r` 这类别名不含 `qty` / `amount` 约定时不会被登记，`×1e6` 的原始定点值会直接参与比较或返回（曾导致「已到货数量恒为 0」的误判）。写聚合 SQL 时别名要命中既有定点列名（`qty`、`received_qty`、`order_qty`、`amount` 等），否则需在 JS 侧显式换算；新增别名时同步检查 `scaled-db.js` 的列名判定。

## 4. 数据库表

### 4.1 基础档案与参数

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `params` | `key` PK, `value` | 系统参数。`currency` 恒为 `¥`；`doc_no_rules` 存单据编号规则 JSON |
| `categories` | `id`, `name` UNIQUE, `prefix` | 物料类别 |
| `units` | `id`, `name` UNIQUE | 计量单位 |
| `destinations` | `id`, `name` UNIQUE | 领用去向词库 |
| `materials` | `id`, `code` UNIQUE, `name`, `spec`, `category`, `unit`, `opening_qty`, `opening_price`, `min_stock`, `brand`, `status`, `image_path`, `image_updated_at` | 物料档案；`status='停用'` 不进入库存汇总与新单候选；`image_path` 只存 `materials/<id>.<ext>` 相对路径；「类别+名称+规格+品牌」有唯一索引（去首尾空格、忽略大小写，空值按空串） |
| `suppliers` | `id`, `name` UNIQUE, `contact`, `phone`, `remarks`, `status` | 供应商档案；`status='disabled'` 为软停用，历史单据仍可引用，可重新启用 |
| `users` | `id`, `username` UNIQUE, `password_hash`, `name`, `role`, `status`, `must_change_pwd`, `last_login` | 用户与角色 |
| `user_permissions` | `user_id`, `module`, `action`，`PRIMARY KEY(user_id, module, action)` | 用户级授权；某用户的全部行就是最终授权集合（整表覆盖，不做增量合并） |
| `user_perm_state` | `user_id` PK, `seeded_at` | 标记该用户权限已初始化，避免「全部取消」后在重启时被角色默认值填回 |
| `user_sessions` | `user_id` PK, `sid`, `terminal`, `login_at`, `last_seen`, `ip`, `user_agent` | 单终端登录会话，每用户一行；后登录覆盖 `sid`，旧 token 因 `sid` 不匹配立即失效 |

### 4.2 单据

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `inbound_docs` | `doc_no` PK, `date`, `txn_type`, `supplier`, `handler`, `po_no`, `contract_no`, `status`, `return_tier`, `origin_doc_no`, `return_ref_no`, `return_reason`, `voided_at/by`, `corrects_doc_no`, `corrected_by_doc_no` | 入库单头。`txn_type`：采购入库 / 零星入库 / 采购退货 / 零星退货；零星退货的来源单位读取时由 `origin_doc_no` 派生，不重复落库 |
| `inbound` | `id`, `date`, `grn_no`, `code`, `qty`, `price`, `amount`(生成列), `supplier`, `handler`, `po_no`, `contract_no`, `txn_type`, `doc_no`, `status`, `order_line_id`, `origin_line_id` | 入库明细行 |
| `inbound_doc_logs` | `id`, `doc_no`, `action`, `operator`, `detail`, `detail_json` | 入库单操作日志 |
| `outbound_docs` | `doc_no` PK, `date`, `txn_type`, `destination`, `receiver`, `handler`, `status`, `origin_doc_no`, `return_reason`, `voided_at/by`, `corrects_doc_no`, `corrected_by_doc_no` | 出库单头。`txn_type`：正常出库 / 领料退库 |
| `outbound` | `id`, `date`, `gin_no`, `code`, `qty`, `destination`, `receiver`, `handler`, `cost_price`, `cost_amount`(生成列), `txn_type`, `doc_no`, `status`, `origin_line_id` | 出库明细行；`cost_price` 由成本核算回写 |
| `outbound_doc_logs` | 同 `inbound_doc_logs` | 出库单操作日志 |
| `purchase_orders` | `id`, `po_no` UNIQUE, `date`, `supplier`, `contract_no`, `project`, `expected_date`, `remarks`, `manual_status`, `status` | 采购单头；`contract_no` 仅作明细默认合同；`modify` 保存只改业务字段，不改 `status` |
| `order_lines` | `id`, `po_no`, `code`, `order_qty`, `order_price`, `order_amount`(生成列), `contract_no`, `remarks` | 采购明细；合同真实归属以此列优先 |
| `contracts` | `id`, `contract_no` UNIQUE, `name`, `supplier`, `sign_date`, `amount`, `status`, `remarks` | 采购合同档案 |

### 4.3 盘点与调整

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `stocktakes` | `id`, `stocktake_no` UNIQUE, `date`, `status`, `category_filter`, `load_scope`, `handler`, `confirmed_at` | 盘点单头 |
| `stocktake_lines` | `id`, `stocktake_no`, `code`, `book_qty`, `count_qty`, `diff_qty`, `status`, `remarks`，`UNIQUE(stocktake_no, code)` | 盘点行；`book_qty` 为创建时账面快照，`count_qty=NULL` 表示未盘 |
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
- 动作集合见 `MODULE_ACTIONS`：业务单据模块统一按业务动作划分。入库 / 出库 / 退货退库为 `view/manage/delete/correct/void/post`：`manage`＝建档/编辑草稿（建单、改单头、明细增行/改行/删行），`delete`＝整单删除（仅草稿整张单），`correct`＝更正整条链路（发起→编辑更正草稿→确认生效），`void`＝零行确认的整单作废，`post`＝草稿态首次确认过账。盘点为 `view/manage/delete/correct/post`（无整单作废）；采购为 `view/manage/delete/modify/post`（无更正、作废，`modify`＝修改已确认单，保存后仍为已确认）。`confirm-correction` 在中间件里按草稿明细数选择动作，失败返回 `CORRECT_FORBIDDEN` / `VOID_FORBIDDEN`。
- 退货与退库没有自己的写路由：采购退货 / 零星退货落在入库端点、领料退库落在出库端点，但入口中间件按 `txn_type` 把权限模块切到 `returns`，写操作只校验 `returns:manage/delete/correct/void/post`，不再叠加 `inbound` / `outbound`。对应只读接口（详情 / 更正信息 / 下一单号 / 可退量）对退货类单据放行 `returns:view`。
- 明细行的新增 / 修改 / 删除统一归所属模块的 `manage`（采购已确认单除外，见下条；`delete` 只删整张草稿单），`manage` 同时放行建单时一次性提交明细；不允许用建单相关动作越权改已有单据的明细。入库 / 出库的 `PUT .../lines` 归 `manage`（更正草稿可用 `correct` / `void`），盘点增删行与保存实盘归 `stocktake:manage`。
- 采购单按状态分流：草稿单的表头与明细增改删走 `purchase:manage`；已确认单的同一批端点（`PUT /orders/:poNo`、`POST /lines`、`POST /lines/batch`、`PUT/DELETE /lines/:id`）改走 `purchase:modify`，无该位返回 403 `PERM_PURCHASE_MODIFY`。`PUT /orders/:poNo` 不修改 `status`；已确认单保存后若明细为 0 行返回 `PO_LAST_LINE`，数量低于已到货返回 `PO_QTY_BELOW_RECEIVED`；明细行删除同样受已到货与「至少一行」约束。价格填写仍由 `requirePriceEdit` 把关，不额外新增权限位。
- 更正草稿的明细保存（`PUT .../lines`）按 `correct` 或 `void` 任一放行（`manage` 也放行普通草稿），与前端「更正草稿看 correct 或 void、普通草稿看 manage」一致；`void` 可单独授予，保证只有作废权的账号能删空明细后零行确认。
- `/api/materials` 是单据「添加明细」的基础数据源：任一业务单据模块（inbound / outbound / returns / purchase / stocktake）有 `view` 即可读取，价格仍按 `price.view` 脱敏；否则只有建档编辑权的账号进不了编辑页（与 `/api/suppliers/options` 的放宽方式一致）。
- 系统日志清空使用独立权限位 `audit:delete`，默认只给管理员；备份、恢复、自动备份、清库、成本差异结转仍是 `role === 'admin'` 的运维例外。
- 开发阶段不做历史数据迁移与权限回填，也不保留旧库兼容分支：建表语句一次到位，升级时清库重建；权限默认值以 `ROLE_PERMISSIONS` 当前定义为准，已初始化用户的授权以库中记录为准。
- `requireAuth` 解析 `Authorization: Bearer <token>`，查库确认用户存在且 `status='active'`，再比对 `user_sessions.sid`：缺 `sid` 或会话已撤销返回 `SESSION_REQUIRED`，`sid` 不一致返回 `SESSION_KICKED`。通过后挂载 `req.user`、`req.sessionSid`、`req.grants`、`req.canViewPrice`。
- 用户管理页通过 `GET /api/permissions/catalog` 取模块 / 动作全集与各角色默认值，`PUT /api/users/:id` 提交 `permissions` 时整表覆盖；`users` 模块本身不可勾选，避免非管理员获得用户管理入口。
- `canViewPrice` / `canEditPrice` 由 `priceGranted` 统一判定：`admin` 恒为真，其余按用户授权表里的 `price:view` / `price:edit` 决定（角色默认值见 `ROLE_PERMISSIONS`）；两项独立、互不蕴含。鉴权中间件把结果挂到 `req.canViewPrice` / `req.canEditPrice`。无价格查看权的接口必须删除价格键（`price`、`amount`、`cost_price`、`cost_amount`、`total_amount`、`unit_cost`、`avg_cost`、`stock_value` 等），不能只依赖前端隐藏；无 `price:edit` 的账号提交价格字段会被写接口拒绝（`PRICE_EDIT_FORBIDDEN`）。
- 涉及已有库存与单据状态的写路径（过账、更正 / 作废、盘点确认、物料期初修改）统一用 `tx.immediate()`（`BEGIN IMMEDIATE`）：状态守卫、库存 / 可退量 / 超收校验与写流水在同一临界区；新物料建档这类没有并发争用的首次写入仍可用普通事务。`SQLITE_BUSY` 由 `services/errors.js` 转成 `DB_BUSY`。
- `auditMiddleware` 记录 `/api` 写操作；设置页运维接口在自身路由内写审计，并把备份文件名等写入 `detail`。采购已确认单的修改（表头与明细）由路由显式写审计并跳过通用摘要，`detail` 直接列出变更字段（如「供应商：A → B；修改明细 X：数量 1 → 2」）；单价只记「已调整」，不在日志里落金额。

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
| GET | `/api/materials`、`/api/materials/next-code`、`/api/materials/import-template` | `materials:view` |
| POST / PUT / DELETE | `/api/materials`、`/api/materials/:code` | `materials:create/edit/delete` |
| POST | `/api/materials/batch` | `materials:create`；批量新增，整批校验通过才写入 |
| POST / DELETE | `/api/materials/:code/image` | `materials:edit`；上传（octet-stream，魔数校验） / 删除参考图 |
| GET | `/uploads/materials/:name` | 登录；物料图片静态读取 |
| GET | `/api/suppliers`、`/api/suppliers/options` | `suppliers:view`；`options` 另允许 `purchase:view` / `inbound:view` / `returns:view` |
| POST | `/api/suppliers` | `suppliers:create` |
| PUT/DELETE | `/api/suppliers/:id` | `suppliers:edit/delete`；DELETE 为软停用 |
| POST | `/api/suppliers/:id/enable` | `suppliers:edit`；重新启用 |
| GET | `/api/params` | 登录 |
| POST | `/api/params/:type` | `settings:create` |
| DELETE | `/api/params/:type/:id` | `settings:delete` |
| PUT | `/api/params/doc-no-rules` | `settings:edit` |

`/api/params/:type` 的 `type` 为 `categories` / `units` / `destinations`。

### 入库

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/inbound-docs`、`/api/inbound-docs/next-no` | `inbound:view` |
| POST | `/api/inbound-docs` | 普通入库 `inbound:manage`；采购退货 / 零星退货 `returns:manage` |
| GET | `/api/inbound-docs/:docNo`、`/:docNo/correction-info` | `inbound:view` |
| PUT | `/api/inbound-docs/:docNo/lines` | 普通入库 `inbound:manage`；退货单 `returns:manage`；更正草稿可用同模块的 `correct` 或 `void` 替代 |
| POST | `/api/inbound-docs/:docNo/confirm` | 普通入库 `inbound:post`；退货单 `returns:post` |
| POST | `/api/inbound-docs/:docNo/correction` | 普通入库 `inbound:correct` 或 `inbound:void`；退货单 `returns:correct` 或 `returns:void` |
| POST | `/api/inbound-docs/:docNo/confirm-correction` | 有明细 `correct`、零行 `void`（按单据所属模块：入库 / 退货） |
| DELETE | `/api/inbound-docs/:docNo` | 普通入库 `inbound:delete`；退货单 `returns:delete` |

价格字段（`price`）另受 `price:edit` 约束：`PUT /:docNo/lines` 与 `POST /:docNo/correction` 在请求体带 >0 价格键时，账号必须拥有 `price:edit`，否则返回 `PRICE_EDIT_FORBIDDEN`。普通退货单（非更正草稿）跳过该校验（单价由原单带出、页面锁定）；退货**更正草稿**仍走校验（硬带价格会被拒），但服务端不接受其提交单价，一律沿用原行价。只有**零星入库**的更正草稿会采用提交单价（`deriveCorrectionLine` 的 `allowPrice`），其余类型（采购入库 / 两类退货）即使带价格也被忽略；前端 `ibEditPriceVisible()` 对这些类型不提交 `price`。

### 出库

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/outbound-docs`、`/api/outbound-docs/next-no` | `outbound:view` |
| POST | `/api/outbound-docs` | 正常出库 `outbound:manage`；领料退库 `returns:manage` |
| GET | `/api/outbound-docs/:docNo`、`/:docNo/returnable`、`/:docNo/correction-info` | `outbound:view` |
| PUT | `/api/outbound-docs/:docNo/lines` | 正常出库 `outbound:manage`；领料退库 `returns:manage`；更正草稿可用同模块的 `correct` 或 `void` 替代 |
| POST | `/api/outbound-docs/:docNo/confirm` | 正常出库 `outbound:post`；领料退库 `returns:post` |
| POST | `/api/outbound-docs/:docNo/correction` | 正常出库 `outbound:correct` 或 `outbound:void`；领料退库 `returns:correct` 或 `returns:void` |
| POST | `/api/outbound-docs/:docNo/confirm-correction` | 有明细 `correct`、零行 `void`（按单据所属模块：出库 / 退货） |
| DELETE | `/api/outbound-docs/:docNo` | 正常出库 `outbound:delete`；领料退库 `returns:delete` |

### 退货退库

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/returns/docs`、`/api/returns/docs/:docNo` | `returns:view` |
| GET | `/api/returns/purchase/origins`、`/origin-lines` | `returns:view` |
| GET | `/api/returns/misc/origins`、`/origin-lines` | `returns:view`；零星退货原单候选 |
| GET | `/api/returns/purchase/scope-options`、`/scope-lines` | `returns:view` |

退货退库为只读聚合接口；实际的采购退货、零星退货写入走入库路由，领料退库写入走出库路由，但权限归属统一为 `returns`（建单 / 改明细 / 删除整单 / 过账 / 更正 / 作废分别对应 `manage/manage/delete/post/correct/void`），不再要求入库 / 出库权限；原单候选只返回已过账且仍有可退量的单据。

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
| POST | `/api/stocktakes` | `stocktake:manage`；只建单 |
| DELETE | `/api/stocktakes/:no` | `stocktake:delete`；只删整张草稿 |
| POST | `/api/stocktakes/:no/lines` | `stocktake:manage`；草稿加物料行 |
| PUT | `/api/stocktakes/:no/lines` | `stocktake:manage`；保存实盘数量 |
| DELETE | `/api/stocktakes/:no/lines/:id` | `stocktake:manage`；草稿移除物料行 |
| POST | `/api/stocktakes/:no/confirm` | `stocktake:post` |
| POST | `/api/stocktakes/:no/lines/:id/correct` | `stocktake:correct`；已确认单的行级差异更正 |

### 采购管理

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/purchase/orders`、`/orders/next-no`、`/orders/:poNo` | `purchase:view` |
| POST | `/api/purchase/orders` | `purchase:manage` |
| PUT | `/api/purchase/orders/:poNo` | 草稿 `purchase:manage`；已确认 `purchase:modify`；保存不改状态，至少保留一行（`PO_LAST_LINE`）；已确认单改价时级联下游并返回 `price_sync` |
| POST | `/api/purchase/orders/:poNo/confirm` | `purchase:post` |
| DELETE | `/api/purchase/orders/:poNo` | `purchase:delete`；仅草稿可删，已确认返回 `PO_NOT_DRAFT` |
| POST | `/api/purchase/lines/batch`、`/api/purchase/lines` | 草稿 `purchase:manage`；已确认 `purchase:modify`；建单时一次性带明细同样走 `purchase:manage` |
| PUT/DELETE | `/api/purchase/lines/:id` | 草稿 `purchase:manage`；已确认 `purchase:modify`；已到货行不可删、数量不得低于已到货（`PO_QTY_BELOW_RECEIVED`），已确认单删到 0 行返回 `PO_LAST_LINE` |
| GET | `/api/purchase/lines`、`/lines/:id/inbound`、`/lines/by-po/:poNo`、`/lines/by-contract/:contractNo` | `purchase:view` |
| GET | `/api/purchase/pending-orders`、`/inbound-sources`、`/inbound-scope-lines` | `purchase:view` |
| GET | `/api/purchase/contracts`、`/contracts/:contractNo` | `purchase:view` |
| POST | `/api/purchase/contracts` | `purchase:manage` |
| PUT/DELETE | `/api/purchase/contracts/:contractNo` | `purchase:manage/delete` |

### 运维与日志

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/settings/backup/download` | 仅 `admin`；默认导出含库与图片的 `.zip` 备份包 |
| POST | `/api/settings/backup/restore` | 仅 `admin`；支持 `.zip` 与旧 `.db`，结构不一致返回 `BACKUP_SCHEMA_MISMATCH` |
| GET/PUT | `/api/settings/backup/auto` | 仅 `admin`；读取 / 保存自动覆盖式备份设置 |
| POST | `/api/settings/backup/auto/run` | 仅 `admin`；立即覆盖 `backups/auto-backup-latest.zip` |
| POST | `/api/settings/cost-variance/settle` | 仅 `admin` |
| POST | `/api/settings/data/clear-business` | 仅 `admin` |
| POST | `/api/settings/data/reset` | 仅 `admin` |
| GET | `/api/dashboard` | `dashboard:view` |
| GET | `/api/audit-logs` | `audit:view` |
| DELETE | `/api/audit-logs` | `audit:delete`（默认只给管理员）；清空全部日志并保留一条本次清空记录 |

## 7. 前端组织

- `public/index.html` 按编号顺序加载 `00-i18n.js` 至 `14-connection.js`，全部挂到全局 `window.App`；同时通过 CDN 引入 Chart.js 4 用于看板图表。
- `public/login.html` 是独立登录页，加载 `public/css/base.css`、`components.css`、`theme-dark.css`，登录样式写在页内 `<style>`；登录成功后把 token 与用户信息写入 `localStorage`，并跳转 `/` 进入 SPA。登录时会带上 `localStorage.terminal_id`（首次登录生成并复用），用于区分终端：同一浏览器的多标签共享同一终端，不互相挤下线。
- `01-core.js` 负责：读取 / 保存 token、统一 `api()` 请求与 401 处理、hash 路由、`can(module, action)` / `canViewPrice` 前端判定、登录页，以及状态徽标与业务类型徽标的单一映射（`docStatusMeta`、`docTypeBadgeClass`、`statusBadge`、`docStatusBadge`）。
- 会话过期保留草稿：401 / 被挤下线前把当前页表单值按 hash 写入 `sessionStorage`（`wms_session_draft`，24 小时内有效），重新登录后回到原 hash 并回填未提交字段，回填成功即清除草稿。
- `02-ui-kit.js` 提供通用表格、弹窗、Toast、分页、单据打印与 CSV 导出（UTF-8 BOM，Excel 中文不乱码）；表头排序按列类型传 `align`（数字右对齐、状态 / 类型 / 操作居中），单元格 `nowrap`，日期与时刻统一走 `fmtDateTime` / `fmtDocDate`，业务日期显示到分钟。
- 公共 UI 只有一份实现：分页条 `puPagerHtml(tableId, total, totText, opts)`（`opts.ns` 走事件委托、`opts.selId` 指定每页条数 select、`opts.pgClick` 指定翻页方法、`opts.hideEmpty` 总数为 0 时不输出）与 `pinPager(boxId)`；单据状态徽标 `docStatusBadge(kind, status)`；表格空行 `emptyRow` 与区块空态 `emptyState`；HTML 转义 `docEsc`；确认弹窗 `confirmDialog`；前端关键字筛选 `filterByKeywords` / `matchKeywords`。各模块不再各写一套。
- 弹窗同一时间只保留一个实例，右上角可最大化 / 还原；行级校验用 `flagFieldError` / 行内提示定位到具体输入框，不再只弹整屏 toast。分页统一在 `puPagerHtml` / `onPage` 内夹住页码（`page <= 0`、超出总页数都回落到有效页），查询中心与各单据列表共用。
- 列表吸顶与吸底：`thead th` 为 `position: sticky`，滚动容器固定为 `.page-body`；`.pu-split .data-scroll` 在宽屏改为 `overflow: visible`，页面内不再给列表叠加内联 `overflow-x`（嵌套滚动会让表头吸顶失效）。分页条由 `pinPager` 按「内容是否超出一屏」切换 `.pin` → `position: sticky; bottom: 0`；窗口尺寸变化后重新计算。库存查询、单据查询、领用人查询与各单据列表同一套做法。
- 关键字搜索：服务端统一 `server/utils/search.js`——空格分词、词间 AND，`kwClause(fields, q, {escape:true})` 生成带 `ESCAPE '\'` 的 LIKE 子句，`kwClauseExpr` 用于子查询谓词，`matchKeywords` 用于已加载集合；前端只保留 `filterByKeywords(data, keywords, fields)` 一个入口，规则与后端一致（大小写不敏感、词间 AND）。分页列表走服务端筛选，已缓存的候选集合走本地筛选。
- 可搜索下拉统一走 `searchableSelect`：输入即过滤、键盘上下选择、支持「历史值 / 已停用」标记；物料类别、单位与供应商下拉共用同一实现。
- 物料批量新增 / 导入共用可搜索下拉与逐行错误标注；导入仅 CSV（UTF-8 / GBK / GB18030，Excel 文件提示另存为 CSV），先预览后写入；批量新增单次上限 500 行。
- `05-inbound.js`：0 数量行在保存时保留、确认时由服务端剔除并删除；行级错误按 `line_id` 定位到物料 / 数量单元格；更正草稿的编辑入口看 `correct` 或 `void`、普通草稿看 `edit`，零行确认前若没有 `void` 直接拦截并提示。
- `06-outbound.js`：确认前用当前 `stock_balance` 做库存预校验并展示缺口；再按当前均价重算成本，差异弹二次确认；两处都确认后才调确认接口；更正草稿与作废的判定与入库一致，详情「退库」入口只需 `returns:create`。
- `10-purchase.js`：供应商 / 合同号可后补，保存后刷新下游单；明细单价输入与展示统一两位小数；订购数量低于已到货时按行定位报错。
- `11-stocktake.js`：新建弹窗内一次选定范围（全盘 / 按类别 / 按物料盘点）并直接生成明细进入录入页，进入后不再切换范围；按物料盘点为「即时搜索 + 点击候选加入已选列表」，与追加物料共用同一候选项组件；右侧实盘面板顶部常驻动作条（行数 / 已盘 / 差异 / 录入 / 只显示未盘 / 批量填 0 / 确认）；未保存行有独立徽标；确认弹窗展示差异表并允许直接改实盘；已确认行可「更正此差异」。
- `12-audit.js`：「对象」列由 `auditTargetLabel` 输出业务名，参数类显示「参数：类别-名称」；详情优先渲染结构化摘要。
- `13-returns.js`：新建统一从原单发起，采购 / 零星 / 领料退库三组候选分别取对应接口；无可退量时入口置灰并说明原因。
- `09-admin.js` 用户管理页从 `/api/permissions/catalog` 渲染模块动作勾选面板（`perm_<action>` 文案，`void` 为「作废 / Void」，`audit.delete` 复用「删除 / Delete」），`admin` 行只读；保存时随用户一起提交 `permissions`。
- 各业务脚本以 `App.xxx` 方法扩展，页面刷新通过 hash 路由重渲染，不做组件级状态管理。
- `14-connection.js` 负责「前端如何感知自己还能不能用」：轮询 `/api/health` 判断服务器是否可达（顶部横幅提示，恢复后自动消失并按需重渲染当前页），轮询 `/api/auth/session` 及时发现被其它终端挤下线（弹窗提示，不静默跳登录页）。
- 导航固定为五个分组：概览、业务办理、查询分析、基础资料、系统管理（`01-core.js` 的 `renderSidebar`），按 `view` 权限过滤。
- 主题切换只改 `data-theme` 并调用 `repaintChartsTheme()` 就地改图表文字 / 网格色，不重渲染页面，正在编辑的单据、已选详情与滚动位置都保持原样。
- 语言切换必须重渲染文案，走「快照 → 渲染 → 恢复」：`captureViewState()` 记录当前页、子视图与表单值、滚动位置；入库 / 出库 / 盘点 / 采购通过 `viewHook()` 登记各自的 `capture*View` / `restore*View`，重建编辑页后回填明细与已填内容；`applyScrollPositions` 在下一帧再对齐一次。停留在 body 上的弹窗不会被重建，已填值保留，但文案要重新打开后才更新。
- 操作完成后的跳转按业务归属：采购退货 / 零星退货确认、更正、作废后回「退货与退库」对应页签，领料退库回「退货与退库 · 领料退库」，正常入库 / 出库回各自模块详情；不再跳到不展示该单据的入库 / 出库列表。
- 语言切换后文本统一走 `t('key')`，中英词典 key 必须一一对应，新增文案需同时补两份。
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
| `PERM_FORBIDDEN` | 通用权限不足（中间件按模块 / 动作判定） |
| `CORRECT_FORBIDDEN` / `VOID_FORBIDDEN` | 更正草稿有明细时缺少 `correct` / 零行整单作废时缺少 `void` |
| `ORIGIN_DOC_REQUIRED` / `ORIGIN_DOC_NOT_FOUND` | 未选择原单 / 原单不存在 |
| `ORIGIN_DOC_INVALID` / `ORIGIN_DOC_NOT_POSTED` | 原单类型不匹配 / 原单未过账或已作废 |
| `RETURN_TIER_REQUIRED` | 采购退货未提供有效关联档位 |
| `RETURN_PRICE_MISMATCH` | 退货明细单价未继承原入库行价格 |
| `NO_LINES` / `NO_QTY_LINES` | 单据没有明细行 / 确认时 0 数量行被剔除后没有有效行 |
| `PO_QTY_BELOW_RECEIVED` | 采购明细订购数量小于已到货数量 |
| `NO_DIFF` | 盘点行账面与实盘一致，无需生成更正 |
| `STOCK_CHANGED` | 盘点确认时创建时账面快照与当前账面不一致，需 `force=true` 确认以实盘为准 |
| `RETURN_EXCEEDS_CORRECTED_QTY` | 原出库单被更正后，已确认的退库数量超过新数量，需先调整退库单 |
| `OVER_RECEIPT` | 到货数量超过采购单剩余量，需显式确认超收 |
| `MATERIAL_DUPLICATE` | 物料「类别+名称+规格+品牌」与已有物料重复（忽略大小写与首尾空格） |
| `MATERIAL_CODE_EXISTS` | 物料编码已存在 |
| `MATERIAL_CODE_CONFLICT_STOCKTAKE` | 改编码时与同一盘点单中的已有明细冲突 |
| `MATERIAL_IN_USE` | 物料已被单据 / 流水引用，不能删除 |
| `MATERIAL_OPENING_LOCKED` | 物料已有期初以外的流水，期初数量 / 单价不可再改 |
| `IMAGE_EMPTY` / `IMAGE_TOO_LARGE` / `IMAGE_TYPE_INVALID` | 图片为空 / 超过 300KB / 不是 JPEG、PNG、WebP |
| `DB_BUSY` | 并发写冲突（`SQLITE_BUSY`），本次操作未生效，可稍后重试 |
| `SESSION_KICKED` | 该账号已在其它终端登录，旧会话失效（401） |
| `SESSION_REQUIRED` | 令牌不含 `sid` 或会话已撤销，需重新登录（401） |
| `BACKUP_SCHEMA_MISMATCH` | 备份的表 / 列结构或列类型与当前版本不一致，拒绝恢复 |
| `BACKUP_IMAGES_NOT_INCLUDED` | `.db` 备份引用了物料图片但未附带图片目录，需改用 `.zip` 备份包 |
| `BACKUP_IMAGE_MISSING` | 备份包清单中的图片在包内缺失 |
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
- 新增关键字筛选时统一复用 `server/utils/search.js`：SQL 用 `kwClause` / `kwClauseExpr` 并带 `escape: true`，已加载集合用 `matchKeywords`；前端统一走 `filterByKeywords`，不要再写内联分词或裸 `LIKE`。
- 列表页不要给表格外层加内联 `overflow-x`；横向滚动交给 `.table-wrap` / `.data-scroll`，否则会形成嵌套滚动容器，导致 `thead th` 吸顶与 `pinPager` 吸底失效。
- 采购单保存的供应商 / 合同号后补必须放在同一事务内调用级联同步：先刷新入库单单头，再按 `order_line_id` 刷新入库明细，最后回填退货单头与退货明细；供应商按采购单当前值原样同步，合同号只在采购单有值时覆盖。
- 采购单改价的级联写在 `server/routes/purchase.js` 的 `syncPoPriceChanges()`（不另建服务文件）：草稿入库单直改 `inbound.price`，已过账入库单交给 `costing.updateInboundPrices()` 改 `stock_ledger.unit_cost` 并从最早受影响序号重算，退货明细按 `origin_line_id` 跟随。`PUT /api/purchase/orders/:poNo` 与 `PUT /api/purchase/lines/:id` 都会在事务内先取改前快照、再比对单价，响应带 `price_sync`；审计动作 `price-recalc` 与 `inventory_recalc_logs` 的 `price-recalc` / `cost-change` 两类记录见 `docs/costing.md`。
- 新增聚合查询时检查结果列名是否被 `scaled-db.js` 识别，未登记的别名校验会导致定点原值参与比较（详见第 3 节）。
- 行级校验错误返回可定位的 `line_id` / `code`，前端用 `flagFieldError` 标注到具体单元格；不要只返回整单错误文案。
- 涉及图片的运维路径（恢复、全清）必须同时处理 `uploads/materials/`，备份导出默认打包图片，避免恢复后档案有路径无文件。
- 新增接口必须显式加 `requirePerm`；涉及金额的返回必须考虑 `req.canViewPrice`。
- 新增权限动作时同步更新 `MODULE_ACTIONS` 与 `ROLE_PERMISSIONS`，并在 `00-i18n.js` 补中英文案：通用动作用 `perm_<action>`，语义随模块不同的动作用 `perm_<module>_<action>`（如 `perm_stocktake_edit`），否则用户管理页会显示 key 或语义不清。开发阶段不做权限回填与迁移，默认值以当前 `ROLE_PERMISSIONS` 为准，升级时清库重建。
- 新增单据类型时，同步更新 `services/docno.js` 的 `TYPES` / 默认前缀与参数设置中的编号规则校验。
- 数据库结构变更直接改建表语句，不写兼容迁移；`init-db.js` 被 require 时不得产生副作用，直接执行时目标库已存在应拒绝，只有 `--force` 才改名备份后重建。
