# 库存进出库管理系统（warehouse_cn）

面向单体仓库 / 小型仓储团队的进出库与库存核算系统。后端提供 REST API，前端为无构建步骤的原生单页应用，数据落在本地 SQLite 文件中，适合在内网或单机部署。

主要能力：

- 入库：采购入库、零星入库、采购退货、零星退货
- 出库：正常出库（含领用人、领用去向）
- 退货与退库：统一从原单发起（采购 / 零星 / 领料），领料退库另保留无原单入口
- 盘点：弹窗内选范围并自动载入、右侧面板录入、差异确认与已确认行级更正
- 采购管理：采购单、合同、采购明细、到货履历与到货核销，供应商 / 合同号支持后补
- 库存核算：移动加权平均成本、库存流水台账、成本差异台账与期末结转
- 查询中心：库存查询、单据查询、领用人查询、库存分析（ABC / 周转率 / 呆滞）
- 系统管理：用户与角色、按用户勾选的模块权限、参数与单据编号规则、系统日志、自动备份、备份 / 恢复 / 清库

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js |
| Web 框架 | Express 4 |
| 数据库 | SQLite（`better-sqlite3`，WAL 模式） |
| 认证 | JWT（`jsonwebtoken`），密码哈希 `bcryptjs` |
| 前端 | 原生 HTML / CSS / JavaScript，`window.App` 单对象组织，无打包工具 |
| 图表 | Chart.js 4（`public/index.html` 通过 CDN 引入） |
| 国际化 | `public/js/00-i18n.js` 内置中英双语词典 |

数值统一使用整数定点存储：数量 `1e6`、单价 `1e8`、金额 `1e2`（分）。详见 [成本核算规则](docs/costing.md)。

## 快速开始

```bash
# 1. 配置环境变量
#    Windows: copy .env.example .env
#    macOS/Linux: cp .env.example .env
#    然后填写 JWT_SECRET（至少 32 个字符）
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 2. 安装依赖
npm install

# 3. 启动（首次启动会自动建表并创建初始管理员）
npm start
```

默认访问地址：`http://localhost:4000`。服务启动时会同时打印可用的局域网地址。

`npm run init-db` 是首次安装时的一次性初始化脚本，用于创建基础表、索引并导入种子字典；正常启动时 `server/db.js` 也会自动完成首次建库，因此通常不是必须步骤。目标库已存在时脚本默认拒绝执行、不会改动任何数据；确需重建请执行 `npm run init-db -- --force`（旧库会先整体备份为 `.bak-时间戳`，不会删除）。

### 环境变量

配置读取逻辑见 `server/config.js`，进程环境变量优先于 `.env` 文件。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `JWT_SECRET` | 是 | 无 | JWT 签名密钥，长度不足 32 个字符时服务拒绝启动 |
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `PORT` | 否 | `4000` | 监听端口 |
| `DB_PATH` | 否 | 项目根目录 `inventory.db` | SQLite 文件路径；WAL 在 U 盘 / 网络盘报 I/O 错误时可指向本机磁盘 |
| `BACKUP_DIR` | 否 | 项目根目录 `backups/` | 备份快照目录 |
| `INITIAL_ADMIN_USERNAME` | 否 | `admin` | 首次创建的管理员用户名 |
| `INITIAL_ADMIN_PASSWORD` | 否 | `admin123` | 首次创建的管理员密码 |

### 默认账号

- 用户名：`admin`
- 密码：`admin123`
- 首次登录强制修改密码（`users.must_change_pwd = 1`）

生产环境请通过 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 覆盖默认值，或在首次登录后立即改密。

## 目录结构

