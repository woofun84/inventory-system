# 全项目代码审查报告 —— 死代码 / 冗余 / 孤立代码专项

- 审查日期：2026-11-22
- 审查范围：全项目 37,069 行（前端 JS 18,458 / 后端约 11,500 / CSS 2,658 / HTML + 文档 + 配置）
- 审查方式：静态引用分析（定义点 → 全局引用计数 → 内联事件、事件委托、字符串动态分发、前缀拼接逐项排除）+ 浏览器实测交叉验证
- 重要声明：本报告主体为**只读审查**，原始审查未修改源码。所有「确认可删」项均经全局 grep 复核；代理初筛中的 1 处误报已排除（见文末「已排除的误报」）。**后续已分批执行 P0/P1（见 9.1-9.4）与 P2（见 9.5），执行记录追加在第 9 节。**

---

## 0. 总体结论

项目整体健康度好于预期：**873 个前端函数/方法中几乎没有真正的死函数**（大量看似零调用的方法实为字符串动态分发），4 个 npm 直接依赖全部在用，前端请求的 API 与后端路由**完全对应，无 404 隐患**。

可回收的冗余集中在四处，按 ROI 排序：

| 优先级 | 类别 | 数量 | 风险 | 收益 |
|---|---|---|---|---|
| P0 | 后端废弃端点 + i18n 死键 + 死导出 | 约 30 处 | 极低 | 减少维护面、避免误导 |
| P1 | CSS 死规则 / 死工具类 | 约 24 处 | 低 | CSS 瘦身 ~15%、消除规则冲突 |
| P2 | 重复实现收敛（focusEnd / esc / 鉴权中间件） | 6 组 | 中 | 显著降低维护成本（**已执行，见 9.5**） |
| P3 | 臃肿函数 / 表驱动重构 | 4 处 | 高 | 需排期，不建议与清理混做 |

> **建议执行顺序**：P0 → P1 → P2 →（单独排期）P3。每一步独立提交、独立验证，不要一次性大爆炸式清理。

---

## 1. P0 —— 确认无用，可直接删除

### 1.1 前端 i18n 死键（10 键 × 中英 = 20 条）

全部经全局 grep 验证：除字典定义外零引用。位置均在 `public/js/00-i18n.js`。

| 键 | zh 行 | en 行 | 说明 |
|---|---|---|---|
| `cf_info` | 238 | 985 | `confirmDialog` 已改用 `this.icon()`，旧改造遗留 |
| `cf_warning` | 238 | 985 | 同上 |
| `set_auto_running` | 231 | 978 | 自动备份实际用 `set_auto_done` / `set_auto_saved` |
| `pu_prev` | 599 | 1347 | 裸键零引用；同名前缀的 `pu_next_add_lines` 仍在用，勿误删 |
| `pu_next` | 599 | 1347 | 同上 |
| `pu_restored` | 607 | 1355 | `pu_undo` 在用，仅此键废弃 |
| `audit_detail_st_load_all` | 731 | 1475 | 见下方风险提示 |
| `audit_detail_st_load_category` | 732 | 1476 | 同上 |
| `audit_detail_st_load_specified` | 733 | 1477 | 同上 |

**风险提示（必须处理）**：`audit_detail_st_load_*` 虽然当前服务端 `logStocktake()` 不再写入，但审计日志是按 key 渲染历史记录的。删除后，**历史日志中已存这 3 个 key 的记录会退化成显示原始 key 字符串**。建议改为「保留字典项但加注释标注历史兼容」，或写迁移脚本把老日志 key 改写为现行值后再删。这是本报告中唯一需要动数据考虑的项目。

### 1.2 前端死导出（1 处）

- `public/js/00-icons.js:51` — `window.appIconNames = Object.keys(ICONS);`
  全局仅定义行命中。删之，`ICONS` 本体仍被 `appIcon()` 使用。

### 1.3 后端废弃端点（3 个，前端 0 引用）

| 位置 | 端点 | 说明 |
|---|---|---|
| `server/routes/purchase.js:792` | `POST /api/purchase/lines/batch` | 前端批量建明细走 `POST /api/purchase/orders`（`10-purchase.js:1395`） |
| `server/routes/purchase.js:987` | `GET /api/purchase/pending-orders` | 前端改用 `/api/purchase/inbound-sources`（`05-inbound.js:375`） |
| `server/routes/returns.js:314` | `GET /api/returns/purchase/scope-options` | 前端只用 `scope-lines`（`05-inbound.js:1578`） |

