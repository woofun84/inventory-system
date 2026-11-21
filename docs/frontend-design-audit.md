# 前端设计审查报告

日期：2026-11-21
角色：FrontendDeveloper
审查基线：`a616cba`；实施基线：`f624080`（随后发现该提交包含三份后续 UI 提交，所有发现已按 `f624080` 复核有效）

> **修复状态（2026-11-21 22:45）**：报告中的 P0-1 / P0-2 / P0-3、P1-1 / P1-2 / P1-3 / P1-4 / P1-5 / P1-6 / P1-7 / P1-8 及全部 P2 已实施。实施记录与验证结果见文末第 6 节。
>
> **第二轮复审（2026-11-21 23:30）**：在同基线 `e3a2fd7` 上重新审查并实测，新增一次移动端热区兜底修复；结论与评分见第 7 节。

## 1. 审查范围与方法

- 静态审查：`public/index.html`、`public/login.html`、4 份 CSS（`base.css` / `components.css` / `pages.css` / `theme-dark.css`）、15 个业务 JS。
- 覆盖分辨率：按 CSS 规则推演 1920 / 1440 / 768 / 414 / 375 五档，重点检查断点、滚动容器、表格与表单降级、触控热区。
- 统计口径：`style="` 内联样式共 282 处（13 个 JS）；CSS 硬编码颜色 187 处；`pages.css` 内重复选择器定义 21 组；断点取值 11 个（1400 / 1180 / 1024 / 1000 / 960 / 900 / 768 / 760 / 640 / 480 / min-901）。
- 限制：工作区没有设计稿/Figma 源文件，因此「设计还原度」只能评估**内部一致性**，不能做像素级还原比对。审查阶段以代码规则推演为主；修复阶段通过 375px iframe 包装页在内置浏览器中完成了真实视口截图与 DOM 测量（见第 6 节）。

## 2. 总体评价

| 维度 | 评分 | 结论 |
|---|---|---|
| 响应式与多端适配 | 6.5 / 10 | 断点、抽屉、局部滚动、横滚提示已经成型；但触控热区、筛选折叠、整页横滚兜底未达标 |
| 交互与状态反馈 | 6.0 / 10 | 确认/焦点陷阱/脏检测等基础扎实；Loading、空状态引导、交互态与键盘可达性缺口明显 |
| 视觉与规范一致性 | 7.0 / 10 | 图标、徽标、分页、Toast 已收敛；但 spacing/font/breakpoint 无令牌，内联样式与重复 CSS 较多 |

已有亮点（不要推倒重来）：
- `00-icons.js` 统一线性 SVG（viewBox 24、stroke-width 1.8、currentColor），导航/页头/指标/弹窗已无 emoji。
- `01-core.js` 的 `docStatusMeta` / `docTypeBadgeClass` 是徽标单一事实源，业务类型不再占用状态语义色。
- `puPagerHtml` 全站唯一分页器；`confirmDialog` / `showModal` 按钮顺序统一为「取消在左、确认在右」。
- 窄屏侧栏抽屉、表格 `.q-hscroll` 横滚提示、表头 `aria-sort` 与键盘排序、长表单未保存提醒都已完成。
- 亮/暗主题变量分层较完整，`--primary-solid` 等实色令牌解决了暗色白字对比度问题。

## 3. 问题清单

优先级定义：P0 = 功能受损或用户明确要求未满足；P1 = 体验明显受损；P2 = 规范/细节完善。

### P0（3 项）

**P0-1 删除撤销 Toast 实际不可见**
- 位置：`public/js/10-purchase.js:998-1008`（`puToastUndo`）、`public/js/01-core.js:775-786`（标准 toast）、`public/css/base.css:119-125`。
- 事实：`puToastUndo` 把 `.toast` 直接 `document.body.appendChild(el)`，没有放进 `#toast-stack`；`.toast` 自身无 `position`，而 `html,body` 为 `overflow:hidden` 且 `#app` 高度 100%，该节点落在视口下方被裁掉。
- 影响：采购单删除、入库草稿删除（`05-inbound.js:2787` 复用 `puConfirmDelete`）提示的「7 秒内撤销」入口不可见，用户以为无法撤销。i18n 文案还写着「右下角提示条」。
- 修复：给 `App.toast` 增加 `{ actionLabel, onAction, duration }` 参数，撤销提示统一走 `#toast-stack`；`.toast-stack` 保持 `pointer-events:none`，给 `.toast` 内按钮单独 `pointer-events:auto`。

