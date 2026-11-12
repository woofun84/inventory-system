# 成本核算规则

本文描述库存成本的存储方式、核算顺序、计价规则、尾差处理与重算机制。实现集中在 `server/services/costing.js`，库存可用量校验在 `server/services/stock.js`。

## 1. 数值存储与舍入

所有数量、单价、金额都以整数定点存储，避免浮点误差：

| 类型 | 比例 | 示例 |
| --- | --- | --- |
| 数量 | `1e6` | 存 `1500000` 表示 1.5 |
| 单价 | `1e8` | 存 `12345678` 表示 0.12345678 |
| 金额 | `1e2`（分） | 存 `12345` 表示 123.45 元 |

- 换算与舍入在 `services/units.js`，使用 BigInt 运算与 `ROUND_HALF_UP`。
- 金额由数量与单价推导：`amount = ROUND(qty × price / 1e12)`，结果单位为分。数据库中的生成列使用 `CAST(ROUND(qty * price / 1000000000000.0) AS INTEGER)`。
- 结存均价由结存金额与结存数量推导：`avg_cost = ROUND(balance_amount × 1e12 / balance_qty)`，结果单位为 `1e8` 定点单价。
- 业务代码读写的是「元 / 个」这类可读数值，`services/scaled-db.js` 在 SQL 层按列名自动完成定点换算。

## 2. 流水与余额

- `stock_ledger` 是成本核算的权威依据，按物料记录每一笔数量与金额变动。
- `stock_balance` 只是最新余额快照：`stock_qty`、`stock_amount`、`avg_cost`、`last_posting_sequence`。
- **只有 `costing.js` 可以写这两张表**。入库、出库、盘点调整、期初、更正都通过它生成流水，其他模块不得直接改余额。
- 流水关键字段：
  - `source_type`：`inbound` / `outbound` / `adjust` / `opening`
  - `business_type`：采购入库、零星入库、采购退货、正常出库、领料退库、盘点调整等
  - `qty_in` / `qty_out`、`amount_in` / `amount_out`、`unit_cost`
  - `balance_qty` / `balance_amount` / `balance_avg_cost`：该笔核算后的结存快照
  - `status`：`active` / `voided`
  - `cost_basis`：`CURRENT_AVG` / `HISTORICAL_AVG` / `NO_BASIS`
  - `correction_of`、`return_source_line_id`：更正链与退库原行

## 3. 核算顺序

同一物料内按以下顺序核算：

```
business_date（业务日期）
  → posting_time（过账时间）
  → id（流水自增主键）
```

- 该顺序固化为「同物料内」的 `posting_sequence`，重算时由 `renumberFrom` 重新编号。
- 新单据不是简单追加到末尾，而是按上述顺序定位插入点，再 `renumberFrom` + `recomputeFrom` 重算插入点之后的全部流水。这样补录历史单据也能得到正确成本。
- 重算范围是「该物料从插入点起」的全部有效流水，结束时刷新 `stock_balance`。

## 4. 移动加权平均

### 4.1 入库

入库按**行价**入账，不取当前均价：

```
amount_in = ROUND(qty_in × line_price / 1e12)
balance_qty    += qty_in
balance_amount += amount_in
balance_avg     = ROUND(balance_amount × 1e12 / balance_qty)
```

### 4.2 正常出库

出库按**核算时点的当前结存均价**计价：

```
amount_out = ROUND(qty_out × balance_avg / 1e12)
balance_qty    -= qty_out
balance_amount -= amount_out
```

出库行的 `cost_price` 会由核算结果回写 `outbound` 表，便于单据详情展示与按成本统计。

### 4.3 采购退货

采购退货是出库方向，但**按原采购行价冲减**，不重新取移动平均。流水 `qty_out` 为正、`amount_out = ROUND(qty_out × 原单价 / 1e12)`。

## 5. 成本依据 `cost_basis`

当出库 / 盘盈 / 无原单退库需要取成本，而当前结存不足以提供均价时，按以下优先级取数，并写入流水 `cost_basis`：

| 取值 | 条件 | 含义 |
| --- | --- | --- |
| `CURRENT_AVG` | 当前结存数量 > 0 | 取当前移动加权平均 |
| `HISTORICAL_AVG` | 当前结存为 0，但历史上出现过正库存 | 回退到最近一次正库存的结存均价 |
| `NO_BASIS` | 从未有过正库存 | 按 0 成本入账，必须由管理员显式确认 |

- `NO_BASIS` 未确认时抛错，错误码 `NO_COST_BASIS`，并带上物料与来源单据信息。
- 管理员确认通过 `acceptNoBasis` 参数传入；该参数只允许 `admin` 使用。
- 历史行重放遇到 `NO_BASIS` 不会阻断其他单据；只有本次新插入的流水才强制拦截。

## 6. 各业务场景计价汇总