仅出现在后端与 docs，前端 `public/` 零命中。删除时同步更新 `docs/development.md:288/291` 与 `docs/business.md:174`。

### 1.4 后端死导出函数（6 个）

| 位置 | 函数 | 判定 |
|---|---|---|
| `server/services/costing.js:665` | `rebuildAll()` | 仅定义 + 导出两处命中，无调用、无路由 |
| `server/services/units.js:101` | `amountOf()` | 仅定义 + 导出 |
| `server/services/units.js:105` | `unitPriceOf()` | 仅定义 + 导出 |
| `server/services/units.js:110` | `isZeroAmount()` | 仅定义 + 导出 |
| `server/services/stock.js:346` | `computeCostPrice()` | 仅定义 + 导出；成本已迁至 costing.js |
| `server/services/stock.js:143` | `getReturnedQtyByLine()` | 已被批量版 `getReturnedQtyMap`（:156）取代，仅定义 + 注释 + 导出 |

### 1.5 自相矛盾的初始化写入（2 行）

- `init-db.js:71-72` 写入 `params` 的 `currency='¥'` 与 `use_icons='是'`
- `server/db.js:450-455` 每次启动都 `DELETE FROM params WHERE key IN ('currency','use_icons')`

必被立即清除的死写入，两处一起删。

---

## 2. P1 —— CSS 死规则与冗余

> 全局 grep 验证：CSS 提取 476 个类，在 16 个 JS + 2 个 HTML 中逐一比对，以下确认零命中（含动态拼接复核）。

### 2.1 整块死规则（高价值）

| 位置 | 选择器 | 判定依据 |
|---|---|---|
| `base.css:495-498` | `.data-pager` 整块 | `data-pager` 全项目零命中；数据页用 `.data-scroll` + `.pu-pager` |
| `base.css:413,425` | `.page-header`（组合分支 + 单独规则） | 全项目只有 `class="page-header-row"`，`.page-header` 单独零命中 |
| `pages.css:460-465` | `.st-tabs` 整块 | DOM 是 `id="st-tabs" class="pu-viewtabs"`，类选择器永不匹配 |
| `pages.css:466-479` | `.st-tab` 及 `:hover`/`.active` | `class="st-tab"` 零命中，盘点页签全走 `.pu-viewtab` |
| `pages.css:409-410` | `.st-insp-actions` | 子串零命中 |
| `pages.css:452` | `.pu-pager .pu-tot` | `pu-tot` 零命中，`puPagerHtml` 不生成该类 |

### 2.2 死工具类（`components.css`）

确认零引用，可删：
`.u-wrap-anywhere`(:17)、`.u-danger`(:54)、`.u-block`(:62)、`.u-flex-center`(:63)、`.u-opac-7`/`.u-opac-6`(:66-67)、`.u-mb-0`(:74)、`.u-mb-1`(:14)、`.u-mb-4`(:76)、`.u-mt-4`(:73)、`.u-ml-2`/`.u-mr-2`/`.u-m-auto`(:77-79)、`.u-w-90`/`.u-w-auto`(:86-87)、`.u-cursor-pointer`/`.u-cursor-default`(:93-94)、`.u-block-title`(:16)、`.u-min-w-120`(:36)

**注意**：`.u-plain-control`(:48-49) 注释称"保留作别名向后兼容，新代码统一用 u-select-transparent"，但 `07-stock.js:872/1108` 的"新代码"仍在用它——**注释与事实不符，类本身有用，勿删**（应改注释）。

### 2.3 死变量

- `base.css:150` `--lh-tight: 1.4` —— 定义后零引用
- `breakpoints.css:9-15` `--bp-xl/lg/md/sm/xs` 全部 5 个 —— 零引用（`@media` 不能读 `var()`，文件头注释已承认只是口径文档）。建议保留文件但明确标注为文档常量，或移入注释。

### 2.4 重复声明（被后续规则完全覆盖的死声明）

- `components.css:12` vs `:71` — `.u-mt-2` 重复定义
- `components.css:13` vs `:72` — `.u-mt-3` 重复定义
- `components.css:53` vs `:75` — `.u-mb-3` 重复定义
- `pages.css:78` vs `:447` — `.pu-pager .btn` 的 `height/min-width/padding` 在 :78 被 :447 完全覆盖