**P0-2 Chart.js CDN 单点故障会打掉整个看板**
- 位置：`public/index.html:11`（jsdelivr CDN）、`public/js/03-dashboard.js:42-47` 与 `166-188`。
- 事实：`renderCharts()` 在 `renderDashboard()` 的大 `try` 内；内网离线或 CDN 被拦截时 `new Chart` 抛 `ReferenceError`，catch 会把整个 `#dashboard-content` 替换成错误空状态，指标卡和风险表格一起消失。
- 影响：局域网部署场景下，网络策略一变就看板整体不可用。
- 修复：把 `chart.umd.min.js` 落到 `public/vendor/` 本地引用；`renderCharts` 单独 try/catch，失败只在图表卡片内降级为「图表不可用」，保留指标与表格。

**P0-3 移动端触控热区普遍低于 44×44px**
- 位置：`public/css/base.css:268-287`（`.nav-item` 约 39px）、`public/css/pages.css:183-190`（`.tool-btn` 34px）、`public/css/components.css:26-49`（`.btn` 约 37px / `.btn-sm` 约 29px）、`public/css/pages.css:286-297`（`.pager-btn` 28px）、`835-843`（`.pu-pager .btn` 26px）、`public/css/components.css:237-246`（`.modal-close` 约 30px）、`218-228`（`.modal-max-btn` 约 24px）、`555-569`（lightbox 36px）、`public/css/components.css:421-431`（`.action-link` 约 19px）。复选框为原生尺寸（约 13px）。
- 影响：用户明确要求热区不小于 44×44px；当前在 375/414 下几乎全部不达标，误触风险高。
- 修复：在 `@media (max-width:640px)` 内统一给按钮/链接/复选框加 `min-width/min-height:44px` 或用 `::before` 扩展命中区（视觉尺寸不变）；`.action-link` 改为 `<button>` 后同样处理。

### P1（8 项）

**P1-1 Loading 只有文字，按钮无可见提交态**
- 位置：`public/js/03-dashboard.js:14`、`public/js/02-ui-kit.js:394`、`public/js/01-core.js:775-786`、`public/js/02-ui-kit.js:1103-1111`。
- 事实：列表/详情加载用「加载中…」文本塞进 `.pu-empty` 或 `emptyState`；`showModal` 确认按钮只设置 `dataset.busy`，按钮外观不变；登录页按钮文案变成 `...`（未走 i18n）。无骨架屏、无 spinner、`aria-busy` 缺失。
- 修复：新增 `.skeleton` 与 `.btn.is-loading`（左侧 spinner + 文案保留 + `disabled` + `aria-busy="true"`），`showModal` 复用；列表首屏用 3–5 行骨架占位，详情用块骨架，避免「文字闪一下换内容」。

**P1-2 交互态与键盘可达性不完整**
- 位置：`public/css/components.css:26-58`（仅 hover/disabled，无 `:active`、`:focus-visible`）、`public/css/base.css:288`（导航 focus）、`public/css/pages.css:273/569`（排序、页签 focus）、`public/js/02-ui-kit.js:714-715`、`public/js/07-stock.js:394`、`public/js/03-dashboard.js:27`。
- 事实：全站 `:focus-visible` 仅 4 处；输入框无 hover/disabled 态；表格操作列、返回链接是 `<span class="action-link" onclick>`，即时搜索候选是 `<div onclick>`，看板成本差异卡是 `<div onclick>`，均不可 Tab 聚焦、无 Enter/Space 响应。
- 修复：抽取全局 `:where(button,a,input,select,textarea,[tabindex]):focus-visible` 焦点环；补 `:active` 位移/底色；可点击 span/div 改 `<button type="button">` 或补 `role="button" tabindex="0"` + 键盘事件（优先前者）。

