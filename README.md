# 库存管理系统（Web 版）

基于 Web 的库存进出库管理系统，从 Excel 管理模式升级为全功能 Web 应用。支持多用户、权限控制、价格隐藏、批量操作、采购管理（采购单 / 合同 / 到货跟踪）等完整业务流程。

## 快速启动

```bash
npm install                # 首次安装依赖
copy .env.example .env     # Windows（macOS/Linux 用 cp）；再编辑 .env 填入 JWT_SECRET
node server.js             # 启动服务
# 打开 http://localhost:4000
```

`JWT_SECRET` 必填且不少于 32 个字符，缺失或过短时服务会直接报错并提示如何生成，不会用默认密钥兜底。

首次登录的管理员账号由环境变量 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 决定；未配置密码时服务会随机生成并只在启动日志中打印一次（首次登录强制修改密码）。

重新初始化数据库（会清空所有数据）：

```bash
node init-db.js
```

### 运行环境

- Node.js 22 及以上。依赖 `better-sqlite3` 13 自带 N-API 预编译二进制，在 Node 26 下可直接使用，**不需要**安装 Visual Studio Build Tools 或 Python。
- 若依赖二进制与当前 Node 版本不匹配（报 `NODE_MODULE_VERSION ... was compiled against a different Node.js version`），执行下面的命令重新生成与该 Node 匹配的二进制即可：

```bash
npm rebuild better-sqlite3     # 已有 node_modules 时
npm install                    # 或重新安装依赖
```

### 数据库位置

默认使用项目根目录下的 `inventory.db`。如果项目放在 USB 外接盘、网络盘或同步盘上，SQLite 的 WAL 模式可能报 `SQLITE_IOERR_*` / `disk I/O error`（这不是代码问题，而是磁盘不支持 WAL 所需的共享内存与截断操作），此时用环境变量 `DB_PATH` 把数据库文件指向本机磁盘的绝对路径即可，例如：

```
DB_PATH=C:\Users\YourName\AppData\Local\warehouse_cn\inventory.db
```

首次使用新的 `DB_PATH` 前，把旧的 `inventory.db` 复制到该位置即可保留原有数据。

### 环境变量（.env）

敏感配置不写进代码，统一从项目根目录的 `.env` 读取（模板见 `.env.example`；`.env` 已被 `.gitignore` 忽略，切勿提交）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | 是 | JWT 签名密钥，至少 32 字符；缺失或过短时启动直接报错退出 |
| `INITIAL_ADMIN_USERNAME` | 否 | 首次初始化数据库时创建的管理员用户名，默认 `admin` |
| `INITIAL_ADMIN_PASSWORD` | 否 | 初始管理员密码；未设置时随机生成并在启动日志打印一次 |
| `HOST` / `PORT` | 否 | 监听地址 / 端口，默认 `0.0.0.0:4000` |
| `DB_PATH` | 否 | 数据库文件绝对路径，默认项目根目录的 `inventory.db`；项目在 USB 外接盘 / 网络盘时建议指向本机磁盘 |

生成密钥（32 字节以上随机串）：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**密钥轮换**：更换 `JWT_SECRET` 后，此前签发的所有 JWT 立即失效，所有在线用户需要重新登录（token 有效期 7 天）。

## 目录结构

