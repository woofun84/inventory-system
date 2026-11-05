/**
 * 入库管理 —— 入库单列表 / 右侧详情栏 / 独立编辑页 / 冲销
 *
 * 交互范式对齐采购管理（10-purchase.js，2026-11-05 改造）：
 *  - 单页三段式：视图页签（按业务类型：全部 / 采购入库 / 采购退货 / 入库冲销）
 *    + 条件区 + 状态统计卡片 + 列表
 *  - 列表右侧 sticky 详情栏（.pu-split.open），点行原地展开，不再整页跳转
 *  - 详情子页签带计数：明细 / 冲销记录 / 操作日志
 *  - 底部固定操作条：添加物料 → 确认入库 → 打印 → 导出 → 冲销 → 删除（高危固定最右）
 *  - 列表/详情复用采购模块注入的 .pu-* 组件样式，保证两模块观感一致
 *
 * 仍以独立整页呈现的部分（不套详情栏）：
 *  - 新建入库单 newInboundDoc()：单据信息表单
 *  - 编辑草稿 editInboundDoc()：明细编辑（存草稿 / 确认入库）
 *  - 创建冲销单 showReversalPage()：勾选可冲销明细
 *  - 确认过账后生成库存流水；已过账单据不可直接修改，只能通过冲销调整
 */