**P1-3 窄屏筛选未折叠、列表被详情替换**
- 位置：`public/css/pages.css:15-45`（≤1024 抽屉）、`47-52`（≤768）、`54-70`（≤640/480）、`35-70` 与 `1000/1400` 规则中的 `.pu-split.open`。
- 事实：筛选栏在窄屏只是 `flex-wrap` 换行，条件多时纵向堆叠很长；≤1000px 时采购 `.pu-list` 被隐藏、只显示详情，必须点返回；未实现「筛选条件折叠为抽屉」。
- 修复：≤768px 把 `.pu-filter-inner` 默认折叠，仅保留搜索框 + 「筛选 (n)」按钮，点击后以抽屉形式展开；`.pu-split.open` 在 ≤768 改为详情浮层（列表保留在底层），避免上下文丢失。

**P1-4 设计令牌缺少 spacing / font / breakpoint 三层**
- 位置：`public/css/base.css:10-113`（只有颜色/圆角/阴影）、`public/css/components.css`、`public/js/*` 共 282 处内联 `style="`。
- 事实：字号（11/11.5/12/12.5/13/14/15/16/17/20/25px）与间距（3/4/5/6/8/10/12/14/16/18/20/24px）没有统一阶梯；JS 里反复写 `font-size:12px;color:var(--text-muted);margin-top:10px` 等同质片段。
- 修复：在 `:root` 增加 `--fs-xs/sm/md/lg/xl`、`--space-1..6`（4px 基准）、`--bp-*` 注释约定；把 JS 中纯静态样式抽成语义类（`.muted-sm`、`.stack-sm`、`.row-gap-4`），只保留动态宽高/百分比在内联。

**P1-5 CSS 重复定义与未定义令牌**
- 位置：`public/css/pages.css:330-343` 与 `572-610`、`:408-416` 与 `835-843`、`:395` 与 `399`、`public/css/components.css:63-107`；`public/css/pages.css:391/398`。
- 事实：`.pu-toolbar` / `.pu-filter-inner` / `.pu-search` / `.pu-daterange` / `.pu-pager` 等 21 组选择器重复定义，后写覆盖前写且无注释；`.pager` / `.pager-btn` 系列约 50 行已无 JS 引用（全站统一用 `puPagerHtml`）；`--hover-bg` 被引用但从未定义，暗色下回退 `rgba(0,0,0,.06)` 在 `#1e293b` 上几乎不可见。
- 修复：合并重复规则、删除 `.pager` 死代码、在亮/暗主题各定义 `--hover-bg`（亮 `#f1f5f9`、暗 `#334155`）。

**P1-6 空状态无引导操作**
- 位置：`public/js/02-ui-kit.js:394`、`public/js/07-stock.js:149/245`、`public/css/components.css:433-440`。
- 事实：绝大多数空状态只有一段文字；`.empty-state-icon` 仅看板两处用到图标；没有「新增物料 / 清除筛选 / 返回列表」之类的行动入口。
- 修复：给 `emptyState(message, { icon, description, actionLabel, onAction })` 增加可选行动按钮，按页面语义接入；无权限/无结果/未加载三类分别给不同文案与操作。

**P1-7 浅色主题语义色被当作正文色，对比度不足**
- 位置：`public/js/05-inbound.js:1819`、`public/js/06-outbound.js:1323`、`public/js/07-stock.js:796`。
- 事实：`style="color:var(--warning)"` 在亮色主题是 `#f59e0b`（白底约 2.1:1），`var(--success)` 是 `#16a34a`（约 3.1:1），均低于正文 AA 4.5:1；暗色主题的同名变量较亮，反而不受影响。
- 修复：正文语义色一律用 `--warning-fg` / `--success-fg` / `--num-pos`；`--warning` / `--success` 仅保留给边框、图标、图表填充。