### 2.5 注释与实际规则冲突（应修正而非删代码）

- `pages.css:96` 注释称"分页器不强制 44px，保持 26px 紧凑（L1143 已下掉 pu-pager）"，但 `pages.css:1154` 又给 `.pu-pager select` 设了 `min-width/min-height:44px`。注释里行号已漂移，需更新。
- `pages.css:339`、`:132-134`、`:898` 有 3 处"已下线"空注释段，规则已清空，注释可删。

---

## 3. P2 —— 重复实现，建议收敛

### 3.1 `focusEnd` 四份完全相同实现 ★最高价值

```
05-inbound.js:1314   ibFocusEnd(id)
10-purchase.js:791   puFocusEnd(id)
11-stocktake.js:691  stFocusEnd(id)
13-returns.js:907    retFocusEnd(id)
```
函数体逐字相同（focus + setSelectionRange 到末尾）。`06-outbound.js:288/300` 甚至直接复用了 `ibFocusEnd()`。建议合并为 `App.focusEnd(id)`，5 处调用点改名。

### 3.2 `const esc = v => this.docEsc(...)` 21 处冗余包装

`07-stock.js` 17 处（`:273,407,683,812,949,982,1263,1413,1609,1700,1718,1743,1818,1991,2115,2221,2245`）、`02-ui-kit.js:573/783/890`、`06-outbound.js:1055`。
`docEsc` 内部已做 `String(v == null ? '' : v)`，包装完全等价，直接用 `this.docEsc` 或 `.bind(this)` 即可。

### 3.3 行错误提示两份同构实现

`05-inbound.js:2238-2250` 的 `ibClearLineErrors`/`ibShowLineError` 与 `10-purchase.js:1321-1333` 的 pu 版，仅 DOM 前缀不同（`#ib-edit-lines` vs `#pu-edit-lines`）。可参数化为 `App.clearLineErrors(rootSel, qtySel)` / `App.showLineError(...)`。

### 3.4 单据状态徽标三套近似实现

`01-core.js:1048` `statusBadge`、`02-ui-kit.js:166` `docStatusBadge`、`07-stock.js:895` `qDocStatusBadge`。后两者结构几乎相同，可抽公共 `badge(cls, label)` 基元，各模块只留标签映射表。

### 3.5 后端入库/出库鉴权中间件 5 对重复 ★维护成本最高

- `inbound.js:60` ↔ `outbound.js:54` `requireDocAction`
- `inbound.js:71` ↔ `outbound.js:65` `requireNextNoView`
- `inbound.js:80` ↔ `outbound.js:74` `requireDocEditOrCorrect`
- `inbound.js:93` ↔ `outbound.js:87` `requireCorrectionStart`
- `inbound.js:105` ↔ `outbound.js:99` `requireCorrectionAction`

逻辑逐行一致，仅表名与默认 `txnType` 不同。建议提取 `middleware/doc-permission.js` 工厂函数注入表名。

### 3.6 其他低优先级

- `09-admin.js:34-35` 两个仅转手调用的局部箭头函数，可内联
- `server/utils/search.js:38` `kwClause` 是 `kwClauseExpr` 的薄封装 —— **属合理设计，不建议动**

---

## 4. P3 —— 臃肿代码，建议单独排期重构

| 位置 | 规模 | 问题 | 建议 |
|---|---|---|---|
| `05-inbound.js:1770` `renderInboundEditTable()` | 197 行 | 表头/行/可用量/更正/合计/写 DOM 全塞一起；`:1829-1830` 与 `:1856-1857` 的 `filled` 计算完全重复 | 抽 `renderEditRow()`、列描述数组表驱动，`filled` 只算一次 |
| `05-inbound.js:1497` `editInboundDoc()` | 168 行 | 6 个串行 `await` + `alive()` 守卫交错 | 数据加载抽私有方法，主函数只做编排（可降至 ~50 行） |
| 前端 4 份 `ibRenderList`/`obRenderList`/`puRenderList`/`stRenderList` | 相似度 0.82-0.84 | `state→KPI→visibleRows→sortData→paginate→render` 同构 | 抽泛型 `renderList(ns, ...)`，改动面广，需完整回归 |
| `pages.css:1009-1032` `.q-ins-split` | 单段 8 处 `!important` | 用 `!important` 覆盖同权重规则，层级脆弱 | 用 `:is()` + 调整顺序 / `@layer` 收敛 |

