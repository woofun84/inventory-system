/* ==========================================
   ⚠️ 备份文件 —— 已不再被 index.html 引用
   前端代码已拆分为 js/ 下的 10 个模块 + css/ 下的 4 个样式文件。
   本文件仅作回滚参考，改动不会生效。请勿在此编辑。
   ========================================== */

/**
 * 库存进出库管理系统 - 前端应用
 * 支持：中英文切换 + 暗色/亮色主题 + 确认弹窗 + 表单校验
 */

// ========== 国际化字典 ==========
const I18N = {
  zh: {
    appName: '库存管理系统', appSub: '进出库跟踪', loading: '加载中...',
    confirm: '确认', cancel: '取消', save: '保存', add: '添加', edit: '编辑', delete: '删除', create: '创建', close: '关闭', search: '查询', clear: '清空', generate: '生成台账',
    updated: '已更新', added: '已添加', deleted: '已删除', created: '已创建', fillRequired: '请填写必填项', requestFailed: '请求失败',
    selectMaterial: '请选择物料', selectLocation: '请选择位置', orderNotFound: '订单不存在', please_select: '请选择', none: '无',
    nav_home: '主页看板', nav_inbound: '入库记录', nav_outbound: '出库记录', nav_query: '查询中心', nav_orders: '采购订单',
    nav_stock: '库存汇总', nav_materials: '物料档案', nav_suppliers: '供应商档案', nav_ledger: '物料台账', nav_location: '位置库存', nav_settings: '参数设置',
    dash_title: '库存进出库管理系统', dash_desc: '数据来源：物料档案 / 入库记录 / 出库记录（自动统计）',
    dash_total_items: '物料种类', dash_items_sub: '已登记物料', dash_total_value: '库存总金额', dash_value_sub: '按加权平均成本计',
    dash_month_in: '本月入库金额', dash_month_in_sub: '本自然月累计', dash_month_out: '本月出库金额', dash_month_out_sub: '按成本单价计',
    dash_month_txn: '本月出入库笔数', dash_txn_sub: '入库 + 出库', dash_alerts: '库存预警', dash_alerts_sub: '补货 + 缺货',
    dash_trend: '近6个月出入库金额趋势', dash_category: '各类别库存金额分布', dash_top5: 'Top 5 物料库存金额',
    dash_alert_list: '库存预警清单（补货 / 缺货）', dash_overdue: '采购订单 — 逾期未到货', dash_in_amount: '入库金额', dash_out_cost: '出库成本', dash_stock_value: '库存金额',
    mat_title: '物料档案', mat_desc: '类别+名称+规格+品牌 唯一；编码唯一；先在此登记物料', mat_add: '新增物料', mat_edit: '编辑物料',
    mat_code: '编码', mat_name: '名称', mat_spec: '规格型号', mat_category: '类别', mat_unit: '单位', mat_opening_qty: '期初库存', mat_opening_price: '期初单价',
    mat_min_stock: '安全库存', mat_location: '常用位置', mat_brand: '品牌', mat_status: '状态', mat_in_use: '在用', mat_stopped: '停用',
    in_title: '入库记录', in_desc: '每收一批货录一行：日期、单号、物料编码、数量、单价、存放位置', in_add: '新增入库', in_edit: '编辑入库记录',
    in_date: '入库日期', in_grn: '入库单号', in_grn_ph: '自动生成', in_material: '物料', in_qty: '入库数量', in_price: '单价', in_supplier: '供应商',
    in_handler: '经手人', in_location: '存放位置', in_po_no: '采购单号', in_contract: '合同号', in_remarks: '备注', in_grn_auto: '留空自动',
    in_total_records: '条记录', in_total_qty: '数量合计', in_total_amount: '金额合计',
    out_title: '出库记录', out_desc: '每次领用录一行：日期、单号、物料编码、数量、领用去向、领用人', out_add: '新增出库', out_edit: '编辑出库记录',
    out_date: '出库日期', out_gin: '出库单号', out_material: '物料', out_qty: '出库数量', out_destination: '领用去向', out_receiver: '领用人',
    out_handler: '经手人', out_location: '出库位置', out_cost_price: '成本单价', out_cost_amount: '成本金额', out_remarks: '备注', out_gin_auto: '留空自动',
    out_cost_hint: '成本单价按当前加权平均价自动计算，出库后不可手动修改。', out_total_records: '条记录', out_total_qty: '数量合计', out_total_amount: '成本金额合计',
    stock_title: '库存汇总', stock_desc: '全自动统计：期初 + 入库 - 出库 = 当前库存；按加权平均成本计价', stock_keyword: '关键字',
    stock_category: '类别', stock_status: '库存状态', stock_all: '全部', stock_opening: '期初', stock_total_in: '累计入库', stock_total_out: '累计出库',
    stock_on_hand: '当前库存', stock_min: '安全库存', stock_avg_price: '加权平均单价', stock_value: '库存金额', stock_types: '物料种类', stock_total_value: '库存总金额', stock_alerts: '预警', stock_items: '项',
    q_title: '查询中心', q_desc: '按物料 / 日期段 / 人员 / 去向 检索', q_keyword: '物料关键字', q_start: '起始日期', q_end: '截止日期',
    q_supplier: '供应商(入库)', q_handler: '经手人', q_destination: '领用去向(出库)', q_po_no: '采购单号', q_contract: '合同号', q_no_limit: '不限',
    q_result_stock: '库存查询结果', q_result_in: '入库明细', q_result_out: '出库明细', q_empty: '请输入查询条件后点击"查询"按钮',
    q_stock_match: '库存匹配', q_in_match: '入库匹配', q_out_match: '出库匹配', q_types: '种', q_records: '条',
    ledger_title: '物料台账', ledger_desc: '单个物料的进出库流水与结余', ledger_select: '选择物料', ledger_start: '起始日期', ledger_end: '截止日期',
    ledger_empty: '选择物料后点击"生成台账"查看进出库流水', ledger_code: '物料编码', ledger_name: '物料名称', ledger_opening: '期初库存',
    ledger_total_in: '累计入库', ledger_total_out: '累计出库', ledger_closing: '结存', ledger_flow: '进出库流水', ledger_seq: '序号',
    ledger_date: '日期', ledger_doc: '单号', ledger_type: '类型', ledger_in_qty: '入库数量', ledger_out_qty: '出库数量', ledger_balance: '结余数量',
    ledger_price: '单价/成本单价', ledger_amount: '金额', ledger_party: '对方', ledger_location: '存放位置',
    loc_title: '位置库存', loc_desc: '各存放位置的库存分布', loc_by_material: 'A. 按物料查看各位置', loc_by_location: 'B. 按位置查看物料',
    loc_select_material: '选择物料', loc_select_location: '选择位置', loc_empty: '选择物料或位置后点击查询',
    loc_opening: '期初', loc_total_in: '累计入库', loc_total_out: '累计出库', loc_stock: '位置库存',
    po_title: '采购订单', po_desc: '一张订单一行；明细在订单详情中登记；到货情况按入库记录自动对账', po_add: '新建订单', po_edit: '编辑采购订单',
    po_no: '订单号', po_date: '订单日期', po_supplier: '供应商', po_contract: '合同号', po_project: '项目/用途', po_expected: '预计到货日',
    po_lines: '明细行数', po_amount: '订单金额', po_received: '已收金额', po_delivery: '到货状态', po_overdue: '逾期(天)', po_manual: '手动状态',
    po_detail: '明细', po_lines_title: '订单明细', po_material: '物料', po_code: '编码', po_unit: '单位', po_order_qty: '订购数量',
    po_order_price: '订单单价', po_order_amount: '订单金额', po_received_qty: '已到货数量', po_unreceived: '未到数量', po_line_status: '到货状态',
    po_add_line: '添加明细行', po_status_pending: '进行中', po_status_closed: '已关闭', po_status_cancelled: '已取消',
    po_batch_add: '添加采购明细', po_batch_title: '批量添加采购明细', po_batch_desc: '选择采购单号或合同号，批量录入明细行',
    po_batch_submit: '批量提交', po_select_source: '选择来源', po_no_lines_yet: '暂无明细',
    sup_title: '供应商档案', sup_desc: '入库时从下拉选择，避免同一供应商写成几种名字', sup_add: '新增供应商', sup_edit: '编辑供应商',
    sup_name: '供应商名称', sup_contact: '联系人', sup_phone: '电话', sup_remarks: '备注', sup_seq: '序号',
    set_title: '参数设置', set_desc: '物料类别、计量单位、领用去向、存放位置等基础参数', set_categories: '物料类别', set_units: '计量单位',
    set_destinations: '领用去向', set_locations: '存放位置', set_cat_name: '类别名称', set_cat_prefix: '编码前缀', set_unit_name: '单位名称',
    set_dest_name: '去向名称', set_loc_name: '位置名称',
    st_normal: '正常', st_restock: '补货', st_out: '缺货', st_arrived: '已到货', st_not_arrived: '未到货', st_partial: '部分到货', st_no_detail: '无明细',
    cf_delete_material: '确定删除物料', cf_delete_material_msg: '相关的出入库记录也会保留但失去关联。', cf_delete_inbound: '确定删除这条入库记录？',
    cf_delete_outbound: '确定删除这条出库记录？', cf_delete_order: '确定删除订单', cf_delete_order_msg: '及其所有明细？', cf_delete_line: '确定删除这条明细？',
    cf_delete_supplier: '确定删除这个供应商？', cf_delete_param: '确定删除？', cf_warning: '⚠', cf_title: '请确认',
    page: '页', of: '共', records: '条', pageSize: '每页', noData: '暂无数据', all: '全部',
    field_required: '此项为必填', field_number: '请输入有效数字', field_positive: '不能小于0',
    quick_filter: '多关键字模糊筛选（空格分隔）', quick_filter_ph: '输入关键字筛选，空格分隔多个...',
    // 新增项
    nav_orderTracking: '订单明细',
    in_txn_type: '入库类型', in_purchase: '采购入库', in_return: '采购退货',
    out_txn_type: '出库类型', out_normal: '正常出库', out_return: '退库出库',
    in_batch_title: '批量入库', in_batch_desc: '可一次添加多行入库记录，选择订单号可自动带出明细',
    in_by_order: '按订单入库', in_by_manual: '手工录入', in_select_order: '选择采购订单',
    in_select_contract: '选择合同号', in_add_row: '添加行', in_remove_row: '删除行', in_batch_submit: '批量提交',
    in_order_lines: '订单明细', in_fill_qty: '填写入库数量',
    in_source_mode: '入库方式', in_source_po: '按采购单号', in_source_contract: '按合同号', in_source_manual: '手工录入',
    in_no_pending_orders: '没有待到货的订单', in_no_contracts: '没有合同号',
    mat_level_category: '类别', mat_level_name: '名称', mat_level_spec: '规格', mat_level_brand: '品牌',
    out_batch_title: '批量出库', out_batch_desc: '可一次添加多行出库记录',
    out_add_row: '添加行', out_remove_row: '删除行', out_batch_submit: '批量提交',
    mat_code_auto: '自动生成', mat_code_hint: '选择类别后自动按前缀编号',
    ot_title: '订单明细跟踪', ot_desc: '跟踪每个订单明细的到货情况',
    ot_po_no: '订单号', ot_po_date: '订单日期', ot_supplier: '供应商', ot_code: '物料编码',
    ot_material: '物料名称', ot_spec: '规格', ot_brand: '品牌', ot_unit: '单位',
    ot_order_qty: '订购数量', ot_order_price: '订单单价', ot_order_amount: '订单金额',
    ot_received_qty: '已到数量', ot_unreceived: '未到数量', ot_expected: '预计到货日',
    ot_status: '到货状态', ot_overdue: '逾期(天)', ot_total_lines: '明细行数', ot_total_amount: '订单总额',
    ot_total_received: '已到金额', ot_total_unreceived: '未到金额',
    nav_users: '用户管理',
    login_title: '登录', login_user: '用户名', login_pass: '密码', login_btn: '登 录', login_default_hint: '初始账号：admin / admin123',
    change_password: '修改密码', old_password: '原密码', new_password: '新密码', confirm_password: '确认新密码',
    pwd_min_len: '至少6位', pwd_not_match: '两次输入的密码不一致', pwd_changed: '密码已修改', session_expired: '登录已过期，请重新登录', session_timeout: '5分钟无操作，已自动退出登录',
    user_title: '用户管理', user_desc: '管理系统用户与角色权限', user_add: '新增用户', user_edit: '编辑用户',
    user_username: '用户名', user_name: '姓名', user_role: '角色', user_status: '状态', user_last_login: '最近登录',
    user_password: '密码', user_password_hint: '新增时必填，编辑时留空表示不修改', user_reset_pwd: '重置密码',
    role_admin: '管理员', role_manager: '主管', role_operator: '操作员', role_viewer: '只读',
    status_active: '启用', status_disabled: '停用',
    cf_delete_user: '确定删除用户', cf_delete_user_msg: '删除后该用户将无法登录。',
    no_perm: '无权限访问该页面', no_perm_msg: '您的角色无权访问此页面，请联系管理员。',
  },
  en: {
    appName: 'Inventory System', appSub: 'In/Out Tracking', loading: 'Loading...',
    confirm: 'Confirm', cancel: 'Cancel', save: 'Save', add: 'Add', edit: 'Edit', delete: 'Delete', create: 'Create', close: 'Close', search: 'Search', clear: 'Clear', generate: 'Generate',
    updated: 'Updated', added: 'Added', deleted: 'Deleted', created: 'Created', fillRequired: 'Please fill required fields', requestFailed: 'Request failed',
    selectMaterial: 'Please select a material', selectLocation: 'Please select a location', orderNotFound: 'Order not found', please_select: 'Select', none: 'None',
    nav_home: 'Dashboard', nav_inbound: 'Inbound', nav_outbound: 'Outbound', nav_query: 'Query Center', nav_orders: 'Purchase Orders',
    nav_stock: 'Stock Summary', nav_materials: 'Materials', nav_suppliers: 'Suppliers', nav_ledger: 'Ledger', nav_location: 'Location Stock', nav_settings: 'Settings',
    dash_title: 'Inventory Management System', dash_desc: 'Data: Materials / Inbound / Outbound (auto-calculated)',
    dash_total_items: 'Item Types', dash_items_sub: 'Registered items', dash_total_value: 'Total Stock Value', dash_value_sub: 'Weighted average cost',
    dash_month_in: 'Month Inbound Value', dash_month_in_sub: 'Current month total', dash_month_out: 'Month Outbound Cost', dash_month_out_sub: 'By cost unit price',
    dash_month_txn: 'Month Txn Count', dash_txn_sub: 'Inbound + Outbound', dash_alerts: 'Stock Alerts', dash_alerts_sub: 'Restock + Out of stock',
    dash_trend: '6-Month In/Out Trend', dash_category: 'Category Value Distribution', dash_top5: 'Top 5 Stock Value',
    dash_alert_list: 'Stock Alert List (Restock / Out)', dash_overdue: 'Overdue Purchase Orders', dash_in_amount: 'Inbound', dash_out_cost: 'Outbound Cost', dash_stock_value: 'Stock Value',
    mat_title: 'Materials', mat_desc: 'Category+Name+Spec+Brand unique; Code unique; Register materials first', mat_add: 'Add Material', mat_edit: 'Edit Material',
    mat_code: 'Code', mat_name: 'Name', mat_spec: 'Specification', mat_category: 'Category', mat_unit: 'Unit', mat_opening_qty: 'Opening Qty', mat_opening_price: 'Opening Price',
    mat_min_stock: 'Min Stock', mat_location: 'Default Location', mat_brand: 'Brand', mat_status: 'Status', mat_in_use: 'Active', mat_stopped: 'Stopped',
    in_title: 'Inbound Records', in_desc: 'One row per receipt: date, GRN no, material code, qty, price, location', in_add: 'Add Inbound', in_edit: 'Edit Inbound',
    in_date: 'Inbound Date', in_grn: 'GRN No', in_grn_ph: 'Auto-generated', in_material: 'Material', in_qty: 'Quantity', in_price: 'Unit Price', in_supplier: 'Supplier',
    in_handler: 'Handler', in_location: 'Storage Location', in_po_no: 'PO No', in_contract: 'Contract No', in_remarks: 'Remarks', in_grn_auto: 'Leave blank for auto',
    in_total_records: 'records', in_total_qty: 'Total Qty', in_total_amount: 'Total Amount',
    out_title: 'Outbound Records', out_desc: 'One row per issue: date, GIN no, material code, qty, destination, receiver', out_add: 'Add Outbound', out_edit: 'Edit Outbound',
    out_date: 'Outbound Date', out_gin: 'GIN No', out_material: 'Material', out_qty: 'Quantity', out_destination: 'Destination', out_receiver: 'Receiver',
    out_handler: 'Handler', out_location: 'Issue Location', out_cost_price: 'Cost Unit Price', out_cost_amount: 'Cost Amount', out_remarks: 'Remarks', out_gin_auto: 'Leave blank for auto',
    out_cost_hint: 'Cost price is auto-calculated by weighted average. Cannot be manually edited.', out_total_records: 'records', out_total_qty: 'Total Qty', out_total_amount: 'Total Cost',
    stock_title: 'Stock Summary', stock_desc: 'Auto: Opening + Inbound - Outbound = Current; Weighted average cost', stock_keyword: 'Keyword',
    stock_category: 'Category', stock_status: 'Status', stock_all: 'All', stock_opening: 'Opening', stock_total_in: 'Total In', stock_total_out: 'Total Out',
    stock_on_hand: 'On Hand', stock_min: 'Min Stock', stock_avg_price: 'Avg Price', stock_value: 'Stock Value', stock_types: 'Item types', stock_total_value: 'Total stock value', stock_alerts: 'alerts', stock_items: 'items',
    q_title: 'Query Center', q_desc: 'Search by material / date range / person / destination', q_keyword: 'Material keyword', q_start: 'Start date', q_end: 'End date',
    q_supplier: 'Supplier (inbound)', q_handler: 'Handler', q_destination: 'Destination (outbound)', q_po_no: 'PO No', q_contract: 'Contract No', q_no_limit: 'Any',
    q_result_stock: 'Stock Results', q_result_in: 'Inbound Detail', q_result_out: 'Outbound Detail', q_empty: 'Enter criteria and click "Search"',
    q_stock_match: 'Stock matched', q_in_match: 'Inbound matched', q_out_match: 'Outbound matched', q_types: 'types', q_records: 'records',
    ledger_title: 'Material Ledger', ledger_desc: 'In/out transaction flow and balance for a single material', ledger_select: 'Select material', ledger_start: 'Start date', ledger_end: 'End date',
    ledger_empty: 'Select a material and click "Generate" to view transactions', ledger_code: 'Material Code', ledger_name: 'Material Name', ledger_opening: 'Opening Qty',
    ledger_total_in: 'Total In', ledger_total_out: 'Total Out', ledger_closing: 'Closing Qty', ledger_flow: 'Transaction Flow', ledger_seq: 'Seq',
    ledger_date: 'Date', ledger_doc: 'Doc No', ledger_type: 'Type', ledger_in_qty: 'In Qty', ledger_out_qty: 'Out Qty', ledger_balance: 'Balance',
    ledger_price: 'Price/Cost', ledger_amount: 'Amount', ledger_party: 'Party', ledger_location: 'Location',
    loc_title: 'Location Stock', loc_desc: 'Stock distribution by storage location', loc_by_material: 'A. By Material (view locations)', loc_by_location: 'B. By Location (view materials)',
    loc_select_material: 'Select material', loc_select_location: 'Select location', loc_empty: 'Select material or location then click Search',
    loc_opening: 'Opening', loc_total_in: 'Total In', loc_total_out: 'Total Out', loc_stock: 'Location Stock',
    po_title: 'Purchase Orders', po_desc: 'One order per row; Lines in detail view; Delivery auto-reconciled by inbound', po_add: 'New Order', po_edit: 'Edit Order',
    po_no: 'PO No', po_date: 'Order Date', po_supplier: 'Supplier', po_contract: 'Contract No', po_project: 'Project/Use', po_expected: 'Expected Date',
    po_lines: 'Lines', po_amount: 'Order Amount', po_received: 'Received Amount', po_delivery: 'Delivery', po_overdue: 'Overdue (days)', po_manual: 'Manual Status',
    po_detail: 'Detail', po_lines_title: 'Order Lines', po_material: 'Material', po_code: 'Code', po_unit: 'Unit', po_order_qty: 'Order Qty',
    po_order_price: 'Order Price', po_order_amount: 'Order Amount', po_received_qty: 'Received Qty', po_unreceived: 'Unreceived', po_line_status: 'Status',
    po_add_line: 'Add Line', po_status_pending: 'In Progress', po_status_closed: 'Closed', po_status_cancelled: 'Cancelled',
    po_batch_add: 'Add Order Lines', po_batch_title: 'Batch Add Order Lines', po_batch_desc: 'Select PO or contract, add multiple lines at once',
    po_batch_submit: 'Submit Batch', po_select_source: 'Select Source', po_no_lines_yet: 'No lines yet',
    sup_title: 'Supplier Directory', sup_desc: 'Select from dropdown during inbound to ensure consistency', sup_add: 'Add Supplier', sup_edit: 'Edit Supplier',
    sup_name: 'Supplier Name', sup_contact: 'Contact', sup_phone: 'Phone', sup_remarks: 'Remarks', sup_seq: 'No',
    set_title: 'Settings', set_desc: 'Categories, units, destinations, locations and other parameters', set_categories: 'Categories', set_units: 'Units',
    set_destinations: 'Destinations', set_locations: 'Locations', set_cat_name: 'Category Name', set_cat_prefix: 'Code Prefix', set_unit_name: 'Unit Name',
    set_dest_name: 'Destination Name', set_loc_name: 'Location Name',
    st_normal: 'Normal', st_restock: 'Restock', st_out: 'Out of Stock', st_arrived: 'Arrived', st_not_arrived: 'Not Arrived', st_partial: 'Partial', st_no_detail: 'No Lines',
    cf_delete_material: 'Delete material', cf_delete_material_msg: 'Related in/out records will remain but lose association.', cf_delete_inbound: 'Delete this inbound record?',
    cf_delete_outbound: 'Delete this outbound record?', cf_delete_order: 'Delete order', cf_delete_order_msg: 'and all its lines?', cf_delete_line: 'Delete this line?',
    cf_delete_supplier: 'Delete this supplier?', cf_delete_param: 'Are you sure to delete?', cf_warning: '⚠', cf_title: 'Please Confirm',
    page: 'Page', of: 'of', records: 'records', pageSize: 'Per page', noData: 'No data', all: 'All',
    field_required: 'This field is required', field_number: 'Please enter a valid number', field_positive: 'Cannot be negative',
    quick_filter: 'Multi-keyword filter (space separated)', quick_filter_ph: 'Type keywords to filter, space separated...',
    // New items
    nav_orderTracking: 'Order Tracking',
    in_txn_type: 'Inbound Type', in_purchase: 'Purchase', in_return: 'Purchase Return',
    out_txn_type: 'Outbound Type', out_normal: 'Normal', out_return: 'Return Out',
    in_batch_title: 'Batch Inbound', in_batch_desc: 'Add multiple inbound records at once; select PO to auto-fill lines',
    in_by_order: 'By PO', in_by_manual: 'Manual', in_select_order: 'Select PO',
    in_select_contract: 'Select Contract', in_add_row: 'Add Row', in_remove_row: 'Remove', in_batch_submit: 'Submit Batch',
    in_order_lines: 'Order Lines', in_fill_qty: 'Enter Qty',
    in_source_mode: 'Inbound Mode', in_source_po: 'By PO No', in_source_contract: 'By Contract No', in_source_manual: 'Manual',
    in_no_pending_orders: 'No pending orders', in_no_contracts: 'No contracts',
    mat_level_category: 'Category', mat_level_name: 'Name', mat_level_spec: 'Spec', mat_level_brand: 'Brand',
    out_batch_title: 'Batch Outbound', out_batch_desc: 'Add multiple outbound records at once',
    out_add_row: 'Add Row', out_remove_row: 'Remove', out_batch_submit: 'Submit Batch',
    mat_code_auto: 'Auto', mat_code_hint: 'Auto-generated by category prefix',
    ot_title: 'Order Tracking', ot_desc: 'Track delivery status of each order line',
    ot_po_no: 'PO No', ot_po_date: 'Order Date', ot_supplier: 'Supplier', ot_code: 'Code',
    ot_material: 'Material', ot_spec: 'Spec', ot_brand: 'Brand', ot_unit: 'Unit',
    ot_order_qty: 'Order Qty', ot_order_price: 'Order Price', ot_order_amount: 'Order Amount',
    ot_received_qty: 'Received Qty', ot_unreceived: 'Unreceived', ot_expected: 'Expected Date',
    ot_status: 'Status', ot_overdue: 'Overdue (days)', ot_total_lines: 'Lines', ot_total_amount: 'Total Amount',
    ot_total_received: 'Received Amount', ot_total_unreceived: 'Unreceived Amount',
    nav_users: 'Users',
    login_title: 'Login', login_user: 'Username', login_pass: 'Password', login_btn: 'Log In', login_default_hint: 'Default: admin / admin123',
    change_password: 'Change Password', old_password: 'Current Password', new_password: 'New Password', confirm_password: 'Confirm Password',
    pwd_min_len: 'min 6 chars', pwd_not_match: 'Passwords do not match', pwd_changed: 'Password changed', session_expired: 'Session expired, please log in again', session_timeout: 'Auto logged out after 5 minutes of inactivity',
    user_title: 'User Management', user_desc: 'Manage system users and role permissions', user_add: 'Add User', user_edit: 'Edit User',
    user_username: 'Username', user_name: 'Name', user_role: 'Role', user_status: 'Status', user_last_login: 'Last Login',
    user_password: 'Password', user_password_hint: 'Required for new users; leave blank to keep unchanged when editing', user_reset_pwd: 'Reset Password',
    role_admin: 'Admin', role_manager: 'Manager', role_operator: 'Operator', role_viewer: 'Viewer',
    status_active: 'Active', status_disabled: 'Disabled',
    cf_delete_user: 'Delete user', cf_delete_user_msg: 'This user will no longer be able to log in.',
    no_perm: 'No Permission', no_perm_msg: 'Your role does not have access to this page. Please contact the administrator.',
  }
};