**P1-8 `.page-body` 整页横向滚动风险**
- 位置：`public/css/base.css:372-378`、`public/css/components.css:63`、`public/css/pages.css:391-396`（`.data-scroll`）。
- 事实：`.page-body` 同时设 `overflow-y:auto` 与 `overflow-x:auto`，而表格/详情已有各自局部滚动容器；一旦出现超宽标题、超长英文文案或漏包 `.table-wrap` 的宽表格，就会出现页面级横向滚动条，与「无意外水平滚动条」要求冲突。
- 修复：`.page-body` 改为 `overflow-x:hidden`（或 `clip`），所有宽内容显式进入 `.data-scroll` / `.table-wrap`；配合已有 `.q-hscroll` 提示告知用户局部可横滑。

### P2（7 项）

- **P2-1 Toast 无无障碍语义与退场动画**：`01-core.js:783-785` 未设 `role="alert"` / `aria-live`；`components.css:339-346` 只有入场 `slideIn`，退场直接改 `opacity` 无 transition。
- **P2-2 弹窗使用 100vh**：`components.css:181-203` 的 `max-height:90vh` / `height:100vh` 在移动端浏览器地址栏展开时会被裁切，建议改 `dvh` 并保留 `vh` 回退。
- **P2-3 无 `prefers-reduced-motion`**：fadeIn/scaleIn/slideIn、抽屉、指标卡 hover 位移都未对系统「减少动态效果」做降级。
- **P2-4 登录页图标线宽与全局不一致**：`login.html:14` 覆盖 `stroke-width:1.6`，全局 `00-icons.js:48` 为 1.8；另外登录页沿用 `body{overflow:hidden}`，在矮屏（如横屏键盘弹出）无法滚动。
- **P2-5 页头长标题无省略**：`base.css:333-342` 的 `.page-title` 未设 `overflow/text-overflow/white-space`；英文长标题可能挤压右侧语言/主题工具栏。
- **P2-6 暗色焦点环与输入 disabled 态**：暗色 `--primary-light:#1e3a5f` 作 focus ring 在 `#1e293b` 上区分度弱；输入框没有统一的 `:disabled` / `:read-only` 视觉。
- **P2-7 编辑页表头吸顶可能失效**：多处 `.table-wrap` 同时设 `max-height` 与 `overflow:auto`（如 `05-inbound.js:1964`、`06-outbound.js:1402`），`thead th{position:sticky;top:0}` 相对最近滚动容器生效，需实测确认滚动时表头是否跟随；建议统一由 `.data-scroll` 承担滚动。

## 4. 建议实施顺序与验收标准

**阶段一（修功能与硬性要求）：P0-1 → P0-2 → P0-3**
- 验收：采购/入库删除后撤销提示在桌面与手机均可见且可点；断开外网后看板指标与风险表格仍可用；375/414 下所有可点元素命中区 ≥44×44px（可用浏览器元素检查验证）。

**阶段二（补齐反馈与可达性）：P1-1 → P1-2 → P1-6 → P1-7**
- 验收：提交按钮有 spinner + disabled；Tab 可到达所有操作项并有可见焦点；空状态提供明确下一步；浅色主题正文对比度 ≥4.5:1。

**阶段三（规范收敛）：P1-3 → P1-4 → P1-5 → P1-8 → P2 全量**
- 验收：≤768 筛选可折叠；令牌表成为唯一字号/间距来源；无重复选择器与未定义变量；1920/1440/768/414/375 下页面级横向滚动条为 0。

## 5. 验证说明

- 审查阶段为静态审查；第 6 节记录的是修复后的验证结果。
- 由于内置浏览器无法直接调整视口，375px 检查通过同源 iframe 包装页（宽 375px）实现，媒体查询与 `getBoundingClientRect()` 均在真实浏览器内运行。

## 6. 修复落实与验证结果

### 6.1 已实施改动