> P3 不建议与 P0/P1 混做。这类改动收益在长期可维护性，但需要完整的回归测试配套。

---

## 5. 疑似无用 —— 需人工确认后再动

| 项 | 位置 | 为何不能直接删 |
|---|---|---|
| `toast-warning` / `toast-info` | `components.css:514-515` | `toast()` 支持 `toast-${type}` 动态拼接，语法可达；只是当前 80 次 error + 1 次 success，无 warning/info 实参 |
| `settle_batch` / `settled_at` | `server/db.js:414-415` | 只写不读，但可能是有意留痕；需确认业务是否要展示结算批次 |
| `idx_adj_date` | `server/db.js:224` | `stock_adjustments` 查询无 `WHERE date`/`ORDER BY date`，索引前导列未入条件；但删索引需评估未来查询 |
| `idx_audit_user` | `server/db.js:483` | `username LIKE @kw` 带前导 `%`，B-Tree 索引命中不了；同上 |
| 6 组"仅内部使用"的 export | 见下 | 函数本身有用，只是导出多余，收窄即可，不要删函数 |

冗余导出清单（收窄为模块内部函数）：
`costing.js:869-874` 的 `COST_BASIS`/`insertLedger`/`renumberFrom`/`recomputeFrom`/`logPriceRecalc`；
`units.js:116-120` 的 `QTY_SCALE`/`PRICE_SCALE`/`AMOUNT_SCALE`/`roundDiv`/`qtyPriceProductToAmount`；
`scaled-db.js:151` 的 `toStorage`/`toApiValue`/`PRICE_COLS`/`AMOUNT_COLS`；
`user-permissions.js:76` 的 `readGrants`；`docno.js:204` 的 `DEFAULT_DATE_STYLE`；`permissions.js:139` 的 `DEFAULT_MODULE_ACTIONS`。

---

## 6. 已排除的误报（审查严谨性记录）

以下初筛判为死代码，经人工复核确认**活跃，禁止删除**：

1. **`corrected_by_doc_no` 字段与索引**（后端代理误报）—— 实为更正链核心字段，`inbound.js:468/521/1384`、`outbound.js:186/238/892`、`returns.js:58/83/105/221/268` 均有读写，前端 3 个模块均用于关键词筛选与"已被更正"跳转按钮。**数据在用的字段，绝不能删。**
2. **`captureInboundView`/`restoreInboundView` 等 10 个"零调用"方法** —— 实为 `01-core.js:506-507` 字符串映射动态分发。
3. **`audit_detail_*` 大部分键** —— 由服务端 `detail_json` 动态生成 key，前端前缀拼接渲染。
4. **`.u-plain-control`** —— 注释误导，实际 `07-stock.js` 两处在用。
5. **`kwClause`** —— 是合理的薄封装，非重复。
6. **28 个图标定义** —— 全部有引用。

---

## 7. 建立系统的代码审查机制

清理是一次性的，机制才是长期解药。建议分三层落地：

### 7.1 提交前自检（开发者侧，零成本）

在 `package.json` 增加脚本：

```json
"scripts": {
  "check": "npm run check:syntax && npm run check:dead",
  "check:syntax": "node -e \"require('fs').readdirSync('public/js').filter(f=>f.endsWith('.js')).forEach(f=>require('child_process').execSync('node --check public/js/'+f))\"",
  "check:dead": "node tools/check-unused.js"
}
```

`tools/check-unused.js`（建议新建，约 100 行）做三件事：
1. 扫 `public/js/*.js` 中 `class="..."` 与 `public/css/*.css` 选择器，输出 JS 生成但 CSS 无定义的类（当前有 28 个待确认项）
2. 扫 `00-i18n.js` 的 key 与全项目 `t('key')`，输出零引用键（当前 10 个）
3. 扫 `server/services/*` 的 `module.exports` 与全项目 `require`，输出零引用导出

每次提交前跑 `npm run check`，把新增的死代码挡在门前。

### 7.2 审查清单（Code Review 模板）

建议在 `docs/development.md` 追加「代码审查清单」小节，作为 PR 模板固定项：

