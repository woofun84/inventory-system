# 系统日志（审计日志）审查报告

> 审查日期：2026-11-23　范围：审计日志的采集、存储、查询、展示与运行期日志。
> **更新：2026-11-23 已按本报告 P0→P3 全部实施，落地清单见文末第六节。审查时的"问题"描述保留作为基线，不代表当前状态。**

## 一、结论（审查时基线）

审查时系统日志「日常够用」，但还达不到强审计/合规级。核心写操作覆盖了、权限和脱敏做得不错、清空可追溯；主要短板是：可以整表删除且无防篡改、关键权限变更缺旧值→新值、运行异常不入库、检索会随数据量线性变慢、前端筛选项与实际数据脱节。综合评分约 **7.5/10**（功能完整度 8.5／治理与可追溯性 6.5）。这些问题现已全部整改，见第六节。

---

## 二、现状速览

| 维度 | 现状 |
| --- | --- |
| 统一写入 | `server/services/audit.js:58` 的 `record()`，同步 `INSERT INTO audit_logs`，写失败仅 `console.error`，不影响主流程 |
| 自动采集 | `server/middleware/audit.js:77` 全局挂在 `server.js:48`，对 `/api/**` 的 POST/PUT/PATCH/DELETE 在 `res.on('finish')` 后落一条；GET 不记 |
| 手工补强 | 物料批量/编码变更、备份/恢复/清库/结转、采购调价、入出库作废等由路由显式写入（部分跳过通用埋点避免重复） |
| 存储 | `audit_logs` 15 列，`created_at` 存 UTC；索引仅 `created_at / username / module`；无日志级别、无完整性字段 |
| 查询 | `services/audit.js:81` 服务端分页（50/页，上限 200），`module/action` 等值 + 6 字段 `LIKE '%…%'` 关键词；`audit:view` 权限 |
| 脱敏 | 写入时键名匹配 `pass|pwd|secret|token` → `***`；读取时无 `price:view` 者价格类键 → `***`（`services/audit.js:45`） |
| 清空 | `routes/audit.js:24` 需 `audit:delete`，事务内先清表再补写一条（含删除条数）；清库操作也会清日志再补记 |
| 前端 | `public/js/12-audit.js`：模块/动作/关键词/日期筛选、详情弹窗、清空；i18n 中英 263 个 key 完全对齐 |
| 运行日志 | 只有 `console.error`/`console.log` 输出到 stderr（systemd journal），无分级、无入库、无全局异常钩子 |

**本地库只读统计（2026-11-19 ~ 11-22）**：共 454 条；模块 auth 129 / inbound 106 / outbound 74 / materials 55 / settings 36 / purchase 26 / users 6 / 其他；动作 create 176 / login 127 / confirm 58 / update 52 / delete 20 / void 11 / backup 类 6 / 其他；其中 `status>=400` 共 25 条（失败登录 19 条），说明**失败请求确实被记录**。

---

## 三、做得好的地方（保持，不要改坏）

1. **写操作全覆盖 + 响应结束再记**：`status` 取自真实响应码，失败请求也能追到；`req.skipGenericAudit` 让精确埋点不重复。
2. **密码明文不落库**：实测用户管理日志里密码为 `***`；价格按查看者权限在读时打码，避免了"审计页绕过价格权限"。
3. **清空可追溯**：清空与系统清库都在事务里补写一条记录，没有变成"无声抹除"。
4. **权限前后端一致**：`audit:view` / `audit:delete` 后端 `requirePerm` 兜底，不是只靠前端隐藏按钮。
5. **详情结构化**：`detail_json` + i18n key 支持中英渲染，"改了什么"比裸 JSON 可读。

---

## 四、问题与优化建议（按优先级）

### P0 — 建议优先处理