Object.assign(App, {

  // ========== 状态 ==========
  ibState() {
    if (!this._ib) this._ib = {};
    const s = this._ib;
    if (s.tab === undefined) s.tab = '';      // 视图页签：'' | 采购入库 | 采购退货 | 入库冲销
    if (s.sel === undefined) s.sel = null;    // 右侧详情栏当前单据号
    if (!s.dt) s.dt = 'lines';                // 详情子页签：lines | rev | logs
    if (s.wide === undefined) s.wide = false;
    if (s.dense === undefined) s.dense = false;
    if (s.kpi === undefined) s.kpi = '';
    if (!s.f) s.f = { kw: '', from: '', to: '' };
    if (!this._ibDetailCache) this._ibDetailCache = {};
    if (!this._ibList) this._ibList = [];
    return s;
  },

  // ========== 页面骨架（对齐采购管理：页签 + 条件区 + KPI + 列表/详情栏） ==========
  async renderInbound() {
    const s = this.ibState();
    this.setMain(this.pageWrap('📥 ' + this.t('ibd_title'), this.t('ibd_desc'), '', this.ibSkeleton()));
    const pb = document.querySelector('.page-body');
    if (pb) pb.classList.add('pu-page-body');
    this.injectPurchaseStyles();
    this.injectInboundStyles();
    this.ibBindEvents();
    this.ibRenderTabs();
    this.ibRenderToolbar();
    this.ibRenderFilters();
    const root = document.getElementById('ib-root');
    if (root) root.classList.toggle('ib-dense', !!s.dense);
    await this.loadInboundList();
    this.ibRenderInspector();
  },

  ibSkeleton() {
    return `<div id="ib-root" class="data-page">
      <div class="data-toolbar">
        <nav id="ib-tabs" class="pu-viewtabs" role="tablist" aria-label="${this.t('ibd_title')}"></nav>
        <div class="pu-toolbar">
          <div id="ib-filters" class="pu-filter-inner"></div>
          <div id="ib-head-actions" class="pu-head-actions"></div>
        </div>
      </div>
      <div id="ib-kpis" class="pu-kpis" role="group" aria-label="${this.t('ibd_status')}"></div>
      <div class="pu-split" id="ib-split">
        <section class="pu-list">
          <div class="data-scroll" id="ib-scroll"></div>
          <div class="pu-pager" id="ib-pager"></div>
        </section>
        <aside class="pu-insp" id="ib-insp" hidden aria-label="${this.t('ibd_view_detail')}"></aside>
      </div>
    </div>`;
  },

  // 视图页签按「业务类型」划分：全部 / 采购入库 / 零星入库 / 入库冲销
  // 采购退货已迁出到「退货与退库」模块，不在本页展示
  ibTabDefs() {
    return [['', this.t('all')], ['采购入库', this.t('in_purchase')], ['零星入库', this.t('in_other')], ['入库冲销', this.t('ibd_rev_type')]];
  },

  ibRenderTabs() {
    const box = document.getElementById('ib-tabs');
    if (!box) return;
    const s = this.ibState();
    box.innerHTML = this.ibTabDefs().map(([k, label]) =>
      `<button type="button" class="pu-viewtab" role="tab" aria-selected="${s.tab === k}" data-ib="tab" data-id="${k}">${label}</button>`
    ).join('');
  },

  ibRenderToolbar() {
    const box = document.getElementById('ib-head-actions');
    if (!box) return;
    box.innerHTML = this.can('inbound', 'create')
      ? `<button type="button" class="btn btn-primary" data-ib="new">+ ${this.t('ibd_add')}</button>` : '';
  },

  ibRenderFilters() {
    const box = document.getElementById('ib-filters');
    if (!box) return;
    const s = this.ibState();
    const ph = this.t('ibd_filter_hint');
    box.innerHTML = `<div class="pu-search" role="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="ib_f_kw" type="search" value="${this.ibEsc(s.f.kw)}" placeholder="${ph}" aria-label="${ph}">
      </div>
      <div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="ib_f_from">${this.t('pu_date')}</label>
        <input id="ib_f_from" type="date" value="${this.ibEsc(s.f.from)}" aria-label="${this.t('pu_date')}">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="ib_f_to" type="date" value="${this.ibEsc(s.f.to)}" aria-label="${this.t('pu_date')}">
      </div>
      <button type="button" class="btn btn-outline btn-sm" data-ib="clr">${this.t('pu_clear_filter')}</button>
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.dense}" data-ib="dense">${this.t('pu_dense')}</button>`;
  },

  ibEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  },

  async loadInboundList() {
    try {
      this._ibList = await this.api('/api/inbound-docs?excludeType=' + encodeURIComponent('采购退货'));
    } catch (e) {
      this._ibList = [];
      const scroll = document.getElementById('ib-scroll');
      if (scroll) scroll.innerHTML = `<div class="pu-empty">${this.ibEsc(e.message)}</div>`;
      const pg = document.getElementById('ib-pager'); if (pg) pg.innerHTML = '';
      const kp = document.getElementById('ib-kpis'); if (kp) kp.innerHTML = '';
      return;
    }
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['inbound'] = () => this.ibRenderList();
    this.ibRenderList();
  },

  // ========== 列表渲染（对齐采购：KPI 卡片 + 条件吸附分页） ==========
  // KPI 状态定义：[key, label, 计数判定]
  ibKpiDefs() {
    return [
      ['', this.t('all'), r => true],
      ['draft', this.t('ibd_status_draft'), r => r.status === 'draft'],
      ['posted', this.t('ibd_status_posted'), r => r.status === 'posted'],
      ['partially_reversed', this.t('ibd_status_partial_rev'), r => r.status === 'partially_reversed'],
      ['reversed', this.t('ibd_status_reversed'), r => r.status === 'reversed'],
      ['cancelled', this.t('ibd_status_cancelled'), r => r.status === 'cancelled'],
    ];
  },

  ibHasFilter() {
    const s = this.ibState();
    return !!(s.f.kw || s.f.from || s.f.to || s.kpi || s.tab);
  },

  // 过滤顺序：业务类型页签 → 关键字（空格 AND）→ 日期区间 → 状态卡片
  ibVisibleRows() {
    const s = this.ibState();
    let rows = this._ibList || [];
    if (s.tab) rows = rows.filter(r => r.txn_type === s.tab);
    else rows = rows.filter(r => r.txn_type !== '采购退货');
    if (s.f.kw) rows = this.filterByKeywords(rows, s.f.kw, ['doc_no', 'date', 'txn_type', 'supplier', 'handler', 'po_no', 'contract_no', 'remarks', 'reversal_of']);
    rows = this.filterByDateRange(rows, 'date', s.f.from, s.f.to);
    const def = this.ibKpiDefs().find(d => d[0] === s.kpi);
    return def ? rows.filter(def[2]) : rows;
  },

  ibRenderList() {
    const s = this.ibState();
    const kp = document.getElementById('ib-kpis');
    if (kp) {
      kp.innerHTML = this.ibKpiDefs().map(([k, label, fn]) =>
        `<button type="button" class="pu-kpi" aria-pressed="${s.kpi === k}" data-ib="kpi" data-id="${k}"><small>${label}</small><strong>${(this._ibList || []).filter(fn).length}</strong></button>`
      ).join('');
    }
    const rows = this.ibVisibleRows();
    const st = this.getTableState('inbound');
    const sorted = this.sortData(rows, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const scroll = document.getElementById('ib-scroll');
    if (scroll) {
      scroll.innerHTML = sorted.length
        ? this.ibListTable(pageData)
        : `<div class="pu-empty">${this.t('pu_no_result')}<br><span class="pu-mu">${this.ibHasFilter() ? this.t('pu_no_result_hint') : this.t('pu_empty_hint')}</span></div>`;
    }
    this.ibRenderPager(sorted);
    this.ibUpdatePagerSticky();
  },

  ibListTable(pageData) {
    const vp = this.canViewPrice();
    const sel = this.ibState().sel;
    const tid = 'inbound';
    const cols = [
      ['doc_no', this.t('ibd_no'), r => {
        const sub = r.reversal_of ? `<br><span class="pu-mu">← ${this.ibEsc(r.reversal_of)}</span>` : '';
        return `<button type="button" class="pu-lk" data-ib="open" data-id="${this.ibEsc(r.doc_no)}">${this.ibEsc(r.doc_no)}</button>${sub}`;
      }],
      ['date', this.t('ibd_date'), r => this.fmtDate(r.date)],
      ['txn_type', this.t('ibd_type'), r => this.ibTypeBadge(r.txn_type)],
      ['supplier', this.t('ibd_supplier'), r => this.ibEsc(r.supplier || '')],
      ['line_count', this.t('ibd_lines'), r => r.line_count || 0, true],
      ['total_qty', this.t('ibd_qty'), r => this.qtyCell(r.total_qty), true],
      ['total_amount', this.t('ibd_amount'), r => this.fmtMoney(r.total_amount), true, vp],
      ['handler', this.t('ibd_handler'), r => this.ibEsc(r.handler || '')],
      ['status', this.t('ibd_status'), r => this.ibdStatusBadge(r.status)],
      ['remarks', this.t('ibd_remarks'), r => this.ibEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = pageData.map(r => {
      const on = sel === r.doc_no;
      return `<tr class="pu-row${on ? ' sel' : ''}" data-ra="inbound" data-id="${this.ibEsc(r.doc_no)}">` +
        shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  ibTypeBadge(t) {
    if (t === '入库冲销') return `<span class="badge badge-danger">${this.t('ibd_rev_type')}</span>`;
    if (t === '采购退货') return `<span class="badge badge-danger">${this.t('in_return')}</span>`;
    if (t === '零星入库') return `<span class="badge badge-success">${this.t('in_other')}</span>`;
    if (t === '采购入库') return `<span class="badge badge-info">${this.t('in_purchase')}</span>`;
    return `<span class="badge badge-muted">${this.ibEsc(t || this.t('ibd_unknown_type'))}</span>`;
  },

  ibTypeLabel(t) {
    const keyMap = { '采购入库': 'in_purchase', '采购退货': 'in_return', '零星入库': 'in_other', '入库冲销': 'ibd_rev_type' };
    if (keyMap[t]) return this.t(keyMap[t]);
    return t || this.t('ibd_unknown_type');
  },

  ibRenderPager(rows) {
    const box = document.getElementById('ib-pager');
    if (!box) return;
    const st = this.getTableState('inbound');
    const tp = Math.max(1, Math.ceil(rows.length / st.pageSize));
    if (st.page > tp) st.page = tp;
    if (!rows.length) { box.innerHTML = ''; return; }
    // 各明细单位不统一，跨单数量求和无意义 → 底部只统计单据计数；金额仅在有权查看时汇总
    const sum = k => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    let tot = `${this.t('pu_sum_orders', { n: rows.length })}`
      + ` · ${this.t('ibd_status_draft')} ${rows.filter(r => r.status === 'draft').length}`
      + ` · ${this.t('ibd_status_posted')} ${rows.filter(r => r.status === 'posted').length}`;
    if (this.canViewPrice()) tot += ` · ${this.t('ibd_amount')} ${this.fmtMoney(sum('total_amount'))}`;
    box.innerHTML = `<span class="pu-tot">${tot}</span>
      <span>${st.page} / ${tp} ${this.t('page')}</span>
      <label>${this.t('pageSize')} <select id="ib-psz">${[10, 15, 20, 50].map(n => `<option value="${n}"${n === st.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-outline btn-sm" data-ib="pg" data-id="-1"${st.page <= 1 ? ' disabled' : ''}>${this.t('pu_prev')}</button>
      <button type="button" class="btn btn-outline btn-sm" data-ib="pg" data-id="1"${st.page >= tp ? ' disabled' : ''}>${this.t('pu_next')}</button>`;
  },

  // 只有内容超出视口时才把分页条吸附到底部；内容不足一屏时随内容排在末尾
  ibUpdatePagerSticky() {
    const pb = document.querySelector('.page-body');
    const pager = document.getElementById('ib-pager');
    if (!pb || !pager) return;
    pager.classList.toggle('pin', pb.scrollHeight > pb.clientHeight + 2);
  },

  // 状态徽标
  ibdStatusBadge(status) {
    const map = {
      draft: [this.t('ibd_status_draft'), 'warning'],
      posted: [this.t('ibd_status_posted'), 'success'],
      cancelled: [this.t('ibd_status_cancelled'), 'muted'],
      partially_reversed: [this.t('ibd_status_partial_rev'), 'warning'],
      reversed: [this.t('ibd_status_reversed'), 'muted']
    };
    const m = map[status] || [status, 'muted'];
    return `<span class="badge badge-${m[1]}">${m[0]}</span>`;
  },

  // ========== 新建入库单据：独立页面，不再使用首屏弹窗 ==========
  // presetType: 传入「采购退货」时由「退货与退库」模块复用本页创建退货单
  async newInboundDoc(presetType) {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const preset = presetType === '采购退货' ? '采购退货' : '';
    this._ibPreloadLines = null;
    let docNo = '';
    try {
      const next = await this.api('/api/inbound-docs/next-no?date=' + date + '&txnType=' + encodeURIComponent(preset || '采购入库'));
      docNo = next.doc_no || '';
    } catch (e) { /* 单号预览失败不阻断创建 */ }

    const suppliers = await this.api('/api/suppliers').catch(() => []);
    const orders = await this.api('/api/purchase/pending-orders').catch(() => []);
    const pendingOrders = orders.filter(o => o.has_pending);
    const contracts = await this.api('/api/purchase/contracts').catch(() => []);
    const contractNos = contracts.map(c => c.contract_no).filter(Boolean).sort();
    const supOptions = suppliers.map(s => `<option value="${this.ibEsc(s.name)}"></option>`).join('');
    const poOptions = pendingOrders.map(o => `<option value="${o.po_no}">${o.po_no}${o.supplier ? ' · ' + o.supplier : ''}</option>`).join('');
    const contractOptions = contractNos.map(c => `<option value="${c}">${c}</option>`).join('');
    // 采购退货已迁出到独立模块，入库页不再提供该类型；仅当外部显式预设时才出现
    const typeOptions = preset
      ? `<option value="采购退货">${this.t('in_return')}</option>`
      : `<option value="采购入库">${this.t('in_purchase')}</option><option value="零星入库">${this.t('in_other')}</option>`;
    const pageTitle = preset ? this.t('ret_new_purchase') : this.t('ibd_add');

    this.setMain(this.pageWrap('🆕 ' + pageTitle, this.t('ibd_create_hint'), '',
      `<div class="data-page" id="ib-new-root">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.backToInboundList()">← ${this.t('ibd_back_list')}</span>
          <span class="badge badge-warning">${this.t('ibd_status_draft')}</span>
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('pu_section_header')}</div></div>
          <div class="form-grid" style="max-width:none">
            <div class="form-group"><label>${this.t('ibd_no')}</label><input id="ib_f_no" value="${docNo}" readonly></div>
            <div class="form-group"><label>${this.t('ibd_date')} *</label><input id="ib_f_date" type="date" value="${date}"></div>
            <div class="form-group"><label>${this.t('ibd_type')} *</label><select id="ib_f_txn_type" onchange="App.ibOnTypeChange()">${typeOptions}</select></div>
            <div class="form-group"><label id="ib_f_supplier_label">${this.t('ibd_supplier')} *</label><input id="ib_f_supplier" list="ib_sup_list" autocomplete="off"><datalist id="ib_sup_list">${supOptions}</datalist><div class="form-error" id="ib_f_supplier_error"></div></div>
            <div class="form-group"><label>${this.t('ibd_handler')}</label><input id="ib_f_handler" value="${this.user?.name || this.user?.username || ''}"></div>
            <div class="form-group" id="ib_f_po_wrap"><label>${this.t('in_po_no')}</label><select id="ib_f_po_no" onchange="App.ibLoadPendingLines('po')"><option value="">${this.t('none')}</option>${poOptions || `<option value="">${this.t('in_no_pending_orders')}</option>`}</select></div>
            <div class="form-group" id="ib_f_contract_wrap"><label>${this.t('in_contract')}</label><select id="ib_f_contract_no" onchange="App.ibLoadPendingLines('contract')"><option value="">${this.t('none')}</option>${contractOptions}</select></div>
            <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_remarks')}</label><textarea id="ib_f_remarks" rows="2"></textarea></div>
          </div>
        </div>
        <div id="ib-preload"></div>
        <div class="pu-edit-actions">
          <button class="btn btn-outline" onclick="App.backToInboundList()">${this.t('cancel')}</button>
          <button class="btn btn-primary" onclick="App.createInboundDoc()">${this.t('pu_create_and_add')}</button>
        </div>
      </div>`));
    this.injectPurchaseStyles();
    this.injectInboundStyles();
    this.ibOnTypeChange();
  },

  // 入库类型切换：采购入库显示供应商/采购单/合同；零星入库只保留可空的「来源单位」
  // 采购退货不需要采购单/合同预载，避免误带「未到货明细」
  ibOnTypeChange() {
    const type = document.getElementById('ib_f_txn_type')?.value || '采购入库';
    const isOther = type === '零星入库';
    const isReturn = type === '采购退货';
    const hidePo = isOther || isReturn;
    const label = document.getElementById('ib_f_supplier_label');
    const input = document.getElementById('ib_f_supplier');
    const poWrap = document.getElementById('ib_f_po_wrap');
    const ctWrap = document.getElementById('ib_f_contract_wrap');
    const poEl = document.getElementById('ib_f_po_no');
    const ctEl = document.getElementById('ib_f_contract_no');
    const box = document.getElementById('ib-preload');
    if (label) label.textContent = isOther ? this.t('ibd_source_unit') : this.t('ibd_supplier') + ' *';
    if (input) {
      input.placeholder = isOther ? this.t('ibd_source_unit_ph') : '';
      this.clearFieldError('ib_f_supplier');
    }
    if (poWrap) poWrap.style.display = hidePo ? 'none' : '';
    if (ctWrap) ctWrap.style.display = hidePo ? 'none' : '';
    if (hidePo) {
      if (poEl) poEl.value = '';
      if (ctEl) ctEl.value = '';
      this._ibPreloadLines = null;
      if (box) box.innerHTML = '';
    }
  },

  async createInboundDoc() {
    if (!this.validateForm({ ib_f_date: [{ rule: 'required' }] })) return;
    const body = {
      doc_no: document.getElementById('ib_f_no')?.value || '',
      date: document.getElementById('ib_f_date')?.value,
      txn_type: document.getElementById('ib_f_txn_type')?.value,
      supplier: document.getElementById('ib_f_supplier')?.value?.trim(),
      handler: document.getElementById('ib_f_handler')?.value.trim(),
      po_no: document.getElementById('ib_f_po_no')?.value,
      contract_no: document.getElementById('ib_f_contract_no')?.value,
      remarks: document.getElementById('ib_f_remarks')?.value.trim()
    };
    try {
      const r = await this.api('/api/inbound-docs', 'POST', body);
      this.toast(this.t('ibd_created'));
      // 带上「未到货明细」进入编辑页，数量留空待人工填写
      await this.editInboundDoc(r.doc_no, this._ibPreloadLines || []);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // 新建入库单：选择采购单/合同后，自动带出全部未到货明细（数量留空）
  async ibLoadPendingLines(src) {
    const poEl = document.getElementById('ib_f_po_no');
    const ctEl = document.getElementById('ib_f_contract_no');
    const box = document.getElementById('ib-preload');
    if (!box) return;
    // 零星入库没有采购单/合同来源，不触发未到货明细预载
    if (document.getElementById('ib_f_txn_type')?.value === '零星入库') {
      this._ibPreloadLines = null;
      box.innerHTML = '';
      return;
    }
    // 采购单与合同二选一
    if (src === 'po' && poEl) ctEl.value = '';
    if (src === 'contract' && ctEl) poEl.value = '';
    const poNo = poEl?.value || '';
    const contractNo = ctEl?.value || '';
    this._ibPreloadLines = null;
    if (!poNo && !contractNo) { box.innerHTML = ''; return; }

    const isPo = !!poNo;
    const url = isPo
      ? '/api/purchase/lines/by-po/' + encodeURIComponent(poNo)
      : '/api/purchase/lines/by-contract/' + encodeURIComponent(contractNo);
    let lines = [];
    try { lines = await this.api(url); }
    catch (e) { box.innerHTML = `<div class="ib-empty-draft">${e.message}</div>`; return; }

    const pending = (lines || []).filter(l => Number(l.unreceived_qty) > 0);
    this._ibPreloadLines = pending.map(l => ({
      code: l.code,
      contract_no: l.contract_no_eff || '',
      po_no: l.po_no || poNo,
      material_name: l.material_name || '',
      material_spec: l.material_spec || '',
      material_brand: l.material_brand || '',
      material_unit: l.material_unit || '',
      qty: '',
      price: Number(l.order_price) || 0,
      remarks: ''
    }));

    if (pending.length === 0) {
      box.innerHTML = `<div class="ib-empty-draft">该单据没有未到货的明细</div>`;
      return;
    }
    box.innerHTML = `<div class="pu-card">
      <div class="pu-card-title"><span>02</span><div>${this.t('pu_next_add_lines')}<small>已自动载入 ${pending.length} 行未到货明细；创建单据后填写入库数量（留空或 0 的行不会生成流水）。</small></div></div>
      <div class="table-wrap" style="max-height:280px;overflow:auto"><table><thead><tr>
        <th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th>
        <th>${this.t('in_contract')}</th><th class="text-right">${this.t('pu_order_qty')}</th>
        <th class="text-right">${this.t('pu_received_qty')}</th><th class="text-right">${this.t('pu_unreceived_qty')}</th>
      </tr></thead><tbody>${pending.map(l => `<tr>
        <td>${l.code}</td><td>${l.material_name || ''}</td><td>${l.material_spec || ''}</td>
        <td style="font-size:12px">${l.contract_no_eff || ''}</td>
        <td class="text-right">${this.fmtQty(l.order_qty)}</td>
        <td class="text-right">${this.fmtQty(l.received_qty)}</td>
        <td class="text-right"><b>${this.fmtQty(l.unreceived_qty)}</b></td>
      </tr>`).join('')}</tbody></table></div>
    </div>`;
  },

  injectInboundStyles() {
    if (document.getElementById('inbound-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'inbound-ui-styles';
    style.textContent = `
      .ib-empty-draft{padding:22px;text-align:center;background:var(--info-bg,rgba(14,165,233,.07));border:1px dashed var(--border);border-radius:9px;margin:12px 0}
      .ib-posted-hint{padding:10px;background:var(--info-bg,rgba(14,165,233,.1));border-left:3px solid var(--info,#0ea5e9);border-radius:6px;font-size:12px}
      #ib-root.ib-dense .table-wrap tbody td{padding:4px 10px;height:auto}
      #ib-root.ib-dense .table-wrap thead th{padding:6px 10px;height:auto}
    `;
    document.head.appendChild(style);
  },

  // ========== 详情栏（对齐采购：点行原地展开，不再整页跳转） ==========
  // 对外入口保持不变，供采购模块「入库单」链接跳转使用
  async openInboundDoc(docNo) {
    if (!docNo) return;
    this.currentPage = 'inbound';
    if (!document.getElementById('ib-root')) await this.renderInbound();
    return this.ibOpen(docNo);
  },

  async ibOpen(docNo) {
    const s = this.ibState();
    if (s.sel !== docNo) { s.dt = 'lines'; s.lq = ''; s.lf = ''; s.lim = 15; s.ex = new Set(); }
    s.sel = docNo;
    this._ibDocNo = docNo;
    this._ibDetail = null;
    this._ibRevInfo = null;
    this._ibDetailCache[docNo] = { loading: true };
    this.ibRenderList();
    this.ibRenderInspector();
    try {
      const d = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo));
      this._ibDetailCache[docNo] = { d };
      this._ibDetail = d;
    } catch (e) {
      this._ibDetailCache[docNo] = { error: e.message };
    }
    if (this.ibState().sel !== docNo) return;
    this.ibRenderInspector();
    // 异步加载冲销信息（原单已过账/部分冲销/已冲销时）
    if (this._ibDetailCache[docNo].d) this.loadReversalInfo(docNo);
  },

  ibCloseInspector() {
    const s = this.ibState();
    const prev = s.sel;
    s.sel = null; s.wide = false;
    this.ibRenderInspector();
    this.ibRenderList();
    if (prev) {
      const el = document.querySelector(`#ib-scroll [data-ib="open"][data-id="${CSS.escape(String(prev))}"]`);
      if (el) el.focus();
    }
  },

  ibRenderInspector() {
    const s = this.ibState();
    const box = document.getElementById('ib-insp');
    const split = document.getElementById('ib-split');
    if (!box || !split) return;
    if (!s.sel) {
      box.hidden = true; box.innerHTML = '';
      split.classList.remove('open', 'wide');
      return;
    }
    box.hidden = false;
    split.classList.add('open');
    split.classList.toggle('wide', s.wide);
    const rec = this._ibDetailCache[s.sel];
    if (!rec || rec.loading) { box.innerHTML = `<div class="pu-empty">${this.t('loading')}</div>`; return; }
    if (rec.error) { box.innerHTML = `<div class="pu-empty">${this.ibEsc(rec.error)}</div>`; return; }
    const d = rec.d;
    const lines = d.lines || [];
    const revs = d.reversals || [];
    const logs = d.logs || [];
    if (!['lines', 'rev', 'logs'].includes(s.dt)) s.dt = 'lines';

    const isReversalDoc = !!d.reversal_of;
    const typeLabel = this.ibTypeLabel(d.txn_type);
    const meta = [
      [this.t('ibd_type'), typeLabel],
      [this.t('ibd_date'), this.fmtDate(d.date) || '–'],
      [this.t('ibd_supplier'), d.supplier || '–'],
      [this.t('ibd_handler'), d.handler || '–'],
      [this.t('in_po_no'), d.po_no || '–'],
      [this.t('in_contract'), d.contract_no || '–'],
      [this.t('ibd_created_by'), d.created_by || '–'],
      [this.t('ibd_created_at'), this.fmtDateTime(d.created_at) || '–'],
    ];
    if (d.confirmed_by) meta.push([this.t('ibd_confirmed_by'), d.confirmed_by]);
    if (d.confirmed_at) meta.push([this.t('ibd_confirmed_at'), this.fmtDateTime(d.confirmed_at)]);
    if (isReversalDoc) meta.push([this.t('ibd_rev_original'), d.reversal_of]);
    meta.push([this.t('ibd_remarks'), d.remarks || '–']);

    const tabs = [
      ['lines', this.t('ibd_tab_lines'), lines.length],
      ['rev', this.t('ibd_rev_history'), revs.length],
      ['logs', this.t('pu_tab_logs'), logs.length],
    ];

    // 底部操作条：业务操作 → 只读输出（打印/导出） → 修改 → 删除（高危固定最右）
    const isDraft = d.status === 'draft';
    let foot = '';
    if (isDraft && this.can('inbound', 'edit')) {
      if (isReversalDoc) {
        foot += `<button type="button" class="btn btn-primary" data-ib="rev-confirm">${this.t('ibd_rev_confirm')}</button>`;
      } else {
        foot += `<button type="button" class="btn btn-outline" data-ib="e-doc">${lines.length ? this.t('ibd_edit') : '+ ' + this.t('ibd_add_line')}</button>`;
        if (lines.length) foot += `<button type="button" class="btn btn-primary" data-ib="confirm">✅ ${this.t('ibd_confirm')}</button>`;
      }
    }
    foot += `<button type="button" class="btn btn-outline" data-ib="print">🖨 ${this.t('doc_print')}</button>`;
    foot += `<button type="button" class="btn btn-outline" data-ib="export">⬇ ${this.t('doc_export')}</button>`;
    if (!isReversalDoc && (d.status === 'posted' || d.status === 'partially_reversed') && this.can('inbound', 'edit')) {
      foot += `<button type="button" class="btn btn-outline" data-ib="reverse">↶ ${this.t('ibd_rev_create')}</button>`;
    }
    if (isDraft && this.can('inbound', 'delete')) {
      foot += `<button type="button" class="btn btn-danger" data-ib="del">${lines.length ? this.t('ibd_delete_draft') : this.t('ibd_delete_empty')}</button>`;
    }

    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" data-ib="icl">← ${this.t('pu_back_list')}</button>
      <div class="pu-insp-head">
        <div>
          <small>${typeLabel}</small>
          <h2>${this.ibEsc(d.doc_no)}</h2>
          <span class="pu-badge">${this.ibdStatusBadge(d.status)}</span>
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" data-ib="wide" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}">${s.wide ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" data-ib="icl" title="${this.t('pu_close_detail')}">✕</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${this.ibEsc(m[0])}</dt><dd>${this.ibEsc(m[1])}</dd></div>`).join('')}</dl>
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" data-ib="dt" data-id="${k}">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="ib-dpanel"></div>
      <div class="pu-insp-foot">${foot}</div>`;
    this.ibRenderDetailPanel();
    this.ibUpdatePagerSticky();
  },

  ibRenderDetailPanel() {
    const s = this.ibState();
    const box = document.getElementById('ib-dpanel');
    if (!box) return;
    const rec = this._ibDetailCache[s.sel];
    if (!rec || !rec.d) { box.innerHTML = ''; return; }
    const d = rec.d;
    if (s.dt === 'lines') return this.ibRenderLinesBody();
    if (s.dt === 'rev') { box.innerHTML = this.ibReversalPanel(d.reversals || []); return; }
    box.innerHTML = this.ibLogsPanel(d.logs || []);
  },

  // 原单在已过账/部分冲销/已冲销时展示「已冲销 / 可冲销」
  ibShowRevCols(d) {
    return !!d && !d.reversal_of && (d.status === 'posted' || d.status === 'partially_reversed' || d.status === 'reversed');
  },

  // --- 明细：手风琴（宽屏时切换为全表） ---
  ibRenderLinesBody() {
    const s = this.ibState();
    const box = document.getElementById('ib-dpanel');
    const rec = this._ibDetailCache[s.sel];
    if (!box || !rec || !rec.d) return;
    const d = rec.d;
    const lines = d.lines || [];
    const showRevCols = this.ibShowRevCols(d);
    if (s.wide) {
      this._tableRenderers['inbound_detail_lines'] = () => this.ibRenderLinesBody();
      box.innerHTML = `<div id="ib-lines-body">${this.ibDetailLinesTable(lines)}</div>`;
      return;
    }
    const revQtyOf = l => (showRevCols ? Number(this._calcLineReversedQty(l.id) || 0) : 0);
    const f = lines.filter(l => {
      if (s.lq && !this.puKwMatch([l.code, l.material_name, l.material_spec, l.material_brand, l.contract_no, l.remarks].join(' '), s.lq)) return false;
      if (s.lf === 'rev') return revQtyOf(l) > 0;
      if (s.lf === 'rem') return revQtyOf(l) < Number(l.qty || 0);
      return true;
    });
    const nRev = lines.filter(l => revQtyOf(l) > 0).length;
    const nRem = lines.filter(l => revQtyOf(l) < Number(l.qty || 0)).length;
    const shown = Math.min(s.lim, f.length);

    let html = `<div class="pu-lqtoolbar">
      <input id="ib_lqi" type="search" value="${this.ibEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}">
      <div class="pu-chips" role="group">${[['', this.t('all'), lines.length]]
        .concat(showRevCols ? [['rev', this.t('ibd_rev_reversed'), nRev], ['rem', this.t('ibd_rev_remaining'), nRem]] : [])
        .map(([k, label, n]) => `<button type="button" class="pu-chip" aria-pressed="${s.lf === k}" data-ib="lf" data-id="${k}">${label} ${n}</button>`).join('')}</div>
    </div>`;
    if (!lines.length) {
      html += `<div class="pu-empty">${this.t('ibd_no_lines')}</div>`;
      box.innerHTML = html; return;
    }
    html += `<p class="pu-cnt">${this.t('pu_shown_count', { shown, total: f.length })}</p>`;
    if (!f.length) {
      html += `<div class="pu-empty">${this.t('pu_no_lines')}</div>`;
      box.innerHTML = html; return;
    }
    html += `<ul class="pu-lines">` + f.slice(0, shown).map(l => {
      const ex = s.ex.has(String(l.id));
      const rq = revQtyOf(l);
      const remain = this.qtyAbs(l.qty) - rq;
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" data-ib="ex" data-id="${l.id}" aria-expanded="${ex}">
          <span class="pu-line-n"><strong>${this.ibEsc(l.code)}</strong> ${this.ibEsc(l.material_name || '')} <span class="pu-mu">${this.ibEsc(l.material_spec || '')}</span></span>
          <span class="pu-line-q">${this.qtyCell(l.qty)}${this.ibEsc(l.material_unit || '')}</span>
          ${rq > 0 ? `<span class="badge badge-danger">${this.t('ibd_rev_reversed')} ${this.fmtQty(rq)}</span>` : ''}
        </button>
        ${ex ? `<div class="pu-line-d">
          <div class="pu-mu">${this.t('in_price')} ${this.fmtMoney(l.price)} · ${this.t('in_total_amount')} ${this.fmtMoney(l.amount)}${l.contract_no ? ` · ${this.t('in_contract')} ${this.ibEsc(l.contract_no)}` : ''}</div>
          ${showRevCols ? `<div>${this.t('ibd_rev_reversed')} ${this.fmtQty(rq)} · ${this.t('ibd_rev_remaining')} ${this.fmtQty(remain)}</div>` : ''}
          ${l.remarks ? `<div>${this.t('pu_remarks')}：${this.ibEsc(l.remarks)}</div>` : ''}
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    if (f.length > s.lim) html += `<button type="button" class="btn btn-outline btn-sm pu-more" data-ib="more">${this.t('pu_more', { n: f.length - s.lim })}</button>`;
    box.innerHTML = html;
  },

  ibDetailLinesTable(lines) {
    const vp = this.canViewPrice();
    const d = this._ibDetail || {};
    const showRevCols = this.ibShowRevCols(d);
    const tid = 'inbound_detail_lines';
    const cols = [
      ['code', this.t('mat_code'), r => this.ibEsc(r.code)],
      ['material_name', this.t('mat_name'), r => this.ibEsc(r.material_name || '')],
      ['material_spec', this.t('mat_spec'), r => this.ibEsc(r.material_spec || '')],
      ['material_brand', this.t('mat_brand'), r => this.ibEsc(r.material_brand || '')],
      ['material_unit', this.t('mat_unit'), r => this.ibEsc(r.material_unit || '')],
      ['contract_no', this.t('in_contract'), r => this.ibEsc(r.contract_no || d.contract_no || '')],
      ['qty', this.t('in_qty'), r => this.qtyCell(r.qty), true],
      ['reversed_qty', this.t('ibd_rev_reversed'), r => this.fmtQty(this._calcLineReversedQty(r.id)), true, showRevCols],
      ['remaining', this.t('ibd_rev_remaining'), r => this.fmtQty(this.qtyAbs(r.qty) - Number(this._calcLineReversedQty(r.id) || 0)), true, showRevCols],
      ['price', this.t('in_price'), r => this.fmtMoney(r.price), true, vp],
      ['amount', this.t('in_total_amount'), r => this.fmtMoney(r.amount), true, vp],
      ['remarks', this.t('in_remarks'), r => this.ibEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const st = this.getTableState(tid);
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = sorted.map(r => '<tr>' + shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>').join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${shown.length}" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('noData')}</td></tr>`}</tbody></table></div>`;
  },

  // --- 冲销记录 ---
  ibReversalPanel(revs) {
    if (!revs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    return `<ul class="pu-items">` + revs.map(r => {
      const isOrig = r.type === 'original';
      const label = isOrig ? `${this.t('ibd_rev_original')}: ${r.doc_no}` : `${this.t('ibd_rev_doc')}: ${r.doc_no}`;
      const sub = isOrig ? '' : [this.fmtDate(r.date), `${this.t('pu_line_count')} ${r.line_count || 0}`, `${this.t('ibd_qty')} ${this.qtyCell(r.total_qty)}`].filter(Boolean).join(' · ');
      return `<li class="pu-item"><div class="pu-item-top">
        <div>
          <button type="button" class="pu-lk" data-ib="open" data-id="${this.ibEsc(r.doc_no)}">${this.ibEsc(label)}</button>
          ${sub ? `<div class="pu-log-meta">${sub}</div>` : ''}
        </div>
        ${isOrig ? '' : this.ibdStatusBadge(r.status)}
      </div></li>`;
    }).join('') + '</ul>';
  },

  ibLogLabel(a) {
    const m = {
      create: this.t('ibd_log_create'), edit: this.t('ibd_log_edit'), update: this.t('ibd_log_edit'),
      confirm: this.t('ibd_log_confirm'), post: this.t('ibd_log_confirm'), save: this.t('ibd_log_edit'),
      cancel: this.t('ibd_log_cancel'), void: this.t('ibd_log_cancel'), delete: this.t('ibd_log_delete'),
      add_line: this.t('ibd_log_edit'), update_line: this.t('ibd_log_edit'), delete_line: this.t('ibd_log_edit'),
      reversal: this.t('ibd_log_reverse'), reverse: this.t('ibd_log_reverse'),
    };
    return m[a] || a;
  },

  ibLogsPanel(logs) {
    if (!logs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    return `<ol class="pu-log">` + logs.map(l => `<li>
      <div>
        <strong>${this.ibEsc(this.ibLogLabel(l.action))}</strong>
        <span class="pu-log-meta">· ${this.ibEsc(l.name || l.username || l.operator || l.created_by || '')} · ${this.fmtDateTime(l.created_at)}</span>
        ${l.detail ? `<div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere">${this.ibEsc(l.detail)}</div>` : ''}
      </div>
    </li>`).join('') + '</ol>';
  },

  ibFocusEnd(id) {
    const el = document.getElementById(id);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (_) {} }
  },

  // ========== 事件委托 ==========
  ibBindEvents() {
    if (this._ibBound) return;
    this._ibBound = true;

    document.addEventListener('click', e => {
      if (this.currentPage !== 'inbound') return;
      const el = e.target.closest('[data-ib]');
      if (el) { e.preventDefault(); this.ibAction(el.dataset.ib, el.dataset.id, el); return; }
      const row = e.target.closest('#ib-root tr[data-ra]');
      if (row && !String(window.getSelection())) this.ibAction('open', row.dataset.id, row);
    });

    // 点击详情卡片以外的区域（含左侧菜单栏）→ 自动收起详情栏，返回列表
    document.addEventListener('click', e => {
      const s = this.ibState();
      if (!s.sel) return;
      const insp = document.getElementById('ib-insp');
      if (!insp || insp.hidden) return;
      if (e.target.closest('#ib-insp, #ib-root tr[data-ra], [data-ib], #modal-overlay, .pu-ov, .toast')) return;
      this.ibCloseInspector();
    }, true);

    document.addEventListener('input', e => {
      if (this.currentPage !== 'inbound') return;
      const s = this.ibState();
      if (e.target.id === 'ib_f_kw') {
        s.f.kw = e.target.value;
        clearTimeout(this._ibFilterTimer);
        this._ibFilterTimer = setTimeout(() => { this.getTableState('inbound').page = 1; this.ibRenderList(); }, 250);
      } else if (e.target.id === 'ib_lqi') {
        s.lq = e.target.value;
        // 组词过程中不重绘：重绘会重建输入框，导致中文输入法组词被打断
        if (e.isComposing || this._ibLqComposing) return;
        this.ibRenderLinesBody(); this.ibFocusEnd('ib_lqi');
      } else if (e.target.id === 'ib_mat_kw') {
        this._ibMatKw = e.target.value;
        this.ibRefreshMatOptions();
      }
    });

    document.addEventListener('compositionstart', e => {
      if (e.target.id === 'ib_lqi') this._ibLqComposing = true;
    });
    document.addEventListener('compositionend', e => {
      if (e.target.id !== 'ib_lqi') return;
      this._ibLqComposing = false;
      if (this.currentPage !== 'inbound') return;
      this.ibState().lq = e.target.value;
      this.ibRenderLinesBody(); this.ibFocusEnd('ib_lqi');
    });

    document.addEventListener('change', e => {
      if (this.currentPage !== 'inbound') return;
      const s = this.ibState();
      const st = this.getTableState('inbound');
      if (e.target.id === 'ib_f_from') { s.f.from = e.target.value; st.page = 1; this.ibRenderList(); }
      else if (e.target.id === 'ib_f_to') { s.f.to = e.target.value; st.page = 1; this.ibRenderList(); }
      else if (e.target.id === 'ib-psz') { st.pageSize = parseInt(e.target.value, 10) || 15; st.page = 1; this.ibRenderList(); }
      else if (e.target.id === 'ib_mat_cat') { this._ibMatCat = e.target.value; this.ibRefreshMatOptions(); }
    });

    document.addEventListener('keydown', e => {
      if (this.currentPage !== 'inbound') return;
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === '/' && !inField && document.getElementById('ib_f_kw')) { e.preventDefault(); document.getElementById('ib_f_kw').focus(); return; }
      if (e.key === 'Escape') {
        if (document.getElementById('modal-overlay')) { this.closeModal(); return; }
        const ov = document.querySelector('.pu-ov');
        if (ov) { ov.remove(); return; }
        if (this.ibState().sel) this.ibCloseInspector();
      }
    });

    // 视口尺寸变化时重算分页条是否需要吸附
    window.addEventListener('resize', () => {
      if (this.currentPage === 'inbound') this.ibUpdatePagerSticky();
    });
  },

  ibAction(name, id, el) {
    const s = this.ibState();
    switch (name) {
      case 'tab': s.tab = id; s.kpi = ''; this.getTableState('inbound').page = 1; this.ibRenderTabs(); this.ibRenderList(); return;
      case 'open': return this.ibOpen(id);
      case 'icl': return this.ibCloseInspector();
      case 'wide': s.wide = !s.wide; this.ibRenderInspector(); return;
      case 'dt': s.dt = id; s.lim = 15; this.ibRenderInspector(); return;
      case 'kpi': s.kpi = s.kpi === id ? '' : id; this.getTableState('inbound').page = 1; this.ibRenderList(); return;
      case 'clr': s.f = { kw: '', from: '', to: '' }; s.kpi = ''; this.getTableState('inbound').page = 1; this.ibRenderFilters(); this.ibRenderList(); return;
      case 'dense': s.dense = !s.dense; document.getElementById('ib-root').classList.toggle('ib-dense', s.dense); if (el) el.setAttribute('aria-pressed', String(s.dense)); return;
      case 'pg': this.getTableState('inbound').page += Number(id); this.ibRenderList(); return;
      case 'lf': s.lf = s.lf === id ? '' : id; s.lim = 15; this.ibRenderLinesBody(); return;
      case 'ex': { const k = String(id); if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k); this.ibRenderLinesBody(); return; }
      case 'more': s.lim += 15; this.ibRenderLinesBody(); return;
      case 'new': return this.newInboundDoc();
      case 'e-doc': return this.editInboundDoc(s.sel);
      case 'confirm': return this.confirmInboundDoc();
      case 'rev-confirm': return this.confirmReversalDoc();
      case 'reverse': return this.showReversalPage(s.sel);
      case 'del': return this.deleteInboundDoc(s.sel);
      case 'print': return this.ibPrintDoc();
      case 'export': return this.ibExportDoc();
    }
  },

  // ========== 单据打印 / 导出（组装通用 doc，细节由 02-ui-kit 统一处理） ==========
  ibDocModel() {
    const s = this.ibState();
    const rec = this._ibDetailCache[s.sel];
    if (!rec || !rec.d) return null;
    const d = rec.d;
    const lines = d.lines || [];
    const vp = this.canViewPrice();
    const showRevCols = this.ibShowRevCols(d);
    const cols = [
      { label: this.t('mat_code'), key: 'code' },
      { label: this.t('mat_name'), key: 'material_name' },
      { label: this.t('mat_spec'), key: 'material_spec' },
      { label: this.t('mat_brand'), key: 'material_brand' },
      { label: this.t('mat_unit'), key: 'material_unit' },
      { label: this.t('in_contract'), value: r => r.contract_no || d.contract_no || '' },
      { label: this.t('in_qty'), align: 'right', value: r => this.fmtQty(r.qty) },
    ];
    if (showRevCols) {
      cols.push({ label: this.t('ibd_rev_reversed'), align: 'right', value: r => this.fmtQty(this._calcLineReversedQty(r.id)) });
      cols.push({ label: this.t('ibd_rev_remaining'), align: 'right', value: r => this.fmtQty(this.qtyAbs(r.qty) - Number(this._calcLineReversedQty(r.id) || 0)) });
    }
    if (vp) {
      cols.push({ label: this.t('in_price'), align: 'right', value: r => this.fmtMoney(r.price) });
      cols.push({ label: this.t('in_total_amount'), align: 'right', value: r => this.fmtMoney(r.amount) });
    }
    cols.push({ label: this.t('in_remarks'), value: r => r.remarks || '' });

    const sum = k => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
    const meta = [
      [this.t('ibd_type'), this.ibTypeLabel(d.txn_type)],
      [this.t('ibd_date'), this.fmtDate(d.date)],
      [this.t('ibd_supplier'), d.supplier || ''],
      [this.t('ibd_handler'), d.handler || ''],
      [this.t('in_po_no'), d.po_no || ''],
      [this.t('in_contract'), d.contract_no || ''],
      [this.t('ibd_status'), this.ibdStatusLabel(d.status)],
      [this.t('ibd_lines'), String(lines.length)],
      [this.t('in_total_qty'), this.fmtQty(sum('qty'))],
    ];
    if (vp) meta.push([this.t('in_total_amount'), this.fmtMoney(sum('amount'))]);
    meta.push([this.t('ibd_remarks'), d.remarks || '']);

    return {
      title: d.doc_no,
      subtitle: this.ibTypeLabel(d.txn_type),
      meta, columns: cols, rows: lines,
      filename: `${d.doc_no}_${this.today().replace(/-/g, '')}.csv`,
    };
  },

  ibdStatusLabel(status) {
    const m = {
      draft: 'ibd_status_draft', posted: 'ibd_status_posted', cancelled: 'ibd_status_cancelled',
      partially_reversed: 'ibd_status_partial_rev', reversed: 'ibd_status_reversed',
    };
    return (m[status] && this.t(m[status])) || status || '';
  },

  ibPrintDoc() {
    const doc = this.ibDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.printDoc(doc);
  },

  ibExportDoc() {
    const doc = this.ibDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.exportDocCsv(doc);
    this.toast(this.t('doc_export_done', { name: doc.filename }));
  },

  // ========== 冲销功能 ==========

  // 计算原明细行的累计已冲销数量（从前端缓存的冲销单数据计算）
  // 需要先异步获取 reversal-info 才有数据；详情页打开时如果没有冲销单则返回 0
  _calcLineReversedQty(lineId) {
    if (!this._ibRevInfo || !this._ibRevInfo.all_lines) return 0;
    const line = this._ibRevInfo.all_lines.find(l => l.id === lineId);
    return line ? line.reversed_qty : 0;
  },

  // 加载冲销信息（原单详情打开时异步调用）
  async loadReversalInfo(docNo) {
    const d = this._ibDetail;
    if (!d || d.doc_no !== docNo) return;
    // 只有原单（非冲销单）且状态为 posted/partially_reversed/reversed 时才加载
    if (d.reversal_of) return;
    if (d.status !== 'posted' && d.status !== 'partially_reversed' && d.status !== 'reversed') return;
    try {
      this._ibRevInfo = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/reversal-info');
      // 补充「已冲销 / 可冲销」后重渲染明细面板
      if (this.ibState().sel === docNo) this.ibRenderDetailPanel();
    } catch (e) { /* 静默失败，不影响详情页浏览 */ }
  },

  // 打开冲销创建页面
  async showReversalPage(docNo) {
    this._ibDocNo = docNo;

    let revInfo;
    try {
      revInfo = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/reversal-info');
    } catch (e) {
      this.setMain(this.pageWrap('⚠️ ' + this.t('ibd_rev_create'), '', '',
        `<div style="padding:20px;text-align:center"><p style="color:var(--danger)">${e.message}</p>
        <button class="btn btn-outline" onclick="App.openInboundDoc('${docNo}')">${this.t('ibd_back_detail')}</button></div>`));
      return;
    }
    this._ibRevInfo = revInfo;

    const lines = revInfo.lines || [];
    if (lines.length === 0) {
      this.setMain(this.pageWrap('⚠️ ' + this.t('ibd_rev_create'), '', '',
        `<div style="padding:20px;text-align:center">
          <p style="color:var(--text-muted)">${this.t('ibd_rev_no_remaining')}</p>
          <div style="margin-top:12px">
            <button class="btn btn-outline" onclick="App.openInboundDoc('${docNo}')">${this.t('ibd_back_detail')}</button>
          </div>
        </div>`));
      return;
    }

    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const vp = this.canViewPrice();

    // 冲销明细行表格
    const rowsHtml = lines.map((l, i) => {
      const checked = 'checked';
      const maxQty = l.remaining;
      const qtyInput = `<input type="number" step="0.01" min="0.01" max="${maxQty}" value="${maxQty}"
        data-idx="${i}" class="ib-rev-qty"
        oninput="App.onRevQtyInput(${i}, this)" onpaste="App.qtyPaste(event)">`;
      const avail = this._inboundStockMap?.[l.code];
      const availText = avail === undefined || avail === null ? '-' : avail;
      const availColor = avail === undefined || avail === null ? 'var(--text-muted)'
        : (avail < 0 ? 'var(--danger)' : (avail === 0 ? 'var(--warning)' : 'var(--success)'));
      return `<tr>
        <td style="text-align:center"><input type="checkbox" class="ib-rev-check" data-idx="${i}" ${checked} onchange="App.onRevCheckChange(${i})"></td>
        <td>${l.code}</td>
        <td>${l.material_name || ''}</td>
        <td>${l.material_spec || ''}</td>
        <td>${l.material_brand || ''}</td>
        <td>${l.material_unit || ''}</td>
        <td class="text-right">${this.qtyCell(l.qty)}</td>
        <td class="text-right" style="color:var(--danger)">${l.reversed_qty > 0 ? '-' + l.reversed_qty : 0}</td>
        <td class="text-right" style="color:var(--success);font-weight:600">${l.remaining}</td>
        <td class="text-right" style="font-size:12px;color:${availColor}">${availText}</td>
        <td>${qtyInput}</td>
      </tr>`;
    }).join('');

    // 已有冲销单列表（独立卡片，与 01/02 卡片同一层级，避免卡片套卡片）
    const existingRevs = revInfo.reversals || [];
    const revListHtml = existingRevs.length > 0
      ? `<div class="pu-card">
          <div class="pu-card-title"><span>03</span><div>${this.t('ibd_rev_history')}<small>· ${existingRevs.length}</small></div></div>
          <div class="table-wrap"><table><thead><tr>
            <th>${this.t('ibd_no')}</th><th>${this.t('ibd_date')}</th><th>${this.t('ibd_status')}</th>
            <th>${this.t('ibd_lines')}</th><th>${this.t('ibd_qty')}</th><th>${this.t('ibd_confirmed_by')}</th><th></th>
          </tr></thead><tbody>
          ${existingRevs.map(r => `<tr>
            <td><span class="action-link" onclick="App.openInboundDoc('${r.doc_no}')">${r.doc_no}</span></td>
            <td>${this.fmtDate(r.date)}</td>
            <td>${this.ibdStatusBadge(r.status)}</td>
            <td class="text-right">${r.line_count || 0}</td>
            <td class="text-right">${this.qtyCell(r.total_qty)}</td>
            <td>${r.confirmed_by || '-'}</td>
            <td><span class="action-link" onclick="App.openInboundDoc('${r.doc_no}')">${this.t('ibd_view_detail')}</span></td>
          </tr>`).join('')}
          </tbody></table></div>
        </div>`
      : '';

    this.setMain(this.pageWrap('↶ ' + this.t('ibd_rev_create'),
      `${this.t('ibd_rev_original')}: ${docNo}`, '',
      `<div id="ib-rev-root" class="data-page">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.openInboundDoc('${docNo}')">← ${this.t('ibd_back_detail')}</span>
          ${this.ibdStatusBadge(revInfo.status)}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('ibd_rev_section_info')}</div></div>
          <div class="form-grid" style="max-width:none">
            <div class="form-group"><label>${this.t('ibd_rev_original')}</label><input id="ib_rev_original" value="${this.ibEsc(docNo)}" readonly></div>
            <div class="form-group"><label>${this.t('ibd_date')} *</label><input id="ib_rev_date" type="date" value="${date}"></div>
            <div class="form-group"><label>${this.t('ibd_type')}</label><input value="${this.t('ibd_rev_type')}" readonly></div>
            <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_rev_reason')}</label><textarea id="ib_rev_reason" rows="2" placeholder="${this.t('ibd_rev_reason_ph')}"></textarea></div>
          </div>
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>02</span><div>${this.t('ibd_rev_section_lines')}<small>· ${lines.length}</small></div></div>
          <div class="table-wrap"><table class="pu-edit-lines"><thead><tr>
            <th style="width:30px"></th>
            <th>${this.t('mat_code')}</th>
            <th>${this.t('mat_name')}</th>
            <th>${this.t('mat_spec')}</th>
            <th>${this.t('mat_brand')}</th>
            <th>${this.t('mat_unit')}</th>
            <th class="text-right">${this.t('ibd_rev_orig_qty')}</th>
            <th class="text-right">${this.t('ibd_rev_reversed')}</th>
            <th class="text-right">${this.t('ibd_rev_remaining')}</th>
            <th class="text-right">${this.t('out_available')}</th>
            <th class="text-right">${this.t('ibd_rev_this_qty')}</th>
          </tr></thead><tbody>${rowsHtml}</tbody></table></div>
          <div class="pu-edit-sum" id="ib-rev-summary"></div>
        </div>
        ${revListHtml}
        <div class="pu-edit-actions">
          <button class="btn btn-outline" onclick="App.openInboundDoc('${docNo}')">${this.t('cancel')}</button>
          <button class="btn btn-primary" onclick="App.createReversalDoc('${docNo}')">${this.t('ibd_rev_create_btn')}</button>
        </div>
      </div>`));
    this.injectPurchaseStyles();
    this.injectInboundStyles();
    this.refreshRevSummary();
  },

  // 冲销数量输入：先去负号（含粘贴），再按上限收敛
  onRevQtyInput(idx, el) {
    const clean = this.qtyInput(el);
    this.onRevQtyChange(idx, clean);
  },

  // 冲销数量变化
  onRevQtyChange(idx, val) {
    const lines = this._ibRevInfo?.lines || [];
    if (lines[idx]) {
      const max = lines[idx].remaining;
      let v = parseFloat(val) || 0;
      if (v > max) v = max;
      if (v < 0) v = 0;
      this._ibRevInfo.lines[idx]._revQty = v;
    }
    this.refreshRevSummary();
  },

  // 勾选/取消勾选
  onRevCheckChange(idx) {
    this.refreshRevSummary();
  },

  // 刷新冲销汇总
  refreshRevSummary() {
    const lines = this._ibRevInfo?.lines || [];
    let totalRevQty = 0, checkedCount = 0;
    lines.forEach((l, i) => {
      const checkbox = document.querySelector(`.ib-rev-check[data-idx="${i}"]`);
      if (checkbox && checkbox.checked) {
        checkedCount++;
        const qty = l._revQty !== undefined ? l._revQty : l.remaining;
        totalRevQty += qty;
      }
    });
    const summary = document.getElementById('ib-rev-summary');
    if (summary) {
      summary.innerHTML = `<span>${this.t('ibd_rev_selected', { n: checkedCount })}</span><span>${this.t('ibd_rev_total_qty')}: <b style="color:var(--danger)">${totalRevQty}</b></span>`;
    }
  },

  // 创建冲销单
  async createReversalDoc(originalDocNo) {
    const lines = this._ibRevInfo?.lines || [];
    const revLines = [];
    let hasInvalidQty = false;
    lines.forEach((l, i) => {
      const checkbox = document.querySelector(`.ib-rev-check[data-idx="${i}"]`);
      if (checkbox && checkbox.checked) {
        const qty = l._revQty !== undefined ? l._revQty : l.remaining;
        if (this.qtyIsValid(qty)) revLines.push({ line_id: l.id, qty: qty });
        else hasInvalidQty = true;
      }
    });

    if (hasInvalidQty) {
      this.toast(this.t('rev_qty_required'), 'error');
      return;
    }
    if (revLines.length === 0) {
      this.toast(this.t('ibd_rev_no_selection'), 'error');
      return;
    }

    const date = document.getElementById('ib_rev_date')?.value || this.today();
    const reason = document.getElementById('ib_rev_reason')?.value || '';

    this.confirmDialog(this.t('ibd_rev_create'),
      `${this.t('ibd_rev_confirm_hint')}\n\n${this.t('ibd_rev_selected', { n: revLines.length })} | ${this.t('ibd_rev_total_qty')}: ${revLines.reduce((s, l) => s + l.qty, 0)}`,
      async () => {
        try {
          const r = await this.api('/api/inbound-docs/' + encodeURIComponent(originalDocNo) + '/reversal', 'POST', {
            date, reason, lines: revLines
          });
          this.toast(this.t('ibd_rev_created', { no: r.doc_no }));
          // 打开冲销单详情
          await this.openInboundDoc(r.doc_no);
        } catch (e) {
          this.toast(e.message, 'error');
        }
      });
  },

  // 确认冲销（冲销单草稿 → posted）
  confirmReversalDoc() {
    const docNo = this._ibDocNo;
    const d = this._ibDetail;
    const lines = d?.lines || [];

    this.confirmDialog(this.t('ibd_rev_confirm'),
      `${this.t('ibd_rev_confirm_hint2')}\n\n${this.t('ibd_line_count', { n: lines.length })} | ${this.t('in_total_qty')}: ${lines.reduce((s, l) => s + Math.abs(Number(l.qty || 0)), 0)}`,
      async () => {
        try {
          const r = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/reversal-confirm', 'POST', {});
          this.toast(this.t('ibd_rev_confirmed', { n: r.line_count }));
          await this.openInboundDoc(docNo);
        } catch (e) {
          if (e.code === 'INSUFFICIENT_STOCK') {
            this.handleReversalStockError(e, docNo);
          } else {
            this.toast(e.message, 'error');
          }
        }
      });
  },

  // 冲销库存不足：admin/manager 可强制放行
  handleReversalStockError(err, docNo) {
    const details = (err.details || []).map(d => `${d.code}：${this.t('ibd_rev_need')} ${d.requested}，${this.t('out_available')} ${d.available}`).join('\n');
    const canForce = ['admin', 'manager'].includes(this.user?.role);
    if (!canForce) {
      this.toast(`${this.t('ibd_rev_stock_short')}：\n${details}`, 'error');
      return;
    }
    const self = this;
    this.confirmDialog(
      this.t('ibd_rev_stock_short'),
      `${details}\n\n${this.t('out_force_allow')}`,
      async () => {
        try {
          const r = await self.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/reversal-confirm', 'POST', { force_allow: true });
          self.toast(self.t('ibd_rev_confirmed', { n: r.line_count }));
          await self.openInboundDoc(docNo);
        } catch (e2) { self.toast(e2.message, 'error'); }
      }
    );
  },

  // ========== 入库单据编辑页面（独立页面，非模态窗口） ==========

  async editInboundDoc(docNo, preloadLines) {
    this._ibDocNo = docNo;
    // 物料筛选条状态：切换单据时重置
    if (this._ibEditFilterDoc !== docNo) { this._ibMatCat = ''; this._ibMatKw = ''; this._ibEditFilterDoc = docNo; }

    const [detail, suppliers] = await Promise.all([
      this.api('/api/inbound-docs/' + encodeURIComponent(docNo)),
      this.api('/api/suppliers').catch(() => [])
    ]);
    this._ibDetail = detail;
    this._ibSupplierList = suppliers || [];
    this._ibEditLines = (detail.lines || []).map(l => ({
      id: l.id,
      code: l.code,
      material_name: l.material_name,
      material_spec: l.material_spec,
      material_brand: l.material_brand,
      material_unit: l.material_unit,
      qty: Math.abs(Number(l.qty)),
      price: Math.abs(Number(l.price)),
      remarks: l.remarks || '',
      contract_no: l.contract_no || '',
      po_no: l.po_no || ''
    }));
    // 从采购单/合同「收货」进入时，自动载入未到货明细（数量留空待人工填写）
    if (this._ibEditLines.length === 0 && Array.isArray(preloadLines) && preloadLines.length > 0) {
      this._ibEditLines = preloadLines.map(l => ({ ...l }));
    }

    // 加载物料和库存数据
    const materials = await this.api('/api/materials');
    this._materialsCache = materials;
    let stockMap = {};
    try {
      const stock = await this.api('/api/stock-summary');
      stockMap = Object.fromEntries(stock.map(s => [s.code, s.on_hand]));
    } catch (e) {}
    this._inboundStockMap = stockMap;

    const typeLabel = this.ibTypeLabel(detail.txn_type);

    this.setMain(this.pageWrap('✏️ ' + detail.doc_no,
      `${this.t('ibd_edit_title')} · ${typeLabel}`, '',
      `<div id="ib-edit-root" class="data-page">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.backToInboundDetail('${docNo}')">← ${this.t('ibd_back_detail')}</span>
          ${this.ibdStatusBadge(detail.status)}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('pu_section_header')}</div></div>
          <div id="ib-edit-form"></div>
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>02</span><div>${this.t('ibd_section_lines')}<small id="ib-edit-line-count"></small></div></div>
          <div id="ib-edit-lines"></div>
        </div>
        <div class="pu-edit-actions" id="ib-edit-buttons"></div>
      </div>`));

    this.injectPurchaseStyles();
    this.injectInboundStyles();
    this.renderInboundEdit();
  },

  renderInboundEdit() {
    const d = this._ibDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const typeLabel = this.ibTypeLabel(d.txn_type);
    const isOther = d.txn_type === '零星入库';
    const supOptions = (this._ibSupplierList || []).map(s => `<option value="${this.ibEsc(s.name)}"></option>`).join('');

    // 01 单据信息（草稿态可编辑；过账后仅提示不可改）
    const formEl = document.getElementById('ib-edit-form');
    if (formEl) {
      if (isDraft) {
        // 字段排布与采购编辑页一致：单据号(只读) → 日期 → 类型(只读) → 供应商/来源单位 → 经手人 → [采购单号 → 合同号] → 备注(整行)
        const supLabel = isOther ? this.t('ibd_source_unit') : this.t('ibd_supplier') + ' *';
        const supPlaceholder = isOther ? this.t('ibd_source_unit_ph') : '';
        const poFields = isOther ? '' : `
          <div class="form-group"><label>${this.t('in_po_no')}</label><input id="ib_e_po_no" value="${this.ibEsc(d.po_no || '')}"></div>
          <div class="form-group"><label>${this.t('in_contract')}</label><input id="ib_e_contract_no" value="${this.ibEsc(d.contract_no || '')}"></div>`;
        formEl.innerHTML = `<div class="form-grid" style="max-width:none">
          <div class="form-group"><label>${this.t('ibd_no')}</label><input id="ib_e_no" value="${this.ibEsc(d.doc_no)}" readonly></div>
          <div class="form-group"><label>${this.t('ibd_date')} *</label><input id="ib_e_date" type="date" value="${this.fmtDate(d.date)}"></div>
          <div class="form-group"><label>${this.t('ibd_type')}</label><input id="ib_e_type" value="${this.ibEsc(typeLabel)}" readonly></div>
          <div class="form-group"><label>${supLabel}</label><input id="ib_e_supplier" list="ib_e_sup_list" autocomplete="off" placeholder="${supPlaceholder}" value="${this.ibEsc(d.supplier || '')}"><datalist id="ib_e_sup_list">${supOptions}</datalist><div class="form-error"></div></div>
          <div class="form-group"><label>${this.t('ibd_handler')}</label><input id="ib_e_handler" value="${this.ibEsc(d.handler || '')}"></div>${poFields}
          <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_remarks')}</label><textarea id="ib_e_remarks" rows="2">${this.ibEsc(d.remarks || '')}</textarea></div>
        </div>`;
      } else {
        formEl.innerHTML = `<div class="ib-posted-hint">${this.t('ibd_posted_hint')}</div>`;
      }
    }

    // 底部操作行（对齐采购编辑页：添加明细 → 保存草稿 → 确认）
    const btnBox = document.getElementById('ib-edit-buttons');
    if (btnBox) {
      btnBox.innerHTML = isDraft
        ? `<button class="btn btn-outline" onclick="App.addInboundEditRow()">+ ${this.t('ibd_add_line')}</button>
           <button class="btn btn-outline" onclick="App.saveInboundDraft()">${this.t('ibd_save_draft')}</button>
           <button class="btn btn-primary" onclick="App.confirmInboundDocFromEdit()">${this.t('ibd_confirm')}</button>`
        : '';
    }

    this.renderInboundEditTable();
  },

  // 添加空行
  addInboundEditRow() {
    if (!this._ibEditLines) this._ibEditLines = [];
    this._ibEditLines.push({ code: '', qty: '', price: '', remarks: '' });
    this.renderInboundEditTable();
  },

  // 只重渲染 02 明细区（物料筛选条 + 明细表 + 汇总），不重建 01 表单与底部按钮
  renderInboundEditTable() {
    const d = this._ibDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const vp = this.canViewPrice();
    const lines = this._ibEditLines || [];
    const mats = this._materialsCache || [];
    const colCount = 6 + (vp ? 2 : 0);

    // 列序对齐采购编辑页：物料 / 数量 / 单价 / 行金额 / 合同号 / 备注 / 只读参照列 / 删除
    const headHtml = `<tr>
      <th>${this.t('pu_material')}</th>
      <th>${this.t('in_qty')}</th>
      ${vp ? `<th>${this.t('in_price')}</th><th class="text-right">${this.t('pu_line_amount')}</th>` : ''}
      <th>${this.t('in_contract')}</th>
      <th>${this.t('in_remarks')}</th>
      <th class="text-right">${this.t('out_available')}</th>
      <th></th>
    </tr>`;

    let tbody = '';
    if (lines.length === 0) {
      tbody = `<tr><td colspan="${colCount}" style="text-align:center;padding:26px;color:var(--text-muted)">
        ${this.t('ibd_no_lines')}
        ${isDraft ? `<div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="App.addInboundEditRow()">+ ${this.t('ibd_add_line')}</button></div>` : ''}
      </td></tr>`;
    } else {
      tbody = lines.map((l, i) => {
        const available = this._inboundStockMap[l.code];
        const availText = available === undefined || available === null ? '-' : this.fmtQty(available);
        const availColor = available === undefined || available === null ? 'var(--text-muted)'
          : (available < 0 ? 'var(--danger)' : (available === 0 ? 'var(--warning)' : 'var(--success)'));
        const contract = l.contract_no || d.contract_no || '';
        const amt = (Number(l.qty) || 0) * (Number(l.price) || 0);

        if (!isDraft) {
          const qty = Number(l.qty) || 0;
          return `<tr>
            <td>${this.ibLineLabel(l)}</td>
            <td${qty < 0 ? ' style="color:var(--danger)"' : ''}>${this.fmtQty(qty)}</td>
            ${vp ? `<td>${this.fmtMoney(l.price)}</td><td class="pu-edit-amt">${this.fmtMoney(amt)}</td>` : ''}
            <td style="font-size:12px">${contract}</td>
            <td>${l.remarks || ''}</td>
            <td class="pu-edit-amt" style="color:${availColor}">${availText}</td>
            <td></td>
          </tr>`;
        }
        return `<tr>
          <td style="min-width:220px"><select class="ib-line-mat" data-idx="${i}" onchange="App.ibEditSet(${i},'code',this.value)">${this.ibMatOpts(l.code)}</select></td>
          <td style="min-width:100px"><input type="number" step="0.01" min="0.01" value="${l.qty === null || l.qty === undefined ? '' : l.qty}" oninput="App.ibEditQtyInput(${i}, this)" onpaste="App.qtyPaste(event)"></td>
          ${vp ? `<td style="min-width:100px"><input type="number" step="0.01" min="0" value="${l.price === null || l.price === undefined ? '' : l.price}" oninput="App.ibEditSet(${i},'price',this.value)"></td>
          <td class="pu-edit-amt" data-line-amount="${i}">${this.fmtMoney(amt)}</td>` : ''}
          <td style="min-width:120px;font-size:12px">${contract}</td>
          <td style="min-width:140px"><input value="${this.ibEsc(l.remarks || '')}" oninput="App.ibEditSet(${i},'remarks',this.value)"></td>
          <td class="pu-edit-amt" style="font-size:12px;color:${availColor}">${availText}</td>
          <td><button type="button" class="pu-edit-del" onclick="App.removeInboundEditRow(${i})">${this.t('in_remove_row')}</button></td>
        </tr>`;
      }).join('');
    }

    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const totalAmount = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
    const sumHtml = `<div class="pu-edit-sum">
      <span>${this.t('pu_line_count')}: <b id="ib_es_lines">${lines.length}</b></span>
      <span>${this.t('in_total_qty')}: <b id="ib_es_qty">${this.fmtQty(totalQty)}</b></span>
      ${vp ? `<span>${this.t('in_total_amount')}: <b id="ib_es_amt">${this.fmtMoney(totalAmount)}</b></span>` : ''}
    </div>`;

    const box = document.getElementById('ib-edit-lines');
    if (box) {
      let filterHtml = '';
      if (isDraft) {
        const cats = [...new Set(mats.map(m => m.category).filter(Boolean))].sort();
        const catOpts = `<option value="">${this.t('all')}</option>` + cats.map(c =>
          `<option value="${this.ibEsc(c)}"${this._ibMatCat === c ? ' selected' : ''}>${this.ibEsc(c)}</option>`).join('');
        filterHtml = `<div class="pu-matfilter">
          <label>${this.t('mat_category')}<select id="ib_mat_cat">${catOpts}</select></label>
          <input id="ib_mat_kw" type="search" value="${this.ibEsc(this._ibMatKw || '')}" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}">
          <span class="pu-mu" id="ib_mat_cnt">${this.ibMatFiltered().length} / ${mats.length}</span>
        </div>`;
      }
      box.innerHTML = filterHtml + `<div class="table-wrap"><table class="pu-edit-lines"><thead>${headHtml}</thead><tbody>${tbody}</tbody></table></div>` + sumHtml;
    }
    const cnt = document.getElementById('ib-edit-line-count');
    if (cnt) cnt.textContent = lines.length ? ' · ' + lines.length : '';
  },

  // 明细行物料文案：优先取物料主数据，回退到单据行自带信息
  ibLineLabel(l) {
    const m = (this._materialsCache || []).find(x => x.code === l.code) || {};
    return this.puMatLabel({
      code: l.code || '',
      name: m.name || l.material_name || '',
      spec: m.spec || l.material_spec || '',
      brand: m.brand || l.material_brand || '',
    });
  },

  // 物料下拉：筛选后的候选 + 保留当前已选（即使被筛掉也保留）
  ibMatOpts(sel) {
    const mats = this._materialsCache || [];
    const list = this.ibMatFiltered();
    if (sel && !list.some(m => m.code === sel)) {
      const cm = mats.find(m => m.code === sel);
      if (cm) list.unshift(cm);
    }
    return `<option value="">${this.t('please_select')}</option>` + list.map(m =>
      `<option value="${this.ibEsc(m.code)}"${m.code === sel ? ' selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
  },

  // 物料筛选：类别（精确）+ 编码/名称/规格/品牌（多关键字模糊）
  ibMatFiltered() {
    const mats = this._materialsCache || [];
    const cat = this._ibMatCat || '';
    return mats.filter(m => {
      if (cat && m.category !== cat) return false;
      return this.puKwMatch([m.code, m.name, m.spec, m.brand].join(' '), this._ibMatKw);
    });
  },

  // 筛选变化时就地刷新各行的物料下拉（不重建整张表，避免输入焦点丢失）
  ibRefreshMatOptions() {
    const mats = this._materialsCache || [];
    const list = this.ibMatFiltered();
    const cnt = document.getElementById('ib_mat_cnt');
    if (cnt) cnt.textContent = `${list.length} / ${mats.length}`;
    document.querySelectorAll('#ib-edit-lines select.ib-line-mat').forEach(sel => {
      const cur = sel.value;
      const opts = list.slice();
      if (cur && !opts.some(m => m.code === cur)) {
        const cm = mats.find(m => m.code === cur);
        if (cm) opts.unshift(cm);
      }
      sel.innerHTML = `<option value="">${this.t('please_select')}</option>` + opts.map(m =>
        `<option value="${this.ibEsc(m.code)}"${m.code === cur ? ' selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
    });
  },

  // 数量输入：去掉负号（含粘贴）后写回明细
  ibEditQtyInput(idx, el) {
    const clean = this.qtyInput(el);
    this.ibEditSet(idx, 'qty', clean);
  },

  // 明细行字段变更（草稿态）：物料/数量/单价/备注
  ibEditSet(idx, field, val) {
    const l = (this._ibEditLines || [])[idx];
    if (!l) return;
    if (field === 'code') {
      const m = (this._materialsCache || []).find(x => x.code === val);
      l.code = val || '';
      l.material_name = m ? m.name : '';
      l.material_spec = m ? m.spec : '';
      l.material_brand = m ? m.brand : '';
      l.material_unit = m ? m.unit : '';
      if (m && (l.price === '' || l.price === null || l.price === undefined)) l.price = m.opening_price || '';
      // 可用库存、单位随物料变化 → 重渲染明细区
      this.renderInboundEditTable();
      return;
    }
    if (field === 'qty' || field === 'price') l[field] = parseFloat(val) || 0;
    else l[field] = String(val == null ? '' : val);
    if (field === 'qty' || field === 'price') {
      const cell = document.querySelector(`#ib-edit-lines [data-line-amount="${idx}"]`);
      if (cell) cell.textContent = this.fmtMoney((Number(l.qty) || 0) * (Number(l.price) || 0));
      this.refreshInboundEditTotals();
    }
  },

  // 数量/单价输入时仅更新金额和汇总，不重绘表格，避免输入焦点丢失
  refreshInboundEditTotals() {
    const lines = this._ibEditLines || [];
    const totalQty = lines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    const totalAmount = lines.reduce((sum, line) => sum + (Number(line.qty) || 0) * (Number(line.price) || 0), 0);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ib_es_lines', String(lines.length));
    set('ib_es_qty', this.fmtQty(totalQty));
    if (this.canViewPrice()) set('ib_es_amt', this.fmtMoney(totalAmount));
  },

  // 删除明细行（只删当前行，不影响其他物料）
  removeInboundEditRow(idx) {
    if (!this._ibEditLines) return;
    this._ibEditLines.splice(idx, 1);
    this.renderInboundEditTable();
  },

  // 明细行校验：数量必须为正数、单价不能为负；0/非法值显式报错，不再静默丢行
  ibValidateEditLines() {
    const lines = this._ibEditLines || [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // 完全空行（点了添加但未填任何内容）允许忽略
      if (!l.code && !l.qty && !l.price && !l.remarks) continue;
      if (!l.code) return { ok: false, message: this.t('line_material_required', { n: i + 1 }) };
      if (!this.qtyIsValid(l.qty)) return { ok: false, message: this.t('qty_line_invalid', { n: i + 1 }) };
      if (!this.priceIsValid(l.price)) return { ok: false, message: this.t('price_line_invalid', { n: i + 1 }) };
    }
    return { ok: true };
  },

  // ========== 保存草稿 ==========
  // 明细行提交体：带上行级合同号/采购单号（按采购单或合同载入的行可能各不相同），
  // 为空则交由后端回退到单据头字段。
  ibLinesPayload(lines) {
    return (lines || []).map(l => {
      const o = { code: l.code, qty: parseFloat(l.qty) || 0, price: parseFloat(l.price) || 0, remarks: l.remarks || '' };
      if (l.contract_no) o.contract_no = l.contract_no;
      if (l.po_no) o.po_no = l.po_no;
      return o;
    });
  },

  async saveInboundDraft() {
    const docNo = this._ibDocNo;

    const check = this.ibValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = (this._ibEditLines || []).filter(l => l.code);

    // 草稿允许暂时没有明细；只有确认过账时才强制要求至少一行有效物料。
    const body = {
      lines: this.ibLinesPayload(lines),
      date: document.getElementById('ib_e_date')?.value,
      supplier: document.getElementById('ib_e_supplier')?.value,
      handler: document.getElementById('ib_e_handler')?.value,
      po_no: document.getElementById('ib_e_po_no')?.value,
      contract_no: document.getElementById('ib_e_contract_no')?.value,
      remarks: document.getElementById('ib_e_remarks')?.value
    };

    try {
      await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
      this.toast(this.t('ibd_draft_saved'));
      // 刷新详情
      await this.editInboundDoc(docNo);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // ========== 确认入库（从编辑页面） ==========
  confirmInboundDocFromEdit() {
    const docNo = this._ibDocNo;
    const d = this._ibDetail;

    const check = this.ibValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = (this._ibEditLines || []).filter(l => l.code);
    const s = d?.summary || {};

    if (lines.length === 0) {
      this.toast(this.t('ibd_no_lines'), 'error');
      return;
    }

    // 采购入库/采购退货在确认过账时必须有供应商；草稿态允许暂空
    if (['采购入库', '采购退货'].includes(d?.txn_type)) {
      const supEl = document.getElementById('ib_e_supplier');
      if (!supEl || !supEl.value.trim()) {
        if (supEl) this.setFieldError('ib_e_supplier', this.t('ibd_supplier_required'));
        this.toast(this.t('ibd_supplier_required'), 'error');
        return;
      }
    }

    this.confirmDialog(this.t('ibd_confirm'),
      `${this.t('ibd_confirm_hint')}\n\n${this.t('ibd_line_count', { n: lines.length })} | ${this.t('in_total_qty')}: ${lines.reduce((s, l) => s + Math.abs(Number(l.qty) || 0), 0)}`,
      async () => {
        // 先保存明细，再确认
        const body = {
          lines: this.ibLinesPayload(lines),
          date: document.getElementById('ib_e_date')?.value,
          supplier: document.getElementById('ib_e_supplier')?.value,
          handler: document.getElementById('ib_e_handler')?.value,
          po_no: document.getElementById('ib_e_po_no')?.value,
          contract_no: document.getElementById('ib_e_contract_no')?.value,
          remarks: document.getElementById('ib_e_remarks')?.value
        };
        try {
          await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
          // 确认入库
          try {
            const r = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', {});
            this.toast(this.t('ibd_confirm_ok', { n: r.line_count }));
            await this.openInboundDoc(docNo);
          } catch (e) {
            if (e.code === 'INSUFFICIENT_STOCK') {
              this.handleInboundDocStockError(e, docNo);
            } else {
              this.toast(e.message, 'error');
            }
          }
        } catch (e) {
          this.toast(e.message, 'error');
        }
      });
  },

  // 确认入库（从详情页面，草稿已有明细行）
  confirmInboundDoc() {
    const docNo = this._ibDocNo;
    const d = this._ibDetail;
    const lines = d?.lines || [];

    if (lines.length === 0) {
      this.toast(this.t('ibd_no_lines'), 'error');
      return;
    }

    // 采购入库/采购退货在确认过账时必须有供应商
    if (['采购入库', '采购退货'].includes(d?.txn_type) && !String(d?.supplier || '').trim()) {
      this.toast(this.t('ibd_supplier_required'), 'error');
      return;
    }

    this.confirmDialog(this.t('ibd_confirm'),
      `${this.t('ibd_confirm_hint')}\n\n${this.t('ibd_line_count', { n: lines.length })} | ${this.t('in_total_qty')}: ${lines.reduce((s, l) => s + Math.abs(Number(l.qty) || 0), 0)}`,
      async () => {
        try {
          const r = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', {});
          this.toast(this.t('ibd_confirm_ok', { n: r.line_count }));
          await this.openInboundDoc(docNo);
        } catch (e) {
          if (e.code === 'INSUFFICIENT_STOCK') {
            this.handleInboundDocStockError(e, docNo);
          } else {
            this.toast(e.message, 'error');
          }
        }
      });
  },

  // 采购退货库存不足：admin/manager 可强制放行
  handleInboundDocStockError(err, docNo) {
    const details = (err.details || []).map(d => `${d.code}：需 ${d.requested}，可用 ${d.available}`).join('\n');
    const canForce = ['admin', 'manager'].includes(this.user?.role);
    if (!canForce) {
      this.toast(`${this.t('out_stock_short')}：${details}`, 'error');
      return;
    }
    const self = this;
    this.confirmDialog(
      this.t('out_stock_short'),
      `${details}\n\n${this.t('out_force_allow')}`,
      async () => {
        try {
          const r = await self.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', { force_allow: true });
          self.toast(self.t('ibd_confirm_ok', { n: r.line_count }));
          await self.openInboundDoc(docNo);
        } catch (e2) { self.toast(e2.message, 'error'); }
      }
    );
  },

  // ========== 删除入库单据 ==========
  // 删除草稿：对齐采购模块（二次确认 + 7 秒内可撤销）
  deleteInboundDoc(docNo) {
    const rec = this._ibDetailCache[docNo];
    const d = (this._ibDetail && this._ibDetail.doc_no === docNo) ? this._ibDetail : (rec && rec.d) || null;
    const lineCount = d ? (d.lines || []).length : null;
    const detailText = lineCount === null ? this.t('ibd_delete_confirm')
      : `确定删除草稿 ${this.ibEsc(docNo)}？<br>当前明细：${lineCount} 行。<br>${this.t('pu_delete_hint')}`;

    const doDelete = async () => {
      let snap = d;
      if (!snap) { try { snap = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo)); } catch (_) { snap = null; } }
      await this.api('/api/inbound-docs/' + encodeURIComponent(docNo), 'DELETE');
      const s = this.ibState();
      if (s.sel === docNo) { s.sel = null; s.wide = false; }
      delete this._ibDetailCache[docNo];
      this._ibDetail = null; this._ibDocNo = null;
      await this.renderInbound();
      // 撤销：按快照重建同号草稿单
      return async () => {
        if (snap) {
          await this.api('/api/inbound-docs', 'POST', {
            doc_no: snap.doc_no, date: snap.date, txn_type: snap.txn_type,
            supplier: snap.supplier, handler: snap.handler,
            po_no: snap.po_no, contract_no: snap.contract_no, remarks: snap.remarks,
            lines: (snap.lines || []).map(l => ({
              code: l.code, qty: l.qty, price: l.price,
              po_no: l.po_no || '', contract_no: l.contract_no || '', remarks: l.remarks || '',
            })),
          });
        }
        await this.renderInbound();
      };
    };
    this.puConfirmDelete(this.t('delete'), detailText, doDelete, this.t('deleted'));
  },

  // ========== 导航 ==========
  backToInboundList() {
    this.renderInbound();
  },

  backToInboundDetail(docNo) {
    this.openInboundDoc(docNo);
  },

});