```
.  （项目根目录）
├── server.js              Express 后端入口（路由挂载 + 静态资源）
├── init-db.js             数据库初始化脚本（建表 + 种子数据）
├── inventory.db           SQLite 数据库文件（本地数据，不入库）
├── .env.example           环境变量模板（复制为 .env 后填写）
├── package.json
├── .gitignore
├── public/
│   ├── index.html         主应用入口（按顺序加载 js/ 各模块 + Chart.js CDN）
│   ├── login.html         独立登录页（支持中英文 + 暗色主题）
│   ├── js/                前端 JS 模块（按依赖顺序加载）
│   │   ├── 00-i18n.js         国际化字典（zh / en）
│   │   ├── 01-core.js         App 主体 / 状态 / 路由 / API / 权限
│   │   ├── 02-ui-kit.js       表格排序 / 分页 / 表单校验 / 筛选 / 弹窗
│   │   ├── 03-dashboard.js    仪表盘与图表
│   │   ├── 04-materials.js    物料档案
│   │   ├── 05-inbound.js      入库记录
│   │   ├── 06-outbound.js     出库记录
│   │   ├── 07-stock.js        库存汇总 / 查询中心 / 物料台账
│   │   ├── 08-orders.js       供应商档案 / 参数设置
│   │   ├── 09-admin.js        用户管理
│   │   ├── 10-purchase.js     采购管理（采购单 / 合同 / 采购明细 / 到货履历）
│   │   ├── 11-stocktake.js    库存盘点（建单/载入清单/实盘/确认/删除草稿，确认自动生成调整流水）
│   │   └── 12-audit.js        系统日志（登录 / 增删改操作审计）
│   ├── css/               样式（按层引入，顺序影响层叠）
│   │   ├── base.css           CSS 变量 / reset / 框架 / 侧边栏 / 主内容
│   │   ├── components.css     卡片 / 按钮 / 表格 / 表单 / 模态框 / Toast
│   │   ├── pages.css          表格优化 / 排序分页 / 响应式
│   │   └── theme-dark.css     暗色主题覆盖（必须最后引入）
│   └── style.css          独立登录页样式（login.html 引用）
```

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Node.js + Express + SQLite (better-sqlite3) | 同步 API，零构建 |
| 鉴权 | bcryptjs + jsonwebtoken | JWT 7 天过期，bcrypt 密码加密 |
| 前端 | 原生 HTML / CSS / JavaScript | 无框架、无打包器，刷新即生效 |
| 图表 | Chart.js (CDN) | 仪表盘趋势图/分类图/Top5 |
| 缓存策略 | Cache-Control: no-cache | 静态文件禁缓存，确保浏览器加载最新版本 |

## 功能模块（13 个页面）

| 页面 | 说明 | 关键特性 |
|---|---|---|
| 仪表盘 | 库存总览、进出库趋势 | 价格权限控制，operator/viewer 隐藏金额图表 |
| 物料档案 | 物料基础信息 | 编码按类别前缀自动生成，期初价格按权限隐藏 |
| 入库记录 | 采购入库/采购退货流水 | 批量录入，三级联动选物料，按订单/合同带明细 |
| 出库记录 | 正常出库/退库出库流水 | 批量录入，三级联动，加权平均成本 |
| 库存盘点 | 建单 / 载入清单 / 实盘 / 确认 | 确认自动生成调整流水，草稿态可增删明细行 |
| 查询中心 | 多条件组合查询 | 三个 tab（库存/入库/出库），排序+分页 |
| 库存汇总 | 实时库存 + 预警 | 多关键字模糊筛选，价格列按权限隐藏 |
| 物料台账 | 单物料进出流水 | 期初/期末/收支汇总 |
| 采购管理 | 采购单 / 合同 / 采购明细三口径查询 | 单据详情可追踪到货与入库，明细下钻到货履历 |
| 供应商档案 | 供应商信息 | |
| 参数设置 | 分类/单位/去向/单号规则等 | |
| 用户管理 | 用户 CRUD + 角色分配 | 仅 admin 可见 |
| 系统日志 | 操作审计（登录 / 增删改 / 确认） | 按模块、动作、时间、关键字筛选 |

## 核心设计

### 1. 入库/出库类型与负数冲抵

| 表 | txn_type | qty | 单号前缀 | 说明 |
|---|---|---|---|---|
| inbound | 采购入库 | 正数 | GRN- | 正常入库 |
| inbound | 采购退货 | **负数** | RET- | 退给供应商，冲减入库 |
| outbound | 正常出库 | 正数 | GIN- | 正常出库 |
| outbound | 退库出库 | **负数** | RKB- | 退库回仓，冲减出库 |

- 用户界面输入正数，前后端自动转负数存储
- 库存公式：`on_hand = opening_qty + SUM(inbound.qty) - SUM(outbound.qty)`
- 采购退货的 qty 为负 → 冲减入库量
- 退库出库的 qty 为负 → `-(-out)` → 增加库存
- `amount`/`cost_amount` 为 GENERATED 列（`qty * price`），自动跟随正负
- 表格 badge 颜色：正常=蓝色(info)，退库/退货=红色(danger)

### 2. 批量单号

- 一批提交（多行）共享同一个单号
- 单号格式：`前缀-YYYYMMDD-序号(4位)`，如 `GRN-20261101-0001`
- 前缀按 txn_type 区分：GRN/GIN（正常）、RET/RKB（退库退货）