**1. 日志可被授权用户整表抹除，且无完整性保障**
- 现象：`DELETE FROM audit_logs` 只需 `audit:delete`（可委派）；表无 `prev_hash/hash`，无任何校验机制；清库也会清日志。
- 影响：日志本身是追责依据，却依赖"没人删它"；内部纠纷时证据力不足。
- 建议：
  - 短期：`audit:delete` 收敛为仅 admin（或加二次确认 + 输入确认短语 + 记录操作人 IP/详情），并把清空记录同步写一份到**独立的只追加文件/备份**（可走现有 systemd journal 或自动备份目录）。
  - 中期：表加 `prev_hash` / `hash` 列，写入时按 `id + created_at + 关键字段 + prev_hash` 生成 SHA-256 链；提供只读的"完整性校验"接口/定时校验任务，发现断链告警。
  - 注意：哈希链会改变表结构，需做迁移（旧行 hash 留空并从最后一条续链），不要直接改写历史。

**2. 关键安全事件只有泛化描述，缺"旧值 → 新值"**
- 现象：用户管理（创建/改角色/改权限/停用/重置密码）只由通用中间件记录，实测 detail 为 `{"name":"woo","role":"manager","status":"active","permissions":"{…}"}`——只有**新值**，`permissions` 还被折叠成 `{…}`；重置密码只看到 `password:"***"`。失败登录有 19 条 status=401，但无失败原因/是否锁定。
- 影响：查不出"谁把谁从管理员降成操作员""谁重置了谁的密码"，这是审计里最该有的证据。
- 建议：在 `routes/users.js` 与 `routes/auth.js` 的关键分支显式 `record({ module:'users', action:'role-change'/'permission-change'/'password-reset'/'login-failed', detail:{key,params:{target,oldValue,newValue}} })`，密码/令牌值永不入参；失败登录补原因枚举和 IP。

### P1 — 明显提升

**3. 运行期异常不入库，通用埋点失败被静默吞掉**
- 现象：`record()` catch 只打印 `console.error`；`server.js` 没有全局 Express 错误中间件，也没有 `uncaughtException/unhandledRejection` 钩子。
- 影响：审计写失败、500 错误、崩溃原因只能在 journal 里翻，系统日志页看不到。
- 建议：
  - 增加 `app.use((err, req, res, next) => {...})` 兜底：5xx 写入审计表（`action='error'`，`status=500`，`detail` 限长 400 字，只记错误 message/type，不记请求体全文），再返回统一错误响应。
  - 审计写失败降级：内存计数 + 写本地 `audit-fail.log`，健康检查暴露 dropped 计数；不要让"审计全丢"悄无声息。
  - 进程级钩子只记录必要信息并让进程按既有监管策略退出，避免带病运行。

**4. IP 口径不一且可伪造**
- 现象：`middleware/audit.js:116` 与 `routes/audit.js:39` 直接取 `x-forwarded-for` 首段；settings-ops 用 `req.ip`；`server.js` 未设 `trust proxy`。
- 影响：客户端可直接伪造 XFF；经过 Cloudflare 隧道后首段是真实访客 IP 还是 CF 节点，取决于链路配置，当前不可确认。
- 建议：封装统一 `clientIp(req)`：若经 Cloudflare，优先 `CF-Connecting-IP` 且仅信任来自本机/隧道的代理请求；其他环境按 `app.set('trust proxy', <可信跳数>)` 后用 `req.ip`。所有埋点都调这个函数，并统一记 UA（可放 detail_json，不必新列）。

**5. 关键词检索是全表 LIKE，数据量上来会拖慢**
- 现象：`services/audit.js:86-94` 对 6 个字段做前导通配 `LIKE '%…%'`，`COUNT(*)` 也走同一条件；时间/模块有索引但关键词没有。
- 影响：当前 454 条无感，按现在写入量（3 天 454 条）一年约 5 万条，分页翻到中间页 + 关键词就会明显变慢。
- 建议（按成本递增）：① 默认时间范围 30 天 + 关键词最短 2 字符；② 复合索引 `(created_at, module, action)` 加速常规筛选；③ 真需要全文检索时再上 FTS5 虚拟表——注意此前已确认 FTS5 会改变中文分词匹配语义，需单独回归，**不要盲目替换现有 LIKE**。