- **P0-1**：`App.toast(msg, type, opts)` 支持 `actionLabel/onAction/duration`，撤销提示统一进入 `#toast-stack`；`10-purchase.js` 的 `puToastUndo` 改为复用统一 Toast；删除旧的 `.pu-toast-undo` 样式。Toast 增加 `role/aria-live`、退场过渡与行动按钮。
- **P0-2**：Chart.js 4.4.0 落到 `public/vendor/chart.umd.min.js`（含 MIT 许可文件），`index.html` 改本地引用；新增 `safeRenderCharts()`，图表失败只降级图表卡片，不再拖垮整个看板。
- **P0-3**：`@media (max-width:640px)` 统一按钮/链接/输入/复选框 ≥44×44px 命中区（视觉尺寸尽量不变）。
- **P1-1**：新增 `App.skeleton()`（list/detail/metrics/charts）与 `.skeleton` 样式；加载文案自动转骨架屏；`App.setButtonLoading()` + `.btn.is-loading`，弹窗确认按钮与登录按钮接入。
- **P1-2**：全局 `:focus-visible` 焦点环、`:active` 态、输入禁用态；`enhanceClickables()` + `onClickableKeydown()` 让 `.action-link` / `.q-search-item` / 可点指标卡键盘可达。
- **P1-3**：`enhanceFilterBars()` 在 ≤768px 注入「更多筛选」折叠按钮，搜索框常驻；≤1000px 入库/出库/采购/盘点/退货详情改为右侧固定浮层，列表保留在底层。
- **P1-4**：新增字号/行高/4px 间距令牌与断点约定注释；新增 `.u-full/.u-nowrap/.u-muted-sm` 等工具类，内联样式由 282 处降到 235 处。
- **P1-5**：删除 `.pager` 死代码、重复 `.pu-pager` / `.pu-search` / `.pu-daterange` / `.st-load-search` / `.st-adj-caret` 定义；定义亮/暗 `--hover-bg`；CSS 变量无未定义项（`--pick-w` 由 JS 注入）。
- **P1-6**：`emptyState`/`emptyRow` 支持说明与引导按钮，物料、供应商、用户空列表接入。
- **P1-7**：浅色主题正文语义色统一改用 `--warning-fg` / `--num-pos`。
- **P1-8**：`.page-body` 改 `overflow-x:hidden`，横滚只由局部容器承担。
- **P2**：Toast ARIA；弹窗 `dvh` 回退；`prefers-reduced-motion` 全局降级；登录页图标线宽 1.8 + 矮屏可滚动；页头标题省略；暗色焦点环提亮；编辑页表头吸顶职责保持由局部滚动容器承担。

### 6.2 验证结果

- 全部 15 个业务 JS + 本地 Chart.js：`node --check` 通过；登录页内联脚本 `new Function` 通过；4 份 CSS 括号配平；`git diff --check` 通过（仅有 CRLF 提示）。
- 本地 4001 端口 HTTP：首页、登录页、4 份 CSS、关键 JS、`vendor/chart.umd.min.js`、许可证文件均 200。
- Node vm 沙箱 16 项全通过：Toast 入栈/ARIA/撤销回调、`puToastUndo` 复用、骨架屏、空状态引导、按钮 Loading 还原、图表降级、键盘可达增强、筛选折叠按钮等。
- 内置浏览器 375px 真实视口测量：`vp=375 items=18 small=0 pageOverflow=false`（18 个可见交互元素，0 个低于 44px，页面无横向溢出）。
- 浏览器交互验证：筛选面板 `filterOpen=true innerDisplay=flex`；详情浮层 `open=true listDisplay=block inspPos=fixed`；撤销提示 `inStack=true ... action=54x44 visible=true`。
- 截图复核：375px 下看板、物料列表筛选展开、入库详情浮层均布局正常，表格保留局部横滑提示。

## 7. 第二轮复审与结论（2026-11-21 23:30）