```
warehouse_cn/
├─ server.js                  # 后端入口：配置校验、中间件、路由挂载、静态资源、启动
├─ init-db.js                 # 可选的一次性建表 / 种子导入脚本
├─ server/
│  ├─ config.js               # 环境变量与默认配置
│  ├─ db.js                   # 数据库连接、建表与唯一索引、初始管理员与用户默认授权
│  ├─ permissions.js          # 角色默认矩阵、模块动作全集、hasGrant、canViewPrice
│  ├─ middleware/
│  │  ├─ auth.js              # JWT 鉴权、sid 会话校验、requirePerm、req.canViewPrice 注入
│  │  └─ audit.js             # /api 写操作审计埋点
│  ├─ routes/                 # 各业务 REST 路由（见下文「接口」）
│  └─ services/
│     ├─ units.js             # 定点数值换算与舍入
│     ├─ scaled-db.js         # SQLite 定点数读写自动换算
│     ├─ costing.js           # 成本核算与库存流水（唯一写入口）
│     ├─ stock.js             # 可用库存、负库存校验、到货核销、库存汇总
│     ├─ session.js           # 单终端登录会话：签发 / 查询 / 心跳 / 撤销
│     ├─ user-permissions.js  # 用户级授权的读取、覆盖写入与角色默认初始化
│     ├─ auto-backup.js       # 自动覆盖式备份（每小时 / 每天 / 每周）
│     ├─ backup-package.js    # 备份包（.zip，含库、图片、清单）生成与恢复校验
│     ├─ zip.js               # 无第三方依赖的最小 ZIP 读写
│     ├─ material-images.js   # 物料图片落盘、类型与体积校验
│     ├─ docno.js             # 单据编号与更正修订号
│     ├─ price-mask.js        # 无价格权限时的字段脱敏
│     ├─ errors.js            # 写路径业务码与 SQLITE_BUSY 统一出口
│     ├─ audit.js             # 审计日志写入
│     ├─ logdetail.js         # 单据操作日志
│     ├─ sign.js              # 单据操作签名 / 留痕辅助
│     └─ time.js              # 时间处理辅助
├─ public/
│  ├─ index.html              # SPA 入口（加载 css/ 与 js/ 编号脚本）
│  ├─ login.html              # 独立登录页（加载 css/ 主题 + 页内登录样式）
│  ├─ js/                     # 按编号顺序加载的前端脚本
│  └─ css/                    # base / components / pages / theme-dark
├─ uploads/materials/         # 运行时生成：物料参考图片
└─ backups/                   # 运行时生成：备份包与危险操作前的自动快照
```

### 前端脚本职责

| 文件 | 职责 |
| --- | --- |
| `00-i18n.js` | 中英词典与 `t()` 翻译 |
| `01-core.js` | `App` 初始化、登录态、API 请求、hash 路由、权限判断 |
| `02-ui-kit.js` | 通用组件、弹窗、可搜索下拉、分页加固、单据打印与 CSV 导出 |
| `03-dashboard.js` | 首页看板 |
| `04-materials.js` | 物料档案、参考图片、批量新增与 CSV 导入 |
| `05-inbound.js` | 入库（采购入库 / 零星入库 / 采购退货 / 零星退货） |
| `06-outbound.js` | 出库（含确认前库存预校验与成本差异二次确认） |
| `07-stock.js` | 查询中心四个板块、全局搜索、详情卡 |
| `08-orders.js` | 基础资料与运维：供应商档案、参数设置、自动备份、备份包下载 / 恢复 / 清库、成本差异结转 |
| `09-admin.js` | 用户管理与按用户的模块授权 |
| `10-purchase.js` | 采购单、合同、采购明细 |
| `11-stocktake.js` | 盘点（范围载入、右侧面板录入、差异确认、行级更正） |
| `12-audit.js` | 系统日志 |
| `13-returns.js` | 退货与退库（统一从原单发起） |
| `14-connection.js` | 服务器断开提示（顶部横幅）、登录会话心跳与「被其它终端挤下线」提示 |

样式文件：`base.css`（基础与变量）、`components.css`（通用组件）、`pages.css`（页面与查询中心样式包）、`theme-dark.css`（深色主题）。

## 功能模块