### 3. 权限矩阵（方案 A：写死角色）

| 角色 | 权限范围 |
|---|---|
| admin | 全部模块全部操作 |
| manager | 业务全权（入出库/物料/订单/供应商/订单跟踪/参数设置），**不含用户管理** |
| operator | 只能新增入库和出库（view+create），**不能编辑/删除**已录入记录，不能新增物料/订单 |
| viewer | 纯只读 |

- 后端：`requirePerm(module, action)` 中间件，32 个业务路由全部挂载
- 前端：`can(module, action)` 基于 `user.grants` 控制菜单/按钮显隐
- 价格权限：`canViewPrice()` 仅 admin/manager，隐藏所有价格/金额列

### 4. 价格权限控制

`canViewPrice()` 返回 `true` 时显示价格/金额列，否则隐藏。涉及：

- 仪表盘：总价值指标卡、趋势图、类别图、Top5 图表、超期订单金额列
- 入库/出库表：单价/金额列 + 汇总总金额
- 库存汇总：加权均价/库存价值列 + 汇总
- 查询中心：三个 tab 的价格列
- 物料台账：单价/金额列
- 采购管理：金额列 + 汇总（订购/已到/未到）
- 物料档案：期初价格列 + 编辑表单字段
- 批量表单：价格输入列

非价格可见用户的表单用 `<input type="hidden" value="0">` 保证提交逻辑不变。

### 5. 前端架构

#### SPA 多模块模式（2026-11 拆分）
- `App` 对象挂载全局，页面通过 `pageWrap()` + `setMain()` 切换
- 路由：`location.hash` → `router()` → 对应 `renderXxx()` 函数
- **文件按依赖顺序用普通 `<script>` 标签加载**（非 ES Module，保持零构建）

```
00-i18n.js  →  01-core.js  →  02-ui-kit.js  →  03..09 各业务模块  →  App.init()
```

拆分约定：
- `00-i18n.js` 定义 `const I18N = {...}`，全局唯一
- `01-core.js` 定义 `const App = {...}`，全局唯一，末尾 `window.App = App`
- 其余模块用 `Object.assign(App, { ...方法... })` 挂载，**`this` 始终指向同一个 App 实例**
  → 跨模块的 `this.xxx()` 调用无需任何改动
- 新增模块：建文件 → 写 `Object.assign(App, {...})` → 在 `index.html` 末尾追加 `<script>`
- CSS 顺序影响层叠：`theme-dark.css` 必须最后引入

#### DOM 三段式布局（铁律）
```
.data-page (flex column, height:100%)
  ├── .data-toolbar  (flex-shrink:0) — 新增按钮 + 筛选框，永久不销毁
  ├── .data-summary  (flex-shrink:0) — 统计汇总行
  ├── .data-scroll   (flex:1, overflow:auto) — 表格在此独立滚动
  └── .data-pager    (flex-shrink:0) — 分页条
```

`renderXxx()` 只渲染一次结构；`renderXxxTable()` 只重设表格区域和分页区域。
**绝不可重设包含工具栏的容器** —— 否则中文输入法（IME）组合状态被打断。

#### 通用函数
| 函数 | 说明 |
|---|---|
| `getTableState(tableId)` | 获取表格的 sortKey/sortDir/page/pageSize |
| `sortData(data, key, dir)` | 排序：数字/日期/字符串自动识别 |
| `sortTh(label, key, tableId)` | 生成可排序表头（点击切换升降序 + 箭头） |
| `paginate(data, page, pageSize)` | 分页切片 |
| `renderPager(tableId, total)` | 分页条 HTML |
| `filterByKeywords(data, kw, fields)` | 多关键字模糊筛选（空格分隔，AND 逻辑） |
| `filterByDateRange(data, field, from, to)` | 日期段筛选 |
| `can(module, action)` | 权限检查 |
| `canViewPrice()` | 价格可见性检查 |
| `showModal(title, body, btn, onConfirm, onCancel, large)` | 弹窗（large=true 宽弹窗） |
| `confirmDialog(title, msg, onConfirm, onCancel)` | 确认框 |
| `rowActions(module, editCall, deleteCall)` | 行操作按钮（按权限显隐） |