| 场景 | 单价来源 |
| --- | --- |
| 采购入库 / 零星入库 | 入库行单价 |
| 采购退货 | 原采购行单价 |
| 正常出库 | 当前结存均价 `CURRENT_AVG` |
| 领料退库（有原单） | 原出库行实际计价单价，不写 `cost_basis` |
| 领料退库（无原单） | 当前均价 → 历史均价 → `NO_BASIS` |
| 盘盈 | 当前均价 → 历史均价 → `NO_BASIS` |
| 盘亏 | 当前结存均价 `CURRENT_AVG` |
| 期初结存 | 物料 `opening_price`，业务日期 `1970-01-01` |

## 7. 负库存

- 出库前置校验 `validateOutboundStock`：按批次累计同一物料的出库量，超出可用量即拒绝并返回明细（`requested` / `available` / `shortfall`）。
- 对「本次操作前可用量已经为负」的物料做豁免：属于历史遗留错账，允许继续出库 / 盘亏修正，避免无法修账；该豁免不会放过把正常库存出成负数的情况。
- 核算层兜底：`recomputeFrom` 中任一有效流水核算后 `balance_qty < 0`，抛 `INSUFFICIENT_STOCK`，整笔业务（含更正重算）回滚。
- 可用库存一律读 `stock_balance`，不由单据表现算。

## 8. 尾差与成本差异

移动平均在多次进出后，数量归零时金额可能残留少量尾差。处理规则：

1. 当 `balance_qty === 0` 且 `balance_amount !== 0` 时，把残值并入**触发清零的这笔流水**的金额（出库加到 `amount_out`，入库加到 `amount_in`），同时把 `balance_amount` 抹平为 0。
2. 不篡改历史单价，只调整本笔金额。
3. 残值写入 `cost_variances`，并绑定触发它的 `ledger_id` 与来源单据 / 行，不允许无来源条目。
4. 同时在 `inventory_recalc_logs` 写一条 `kind='tail-diff'` 记录，同一流水序号只记一次。
5. 差异原因按触发流水归类：`inbound`、`purchase_return`、`outbound`、`return_in`、`adjust`、`opening`、`other`。

### 差异台账的维护

- 「未结转差异」= 该流水当前核算出的残值 − 该流水历史上已结转金额。
- 平时只保留一条 `status='open'` 记录；数据库用部分唯一索引 `(ledger_id) WHERE status='open'` 保证。
- 已结转后又因补录 / 更正导致残值变化时，只把增量写成新的 `open` 记录，已结转快照不动。
- 残值回到 0 时删除未结转记录，已结转快照保留。
- 流水作废后不再产生残值：撤销其未结转差异；已结转的生成负数差异冲回。

### 期末结转

`POST /api/settings/cost-variance/settle`（仅 `admin`）把当前 `open` 记录批量置为 `settled`，写入 `settle_batch` 与 `settled_at`。结转只改状态，不动库存数量、金额与均价。

## 9. 重算、重建与期初

| 能力 | 行为 |
| --- | --- |
| `settle(code, ledgerIds, opts)` | 定位新流水插入点 → `renumberFrom` → `recomputeFrom`，刷新余额 |
| `recomputeFrom(code, fromSequence, opts)` | 从指定序号起重算该物料全部有效流水，回写出库成本，处理负库存与尾差 |
| `renumberFrom(code, fromSequence)` | 按核算顺序重排同物料 `posting_sequence` |
| `voidDocLedger(sourceType, docNo)` | 把单据流水置 `voided`，返回需要重算的锚点 |
| `rebuildAll()` | 全量重建库存流水与余额 |
| `ensureOpeningBalances()` | 把物料 `opening_qty` / `opening_price` 补成期初流水，业务日期 `1970-01-01` |
| `captureBalances()` | 重算结束后刷新 `stock_balance` 快照 |
| `logCorrection({...})` | 把更正重算的范围与前后余额写入 `inventory_recalc_logs` |

服务启动时会执行一次 `ensureOpeningBalances()`，保证「余额可由流水完整推导」。

## 10. 作废与更正对成本的影响

- 作废：原单流水 `status='voided'`，从锚点起重算，余额自动回滚；原单保留可追溯。
- 更正重开：原单作废 + 新修订单（`-R1` / `-R2`）重新过账，新旧流水都会参与重算，修订号不占用正常流水序号。
- 更正后若导致某物料在任一历史时点结存为负，整笔更正回滚并返回 `INSUFFICIENT_STOCK`。
- 重算会撤销已不成立的未结转差异；已结转差异用负数记录冲回。

## 11. 核对建议

- 库存数量核对：`stock_balance.stock_qty` 应等于该物料所有 `active` 流水的 `qty_in − qty_out`。
- 库存金额核对：`stock_balance.stock_amount` 应等于 `amount_in − amount_out` 的累计，且数量为 0 时金额为 0。
- 成本异常排查：先看 `cost_variances`（尾差）与 `inventory_recalc_logs`（重算 / 尾差留痕），再看对应 `stock_ledger` 行的 `cost_basis`。
- 单据成本核对：出库单行 `cost_price` 应等于同 `source_line_id` 的最新有效流水 `unit_cost`。