### P2 — 体验与可用性

**6. 前端筛选项与实际数据脱节**
- 现象：`12-audit.js:12-14` 的 `AUDIT_MODULES` 缺 `audit`、`lines`；`AUDIT_ACTIONS` 仅 9 项，实际库里还有 `auto-backup / backup / restore / reset / batch / auto-backup-settings` 等；`00-i18n.js:614` 的 `audit_desc` 仍写"记录登录与单据操作"。
- 影响：用户筛不到"清空日志""备份/恢复"这类关键记录；页面描述低估了实际能力。
- 建议：补全常量并同步中英文案；更稳的做法是后端提供 `/api/audit-logs/facets` 返回实际出现过的值，前端按返回值渲染下拉（顺手解决历史脏值）。同时可加测试断言"下拉枚举覆盖近 N 天实际值"。

**7. 没有导出能力**
- 建议：按当前筛选条件提供 CSV 导出（复用现有导出的 CSV 注入防护与 BOM 口径），服务端限制最大行数（如 5000）并记一条 `audit:export` 日志；这样也缓解 P0-1 的"证据离库保存"问题。

**8. 详情可读性与失败原因**
- 现象：原始文本用 `<pre>` 直接显示；失败记录只显示状态码（如 401/400），没有错误原因；时间未标时区基准；无快捷时间区间。
- 建议：i18n 错误码映射 + 展示 message；时间列 title 注明"UTC 存储、按本地显示"；增加"今天/近 7 天/近 30 天"快捷按钮；结构化字段按类型渲染（布尔、数组、金额）。

### P3 — 锦上添花

9. **脱敏按"键名"而非"值"**：自由文本备注里若含密码/令牌，当前正则无能为力；可在 `packDetail` 里对字符串值追加一次敏感模式扫描，并统一截断长度。
10. **加 `level` / `source` 字段**：区分 `user / system / auto` 与 `info / warn / error`，让自动备份、异常、人工操作能在同一页分开筛选。
11. **前端运行异常**：目前无全局错误上报；若需要排查用户端问题，可加轻量 `window.onerror/unhandledrejection` 采样上报接口（注意不要上报表单正文与令牌）。

---

## 五、建议落地顺序

| 批次 | 内容 | 风险 |
| --- | --- | --- |
| 第 1 批 | P0-2 关键安全事件补旧→新值；P1-4 IP 口径统一；P2-6 筛选项与文案修正 | 低，纯增量埋点 + 常量 |
| 第 2 批 | P1-3 全局错误入库 + 审计写失败可见；P2-7 CSV 导出；P2-8 详情可读性 | 中，涉及错误响应路径，需回归错误码 |
| 第 3 批 | P0-1 哈希链 + 清空双重管控；P1-5 检索优化；P3 项 | 高，涉及表结构迁移与性能回归 |

> 复用项目既有约定：改完 `npm run check`，本地验证后推送并直接部署；动表结构前先备份数据库，历史日志不回溯改写。

---

## 六、P0→P3 落地记录（2026-11-23 实施完成）

### P0
- **P0-1 防篡改 + 清空管控**：`audit_logs` 新增 `prev_hash/hash/level/source` 四列（存量库启动时自动 `ALTER TABLE` 补列，历史行不改写）。`server/services/audit-hash.js` 定义 sha256 链，`record()` 写入即挂链，`verifyChain()` 逐行重算 + 校验 prev_hash 衔接，系统日志页新增「校验完整性」按钮与 `GET /api/audit-logs/verify`。篡改单行 / 删中间行均能定位首个断点（已在 454 条存量库副本上实测；新写入记录篡改→`brokenId` 命中，删行→后继行断裂）。
- 清空从「单点权限」升级为三重管控：`audit:delete` + **admin 角色** + **输入确认短语「清空日志」**；清空前把链尾 hash、条数、操作人、IP 写入数据目录独立只追加文件 `audit-evidence.log`。清业务数据 / 全清重置 / 恢复三个会抹库的操作也在删除前写同一留痕文件。
- **P0-2 关键事件旧值→新值**：用户改角色 / 改状态 / 改权限 / 重置密码 / 删除均有独立结构化审计（含 old→new，权限变更列出逐模块前后授权）；登录失败区分「用户不存在 / 密码错误 / 账号停用」，登出、改密、改密失败也独立记录。这些动作跳过通用埋点避免重复。