#### i18n
- `I18N` 字典对象，`zh` 和 `en` 两套 key 完全对齐
- `this.t('key')` 翻译函数
- 新增任何界面文案时，必须同时补 zh 和 en

#### 主题
- CSS 变量定义在 `:root`，暗色主题用 `[data-theme="dark"]` 覆盖
- 偏好存 `localStorage`
- 切换主题时 Chart.js 图表需销毁重建

### 6. 登录与安全

- 独立登录页 `login.html`，token 存 localStorage
- JWT 签名密钥来自环境变量 `JWT_SECRET`（不再硬编码）；轮换密钥会使旧 token 全部失效，用户需重新登录
- 初始管理员账号由 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 配置，未配置密码时随机生成并只打印一次
- `api()` 自动带 `Authorization: Bearer` 头，401 自动跳登录页
- 首次登录强制改密（`must_change_pwd` 标记）
- **5 分钟空闲超时**：无操作自动退出登录
- 保护：不能删除最后一个启用的管理员、不能删除当前登录账号

### 7. 数据库表结构

```sql
-- 物料档案
materials (code PK, name, spec, category, unit, opening_qty, opening_price,
           min_stock, default_location, brand, status)

-- 入库记录（采购入库 + 采购退货）
inbound (id PK, date, grn_no, code FK, qty, price, amount GENERATED,
         supplier, handler, location, remarks, po_no, contract_no, txn_type,
         order_line_id)   -- 精确核销到采购明细行（0 = 未关联，回退三元组匹配）

-- 出库记录（正常出库 + 退库出库）
outbound (id PK, date, gin_no, code FK, qty, destination, receiver,
          handler, location, remarks, cost_price, cost_amount GENERATED, txn_type)

-- 采购单（表头；contract_no 仅作新建明细时带出的「默认合同」）
purchase_orders (po_no PK, date, supplier, project, expected_date,
                 contract_no, manual_status, remarks)

-- 采购明细行（真实合同归属在行上：采购单 ↔ 合同为多对多）
order_lines (id PK, po_no FK, code FK, order_qty, order_price, contract_no, remarks)

-- 合同档案（独立建表，「按合同查询」与到货核销的实体依据）
contracts (id PK, contract_no UNIQUE, name, supplier, sign_date, amount,
           status, remarks, created_by, created_at)

-- 用户
users (id PK, username UNIQUE, password_hash, name, role, status,
       must_change_pwd, last_login, created_at)

-- 参数表
params (key, value)              -- currency, system_name 等
categories (id, name, prefix)    -- 物料分类 + 编码前缀
units (id, name)                 -- 计量单位
locations (id, name)             -- 库位
destinations (id, name)          -- 出库去向
```

### 8. 关键 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/login | 登录，返回 JWT |
| GET | /api/auth/me | 获取当前用户信息 + grants |
| GET | /api/dashboard | 仪表盘聚合数据 |
| GET/POST/PUT/DELETE | /api/inbound | 入库 CRUD（POST 支持 items 数组批量，**批量行集与校验行集一致**） |
| GET/POST/PUT/DELETE | /api/outbound | 出库 CRUD（POST 支持 items 数组批量，**带库存校验**） |
| GET | /api/stock-summary | 库存汇总（含 avg_price, stock_value） |
| GET | /api/purchase/orders | 采购单列表（关键字/供应商/合同/状态/到货状态/日期） |
| GET | /api/purchase/orders/:poNo | 采购单详情（明细 + 入库单 + 日志 + 汇总） |
| GET | /api/purchase/lines | 采购明细综合查询（可按采购单 / 合同） |
| GET | /api/purchase/lines/:id/inbound | 明细到货履历（含累计到货） |
| GET | /api/purchase/lines/by-po/:poNo · by-contract/:contractNo | 按采购单 / 合同取未到货明细 |
| GET | /api/purchase/pending-orders | 有未到货明细的采购单（入库页选择） |
| GET | /api/purchase/contracts/:contractNo | 合同详情（关联采购单 + 明细 + 入库 + 汇总） |
| GET | /api/materials/next-code | 按类别生成物料编码 |
| GET/POST/PUT/DELETE | /api/users | 用户管理 |
| GET/POST/PUT/DELETE | /api/materials | 物料档案 CRUD |
| GET/POST/PUT/DELETE | /api/purchase/orders(/:poNo) | 采购单 CRUD（有入库记录的采购单不可删） |
| POST/PUT/DELETE | /api/purchase/lines(/:id) | 采购明细增删改（已到货明细不可删） |
| GET/POST/PUT/DELETE | /api/purchase/contracts(/:contractNo) | 合同 CRUD（被采购单/入库引用不可删） |
| GET | /api/ledger/:code | 单物料台账流水 |