| 模块 | 说明 |
| --- | --- |
| 入库 | 采购入库、零星入库、采购退货、零星退货；明细行支持采购单 / 合同关联，0 数量行确认时剔除 |
| 出库 | 正常出库；记录领用人、领用去向、经手人，确认前做库存与成本差异预检 |
| 退货退库 | 采购 / 零星 / 领料退库统一从原单发起；领料退库另保留无原单入口 |
| 盘点 | 弹窗选范围自动载入、右侧面板录入、差异确认，已确认行可单独更正 |
| 采购管理 | 采购单、合同、采购明细、到货履历；供应商 / 合同号后补会级联同步下游单据 |
| 查询中心 | 库存查询、单据查询、领用人查询、库存分析；分页越界自动夹取 |
| 参数设置 | 类别 / 单位 / 去向词库、单据编号规则、自动备份、备份包恢复、清库、成本差异结转 |
| 系统管理 | 用户与按用户授权的权限、系统审计日志（对象列显示业务名，支持清空日志） |

单据状态机（`draft → posted → voided`）、作废与更正重开的业务规则见 [业务说明](docs/business.md)。

## 权限与价格脱敏

- 角色：`admin`（管理员）、`manager`（主管）、`operator`（操作员）、`viewer`（只读）。
- 权限粒度为「模块 + 动作」。授权以数据库为准：`user_permissions` 存每个用户的最终授权集合，`user_perm_state` 标记该用户已初始化；角色矩阵（`server/permissions.js` 的 `ROLE_PERMISSIONS`）只在建号或改角色时提供默认值。
- 管理员可在「用户管理」里按用户勾选模块动作，保存即生效；`GET /api/permissions/catalog` 提供模块 / 动作全集与各角色默认值。`admin` 恒定拥有全部权限，不读取授权表，避免误操作锁死唯一管理员。
- 动作中 `correct`（更正重开 / 作废）与 `edit` 分开授予。`operator` 默认具备入库、出库、退货退库的建单、改草稿与过账权限，但没有 `correct`、`delete` 等破坏性动作；盘点确认 `stocktake:confirm` 仍是独立动作。
- 服务端路由用 `requirePerm(module, action)` 校验（内部读 `req.grants`）；前端用 `App.can(module, action)` 控制菜单与按钮显隐，不构成安全边界。
- 价格可见性由 `canViewPrice` 判定，仅 `admin` / `manager` 为真。鉴权中间件把结果挂到 `req.canViewPrice`，各接口在无权限时**服务端删除**金额、单价、成本等键，而不是仅靠前端隐藏。
- 同一账号单终端登录：`user_sessions` 每用户一行，JWT 带 `sid`；后登录的终端覆盖 `sid`，旧终端再请求时返回 401 `SESSION_KICKED`。终端标识存在浏览器 `localStorage`，同一浏览器的多个标签页视为同一终端，不会互踢。

## 文档

- [开发文档](docs/development.md)：架构、目录职责、数据库表、服务层、接口一览、前端组织
- [业务说明](docs/business.md)：权限模型、各模块流程、单据状态机、作废与更正重开、查询中心
- [成本核算规则](docs/costing.md)：定点数值、移动加权平均、成本依据、负库存、成本差异与重算

## 已知限制

- 列表级 CSV 导出 / 打印目前只在查询中心四个板块与各单据详情页提供，其他模块的列表页没有导出入口。
- 单据详情渲染存在两套实现：业务模块详情页与查询中心的只读详情卡各有一套组装逻辑，字段展示需分别维护。
- 数据库为单文件 SQLite，适合单机 / 小团队并发；不支持多实例同时写入。并发写冲突会以 `DB_BUSY` 提示，而不是静默失败。
- 旧结构（表或列类型不一致）的备份不允许恢复，恢复接口会直接拒绝；仅含库文件、未带图片的旧 `.db` 备份在物料有图片时也需改用 `.zip` 备份包。
