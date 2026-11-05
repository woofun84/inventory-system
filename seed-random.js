/**
 * 随机数据生成器 —— 清空业务数据后重建一套"干净"的数据
 *
 * 设计目标：生成的数据必须满足系统的不变量，否则页面会出现莫名其妙的负库存或账实不符。
 *   1. 库存口径：on_hand = 期初 + Σ入库 − Σ出库 + Σ调整（按物料维度，系统已废弃库位分账）
 *   2. 任何时点出库 / 盘亏都不得击穿库存
 *   3. 入库/出库都落在「单据头 inbound_docs / outbound_docs + 明细行」模型上：
 *      明细行的 doc_no 指向单据头，且 status='posted' 才计入库存
 *   4. 采购订单的 order_qty 与实际到货量形成 全到/部分到/未到 三种状态
 *   5. 盘点按物料维度（不分库位），状态只有 draft / confirmed（已取消「作废」语义）
 *
 * 用法：
 *   node seed-random.js              # 用默认随机种子
 *   node seed-random.js 20261102     # 指定种子（同样的种子生成同样的数据）
 *
 * 保留不动：users（登录账号）、params / categories / units / destinations（基础配置）
 * 清空重建：materials suppliers inbound outbound purchase_orders order_lines contracts
 *           stock_adjustments stocktakes stocktake_lines stocktake_logs
 *           inbound_docs outbound_docs inbound_doc_logs outbound_doc_logs
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'inventory.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== 随机数（线性同余，可复现） ====================
let _seed = (Number(process.argv[2]) || 20261102) >>> 0;
function rnd() {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
const ri = (a, b) => Math.floor(rnd() * (b - a + 1)) + a;      // 闭区间整数
const rf = (a, b) => a + rnd() * (b - a);                        // 闭区间小数
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;
const round2 = n => Math.round(n * 100) / 100;
// Fisher-Yates 洗牌（原地打乱副本，不改原数组）
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function randDate(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return fmtDate(new Date(a.getTime() + Math.floor(rnd() * (b.getTime() - a.getTime() + 1))));
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

// ==================== 业务词库 ====================
const BRANDS = ['远东', '宝胜', '中天', '起帆', '金杯', '正泰', '德力西', '公牛', '飞利浦', '欧普', '西门子', '施耐德', '海康', '大华', '得力', '世达', '波斯'];

const CATALOG = {
  '电缆电线': {
    prefix: 'CB', unit: ['米', '卷'], base: 38,
    names: ['电力电缆', '铜芯电缆', '控制电缆', '铝芯电缆', '阻燃电缆', '耐火电缆', '橡套电缆', '屏蔽电缆'],
    specs: ['YJV 3×4+1×2.5 mm²', 'YJV 4×6 mm²', 'ZC-YJV 5×16 mm²', 'KVV 10×1.5 mm²', 'RVV 2×2.5 mm²', 'YJV 3×2.5 mm²'],
  },
  '桥架线管': {
    prefix: 'QJ', unit: ['米', '根'], base: 22,
    names: ['热镀锌桥架', '喷塑桥架', 'PVC线管', '金属线槽', '电缆沟盖板', '强弱电桥架', '穿线管'],
    specs: ['200×100×1.2 mm', '100×50×1.0 mm', 'DN25×1.5 mm', 'DN32×2.0 mm', '300×150×1.5 mm', 'DN50×2.5 mm'],
  },
  '配电设备': {
    prefix: 'PD', unit: ['台', '套', '个'], base: 320,
    names: ['配电柜', '动力柜', '控制箱', '断路器', '隔离开关', '避雷器', '接触器', '热继电器'],
    specs: ['GGD-01', 'XL-21', 'DW15-630', 'DZ47-63', 'CJX2-2510', 'NRB0-63', 'CJ20-63'],
  },
  '开关插座': {
    prefix: 'DJ', unit: ['个', '套'], base: 26,
    names: ['单联开关', '双联开关', '五孔插座', '七孔插座', '三极开关', '漏电保护器', '防溅插座'],
    specs: ['86型 10A', '86型 16A', '86型 五孔', '86型 七孔', '2P 32A', '2P 40A'],
  },
  '灯具照明': {
    prefix: 'RD', unit: ['套', '个'], base: 88,
    names: ['LED筒灯', 'LED面板灯', '工矿灯', '投光灯', '吸顶灯', '格栅灯盘', '应急灯'],
    specs: ['Φ90 18W', '300×300 36W', '100W LED', '150W LED', 'Φ400 24W', '600×600 40W'],
  },
  '弱电设备': {
    prefix: 'WJ', unit: ['台', '个', '套'], base: 260,
    names: ['网络摄像机', '硬盘录像机', '交换机', '无线AP', '视频门禁', '考勤机', '综合布线模块'],
    specs: ['400万 红外', '16路 硬盘机', '24口 千兆', '双频 吸顶', '单门 刷卡', '人脸 脱挂'],
  },
  '五金配件': {
    prefix: 'GJ', unit: ['个', '包', '套'], base: 12,
    names: ['膨胀螺栓', '不锈钢卡箍', '接线端子', '铜鼻子', '防水接头', '扎带', '角码'],
    specs: ['M8×60', 'DN20', 'DT-10', '双孔 6-10 mm²', 'PG9 尼龙', '4×200 mm', '40×40'],
  },
  '辅材耗材': {
    prefix: 'FC', unit: ['卷', '包', '箱', '只'], base: 32,
    names: ['绝缘胶带', '缠绕膜', '纸箱', '编织袋', '气泡膜', '标签纸', '封箱胶带'],
    specs: ['18m×18mm', '50cm×300m', '60×40×40 cm', '70×90 cm', '100cm×100m', '100×100 mm'],
  },
  '工具劳保': {
    prefix: 'GJ', unit: ['把', '套', '双'], base: 45,
    names: ['螺丝刀套装', '活动扳手', '钢丝钳', '水平尺', '绝缘手套', '安全帽', '劳保鞋'],
    specs: ['5件套', '12寸', '8寸', '600mm', '5kV 绝缘', '安全帽 ABS', '42码 防砸'],
  },
  '其他': {
    prefix: 'QT', unit: ['个', '批', 'kg'], base: 18,
    names: ['标准件', '密封胶', '清洁用品', '劳保手套', '包装膜', '标签机色带'],
    specs: ['M6×20 镀锌', '硅酮 透明', '工业级 5L', '丁腈 100只', '50cm×300m', '110mm×300m'],
  },
};

const SUPPLIER_TPL = [
  ['华通电气有限公司', '王经理'], ['中天电缆销售部', '李经理'], ['宝胜电缆经销商', '张工'],
  ['正泰电器代理', '陈经理'], ['德力西电气办事处', '刘工'], ['公牛插座专营', '赵经理'],
  ['欧普照明经销商', '孙经理'], ['海康威视代理商', '周经理'], ['世达工具行', '吴老板'],
  ['得力办公用品', '郑经理'], ['远东电缆直销部', '钱经理'], ['施耐德电气部', '冯工'],
  ['金杯电缆专卖', '蒋经理'], ['安泰建材五金', '沈老板'], ['宏发机电设备', '韩经理'],
];

const HANDLERS = ['张仓管', '李库管', '王验收', '赵发货', '孙盘点', '周主管', '吴收货'];
const RECEIVERS = ['陈工', '刘工', '黄工', '徐师傅', '何工', '马工'];
const REMARKS = ['常规采购', '项目配套', '紧急补货', '备库存货', '返修补料', '年度集采', '零星采购', '工程余料', ''];

// ==================== 1. 清空业务数据 ====================
console.log('清空业务数据...');
// 删除顺序：先子表后父表（外键约束 ON）
const TABLES = [
  'stocktake_logs', 'stocktake_lines', 'stocktakes', 'stock_adjustments',
  'order_lines', 'purchase_orders', 'contracts',
  'inbound_doc_logs', 'outbound_doc_logs',
  'inbound_docs', 'outbound_docs',
  'inbound', 'outbound',
  'materials', 'suppliers',
];
const wipe = db.transaction(() => {
  TABLES.forEach(t => db.prepare(`DELETE FROM ${t}`).run());
  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN
    ('stocktake_logs','stocktake_lines','stocktakes','stock_adjustments','order_lines','purchase_orders','contracts',
     'inbound_doc_logs','outbound_doc_logs','inbound','outbound','materials','suppliers')`).run();
});
wipe();

// ==================== 2. 读取基础配置 ====================
const categories = db.prepare('SELECT name, prefix FROM categories ORDER BY id').all();
const units = db.prepare('SELECT name FROM units ORDER BY id').all().map(r => r.name);
const destinations = db.prepare('SELECT name FROM destinations ORDER BY id').all().map(r => r.name);

// ==================== 3. 生成物料 ====================
console.log('生成物料档案...');
const materials = [];
let matSeq = {};   // prefix -> 下一个序号
categories.forEach(cat => {
  const tpl = CATALOG[cat.name];
  if (!tpl) return;
  const count = ri(3, 6);
  for (let i = 0; i < count; i++) {
    matSeq[cat.prefix] = (matSeq[cat.prefix] || 0) + 1;
    // 前缀可能自带尾部横杠（如「电缆电线」的前缀是 'CB-'），
    // 直接拼 '-' 会生成 'CB--001' 这种双横杠编码，与原始数据口径不符
    const pfx = cat.prefix.endsWith('-') ? cat.prefix : cat.prefix + '-';
    const code = `${pfx}${String(matSeq[cat.prefix]).padStart(3, '0')}`;
    const base = tpl.base * rf(0.8, 1.3);
    materials.push({
      code,
      name: pick(tpl.names),
      spec: pick(tpl.specs),
      category: cat.name,
      unit: pick(tpl.unit.filter(u => units.includes(u)).length ? tpl.unit.filter(u => units.includes(u)) : [units[0]]),
      opening_qty: chance(0.25) ? 0 : Math.round(rf(20, 260) / 10) * 10,
      opening_price: round2(base * rf(0.9, 1.15)),
      min_stock: Math.round(rf(10, 80) / 5) * 5,
      brand: pick(BRANDS),
      status: '',
    });
  }
});
// 2 个停用物料（无任何流水，不会在库存汇总里产生孤儿库存）
const disabled = materials.slice(-2);
disabled.forEach(m => { m.status = '停用'; m.opening_qty = 0; m.min_stock = 0; });

const insMat = db.prepare(`INSERT INTO materials (code,name,spec,category,unit,opening_qty,opening_price,min_stock,brand,status)
  VALUES (@code,@name,@spec,@category,@unit,@opening_qty,@opening_price,@min_stock,@brand,@status)`);
db.transaction(() => materials.forEach(m => insMat.run(m)))();

// ==================== 4. 生成供应商 ====================
console.log('生成供应商...');
const suppliers = SUPPLIER_TPL.map(([name, contact]) => ({
  name, contact,
  phone: `1${pick(['3', '5', '7', '8'])}${String(ri(100000000, 999999999))}`,
  remarks: pick(['长期合作', '年度协议价', '本地供应商', '需现款现货', '']),
}));
const insSup = db.prepare('INSERT INTO suppliers (name,contact,phone,remarks) VALUES (@name,@contact,@phone,@remarks)');
db.transaction(() => suppliers.forEach(s => insSup.run(s)))();

// ==================== 5. 逐物料模拟出入库与调整 ====================
// 事件统一建模：{ kind:'in'|'out'|'adj', date, qty(带符号影响库存), ... }
// 处理时按时间顺序扫描，用总量余额兜底：出库 / 盘亏都不得击穿库存（不再分库位）。
console.log('生成出入库流水与调整...');

const DATE_FROM = '2026-05-01';
// 流水结束日。注意两个约束：
//   1) 盘点单的日期必须晚于它 —— book_qty 取的就是「终态余额」，且盘点调整要落在台账最后一笔
//   2) 不能晚于今天 —— 否则会出现未来日期的流水
const DATE_TO = '2026-10-25';
const TODAY = '2026-11-02';   // 生成日（当天），任何流水都不得晚于它

const inboundRows = [];
const outboundRows = [];
const adjRows = [];

let grnSeq = {}, ginSeq = {};
// 单号格式必须与服务端运行时完全一致，否则用户在界面上手工新增单据时会撞号：
//   服务端 genGrnNo：GRN-YYYYMMDD-NNNN（采购退货用 RET- 前缀）
//   服务端 genGinNo：GIN-YYYYMMDD-NNNN（退库出库用 GIT- 前缀）
//   注：库存调整已并入盘点，调整流水无独立单号（用来源 stocktake_no 追溯）。
function nextNo(map, prefix, date) {
  const k = `${prefix}-${date.replace(/-/g, '')}`;
  map[k] = (map[k] || 0) + 1;
  return `${k}-${String(map[k]).padStart(4, '0')}`;
}

materials.forEach(m => {
  if (m.status === '停用') return;

  const events = [];
  const inCount = ri(4, 12);
  const outCount = ri(6, 20);
  const adjCount = ri(1, 4);
  const sizeFactor = m.opening_qty > 0 ? m.opening_qty / 100 : 1;

  // --- 入库计划 ---
  for (let i = 0; i < inCount; i++) {
    const date = randDate(DATE_FROM, DATE_TO);
    const qty = Math.max(5, Math.round(rf(20, 220) * sizeFactor / 5) * 5);
    const price = round2(m.opening_price * rf(0.92, 1.08));
    events.push({
      kind: 'in', date, qty, price,
      supplier: pick(suppliers).name,
      handler: pick(HANDLERS),
      remarks: pick(REMARKS),
      contract_no: 'HT-2026-' + pick(['A', 'B', 'C', 'D']),
      txn_type: '采购入库',
    });
  }

  // --- 出库计划 ---
  for (let i = 0; i < outCount; i++) {
    const date = randDate(DATE_FROM, DATE_TO);
    const qty = Math.max(1, Math.round(rf(5, 70) * sizeFactor / 5) * 5);
    events.push({
      kind: 'out', date, qty,
      destination: pick(destinations),
      receiver: pick(RECEIVERS),
      handler: pick(HANDLERS),
      remarks: pick(REMARKS),
      txn_type: '正常出库',
    });
  }

  // --- 手工调整计划 ---
  for (let i = 0; i < adjCount; i++) {
    const date = randDate(DATE_FROM, DATE_TO);
    const type = pick(['盘盈', '盘亏', '报废', '损耗', '其它']);
    const sign = (type === '盘盈') ? 1 : -1;
    events.push({
      kind: 'adj', date, qty: sign * Math.max(1, Math.round(rf(1, 12))),
      adj_type: type,
      reason: pick(['盘点修正', '破损报废', '领用溢出', '采购多计', '样品领用', '重量误差']),
      handler: pick(HANDLERS),
      remarks: pick(REMARKS),
    });
  }

  // --- 退货配对：入库后按比例退供应商（负数入库）；出库后按比例退库（负数出库）---
  // 注意：冲抵日期必须晚于原单，但不能晚于今天（不允许出现未来日期的流水）。
  // 若原单本身已接近今天，就跳过这次冲抵。
  const planned = events.filter(e => e.kind === 'in' || e.kind === 'out');
  planned.forEach(ev => {
    if (chance(0.18)) {
      const ratio = rf(0.15, 0.4);
      const backDate = addDays(ev.date, ri(2, 20));
      if (backDate > TODAY) return;                       // 冲抵会落到未来 → 放弃
      if (backDate <= ev.date) return;
      const back = {
        kind: ev.kind, date: backDate,
        qty: -Math.max(1, Math.round(ev.qty * ratio)),
        price: ev.kind === 'in' ? round2(ev.price * rf(0.95, 1.05)) : 0,
        supplier: ev.supplier, handler: pick(HANDLERS),
        destination: ev.destination, receiver: ev.receiver,
        remarks: '退货冲抵',
        txn_type: ev.kind === 'in' ? '采购退货' : '退库出库',
      };
      events.push(back);
    }
  });

  // --- 负数行独占日期 ---
  // 台账接口对同一天的流水固定按「入库 → 出库 → 调整」顺序累加结余。
  // 若负数行（采购退货 / 退库出库 / 盘亏）与该物料其它流水落在同一天，
  // 中间结余会被压成负数（期末虽平，过程却出现负库存）。
  // 因此把每个负数行挪到「该物料当天没有其它流水」的日子。
  const isNeg = ev => ev.qty < 0;
  const posDates = new Set(events.filter(ev => !isNeg(ev)).map(ev => ev.date));
  const claimed = new Set();
  events.filter(isNeg).forEach(ev => {
    if (!posDates.has(ev.date) && !claimed.has(ev.date)) { claimed.add(ev.date); return; }
    let d = ev.date, guard = 0;
    while ((posDates.has(d) || claimed.has(d)) && guard++ < 400) d = addDays(d, 1);
    if (d <= TODAY) { ev.date = d; claimed.add(d); }
    else claimed.add(ev.date);
  });

  // --- 按时间扫描，落地流水（总量口径，不分库位） ---
  events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let totalBal = m.opening_qty;
  let shippedTotal = 0;              // 累计出库量（用于限制退库，不能超过它）
  let totalCost = m.opening_qty * m.opening_price;

  events.forEach(ev => {
    if (ev.kind === 'in') {
      let q = ev.qty;
      if (q < 0) {  // 采购退货：扣减库存，不能超过现有库存
        q = -Math.min(Math.abs(q), totalBal);
        if (q === 0) return;
      }
      totalBal += q;
      totalCost += q * ev.price;
      inboundRows.push({
        date: ev.date,
        grn_no: nextNo(grnSeq, ev.txn_type === '采购退货' ? 'RET' : 'GRN', ev.date),
        code: m.code,
        qty: q, price: q < 0 ? -Math.abs(ev.price) : ev.price,
        supplier: ev.supplier, handler: ev.handler,
        remarks: ev.remarks, po_no: '', contract_no: ev.contract_no || '',
        txn_type: ev.txn_type,
      });
      return;
    }

    if (ev.kind === 'out') {
      let q = ev.qty;
      if (q < 0) {  // 退库出库：加回库存，但不能超过累计出库量
        q = -Math.min(Math.abs(q), shippedTotal);
        if (q === 0) return;
      } else {
        q = Math.min(q, totalBal);      // 出库不得超过现有库存
        if (q <= 0) return;
      }
      const cost = totalBal > 0 ? totalCost / totalBal : 0;
      totalBal -= q;
      totalCost -= q * cost;
      if (q > 0) shippedTotal += q;
      outboundRows.push({
        date: ev.date,
        gin_no: nextNo(ginSeq, ev.txn_type === '退库出库' ? 'GIT' : 'GIN', ev.date),
        code: m.code,
        qty: q, destination: ev.destination, receiver: ev.receiver,
        handler: ev.handler, remarks: ev.remarks,
        cost_price: round2(cost), txn_type: ev.txn_type,
      });
      return;
    }

    // --- 调整 ---
    let q = ev.qty;
    if (q < 0) {
      q = -Math.min(Math.abs(q), totalBal);   // 盘亏不能击穿库存
      if (q === 0) return;
    }
    totalBal += q;
    // 调整不参与成本核算（与系统口径一致），成本保持不变
    adjRows.push({
      date: ev.date, code: m.code,
      qty: q, adj_type: ev.adj_type, reason: ev.reason,
      remarks: ev.remarks, handler: ev.handler, stocktake_no: '',
    });
  });

  // --- 按最终库存回填最低库存线，让告警有层次 ---
  if (totalBal > 0 && chance(0.35)) {
    m.min_stock = Math.max(5, Math.round(totalBal * rf(1.1, 1.8) / 5) * 5);
  } else if (totalBal > 0) {
    m.min_stock = Math.max(5, Math.round(totalBal * rf(0.15, 0.6) / 5) * 5);
  }
});

// 回填 min_stock
const updMin = db.prepare('UPDATE materials SET min_stock=? WHERE code=?');
db.transaction(() => materials.forEach(m => updMin.run(m.min_stock, m.code)))();

// ==================== 6. 采购订单（用实际入库回填，形成三种到货状态） ====================
console.log('生成采购订单...');
// 先按入库日期把同一物料的入库归拢成批次
const poBatches = [];
const pool = inboundRows.filter(r => r.txn_type === '采购入库');
const byCode = new Map();
pool.forEach(r => {
  if (!byCode.has(r.code)) byCode.set(r.code, []);
  byCode.get(r.code).push(r);
});
// 随机挑 18 个批次作为订单来源
const picked = [];
for (let i = 0; i < 18 && pool.length; i++) {
  const idx = Math.floor(rnd() * pool.length);
  picked.push(pool.splice(idx, 1)[0]);
}
picked.forEach((first, idx) => {
  const date = first.date;
  const lines = [{ code: first.code, order_qty: Math.max(first.qty, Math.round(first.qty * rf(1, 1.6) / 5) * 5), order_price: first.price, received: first.qty }];
  // 同一订单再加 1-2 个物料行
  const extra = ri(0, 2);
  for (let k = 0; k < extra; k++) {
    const m2 = pick(materials.filter(m => m.status !== '停用' && m.code !== first.code));
    if (!m2) continue;
    const ord = Math.round(rf(20, 200) / 5) * 5;
    lines.push({ code: m2.code, order_qty: ord, order_price: round2(m2.opening_price * rf(0.95, 1.1)), received: 0 });
  }
  const sup = pick(suppliers).name;
  const poNo = `PO-2026-${String(idx + 1).padStart(3, '0')}`;
  const expected = addDays(date, ri(10, 60));
  poBatches.push({
    po_no: poNo, date, supplier: sup,
    contract_no: 'HT-2026-' + pick(['A', 'B', 'C', 'D']),
    project: pick(destinations),
    expected_date: expected,
    remarks: pick(REMARKS),
    manual_status: chance(0.12) ? pick(['已关闭', '已取消']) : '',
    lines,
  });
  // 把 first 这条入库挂到订单上
  first.po_no = poNo;
  first.contract_no = poBatches[poBatches.length - 1].contract_no;
});

// 再补 6 张「未到货」的订单（有明细但没有入库）
for (let i = 0; i < 6; i++) {
  const date = randDate(DATE_FROM, '2026-10-20');
  const lines = [];
  const cnt = ri(1, 3);
  for (let k = 0; k < cnt; k++) {
    const m2 = pick(materials.filter(m => m.status !== '停用'));
    lines.push({ code: m2.code, order_qty: Math.round(rf(30, 250) / 5) * 5, order_price: round2(m2.opening_price * rf(0.95, 1.1)), received: 0 });
  }
  poBatches.push({
    po_no: `PO-2026-${String(poBatches.length + 1).padStart(3, '0')}`,
    date, supplier: pick(suppliers).name,
    contract_no: 'HT-2026-' + pick(['A', 'B', 'C', 'D']),
    project: pick(destinations),
    expected_date: addDays(date, ri(15, 70)),
    remarks: pick(REMARKS),
    manual_status: chance(0.15) ? pick(['已关闭', '已取消']) : '',
    lines,
  });
}

const insPO = db.prepare(`INSERT INTO purchase_orders (po_no,date,supplier,contract_no,project,expected_date,remarks,manual_status)
  VALUES (@po_no,@date,@supplier,@contract_no,@project,@expected_date,@remarks,@manual_status)`);
const insOL = db.prepare(`INSERT INTO order_lines (po_no,code,order_qty,order_price,remarks,contract_no)
  VALUES (@po_no,@code,@order_qty,@order_price,@remarks,@contract_no)`);
db.transaction(() => {
  poBatches.forEach(p => {
    insPO.run(p);
    p.lines.forEach(l => insOL.run({
      po_no: p.po_no, code: l.code, order_qty: l.order_qty,
      order_price: l.order_price, remarks: '', contract_no: p.contract_no,
    }));
  });
})();

// 合同独立建表：把采购单/明细/入库上出现过的合同号补成档案，
// 否则「按合同查询」视图为空（合同是采购单 ↔ 明细多对多关系的实体依据）。
console.log('生成合同档案...');
const contractMap = new Map(); // contract_no -> supplier
const noteContract = (no, sup) => {
  const c = String(no || '').trim();
  if (c && !contractMap.has(c)) contractMap.set(c, sup || '');
};
poBatches.forEach(p => p.lines.forEach(l => noteContract(l.contract_no || p.contract_no, p.supplier)));
inboundRows.forEach(r => noteContract(r.contract_no, r.supplier));
const insContract = db.prepare(`INSERT OR IGNORE INTO contracts
  (contract_no,name,supplier,sign_date,amount,status,remarks,created_by,created_at)
  VALUES (@contract_no,@name,@supplier,@sign_date,@amount,'active',@remarks,'system',@created_at)`);
db.transaction(() => {
  [...contractMap.entries()].forEach(([no, sup]) => {
    insContract.run({
      contract_no: no, name: no + ' 采购合同', supplier: sup,
      sign_date: DATE_FROM, amount: 0, remarks: '演示数据', created_at: DATE_FROM + ' 09:00:00',
    });
  });
})();

// ==================== 7. 写入出入库与调整 ====================
// 明细行与单据头一一对应：doc_no 用明细单号（与服务端「老数据补建单据头」口径一致），
// status='posted' 才会计入库存（服务端库存统计只认已过账行）。
console.log('写入流水...');
const insIn = db.prepare(`INSERT INTO inbound (date,grn_no,doc_no,code,qty,price,supplier,handler,remarks,po_no,contract_no,txn_type,status)
  VALUES (@date,@grn_no,@doc_no,@code,@qty,@price,@supplier,@handler,@remarks,@po_no,@contract_no,@txn_type,'posted')`);
const insOut = db.prepare(`INSERT INTO outbound (date,gin_no,doc_no,code,qty,destination,receiver,handler,remarks,cost_price,txn_type,status)
  VALUES (@date,@gin_no,@doc_no,@code,@qty,@destination,@receiver,@handler,@remarks,@cost_price,@txn_type,'posted')`);
const insAdj = db.prepare(`INSERT INTO stock_adjustments (date,code,qty,adj_type,reason,remarks,handler,stocktake_no,created_by)
  VALUES (@date,@code,@qty,@adj_type,@reason,@remarks,@handler,@stocktake_no,@created_by)`);
db.transaction(() => {
  inboundRows.forEach(r => insIn.run({ ...r, doc_no: r.grn_no }));
  outboundRows.forEach(r => insOut.run({ ...r, doc_no: r.gin_no }));
  adjRows.forEach(r => insAdj.run({ ...r, created_by: 'admin' }));
})();

// 到货精确核销：把带采购单号的入库行回填到对应采购明细行（order_line_id）。
// 与服务端 resolveOrderLineId 同口径：行合同号优先、空则回退单头默认合同；
// 未命中保持 0，服务端会回退「采购单 + 物料 + 合同」匹配。
db.prepare(`
  UPDATE inbound SET order_line_id = COALESCE((
    SELECT ol.id FROM order_lines ol
    JOIN purchase_orders po ON po.po_no = ol.po_no
    WHERE ol.po_no = inbound.po_no AND ol.code = inbound.code
      AND (TRIM(COALESCE(inbound.contract_no,'')) = ''
           OR (CASE WHEN TRIM(COALESCE(ol.contract_no,'')) <> '' THEN ol.contract_no ELSE COALESCE(po.contract_no,'') END) = ''
           OR inbound.contract_no = (CASE WHEN TRIM(COALESCE(ol.contract_no,'')) <> '' THEN ol.contract_no ELSE COALESCE(po.contract_no,'') END))
    ORDER BY ol.id LIMIT 1
  ), 0)
  WHERE po_no <> '' AND status = 'posted'
`).run();

// ==================== 7.5 入库/出库单据头 ====================
// 系统采用「单据头 + 明细行」模型：出入库列表页读的是 inbound_docs / outbound_docs，
// 明细行靠 doc_no 关联单据头。这里必须补上单据头，否则明细只在库存统计里生效、
// 却在出入库页面里看不到。单据头状态一律 'posted'（历史数据均已生效）。
console.log('生成出入库单据头...');
const insInDoc = db.prepare(`INSERT INTO inbound_docs
  (doc_no,date,txn_type,supplier,handler,po_no,contract_no,status,remarks,created_by,created_at,confirmed_by,confirmed_at)
  VALUES (@doc_no,@date,@txn_type,@supplier,@handler,@po_no,@contract_no,'posted',@remarks,@created_by,@created_at,'system',@confirmed_at)`);
const insOutDoc = db.prepare(`INSERT INTO outbound_docs
  (doc_no,date,txn_type,destination,receiver,handler,status,remarks,created_by,created_at,confirmed_by,confirmed_at)
  VALUES (@doc_no,@date,@txn_type,@destination,@receiver,@handler,'posted',@remarks,@created_by,@created_at,'system',@confirmed_at)`);
const insInLog = db.prepare("INSERT INTO inbound_doc_logs (doc_no,action,operator,detail) VALUES (?,?,?,?)");
const insOutLog = db.prepare("INSERT INTO outbound_doc_logs (doc_no,action,operator,detail) VALUES (?,?,?,?)");
// 单据时间戳：用日期 + 同日内递增的分钟，保证同一单据头 created_at/confirmed_at 自洽
const docStamp = (date, i) => `${date} 09:${String(i % 60).padStart(2, '0')}:00`;

db.transaction(() => {
  inboundRows.forEach((r, i) => {
    insInDoc.run({
      doc_no: r.grn_no, date: r.date, txn_type: r.txn_type, supplier: r.supplier,
      handler: r.handler, po_no: r.po_no, contract_no: r.contract_no,
      remarks: r.remarks, created_by: 'admin',
      created_at: docStamp(r.date, i), confirmed_at: docStamp(r.date, i),
    });
    insInLog.run(r.grn_no, 'create', 'admin', '创建入库单据');
  });
  outboundRows.forEach((r, i) => {
    insOutDoc.run({
      doc_no: r.gin_no, date: r.date, txn_type: r.txn_type, destination: r.destination,
      receiver: r.receiver, handler: r.handler, remarks: r.remarks, created_by: 'admin',
      created_at: docStamp(r.date, i), confirmed_at: docStamp(r.date, i),
    });
    insOutLog.run(r.gin_no, 'create', 'admin', '创建出库单据');
  });
})();

// ==================== 8. 盘点单 ====================
// 4 种形态，覆盖所有状态与分支（系统只有 draft / confirmed，已移除「作废」）：
//   A. 已确认（有差异）—— 差异行生成调整流水，与盘点单 stocktake_no 严格对应
//   B. 草稿（部分已录）—— 录了实盘但未确认，无任何调整流水
//   C. 已确认（全无差异）—— 全部 matched，不产生调整流水
//   D. 草稿（全部未盘）—— count_qty 为 NULL，无任何调整流水
console.log('生成盘点单...');
const stSeq = {};
const stRows = [], stLineRows = [], stAdjRows = [], stLogRows = [];

function makeStocktake({ date, status, handler, remarks, lines }) {
  const k = date.replace(/-/g, '');
  stSeq[k] = (stSeq[k] || 0) + 1;
  const no = `ST-${k}-${String(stSeq[k]).padStart(4, '0')}`;
  stRows.push({
    stocktake_no: no, date, status,
    category_filter: '', load_scope: 'all',
    handler, remarks, created_by: 'admin',
    confirmed_at: status === 'draft' ? '' : `${date} 10:${String(ri(10, 59)).padStart(2, '0')}:00`,
  });
  lines.forEach(l => stLineRows.push({ stocktake_no: no, ...l }));
  // 操作日志（对齐出入库单据）：创建 → 载入清单 →（有实盘时）保存实盘 →（已确认时）确认
  stLogRows.push({ stocktake_no: no, action: 'create', operator: 'admin', detail: '创建盘点单' });
  stLogRows.push({ stocktake_no: no, action: 'load', operator: 'admin', detail: `全盘载入，共 ${lines.length} 项` });
  const counted = lines.filter(l => l.count_qty !== null && l.count_qty !== undefined).length;
  if (counted > 0) {
    stLogRows.push({ stocktake_no: no, action: 'save', operator: 'admin', detail: `保存实盘，${counted} 行` });
  }
  if (status === 'confirmed') {
    stLogRows.push({ stocktake_no: no, action: 'confirm', operator: 'admin', detail: '确认盘点' });
  }
  return no;
}

// 终态账面（物料维度）：code -> 数量，与系统「不分库位」口径一致
const balances = new Map();
materials.forEach(m => {
  let bal = m.opening_qty || 0;
  inboundRows.forEach(r => { if (r.code === m.code) bal += r.qty; });
  outboundRows.forEach(r => { if (r.code === m.code) bal -= r.qty; });
  adjRows.forEach(r => { if (r.code === m.code) bal += r.qty; });
  balances.set(m.code, bal);
});

// 取有账面库存的在用物料作为盘点候选（物料维度，不重复）
function stocktakeCandidates() {
  const cands = [];
  materials.filter(m => m.status !== '停用').forEach(m => {
    const bal = balances.get(m.code) || 0;
    if (bal > 0) cands.push({ code: m.code, bal });
  });
  return cands;
}

// 确认后：差异行落地为调整流水，并同步更新内存账面（供后续盘点取数）
function postDiffs(lines, date, no) {
  const diffLines = lines.filter(l => l.diff_qty !== 0);
  if (!diffLines.length) return;
  diffLines.forEach(l => {
    stAdjRows.push({
      date, code: l.code, qty: l.diff_qty,
      adj_type: l.diff_qty > 0 ? '盘盈' : '盘亏',
      reason: '盘点差异', remarks: `盘点单 ${no}`,
      handler: pick(HANDLERS), stocktake_no: no, created_by: 'admin',
    });
    balances.set(l.code, (balances.get(l.code) || 0) + l.diff_qty);
  });
}

// --- A. 已确认盘点（有差异，生成调整流水） ---
{
  const date = '2026-10-28';
  const cands = stocktakeCandidates();
  const chosen = [];
  const want = Math.min(cands.length, ri(10, 18));
  while (chosen.length < want && cands.length) {
    chosen.push(cands.splice(Math.floor(rnd() * cands.length), 1)[0]);
  }
  const lines = chosen.map(c => {
    const maxDelta = Math.max(1, Math.floor(c.bal * 0.3));
    const delta = ri(-maxDelta, maxDelta);
    const count = c.bal + delta;
    const diff = count - c.bal;
    return {
      code: c.code, book_qty: c.bal, count_qty: count,
      diff_qty: diff,
      status: diff === 0 ? 'matched' : 'adjusted',
      remarks: '',
    };
  });
  const no = makeStocktake({
    date, status: 'confirmed', handler: pick(HANDLERS),
    remarks: '月度抽盘', lines,
  });
  postDiffs(lines, date, no);
}

// --- B. 草稿盘点（部分已录实盘，未确认） ---
{
  const date = '2026-11-01';
  const cands = stocktakeCandidates();
  const lines = [];
  const cnt = Math.min(cands.length, ri(8, 14));
  for (let i = 0; i < cnt; i++) {
    const c = cands[Math.floor(rnd() * cands.length)];
    if (lines.some(l => l.code === c.code)) continue;
    const saved = chance(0.7);   // 70% 已录实盘，30% 留空 = 未盘
    if (saved) {
      const maxDelta = Math.max(1, Math.floor(c.bal * 0.2));
      const count = c.bal + ri(-maxDelta, maxDelta);
      const diff = count - c.bal;
      lines.push({ code: c.code, book_qty: c.bal, count_qty: count, diff_qty: diff, status: diff === 0 ? 'matched' : 'pending', remarks: '' });
    } else {
      lines.push({ code: c.code, book_qty: c.bal, count_qty: null, diff_qty: null, status: 'pending', remarks: '' });
    }
  }
  makeStocktake({ date, status: 'draft', handler: pick(HANDLERS), remarks: '年中盘点（进行中）', lines });
}

// --- C. 已确认盘点（账实一致，无差异无调整） ---
{
  const date = '2026-10-20';
  const cands = stocktakeCandidates();
  const lines = [];
  const cnt = Math.min(cands.length, ri(6, 12));
  for (let i = 0; i < cnt; i++) {
    const c = cands[Math.floor(rnd() * cands.length)];
    if (lines.some(l => l.code === c.code)) continue;
    lines.push({ code: c.code, book_qty: c.bal, count_qty: c.bal, diff_qty: 0, status: 'matched', remarks: '' });
  }
  makeStocktake({ date, status: 'confirmed', handler: pick(HANDLERS), remarks: '月末复盘', lines });
}

// --- D. 草稿盘点（全部未盘） ---
{
  const date = '2026-09-15';
  const cands = stocktakeCandidates();
  const lines = [];
  const cnt = Math.min(cands.length, ri(5, 10));
  for (let i = 0; i < cnt; i++) {
    const c = cands[Math.floor(rnd() * cands.length)];
    if (lines.some(l => l.code === c.code)) continue;
    lines.push({ code: c.code, book_qty: c.bal, count_qty: null, diff_qty: null, status: 'pending', remarks: '' });
  }
  const no = makeStocktake({ date, status: 'draft', handler: pick(HANDLERS), remarks: '季度复盘（进行中）', lines });
  // 草稿态增删物料行演示（对应新的 add / remove 操作日志）：
  // 先追加一个未在清单中的物料，再移除一行，与「草稿可增删物料行」的行为一致。
  const extra = cands.find(c => !lines.some(l => l.code === c.code));
  if (extra) {
    stLineRows.push({ stocktake_no: no, code: extra.code, book_qty: extra.bal, count_qty: null, diff_qty: null, status: 'pending', remarks: '' });
    stLogRows.push({ stocktake_no: no, action: 'add', operator: 'admin', detail: `添加物料 ${extra.code}` });
    const removed = lines[lines.length - 1];
    const idx = stLineRows.findIndex(r => r.stocktake_no === no && r.code === removed.code);
    if (idx >= 0) {
      stLineRows.splice(idx, 1);
      stLogRows.push({ stocktake_no: no, action: 'remove', operator: 'admin', detail: `移除物料 ${removed.code}` });
    }
  }
}

const insST = db.prepare(`INSERT INTO stocktakes (stocktake_no,date,status,category_filter,load_scope,handler,remarks,created_by,confirmed_at)
  VALUES (@stocktake_no,@date,@status,@category_filter,@load_scope,@handler,@remarks,@created_by,@confirmed_at)`);
const insSTL = db.prepare(`INSERT INTO stocktake_lines (stocktake_no,code,book_qty,count_qty,diff_qty,status,remarks)
  VALUES (@stocktake_no,@code,@book_qty,@count_qty,@diff_qty,@status,@remarks)`);
const insSTLog = db.prepare("INSERT INTO stocktake_logs (stocktake_no,action,operator,detail) VALUES (?,?,?,?)");
db.transaction(() => {
  stRows.forEach(r => insST.run(r));
  stLineRows.forEach(r => insSTL.run(r));
  stAdjRows.forEach(r => insAdj.run(r));
  stLogRows.forEach(r => insSTLog.run(r.stocktake_no, r.action, r.operator, r.detail));
})();

// ==================== 9. 校验不变量 ====================
console.log('\n===== 数据校验 =====');
const summary = db.prepare(`
  SELECT m.code, m.name, m.status, m.opening_qty,
         COALESCE((SELECT SUM(qty) FROM inbound WHERE code=m.code AND status='posted'),0) AS tin,
         COALESCE((SELECT SUM(qty) FROM outbound WHERE code=m.code AND status='posted'),0) AS tout,
         COALESCE((SELECT SUM(qty) FROM stock_adjustments WHERE code=m.code),0) AS tadj
  FROM materials m`).all();

let negTotal = 0;
summary.forEach(s => {
  const onHand = s.opening_qty + s.tin - s.tout + s.tadj;
  if (onHand < 0 && s.status !== '停用') negTotal++;
});

const orphanAdj = db.prepare("SELECT COUNT(*) c FROM stock_adjustments WHERE stocktake_no<>'' AND stocktake_no NOT IN (SELECT stocktake_no FROM stocktakes)").get().c;
const orphanIn = db.prepare('SELECT COUNT(*) c FROM inbound WHERE code NOT IN (SELECT code FROM materials)').get().c;
const orphanOut = db.prepare('SELECT COUNT(*) c FROM outbound WHERE code NOT IN (SELECT code FROM materials)').get().c;
const badPo = db.prepare("SELECT COUNT(*) c FROM inbound WHERE po_no<>'' AND po_no NOT IN (SELECT po_no FROM purchase_orders)").get().c;
const badOl = db.prepare('SELECT COUNT(*) c FROM order_lines WHERE po_no NOT IN (SELECT po_no FROM purchase_orders) OR code NOT IN (SELECT code FROM materials)').get().c;
const badStStatus = db.prepare("SELECT COUNT(*) c FROM stocktakes WHERE status NOT IN ('draft','confirmed')").get().c;
const orphanStLine = db.prepare('SELECT COUNT(*) c FROM stocktake_lines WHERE stocktake_no NOT IN (SELECT stocktake_no FROM stocktakes)').get().c;
const orphanStLog = db.prepare('SELECT COUNT(*) c FROM stocktake_logs WHERE stocktake_no NOT IN (SELECT stocktake_no FROM stocktakes)').get().c;
const badDocLink = db.prepare(`SELECT COUNT(*) c FROM inbound WHERE doc_no NOT IN (SELECT doc_no FROM inbound_docs)`).get().c
                 + db.prepare(`SELECT COUNT(*) c FROM outbound WHERE doc_no NOT IN (SELECT doc_no FROM outbound_docs)`).get().c;
const badContract = db.prepare(`SELECT COUNT(*) c FROM (
    SELECT contract_no FROM purchase_orders WHERE TRIM(COALESCE(contract_no,''))<>'' AND contract_no NOT IN (SELECT contract_no FROM contracts)
    UNION ALL SELECT contract_no FROM order_lines WHERE TRIM(COALESCE(contract_no,''))<>'' AND contract_no NOT IN (SELECT contract_no FROM contracts)
    UNION ALL SELECT contract_no FROM inbound WHERE TRIM(COALESCE(contract_no,''))<>'' AND contract_no NOT IN (SELECT contract_no FROM contracts))`).get().c;
const unlinkedIn = db.prepare("SELECT COUNT(*) c FROM inbound WHERE po_no<>'' AND status='posted' AND order_line_id=0").get().c;

console.log(`物料总数        ${materials.length}（其中停用 ${disabled.length}）`);
console.log(`库存为负的物料  ${negTotal}   ${negTotal === 0 ? '✅' : '❌'}`);
console.log(`孤儿调整流水    ${orphanAdj}   ${orphanAdj === 0 ? '✅' : '❌'}`);
console.log(`孤儿出入库      ${orphanIn + orphanOut}   ${orphanIn + orphanOut === 0 ? '✅' : '❌'}`);
console.log(`挂空单的入库    ${badPo}       ${badPo === 0 ? '✅' : '❌'}`);
console.log(`非法订单明细    ${badOl}       ${badOl === 0 ? '✅' : '❌'}`);
console.log(`非法盘点状态    ${badStStatus}   ${badStStatus === 0 ? '✅' : '❌'}`);
console.log(`孤儿盘点行      ${orphanStLine}   ${orphanStLine === 0 ? '✅' : '❌'}`);
console.log(`孤儿盘点日志    ${orphanStLog}   ${orphanStLog === 0 ? '✅' : '❌'}`);
console.log(`悬空明细行      ${badDocLink}   ${badDocLink === 0 ? '✅' : '❌'}`);
console.log(`挂空合同        ${badContract}   ${badContract === 0 ? '✅' : '❌'}`);
console.log(`未精确核销入库  ${unlinkedIn}   （将按「采购单+物料+合同」三元组回退匹配）`);
console.log('');
console.log(`入库 ${inboundRows.length} 条 / 出库 ${outboundRows.length} 条 / 手工调整 ${adjRows.length} 条`);
console.log(`采购订单 ${poBatches.length} 张 / 合同 ${contractMap.size} 份 / 盘点单 ${stRows.length} 张 / 盘点行 ${stLineRows.length} 行 / 盘点调整 ${stAdjRows.length} 条`);
console.log('');
console.table(db.prepare('SELECT status, COUNT(*) c FROM stocktakes GROUP BY status').all());
console.table(db.prepare('SELECT txn_type, COUNT(*) c FROM inbound GROUP BY txn_type').all());
console.table(db.prepare('SELECT txn_type, COUNT(*) c FROM outbound GROUP BY txn_type').all());
console.table(db.prepare('SELECT adj_type, COUNT(*) c FROM stock_adjustments GROUP BY adj_type').all());

db.close();
console.log('\n✅ 数据生成完成');