### 9. 出库库存校验规则

出库（POST/PUT `/api/outbound`）在写入前做库存校验，规则如下：

| 规则 | 说明 |
|---|---|
| 库存口径 | `可用 = 期初数量 + Σ入库 - Σ出库`（按**物料总量**计算，不按库位，因物料可跨库位调拨） |
| 超量拒绝 | 可用 < 出库量 → 抛错 `INSUFFICIENT_STOCK`，HTTP 400，响应带 `details` 数组（每行：编码/可用/需求/缺口） |
| 批量累计 | 同一批次内同物料的多行**累计**后再比较，不会因分行而绕过校验 |
| 编辑排除自身 | PUT 时排除该记录自身的扣减量，只校验"改动后的净增量"；若同时换了物料，旧扣减仍归属原物料，不计入新物料 |
| 存量负库存豁免 | 若某物料**本次操作前的真实可用量**已 < 0（历史错账），不再拦截新出库，避免管理员无法修正历史记录 |
| 强制放行 | 请求带 `force_allow: true` 且当前用户角色为 `admin` / `manager` 时跳过校验；其他角色的 `force_allow` 被静默忽略 |

**豁免口径说明**：豁免判断用的是「本次操作前的真实可用量（含被编辑记录自身的扣减）」，
而不是「排除自身后的可用额度」。若用后者，一条本身把库存打成负数的记录在编辑时
可用额度恰好 ≥ 0，会导致负库存物料反而无法被修正。

**批量写入一致性**：POST 的校验与写入基于同一批"有效行"——
先过滤出 `code + qty + date` 齐全的行（`date` 缺失时回退到顶层 `body.date`），
再对这一批行做校验和写入，避免"校验时算进需求、写入时却跳过"的不一致。
一批里若没有任何有效行，直接返回 400 而不是静默成功。

**响应结构**：
- POST `/api/outbound`、`/api/inbound` 的 `results[]` 每项含 `id`（自增主键）、单号、成本单价
- PUT `/api/outbound/:id`、`/api/inbound/:id` 缺省的可选字段自动回退到原记录值，
  不会因少传 `gin_no` / `grn_no` 等参数导致整个编辑失败

前端配合：
- 出库表单实时显示每个物料的「可用库存」列，超量时标红并给出红框提示
- admin / manager 收到 `INSUFFICIENT_STOCK` 时弹确认框，可选择「强制放行」
- operator / viewer 只收到 toast 提示，无法强制放行

## 开发约定

1. 改动集中在 `public/js/<对应模块>.js` 和 `public/css/<对应层>.css`，改完直接刷新浏览器
2. 验证语法：`node -c public/js/<模块>.js` 和 `node -c server.js`（`node -c` 一次只能校验一个文件）
3. 静态文件已禁缓存（`Cache-Control: no-cache`），浏览器会加载最新版本
4. 本地 SQLite 带 WAL 文件，改数据前注意 `inventory.db-wal`
5. 数据库迁移在 `migrateDB()` 中自动执行（ALTER TABLE + 数据更新）
6. **`public/style.css` 仅用于独立登录页 `login.html`**，主应用的样式一律写在 `public/css/` 下
7. 新增 JS 模块时：文件名前缀数字决定加载顺序（如 `10-xxx.js`），在 `public/index.html` 中按序引入；
   模块内用 `Object.assign(App, { ... })` 挂载方法，`this` 始终指向全局唯一的 `App`
8. 新增 CSS 时：按"基础变量 → 组件 → 页面 → 主题"放进对应文件，**`theme-dark.css` 必须最后引入**，
   否则暗色主题的变量覆盖会失效
9. 新增界面文案必须同时补 `00-i18n.js` 里的 `zh` 和 `en` 两条，否则切换语言会显示原始 key

## 依赖

```json
{
  "express": "^4.18.2",
  "better-sqlite3": "^11.0.0",
  "bcryptjs": "^2.4.3",
  "jsonwebtoken": "^9.0.0"
}
```