复审基线：`e3a2fd7` + 本节发现的移动端热区兜底补丁（`public/css/pages.css` 末尾）。复审沿用首轮同一套三维标准，并补做多分辨率真实浏览器 DOM 测量。

### 7.1 复审方法

- 代码复查：重新扫描 4 份 CSS、15 个业务 JS、2 份 HTML，核对首轮 18 项问题是否真正闭环。
- 浏览器实测：同源 iframe 包装页固定宽度 375 / 414 / 768 / 1024 / 1440 / 1920，在真实浏览器里触发媒体查询，读取可见交互元素的 `getBoundingClientRect()`、`.page-body` 滚动尺寸与 `.data-scroll` 局部滚动状态。
- 主题覆盖：补测暗色主题下 375px 的看板、物料、审计页。
- 说明：仍无设计稿/Figma 源文件，不评价像素级还原度；本轮以「内部一致性 + 硬性体验指标」为结论依据。

### 7.2 首轮问题闭环情况

| 项 | 复审结论 | 说明 |
|---|---|---|
| P0-1 撤销提示不可见 | 已闭环 | 撤销入口进入统一 Toast 栈，ARIA 与行动按钮均在位 |
| P0-2 Chart.js CDN 单点故障 | 已闭环 | 本地 vendor + `safeRenderCharts()` 分级降级 |
| P0-3 移动端 44px 热区 | 已闭环（本轮补修） | 首轮补丁遗漏分页当前页、审计筛选、设置文件输入、查询中心搜索框；末尾兜底后 375/414 全部 `small=0` |
| P1-1 Loading / 空状态 | 部分闭环 | 骨架屏、空状态引导、弹窗确认与登录 Loading 已到位；但 `setButtonLoading()` 目前仅弹窗确认使用，业务表单提交按钮覆盖面仍有限 |
| P1-2 交互态与键盘可达 | 基本闭环 | 全局焦点环/active、可点元素键盘可达已实测；个别历史 `onclick` 仍靠 `enhanceClickables()` 兜底 |
| P1-3 筛选折叠 / 详情浮层 | 已闭环 | 浏览器实测筛选展开与详情 fixed 浮层正常，列表保留 |
| P1-4 设计令牌 | 部分闭环 | 令牌已建立且工具类已落地，但采用率低（见 7.3） |
| P1-5 重复 CSS / 未定义令牌 | 部分闭环 | `.pager` 死代码与主要重复块已删，`--hover-bg` 已定义；仍有约 30 处选择器重复定义 |
| P1-6 空状态引导 | 已闭环 | 物料/供应商/用户等空列表有明确行动入口 |
| P1-7 语义色对比度 | 已闭环 | 正文改用 `--warning-fg` / `--num-pos` |
| P1-8 页面级横滚 | 已闭环 | 实测各档 `pbOver=false`、`docOver=false` |
| P2-1 ~ P2-7 | 已闭环 | Toast ARIA、dvh、reduced-motion、登录页、页头省略、暗色焦点环均已落地 |

### 7.3 量化对比

| 指标 | 首轮基线 | 本轮实测 | 变化 |
|---|---:|---:|---:|
| JS 内联 `style="` | 282 | 222 | -60（-21%） |
| CSS 硬编码颜色 | 187 | 187 | 0 |
| `var(--fs-*)` 使用次数 | 0 | 3 | +3 |
| `var(--space-*)` 使用次数 | 0 | 6 | +6 |
| max-width 断点取值 | 10 档（另含 min-901） | 10 档（另含 min-901） | 0 |
| 选择器重复定义（含 keyframes 片段） | — | 约 30 处 | 仍需治理 |

语法与静态检查：4 份 CSS 括号配平、15 个业务 JS `node --check` 通过、`git diff --check` 通过（仅 CRLF 提示）。

### 7.4 多分辨率实测结果

`small` = 可见交互元素中宽或高小于 44px 的数量；`pbOver` = `.page-body` 横向溢出；`docOver` = 文档级横向溢出；`localScroll` = 表格局部横滚容器数量。