// ========== 应用主体 ==========
const App = {
  currentPage: 'dashboard',
  params: null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: localStorage.getItem('token') || '',
  lang: localStorage.getItem('lang') || 'zh',
  theme: localStorage.getItem('theme') || 'light',
  charts: [],

  t(key) {
    return (I18N[this.lang] && I18N[this.lang][key]) || (I18N.zh[key]) || key;
  },

  async init() {
    // 未登录 → 跳转登录页
    if (!this.token) { location.href = '/login.html'; return; }
    document.documentElement.setAttribute('data-theme', this.theme);
    try {
      // 校验 token 有效性
      const me = await this.api('/api/auth/me');
      this.user = me;
      localStorage.setItem('user', JSON.stringify(me));
    } catch (e) {
      this.logout();
      return;
    }
    // 启动空闲超时（5分钟无操作自动退出）
    this.startIdleTimer();
    // 强制改密：先加载 params 和渲染基础布局，再弹出改密弹窗
    if (this.user && this.user.must_change_pwd) {
      await this.loadParams();
      this.setMain(this.pageWrap('📦 ' + this.t('appName'), '', '', '<div id="force-pwd-hint" style="padding:40px;text-align:center;color:var(--text-muted)">' + this.t('change_password') + '</div>'));
      this.showChangePwdModal(true);
      return;
    }
    await this.loadParams();
    this.router();
    window.addEventListener('hashchange', () => this.router());
  },

  // 空闲超时：5分钟无操作自动退出
  _idleTimeout: 5 * 60 * 1000, // 5分钟
  _idleTimer: null,
  startIdleTimer() {
    this.resetIdleTimer();
    ['mousemove','keydown','click','scroll','touchstart'].forEach(evt => {
      document.addEventListener(evt, () => this.resetIdleTimer(), { passive: true });
    });
  },
  resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this.toast(this.t('session_timeout'), 'error');
      this.logout();
    }, this._idleTimeout);
  },

  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.href = '/login.html';
  },

  // 权限检查：can(模块, 操作)
  can(module, action) {
    if (!this.user || !this.user.grants) return false;
    const g = this.user.grants[module];
    return Array.isArray(g) && g.includes(action);
  },
  // 价格权限：只有 admin 和 manager 可以看到价格/金额
  canViewPrice() {
    return this.user && (this.user.role === 'admin' || this.user.role === 'manager');
  },

  showChangePwdModal(force) {
    const body = `<div class="form-grid" style="max-width:400px;margin:0 auto">
      <div class="form-group" style="grid-column:1/-1">
        <label>${this.t('old_password')} *</label>
        <input id="cp_old" type="password" oninput="App.clearFieldError('cp_old')">
        <div class="form-error" id="cp_old_error"></div>
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label>${this.t('new_password')} * <span style="font-size:11px;color:var(--text-muted)">(${this.t('pwd_min_len')})</span></label>
        <input id="cp_new" type="password" oninput="App.clearFieldError('cp_new')">
        <div class="form-error" id="cp_new_error"></div>
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label>${this.t('confirm_password')} *</label>
        <input id="cp_confirm" type="password" oninput="App.clearFieldError('cp_confirm')">
        <div class="form-error" id="cp_confirm_error"></div>
      </div>
    </div>`;
    this.showModal(`<h3>${this.t('change_password')}</h3>`, body, this.t('save'), async () => {
      if (!this.validateForm({
        cp_old: [{ rule: 'required' }],
        cp_new: [{ rule: 'required' }, { rule: 'minlen', param: 6 }],
        cp_confirm: [{ rule: 'required' }],
      })) return;
      const np = document.getElementById('cp_new').value;
      const cp = document.getElementById('cp_confirm').value;
      if (np !== cp) { this.setFieldError('cp_confirm', this.t('pwd_not_match')); return; }
      try {
        await this.api('/api/auth/change-password', 'POST', {
          oldPassword: document.getElementById('cp_old').value,
          newPassword: np,
        });
        this.closeModal();
        this.user.must_change_pwd = false;
        localStorage.setItem('user', JSON.stringify(this.user));
        this.toast(this.t('pwd_changed'));
        if (force) { await this.loadParams(); this.router(); window.addEventListener('hashchange', () => this.router()); }
      } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', this.theme);
    document.documentElement.setAttribute('data-theme', this.theme);
    this.destroyCharts();
    this.render();
  },

  toggleLang() {
    this.lang = this.lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('lang', this.lang);
    this.destroyCharts();
    this.render();
  },

  destroyCharts() {
    this.charts.forEach(c => { try { c.destroy(); } catch(e){} });
    this.charts = [];
  },

  renderToolbar() {
    return `<div class="toolbar">
      <button class="tool-btn tool-btn-sm" onclick="App.toggleLang()" title="Language">${this.lang === 'zh' ? 'EN' : '中文'}</button>
      <button class="tool-btn" onclick="App.toggleTheme()" title="Theme">${this.theme === 'light' ? '🌙' : '☀'}</button>
    </div>`;
  },

  async loadParams() {
    try {
      this.params = await this.api('/api/params');
    } catch (e) {
      console.error('Failed to load params', e);
      this.params = { categories: [], units: [], destinations: [], locations: [] };
    }
  },

  router() {
    const hash = location.hash.slice(1) || 'dashboard';
    this.currentPage = hash;
    // 权限拦截：无 view 权限的页面不允许访问
    if (!this.can(hash, 'view') && hash !== 'dashboard') {
      this.currentPage = 'dashboard';
      this.toast(this.t('no_perm_msg'), 'error');
    }
    this.render();
  },

  render() {
    const pages = {
      dashboard: () => this.renderDashboard(), materials: () => this.renderMaterials(),
      inbound: () => this.renderInbound(), outbound: () => this.renderOutbound(),
      stockSummary: () => this.renderStockSummary(), query: () => this.renderQuery(),
      ledger: () => this.renderLedger(), locationStock: () => this.renderLocationStock(),
      orders: () => this.renderOrders(), suppliers: () => this.renderSuppliers(),
      settings: () => this.renderSettings(), orderTracking: () => this.renderOrderTracking(),
      users: () => this.renderUsers(),
    };
    (pages[this.currentPage] || pages.dashboard).call(this);
  },

  renderSidebar() {
    const nav = [
      { section: this.t('nav_home'), items: [{ key: 'dashboard', icon: '🏠', label: this.t('nav_home') }]},
      { section: this.lang === 'zh' ? '常用操作' : 'Operations', items: [
        { key: 'inbound', icon: '📥', label: this.t('nav_inbound') }, { key: 'outbound', icon: '📤', label: this.t('nav_outbound') },
        { key: 'query', icon: '🔍', label: this.t('nav_query') }, { key: 'orders', icon: '🛒', label: this.t('nav_orders') },
        { key: 'orderTracking', icon: '📋', label: this.t('nav_orderTracking') },
      ]},
      { section: this.lang === 'zh' ? '统计与资料' : 'Analytics & Data', items: [
        { key: 'stockSummary', icon: '📦', label: this.t('nav_stock') }, { key: 'materials', icon: '🏷', label: this.t('nav_materials') },
        { key: 'suppliers', icon: '🚚', label: this.t('nav_suppliers') }, { key: 'ledger', icon: '📒', label: this.t('nav_ledger') },
        { key: 'locationStock', icon: '📍', label: this.t('nav_location') }, { key: 'settings', icon: '⚙', label: this.t('nav_settings') },
        { key: 'users', icon: '👤', label: this.t('nav_users') },
      ]}
    ];
    let html = `<div class="sidebar-header"><h1>📦 <span>${this.t('appName')}</span></h1><div class="subtitle">${this.t('appSub')}</div></div><div class="sidebar-nav">`;
    nav.forEach(s => {
      // 按权限过滤
      const visibleItems = s.items.filter(item => this.can(item.key, 'view'));
      if (visibleItems.length === 0) return;
      html += `<div class="nav-section-label">${s.section}</div>`;
      visibleItems.forEach(item => {
        html += `<div class="nav-item ${this.currentPage === item.key ? 'active' : ''}" onclick="location.hash='${item.key}'"><span class="nav-icon">${item.icon}</span><span>${item.label}</span></div>`;
      });
    });
    html += '</div>';
    // 底部用户信息栏
    if (this.user) {
      const roleLabel = this.t('role_' + this.user.role);
      html += `<div class="sidebar-user">
        <div class="sidebar-user-info">
          <span class="sidebar-user-name">${this.user.name || this.user.username}</span>
          <span class="sidebar-user-role">${roleLabel}</span>
        </div>
        <button class="tool-btn tool-btn-sm" onclick="App.showChangePwdModal(false)" title="${this.t('change_password')}">🔑</button>
        <button class="tool-btn tool-btn-sm" onclick="App.logout()" title="${this.lang === 'zh' ? '退出' : 'Logout'}">⏻</button>
      </div>`;
    }
    return html;
  },

  setMain(html) {
    document.getElementById('app').innerHTML = `<div class="layout">${this.renderSidebar()}<div class="main">${html}</div></div>`;
  },

  pageWrap(title, desc, headerRight, bodyHtml) {
    const tools = this.renderToolbar();
    const right = (headerRight || '') + tools;
    return `<div class="page-header-row"><div><div class="page-title">${title}</div>${desc ? `<div class="page-desc">${desc}</div>` : ''}</div><div>${right}</div></div><div class="page-body">${bodyHtml}</div>`;
  },

  async api(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) { this.logout(); throw new Error(this.t('session_expired')); }
    if (!res.ok) { const err = await res.json().catch(() => ({ error: this.t('requestFailed') })); throw new Error(err.error || this.t('requestFailed')); }
    return res.json();
  },

  toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
  },

  confirmDialog(title, msg, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay'; overlay.id = 'confirm-overlay';
    overlay.innerHTML = `<div class="confirm-box"><div class="confirm-icon">${this.t('cf_warning')}</div><div class="confirm-title">${title}</div><div class="confirm-msg">${msg}</div><div class="confirm-actions"><button class="btn btn-outline" id="cf-cancel">${this.t('cancel')}</button><button class="btn btn-danger" id="cf-ok">${this.t('confirm')}</button></div></div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); if (onCancel) onCancel(); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('cf-cancel').onclick = close;
    document.getElementById('cf-ok').onclick = () => { overlay.remove(); onConfirm(); };
  },

  statusBadge(status) {
    const map = { '正常': this.t('st_normal'), '补货': this.t('st_restock'), '缺货': this.t('st_out'), '停用': this.t('mat_stopped'), '已到货': this.t('st_arrived'), '未到货': this.t('st_not_arrived'), '部分到货': this.t('st_partial'), '无明细': this.t('st_no_detail'), '已关闭': this.t('po_status_closed'), '已取消': this.t('po_status_cancelled') };
    const clsMap = { '正常': 'success', '补货': 'warning', '缺货': 'danger', '停用': 'muted', '已到货': 'success', '未到货': 'warning', '部分到货': 'info', '无明细': 'muted', '已关闭': 'muted', '已取消': 'danger' };
    return `<span class="badge badge-${clsMap[status] || 'muted'}">${map[status] || status}</span>`;
  },

  // ========== 表格排序 ==========
  // tableState 存储各页面的排序/分页状态: { key: { sortKey, sortDir, page, pageSize } }
  tableStates: {},

  getTableState(tableId) {
    if (!this.tableStates[tableId]) {
      this.tableStates[tableId] = { sortKey: '', sortDir: 'asc', page: 1, pageSize: 15 };
    }
    return this.tableStates[tableId];
  },

  sortData(data, key, dir) {
    if (!key) return data;
    const sorted = [...data].sort((a, b) => {
      let va = a[key], vb = b[key];
      // 数字比较
      if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va;
      // 尝试数字字符串比较
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb) && String(va).match(/^[\d.]+$/) && String(vb).match(/^[\d.]+$/)) return dir === 'asc' ? na - nb : nb - na;
      // 日期比较
      if (typeof va === 'string' && typeof vb === 'string' && /^\d{4}-\d{2}-\d{2}/.test(va) && /^\d{4}-\d{2}-\d{2}/.test(vb)) return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      // 字符串比较
      va = (va == null ? '' : String(va)).toLowerCase();
      vb = (vb == null ? '' : String(vb)).toLowerCase();
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    return sorted;
  },

  // 生成可排序的表头
  sortTh(label, key, tableId) {
    const st = this.getTableState(tableId);
    const active = st.sortKey === key;
    const arrow = active ? (st.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sort-th ${active ? 'active' : ''}" onclick="App.onSort('${tableId}','${key}')">${label}<span class="sort-arrow">${active ? (st.sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span></th>`;
  },

  onSort(tableId, key) {
    const st = this.getTableState(tableId);
    if (st.sortKey === key) {
      st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      st.sortKey = key;
      st.sortDir = 'asc';
    }
    st.page = 1;
    // 触发页面重渲染
    if (this._tableRenderers && this._tableRenderers[tableId]) this._tableRenderers[tableId]();
  },

  // ========== 分页 ==========
  paginate(data, page, pageSize) {
    if (pageSize <= 0) return data;
    const start = (page - 1) * pageSize;
    return data.slice(start, start + pageSize);
  },

  renderPager(tableId, total) {
    const st = this.getTableState(tableId);
    const pageSize = st.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    if (st.page > totalPages) st.page = 1;
    const page = st.page;
    const startIdx = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const endIdx = Math.min(page * pageSize, total);
    const sizes = [10, 15, 20, 50, 0];
    let html = `<div class="pager">
      <span class="pager-info">${startIdx}-${endIdx} / ${total} ${this.t('records')}</span>`;
    // 上一页
    html += `<button class="pager-btn" ${page <= 1 ? 'disabled' : ''} onclick="App.onPage('${tableId}',${page - 1})">‹</button>`;
    // 页码按钮
    let pStart = Math.max(1, page - 2), pEnd = Math.min(totalPages, page + 2);
    if (pStart > 1) { html += `<button class="pager-btn" onclick="App.onPage('${tableId}',1)">1</button>`; if (pStart > 2) html += `<span class="pager-info">...</span>`; }
    for (let i = pStart; i <= pEnd; i++) {
      html += `<button class="pager-btn ${i === page ? 'active' : ''}" onclick="App.onPage('${tableId}',${i})">${i}</button>`;
    }
    if (pEnd < totalPages) { if (pEnd < totalPages - 1) html += `<span class="pager-info">...</span>`; html += `<button class="pager-btn" onclick="App.onPage('${tableId}',${totalPages})">${totalPages}</button>`; }
    // 下一页
    html += `<button class="pager-btn" ${page >= totalPages ? 'disabled' : ''} onclick="App.onPage('${tableId}',${page + 1})">›</button>`;
    // 每页条数
    html += `<span class="pager-size"><select onchange="App.onPageSize('${tableId}',this.value)">`;
    sizes.forEach(s => { html += `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s === 0 ? this.t('all') : s + ' / ' + this.t('page')}</option>`; });
    html += `</select></span></div>`;
    return html;
  },

  onPage(tableId, page) {
    const st = this.getTableState(tableId);
    st.page = page;
    if (this._tableRenderers && this._tableRenderers[tableId]) this._tableRenderers[tableId]();
  },

  onPageSize(tableId, size) {
    const st = this.getTableState(tableId);
    st.pageSize = parseInt(size);
    st.page = 1;
    if (this._tableRenderers && this._tableRenderers[tableId]) this._tableRenderers[tableId]();
  },

  // ========== 表单校验 ==========
  // rules: { fieldId: [{ rule: 'required', msg?: '' }, { rule: 'number', msg?: '' }, { rule: 'positive', msg?: '' }] }
  validateForm(rules) {
    let valid = true;
    Object.keys(rules).forEach(fieldId => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      const val = el.value.trim();
      const errorEl = el.parentElement.querySelector('.form-error');
      let errorMsg = '';
      for (const r of rules[fieldId]) {
        if (r.rule === 'required' && !val) { errorMsg = r.msg || this.t('field_required'); break; }
        if (r.rule === 'number' && val && isNaN(parseFloat(val))) { errorMsg = r.msg || this.t('field_number'); break; }
        if (r.rule === 'positive' && val && parseFloat(val) < 0) { errorMsg = r.msg || this.t('field_positive'); break; }
        if (r.rule === 'minlen' && val && val.length < (r.param || 0)) { errorMsg = r.msg || this.t('pwd_min_len'); break; }
      }
      if (errorMsg) {
        el.classList.add('error');
        if (errorEl) { errorEl.textContent = errorMsg; errorEl.classList.add('show'); }
        valid = false;
      } else {
        el.classList.remove('error');
        if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
      }
    });
    return valid;
  },

  // 清除字段错误状态
  clearFieldError(fieldId) {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.classList.remove('error');
    const errorEl = el.parentElement.querySelector('.form-error');
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
  },

  // 设置字段错误状态
  setFieldError(fieldId, msg) {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.classList.add('error');
    const errorEl = el.parentElement.querySelector('.form-error');
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.add('show'); }
  },

  // 生成带 error div 的 form-group（辅助函数）
  formGroup(label, inputHtml, fieldId) {
    return `<div class="form-group"><label>${label}</label>${inputHtml}<div class="form-error" id="${fieldId}_error"></div></div>`;
  },

  // ========== 空状态 ==========
  emptyRow(colSpan) {
    return `<tr><td colspan="${colSpan}" style="text-align:center;padding:40px;color:var(--text-muted)">${this.t('noData')}</td></tr>`;
  },

  // ========== 多关键字模糊筛选 ==========
  // 对数据数组做多关键字 AND 筛选（空格分隔关键字，每条记录需同时包含所有关键字）
  filterByKeywords(data, keywords, fields) {
    if (!keywords || !keywords.trim()) return data;
    const kws = keywords.trim().toLowerCase().split(/\s+/);
    return data.filter(row => {
      const haystack = fields.map(f => String(row[f] == null ? '' : row[f]).toLowerCase()).join(' ');
      return kws.every(kw => haystack.includes(kw));
    });
  },

  // ========== 日期段筛选 ==========
  // 对数据按日期字段做范围筛选（from/to 均为可选，格式 YYYY-MM-DD）
  filterByDateRange(data, dateField, from, to) {
    if (!from && !to) return data;
    return data.filter(row => {
      const d = String(row[dateField] || '').slice(0, 10);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  },

  // 生成表格行操作列（编辑/删除链接，按权限显隐）
  rowActions(module, editCall, deleteCall) {
    let html = '';
    if (this.can(module, 'edit')) html += `<span class="action-link" onclick="${editCall}">${this.t('edit')}</span>`;
    if (this.can(module, 'delete')) html += `<span class="action-link danger" onclick="${deleteCall}">${this.t('delete')}</span>`;
    return html;
  },

  // 生成表格上方工具栏（新增按钮 + 关键字筛选框 + 可选日期段筛选）
  renderTableToolbar(filterId, filterOnInput, addBtnHtml, dateFilter) {
    let dateHtml = '';
    if (dateFilter) {
      dateHtml = `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <input id="${dateFilter.fromId}" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="${dateFilter.onChange}" value="${dateFilter.fromVal || ''}">
        <span style="color:var(--text-muted);font-size:12px">~</span>
        <input id="${dateFilter.toId}" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="${dateFilter.onChange}" value="${dateFilter.toVal || ''}">
      </div>`;
    }
    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div>${addBtnHtml || ''}</div>
      <div class="form-group" style="flex:1;max-width:400px;margin:0;margin-rigth:auto">
        <input id="${filterId}" type="text" placeholder="${this.t('quick_filter_ph')}" oninput="${filterOnInput}" style="width:100%">
      </div>
      ${dateHtml}
    </div>`;
  },

  // 恢复筛选框的值和焦点（innerHTML 重设后调用）
  restoreFilter(filterId, value) {
    const el = document.getElementById(filterId);
    if (el) {
      el.value = value;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    }
  },

  fmtMoney(v) { if (v == null || isNaN(v)) return '-'; return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  fmtDate(d) { if (!d) return ''; return String(d).slice(0, 10); },
  chartTextColor() { return this.theme === 'dark' ? '#94a3b8' : '#6b7280'; },
  chartGridColor() { return this.theme === 'dark' ? 'rgba(51,65,85,0.3)' : 'rgba(229,231,235,0.5)'; },

  // ========== 仪表盘 ==========
  async renderDashboard() {
    this.setMain(this.pageWrap('🏠 ' + this.t('dash_title'), this.t('dash_desc'), '', `<div id="dashboard-content"><p style="text-align:center;padding:40px;color:var(--text-muted)">${this.t('loading')}</p></div>`));
    try {
      const data = await this.api('/api/dashboard'); const cur = data.currency; const vp = this.canViewPrice(); let html = '';
      html += `<div class="metric-grid">
        <div class="metric-card"><div class="metric-label">🔖 ${this.t('dash_total_items')}</div><div class="metric-value">${data.total_items}</div><div class="metric-sub">${this.t('dash_items_sub')}</div></div>
        ${vp ? `<div class="metric-card metric-success"><div class="metric-label">💰 ${this.t('dash_total_value')}</div><div class="metric-value">${cur} ${this.fmtMoney(data.total_value)}</div><div class="metric-sub">${this.t('dash_value_sub')}</div></div>
        <div class="metric-card metric-info"><div class="metric-label">📥 ${this.t('dash_month_in')}</div><div class="metric-value">${cur} ${this.fmtMoney(data.month_in_amount)}</div><div class="metric-sub">${this.t('dash_month_in_sub')}</div></div>
        <div class="metric-card metric-warning"><div class="metric-label">📤 ${this.t('dash_month_out')}</div><div class="metric-value">${cur} ${this.fmtMoney(data.month_out_amount)}</div><div class="metric-sub">${this.t('dash_month_out_sub')}</div></div>` : ''}
        <div class="metric-card"><div class="metric-label">🧾 ${this.t('dash_month_txn')}</div><div class="metric-value">${data.month_txn_count}</div><div class="metric-sub">${this.t('dash_txn_sub')}</div></div>
        <div class="metric-card metric-danger"><div class="metric-label">⚠ ${this.t('dash_alerts')}</div><div class="metric-value">${data.alert_count}</div><div class="metric-sub">${this.t('dash_alerts_sub')}</div></div></div>`;
      if (vp) html += `<div class="chart-grid"><div class="card"><div class="card-title">${this.t('dash_trend')}</div><div class="chart-container"><canvas id="trendChart"></canvas></div></div><div class="card"><div class="card-title">${this.t('dash_category')}</div><div class="chart-container"><canvas id="categoryChart"></canvas></div></div></div>`;
      if (vp) html += `<div class="card"><div class="card-title">${this.t('dash_top5')}</div><div class="chart-container"><canvas id="topChart"></canvas></div></div>`;
      if (data.alerts.length > 0) {
        html += `<div class="card"><div class="card-title">⚠ ${this.t('dash_alert_list')} — ${data.alert_count} ${this.t('stock_items')}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th><th>${this.t('stock_on_hand')}</th><th>${this.t('stock_min')}</th><th>${this.t('mat_status')}</th></tr></thead><tbody>${data.alerts.map(a => `<tr><td>${a.code}</td><td>${a.name}</td><td>${a.spec || ''}</td><td class="text-right">${a.on_hand}</td><td class="text-right">${a.min_stock}</td><td>${this.statusBadge(a.stock_status)}</td></tr>`).join('')}</tbody></table></div></div>`;
      }
      if (data.overdue_orders.length > 0) {
        html += `<div class="card"><div class="card-title">🛒 ${this.t('dash_overdue')} (${data.overdue_orders.length})</div><div class="table-wrap"><table><thead><tr><th>${this.t('po_no')}</th><th>${this.t('po_supplier')}</th><th>${this.t('po_expected')}</th><th>${this.t('po_overdue')}</th><th>${this.t('po_delivery')}</th>${vp ? `<th>${this.t('po_amount')}</th>` : ''}</tr></thead><tbody>${data.overdue_orders.map(o => `<tr><td>${o.po_no}</td><td>${o.supplier}</td><td>${this.fmtDate(o.expected_date)}</td><td class="text-center"><span class="badge badge-danger">${o.overdue_days}</span></td><td>${this.statusBadge(o.delivery_status)}</td>${vp ? `<td class="text-right">${cur} ${this.fmtMoney(o.order_amount)}</td>` : ''}</tr>`).join('')}</tbody></table></div></div>`;
      }
      document.getElementById('dashboard-content').innerHTML = html;
      this.renderCharts(data, vp);
    } catch (e) {
      document.getElementById('dashboard-content').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><p>${e.message}</p></div>`;
    }
  },

  renderCharts(data, vp) {
    if (vp) {
      this.renderTrendChart(data.months_trend);
      this.renderCategoryChart(data.category_values);
      this.renderTopChart(data.top_items);
    }
  },

  renderTrendChart(data) {
    const ctx = document.getElementById('trendChart'); if (!ctx) return;
    const tc = this.chartTextColor(), gc = this.chartGridColor();
    this.charts.push(new Chart(ctx, { type: 'bar', data: { labels: data.map(d => d.label), datasets: [
      { label: this.t('dash_in_amount'), data: data.map(d => d.in_amount), backgroundColor: '#3b82f6', borderRadius: 4 },
      { label: this.t('dash_out_cost'), data: data.map(d => d.out_amount), backgroundColor: '#f59e0b', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, color: tc } } }, scales: { y: { beginAtZero: true, ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } }, x: { ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } } } } }));
  },

  renderCategoryChart(data) {
    const ctx = document.getElementById('categoryChart'); if (!ctx) return;
    const tc = this.chartTextColor();
    const labels = Object.keys(data), values = Object.values(data);
    const colors = ['#3b82f6','#f59e0b','#16a34a','#dc2626','#0891b2','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1'];
    this.charts.push(new Chart(ctx, { type: 'doughnut', data: { labels, datasets: [{ data: values, backgroundColor: colors }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 }, color: tc } } } } }));
  },

  renderTopChart(data) {
    const ctx = document.getElementById('topChart'); if (!ctx) return;
    const tc = this.chartTextColor(), gc = this.chartGridColor();
    this.charts.push(new Chart(ctx, { type: 'bar', data: { labels: data.map(d => d.name), datasets: [{ label: this.t('dash_stock_value'), data: data.map(d => d.value), backgroundColor: '#3b82f6', borderRadius: 4 }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } }, y: { ticks: { font: { size: 11 }, color: tc }, grid: { color: gc } } } } }));
  },

  // ========== 物料档案 ==========
  async renderMaterials() {
    const addBtn = this.can('materials','create') ? `<button class="btn btn-primary" onclick="App.editMaterial()">+ ${this.t('mat_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('mat_filter', 'App.onMaterialsFilter()', addBtn);
    this.setMain(this.pageWrap('🏷 ' + this.t('mat_title'), this.t('mat_desc'), '', `<div id="materials-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="materials-scroll"></div><div class="data-pager" id="materials-pager"></div></div>`));
    try {
      this._materialsData = await this.api('/api/materials');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['materials'] = () => this.renderMaterialsTable();
      this.renderMaterialsTable();
    } catch (e) { document.getElementById('materials-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderMaterialsTable() {
    const data = this._materialsData;
    if (!data) return;
    const tid = 'materials';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('mat_filter')?.value || '';
    const vp = this.canViewPrice();
    const filterFields = ['code','name','spec','category','unit','opening_qty','opening_price','min_stock','default_location','brand','status'];
    const filtered = this.filterByKeywords(data, keywords, filterFields);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
      ['category', this.t('mat_category')], ['unit', this.t('mat_unit')], ['opening_qty', this.t('mat_opening_qty')],
      ...vp ? [['opening_price', this.t('mat_opening_price')]] : [],
      ['min_stock', this.t('mat_min_stock')],
      ['default_location', this.t('mat_location')], ['brand', this.t('mat_brand')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('mat_status')}</th><th></th>`;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(vp ? 12 : 11); }
    else { tbody = pageData.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.category}</td><td>${m.unit}</td><td class="text-right">${m.opening_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(m.opening_price)}</td>` : ''}<td class="text-right">${m.min_stock}</td><td>${m.default_location || ''}</td><td>${m.brand || ''}</td><td>${m.status === '停用' ? this.statusBadge('停用') : `<span class="badge badge-success">${this.t('mat_in_use')}</span>`}</td><td>${this.rowActions('materials', `App.editMaterial('${m.code}')`, `App.deleteMaterial('${m.code}')`)}</td></tr>`).join(''); }
    document.getElementById('materials-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('materials-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  async editMaterial(code) {
    let m = { code: '', name: '', spec: '', category: '', unit: '', opening_qty: 0, opening_price: 0, min_stock: 0, default_location: '', brand: '', status: '' };
    if (code) { const data = await this.api('/api/materials'); m = data.find(d => d.code === code) || m; }
    const cats = this.params.categories.map(c => c.name), units = this.params.units.map(u => u.name), locs = this.params.locations.map(l => l.name);
    const sel = (arr, val) => arr.map(a => `<option value="${a}" ${a === val ? 'selected' : ''}>${a}</option>`).join('');
    this.showModal(`<h3>${code ? this.t('mat_edit') : this.t('mat_add')}</h3>`, `<div class="form-grid">
      <div class="form-group"><label>${this.t('mat_code')} ${code ? '' : '(' + this.t('mat_code_auto') + ')'}</label><input id="m_code" value="${m.code}" ${code ? 'readonly' : 'readonly placeholder="' + this.t('mat_code_hint') + '"'}><div class="form-error" id="m_code_error"></div></div>
      <div class="form-group"><label>${this.t('mat_name')} *</label><input id="m_name" value="${m.name}" oninput="App.clearFieldError('m_name')"><div class="form-error" id="m_name_error"></div></div>
      <div class="form-group"><label>${this.t('mat_spec')}</label><input id="m_spec" value="${m.spec || ''}"></div>
      <div class="form-group"><label>${this.t('mat_category')} *</label><select id="m_category" onchange="App.onMaterialCategoryChange()"><option value="">${this.t('please_select')}</option>${sel(cats, m.category)}</select><div class="form-error" id="m_category_error"></div></div>
      <div class="form-group"><label>${this.t('mat_unit')} *</label><select id="m_unit" onchange="App.clearFieldError('m_unit')"><option value="">${this.t('please_select')}</option>${sel(units, m.unit)}</select><div class="form-error" id="m_unit_error"></div></div>
      <div class="form-group"><label>${this.t('mat_opening_qty')}</label><input id="m_opening_qty" type="number" step="0.01" value="${m.opening_qty}"></div>
      ${this.canViewPrice() ? `<div class="form-group"><label>${this.t('mat_opening_price')}</label><input id="m_opening_price" type="number" step="0.01" value="${m.opening_price}"></div>` : '<input id="m_opening_price" type="hidden" value="0">'}
      <div class="form-group"><label>${this.t('mat_min_stock')}</label><input id="m_min_stock" type="number" step="0.01" value="${m.min_stock}"></div>
      <div class="form-group"><label>${this.t('mat_location')}</label><select id="m_default_location"><option value="">${this.t('none')}</option>${sel(locs, m.default_location)}</select></div>
      <div class="form-group"><label>${this.t('mat_brand')}</label><input id="m_brand" value="${m.brand || ''}"></div>
      <div class="form-group"><label>${this.t('mat_status')}</label><select id="m_status"><option value="">${this.t('mat_in_use')}</option><option value="停用" ${m.status === '停用' ? 'selected' : ''}>${this.t('mat_stopped')}</option></select></div>
      </div>`, code ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ m_name: [{rule:'required'}], m_category: [{rule:'required'}], m_unit: [{rule:'required'}] })) return;
      const body = { code: document.getElementById('m_code').value.trim() || 'auto', name: document.getElementById('m_name').value.trim(), spec: document.getElementById('m_spec').value.trim(), category: document.getElementById('m_category').value, unit: document.getElementById('m_unit').value, opening_qty: parseFloat(document.getElementById('m_opening_qty').value) || 0, opening_price: parseFloat(document.getElementById('m_opening_price').value) || 0, min_stock: parseFloat(document.getElementById('m_min_stock').value) || 0, default_location: document.getElementById('m_default_location').value, brand: document.getElementById('m_brand').value.trim(), status: document.getElementById('m_status').value };
      try { await this.api('/api/materials' + (code ? '/' + code : ''), code ? 'PUT' : 'POST', body); this.closeModal(); this.toast(code ? this.t('updated') : this.t('added')); this.renderMaterials(); } catch (e) { this.toast(e.message, 'error'); }
    });
    // 新增模式下，初始如果有类别就触发
    if (!code && m.category) this.onMaterialCategoryChange();
  },

  async onMaterialCategoryChange() {
    const cat = document.getElementById('m_category')?.value;
    const codeEl = document.getElementById('m_code');
    if (!codeEl || codeEl.readOnly === false) return;
    if (cat) {
      try {
        const res = await this.api(`/api/materials/next-code?category=${encodeURIComponent(cat)}`);
        codeEl.value = res.code;
      } catch(e) { codeEl.value = ''; }
    } else {
      codeEl.value = '';
    }
  },

  async deleteMaterial(code) { this.confirmDialog(this.t('cf_delete_material') + ' ' + code, this.t('cf_delete_material_msg'), async () => { try { await this.api('/api/materials/' + code, 'DELETE'); this.toast(this.t('deleted')); this.renderMaterials(); } catch (e) { this.toast(e.message, 'error'); } }); },

  onMaterialsFilter() {
    const st = this.getTableState('materials');
    st.page = 1;
    this.renderMaterialsTable();
  },

  // ========== 入库记录 ==========
  async renderInbound() {
    const dateFilter = { fromId: 'in_date_from', toId: 'in_date_to', onChange: 'App.onInboundFilter()' };
    const addBtn = this.can('inbound','create') ? `<button class="btn btn-primary" onclick="App.editInboundBatch()">+ ${this.t('in_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('in_filter', 'App.onInboundFilter()', addBtn, dateFilter);
    this.setMain(this.pageWrap('📥 ' + this.t('in_title'), this.t('in_desc'), '', `<div id="inbound-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-summary" id="inbound-summary"></div><div class="data-scroll" id="inbound-scroll"></div><div class="data-pager" id="inbound-pager"></div></div>`));
    try {
      this._inboundData = await this.api('/api/inbound');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['inbound'] = () => this.renderInboundTable();
      this.renderInboundTable();
    } catch (e) { document.getElementById('inbound-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderInboundTable() {
    const data = this._inboundData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'inbound';
    const st = this.getTableState(tid);
    // 读取筛选值
    const keywords = document.getElementById('in_filter')?.value || '';
    const dateFrom = document.getElementById('in_date_from')?.value || '';
    const dateTo = document.getElementById('in_date_to')?.value || '';
    // 关键字 + 日期段筛选
    const filterFields = ['date','grn_no','code','material_name','material_spec','material_brand','material_unit','qty','price','amount','supplier','handler','location','po_no','contract_no','txn_type','remarks'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    filtered = this.filterByDateRange(filtered, 'date', dateFrom, dateTo);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    let totalQty = 0, totalAmount = 0; sorted.forEach(r => { totalQty += r.qty; totalAmount += r.amount; });
    const headers = [
      ['date', this.t('in_date')], ['grn_no', this.t('in_grn')], ['txn_type', this.t('in_txn_type')],
      ['code', this.t('mat_code')], ['material_name', this.t('mat_name')], ['material_spec', this.t('mat_spec')], ['material_brand', this.t('mat_brand')],
      ['material_unit', this.t('mat_unit')], ['qty', this.t('in_qty')],
      ...vp ? [['price', this.t('in_price')], ['amount', this.t('in_total_amount')]] : [],
      ['supplier', this.t('in_supplier')], ['handler', this.t('in_handler')],
      ['location', this.t('in_location')], ['po_no', this.t('in_po_no')], ['contract_no', this.t('in_contract')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('in_remarks')}</th><th></th>`;
    const colCount = headers.length + 2;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(r => { const txnBadge = r.txn_type === '采购退货' ? `<span class="badge badge-danger">${this.t('in_return')}</span>` : `<span class="badge badge-info">${this.t('in_purchase')}</span>`; return `<tr><td>${this.fmtDate(r.date)}</td><td>${r.grn_no}</td><td>${txnBadge}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_spec || ''}</td><td>${r.material_brand || ''}</td><td>${r.material_unit || ''}</td><td class="text-right">${r.qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.price)}</td><td class="text-right">${this.fmtMoney(r.amount)}</td>` : ''}<td>${r.supplier || ''}</td><td>${r.handler || ''}</td><td>${r.location || ''}</td><td>${r.po_no || ''}</td><td>${r.contract_no || ''}</td><td>${r.remarks || ''}</td><td>${this.rowActions('inbound', `App.editInbound(${r.id})`, `App.deleteInbound(${r.id})`)}</td></tr>`; }).join(''); }
    const filterActive = (keywords.trim() || dateFrom || dateTo) ? ` | 🔍 ${sorted.length}/${data.length}` : '';
    document.getElementById('inbound-summary').innerHTML = `${sorted.length} ${this.t('in_total_records')} | ${this.t('in_total_qty')}: ${totalQty}${vp ? ` | ${this.t('in_total_amount')}: ${cur} ${this.fmtMoney(totalAmount)}` : ''}${filterActive}`;
    document.getElementById('inbound-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('inbound-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onInboundFilter() {
    const st = this.getTableState('inbound');
    st.page = 1;
    this.renderInboundTable();
  },

  // 批量新增入库
  async editInboundBatch() {
    const materials = await this.api('/api/materials');
    const suppliers = await this.api('/api/suppliers');
    const orders = await this.api('/api/purchase-orders');
    const locs = this.params.locations.map(l => l.name);
    const today = new Date().toISOString().slice(0, 10);

    // #1: 只显示未到货和部分到货的订单
    const pendingOrders = orders.filter(o => o.delivery_status === '未到货' || o.delivery_status === '部分到货');
    // #1: 合同号下拉 — 从所有采购订单中提取去重的合同号
    const contractNos = [...new Set(orders.map(o => o.contract_no).filter(Boolean))].sort();
    const supOptions = suppliers.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    const poOptions = pendingOrders.length > 0
      ? pendingOrders.map(o => `<option value="${o.po_no}">${o.po_no} (${o.delivery_status})</option>`).join('')
      : `<option value="" disabled>${this.t('in_no_pending_orders')}</option>`;
    const contractOptions = contractNos.length > 0
      ? contractNos.map(c => `<option value="${c}">${c}</option>`).join('')
      : `<option value="" disabled>${this.t('in_no_contracts')}</option>`;
    const locOptions = locs.map(l => `<option value="${l}">${l}</option>`).join('');

    // #4: 物料三级联动数据准备
    this._materialsCache = materials;
    this._inboundOrders = orders;
    const vp = this.canViewPrice();
    const categories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();

    this.showModal(`<h3>${this.t('in_batch_title')}</h3>`, `<div style="margin-bottom:12px;font-size:12px;color:var(--text-muted)">${this.t('in_batch_desc')}</div>
      <div class="form-grid">
        <div class="form-group"><label>${this.t('in_date')} *</label><input id="ib_date" type="date" value="${today}"></div>
        <div class="form-group"><label>${this.t('in_txn_type')} *</label><select id="ib_txn_type"><option value="采购入库">${this.t('in_purchase')}</option><option value="采购退货">${this.t('in_return')}</option></select></div>
        <div class="form-group"><label>${this.t('in_supplier')}</label><select id="ib_supplier"><option value="">${this.t('none')}</option>${supOptions}</select></div>
        <div class="form-group"><label>${this.t('in_handler')}</label><input id="ib_handler" value=""></div>
        <div class="form-group"><label>${this.t('in_location')}</label><select id="ib_location"><option value="">${this.t('none')}</option>${locOptions}</select></div>
        <div class="form-group" style="grid-column:span 2">
          <label>${this.t('in_source_mode')}</label>
          <div style="display:flex;gap:8px;align-items:center">
            <select id="ib_source_mode" onchange="App.onInboundSourceModeChange()" style="width:140px">
              <option value="manual">${this.t('in_source_manual')}</option>
              <option value="po">${this.t('in_source_po')}</option>
              <option value="contract">${this.t('in_source_contract')}</option>
            </select>
            <div id="ib_po_wrap" style="display:none;flex:1">
              <select id="ib_po_no" onchange="App.loadOrderLinesForInbound()" style="width:100%"><option value="">${this.t('in_select_order')}</option>${poOptions}</select>
            </div>
            <div id="ib_contract_wrap" style="display:none;flex:1">
              <select id="ib_contract_no" onchange="App.loadOrderLinesForInboundByContract()" style="width:100%"><option value="">${this.t('in_select_contract')}</option>${contractOptions}</select>
            </div>
          </div>
        </div>
      </div>
      <div id="ib_order_lines" style="display:none;margin-bottom:12px"></div>
      <div class="card" style="margin-top:12px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${this.t('in_title')}</strong>
          <button class="btn btn-outline btn-sm" onclick="App.addInboundRow()">+ ${this.t('in_add_row')}</button>
        </div>
        <div class="table-wrap"><table id="ib_table"><thead><tr>
          <th>${this.t('mat_level_category')}</th><th>${this.t('mat_level_name')}</th><th>${this.t('mat_level_spec')}</th><th>${this.t('mat_level_brand')}</th><th>${this.t('in_qty')} *</th>${vp ? `<th>${this.t('in_price')}</th>` : ''}<th>${this.t('in_remarks')}</th><th></th>
        </tr></thead><tbody id="ib_rows"></tbody></table></div>
      </div>`, this.t('in_batch_submit'), async () => {
      const date = document.getElementById('ib_date').value;
      const txnType = document.getElementById('ib_txn_type').value;
      const supplier = document.getElementById('ib_supplier').value;
      const handler = document.getElementById('ib_handler').value.trim();
      const location = document.getElementById('ib_location').value;
      const poNo = document.getElementById('ib_po_no').value;
      const contractNo = document.getElementById('ib_contract_no').value;
      if (!date) { this.toast(this.t('field_required'), 'error'); return; }
      // 收集行数据
      const rows = document.querySelectorAll('#ib_rows tr');
      const items = [];
      rows.forEach(tr => {
        const code = tr.getAttribute('data-code') || '';
        const qty = parseFloat(tr.querySelector('.ib-qty').value) || 0;
        const price = parseFloat(tr.querySelector('.ib-price').value) || 0;
        const remarks = tr.querySelector('.ib-remarks').value.trim();
        if (code && qty > 0) {
          const actualQty = txnType === '采购退货' ? -qty : qty;
          const actualPrice = txnType === '采购退货' ? -price : price;
          items.push({ date, code, qty: actualQty, price: actualPrice, supplier, handler, location, remarks, po_no: poNo, contract_no: contractNo, txn_type: txnType });
        }
      });
      if (items.length === 0) { this.toast(this.t('fillRequired'), 'error'); return; }
      try {
        await this.api('/api/inbound', 'POST', { items });
        this.closeModal();
        this.toast(this.t('added') + ' (' + items.length + ')');
        this.renderInbound();
      } catch (e) { this.toast(e.message, 'error'); }
    }, null, true); // large modal

    // #4: 缓存物料数据供三级联动使用
    this._materialsCache = materials;
    this._inboundMatCategories = categories;
    // 默认加3个空行
    this.addInboundRow();
    this.addInboundRow();
    this.addInboundRow();
  },

  // #1: 入库方式切换
  onInboundSourceModeChange() {
    const mode = document.getElementById('ib_source_mode').value;
    document.getElementById('ib_po_wrap').style.display = mode === 'po' ? 'flex' : 'none';
    document.getElementById('ib_contract_wrap').style.display = mode === 'contract' ? 'flex' : 'none';
    // 切换模式时清空订单明细区域
    const c = document.getElementById('ib_order_lines');
    if (c) { c.style.display = 'none'; c.innerHTML = ''; }
  },

  // #4: 批量入库行 — 三级联动物料选择（类别→名称→规格品牌）
  addInboundRow(code = '', qty = '', price = '', remarks = '', spec = '', brand = '') {
    const cats = this._inboundMatCategories || [];
    const materials = this._materialsCache || [];
    const tbody = document.getElementById('ib_rows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.setAttribute('data-code', code);
    // 查找预选物料的 category 和 name
    const mat = code ? materials.find(m => m.code === code) : null;
    const preCat = mat ? mat.category : '';
    const preName = mat ? mat.name : '';

    // 第一级：类别
    const catOpts = cats.map(c => `<option value="${c}" ${c === preCat ? 'selected' : ''}>${c}</option>`).join('');
    // 第二级：名称（基于选中的类别筛选）
    const names = preCat ? [...new Set(materials.filter(m => m.category === preCat).map(m => m.name))] : [];
    const nameOpts = names.map(n => `<option value="${n}" ${n === preName ? 'selected' : ''}>${n}</option>`).join('');
    // 第三级：规格品牌（基于选中的类别+名称筛选）
    const specs = (preCat && preName) ? materials.filter(m => m.category === preCat && m.name === preName) : [];
    const specOpts = specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}" ${m.code === code ? 'selected' : ''}>${label}</option>`;
    }).join('');

    const vp = this.canViewPrice();
    tr.innerHTML = `<td><select class="ib-cat" onchange="App.onInboundRowCatChange(this)" style="width:120px"><option value="">${this.t('please_select')}</option>${catOpts}</select></td>
      <td><select class="ib-name" onchange="App.onInboundRowNameChange(this)" style="width:140px" ${!preCat ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${nameOpts}</select></td>
      <td><select class="ib-spec-sel" onchange="App.onInboundRowSpecChange(this)" style="width:200px" ${!preName ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${specOpts}</select></td>
      <td class="ib-brand" style="font-size:12px;color:var(--text-muted)">${brand}</td>
      <td><input class="ib-qty" type="number" step="0.01" value="${qty}" style="width:80px"></td>
      ${vp ? `<td><input class="ib-price" type="number" step="0.01" value="${price}" style="width:90px"></td>` : '<td class="ib-price" style="display:none"><input class="ib-price" type="hidden" value="0"></td>'}
      <td><input class="ib-remarks" value="${remarks}" style="width:120px"></td>
      <td><span class="action-link danger" onclick="this.parentElement.parentElement.remove()">${this.t('in_remove_row')}</span></td>`;
    tbody.appendChild(tr);
  },

  onInboundRowCatChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = selEl.value;
    const materials = this._materialsCache || [];
    const names = cat ? [...new Set(materials.filter(m => m.category === cat).map(m => m.name))] : [];
    const nameSel = tr.querySelector('.ib-name');
    nameSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + names.map(n => `<option value="${n}">${n}</option>`).join('');
    nameSel.disabled = !cat;
    // 重置第三级
    const specSel = tr.querySelector('.ib-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>`;
    specSel.disabled = true;
    tr.querySelector('.ib-brand').textContent = '';
    tr.setAttribute('data-code', '');
  },

  onInboundRowNameChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = tr.querySelector('.ib-cat').value;
    const name = selEl.value;
    const materials = this._materialsCache || [];
    const specs = (cat && name) ? materials.filter(m => m.category === cat && m.name === name) : [];
    const specSel = tr.querySelector('.ib-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}">${label}</option>`;
    }).join('');
    specSel.disabled = !name;
    tr.querySelector('.ib-brand').textContent = '';
    tr.setAttribute('data-code', '');
  },

  onInboundRowSpecChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const code = selEl.value;
    const m = (this._materialsCache || []).find(x => x.code === code);
    if (m) {
      tr.querySelector('.ib-brand').textContent = m.brand || '';
      tr.setAttribute('data-code', code);
      // 如果单价为空，带出期初单价作为默认
      const priceInput = tr.querySelector('.ib-price');
      if (!priceInput.value) priceInput.value = m.opening_price || '';
    } else {
      tr.querySelector('.ib-brand').textContent = '';
      tr.setAttribute('data-code', '');
    }
  },

  async loadOrderLinesForInbound() {
    const poNo = document.getElementById('ib_po_no').value;
    const container = document.getElementById('ib_order_lines');
    if (!poNo) { container.style.display = 'none'; container.innerHTML = ''; return; }
    try {
      const lines = await this.api(`/api/order-lines/by-po/${encodeURIComponent(poNo)}`);
      // 选采购单号时自动关联合同号
      const orders = this._inboundOrders || [];
      const order = orders.find(o => o.po_no === poNo);
      if (order && order.contract_no) {
        const conSel = document.getElementById('ib_contract_no');
        if (conSel) conSel.value = order.contract_no;
      }
      if (lines.length === 0) { container.style.display = 'none'; return; }
      // 缓存行数据
      this._inboundOrderLines = lines;
      container.style.display = 'block';
      let rowsHtml = '';
      const vp = this.canViewPrice();
      lines.forEach((l, i) => {
        rowsHtml += `<tr><td>${l.code}</td><td>${l.material_name || ''} ${l.material_spec || ''}</td><td class="text-right">${l.order_qty}</td><td class="text-right">${l.received_qty}</td><td class="text-right">${l.unreceived_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(l.order_price)}</td>` : ''}<td><button class="btn btn-primary btn-sm" data-fill="${i}">${this.t('in_fill_qty')}</button></td></tr>`;
      });
      container.innerHTML = `<div class="card" style="padding:10px"><div style="font-weight:600;margin-bottom:6px">${this.t('in_order_lines')} — ${poNo}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('po_order_qty')}</th><th>${this.t('po_received_qty')}</th><th>${this.t('po_unreceived')}</th>${vp ? `<th>${this.t('po_order_price')}</th>` : ''}<th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div></div>`;
      // 绑定点击事件
      container.querySelectorAll('[data-fill]').forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.getAttribute('data-fill'));
          const l = this._inboundOrderLines[idx];
          if (l) this.addInboundRow(l.code, l.unreceived_qty, l.order_price, '', l.material_spec || '', l.material_brand || '');
        };
      });
    } catch(e) { container.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`; }
  },

  // #1: 按合同号带出未到货明细
  async loadOrderLinesForInboundByContract() {
    const contractNo = document.getElementById('ib_contract_no').value;
    const container = document.getElementById('ib_order_lines');
    if (!contractNo) { container.style.display = 'none'; container.innerHTML = ''; return; }
    try {
      const lines = await this.api(`/api/order-lines/by-contract/${encodeURIComponent(contractNo)}`);
      if (lines.length === 0) { container.style.display = 'none'; return; }
      this._inboundOrderLines = lines;
      container.style.display = 'block';
      let rowsHtml = '';
      const vp = this.canViewPrice();
      lines.forEach((l, i) => {
        rowsHtml += `<tr><td>${l.code}</td><td>${l.material_name || ''} ${l.material_spec || ''}</td><td>${l.po_no}</td><td class="text-right">${l.order_qty}</td><td class="text-right">${l.received_qty}</td><td class="text-right">${l.unreceived_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(l.order_price)}</td>` : ''}<td><button class="btn btn-primary btn-sm" data-fill="${i}">${this.t('in_fill_qty')}</button></td></tr>`;
      });
      container.innerHTML = `<div class="card" style="padding:10px"><div style="font-weight:600;margin-bottom:6px">${this.t('in_order_lines')} — ${this.t('in_contract')}: ${contractNo}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('in_po_no')}</th><th>${this.t('po_order_qty')}</th><th>${this.t('po_received_qty')}</th><th>${this.t('po_unreceived')}</th>${vp ? `<th>${this.t('po_order_price')}</th>` : ''}<th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div></div>`;
      // 绑定点击事件
      container.querySelectorAll('[data-fill]').forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.getAttribute('data-fill'));
          const l = this._inboundOrderLines[idx];
          if (l) {
            this.addInboundRow(l.code, l.unreceived_qty, l.order_price, '', l.material_spec || '', l.material_brand || '');
            // 点击填写时自动关联采购单号
            if (l.po_no) {
              const poSel = document.getElementById('ib_po_no');
              if (poSel) poSel.value = l.po_no;
            }
          }
        };
      });
    } catch(e) { container.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`; }
  },

  // 编辑单行入库（保留原有功能）
  async editInbound(id) {
    let r = { date: new Date().toISOString().slice(0, 10), grn_no: '', code: '', qty: '', price: '', supplier: '', handler: '', location: '', remarks: '', po_no: '', contract_no: '', txn_type: '采购入库' };
    if (id) { const data = await this.api('/api/inbound'); r = data.find(d => d.id === id) || r; }
    const materials = await this.api('/api/materials'), suppliers = await this.api('/api/suppliers'), orders = await this.api('/api/purchase-orders');
    const locs = this.params.locations.map(l => l.name);
    const matSel = materials.map(m => `<option value="${m.code}" ${m.code === r.code ? 'selected' : ''}>${m.name} ${m.spec || ''} ${m.brand || ''} (${m.code})</option>`).join('');
    const supSel = suppliers.map(s => `<option value="${s.name}" ${s.name === r.supplier ? 'selected' : ''}>${s.name}</option>`).join('');
    const poSel = orders.map(o => `<option value="${o.po_no}" ${o.po_no === r.po_no ? 'selected' : ''}>${o.po_no}</option>`).join('');
    const locSel = locs.map(l => `<option value="${l}" ${l === r.location ? 'selected' : ''}>${l}</option>`).join('');
    this.showModal(`<h3>${id ? this.t('in_edit') : this.t('in_add')}</h3>`, `<div class="form-grid">
      <div class="form-group"><label>${this.t('in_date')} *</label><input id="i_date" type="date" value="${this.fmtDate(r.date)}" oninput="App.clearFieldError('i_date')"><div class="form-error" id="i_date_error"></div></div>
      <div class="form-group"><label>${this.t('in_txn_type')}</label><select id="i_txn_type"><option value="采购入库" ${r.txn_type === '采购入库' ? 'selected' : ''}>${this.t('in_purchase')}</option><option value="采购退货" ${r.txn_type === '采购退货' ? 'selected' : ''}>${this.t('in_return')}</option></select></div>
      <div class="form-group"><label>${this.t('in_grn')} (${this.t('in_grn_auto')})</label><input id="i_grn_no" value="${r.grn_no}" placeholder="${this.t('in_grn_ph')}"></div>
      <div class="form-group"><label>${this.t('in_material')} *</label><select id="i_code" onchange="App.clearFieldError('i_code')"><option value="">${this.t('please_select')}</option>${matSel}</select><div class="form-error" id="i_code_error"></div></div>
      <div class="form-group"><label>${this.t('in_qty')} *</label><input id="i_qty" type="number" step="0.01" value="${r.qty}" oninput="App.clearFieldError('i_qty')"><div class="form-error" id="i_qty_error"></div></div>
      <div class="form-group">${this.canViewPrice() ? `<label>${this.t('in_price')}</label><input id="i_price" type="number" step="0.01" value="${r.price}" oninput="App.clearFieldError('i_price')"><div class="form-error" id="i_price_error"></div>` : `<input id="i_price" type="hidden" value="0">`}</div>
      <div class="form-group"><label>${this.t('in_supplier')}</label><select id="i_supplier"><option value="">${this.t('none')}</option>${supSel}</select></div>
      <div class="form-group"><label>${this.t('in_handler')}</label><input id="i_handler" value="${r.handler || ''}"></div>
      <div class="form-group"><label>${this.t('in_location')}</label><select id="i_location"><option value="">${this.t('none')}</option>${locSel}</select></div>
      <div class="form-group"><label>${this.t('in_po_no')}</label><select id="i_po_no"><option value="">${this.t('none')}</option>${poSel}</select></div>
      <div class="form-group"><label>${this.t('in_contract')}</label><input id="i_contract_no" value="${r.contract_no || ''}"></div>
      <div class="form-group" style="grid-column:span 2"><label>${this.t('in_remarks')}</label><input id="i_remarks" value="${r.remarks || ''}"></div></div>`, id ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ i_date: [{rule:'required'}], i_code: [{rule:'required'}], i_qty: [{rule:'required'},{rule:'number'}] })) return;
      const txnType = document.getElementById('i_txn_type').value;
      let qty = parseFloat(document.getElementById('i_qty').value) || 0;
      let price = parseFloat(document.getElementById('i_price').value) || 0;
      // 采购退货：qty 和 price 转负数
      if (txnType === '采购退货') { qty = -Math.abs(qty); price = -Math.abs(price); }
      const body = { date: document.getElementById('i_date').value, grn_no: document.getElementById('i_grn_no').value.trim(), code: document.getElementById('i_code').value, qty, price, supplier: document.getElementById('i_supplier').value, handler: document.getElementById('i_handler').value.trim(), location: document.getElementById('i_location').value, po_no: document.getElementById('i_po_no').value, contract_no: document.getElementById('i_contract_no').value.trim(), remarks: document.getElementById('i_remarks').value.trim(), txn_type: txnType };
      try { await this.api('/api/inbound' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body); this.closeModal(); this.toast(id ? this.t('updated') : this.t('added')); this.renderInbound(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  async deleteInbound(id) { this.confirmDialog(this.t('cf_delete_inbound'), '', async () => { try { await this.api('/api/inbound/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderInbound(); } catch (e) { this.toast(e.message, 'error'); } }); },

  // ========== 出库记录 ==========
  async renderOutbound() {
    const dateFilter = { fromId: 'out_date_from', toId: 'out_date_to', onChange: 'App.onOutboundFilter()' };
    const addBtn = this.can('outbound','create') ? `<button class="btn btn-primary" onclick="App.editOutboundBatch()">+ ${this.t('out_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('out_filter', 'App.onOutboundFilter()', addBtn, dateFilter);
    this.setMain(this.pageWrap('📤 ' + this.t('out_title'), this.t('out_desc'), '', `<div id="outbound-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-summary" id="outbound-summary"></div><div class="data-scroll" id="outbound-scroll"></div><div class="data-pager" id="outbound-pager"></div></div>`));
    try {
      this._outboundData = await this.api('/api/outbound');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['outbound'] = () => this.renderOutboundTable();
      this.renderOutboundTable();
    } catch (e) { document.getElementById('outbound-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderOutboundTable() {
    const data = this._outboundData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'outbound';
    const st = this.getTableState(tid);
    // 读取筛选值
    const keywords = document.getElementById('out_filter')?.value || '';
    const dateFrom = document.getElementById('out_date_from')?.value || '';
    const dateTo = document.getElementById('out_date_to')?.value || '';
    // 关键字 + 日期段筛选
    const filterFields = ['date','gin_no','code','material_name','material_spec','material_brand','material_unit','qty','destination','receiver','handler','location','cost_price','cost_amount','txn_type','remarks'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    filtered = this.filterByDateRange(filtered, 'date', dateFrom, dateTo);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    let totalQty = 0, totalAmount = 0; sorted.forEach(r => { totalQty += r.qty; totalAmount += r.cost_amount; });
    const headers = [
      ['date', this.t('out_date')], ['gin_no', this.t('out_gin')], ['txn_type', this.t('out_txn_type')],
      ['code', this.t('mat_code')], ['material_name', this.t('mat_name')], ['material_spec', this.t('mat_spec')], ['material_brand', this.t('mat_brand')],
      ['material_unit', this.t('mat_unit')], ['qty', this.t('out_qty')], ['destination', this.t('out_destination')],
      ['receiver', this.t('out_receiver')], ['handler', this.t('out_handler')], ['location', this.t('out_location')],
      ...vp ? [['cost_price', this.t('out_cost_price')], ['cost_amount', this.t('out_cost_amount')]] : []
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('out_remarks')}</th><th></th>`;
    const colCount = headers.length + 2;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(r => { const txnBadge = r.txn_type === '退库出库' ? `<span class="badge badge-danger">${this.t('out_return')}</span>` : `<span class="badge badge-info">${this.t('out_normal')}</span>`; return `<tr><td>${this.fmtDate(r.date)}</td><td>${r.gin_no}</td><td>${txnBadge}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_spec || ''}</td><td>${r.material_brand || ''}</td><td>${r.material_unit || ''}</td><td class="text-right">${r.qty}</td><td>${r.destination || ''}</td><td>${r.receiver || ''}</td><td>${r.handler || ''}</td><td>${r.location || ''}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.cost_price)}</td><td class="text-right">${this.fmtMoney(r.cost_amount)}</td>` : ''}<td>${r.remarks || ''}</td><td>${this.rowActions('outbound', `App.editOutbound(${r.id})`, `App.deleteOutbound(${r.id})`)}</td></tr>`; }).join(''); }
    const filterActive = (keywords.trim() || dateFrom || dateTo) ? ` | 🔍 ${sorted.length}/${data.length}` : '';
    document.getElementById('outbound-summary').innerHTML = `${sorted.length} ${this.t('out_total_records')} | ${this.t('out_total_qty')}: ${totalQty}${vp ? ` | ${this.t('out_total_amount')}: ${cur} ${this.fmtMoney(totalAmount)}` : ''}${filterActive}`;
    document.getElementById('outbound-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('outbound-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onOutboundFilter() {
    const st = this.getTableState('outbound');
    st.page = 1;
    this.renderOutboundTable();
  },

  // 批量新增出库
  async editOutboundBatch() {
    const materials = await this.api('/api/materials');
    const dests = this.params.destinations.map(d => d.name);
    const locs = this.params.locations.map(l => l.name);
    const today = new Date().toISOString().slice(0, 10);

    const destOptions = dests.map(d => `<option value="${d}">${d}</option>`).join('');
    const locOptions = locs.map(l => `<option value="${l}">${l}</option>`).join('');

    // #4: 物料三级联动数据准备
    this._materialsCache = materials;
    this._outboundMatCategories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    const vp = this.canViewPrice();

    this.showModal(`<h3>${this.t('out_batch_title')}</h3>`, `<div style="margin-bottom:12px;font-size:12px;color:var(--text-muted)">${this.t('out_batch_desc')}</div>
      <div class="form-grid">
        <div class="form-group"><label>${this.t('out_date')} *</label><input id="ob_date" type="date" value="${today}"></div>
        <div class="form-group"><label>${this.t('out_txn_type')} *</label><select id="ob_txn_type"><option value="正常出库">${this.t('out_normal')}</option><option value="退库出库">${this.t('out_return')}</option></select></div>
        <div class="form-group"><label>${this.t('out_destination')}</label><select id="ob_destination"><option value="">${this.t('none')}</option>${destOptions}</select></div>
        <div class="form-group"><label>${this.t('out_receiver')}</label><input id="ob_receiver" value=""></div>
        <div class="form-group"><label>${this.t('out_handler')}</label><input id="ob_handler" value=""></div>
        <div class="form-group"><label>${this.t('out_location')}</label><select id="ob_location"><option value="">${this.t('none')}</option>${locOptions}</select></div>
      </div>
      <div class="card" style="margin-top:12px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${this.t('out_title')}</strong>
          <button class="btn btn-outline btn-sm" onclick="App.addOutboundRow()">+ ${this.t('out_add_row')}</button>
        </div>
        <div class="table-wrap"><table id="ob_table"><thead><tr>
          <th>${this.t('mat_level_category')}</th><th>${this.t('mat_level_name')}</th><th>${this.t('mat_level_spec')}</th><th>${this.t('mat_level_brand')}</th><th>${this.t('out_qty')} *</th>${vp ? `<th>${this.t('out_cost_price')}</th>` : ''}<th>${this.t('out_remarks')}</th><th></th>
        </tr></thead><tbody id="ob_rows"></tbody></table></div>
      </div>
      <div style="margin-top:8px;padding:8px 12px;background:var(--primary-light);border-radius:6px;font-size:12px;color:var(--text-muted)">💡 ${this.t('out_cost_hint')}</div>`, this.t('out_batch_submit'), async () => {
      const date = document.getElementById('ob_date').value;
      const txnType = document.getElementById('ob_txn_type').value;
      const destination = document.getElementById('ob_destination').value;
      const receiver = document.getElementById('ob_receiver').value.trim();
      const handler = document.getElementById('ob_handler').value.trim();
      const location = document.getElementById('ob_location').value;
      if (!date) { this.toast(this.t('field_required'), 'error'); return; }
      const rows = document.querySelectorAll('#ob_rows tr');
      const items = [];
      rows.forEach(tr => {
        const code = tr.getAttribute('data-code') || '';
        const qty = parseFloat(tr.querySelector('.ob-qty').value) || 0;
        const remarks = tr.querySelector('.ob-remarks').value.trim();
        if (code && qty > 0) {
          const actualQty = txnType === '退库出库' ? -qty : qty;
          items.push({ date, code, qty: actualQty, destination, receiver, handler, location, remarks, txn_type: txnType });
        }
      });
      if (items.length === 0) { this.toast(this.t('fillRequired'), 'error'); return; }
      try {
        await this.api('/api/outbound', 'POST', { items });
        this.closeModal();
        this.toast(this.t('added') + ' (' + items.length + ')');
        this.renderOutbound();
      } catch (e) { this.toast(e.message, 'error'); }
    }, null, true); // large modal

    this.addOutboundRow();
    this.addOutboundRow();
    this.addOutboundRow();
  },

  // #4: 批量出库行 — 三级联动物料选择（类别→名称→规格品牌）
  addOutboundRow(code = '', qty = '', remarks = '', spec = '', brand = '') {
    const cats = this._outboundMatCategories || [];
    const materials = this._materialsCache || [];
    const tbody = document.getElementById('ob_rows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.setAttribute('data-code', code);
    const mat = code ? materials.find(m => m.code === code) : null;
    const preCat = mat ? mat.category : '';
    const preName = mat ? mat.name : '';

    const catOpts = cats.map(c => `<option value="${c}" ${c === preCat ? 'selected' : ''}>${c}</option>`).join('');
    const names = preCat ? [...new Set(materials.filter(m => m.category === preCat).map(m => m.name))] : [];
    const nameOpts = names.map(n => `<option value="${n}" ${n === preName ? 'selected' : ''}>${n}</option>`).join('');
    const specs = (preCat && preName) ? materials.filter(m => m.category === preCat && m.name === preName) : [];
    const specOpts = specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}" ${m.code === code ? 'selected' : ''}>${label}</option>`;
    }).join('');

    const vp = this.canViewPrice();
    tr.innerHTML = `<td><select class="ob-cat" onchange="App.onOutboundRowCatChange(this)" style="width:120px"><option value="">${this.t('please_select')}</option>${catOpts}</select></td>
      <td><select class="ob-name" onchange="App.onOutboundRowNameChange(this)" style="width:140px" ${!preCat ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${nameOpts}</select></td>
      <td><select class="ob-spec-sel" onchange="App.onOutboundRowSpecChange(this)" style="width:200px" ${!preName ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${specOpts}</select></td>
      <td class="ob-brand" style="font-size:12px;color:var(--text-muted)">${brand}</td>
      <td><input class="ob-qty" type="number" step="0.01" value="${qty}" style="width:80px"></td>
      ${vp ? `<td class="ob-cost" style="font-size:12px;color:var(--text-muted)">-</td>` : ''}
      <td><input class="ob-remarks" value="${remarks}" style="width:120px"></td>
      <td><span class="action-link danger" onclick="this.parentElement.parentElement.remove()">${this.t('out_remove_row')}</span></td>`;
    tbody.appendChild(tr);
  },

  onOutboundRowCatChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = selEl.value;
    const materials = this._materialsCache || [];
    const names = cat ? [...new Set(materials.filter(m => m.category === cat).map(m => m.name))] : [];
    const nameSel = tr.querySelector('.ob-name');
    nameSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + names.map(n => `<option value="${n}">${n}</option>`).join('');
    nameSel.disabled = !cat;
    const specSel = tr.querySelector('.ob-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>`;
    specSel.disabled = true;
    tr.querySelector('.ob-brand').textContent = '';
    tr.setAttribute('data-code', '');
  },

  onOutboundRowNameChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = tr.querySelector('.ob-cat').value;
    const name = selEl.value;
    const materials = this._materialsCache || [];
    const specs = (cat && name) ? materials.filter(m => m.category === cat && m.name === name) : [];
    const specSel = tr.querySelector('.ob-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}">${label}</option>`;
    }).join('');
    specSel.disabled = !name;
    tr.querySelector('.ob-brand').textContent = '';
    tr.setAttribute('data-code', '');
  },

  onOutboundRowSpecChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const code = selEl.value;
    const m = (this._materialsCache || []).find(x => x.code === code);
    if (m) {
      tr.querySelector('.ob-brand').textContent = m.brand || '';
      tr.setAttribute('data-code', code);
    } else {
      tr.querySelector('.ob-brand').textContent = '';
      tr.setAttribute('data-code', '');
    }
  },

  // 编辑单行出库
  async editOutbound(id) {
    let r = { date: new Date().toISOString().slice(0, 10), gin_no: '', code: '', qty: '', destination: '', receiver: '', handler: '', location: '', remarks: '', txn_type: '正常出库' };
    if (id) { const data = await this.api('/api/outbound'); r = data.find(d => d.id === id) || r; }
    const materials = await this.api('/api/materials'), dests = this.params.destinations.map(d => d.name), locs = this.params.locations.map(l => l.name);
    const matSel = materials.map(m => `<option value="${m.code}" ${m.code === r.code ? 'selected' : ''}>${m.name} ${m.spec || ''} ${m.brand || ''} (${m.code})</option>`).join('');
    const destSel = dests.map(d => `<option value="${d}" ${d === r.destination ? 'selected' : ''}>${d}</option>`).join('');
    const locSel = locs.map(l => `<option value="${l}" ${l === r.location ? 'selected' : ''}>${l}</option>`).join('');
    this.showModal(`<h3>${id ? this.t('out_edit') : this.t('out_add')}</h3>`, `<div class="form-grid">
      <div class="form-group"><label>${this.t('out_date')} *</label><input id="o_date" type="date" value="${this.fmtDate(r.date)}" oninput="App.clearFieldError('o_date')"><div class="form-error" id="o_date_error"></div></div>
      <div class="form-group"><label>${this.t('out_txn_type')}</label><select id="o_txn_type"><option value="正常出库" ${r.txn_type === '正常出库' ? 'selected' : ''}>${this.t('out_normal')}</option><option value="退库出库" ${r.txn_type === '退库出库' ? 'selected' : ''}>${this.t('out_return')}</option></select></div>
      <div class="form-group"><label>${this.t('out_gin')} (${this.t('out_gin_auto')})</label><input id="o_gin_no" value="${r.gin_no}" placeholder="${this.t('in_grn_ph')}"></div>
      <div class="form-group"><label>${this.t('out_material')} *</label><select id="o_code" onchange="App.clearFieldError('o_code')"><option value="">${this.t('please_select')}</option>${matSel}</select><div class="form-error" id="o_code_error"></div></div>
      <div class="form-group"><label>${this.t('out_qty')} *</label><input id="o_qty" type="number" step="0.01" value="${r.qty}" oninput="App.clearFieldError('o_qty')"><div class="form-error" id="o_qty_error"></div></div>
      <div class="form-group"><label>${this.t('out_destination')}</label><select id="o_destination"><option value="">${this.t('none')}</option>${destSel}</select></div>
      <div class="form-group"><label>${this.t('out_receiver')}</label><input id="o_receiver" value="${r.receiver || ''}"></div>
      <div class="form-group"><label>${this.t('out_handler')}</label><input id="o_handler" value="${r.handler || ''}"></div>
      <div class="form-group"><label>${this.t('out_location')}</label><select id="o_location"><option value="">${this.t('none')}</option>${locSel}</select></div>
      <div class="form-group" style="grid-column:span 2"><label>${this.t('out_remarks')}</label><input id="o_remarks" value="${r.remarks || ''}"></div></div>
      <div style="margin-top:8px;padding:8px 12px;background:var(--primary-light);border-radius:6px;font-size:12px;color:var(--text-muted)">💡 ${this.t('out_cost_hint')}</div>`, id ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ o_date: [{rule:'required'}], o_code: [{rule:'required'}], o_qty: [{rule:'required'},{rule:'number'},{rule:'positive'}] })) return;
      const txnType = document.getElementById('o_txn_type').value;
      let qty = parseFloat(document.getElementById('o_qty').value) || 0;
      // 退库出库：qty 转负数
      if (txnType === '退库出库') qty = -Math.abs(qty);
      const body = { date: document.getElementById('o_date').value, gin_no: document.getElementById('o_gin_no').value.trim(), code: document.getElementById('o_code').value, qty, destination: document.getElementById('o_destination').value, receiver: document.getElementById('o_receiver').value.trim(), handler: document.getElementById('o_handler').value.trim(), location: document.getElementById('o_location').value, remarks: document.getElementById('o_remarks').value.trim(), txn_type: txnType };
      try { await this.api('/api/outbound' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body); this.closeModal(); this.toast(id ? this.t('updated') : this.t('added')); this.renderOutbound(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  async deleteOutbound(id) { this.confirmDialog(this.t('cf_delete_outbound'), '', async () => { try { await this.api('/api/outbound/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderOutbound(); } catch (e) { this.toast(e.message, 'error'); } }); },

  // ========== 库存汇总 ==========
  async renderStockSummary() {
    this.setMain(this.pageWrap('📦 ' + this.t('stock_title'), this.t('stock_desc'), '', `<div class="data-page"><div class="data-toolbar"><div class="filter-bar" style="margin:0;padding:0;background:none;box-shadow:none"><div class="form-group"><label>${this.t('stock_keyword')}</label><input id="s_keyword" placeholder="${this.t('quick_filter_ph')}" oninput="App.renderStockTable()"></div><div class="form-group"><label>${this.t('stock_category')}</label><select id="s_category" onchange="App.renderStockTable()"><option value="">${this.t('stock_all')}</option>${this.params.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}</select></div><div class="form-group"><label>${this.t('stock_status')}</label><select id="s_status" onchange="App.renderStockTable()"><option value="">${this.t('stock_all')}</option><option value="正常">${this.t('st_normal')}</option><option value="补货">${this.t('st_restock')}</option><option value="缺货">${this.t('st_out')}</option></select></div></div></div><div class="data-summary" id="stock-summary"></div><div class="data-scroll" id="stock-scroll"></div><div class="data-pager" id="stock-pager"></div></div>`));
    try {
      this._stockData = await this.api('/api/stock-summary');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['stock'] = () => this.renderStockTable();
      this.renderStockTable();
    } catch (e) { document.getElementById('stock-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderStockTable() {
    const data = this._stockData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'stock';
    const st = this.getTableState(tid);
    // 多关键字 + 类别 + 状态筛选（前端）
    const keywords = document.getElementById('s_keyword')?.value || '';
    const category = document.getElementById('s_category')?.value || '';
    const status = document.getElementById('s_status')?.value || '';
    const filterFields = ['code','name','spec','category','unit','brand','stock_status','on_hand','min_stock','opening_qty','total_in','total_out'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    if (category) filtered = filtered.filter(m => m.category === category);
    if (status) filtered = filtered.filter(m => m.stock_status === status);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const totalValue = sorted.reduce((s, m) => s + m.stock_value, 0);
    const alerts = sorted.filter(m => m.stock_status === '补货' || m.stock_status === '缺货').length;
    const headers = [
      ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
      ['category', this.t('mat_category')], ['unit', this.t('mat_unit')], ['opening_qty', this.t('stock_opening')],
      ['total_in', this.t('stock_total_in')], ['total_out', this.t('stock_total_out')], ['on_hand', this.t('stock_on_hand')],
      ['min_stock', this.t('stock_min')], ['stock_status', this.t('mat_status')],
      ...vp ? [['avg_price', this.t('stock_avg_price')], ['stock_value', this.t('stock_value')]] : [],
      ['brand', this.t('mat_brand')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    const colCount = headers.length;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.category}</td><td>${m.unit}</td><td class="text-right">${m.opening_qty}</td><td class="text-right">${m.total_in}</td><td class="text-right">${m.total_out}</td><td class="text-right"><strong>${m.on_hand}</strong></td><td class="text-right">${m.min_stock}</td><td>${this.statusBadge(m.stock_status)}</td>${vp ? `<td class="text-right">${this.fmtMoney(m.avg_price)}</td><td class="text-right">${cur} ${this.fmtMoney(m.stock_value)}</td>` : ''}<td>${m.brand || ''}</td></tr>`).join(''); }
    document.getElementById('stock-summary').innerHTML = `${this.t('stock_types')}: ${sorted.length}${vp ? ` | ${this.t('stock_total_value')}: ${cur} ${this.fmtMoney(totalValue)}` : ''} | ${this.t('stock_alerts')}: ${alerts} ${this.t('stock_items')}`;
    document.getElementById('stock-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('stock-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  // ========== 查询中心 ==========
  async renderQuery() {
    this.setMain(this.pageWrap('🔍 ' + this.t('q_title'), this.t('q_desc'), '', `<div class="data-page">
      <div class="data-toolbar">
        <div class="filter-bar" style="margin:0;padding:10px;background:none;box-shadow:none">
          <div class="form-group"><label>${this.t('q_keyword')}</label><input id="q_keyword" placeholder="${this.t('quick_filter_ph')}"></div>
          <div class="form-group"><label>${this.t('q_start')}</label><input id="q_start" type="date"></div>
          <div class="form-group"><label>${this.t('q_end')}</label><input id="q_end" type="date"></div>
          <div class="form-group"><label>${this.t('q_supplier')}</label><input id="q_supplier"></div>
          <div class="form-group"><label>${this.t('q_handler')}</label><input id="q_handler"></div>
          <div class="form-group"><label>${this.t('q_destination')}</label><select id="q_destination"><option value="">${this.t('q_no_limit')}</option>${this.params.destinations.map(d => `<option value="${d.name}">${d.name}</option>`).join('')}</select></div>
          <div class="form-group"><label>${this.t('q_po_no')}</label><input id="q_po_no"></div>
          <div class="form-group"><label>${this.t('q_contract')}</label><input id="q_contract_no"></div>
        </div>
        <div class="query-btn-row" style="display:flex;gap:10px;padding:0 10px 10px">
          <button class="btn btn-primary" onclick="App.runQuery()">${this.t('search')}</button>
          <button class="btn btn-outline" onclick="App.clearQuery()">${this.t('clear')}</button>
        </div>
      </div>
      <div class="data-summary" id="query-tabs" style="display:none">
        <button class="btn btn-primary btn-sm" onclick="App.showQueryResult('stock')">${this.t('q_result_stock')}</button>
        <button class="btn btn-outline btn-sm" onclick="App.showQueryResult('inbound')">${this.t('q_result_in')}</button>
        <button class="btn btn-outline btn-sm" onclick="App.showQueryResult('outbound')">${this.t('q_result_out')}</button>
      </div>
      <div class="data-scroll" id="query-content"><div class="empty-state"><div class="empty-state-icon">🔍</div><p>${this.t('q_empty')}</p></div></div>
      <div class="data-pager" id="query-pager"></div>
    </div>`));
    this.queryResults = null;
    this._queryTab = 'stock';
  },

  async runQuery() {
    const keyword = document.getElementById('q_keyword').value.trim(), startDate = document.getElementById('q_start').value, endDate = document.getElementById('q_end').value, supplier = document.getElementById('q_supplier').value.trim(), handler = document.getElementById('q_handler').value.trim(), destination = document.getElementById('q_destination').value, poNo = document.getElementById('q_po_no').value.trim(), contractNo = document.getElementById('q_contract_no').value.trim();
    // keyword 不传后端，前端 filterByKeywords 多关键字模糊匹配
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate); if (endDate) params.set('endDate', endDate);
    if (supplier) params.set('supplier', supplier); if (handler) params.set('handler', handler); if (poNo) params.set('poNo', poNo); if (contractNo) params.set('contractNo', contractNo);
    try {
      const stock = await this.api('/api/stock-summary');
      const inbound = await this.api('/api/inbound?' + params.toString());
      const outParams = new URLSearchParams();
      if (startDate) outParams.set('startDate', startDate); if (endDate) outParams.set('endDate', endDate); if (handler) outParams.set('handler', handler); if (destination) outParams.set('destination', destination);
      const outbound = await this.api('/api/outbound?' + outParams.toString());
      // 前端多关键字筛选
      this._queryKeyword = keyword;
      this.queryResults = { stock, inbound, outbound };
      document.getElementById('query-tabs').style.display = 'block';
      // 重置三个 tab 的表格状态
      ['queryStock','queryInbound','queryOutbound'].forEach(tid => { this.tableStates[tid] = { sortKey: '', sortDir: 'asc', page: 1, pageSize: 15 }; });
      this.showQueryResult('stock');
    } catch (e) { this.toast(e.message, 'error'); }
  },

  clearQuery() {
    ['q_keyword','q_start','q_end','q_supplier','q_handler','q_po_no','q_contract_no'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('q_destination').value = '';
    document.getElementById('query-tabs').style.display = 'none';
    document.getElementById('query-content').innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>${this.t('q_empty')}</p></div>`;
    document.getElementById('query-pager').innerHTML = '';
    this.queryResults = null;
  },

  showQueryResult(tab) {
    const tabs = document.querySelectorAll('#query-tabs button'); const tabMap = { stock: 0, inbound: 1, outbound: 2 };
    tabs.forEach((b, i) => { b.className = i === tabMap[tab] ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'; });
    this._queryTab = tab;
    if (!this.queryResults) return;
    const cur = this.params.currency; const vp = this.canViewPrice();
    const tid = 'query' + tab.charAt(0).toUpperCase() + tab.slice(1);
    // 注册重渲染回调（排序/翻页时调用）
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers[tid] = () => this.showQueryResult(tab);
    const st = this.getTableState(tid);

    if (tab === 'stock') {
      const kw = this._queryKeyword || '';
      const filterFields = ['code','name','spec','brand','category','unit','stock_status'];
      let data = this.filterByKeywords(this.queryResults.stock, kw, filterFields);
      const sorted = this.sortData(data, st.sortKey, st.sortDir);
      const pageData = this.paginate(sorted, st.page, st.pageSize);
      const headers = [
        ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
        ['brand', this.t('mat_brand')], ['category', this.t('mat_category')], ['unit', this.t('mat_unit')],
        ['opening_qty', this.t('stock_opening')], ['total_in', this.t('stock_total_in')], ['total_out', this.t('stock_total_out')],
        ['on_hand', this.t('stock_on_hand')], ['min_stock', this.t('stock_min')],
      ];
      let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      thHtml += `<th>${this.t('mat_status')}</th>`;
      if (vp) thHtml += this.sortTh(this.t('stock_value'), 'stock_value', tid);
      let tbody = '';
      if (pageData.length === 0) { tbody = this.emptyRow(headers.length + 2 + (vp ? 1 : 0)); }
      else { tbody = pageData.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.brand || ''}</td><td>${m.category}</td><td>${m.unit}</td><td class="text-right">${m.opening_qty}</td><td class="text-right">${m.total_in}</td><td class="text-right">${m.total_out}</td><td class="text-right"><strong>${m.on_hand}</strong></td><td class="text-right">${m.min_stock}</td><td>${this.statusBadge(m.stock_status)}</td>${vp ? `<td class="text-right">${cur} ${this.fmtMoney(m.stock_value)}</td>` : ''}</tr>`).join(''); }
      const html = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">${this.t('q_stock_match')}: ${data.length} ${this.t('q_types')}</div><div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      document.getElementById('query-content').innerHTML = html;
      document.getElementById('query-pager').innerHTML = this.renderPager(tid, sorted.length);

    } else if (tab === 'inbound') {
      const kw = this._queryKeyword || '';
      const filterFields = ['date','grn_no','code','material_name','material_spec','material_brand','supplier','handler','location','po_no','contract_no','txn_type','remarks'];
      let data = this.filterByKeywords(this.queryResults.inbound, kw, filterFields);
      const sorted = this.sortData(data, st.sortKey, st.sortDir);
      const pageData = this.paginate(sorted, st.page, st.pageSize);
      const headers = [
        ['date', this.t('in_date')], ['grn_no', this.t('in_grn')], ['code', this.t('mat_code')],
        ['material_name', this.t('mat_name')], ['material_brand', this.t('mat_brand')], ['qty', this.t('in_qty')],
        ...vp ? [['price', this.t('in_price')], ['amount', this.t('in_total_amount')]] : [],
        ['supplier', this.t('in_supplier')], ['handler', this.t('in_handler')], ['location', this.t('in_location')], ['po_no', this.t('in_po_no')],
      ];
      let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      let tbody = '';
      if (pageData.length === 0) { tbody = this.emptyRow(headers.length); }
      else { tbody = pageData.map(r => `<tr><td>${this.fmtDate(r.date)}</td><td>${r.grn_no}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_brand || ''}</td><td class="text-right">${r.qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.price)}</td><td class="text-right">${this.fmtMoney(r.amount)}</td>` : ''}<td>${r.supplier || ''}</td><td>${r.handler || ''}</td><td>${r.location || ''}</td><td>${r.po_no || ''}</td></tr>`).join(''); }
      const html = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">${this.t('q_in_match')}: ${data.length} ${this.t('q_records')}</div><div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      document.getElementById('query-content').innerHTML = html;
      document.getElementById('query-pager').innerHTML = this.renderPager(tid, sorted.length);

    } else {
      const kw = this._queryKeyword || '';
      const filterFields = ['date','gin_no','code','material_name','material_spec','material_brand','destination','receiver','handler','txn_type','remarks'];
      let data = this.filterByKeywords(this.queryResults.outbound, kw, filterFields);
      const sorted = this.sortData(data, st.sortKey, st.sortDir);
      const pageData = this.paginate(sorted, st.page, st.pageSize);
      const headers = [
        ['date', this.t('out_date')], ['gin_no', this.t('out_gin')], ['code', this.t('mat_code')],
        ['material_name', this.t('mat_name')], ['material_brand', this.t('mat_brand')], ['qty', this.t('out_qty')],
        ['destination', this.t('out_destination')], ['receiver', this.t('out_receiver')], ['handler', this.t('out_handler')],
        ...vp ? [['cost_price', this.t('out_cost_price')], ['cost_amount', this.t('out_cost_amount')]] : [],
      ];
      let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      let tbody = '';
      if (pageData.length === 0) { tbody = this.emptyRow(headers.length); }
      else { tbody = pageData.map(r => `<tr><td>${this.fmtDate(r.date)}</td><td>${r.gin_no}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_brand || ''}</td><td class="text-right">${r.qty}</td><td>${r.destination || ''}</td><td>${r.receiver || ''}</td><td>${r.handler || ''}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.cost_price)}</td><td class="text-right">${this.fmtMoney(r.cost_amount)}</td>` : ''}</tr>`).join(''); }
      const html = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">${this.t('q_out_match')}: ${data.length} ${this.t('q_records')}</div><div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      document.getElementById('query-content').innerHTML = html;
      document.getElementById('query-pager').innerHTML = this.renderPager(tid, sorted.length);
    }
  },

  // ========== 物料台账 ==========
  async renderLedger() {
    const materials = await this.api('/api/materials');
    const matSel = materials.map(m => `<option value="${m.code}">${m.name} ${m.spec || ''} (${m.code})</option>`).join('');
    this.setMain(this.pageWrap('📒 ' + this.t('ledger_title'), this.t('ledger_desc'), '', `<div class="data-page"><div class="data-toolbar"><div class="filter-bar" style="margin:0;padding:10px;background:none;box-shadow:none"><div class="form-group"><label>${this.t('ledger_select')} *</label><select id="l_code"><option value="">${this.t('please_select')}</option>${matSel}</select></div><div class="form-group"><label>${this.t('ledger_start')}</label><input id="l_start" type="date"></div><div class="form-group"><label>${this.t('ledger_end')}</label><input id="l_end" type="date"></div><div class="form-group"><button class="btn btn-primary" onclick="App.runLedger()">${this.t('generate')}</button></div></div></div><div class="data-scroll" id="ledger-content"><div class="empty-state"><div class="empty-state-icon">📒</div><p>${this.t('ledger_empty')}</p></div></div><div class="data-pager" id="ledger-pager"></div></div>`));
  },

  async runLedger() {
    const code = document.getElementById('l_code').value; if (!code) return this.toast(this.t('selectMaterial'), 'error');
    const startDate = document.getElementById('l_start').value, endDate = document.getElementById('l_end').value; const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate); if (endDate) params.set('endDate', endDate);
    try {
      const data = await this.api(`/api/ledger/${code}?${params.toString()}`); const cur = this.params.currency; const vp = this.canViewPrice();
      let html = `<div class="metric-grid"><div class="metric-card"><div class="metric-label">${this.t('ledger_code')}</div><div class="metric-value" style="font-size:18px">${data.material.code}</div></div><div class="metric-card"><div class="metric-label">${this.t('ledger_name')}</div><div class="metric-value" style="font-size:18px">${data.material.name}</div></div><div class="metric-card metric-info"><div class="metric-label">${this.t('ledger_opening')}</div><div class="metric-value">${data.opening_qty}</div></div><div class="metric-card metric-success"><div class="metric-label">${this.t('ledger_total_in')}</div><div class="metric-value">${data.total_in}</div></div><div class="metric-card metric-warning"><div class="metric-label">${this.t('ledger_total_out')}</div><div class="metric-value">${data.total_out}</div></div><div class="metric-card metric-danger"><div class="metric-label">${this.t('ledger_closing')}</div><div class="metric-value">${data.closing_qty}</div></div></div>`;
      html += `<div class="card"><div class="card-title">${this.t('ledger_flow')}</div><div class="table-wrap"><table><thead><tr><th>${this.t('ledger_seq')}</th><th>${this.t('ledger_date')}</th><th>${this.t('ledger_doc')}</th><th>${this.t('ledger_type')}</th><th>${this.t('ledger_in_qty')}</th><th>${this.t('ledger_out_qty')}</th><th>${this.t('ledger_balance')}</th>${vp ? `<th>${this.t('ledger_price')}</th><th>${this.t('ledger_amount')}</th>` : ''}<th>${this.t('ledger_party')}</th><th>${this.t('ledger_location')}</th><th>${this.t('in_handler')}</th><th>${this.t('in_remarks')}</th></tr></thead><tbody>${data.rows.map(r => { const tb = r.type === '入库' ? `<span class="badge badge-info">${this.t('nav_inbound')}</span>` : r.type === '出库' ? `<span class="badge badge-warning">${this.t('nav_outbound')}</span>` : `<span class="badge badge-muted">${this.t('stock_opening')}</span>`; return `<tr><td class="text-center">${r.seq}</td><td>${r.date || ''}</td><td>${r.doc_no || ''}</td><td>${tb}</td><td class="text-right">${r.in_qty || ''}</td><td class="text-right">${r.out_qty || ''}</td><td class="text-right"><strong>${r.balance}</strong></td>${vp ? `<td class="text-right">${r.price ? this.fmtMoney(r.price) : ''}</td><td class="text-right">${r.amount ? cur + ' ' + this.fmtMoney(r.amount) : ''}</td>` : ''}<td>${r.party || ''}</td><td>${r.location || ''}</td><td>${r.handler || ''}</td><td>${r.remarks || ''}</td></tr>`; }).join('')}</tbody></table></div></div>`;
      document.getElementById('ledger-content').innerHTML = html;
    } catch (e) { document.getElementById('ledger-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  // ========== 位置库存 ==========
  async renderLocationStock() {
    const materials = await this.api('/api/materials');
    const matSel = materials.map(m => `<option value="${m.code}">${m.name} ${m.spec || ''} (${m.code})</option>`).join('');
    const locSel = this.params.locations.map(l => `<option value="${l.name}">${l.name}</option>`).join('');
    this.setMain(this.pageWrap('📍 ' + this.t('loc_title'), this.t('loc_desc'), '', `<div class="data-page"><div class="data-toolbar"><div class="filter-bar" style="margin:0;padding:10px;background:none;box-shadow:none"><div class="form-group"><label>${this.t('loc_by_material')}</label><select id="loc_code"><option value="">${this.t('loc_select_material')}</option>${matSel}</select></div><div class="form-group"><button class="btn btn-primary" onclick="App.queryLocByMaterial()">${this.t('search')}</button></div><div style="width:20px"></div><div class="form-group"><label>${this.t('loc_by_location')}</label><select id="loc_name"><option value="">${this.t('loc_select_location')}</option>${locSel}</select></div><div class="form-group"><button class="btn btn-primary" onclick="App.queryLocByLocation()">${this.t('search')}</button></div></div></div><div class="data-scroll" id="loc-content"><div class="empty-state"><div class="empty-state-icon">📍</div><p>${this.t('loc_empty')}</p></div></div><div class="data-pager" id="loc-pager"></div></div>`));
  },

  async queryLocByMaterial() {
    const code = document.getElementById('loc_code').value; if (!code) return this.toast(this.t('selectMaterial'), 'error');
    try { const data = await this.api(`/api/location-stock?code=${code}`); document.getElementById('loc-content').innerHTML = `<div class="card"><div class="card-title">${data.material.code} - ${data.material.name}</div><div class="table-wrap"><table><thead><tr><th>${this.t('in_location')}</th><th>${this.t('loc_opening')}</th><th>${this.t('loc_total_in')}</th><th>${this.t('loc_total_out')}</th><th>${this.t('loc_stock')}</th></tr></thead><tbody>${data.locations.map(l => `<tr><td>${l.location}</td><td class="text-right">${l.opening}</td><td class="text-right">${l.total_in}</td><td class="text-right">${l.total_out}</td><td class="text-right"><strong>${l.stock}</strong></td></tr>`).join('')}</tbody></table></div></div>`; } catch (e) { document.getElementById('loc-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  async queryLocByLocation() {
    const location = document.getElementById('loc_name').value; if (!location) return this.toast(this.t('selectLocation'), 'error');
    try { const data = await this.api(`/api/location-stock?location=${encodeURIComponent(location)}`); document.getElementById('loc-content').innerHTML = `<div class="card"><div class="card-title">${location}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th><th>${this.t('mat_brand')}</th><th>${this.t('mat_unit')}</th><th>${this.t('loc_stock')}</th></tr></thead><tbody>${data.items.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.brand || ''}</td><td>${m.unit}</td><td class="text-right"><strong>${m.location_stock}</strong></td></tr>`).join('')}</tbody></table></div></div>`; } catch (e) { document.getElementById('loc-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  // ========== 采购订单 ==========
  async renderOrders() {
    const addBtn = this.can('orders','create') ? `<button class="btn btn-primary" onclick="App.editOrder()">+ ${this.t('po_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('ord_filter', 'App.onOrdersFilter()', addBtn);
    this.setMain(this.pageWrap('🛒 ' + this.t('po_title'), this.t('po_desc'), '', `<div id="orders-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="orders-scroll"></div><div class="data-pager" id="orders-pager"></div></div>`));
    try {
      this._ordersData = await this.api('/api/purchase-orders');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['orders'] = () => this.renderOrdersTable();
      this.renderOrdersTable();
    } catch (e) { document.getElementById('orders-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderOrdersTable() {
    const data = this._ordersData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'orders';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('ord_filter')?.value || '';
    const filterFields = ['po_no','date','supplier','contract_no','project','expected_date','line_count','order_amount','received_amount','delivery_status','overdue_days','manual_status'];
    const filtered = this.filterByKeywords(data, keywords, filterFields);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['po_no', this.t('po_no')], ['date', this.t('po_date')], ['supplier', this.t('po_supplier')],
      ['contract_no', this.t('po_contract')], ['project', this.t('po_project')], ['expected_date', this.t('po_expected')],
      ['line_count', this.t('po_lines')],
      ...vp ? [['order_amount', this.t('po_amount')], ['received_amount', this.t('po_received')]] : [],
      ['delivery_status', this.t('po_delivery')], ['overdue_days', this.t('po_overdue')], ['manual_status', this.t('po_manual')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th></th>`;
    const colCount = headers.length + 1;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(o => `<tr><td><strong>${o.po_no}</strong></td><td>${this.fmtDate(o.date)}</td><td>${o.supplier || ''}</td><td>${o.contract_no || ''}</td><td>${o.project || ''}</td><td>${this.fmtDate(o.expected_date)}</td><td class="text-center">${o.line_count}</td>${vp ? `<td class="text-right">${cur} ${this.fmtMoney(o.order_amount)}</td><td class="text-right">${cur} ${this.fmtMoney(o.received_amount)}</td>` : ''}<td>${this.statusBadge(o.delivery_status)}</td><td class="text-center">${o.overdue_days > 0 ? '<span class="badge badge-danger">' + o.overdue_days + '</span>' : '-'}</td><td>${o.manual_status || this.t('po_status_pending')}</td><td>${this.can('orders','edit') ? `<span class="action-link" onclick="App.editOrder('${o.po_no}')">${this.t('edit')}</span>` : ''}${this.can('orders','delete') ? `<span class="action-link danger" onclick="App.deleteOrder('${o.po_no}')">${this.t('delete')}</span>` : ''}</td></tr>`).join(''); }
    document.getElementById('orders-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('orders-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  async editOrder(poNo) {
    let o = { po_no: '', date: new Date().toISOString().slice(0, 10), supplier: '', contract_no: '', project: '', expected_date: '', remarks: '', manual_status: '' };
    if (poNo) { const data = await this.api('/api/purchase-orders'); o = data.find(d => d.po_no === poNo) || o; }
    const suppliers = await this.api('/api/suppliers'), dests = this.params.destinations.map(d => d.name);
    const supSel = suppliers.map(s => `<option value="${s.name}" ${s.name === o.supplier ? 'selected' : ''}>${s.name}</option>`).join('');
    const destSel = dests.map(d => `<option value="${d}" ${d === o.project ? 'selected' : ''}>${d}</option>`).join('');
    this.showModal(`<h3>${poNo ? this.t('po_edit') : this.t('po_add')}</h3>`, `<div class="form-grid"><div class="form-group"><label>${this.t('po_no')} *</label><input id="o_po_no" value="${o.po_no}" ${poNo ? 'readonly' : ''} oninput="App.clearFieldError('o_po_no')"><div class="form-error" id="o_po_no_error"></div></div><div class="form-group"><label>${this.t('po_date')} *</label><input id="o_date" type="date" value="${this.fmtDate(o.date)}" oninput="App.clearFieldError('o_date')"><div class="form-error" id="o_date_error"></div></div><div class="form-group"><label>${this.t('po_supplier')}</label><select id="o_supplier"><option value="">${this.t('none')}</option>${supSel}</select></div><div class="form-group"><label>${this.t('po_contract')}</label><input id="o_contract_no" value="${o.contract_no || ''}"></div><div class="form-group"><label>${this.t('po_project')}</label><select id="o_project"><option value="">${this.t('none')}</option>${destSel}</select></div><div class="form-group"><label>${this.t('po_expected')}</label><input id="o_expected_date" type="date" value="${this.fmtDate(o.expected_date)}"></div><div class="form-group"><label>${this.t('po_manual')}</label><select id="o_manual_status"><option value="">${this.t('po_status_pending')}</option><option value="已关闭" ${o.manual_status === '已关闭' ? 'selected' : ''}>${this.t('po_status_closed')}</option><option value="已取消" ${o.manual_status === '已取消' ? 'selected' : ''}>${this.t('po_status_cancelled')}</option></select></div><div class="form-group" style="grid-column:span 2"><label>${this.t('in_remarks')}</label><input id="o_remarks" value="${o.remarks || ''}"></div></div>`, poNo ? this.t('save') : this.t('create'), async () => {
      if (!this.validateForm({ o_po_no: [{rule:'required'}], o_date: [{rule:'required'}] })) return;
      const body = { po_no: document.getElementById('o_po_no').value.trim(), date: document.getElementById('o_date').value, supplier: document.getElementById('o_supplier').value, contract_no: document.getElementById('o_contract_no').value.trim(), project: document.getElementById('o_project').value, expected_date: document.getElementById('o_expected_date').value, remarks: document.getElementById('o_remarks').value.trim(), manual_status: document.getElementById('o_manual_status').value };
      try { await this.api('/api/purchase-orders' + (poNo ? '/' + poNo : ''), poNo ? 'PUT' : 'POST', body); this.closeModal(); this.toast(poNo ? this.t('updated') : this.t('created')); this.renderOrders(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  async deleteOrderLineById(id) {
    this.confirmDialog(this.t('cf_delete_line'), '', async () => {
      try { await this.api('/api/order-lines/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderOrderTracking(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  // 批量添加采购明细（对齐批量入库弹窗结构）
  async editOrderLineBatch() {
    const materials = await this.api('/api/materials');
    const orders = await this.api('/api/purchase-orders');
    this._materialsCache = materials;
    const vp = this.canViewPrice();
    this._otOrders = orders;
    const categories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    this._otMatCategories = categories;

    // 采购单号下拉 + 合同号下拉
    const poOptions = orders.map(o => `<option value="${o.po_no}">${o.po_no}</option>`).join('');
    const contractNos = [...new Set(orders.map(o => o.contract_no).filter(Boolean))].sort();
    const contractOptions = contractNos.length > 0
      ? contractNos.map(c => `<option value="${c}">${c}</option>`).join('')
      : `<option value="" disabled>${this.t('in_no_contracts')}</option>`;

    this.showModal(`<h3>${this.t('po_batch_title')}</h3>`, `<div style="margin-bottom:12px;font-size:12px;color:var(--text-muted)">${this.t('po_batch_desc')}</div>
      <div class="form-grid">
        <div class="form-group" style="grid-column:span 2">
          <label>${this.t('po_select_source')}</label>
          <div style="display:flex;gap:8px;align-items:center">
            <select id="ol_po_no" style="flex:1"><option value="">${this.t('in_po_no')}</option>${poOptions}</select>
            <select id="ol_contract_no" style="flex:1"><option value="">${this.t('in_contract')}</option>${contractOptions}</select>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:12px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${this.t('po_lines_title')}</strong>
          <button class="btn btn-outline btn-sm" onclick="App.addOrderLineRow()">+ ${this.t('in_add_row')}</button>
        </div>
        <div class="table-wrap"><table id="ol_table"><thead><tr>
          <th>${this.t('mat_level_category')}</th><th>${this.t('mat_level_name')}</th><th>${this.t('mat_level_spec')}</th><th>${this.t('po_order_qty')} *</th>${vp ? `<th>${this.t('po_order_price')}</th>` : ''}<th>${this.t('in_remarks')}</th><th></th>
        </tr></thead><tbody id="ol_rows"></tbody></table></div>
      </div>`, this.t('po_batch_submit'), async () => {
      const poNo = document.getElementById('ol_po_no').value;
      const contractNo = document.getElementById('ol_contract_no').value;
      if (!poNo && !contractNo) { this.toast(this.t('po_select_source'), 'error'); return; }
      const rows = document.querySelectorAll('#ol_rows tr');
      const items = [];
      rows.forEach(tr => {
        const code = tr.getAttribute('data-code') || '';
        const order_qty = parseFloat(tr.querySelector('.ol-qty').value) || 0;
        const order_price = parseFloat(tr.querySelector('.ol-price').value) || 0;
        const remarks = tr.querySelector('.ol-remarks').value.trim();
        if (code && order_qty > 0) {
          // 如果选了合同号但没选采购单号，查找该合同下的第一个采购单
          let targetPo = poNo;
          if (!targetPo && contractNo) {
            const o = orders.find(o => o.contract_no === contractNo);
            if (o) targetPo = o.po_no;
          }
          items.push({ po_no: targetPo, code, order_qty, order_price, remarks });
        }
      });
      if (items.length === 0) { this.toast(this.t('fillRequired'), 'error'); return; }
      try {
        for (const item of items) { await this.api('/api/order-lines', 'POST', item); }
        this.closeModal();
        this.toast(this.t('added') + ' (' + items.length + ')');
        this.renderOrderTracking();
      } catch (e) { this.toast(e.message, 'error'); }
    }, null, true); // large modal

    // 默认加3个空行
    this.addOrderLineRow();
    this.addOrderLineRow();
    this.addOrderLineRow();
  },

  // 采购明细行 — 三级联动物料选择（对齐入库行）
  addOrderLineRow() {
    const cats = this._otMatCategories || [];
    const materials = this._materialsCache || [];
    const tbody = document.getElementById('ol_rows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.setAttribute('data-code', '');
    const catOpts = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const vp = this.canViewPrice();
    tr.innerHTML = `<td><select class="ol-cat" onchange="App.onOrderLineRowCatChange(this)" style="width:120px"><option value="">${this.t('please_select')}</option>${catOpts}</select></td>
      <td><select class="ol-name" onchange="App.onOrderLineRowNameChange(this)" style="width:140px" disabled><option value="">${this.t('please_select')}</option></select></td>
      <td><select class="ol-spec-sel" onchange="App.onOrderLineRowSpecChange(this)" style="width:200px" disabled><option value="">${this.t('please_select')}</option></select></td>
      <td><input class="ol-qty" type="number" step="0.01" value="" style="width:80px"></td>
      ${vp ? `<td><input class="ol-price" type="number" step="0.01" value="" style="width:90px"></td>` : '<td><input class="ol-price" type="hidden" value="0"></td>'}
      <td><input class="ol-remarks" value="" style="width:120px"></td>
      <td><span class="action-link danger" onclick="this.parentElement.parentElement.remove()">${this.t('in_remove_row')}</span></td>`;
    tbody.appendChild(tr);
  },

  onOrderLineRowCatChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = selEl.value;
    const materials = this._materialsCache || [];
    const names = cat ? [...new Set(materials.filter(m => m.category === cat).map(m => m.name))] : [];
    const nameSel = tr.querySelector('.ol-name');
    nameSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + names.map(n => `<option value="${n}">${n}</option>`).join('');
    nameSel.disabled = !cat;
    const specSel = tr.querySelector('.ol-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>`;
    specSel.disabled = true;
    tr.setAttribute('data-code', '');
  },

  onOrderLineRowNameChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = tr.querySelector('.ol-cat').value;
    const name = selEl.value;
    const materials = this._materialsCache || [];
    const specs = (cat && name) ? materials.filter(m => m.category === cat && m.name === name) : [];
    const specSel = tr.querySelector('.ol-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}">${label}</option>`;
    }).join('');
    specSel.disabled = !name;
    tr.setAttribute('data-code', '');
  },

  onOrderLineRowSpecChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const code = selEl.value;
    const m = (this._materialsCache || []).find(x => x.code === code);
    if (m) {
      tr.setAttribute('data-code', code);
      const priceInput = tr.querySelector('.ol-price');
      if (!priceInput.value) priceInput.value = m.opening_price || '';
    } else {
      tr.setAttribute('data-code', '');
    }
  },

  async deleteOrder(poNo) { this.confirmDialog(this.t('cf_delete_order') + ' ' + poNo, this.t('cf_delete_order_msg'), async () => { try { await this.api('/api/purchase-orders/' + poNo, 'DELETE'); this.toast(this.t('deleted')); this.renderOrders(); } catch (e) { this.toast(e.message, 'error'); } }); },

  onOrdersFilter() {
    const st = this.getTableState('orders');
    st.page = 1;
    this.renderOrdersTable();
  },

  // ========== 供应商档案 ==========
  async renderSuppliers() {
    const addBtn = this.can('suppliers','create') ? `<button class="btn btn-primary" onclick="App.editSupplier()">+ ${this.t('sup_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('sup_filter', 'App.onSuppliersFilter()', addBtn);
    this.setMain(this.pageWrap('🚚 ' + this.t('sup_title'), this.t('sup_desc'), '', `<div id="suppliers-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="suppliers-scroll"></div><div class="data-pager" id="suppliers-pager"></div></div>`));
    try {
      this._suppliersData = await this.api('/api/suppliers');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['suppliers'] = () => this.renderSuppliersTable();
      this.renderSuppliersTable();
    } catch (e) { document.getElementById('suppliers-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderSuppliersTable() {
    const data = this._suppliersData;
    if (!data) return;
    const tid = 'suppliers';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('sup_filter')?.value || '';
    const filterFields = ['name','contact','phone','remarks'];
    const filtered = this.filterByKeywords(data, keywords, filterFields);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['name', this.t('sup_name')], ['contact', this.t('sup_contact')],
      ['phone', this.t('sup_phone')], ['remarks', this.t('sup_remarks')]
    ];
    let thHtml = `<th>${this.t('sup_seq')}</th>`;
    thHtml += headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th></th>`;
    const colCount = headers.length + 2;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else {
      const startIdx = (st.page - 1) * st.pageSize;
      tbody = pageData.map((s, i) => `<tr><td class="text-center">${startIdx + i + 1}</td><td><strong>${s.name}</strong></td><td>${s.contact || ''}</td><td>${s.phone || ''}</td><td>${s.remarks || ''}</td><td>${this.rowActions('suppliers', `App.editSupplier(${s.id})`, `App.deleteSupplier(${s.id})`)}</td></tr>`).join('');
    }
    document.getElementById('suppliers-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('suppliers-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  async editSupplier(id) {
    let s = { name: '', contact: '', phone: '', remarks: '' };
    if (id) { const data = await this.api('/api/suppliers'); s = data.find(d => d.id === id) || s; }
    this.showModal(`<h3>${id ? this.t('sup_edit') : this.t('sup_add')}</h3>`, `<div class="form-grid"><div class="form-group" style="grid-column:span 2"><label>${this.t('sup_name')} *</label><input id="s_name" value="${s.name}" oninput="App.clearFieldError('s_name')"><div class="form-error" id="s_name_error"></div></div><div class="form-group"><label>${this.t('sup_contact')}</label><input id="s_contact" value="${s.contact || ''}"></div><div class="form-group"><label>${this.t('sup_phone')}</label><input id="s_phone" value="${s.phone || ''}"></div><div class="form-group" style="grid-column:span 2"><label>${this.t('sup_remarks')}</label><input id="s_remarks" value="${s.remarks || ''}"></div></div>`, id ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ s_name: [{rule:'required'}] })) return;
      const body = { name: document.getElementById('s_name').value.trim(), contact: document.getElementById('s_contact').value.trim(), phone: document.getElementById('s_phone').value.trim(), remarks: document.getElementById('s_remarks').value.trim() };
      try { await this.api('/api/suppliers' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body); this.closeModal(); this.toast(id ? this.t('updated') : this.t('added')); this.renderSuppliers(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  async deleteSupplier(id) { this.confirmDialog(this.t('cf_delete_supplier'), '', async () => { try { await this.api('/api/suppliers/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderSuppliers(); } catch (e) { this.toast(e.message, 'error'); } }); },

  onSuppliersFilter() {
    const st = this.getTableState('suppliers');
    st.page = 1;
    this.renderSuppliersTable();
  },

  // ========== 参数设置 ==========
  async renderSettings() {
    this.setMain(this.pageWrap('⚙ ' + this.t('set_title'), this.t('set_desc'), '', `<div id="settings-content"><p style="text-align:center;padding:20px;color:var(--text-muted)">${this.t('loading')}</p></div>`));
    try {
      const data = await this.api('/api/params'); let html = '';
      const sections = [
        { key: 'categories', title: this.t('set_categories'), fields: ['name', 'prefix'], headers: [this.t('set_cat_name'), this.t('set_cat_prefix')] },
        { key: 'units', title: this.t('set_units'), fields: ['name'], headers: [this.t('set_unit_name')] },
        { key: 'destinations', title: this.t('set_destinations'), fields: ['name'], headers: [this.t('set_dest_name')] },
        { key: 'locations', title: this.t('set_locations'), fields: ['name'], headers: [this.t('set_loc_name')] }
      ];
      sections.forEach(s => {
        const items = data[s.key];
        const canCreate = this.can('settings','create'), canDelete = this.can('settings','delete');
        const thHtml = s.headers.map(h => '<th>' + h + '</th>').join('') + '<th></th>';
        const rowsHtml = items.map(item => {
          const cells = s.fields.map(f => '<td>' + (item[f] || '') + '</td>').join('');
          const del = canDelete ? '<td><span class="action-link danger" onclick="App.deleteParam(\'' + s.key + '\',' + item.id + ')">' + this.t('delete') + '</span></td>' : '<td></td>';
          return '<tr>' + cells + del + '</tr>';
        }).join('');
        let addRow = '';
        if (canCreate) {
          const inputs = s.fields.map(f => {
            const idx = s.fields.indexOf(f);
            return '<div class="form-group"><label>' + s.headers[idx] + '</label><input id="add_' + s.key + '_' + f + '" placeholder="' + s.headers[idx] + '"></div>';
          }).join('');
          addRow = '<div style="margin-top:8px;display:flex;gap:8px;align-items:flex-end">' + inputs + '<button class="btn btn-primary btn-sm" onclick="App.addParam(\'' + s.key + '\')">+ ' + this.t('add') + '</button></div>';
        }
        html += '<div class="card"><div class="card-title">' + s.title + '（' + items.length + '）</div><div class="table-wrap"><table><thead><tr>' + thHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' + addRow + '</div>';
      });
      document.getElementById('settings-content').innerHTML = html;
    } catch (e) { document.getElementById('settings-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  async addParam(type) {
    const fields = type === 'categories' ? ['name', 'prefix'] : ['name']; const body = {};
    fields.forEach(f => body[f] = document.getElementById(`add_${type}_${f}`).value.trim());
    if (!body.name) { this.toast(this.t('fillRequired'), 'error'); const el = document.getElementById(`add_${type}_name`); if (el) { el.classList.add('error'); el.focus(); } return; }
    try { await this.api(`/api/params/${type}`, 'POST', body); this.toast(this.t('added')); this.renderSettings(); } catch (e) { this.toast(e.message, 'error'); }
  },

  async deleteParam(type, id) { this.confirmDialog(this.t('cf_delete_param'), '', async () => { try { await this.api(`/api/params/${type}/${id}`, 'DELETE'); this.toast(this.t('deleted')); this.renderSettings(); } catch (e) { this.toast(e.message, 'error'); } }); },

  // ========== 订单明细跟踪 ==========
  async renderOrderTracking() {
    const addBtn = this.can('orders', 'create') ? `<button class="btn btn-primary" onclick="App.editOrderLineBatch()">+ ${this.t('po_batch_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('ot_filter', 'App.onOrderTrackingFilter()', `<div style="display:flex;gap:8px;align-items:center">${addBtn}<select id="ot_status_filter" onchange="App.onOrderTrackingFilter()" style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;background:var(--card-bg);color:var(--text)"><option value="">${this.t('stock_all')}</option><option value="未到货">${this.t('st_not_arrived')}</option><option value="部分到货">${this.t('st_partial')}</option><option value="已到货">${this.t('st_arrived')}</option></select></div>`);
    this.setMain(this.pageWrap('📋 ' + this.t('ot_title'), this.t('ot_desc'), '', `<div id="ot-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-summary" id="ot-summary"></div><div class="data-scroll" id="ot-scroll"></div><div class="data-pager" id="ot-pager"></div></div>`));
    try {
      this._otData = await this.api('/api/order-tracking');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['orderTracking'] = () => this.renderOrderTrackingTable();
      this.renderOrderTrackingTable();
    } catch (e) { document.getElementById('ot-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderOrderTrackingTable() {
    const data = this._otData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'orderTracking';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('ot_filter')?.value || '';
    const statusFilter = document.getElementById('ot_status_filter')?.value || '';
    const filterFields = ['po_no','po_date','po_supplier','expected_date','code','material_name','material_spec','material_brand','manual_status','line_status'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    if (statusFilter) filtered = filtered.filter(r => r.line_status === statusFilter);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const totalLines = sorted.length;
    const totalAmount = sorted.reduce((s, r) => s + (r.order_amount || 0), 0);
    const totalReceived = sorted.reduce((s, r) => s + (r.received_qty * r.order_price || 0), 0);
    const totalUnreceived = totalAmount - totalReceived;
    const headers = [
      ['po_no', this.t('ot_po_no')], ['po_date', this.t('ot_po_date')], ['po_supplier', this.t('ot_supplier')],
      ['code', this.t('ot_code')], ['material_name', this.t('ot_material')], ['material_spec', this.t('ot_spec')],
      ['material_brand', this.t('ot_brand')], ['material_unit', this.t('ot_unit')],
      ['order_qty', this.t('ot_order_qty')],
      ...vp ? [['order_price', this.t('ot_order_price')], ['order_amount', this.t('ot_order_amount')]] : [],
      ['received_qty', this.t('ot_received_qty')],
      ['unreceived_qty', this.t('ot_unreceived')], ['expected_date', this.t('ot_expected')],
      ['line_status', this.t('ot_status')], ['overdue_days', this.t('ot_overdue')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th></th>`;
    const colCount = headers.length + 1;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else {
      tbody = pageData.map(r => `<tr><td><strong>${r.po_no}</strong></td><td>${this.fmtDate(r.po_date)}</td><td>${r.po_supplier || ''}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_spec || ''}</td><td>${r.material_brand || ''}</td><td>${r.material_unit || ''}</td><td class="text-right">${r.order_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.order_price)}</td><td class="text-right">${cur} ${this.fmtMoney(r.order_amount)}</td>` : ''}<td class="text-right">${r.received_qty}</td><td class="text-right"><strong>${r.unreceived_qty}</strong></td><td>${this.fmtDate(r.expected_date)}</td><td>${this.statusBadge(r.line_status)}</td><td class="text-center">${r.overdue_days > 0 ? '<span class="badge badge-danger">' + r.overdue_days + '</span>' : '-'}</td><td>${this.can('orders','delete') ? `<span class="action-link danger" onclick="App.deleteOrderLineById(${r.id})">${this.t('delete')}</span>` : ''}</td></tr>`).join('');
    }
    document.getElementById('ot-summary').innerHTML = `${this.t('ot_total_lines')}: ${totalLines}${vp ? ` | ${this.t('ot_total_amount')}: ${cur} ${this.fmtMoney(totalAmount)} | ${this.t('ot_total_received')}: ${cur} ${this.fmtMoney(totalReceived)} | ${this.t('ot_total_unreceived')}: ${cur} ${this.fmtMoney(totalUnreceived)}` : ''}`;
    document.getElementById('ot-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('ot-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onOrderTrackingFilter() {
    const st = this.getTableState('orderTracking');
    st.page = 1;
    this.renderOrderTrackingTable();
  },

  // ========== 用户管理 ==========
  async renderUsers() {
    const addBtn = this.can('users','create') ? `<button class="btn btn-primary" onclick="App.editUser()">+ ${this.t('user_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('user_filter', 'App.onUsersFilter()', addBtn);
    this.setMain(this.pageWrap('👤 ' + this.t('user_title'), this.t('user_desc'), '', `<div id="users-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="users-scroll"></div><div class="data-pager" id="users-pager"></div></div>`));
    try {
      this._usersData = await this.api('/api/users');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['users'] = () => this.renderUsersTable();
      this.getTableState('users');
      this.renderUsersTable();
    } catch (e) { document.getElementById('users-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderUsersTable() {
    const data = this._usersData || [];
    const tid = 'users';
    const st = this.getTableState(tid);
    const kw = (document.getElementById('user_filter') || {}).value || '';
    let filtered = data;
    if (kw.trim()) filtered = this.filterByKeywords(data, kw, ['username','name','role']);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['username', this.t('user_username')], ['name', this.t('user_name')], ['role', this.t('user_role')],
      ['status', this.t('user_status')], ['last_login', this.t('user_last_login')], ['created_at', this.t('ledger_date')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th></th>`;
    const roleLabel = r => this.t('role_' + r);
    const statusBadge = s => s === 'active' ? `<span class="badge badge-success">${this.t('status_active')}</span>` : `<span class="badge badge-muted">${this.t('status_disabled')}</span>`;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(headers.length + 1); }
    else { tbody = pageData.map(u => `<tr><td><strong>${u.username}</strong>${u.must_change_pwd ? ' <span class="badge badge-warning">⚠</span>' : ''}</td><td>${u.name || ''}</td><td>${roleLabel(u.role)}</td><td>${statusBadge(u.status)}</td><td>${this.fmtDate(u.last_login) || '-'}</td><td>${this.fmtDate(u.created_at)}</td><td>${this.rowActions('users', `App.editUser(${u.id})`, `App.deleteUser(${u.id})`)}</td></tr>`).join(''); }
    document.getElementById('users-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('users-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onUsersFilter() {
    const st = this.getTableState('users'); st.page = 1;
    this.renderUsersTable();
  },

  async editUser(id) {
    let u = { username: '', name: '', role: 'operator', status: 'active' };
    if (id) { u = this._usersData.find(d => d.id === id) || u; }
    const roles = ['admin','manager','operator','viewer'];
    const roleOpts = roles.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${this.t('role_' + r)}</option>`).join('');
    const statusOpts = [['active', this.t('status_active')], ['disabled', this.t('status_disabled')]].map(s => `<option value="${s[0]}" ${s[0] === u.status ? 'selected' : ''}>${s[1]}</option>`).join('');
    this.showModal(`<h3>${id ? this.t('user_edit') : this.t('user_add')}</h3>`, `<div class="form-grid" style="max-width:500px">
      <div class="form-group"><label>${this.t('user_username')} *</label><input id="u_username" value="${u.username}" ${id ? 'readonly' : ''} oninput="App.clearFieldError('u_username')"><div class="form-error" id="u_username_error"></div></div>
      <div class="form-group"><label>${this.t('user_name')}</label><input id="u_name" value="${u.name || ''}"></div>
      <div class="form-group"><label>${this.t('user_role')} *</label><select id="u_role">${roleOpts}</select></div>
      <div class="form-group"><label>${this.t('user_status')}</label><select id="u_status">${statusOpts}</select></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('user_password')} ${id ? `<span style="font-size:11px;color:var(--text-muted)">(${this.t('user_password_hint')})</span>` : '*'}</label><input id="u_password" type="password" ${id ? 'placeholder="' + this.t('user_password_hint') + '"' : ''} oninput="App.clearFieldError('u_password')"><div class="form-error" id="u_password_error"></div></div>
    </div>`, this.t('save'), async () => {
      const body = {
        name: document.getElementById('u_name').value.trim(),
        role: document.getElementById('u_role').value,
        status: document.getElementById('u_status').value,
      };
      const pwd = document.getElementById('u_password').value;
      if (!id) {
        if (!document.getElementById('u_username').value.trim()) { this.setFieldError('u_username', this.t('field_required')); return; }
        body.username = document.getElementById('u_username').value.trim();
        if (!pwd) { this.setFieldError('u_password', this.t('field_required')); return; }
        body.password = pwd;
        if (!this.validateForm({ u_username: [{rule:'required'}], u_password: [{rule:'required'},{rule:'minlen',param:6}] })) return;
      } else {
        if (pwd) { body.password = pwd; if (pwd.length < 6) { this.setFieldError('u_password', this.t('pwd_min_len')); return; } }
      }
      try {
        await this.api('/api/users' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body);
        this.closeModal();
        this.toast(id ? this.t('updated') : this.t('added'));
        this.renderUsers();
      } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  deleteUser(id) {
    this.confirmDialog(this.t('cf_delete_user'), this.t('cf_delete_user_msg'), async () => {
      try { await this.api('/api/users/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderUsers(); }
      catch (e) { this.toast(e.message, 'error'); }
    });
  },

  // ========== 模态框 ==========
  showModal(title, bodyHtml, btnText, onConfirm, onCancel, large) {
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'modal-overlay';
    const modalClass = large ? 'modal modal-lg' : 'modal';
    overlay.innerHTML = `<div class="${modalClass}"><div class="modal-header">${title}<button class="modal-close" id="modal-close-btn">&times;</button></div><div class="modal-body">${bodyHtml}</div><div class="modal-footer"><button class="btn btn-outline" id="modal-cancel-btn">${this.t('cancel')}</button><button class="btn btn-primary" id="modal-confirm-btn">${btnText}</button></div></div>`;
    document.body.appendChild(overlay);
    const doCancel = () => { this.closeModal(); if (onCancel) onCancel(); };
    document.getElementById('modal-close-btn').onclick = doCancel;
    document.getElementById('modal-cancel-btn').onclick = doCancel;
    overlay.addEventListener('click', e => { if (e.target === overlay) doCancel(); });
    document.getElementById('modal-confirm-btn').onclick = onConfirm;
  },

  closeModal() { const el = document.getElementById('modal-overlay'); if (el) el.remove(); }
};

App.init();