### P1
- **P1-3 异常入库**：`server.js` 末尾加全局 Express 错误中间件，5xx 落一条 `level=error, source=system` 审计；`uncaughtException/unhandledRejection` 写 `fatal-error` 后按 Node 推荐退出，交 systemd 拉起。审计写失败仍只打印 stderr（不静默吞掉）。
- **P1-4 IP 口径**：新增 `server/utils/client-ip.js`，仅当请求来自回环（Nginx 反代）才采信 CF-Connecting-IP / XFF，局域网直连一律用 socket 地址，堵住 XFF 伪造。全部 11 处埋点（中间件、审计路由、物料、采购、入出库、盘点、设置、会话、用户、认证）统一改用该函数。
- **P1-5 检索**：加 `idx_audit_module_action`、`idx_audit_chain` 复合索引；系统日志页新增「近 7 天 / 近 30 天 / 全部」快捷区间。**未做**关键词最短长度限制——中文单字搜索（如搜姓氏）有意义，强制 2 字符会误伤；FTS5 同样因中文分词语义风险未引入。

### P2
- **P2-6 筛选项**：模块下拉补 `audit/system/lines`，动作下拉从 9 项扩到 29 项（覆盖 backup/restore/reset/auto-backup/导出/各类错误等实际值）；页面描述改为准确的「登录、权限变更、单据与运维操作」，并加时区说明。
- **P2-7 导出**：`GET /api/audit-logs/export` 按当前筛选导出 CSV，最多 5000 条，复用 CSV 注入防护（公式字符前置 `'`）与价格权限打码；导出动作本身写审计。前端在工具栏加「导出 CSV」按钮。
- **P2-8 可读性**：失败记录的状态徽标 title 展示失败原因（截断 200 字），详情弹窗补「错误码」与「级别/来源」；时间列注明 UTC 存储本地显示。

### P3
- **值级脱敏**：`server/services/logdetail.js` 统一 `scrubText`，结构化 params 与纯文本 detail 都做 `password=*** / Bearer *** / token: ***` 打码 + 400 字截断，不依赖字段名。实测 `password=abc123 Bearer xyz` 入库为 `password=*** Bearer ***`。
- **level/source 分级**：审计表增加两列，通用埋点记 `info/user`，系统自动备份 `info/system`，运行异常 `error/system`，前端异常 `error/client`，校验失败 `error/user`。
- **前端异常上报**：`POST /api/client-errors` 免鉴权（只收类型 + 消息，服务端按 IP 每分钟限 20 条）；`01-core.js` 的 `initClientErrorReport()` 采样 10% 上报 `window.error` / `unhandledrejection`，永不携带请求体或令牌。

### 验证与改动文件
- `npm run check` 全绿：JS 语法 62/62，i18n zh=en=1500 零引用 0，server 导出 175 零引用 0；CSS 无样式类 27 仅报告。
- 接口冒烟（4001 端口 + 数据库副本）：哈希链校验、分页列表、CSV 导出、免鉴权异常上报、短语文案校验、清空全流程均通过，未污染开发库。
- 改动：新增 `server/services/audit-hash.js`、`server/utils/client-ip.js`；修改 `server.js`、`server/db.js`、审计服务/中间件/路由、认证与用户路由、8 个业务路由的 IP 取值、清晰库留痕、自动备份分级、前端 `00-i18n.js`/`01-core.js`/`12-audit.js`。历史日志无回溯改写。
