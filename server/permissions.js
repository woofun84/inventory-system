/**
 * 角色与权限矩阵
 */
// ==================== 角色与权限矩阵 ====================
// 角色：admin 管理员 / manager 主管 / operator 操作员 / viewer 只读
// 权限粒度：模块 + 动作。单据类模块（入库、出库、退货与退库、采购、盘点）统一按业务动作划分：
//   view    查看
//   manage  建档/编辑草稿：建单、改单头、明细增行/改行/删行（不含整单删除）
//   delete  整单删除：只删整张草稿单，明细行删除归 manage
//   correct 更正：发起更正、编辑更正草稿、确认更正生效整条链路
//   void    整单作废：零行确认的作废，可单独授予，不要求 correct
//   post    过账：草稿态首次确认过账，已确认后的动作不走此位
//   modify  修改已确认单：已确认采购单再次编辑并保存，保存后仍为已确认，不退回草稿
// 各模块的动作子集：
//   inbound / outbound / returns — view/manage/delete/correct/void/post
//     returns 是独立模块：采购退货、零星退货、领料退库的读写都只校验 returns，
//     不叠加 inbound / outbound 权限。
//   stocktake — view/manage/delete/correct/post（无整单作废）
//   purchase — view/manage/delete/modify/post（采购单无更正、作废；modify 只管已确认单的再次编辑）
//   物料、供应商、参数、用户等其他模块维持 view/create/edit/delete 不变。
//   audit 的 delete 用于清空全部系统日志，默认只给管理员。
// 说明：独立的「库存调整」模块已取消，调整流水由盘点确认自动生成，
//      其只读查询挂在 stocktake 模块的 view 权限下。
// 规则（默认值只由角色定义生效，不做存量回填）：
//   admin — 全部权限
//   manager — 业务全权（入出库/退货退库/物料/采购管理/供应商/参数设置/盘点），不含用户管理
//   operator — 入库/出库/退货退库可建档、编辑草稿、过账、查看；
//              不能删除整单、不能更正（correct）、不能作废（void）；
//              采购可建档、编辑草稿、确认下单、查看，不能删除整单、不能修改已确认单；
//              不能新增物料/订单/供应商；
//              盘点可建单、录实盘，但不能确认过账、不能删除、不能更正差异
//   viewer — 纯只读
const ROLE_PERMISSIONS = {
  admin: ['*'],
  manager: {
    dashboard: ['view'],
    inbound: ['view', 'manage', 'delete', 'correct', 'void', 'post'],
    outbound: ['view', 'manage', 'delete', 'correct', 'void', 'post'],
    returns: ['view', 'manage', 'delete', 'correct', 'void', 'post'],
    materials: ['view', 'create', 'edit', 'delete'],
    suppliers: ['view', 'create', 'edit', 'delete'],
    purchase: ['view', 'manage', 'delete', 'modify', 'post'],
    query: ['view'],
    stocktake: ['view', 'manage', 'delete', 'correct', 'post'],
    settings: ['view', 'create', 'edit', 'delete'],
    audit: ['view'],
    price: ['view', 'edit'],
  },
  operator: {
    dashboard: ['view'],
    inbound: ['view', 'manage', 'post'],
    outbound: ['view', 'manage', 'post'],
    returns: ['view', 'manage', 'post'],
    materials: ['view'],
    suppliers: ['view'],
    purchase: ['view', 'manage', 'post'],
    query: ['view'],
    stocktake: ['view', 'manage'],
  },
  viewer: {
    dashboard: ['view'], inbound: ['view'], outbound: ['view'], returns: ['view'], materials: ['view'],
    suppliers: ['view'], purchase: ['view'],
    query: ['view'],
    stocktake: ['view'],
  },
};

// 全部模块（顺序即用户管理页权限矩阵的展示顺序）
// price 是「价格」分组：view 控制价格/金额可见，edit 控制价格类字段可写，两者独立
const MODULES = ['dashboard', 'inbound', 'outbound', 'returns', 'materials', 'price', 'suppliers',
  'purchase', 'query', 'stocktake', 'settings', 'users', 'audit'];

// 各模块的动作全集（与后端 requirePerm 实际用到的动作保持一致，也是用户管理页勾选项）
const MODULE_ACTIONS = {
  dashboard: ['view'],
  inbound: ['view', 'manage', 'delete', 'correct', 'void', 'post'],
  outbound: ['view', 'manage', 'delete', 'correct', 'void', 'post'],
  returns: ['view', 'manage', 'delete', 'correct', 'void', 'post'],
  materials: ['view', 'create', 'edit', 'delete'],
  price: ['view', 'edit'],
  suppliers: ['view', 'create', 'edit', 'delete'],
  purchase: ['view', 'manage', 'delete', 'modify', 'post'],
  query: ['view'],
  stocktake: ['view', 'manage', 'delete', 'correct', 'post'],
  settings: ['view', 'create', 'edit', 'delete'],
  users: ['view', 'create', 'edit', 'delete'],
  audit: ['view', 'delete'],
};
const DEFAULT_MODULE_ACTIONS = ['view', 'create', 'edit', 'delete'];

function actionsOf(module) {
  return (MODULE_ACTIONS[module] || DEFAULT_MODULE_ACTIONS).slice();
}

// 计算某角色的默认授权表（用户首次初始化时写入 user_permissions）
function grantsOf(role) {
  const p = ROLE_PERMISSIONS[role];
  if (!p) return {};
  if (Array.isArray(p)) {
    const g = {};
    MODULES.forEach(m => g[m] = actionsOf(m));
    return g;
  }
  return p;
}

// 判断一份授权表是否包含某操作
function hasGrant(grants, module, action) {
  const m = grants && grants[module];
  return Array.isArray(m) && m.includes(action);
}

// 价格（金额 / 成本 / 均价）权限：admin 恒定可见可写；其他角色由用户授权表决定。
// view —— 看价格；edit —— 填/改价格（期初单价、入库单价、采购单价等）。
// 两者独立：只有 view 的用户能看不能改；只有 edit 的用户能改但看不到（前端不渲染价格输入）。
// 判定所需的授权表由调用方传入（auth 中间件每次请求解析一次，避免这里反查库造成循环依赖）。
function priceGranted(user, grants, action) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return hasGrant(grants, 'price', action);
}

function canViewPrice(user, grants) {
  return priceGranted(user, grants, 'view');
}

function canEditPrice(user, grants) {
  return priceGranted(user, grants, 'edit');
}


module.exports = {
  ROLE_PERMISSIONS,
  MODULES,
  MODULE_ACTIONS,
  DEFAULT_MODULE_ACTIONS,
  actionsOf,
  grantsOf,
  hasGrant,
  canViewPrice,
  canEditPrice,
};