- [ ] 新增的 i18n key 中英文成对，且确实被引用
- [ ] 新增的 CSS 类在 JS/HTML 中有生成点；新增的 JS class 有对应样式或明确是 querySelector 钩子
- [ ] 新增的后端端点在前端有调用；新增的 API 调用在 server.js 有挂载
- [ ] 新增的导出函数有跨文件调用方，否则改为模块内部函数
- [ ] 新增的 DB 字段有读写两端；新增索引有对应 WHERE/ORDER BY 前导列
- [ ] 新增的 `!important` 有注释说明为何无法用特异性解决
- [ ] 涉及成本计算、权限、过账的改动必须双人复核（项目历史约定：不改原成本逻辑）

### 7.3 定期审计节奏

| 频率 | 动作 | 产出 |
|---|---|---|
| 每次提交 | `npm run check` + 语法检查 | 本地控制台 |
| 每月 | 本报告第 1/2 节的死键/死类/死端点复查 | `docs/code-audit.md` 更新「已清理」标记 |
| 每季度 | 第 3/4 节重复实现与臃肿函数专项 | 排期重构任务单 |
| 大版本前 | 全量重跑本报告方法 + 依赖审计（`npm audit`） | 版本质量门禁 |

### 7.4 防止死代码复生的两条硬规则

1. **i18n 键必须成对**：新增键时中英文同时写，删除时同时删；`check:dead` 会检测单边残留。
2. **废弃端点/字段用「墓碑注释」**：不能直接删数据库字段或公开 API 时（可能有外部调用方或历史数据），在旁边写明 `DEPRECATED since YYYY-MM-DD, reason: ...`，下次审计可直接识别，避免反复讨论。

---

## 8. 附：本次审查的方法学与局限

- **方法**：结构化提取定义 → 全局引用计数 → 排除动态分发（内联 `onclick`、`data-*` 事件委托、`this[method]()` 字符串映射、`t(prefix + suffix)` 前缀拼接、服务端 `detail_json.key`）→ 浏览器实测交叉验证。
- **局限**：
  - 纯静态分析无法覆盖运行期通过 `eval`/`new Function` 生成的引用（本项目未发现此类用法）
  - 审计日志历史数据的 key 兼容需人工判断（已在 1.1 标注）
  - DB 索引有效性判断基于当前查询，未来新增查询需重新评估
- **误报控制**：3 路独立审查 + 人工复核，已排除 6 类误报（见第 6 节）

---

**报告结论**：可以安全执行 P0（除审计日志 3 键需特殊处理）与 P1 全部清理；P2 建议按组分批做，每组独立回归；P3 单独排期。机制部分（7.1 的 check 脚本、7.2 的清单）建议随第一批清理一起落地。

---

## 9. 清理执行记录（2026-11-22）

> 用户确认执行 P0 + P1，并明确 `audit_detail_st_load_*` 三键**不做历史兼容保留，直接删除**。以下为实际执行结果。

### 9.1 已完成（P0）

| 项 | 处理结果 |
|---|---|
| 10 个 i18n 死键（中英） | **全部删除**，含 `audit_detail_st_load_*` 三键（按用户要求不做历史兼容） |
| `window.appIconNames` 死导出 | 已删（`00-icons.js`） |
| 3 个废弃端点 | 已删：`POST /api/purchase/lines/batch`、`GET /api/purchase/pending-orders`、`GET /api/returns/purchase/scope-options`；`docs/development.md`、`docs/business.md` 同步更新 |
| 6 个后端死导出函数 | 已删：`rebuildAll`、`amountOf`、`unitPriceOf`、`isZeroAmount`、`computeCostPrice`、`getReturnedQtyByLine` 及其导出项 |
| `init-db.js` 死写入 | 已删 `currency`/`use_icons` 两条 INSERT |

### 9.2 执行中发现的新问题（已一并处理）

1. **连锁死代码**：删除 `/api/returns/purchase/scope-options` 后，其唯一调用的服务函数 `getPurchaseReturnScopeOptions()`（`stock.js:675`）及其导出变成死代码，已一并删除，并同步清理 `returns.js` 的 import。**这说明端点清理必须追踪其专属 service 函数。**
2. **报告判断修正 —— `server/db.js:450-455` 的 DELETE 不应删除**：原报告 1.5 建议"两处一起删"，但复核发现这段 DELETE 是**运行时清理历史库残留的有效逻辑**（老数据库里仍可能有 `currency`/`use_icons` 参数），删掉反而会让升级后的老库残留脏参数。最终只删了 `init-db.js` 的死写入，**保留了 db.js 的清理逻辑**。

