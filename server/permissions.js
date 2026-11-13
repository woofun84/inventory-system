/**
 * 角色与权限矩阵
 */
// ==================== 角色与权限矩阵 ====================
// 角色：admin 管理员 / manager 主管 / operator 操作员 / viewer 只读
// 权限粒度：模块 + 操作（view 查看 / create 新增 / edit 修改 / delete 删除）
// 特殊模块可定义额外动作：
//   stocktake 的 confirm（确认盘点并按差异生成调整流水）是独立于
//   view/create/edit/delete 的动作，必须显式授予。
//   盘点草稿的删除并入 create（建单方能删自己的草稿）。
// 说明：独立的「库存调整」模块已取消，调整流水由盘点确认自动生成，
//      其只读查询挂在 stocktake 模块的 view 权限下。
// 规则：
//   admin — 全部权限
//   manager — 业务全权（入出库/物料/采购管理/供应商/参数设置/盘点），不含用户管理
//   operator — 入库/出库/退货退库可新建、保存草稿、过账确认、查看（日常操作）；
//              不能作废/更正重开（correct）、不能删除、不能新增物料/订单/供应商；
//              盘点可建单、填实盘，但不能确认（确认由主管/管理员执行）
//   viewer — 纯只读
// 说明：correct 是「更正重开/作废」的独立动作，与日常 edit 拆开，
//       避免把 edit 开放给操作员时连带放开破坏性操作。
const ROLE_PERMISSIONS = {
  admin: ['*'],
  manager: {
    dashboard: ['view'],
    inbound: ['view', 'create', 'edit', 'delete', 'correct'],
    outbound: ['view', 'create', 'edit', 'delete', 'correct'],
    returns: ['view', 'create'],
    materials: ['view', 'create', 'edit', 'delete'],
    suppliers: ['view', 'create', 'edit', 'delete'],
    purchase: ['view', 'create', 'edit', 'delete'],
    query: ['view'],
    stocktake: ['view', 'create', 'confirm'],
    settings: ['view', 'create', 'edit', 'delete'],
    audit: ['view'],
  },
  operator: {
    dashboard: ['view'],
    inbound: ['view', 'create', 'edit'],
    outbound: ['view', 'create', 'edit'],
    returns: ['view', 'create'],
    materials: ['view'],
    suppliers: ['view'],
    purchase: ['view'],
    query: ['view'],
    stocktake: ['view', 'create'],
  },
  viewer: {
    dashboard: ['view'], inbound: ['view'], outbound: ['view'], returns: ['view'], materials: ['view'],
    suppliers: ['view'], purchase: ['view'],
    query: ['view'],
    stocktake: ['view'],
  },
};

// 全部模块（顺序即用户管理页权限矩阵的展示顺序）
const MODULES = ['dashboard', 'inbound', 'outbound', 'returns', 'materials', 'suppliers',
  'purchase', 'query', 'stocktake', 'settings', 'users', 'audit'];

// 各模块的动作全集（与后端 requirePerm 实际用到的动作保持一致，也是用户管理页勾选项）
const MODULE_ACTIONS = {
  dashboard: ['view'],
  inbound: ['view', 'create', 'edit', 'delete', 'correct'],
  outbound: ['view', 'create', 'edit', 'delete', 'correct'],
  returns: ['view', 'create'],
  materials: ['view', 'create', 'edit', 'delete'],
  suppliers: ['view', 'create', 'edit', 'delete'],
  purchase: ['view', 'create', 'edit', 'delete'],
  query: ['view'],
  stocktake: ['view', 'create', 'confirm'],
  settings: ['view', 'create', 'edit', 'delete'],
  users: ['view', 'create', 'edit', 'delete'],
  audit: ['view'],
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

// 价格（金额 / 成本 / 均价）可见性：沿用既有口径，admin / manager 可见。
// 这是全站唯一的价格权限判定点，服务端各接口通过 req.canViewPrice 复用。
const PRICE_ROLES = ['admin', 'manager'];

function canViewPrice(user) {
  return !!user && PRICE_ROLES.includes(user.role);
}


module.exports = {
  ROLE_PERMISSIONS,
  MODULES,
  MODULE_ACTIONS,
  DEFAULT_MODULE_ACTIONS,
  actionsOf,
  grantsOf,
  hasGrant,
  PRICE_ROLES,
  canViewPrice,
};