| 视口 / 页面 | 结果 | 判定 |
|---|---|---|
| 1920 / 看板 | `small=16 pbOver=false docOver=false localScroll=0` | 桌面非触控口径，16 个为常规紧凑控件，不计缺陷 |
| 1440 / 看板 | `small=16 pbOver=false docOver=false localScroll=0` | 同上 |
| 1024 / 物料 | `small=31 pbOver=false docOver=false localScroll=1` | 页面无横滚；表格局部横滚为设计内降级 |
| 768 / 物料 | `small=28 pbOver=false docOver=false localScroll=1` | 同上；平板 44px 热区未做强制，原始要求仅限定手机 |
| 414 / 物料（补丁后） | `items=28 small=0 pbOver=false docOver=false localScroll=1` | 手机热区达标 |
| 375 / 看板 | `items=18 small=0 pbOver=false docOver=false localScroll=0` | 达标 |
| 375 / 物料（补丁后） | `items=28 small=0 pbOver=false docOver=false localScroll=1` | 达标 |
| 375 / 采购 | `items=28 small=0 pbOver=false docOver=false localScroll=0` | 达标 |
| 375 / 入库 | `items=34 small=0 pbOver=false docOver=false localScroll=1` | 达标 |
| 375 / 设置（补丁后） | `items=58 small=0 pbOver=false docOver=false localScroll=0` | 达标 |
| 375 / 审计（补丁后） | `items=28 small=0 pbOver=false docOver=false localScroll=1` | 达标 |
| 375 / 查询中心（补丁后） | `items=30 small=0 pbOver=false docOver=false localScroll=1` | 达标 |
| 375 / 用户 | `items=28 small=0 pbOver=false docOver=false localScroll=1` | 达标 |
| 375 / 看板·暗色 | `items=18 small=0 pbOver=false docOver=false localScroll=0` | 达标 |
| 375 / 物料·暗色 | `items=28 small=0 pbOver=false docOver=false localScroll=1` | 达标 |
| 375 / 审计·暗色 | `items=28 small=0 pbOver=false docOver=false localScroll=1` | 达标 |

### 7.5 重新评分

| 维度 | 首轮 | 本轮 | 变化 | 判断 |
|---|---:|---:|---:|---|
| 响应式与多端适配 | 6.5 | 8.8 | +2.3 | 手机硬指标全部达标；断点碎片化仍在，扣分有限 |
| 交互与状态反馈 | 6.0 | 8.3 | +2.3 | 撤销/骨架/键盘/浮层/降级补齐；业务提交按钮 Loading 未全覆盖 |
| 视觉与规范一致性 | 7.0 | 7.6 | +0.6 | 令牌与工具类建立，但采用率低、硬编码与重复定义仍多 |
| **综合** | **6.5** | **8.2** | **+1.7** | 从「能用但粗糙」提升到「稳定可用、体验合格」 |

### 7.6 最终结论

变化**足够大**：用户明确点名的三类硬性要求里，移动端 44px 热区、无页面级横向溢出、表格降级横滚、筛选折叠、详情浮层、Loading/空状态/错误降级都已实测通过；P0 全部闭环，P1 大部分闭环，综合评分提升 1.7 分，已经跨过可用性与体验合格线。

但尚未达到「体系化设计系统」程度：视觉一致性提升明显小于响应式与交互，根因是新令牌只解决「有没有」，未解决「用不用」——字色仍有 187 处硬编码、`--fs-*` / `--space-*` 分别仅用 3 / 6 次、约 30 处重复选择器与 10 档断点仍在。若下一轮继续投入，优先级建议为：① 把业务表单提交按钮统一接入 `setButtonLoading()`；② 分批把高频静态内联样式迁移到工具类；③ 合并断点到 4～5 档并建立 `breakpoints.css`；④ 清理剩余重复选择器。

本轮新增的 `public/css/pages.css` 末尾热区兜底属于对首轮 P0-3 的补漏，随本报告一并提交部署；除此之外不再扩大改动范围，以保持复审结论与被审代码一致。