### 9.3 已完成（P1）

| 项 | 处理结果 |
|---|---|
| 整块死规则 | 已删 `.data-pager`、`.page-header`（含响应式与主题中的分支）、`.st-tabs`、`.st-tab`、`.st-insp-actions`、`.pu-pager .pu-tot` |
| 14 个死工具类 | 已删（`.u-wrap-anywhere`/`.u-danger`/`.u-block`/`.u-flex-center`/`.u-opac-*`/`.u-mb-*`/`.u-mt-4`/`.u-ml-2`/`.u-mr-2`/`.u-m-auto`/`.u-w-*`/`.u-cursor-*`/`.u-block-title`/`.u-min-w-120`） |
| 死变量 | `--lh-tight` 已删 |
| 重复声明 | `.u-mt-2`/`.u-mt-3`/`.u-mb-3` 各保留一处；`.pu-pager .btn` 在 768 断点只保留独有的 `flex-shrink:0`，删掉被覆盖的重复声明 |
| 注释修正 | 640 断点过时注释已更新；2 处空注释段已删 |

**保留项（非死代码）**：`breakpoints.css` 的 5 个 `--bp-*` 变量是**文档常量**（`/@media` 无法读取 `var()`），作为断点口径的单一事实来源保留，已在文件注释中明确标注"运行时零引用，勿判为死变量"，避免后续审查反复误报。

### 9.4 验证结果

- 全部 JS（前端 16 + 后端全部）`node --check` 通过
- 5 个 CSS 文件括号平衡（end=0, min=0）
- 两个 HTML 的资源引用完整性通过（index 22 项、login 5 项，无缺失）
- 待删项 grep 残留全部为 0；`.page-header` 独立类、死类、死键、死导出均无残留
- 净效果：**15 个文件、删除 298 行、新增 87 行（含本报告执行记录）**

### 9.5 P2 执行记录（2026-11-22 晚）

| 组 | 处理结果 |
|---|---|
| 3.1 `focusEnd` | 4 份逐字相同实现合并为 `App.focusEnd(id)`（`01-core.js`），9 处调用点改名（含 `06-outbound.js` 原先跨模块复用 `ibFocusEnd` 的 2 处） |
| 3.2 `esc` 包装 | 21 处箭头包装统一为 `this.docEsc.bind(this)`：`07-stock.js` 17、`02-ui-kit.js` 3、`06-outbound.js` 1；`02-ui-kit.js:206` 是一次转义后的字符串值，非包装，保留 |
| 3.3 行错误提示 | 新增 `App.clearLineErrors(rootSel, qtySel)` / `App.showLineError(rootSel, qtySel, tipAttr, idx, msg, withToast)`（`02-ui-kit.js`）；入库/采购只保留传参包装，**入库专属的 toast 通过 `withToast=true` 保持原行为** |
| 3.4 状态徽标 | 新增 `App.badgeHtml(cls, label)` 基元，`statusBadge` / `docStatusBadge` / `qDocStatusBadge` 及用户管理页状态列统一走该基元，标签映射与 DOM 结构不变 |
| 3.5 后端鉴权 | 新建 `server/middleware/doc-permission.js`，`createDocPermissions()` 工厂注入表名、默认业务类型、模块映射；入出库各删 6 对重复中间件（报告列 5 对，另有 `requireTypeAction` 一对），统一产出错码与 404 放行规则不变；表名做白名单校验防 SQL 拼接 |
| 3.6 低优先级 | `09-admin.js` 两个局部箭头函数内联，状态列改用 `badgeHtml` |

**验证**：全部 JS `node --check` 通过；一次性 vm/工厂回归脚本覆盖 11 组行为（未登录 401、分模块授权、缺单放行、草稿/更正分权、错误码、光标定位、行错误提示与 toast 差异、转义等价、三种徽标 HTML），全部通过，脚本已删除。

**净效果**：新增 1 个中间件文件（114 行），11 个既有文件共删 235 行、新增 102 行。

### 9.6 未执行（待后续排期）

- **P3**：`renderInboundEditTable`（197 行）、`editInboundDoc`（168 行）等臃肿函数重构
- **7.1 的 `tools/check-unused.js` 自检脚本**：仍未新建（属机制建议，非 P2 本体；本次未扩大范围）
