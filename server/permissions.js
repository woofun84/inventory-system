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
//   operator — 只能新增入库和出库，不能编辑/删除已录入记录，不能新增物料/订单/供应商；
//              盘点可建单、填实盘，但不能确认（确认由主管/管理员执行）
//   viewer — 纯只读
const ROLE_PERMISSIONS = {
  admin: ['*'],
  manager: {
    dashboard: ['view'],
    inbound: ['view', 'create', 'edit', 'delete'],
    outbound: ['view', 'create', 'edit', 'delete'],
    returns: ['view', 'create', 'edit', 'delete'],
    materials: ['view', 'create', 'edit', 'delete'],
    suppliers: ['view', 'create', 'edit', 'delete'],
    purchase: ['view', 'create', 'edit', 'delete'],
    stockSummary: ['view'], query: ['view'], ledger: ['view'],
    stocktake: ['view', 'create', 'confirm'],
    settings: ['view', 'create', 'edit', 'delete'],
    audit: ['view'],
  },
  operator: {
    dashboard: ['view'],
    inbound: ['view', 'create'],
    outbound: ['view', 'create'],
    returns: ['view', 'create'],
    materials: ['view'],
    suppliers: ['view'],
    purchase: ['view'],
    stockSummary: ['view'], query: ['view'], ledger: ['view'],
    stocktake: ['view', 'create'],
  },
  viewer: {
    dashboard: ['view'], inbound: ['view'], outbound: ['view'], returns: ['view'], materials: ['view'],
    suppliers: ['view'], purchase: ['view'], stockSummary: ['view'],
    query: ['view'], ledger: ['view'],
    stocktake: ['view'],
  },
};

// 各模块的动作全集（admin 走 grantsOf 的通配分支时按此展开）
const MODULE_ACTIONS = {
  stocktake: ['view', 'create', 'confirm'],
  audit: ['view'],
};
const DEFAULT_MODULE_ACTIONS = ['view', 'create', 'edit', 'delete'];

// 计算某角色的授权表（前端据此控制菜单与按钮显隐）
function grantsOf(role) {
  const p = ROLE_PERMISSIONS[role];
  if (!p) return {};
  if (Array.isArray(p)) {
    const g = {};
    ['dashboard', 'inbound', 'outbound', 'returns', 'materials', 'suppliers', 'purchase',
     'stockSummary', 'query', 'ledger', 'stocktake', 'settings', 'users', 'audit']
      .forEach(m => g[m] = (MODULE_ACTIONS[m] || DEFAULT_MODULE_ACTIONS).slice());
    return g;
  }
  return p;
}

function canDo(role, module, action) {
  const p = ROLE_PERMISSIONS[role];
  if (!p) return false;
  if (Array.isArray(p)) return p.includes('*');
  const m = p[module];
  return Array.isArray(m) && m.includes(action);
}


module.exports = {
  ROLE_PERMISSIONS,
  MODULE_ACTIONS,
  DEFAULT_MODULE_ACTIONS,
  grantsOf,
  canDo,
};
