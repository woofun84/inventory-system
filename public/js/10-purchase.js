/**
 * 采购管理 —— 采购单 / 合同 / 采购明细
 *
 * 交互范式（参考采购管理模板，配色映射项目 CSS 变量）：
 *   - 单页三段式：页签（采购单 / 合同 / 采购明细）+ 条件区 + 列表
 *   - 列表右侧 sticky 详情栏（.pu-split.open），点行即在右侧展开，不跳页
 *   - 详情子页签带计数；明细以手风琴卡片呈现（行内进度条、展开出到货履历/编辑/删除）
 *   - KPI 状态胶囊（可点击筛选 + 计数）；底部合计 + 分页
 *   - 删除可撤销（toast 内「撤销」）；支持 / 搜索、↑↓ 选行、Enter 打开、Esc 关闭
 *
 * 信息架构：
 *   采购单  → 一张单一行，右侧详情（明细 / 入库 / 日志）
 *   合同    → 合同档案，右侧详情（明细 / 采购单 / 入库 / 日志）
 *   采购明细→ 行级综合查询，点行下钻到所属采购单详情
 *
 * 数据来源：/api/purchase/*（见 server/routes/purchase.js）
 * 到货口径：入库按 order_line_id 精确核销，回退「采购单 + 物料 + 有效合同号」
 * 采购单 ↔ 合同为多对多：明细行 order_lines.contract_no 才是真实归属，
 *   采购单头的 contract_no 仅作新建明细时带出的「默认合同」。
 */
Object.assign(App, {
  // ========== 小工具 ==========
  puActionLabel(a) {
    const m = {
      create: this.t('audit_act_create'), update: this.t('audit_act_update'), delete: this.t('audit_act_delete'),
      confirm: this.t('audit_act_confirm'), cancel: this.t('audit_act_cancel'),
      void: this.t('audit_act_void'), load: this.t('audit_act_load'),
    };
    return m[a] || this.auditActionLabel(a);
  },

  // 采购单手动状态：后端以中文原值存储，界面按当前语言展示
  puManualLabel(v) {
    const m = { '已关闭': this.t('pu_manual_closed'), '已取消': this.t('pu_manual_cancelled') };
    return m[v] || v || '';
  },

  puContractStatusBadge(s) {
    return this.docStatusBadge('pu_contract', s);
  },

  // 到货状态徽章（带图形符号，参考模板）
  puDeliveryBadge(s) {
    const m = {
      '未到货': ['○', 'not_arrived', 'st_not_arrived'],
      '部分到货': ['◐', 'partial', 'st_partial'],
      '已到货': ['●', 'posted', 'st_arrived'],
      '无明细': ['–', 'closed', 'st_no_detail'],
      '已关闭': ['■', 'closed', 'po_status_closed'],
      '已取消': ['✕', 'cancelled', 'po_status_cancelled'],
    };
    const it = m[s] || m['未到货'];
    return `<span class="badge ${this.docStatusMeta(it[1]).cls}"><span aria-hidden="true">${it[0]}</span>&nbsp;${this.t(it[2])}</span>`;
  },

  // 采购单状态徽章（草稿 / 已确认）
  puOrderStatusBadge(s) {
    return this.docStatusBadge('pu_order', s);
  },

  // 到货进度条（已到 / 订购）
  puRateBar(recv, qty) {
    const r = Number(recv || 0), q = Number(qty || 0);
    const p = q ? Math.min(100, Math.round(r / q * 100)) : 0;
    return `<span class="pu-rate"><span class="pu-bar" aria-hidden="true"><i style="width:${p}%"></i></span>${this.fmtQty(r)} / ${this.fmtQty(q)}</span>`;
  },

  // 供应商 / 合同 / 物料 下拉与提示数据
  async puLookups() {
    const [suppliers, contracts, materials] = await Promise.all([
      this.api('/api/suppliers/options').catch(() => []),
      this.api('/api/purchase/contracts').catch(() => []),
      this.api('/api/materials').catch(() => []),
    ]);
    return { suppliers, contracts, materials };
  },

  // 供应商下拉：统一取供应商档案（含停用标记）与历史单据里出现的历史值
  puSupplierOptionsHtml(list) {
    return (list || []).map(s => {
      const name = typeof s === 'string' ? s : (s && s.name) || '';
      if (!name) return '';
      const tag = (s && s.status === 'disabled') ? this.t('sup_disabled_tag')
        : (s && s.historical ? this.t('sup_historical_tag') : '');
      return `<option value="${this.docEsc(name)}"${tag ? ` label="${this.docEsc(tag)}"` : ''}></option>`;
    }).join('');
  },

  // ========== 状态 ==========
  puState() {
    if (!this._pu) this._pu = {};
    const s = this._pu;
    if (!s.tab) s.tab = 'orders';
    if (s.view === undefined) s.view = 'list';          // 'list' | 'edit'
    if (s.sel === undefined) s.sel = null;              // { t:'orders'|'contracts', id }
    if (!s.dt) s.dt = 'lines';                          // 详情子页签
    if (s.wide === undefined) s.wide = false;
    if (s.dense === undefined) s.dense = false;
    if (s.kpi === undefined) s.kpi = '';
    if (s.lq === undefined) s.lq = '';
    if (s.lf === undefined) s.lf = '';
    if (!s.ex) s.ex = new Set();
    if (!s.f) s.f = { kw: '', from: '', to: '' };
    if (!this._puDetail) this._puDetail = {};
    if (!this._puList) this._puList = [];
    return s;
  },

  puDetail() {
    const s = this.puState();
    return s.sel ? (this._puDetail[s.sel.t + ':' + s.sel.id] || null) : null;
  },

  // ========== 页面骨架 ==========
  async renderPurchase() {
    const s = this.puState();
    s.view = 'list';
    this.setMain(this.pageWrap(this.icon('cart', 'icon--title') + ' ' + this.t('pu_title'), this.t('pu_desc'), '', this.puSkeleton()));
    const pb = document.querySelector('.page-body');
    if (pb) pb.classList.add('pu-page-body');
    this.puBindEvents();
    this.puRenderTabs();
    this.puRenderToolbar();
    this.puRenderFilters();
    document.getElementById('pu-root').classList.toggle('pu-dense', !!s.dense);
    await this.loadPurchaseList();
    // 进入页面时若有选中的单据，强制重取详情，避免复用上次的快照
    if (s.sel) await this.puOpen(s.sel.t, s.sel.id); else this.puRenderInspector();
  },

  puSkeleton() {
    return `<div id="pu-root" class="data-page">
      <div class="data-toolbar">
        <nav id="pu-tabs" class="pu-viewtabs" role="tablist" aria-label="${this.t('pu_title')}"></nav>
        <div class="pu-toolbar">
          <div id="pu-filters" class="pu-filter-inner"></div>
          <div id="pu-head-actions" class="pu-head-actions"></div>
        </div>
      </div>
      <div id="pu-kpis" class="pu-kpis" role="group" aria-label="${this.t('pu_delivery')}"></div>
      <div class="pu-split" id="pu-split">
        <section class="pu-list">
          <div class="data-scroll" id="pu-scroll"></div>
          <div class="pu-pager" id="pu-pager"></div>
        </section>
        <aside class="pu-insp" id="pu-insp" hidden aria-label="${this.t('pu_view')}"></aside>
      </div>
    </div>`;
  },

  puRenderTabs() {
    const box = document.getElementById('pu-tabs');
    if (!box) return;
    const s = this.puState();
    const map = [['orders', this.t('pu_tab_orders')], ['contracts', this.t('pu_tab_contracts')], ['lines', this.t('pu_tab_lines')]];
    box.innerHTML = map.map(([k, label]) =>
      `<button type="button" class="pu-viewtab" role="tab" id="pu-tab-${k}" aria-selected="${s.tab === k}" data-pu="tab" data-id="${k}">${label}</button>`
    ).join('');
  },

  puRenderToolbar() {
    const box = document.getElementById('pu-head-actions');
    if (!box) return;
    const s = this.puState();
    let html = '';
    if (s.tab === 'orders' && this.can('purchase', 'manage'))
      html = `<button class="btn btn-primary" data-pu="n-order">+ ${this.t('pu_new_order')}</button>`;
    else if (s.tab === 'contracts' && this.can('purchase', 'manage'))
      html = `<button class="btn btn-primary" data-pu="n-contract">+ ${this.t('pu_new_contract')}</button>`;
    box.innerHTML = html;
  },

  puRenderFilters() {
    const box = document.getElementById('pu-filters');
    if (!box) return;
    const s = this.puState();
    const ph = s.tab === 'lines' ? this.t('pu_lines_filter_ph')
      : s.tab === 'contracts' ? this.t('pu_contract_filter_ph') : this.t('pu_filter_ph');
    let html = `<div class="pu-search" role="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="pu_f_kw" type="search" value="${this.docEsc(s.f.kw)}" placeholder="${ph}" aria-label="${ph}">
      </div>`;
    if (s.tab !== 'contracts') {
      html += `<div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="pu_f_from">${this.t('pu_date')}</label>
        <input id="pu_f_from" type="date" value="${this.docEsc(s.f.from)}" aria-label="${this.t('pu_date')}">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="pu_f_to" type="date" value="${this.docEsc(s.f.to)}" aria-label="${this.t('pu_date')}">
      </div>`;
    }
    html += `<button type="button" class="btn btn-outline btn-sm" data-pu="clr">${this.t('pu_clear_filter')}</button>
      <button type="button" class="btn btn-outline btn-sm" id="pu-dense-btn" aria-pressed="${!!s.dense}" data-pu="dense">${this.t('pu_dense')}</button>`;
    box.innerHTML = html;
  },

  switchPurchaseTab(tab) {
    const s = this.puState();
    if (s.tab === tab) return;
    s.tab = tab; s.kpi = ''; s.sel = null; s.wide = false;
    const st = this.getTableState('purchase'); st.page = 1; st.sortKey = '';
    this.puRenderTabs();
    this.puRenderToolbar();
    this.puRenderFilters();
    this.loadPurchaseList();
    this.puRenderInspector();
  },

  // ========== 列表 ==========
  async loadPurchaseList() {
    const s = this.puState();
    const p = new URLSearchParams();
    const kw = s.f.kw.trim(), from = s.f.from, to = s.f.to;
    let path = '/api/purchase/';
    if (s.tab === 'orders') {
      path += 'orders';
      if (kw) p.set('keyword', kw);
      if (from) p.set('dateFrom', from); if (to) p.set('dateTo', to);
    } else if (s.tab === 'contracts') {
      path += 'contracts';
      if (kw) p.set('keyword', kw);
    } else {
      path += 'lines';
      if (kw) p.set('keyword', kw);
      if (from) p.set('dateFrom', from); if (to) p.set('dateTo', to);
    }
    const qs = p.toString();
    try {
      this._puList = await this.api(path + (qs ? '?' + qs : ''));
    } catch (e) {
      this._puList = [];
      const scroll = document.getElementById('pu-scroll');
      if (scroll) scroll.innerHTML = `<div class="pu-empty">${this.docEsc(e.message)}</div>`;
      const pg = document.getElementById('pu-pager'); if (pg) pg.innerHTML = '';
      const kp = document.getElementById('pu-kpis'); if (kp) kp.innerHTML = '';
      return;
    }
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['purchase'] = () => this.puRenderList();
    this.puRenderList();
    this.markFresh('purchase');
  },

  // KPI 状态定义：[key, label, 计数判定]
  puKpiDefs() {
    const s = this.puState();
    if (s.tab === 'contracts') {
      return [
        ['', this.t('all'), r => true],
        ['active', this.t('pu_status_active'), r => !r.status || r.status === 'active'],
        ['closed', this.t('pu_status_closed_c'), r => r.status === 'closed'],
      ];
    }
    return [
      ['', this.t('all'), r => true],
      ['未到货', this.t('st_not_arrived'), r => this.puRowStatus(r) === '未到货'],
      ['部分到货', this.t('st_partial'), r => this.puRowStatus(r) === '部分到货'],
      ['已到货', this.t('st_arrived'), r => this.puRowStatus(r) === '已到货'],
      ['od', this.t('pu_overdue_only'), r => Number(r.overdue_days || 0) > 0],
    ];
  },

  puRowStatus(r) { return r.delivery_status || r.line_status || ''; },

  puVisibleRows() {
    const s = this.puState();
    const def = this.puKpiDefs().find(d => d[0] === s.kpi);
    return def ? this._puList.filter(def[2]) : this._puList;
  },

  puRenderList() {
    const s = this.puState();
    const kp = document.getElementById('pu-kpis');
    if (kp) {
      kp.innerHTML = this.puKpiDefs().map(([k, label, fn]) =>
        `<button type="button" class="pu-kpi${k === 'od' ? ' warn' : ''}" aria-pressed="${s.kpi === k}" data-pu="kpi" data-id="${k}"><small>${label}</small><strong>${this._puList.filter(fn).length}</strong></button>`
      ).join('');
    }
    const rows = this.puVisibleRows();
    const st = this.getTableState('purchase');
    const sorted = this.sortData(rows, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const scroll = document.getElementById('pu-scroll');
    if (scroll) {
      scroll.innerHTML = sorted.length
        ? this.puListTable(pageData)
        : `<div class="pu-empty">${this.t('pu_no_result')}<br><span class="pu-mu">${this.puHasFilter() ? this.t('pu_no_result_hint') : this.t('pu_empty_hint')}</span></div>`;
    }
    this.puRenderPager(sorted);
    this.pinPager('pu-pager');
  },

  puHasFilter() { const s = this.puState(); return !!(s.f.kw || s.f.from || s.f.to || s.kpi); },

  puListTable(pageData) {
    const s = this.puState();
    // 金额/到货率列：以接口是否下发对应字段为准（空列表时退回角色判断，避免表头闪变）
    const vp = pageData.length > 0 ? this.hasField(pageData[0], 'order_amount') : this.canViewPrice();
    const showContractAmount = pageData.length > 0 ? this.hasField(pageData[0], 'amount') : this.canViewPrice();
    const showRate = pageData.length > 0 ? this.hasField(pageData[0], 'receive_rate') : this.canViewPrice();
    const tid = 'purchase';
    let cols;
    if (s.tab === 'orders') {
      cols = [
        ['po_no', this.t('pu_po_no_filter'), r => `<button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.docEsc(r.po_no)}">${this.docEsc(r.po_no)}</button>`],
        ['status', this.t('pu_order_status'), r => this.puOrderStatusBadge(r.status), 'center'],
        ['date', this.t('pu_date'), r => this.fmtDocDate(r.date, r.created_at, r.confirmed_at)],
        ['supplier', this.t('pu_supplier'), r => this.docEsc(r.supplier || '')],
        ['contract_display', this.t('pu_contract_filter'), r => this.puContractLinks(r.contract_nos)],
        ['line_count', this.t('pu_line_count'), r => r.line_count, true],
        ['received_qty', this.t('pu_progress'), r => this.puRateBar(r.received_qty, r.order_qty)],
        ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
        ['delivery_status', this.t('pu_delivery'), r => this.puDeliveryBadge(r.delivery_status), 'center'],
        ['overdue_days', this.t('pu_overdue'), r => r.overdue_days || '', true],
        ['expected_date', this.t('pu_expected'), r => this.fmtDate(r.expected_date)],
      ];
    } else if (s.tab === 'contracts') {
      cols = [
        ['contract_no', this.t('pu_contract_no'), r => `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.docEsc(r.contract_no)}">${this.docEsc(r.contract_no)}</button>`],
        ['name', this.t('pu_contract_name'), r => this.docEsc(r.name || '')],
        ['supplier', this.t('pu_supplier'), r => this.docEsc(r.supplier || '')],
        ['sign_date', this.t('pu_sign_date'), r => this.fmtDate(r.sign_date)],
        ['amount', this.t('pu_contract_amount'), r => this.fmtMoney(r.amount), true, showContractAmount],
        ['po_count', this.t('pu_po_count'), r => r.po_count, true],
        ['line_count', this.t('pu_line_count'), r => r.line_count, true],
        ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
        ['receive_rate', this.t('pu_receive_rate'), r => r.receive_rate + '%', true, showRate],
        ['status', this.t('pu_status'), r => this.puContractStatusBadge(r.status), 'center'],
      ];
    } else {
      cols = [
        ['po_no', this.t('pu_po_no_filter'), r => `<button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.docEsc(r.po_no)}">${this.docEsc(r.po_no)}</button>`],
        ['code', this.t('pu_material'), r => `${this.docEsc(r.code)} ${this.docEsc(r.material_name || '')}<br><span class="pu-mu">${this.docEsc(r.material_spec || '')}</span>`],
        ['contract_no_eff', this.t('pu_contract_filter'), r => r.contract_no_eff ? `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.docEsc(r.contract_no_eff)}">${this.docEsc(r.contract_no_eff)}</button>` : '<span class="pu-mu">–</span>'],
        ['received_qty', this.t('pu_progress'), r => this.puRateBar(r.received_qty, r.order_qty)],
        ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
        ['line_status', this.t('pu_line_status'), r => this.puDeliveryBadge(r.line_status), 'center'],
        ['overdue_days', this.t('pu_overdue'), r => r.overdue_days || '', true],
      ];
    }
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const sid = this.puRowIdKey();
    const body = pageData.map(r => {
      const on = this.puIsSelected(r);
      return `<tr class="pu-row${on ? ' sel' : ''}" data-ra="${s.tab === 'lines' ? 'orders' : s.tab}" data-id="${this.docEsc(r[sid])}">` +
        shown.map(c => `<td class="${this.colAlignClass(c[3])}">${c[2] ? c[2](r) : this.docEsc(r[c[0]] == null ? '' : r[c[0]])}</td>`).join('') +
        '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  // 行主键 + 是否选中
  puRowIdKey() {
    const s = this.puState();
    return s.tab === 'contracts' ? 'contract_no' : s.tab === 'lines' ? 'po_no' : 'po_no';
  },

  puIsSelected(r) {
    const s = this.puState();
    if (!s.sel) return false;
    const t = s.tab === 'lines' ? 'orders' : s.tab;
    if (s.sel.t !== t) return false;
    return s.sel.id === (t === 'contracts' ? r.contract_no : r.po_no);
  },

  puContractLinks(list) {
    if (!list || !list.length) return '<span class="pu-mu">–</span>';
    return list.map(c => `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.docEsc(c)}">${this.docEsc(c)}</button>`).join('、');
  },

  puRenderPager(rows) {
    const box = document.getElementById('pu-pager');
    if (!box) return;
    const s = this.puState();
    const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    // 明细单位不统一，数量求和没有意义 → 底部只统计单据/行数等「计数」，金额仅在有权查看时汇总
    let tot;
    if (s.tab === 'orders')
      tot = this.t('pu_sum_orders', { n: rows.length })
        + (rows.length && this.hasField(rows[0], 'order_amount') ? ` · ${this.t('pu_order_amount')} ${this.fmtMoney(sum('order_amount'))}` : '');
    else if (s.tab === 'contracts')
      tot = `${this.t('pu_sum_contracts', { n: rows.length })} · ${this.t('pu_po_count')} ${sum('po_count')} · ${this.t('pu_line_count')} ${sum('line_count')}`
        + (rows.length && this.hasField(rows[0], 'order_amount') ? ` · ${this.t('pu_order_amount')} ${this.fmtMoney(sum('order_amount'))}` : '');
    else
      tot = `${this.t('pu_sum_lines', { n: rows.length })} · ${this.t('pu_sum_pending', { n: rows.filter(r => this.puRowStatus(r) !== '已到货').length })}`;
    box.innerHTML = this.puPagerHtml('purchase', rows.length, tot, { ns: 'pu', hideEmpty: true });
  },

  // ========== 详情栏 ==========
  async puOpen(t, id) {
    const s = this.puState();
    s.sel = { t, id };
    s.dt = 'lines'; s.lq = ''; s.lf = ''; s.ex = new Set();
    this.puRenderList();
    this.puRenderInspector();
    const key = t + ':' + id;
    try {
      const base = t === 'contracts' ? '/api/purchase/contracts/' : '/api/purchase/orders/';
      const d = await this.api(base + encodeURIComponent(id));
      // 关联单据（单据级）随详情一次性返回，不再单独拉行级明细，避免 N+1
      this._puDetail[key] = { d, loading: false };
    } catch (e) {
      this._puDetail[key] = { error: e.message };
    }
    if (this.puState().sel && this.puState().sel.t === t && this.puState().sel.id === id) this.puRenderInspector();
  },

  async puCloseInspector() {
    const s = this.puState();
    const prev = s.sel;
    s.sel = null; s.wide = false;
    if (this.isStale('purchase')) {
      // 详情栏开着期间发生过写操作：关闭前补拉一次列表，避免回到旧数据
      await this.loadPurchaseList();
    } else {
      this.puRenderList();
    }
    this.puRenderInspector();
    if (prev) {
      const el = document.querySelector(`#pu-scroll [data-pu="open"][data-id="${CSS.escape(String(prev.id))}"]`);
      if (el) el.focus();
    }
  },

  puToggleWide() {
    const s = this.puState();
    s.wide = !s.wide;
    this.puRenderInspector();
  },

  puRenderInspector() {
    const s = this.puState();
    const box = document.getElementById('pu-insp');
    const split = document.getElementById('pu-split');
    if (!box || !split) return;
    if (!s.sel) {
      box.hidden = true; box.innerHTML = '';
      split.classList.remove('open', 'wide');
      return;
    }
    box.hidden = false;
    split.classList.add('open');
    split.classList.toggle('wide', s.wide);
    const rec = this.puDetail();
    if (!rec || rec.loading) { box.innerHTML = `<div class="pu-empty">${this.t('loading')}</div>`; return; }
    if (rec.error) { box.innerHTML = `<div class="pu-empty">${this.docEsc(rec.error)}</div>`; return; }
    const d = rec.d;
    const isPo = s.sel.t === 'orders';
    const id = isPo ? d.po_no : d.contract_no;
    const lines = d.lines || [];
    const ors = d.orders || [];
    // 关联单据已按入库单头聚合（含草稿/已作废），按 txn_type 分到入库单/退货单两个页签
    const relInb = Array.isArray(d.related_inbound_docs) ? d.related_inbound_docs : [];
    const relRet = Array.isArray(d.related_return_docs) ? d.related_return_docs : [];
    const logs = d.logs || [];
    if (!['lines', 'orders', 'inbound', 'returns', 'logs'].includes(s.dt)) s.dt = 'lines';
    if (!isPo && s.dt === 'orders' && !ors.length) s.dt = 'lines';
    if (isPo && s.dt === 'orders') s.dt = 'lines';

    const sum = (k) => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
    const q = sum('order_qty'), r = sum('received_qty');
    const p = q ? Math.min(100, Math.round(r / q * 100)) : 0;
    const amt = lines.reduce((a, l) => a + Number(l.order_amount || 0), 0);

    const meta = isPo
      ? [[this.t('pu_supplier'), d.supplier || '–'], [this.t('pu_date'), this.fmtDocDate(d.date, d.created_at) || '–'],
         [this.t('pu_project'), d.project || '–'], [this.t('pu_expected'), this.fmtDate(d.expected_date) || '–'],
         [this.t('pu_contract_default'), d.contract_no || '–'], [this.t('pu_manual_status'), this.puManualLabel(d.manual_status) || '–']]
      : [[this.t('pu_contract_name'), d.name || '–'], [this.t('pu_supplier'), d.supplier || '–'],
         [this.t('pu_sign_date'), this.fmtDate(d.sign_date) || '–'],
         [this.t('pu_contract_amount'), this.hasField(d, 'amount') ? this.fmtMoney(d.amount) : '–']];

    const tabs = isPo
      ? [['lines', this.t('pu_tab_detail_lines'), lines.length], ['inbound', this.t('pu_tab_inbound'), relInb.length],
         ['returns', this.t('pu_tab_returns'), relRet.length], ['logs', this.t('pu_tab_logs'), logs.length]]
      : [['lines', this.t('pu_tab_detail_lines'), lines.length], ['orders', this.t('pu_detail_orders'), ors.length],
         ['inbound', this.t('pu_tab_inbound'), relInb.length], ['returns', this.t('pu_tab_returns'), relRet.length],
         ['logs', this.t('pu_tab_logs'), logs.length]];

    // 草稿编辑走 manage，已确认单的再次编辑走 modify；两者互不复用
    const canEditDoc = isPo
      ? (d.status === 'draft' ? this.can('purchase', 'manage') : this.can('purchase', 'modify'))
      : this.can('purchase', 'manage');

    let foot = '';
    // 明细新增属于修改已有单据：草稿 manage / 已确认 modify
    if (isPo && canEditDoc) foot += `<button class="btn btn-primary" data-pu="n-line">+ ${this.t('pu_add_line')}</button>`;
    // 收货：直接建一张采购入库单并带出未到货明细（数量留空待填写）
    if (this.can('inbound', 'manage') && lines.some(l => Number(l.unreceived_qty) > 0)) {
      foot += `<button class="btn btn-primary" data-pu="receive">${this.t('pu_receive')}</button>`;
    }
    // 只读输出（打印/导出）排在写操作之前；删除作为高危操作固定在最右
    foot += `<button class="btn btn-outline" data-pu="print">${this.t('doc_print')}</button>`;
    foot += `<button class="btn btn-outline" data-pu="export">${this.t('doc_export')}</button>`;
    if (isPo && d.status === 'draft' && this.can('purchase', 'manage')) {
      foot += `<button class="btn btn-outline" data-pu="e-entity">${this.t('edit')}</button>`;
    }
    if (isPo && d.status !== 'draft' && this.can('purchase', 'modify')) {
      foot += `<button class="btn btn-outline" data-pu="e-entity">${this.t('pu_modify')}</button>`;
    }
    if (!isPo && this.can('purchase', 'manage')) {
      foot += `<button class="btn btn-outline" data-pu="e-entity">${this.t('edit')}</button>`;
    }
    // 过账是独立动作：详情页直接确认草稿单，只有 post 权限可见
    if (isPo && d.status === 'draft' && this.can('purchase', 'post')) {
      foot += `<button class="btn btn-primary" data-pu="p-confirm">${this.t('pu_confirm_order')}</button>`;
    }
    // 整单删除只对草稿开放：已确认（过账）的采购单不显示删除入口
    if (isPo && d.status === 'draft' && this.can('purchase', 'delete')) {
      foot += `<button class="btn btn-danger" data-pu="d-entity">${this.t('delete')}</button>`;
    }

    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" data-pu="icl">← ${this.t('pu_back_list')}</button>
      <div class="pu-insp-head">
        <div>
          <small>${isPo ? this.t('pu_tab_orders') : this.t('pu_tab_contracts')}</small>
          <h2>${this.docEsc(id)}</h2>
          ${isPo ? `<span class="pu-badge">${this.puOrderStatusBadge(d.status)}${this.puDeliveryBadge((d.summary || {}).delivery_status)}</span>` : this.puContractStatusBadge(d.status)}
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" data-pu="wide" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}">${this.icon(s.wide ? 'restore' : 'maximize', 'icon--tool')}</button>
          <button type="button" class="btn btn-outline btn-sm" data-pu="icl" title="${this.t('pu_close_detail')}" aria-label="${this.t('pu_close_detail')}">${this.icon('close', 'icon--tool')}</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${m[0]}</dt><dd>${this.docEsc(m[1])}</dd></div>`).join('')}</dl>
      <div class="pu-prog-wrap">
        <div class="pu-rate-row"><strong>${this.t('pu_progress')} ${p}%</strong><span class="pu-mu">${this.fmtQty(r)} / ${this.fmtQty(q)}${lines.length && this.hasField(lines[0], 'order_amount') ? ' · ' + this.fmtMoney(amt) : ''}</span></div>
        <div class="pu-prog" role="progressbar" aria-label="${this.t('pu_progress')}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>
      </div>
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" data-pu="dt" data-id="${k}">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="pu-dpanel"></div>
      <div class="pu-insp-foot">${foot}</div>`;
    this.puRenderDetailPanel();
    this.pinPager('pu-pager');
  },

  puRenderDetailPanel() {
    const box = document.getElementById('pu-dpanel');
    if (!box) return;
    const s = this.puState();
    const rec = this.puDetail();
    if (!rec || !rec.d) { box.innerHTML = ''; return; }
    const d = rec.d;
    if (s.dt === 'lines') return this.puRenderLinesBody();
    if (s.dt === 'orders') { box.innerHTML = this.puOrdersPanel(d.orders || []); return; }
    if (s.dt === 'inbound') {
      box.innerHTML = this.puRelatedDocsPanel(d.related_inbound_docs, this.t('pu_no_inbound'), 'inb');
      return;
    }
    if (s.dt === 'returns') {
      box.innerHTML = this.puRelatedDocsPanel(d.related_return_docs, this.t('pu_no_returns'), 'ret');
      return;
    }
    box.innerHTML = this.puLogsPanel(d.logs || []);
  },

  // 采购单/合同的关联单据列表：复用详情页统一的一行式渲染器（不退回卡片/表格）
  puRelatedDocsPanel(rows, emptyText, kind) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<div class="pu-empty">${emptyText}</div>`;
    // 数字口径：只算属于本采购单/合同的明细行；单据因单头归属入列但无对应明细行时
    // 数量金额为 0，照列并标注，隐藏或伪造数字都不允许。
    const isContract = this.puState().sel.t === 'contracts';
    return `<div class="rel-list">${list.map(r => this.relatedDocItemHtml({
      doc: r,
      typeLabel: this.ibTypeLabel(r.txn_type),
      statusBadge: this.ibdStatusBadge(r.status),
      party: [r.supplier, r.handler].filter(Boolean).join(' · '),
      qty: r.total_qty,
      amount: r.total_amount,
      note: Number(r.line_count) === 0
        ? this.t(isContract ? 'rel_no_scope_contract' : 'rel_no_scope_po')
        : null,
      onClick: kind === 'ret'
        ? `App.openReturnDoc('${this.docEsc(r.doc_no)}')`
        : `App.puOpenInbound('${this.docEsc(r.doc_no)}')`,
    })).join('')}</div>`;
  },

  // --- 明细：手风琴（宽屏时切换为全表） ---
  puRenderLinesBody() {
    const s = this.puState();
    const rec = this.puDetail();
    const body = document.getElementById('pu-dpanel');
    if (!body || !rec || !rec.d) return;
    if (s.dt !== 'lines') return;
    this.docLinesBind('purchase', () => { const s = this.puState(); s.dt = 'lines'; s.wide = true; this.puRenderInspector(); });
    const isPo = s.sel.t === 'orders';
    const lines = rec.d.lines || [];
    // 详情内改明细：草稿 manage / 已确认 modify；到货行与最后一行不给移除入口
    const canEditDoc = isPo
      ? (rec.d.status === 'draft' ? this.can('purchase', 'manage') : this.can('purchase', 'modify'))
      : this.can('purchase', 'manage');
    // 采购已确认单至少保留一行，合同不受此限制；到货行一律不给移除入口
    const canRemoveLine = canEditDoc && (!isPo || rec.d.status === 'draft' || lines.length > 1);
    if (s.wide) {
      this._tableRenderers['purchase_detail_lines'] = () => this.puRenderLinesBody();
      body.innerHTML = `<div id="pu-lines-body">${this.puDetailLinesTable(lines)}</div>`;
      return;
    }
    const f = lines.filter(l => this.matchKeywords([l.code, l.material_name, l.material_spec, l.remarks, l.po_no, l.contract_no_eff], s.lq)
      && (!s.lf || (s.lf === 'od' ? Number(l.overdue_days || 0) > 0 : l.line_status !== '已到货')));
    const nOpen = lines.filter(l => l.line_status !== '已到货').length;
    const nOd = lines.filter(l => Number(l.overdue_days || 0) > 0).length;
    const shown = this.docLinesShown('purchase', f.length);
    let html = `<div class="pu-lqtoolbar">
      <input id="pu_lqi" type="search" value="${this.docEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}">
      <div class="pu-chips" role="group">${[['', this.t('all'), lines.length], ['open', this.t('pu_unfinished'), nOpen], ['od', this.t('pu_overdue_only'), nOd]]
        .map(([k, label, n]) => `<button type="button" class="pu-chip" aria-pressed="${s.lf === k}" data-pu="lf" data-id="${k}">${label} ${n}</button>`).join('')}</div>
    </div>`;
    if (!lines.length) {
      html += `<div class="pu-empty">${isPo ? this.t('pu_add_first_line') : this.t('pu_no_lines')}</div>`;
      body.innerHTML = html; return;
    }
    html += `<p class="pu-cnt">${this.t('pu_shown_count', { shown, total: f.length })}</p>`;
    if (!f.length) {
      html += `<div class="pu-empty">${this.t('pu_no_lines')}</div>`;
      body.innerHTML = html; return;
    }
    html += `<ul class="pu-lines">` + f.slice(0, shown).map(l => {
      const ex = s.ex.has(String(l.id));
      const p = Number(l.order_qty) ? Math.min(100, Math.round(Number(l.received_qty) / Number(l.order_qty) * 100)) : 0;
      const od = Number(l.overdue_days || 0);
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" data-pu="ex" data-id="${l.id}" aria-expanded="${ex}">
          ${od ? `<span class="pu-odm" title="${this.t('pu_overdue')} ${od}"><span aria-hidden="true">${this.icon('alert')}</span><span class="sr-only">${this.t('pu_overdue')} ${od}</span></span>` : ''}
          <span class="pu-line-n"><strong>${this.docEsc(l.code)}</strong> ${this.docEsc(l.material_name || '')} <span class="pu-mu">${this.docEsc(l.material_spec || '')}</span></span>
          <span class="pu-line-q">${this.fmtQty(l.received_qty)}/${this.fmtQty(l.order_qty)}${l.material_unit ? ' ' + this.docEsc(l.material_unit) : ''}</span>
          ${this.puDeliveryBadge(l.line_status)}
        </button>
        <div class="pu-line-bar" aria-hidden="true"><i style="width:${p}%"></i></div>
        ${ex ? `<div class="pu-line-d">
          <div class="pu-mu">${this.hasField(l, 'order_price') ? `${this.t('pu_order_price')} ${this.fmtMoney(l.order_price)}/${this.docEsc(l.material_unit || '')} · ${this.t('pu_order_amount')} ${this.fmtMoney(l.order_amount)} · ` : ''}${isPo ? (l.contract_no_eff ? `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.docEsc(l.contract_no_eff)}">${this.docEsc(l.contract_no_eff)}</button>` : this.t('pu_no_contract')) : `<button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.docEsc(l.po_no)}">${this.docEsc(l.po_no)}</button>`}${od ? ` · ${this.t('pu_overdue')} ${od}` : ''}</div>
          ${l.remarks ? `<div>${this.t('pu_remarks')}：${this.docEsc(l.remarks)}</div>` : ''}
          <div class="pu-line-acts">
            <button type="button" class="pu-lk" data-pu="hist" data-id="${l.id}">${this.t('pu_history')}</button>
            ${canEditDoc ? `<button type="button" class="pu-lk" data-pu="e-line" data-id="${l.id}">${this.t('edit')}</button>` : ''}
            ${canRemoveLine && Number(l.received_qty || 0) <= 0
              ? `<button type="button" class="pu-lk danger" data-pu="d-line" data-id="${l.id}">${this.t('in_remove_row')}</button>` : ''}
          </div>
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    html += this.docLinesToggleHtml('purchase', f.length);
    body.innerHTML = html;
  },

  puDetailLinesTable(lines) {
    const s = this.puState();
    const vp = lines.length > 0 && this.hasField(lines[0], 'order_price');
    const isPo = s.sel.t === 'orders';
    const cols = [
      ['code', this.t('pu_code'), r => this.docEsc(r.code)],
      ['material_name', this.t('pu_material'), r => this.docEsc(r.material_name || '')],
      ['material_spec', this.t('pu_spec'), r => this.docEsc(r.material_spec || '')],
      ['order_qty', this.t('pu_order_qty'), r => this.qtyWithUnit(r.order_qty, r.material_unit), true],
      ['order_price', this.t('pu_order_price'), r => this.fmtMoney(r.order_price), true, vp],
      ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
      ['received_qty', this.t('pu_progress'), r => this.puRateBar(r.received_qty, r.order_qty)],
      ['unreceived_qty', this.t('pu_unreceived_qty'), r => this.qtyWithUnit(r.unreceived_qty, r.material_unit), true],
      ['line_status', this.t('pu_line_status'), r => this.puDeliveryBadge(r.line_status)],
      [isPo ? 'contract_no_eff' : 'po_no', isPo ? this.t('pu_contract_filter') : this.t('pu_po_no_filter'),
        r => this.docEsc((isPo ? r.contract_no_eff : r.po_no) || '')],
      ['remarks', this.t('pu_remarks'), r => this.docEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const st = this.getTableState('purchase_detail_lines');
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const th = shown.map(c => this.sortTh(c[1], c[0], 'purchase_detail_lines', c[3])).join('');
    const body = sorted.map(r => `<tr>` + shown.map(c => `<td class="${this.colAlignClass(c[3])}">${c[2](r)}</td>`).join('') + '</tr>').join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body || this.emptyRow(shown.length, this.t('noData'), { pad: 24 })}</tbody></table></div>`;
  },

  // --- 采购单清单（合同详情） ---
  puOrdersPanel(orders) {
    if (!orders.length) return `<div class="pu-empty">${this.t('pu_no_orders_in_contract')}</div>`;
    return `<ul class="pu-items">` + orders.map(o => `<li class="pu-item">
      <div class="pu-item-top">
        <div>
          <button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.docEsc(o.po_no)}">${this.docEsc(o.po_no)}</button>
          <div class="pu-log-meta">${this.fmtDocDate(o.date, o.created_at)} · ${this.docEsc(o.supplier || '')}${o.project ? ' · ' + this.docEsc(o.project) : ''}</div>
        </div>
      </div>
    </li>`).join('') + '</ul>';
  },

  puLogsPanel(logs) {
    if (!logs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    const detailOf = l => this.logDetailText(l);
    return `<ol class="pu-log">` + logs.map(l => `<li>
      <div>
        <strong>${this.puActionLabel(l.action)}</strong>
        <span class="pu-log-meta">· ${this.docEsc(l.name || l.username || '')} · ${this.fmtDateTime(l.created_at)}</span>
        ${detailOf(l) ? `<div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere">${this.docEsc(detailOf(l))}</div>` : ''}
      </div>
    </li>`).join('') + '</ol>';
  },

  // ========== 事件委托 ==========
  puBindEvents() {
    if (this._puBound) return;
    this._puBound = true;

    document.addEventListener('click', e => {
      if (this.currentPage !== 'purchase') return;
      const el = e.target.closest('[data-pu]');
      if (el) { e.preventDefault(); this.puAction(el.dataset.pu, el.dataset.id, el.dataset.t, el); return; }
      const row = e.target.closest('#pu-root tr[data-ra]');
      if (row && !String(window.getSelection())) this.puAction('open', row.dataset.id, row.dataset.ra, row);
    });

    // 点击详情卡片以外的区域（含左侧菜单栏）→ 自动收起详情栏，返回明细列表
    document.addEventListener('click', e => {
      const s = this.puState();
      if (!s.sel || s.view === 'edit') return;
      const insp = document.getElementById('pu-insp');
      if (!insp || insp.hidden) return;
      if (e.target.closest('#pu-insp, #pu-root tr[data-ra], [data-pu], #modal-overlay, .pu-ov, .toast')) return;
      this.puCloseInspector();
    }, true);

    document.addEventListener('input', e => {
      if (this.currentPage !== 'purchase') return;
      const s = this.puState();
      if (e.target.id === 'pu_f_kw') { s.f.kw = e.target.value; clearTimeout(this._puFilterTimer); this._puFilterTimer = setTimeout(() => this.loadPurchaseList(), 250); }
      else if (e.target.id === 'pu_lqi') {
        s.lq = e.target.value;
        // 组词过程中不重绘：重绘会重建输入框，导致中文输入法组词被打断
        if (e.isComposing || this._puLqComposing) return;
        this.puRenderLinesBody(); this.puFocusEnd('pu_lqi');
      }
      else if (e.target.id === 'pu_mat_kw') { this._puMatKw = e.target.value; this.puRefreshMatOptions(); }
      else if (e.target.id === 'pu_lm_kw') { this._puLmKw = e.target.value; this.puRefreshLmOptions(); }
    });

    // 中文输入法：组词结束后再过滤
    document.addEventListener('compositionstart', e => {
      if (e.target.id === 'pu_lqi') this._puLqComposing = true;
    });
    document.addEventListener('compositionend', e => {
      if (e.target.id !== 'pu_lqi') return;
      this._puLqComposing = false;
      if (this.currentPage !== 'purchase') return;
      this.puState().lq = e.target.value;
      this.puRenderLinesBody(); this.puFocusEnd('pu_lqi');
    });

    document.addEventListener('change', e => {
      if (this.currentPage !== 'purchase') return;
      const s = this.puState();
      if (e.target.id === 'pu_f_from') { s.f.from = e.target.value; this.getTableState('purchase').page = 1; this.loadPurchaseList(); }
      else if (e.target.id === 'pu_f_to') { s.f.to = e.target.value; this.getTableState('purchase').page = 1; this.loadPurchaseList(); }
      else if (e.target.id === 'pu-psz') { const st = this.getTableState('purchase'); st.pageSize = this.normalizePageSize(e.target.value); st.page = 1; this.puRenderList(); }
      else if (e.target.id === 'pu_mat_cat') { this._puMatCat = e.target.value; this.puRefreshMatOptions(); }
      else if (e.target.id === 'pu_lm_cat') { this._puLmCat = e.target.value; this.puRefreshLmOptions(); }
    });

    document.addEventListener('keydown', e => {
      if (this.currentPage !== 'purchase') return;
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === '/' && !inField && document.getElementById('pu_f_kw')) { e.preventDefault(); document.getElementById('pu_f_kw').focus(); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest && e.target.matches('#pu-scroll .pu-lk')) {
        const links = [...document.querySelectorAll('#pu-scroll .pu-lk')];
        const i = links.indexOf(e.target);
        const n = links[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (n) { e.preventDefault(); n.focus(); }
        return;
      }
      if (e.key === 'Escape') {
        if (document.getElementById('modal-overlay')) { this.closeModal(); return; }
        const ov = document.querySelector('.pu-ov');
        if (ov) { ov.remove(); return; }
        if (this.puState().sel) this.puCloseInspector();
      }
    });

    // 视口尺寸变化时重算分页条是否需要吸附
    window.addEventListener('resize', () => {
      if (this.currentPage === 'purchase') this.pinPager('pu-pager');
    });
  },

  puFocusEnd(id) {
    const el = document.getElementById(id);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (_) {} }
  },

  puAction(name, id, t, el) {
    const s = this.puState();
    switch (name) {
      case 'tab': return this.switchPurchaseTab(id);
      case 'open': return this.puOpen(t || 'orders', id);
      case 'icl': return this.puCloseInspector();
      case 'wide': return this.puToggleWide();
      case 'dt': s.dt = id; this.puRenderInspector(); return;
      case 'kpi': s.kpi = s.kpi === id ? '' : id; this.getTableState('purchase').page = 1; this.puRenderList(); return;
      case 'clr': s.f = { kw: '', from: '', to: '' }; s.kpi = ''; this.getTableState('purchase').page = 1; this.puRenderFilters(); this.loadPurchaseList(); return;
      case 'dense': s.dense = !s.dense; document.getElementById('pu-root').classList.toggle('pu-dense', s.dense); if (el) el.setAttribute('aria-pressed', String(s.dense)); return;
      case 'pg': this.getTableState('purchase').page += Number(id); this.puRenderList(); return;
      case 'lf': s.lf = s.lf === id ? '' : id; this.puRenderLinesBody(); return;
      case 'ex': { const k = String(id); if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k); this.puRenderLinesBody(); return; }
      case 'hist': return this.showLineInbound(Number(id));
      case 'n-order': return this.puNewOrderPage();
      case 'n-contract': return this.editContract();
      case 'n-line': return this.addPurchaseLine(s.sel.id);
      case 'receive': return this.puReceive();
      case 'e-entity': return s.sel.t === 'contracts' ? this.editContract(s.sel.id) : this.puEditOrderPage(s.sel.id);
      case 'd-entity': return s.sel.t === 'contracts' ? this.deleteContract(s.sel.id) : this.deletePurchaseOrder(s.sel.id);
      case 'p-confirm': return this.puConfirmOrderDirect(s.sel.id);
      case 'e-line': return this.editPurchaseLine(Number(id));
      case 'd-line': return this.deletePurchaseLine(Number(id));
      case 'print': return this.puPrintDoc();
      case 'export': return this.puExportDoc();
    }
  },

  // ========== 单据打印 / 导出（组装通用 doc，细节由 02-ui-kit 统一处理） ==========
  puDocModel() {
    const rec = this.puDetail();
    const s = this.puState();
    if (!rec || !rec.d || !s.sel) return null;
    const d = rec.d;
    const isPo = s.sel.t === 'orders';
    const lines = d.lines || [];
    const vp = lines.length > 0 && this.hasField(lines[0], 'order_price');
    const cols = [
      { label: this.t('pu_code'), key: 'code' },
      { label: this.t('pu_material'), key: 'material_name' },
      { label: this.t('pu_spec'), key: 'material_spec' },
      { label: this.t('pu_order_qty'), align: 'right', value: r => this.qtyUnitText(r.order_qty, r.material_unit) },
      { label: this.t('pu_received_qty'), align: 'right', value: r => this.qtyUnitText(r.received_qty, r.material_unit) },
    ];
    if (vp) {
      cols.push({ label: this.t('pu_order_price'), align: 'right', value: r => this.fmtMoney(r.order_price) });
      cols.push({ label: this.t('pu_order_amount'), align: 'right', value: r => this.fmtMoney(r.order_amount) });
    }
    cols.push({ label: this.t('pu_contract_filter'), value: r => r.contract_no_eff || '' });
    cols.push({ label: this.t('pu_remarks'), value: r => r.remarks || '' });
    cols.push({ label: this.t('pu_status'), value: r => r.line_status || '' });

    const sum = k => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
    const meta = isPo
      ? [[this.t('pu_supplier'), d.supplier || ''], [this.t('pu_date'), this.fmtDocDate(d.date, d.created_at)],
         [this.t('pu_project'), d.project || ''], [this.t('pu_expected'), this.fmtDate(d.expected_date)],
         [this.t('pu_contract_default'), d.contract_no || ''], [this.t('pu_manual_status'), this.puManualLabel(d.manual_status)],
         [this.t('pu_line_count'), String(lines.length)],
         [this.t('pu_progress'), `${this.fmtQty(sum('received_qty'))} / ${this.fmtQty(sum('order_qty'))}`]]
      : [[this.t('pu_contract_name'), d.name || ''], [this.t('pu_supplier'), d.supplier || ''],
         [this.t('pu_sign_date'), this.fmtDate(d.sign_date)],
         [this.t('pu_contract_amount'), this.hasField(d, 'amount') ? this.fmtMoney(d.amount) : ''],
         [this.t('pu_line_count'), String(lines.length)]];

    const id = isPo ? d.po_no : d.contract_no;
    return {
      title: id,
      subtitle: isPo ? this.t('pu_tab_orders') : this.t('pu_tab_contracts'),
      meta, columns: cols, rows: lines,
      filename: `${id}_${this.today().replace(/-/g, '')}.csv`,
    };
  },

  puPrintDoc() {
    const doc = this.puDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.printDoc(doc);
  },

  puExportDoc() {
    const doc = this.puDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.exportDocCsv(doc);
    this.toast(this.t('doc_export_done', { name: doc.filename }));
  },

  // 从采购/合同详情的「入库」页签跳到对应入库单
  puOpenInbound(docNo) {
    if (!docNo) return;
    if (!this.can('inbound', 'view')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    return this.openInboundDoc(docNo);
  },

  // ========== 收货：从采购单/合同详情一键生成采购入库单 ==========
  // 自动创建草稿入库单并带出该单据全部「未到货」明细，数量留空，
  // 由用户填写后自行选择「保存草稿」或「确认入库」；数量为空/0 的行不会生成流水。
  async puReceive() {
    const s = this.puState();
    if (!s.sel) return;
    if (!this.can('inbound', 'manage')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const rec = this.puDetail();
    const d = (rec && rec.d) || {};
    const isPo = s.sel.t === 'orders';
    const id = s.sel.id;

    let lines = [];
    try {
      lines = await this.api((isPo ? '/api/purchase/lines/by-po/' : '/api/purchase/lines/by-contract/') + encodeURIComponent(id));
    } catch (e) { this.toast(e.message, 'error'); return; }
    const pending = (lines || []).filter(l => Number(l.unreceived_qty) > 0);
    if (!pending.length) { this.toast(this.t('pu_no_pending_lines'), 'error'); return; }

    const preload = pending.map(l => ({
      code: l.code,
      contract_no: l.contract_no_eff || '',
      po_no: l.po_no || (isPo ? id : ''),
      // 带上采购行 id，预载后「未到货」/物料锁定/来源回显才有映射；
      // 同一物料出现在多张采购单时必须靠它区分，不能按物料编码回退
      order_line_id: Number(l.id) || 0,
      origin_line_id: 0,
      source_doc_no: '',
      material_name: l.material_name || '',
      material_spec: l.material_spec || '',
      material_brand: l.material_brand || '',
      material_unit: l.material_unit || '',
      qty: '',
      // 没有 price:edit 时不带单价，服务端按采购行单价推导
      ...(this.canEditPrice() ? { price: Number(l.order_price) || 0 } : {}),
      remarks: ''
    }));

    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    try {
      const r = await this.api('/api/inbound-docs', 'POST', {
        date,
        txn_type: '采购入库',
        supplier: d.supplier || '',
        handler: this.user?.name || this.user?.username || '',
        po_no: isPo ? id : '',
        contract_no: isPo ? '' : id,
        remarks: ''
      });
      this.toast(this.t('ibd_created'));
      // 切到「入库」模块视角，进入明细编辑页（同步 hash，避免返回时地址栏与页面脱节）
      await this.gotoPage('inbound', { render: false });
      await this.editInboundDoc(r.doc_no, preload);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // ========== 到货履历（右侧抽屉） ==========
  async showLineInbound(lineId) {
    let d;
    try { d = await this.api('/api/purchase/lines/' + lineId + '/inbound'); }
    catch (e) { this.toast(e.message, 'error'); return; }
    // 履历单价：有履历看首行是否带 price，无履历看行本身是否带 order_price
    const vp = (d.history || []).length > 0 ? this.hasField(d.history[0], 'price') : this.hasField(d.line || {}, 'order_price');
    const l = d.line || {}, sm = d.summary || {};
    const head = `<div class="pu-stat-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px">
      <div class="pu-kpi"><small>${this.t('pu_order_qty')}</small><strong>${this.fmtQty(sm.order_qty)}</strong></div>
      <div class="pu-kpi"><small>${this.t('pu_received_qty')}</small><strong>${this.fmtQty(sm.received_qty)}</strong></div>
      <div class="pu-kpi"><small>${this.t('pu_unreceived_qty')}</small><strong>${this.fmtQty(sm.unreceived_qty)}</strong></div>
    </div>
    <div class="pu-log-meta" style="margin-bottom:12px">${this.docEsc(l.po_no || '')} · ${this.docEsc(l.code || '')} ${this.docEsc(l.material_name || '')} ${this.docEsc(l.material_spec || '')}${l.contract_no_eff ? ' · ' + this.t('pu_contract_filter') + ': ' + this.docEsc(l.contract_no_eff) : ''}</div>`;
    let table;
    if (!(d.history || []).length) {
      table = `<div class="pu-empty">${this.t('pu_hist_empty')}</div>`;
    } else {
      table = `<div class="table-wrap"><table><thead><tr>
        <th>${this.t('pu_hist_inbound_no')}</th><th>${this.t('pu_hist_date')}</th><th class="text-right">${this.t('pu_hist_qty')}</th>
        ${vp ? `<th class="text-right">${this.t('pu_hist_price')}</th><th class="text-right">${this.t('pu_hist_amount')}</th>` : ''}
        <th class="text-right">${this.t('pu_hist_cum')}</th><th>${this.t('pu_hist_supplier')}</th><th>${this.t('pu_hist_handler')}</th>
      </tr></thead><tbody>` +
        d.history.map(r => `<tr>
          <td>${this.docEsc(r.doc_no || r.grn_no || '-')}</td><td>${this.fmtDocDate(r.date, r.doc_created_at, r.doc_confirmed_at)}</td>
          <td class="text-right">${this.fmtQty(r.qty)}</td>
          ${vp ? `<td class="text-right">${this.fmtMoney(r.price)}</td><td class="text-right">${this.fmtMoney(r.amount)}</td>` : ''}
          <td class="text-right"><b>${this.fmtQty(r.cum_qty)}</b></td>
          <td>${this.docEsc(r.supplier || '')}</td><td>${this.docEsc(r.handler || '')}</td>
        </tr>`).join('') +
        `</tbody></table></div>`;
    }
    this.puDrawer(this.t('pu_hist_title'), head + table);
  },

  puDrawer(title, bodyHtml) {
    const ov = document.createElement('div');
    ov.className = 'pu-ov';
    ov.innerHTML = `<div class="pu-drawer" role="dialog" aria-modal="true" aria-label="${this.docEsc(title)}">
      <div class="pu-drawer-h"><h3>${this.docEsc(title)}</h3><button type="button" class="btn btn-outline btn-sm" data-pu="drawer-close" aria-label="${this.t('close')}">${this.icon('close', 'icon--tool')}</button></div>
      <div class="pu-drawer-b">${bodyHtml}</div>
    </div>`;
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    ov.querySelector('[data-pu="drawer-close"]').addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
  },

  // ========== 可撤销删除 ==========
  puToastUndo(msg, undo) {
    const el = document.createElement('div');
    el.className = 'toast toast-success pu-toast-undo';
    el.innerHTML = `<span>${this.docEsc(msg)}</span><button type="button">${this.t('pu_undo')}</button>`;
    document.body.appendChild(el);
    const timer = setTimeout(() => el.remove(), 7000);
    el.querySelector('button').onclick = async () => {
      clearTimeout(timer); el.remove();
      try { await undo(); this.toast(this.t('pu_restored')); }
      catch (e) { this.toast(e.message, 'error'); }
    };
  },

  async puConfirmDelete(title, msg, doDelete, doneMsg) {
    // 删除属破坏性操作：走统一确认弹窗，确认键为红色
    this.confirmDialog(this.docEsc(title),
      `<p style="margin:0">${msg}</p><p class="pu-mu" style="margin:8px 0 0;font-size:12px">${this.t('pu_delete_hint')}</p>`,
      async () => {
        let undo;
        try { undo = await doDelete(); } catch (e) { this.toast(e.message, 'error'); return; }
        this.puToastUndo(doneMsg || title, undo);
      });
  },

  // ========== 采购单增删改（独立编辑页：新建 → 保存草稿 → 确认） ==========

  // 新建采购单：先填表头 → 创建草稿 → 进入明细编辑页（对齐出库 / 入库交互）
  async puNewOrderPage() {
    this.puState().view = 'edit';
    this._puEditPo = null;
    this._puPriceVisible = null;
    this._puEditLines = [];
    this._puEditLookups = await this.puLookups();
    let no = '';
    try { no = (await this.api('/api/purchase/orders/next-no?date=' + this.today())).po_no || ''; } catch (_) {}
    this._puEditDraft = {
      po_no: no, date: this.today(), supplier: '', contract_no: '',
      project: '', expected_date: '', manual_status: '', remarks: '',
    };
    this.puRenderEditPage(true);
  },

  // 整单编辑：加载详情 → 表头 + 明细一起修改 → 保存草稿 / 确认
  async puEditOrderPage(poNo) {
    this.puState().view = 'edit';
    if (this._puEditFilterPo !== poNo) { this._puMatCat = ''; this._puMatKw = ''; this._puEditFilterPo = poNo; }
    let d;
    try { d = await this.api('/api/purchase/orders/' + encodeURIComponent(poNo)); }
    catch (e) { this.toast(e.message, 'error'); return this.puBackToList(); }
    // 入口守卫：草稿要 manage，已确认要 modify，避免仅凭前端隐藏按钮被绕过
    const editOk = d.status === 'draft' ? this.can('purchase', 'manage') : this.can('purchase', 'modify');
    if (!editOk) { this.toast(this.t('no_perm_msg'), 'error'); return this.puBackToList(); }
    this._puEditLookups = await this.puLookups();
    this._puEditPo = d;
    // 明细单价是否下发：有明细看首行字段，新建单没有明细时为 null（退回角色判断）
    this._puPriceVisible = (d.lines || []).length ? this.hasField(d.lines[0], 'order_price') : null;
    this._puEditDraft = {
      po_no: d.po_no, date: d.date || '', supplier: d.supplier || '', contract_no: d.contract_no || '',
      project: d.project || '', expected_date: d.expected_date || '', manual_status: d.manual_status || '', remarks: d.remarks || '',
    };
    this._puEditLines = (d.lines || []).map(l => ({
      id: l.id, code: l.code,
      order_qty: Number(l.order_qty || 0), order_price: Number(l.order_price || 0),
      contract_no: l.contract_no_eff || l.contract_no || '', remarks: l.remarks || '',
      received_qty: Number(l.received_qty || 0), material_unit: l.material_unit || '',
    }));
    this.puRenderEditPage(false);
  },

  puRenderEditPage(isNew) {
    const po = this._puEditDraft || {};
    const status = isNew ? 'draft' : (this._puEditPo?.status || 'posted');
    const badge = this.puOrderStatusBadge(status);
    // 草稿保存走 manage，已确认单保存走 modify；已确认模式不出现确认按钮
    const canEdit = status === 'draft' ? this.can('purchase', 'manage') : this.can('purchase', 'modify');
    const actions = isNew
      ? `<div class="pu-edit-actions">
           <button class="btn btn-outline" onclick="App.puBackToList()">${this.t('cancel')}</button>
           <button class="btn btn-primary" onclick="App.puCreateOrder()">${this.t('pu_create_and_add')}</button>
         </div>`
      : `<div class="pu-edit-actions">
           ${canEdit ? `<button class="btn btn-outline" onclick="App.puEditAddRow()">+ ${this.t('pu_add_line')}</button>
           <button class="btn btn-outline" onclick="App.puSaveOrderDraft()">${this.t(status === 'draft' ? 'pu_save_draft' : 'save')}</button>` : ''}
           ${status === 'draft' && this.can('purchase', 'post') ? `<button class="btn btn-primary" onclick="App.puConfirmOrder()">${this.t('pu_confirm_order')}</button>` : ''}
         </div>`;
    const title = isNew ? this.t('pu_new_order')
      : (status === 'draft' ? this.t('pu_edit_order') : this.t('pu_modify_order')) + ' · ' + this.docEsc(po.po_no);
    const desc = isNew ? this.t('pu_create_hint') : (status === 'posted' ? this.t('pu_edit_posted_hint') : this.t('pu_edit_hint'));
    this.setMain(this.pageWrap(this.icon(isNew ? 'plus' : 'edit', 'icon--title') + ' ' + title, desc, '', `
      <div class="data-page" id="pu-edit-root">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.puBackToList()">← ${this.t('pu_back_list')}</span>
          ${badge}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('pu_section_header')}<small>${isNew ? this.t('pu_next_add_lines_hint') : ''}</small></div></div>
          <div id="pu-edit-form"></div>
        </div>
        ${isNew ? '' : `<div class="pu-card">
          <div class="pu-card-title"><span>02</span><div>${this.t('pu_section_lines')}<small id="pu-edit-line-count"></small></div></div>
          <div id="pu-edit-lines"></div>
        </div>`}
        ${actions}
      </div>`));
    this.puRenderEditForm();
    if (!isNew) this.puRenderEditLines();
  },

  // 表头表单（新建与整单编辑共用）
  puRenderEditForm() {
    const box = document.getElementById('pu-edit-form');
    if (!box) return;
    const po = this._puEditDraft || {};
    const isNew = !this._puEditPo;
    const lk = this._puEditLookups || { suppliers: [], contracts: [] };
    const supList = this.puSupplierOptionsHtml(lk.suppliers);
    const cList = (lk.contracts || []).map(x => `<option value="${this.docEsc(x.contract_no)}"></option>`).join('');
    const msOpts = ['', '已关闭', '已取消'].map(v => `<option value="${v}" ${po.manual_status === v ? 'selected' : ''}>${v ? this.puManualLabel(v) : this.t('pu_manual_none')}</option>`).join('');
    box.innerHTML = `<div class="form-grid" style="max-width:none">
      <div class="form-group"><label>${this.t('pu_po_no_filter')}</label><input id="pu_e_no" value="${this.docEsc(po.po_no || '')}" ${isNew ? `placeholder="${this.t('pu_po_no_manual_ph')}"` : 'readonly'}></div>
      <div class="form-group"><label>${this.t('pu_date')} *</label><input id="pu_e_date" type="date" value="${this.fmtDate(po.date)}"></div>
      <div class="form-group"><label>${this.t('pu_supplier')}</label><input id="pu_e_supplier" list="pu_e_sup" value="${this.docEsc(po.supplier || '')}"><datalist id="pu_e_sup">${supList}</datalist></div>
      <div class="form-group"><label>${this.t('pu_contract_default')}</label><input id="pu_e_contract" list="pu_e_c" value="${this.docEsc(po.contract_no || '')}"><datalist id="pu_e_c">${cList}</datalist></div>
      <div class="form-group"><label>${this.t('pu_project')}</label><input id="pu_e_project" value="${this.docEsc(po.project || '')}"></div>
      <div class="form-group"><label>${this.t('pu_expected')}</label><input id="pu_e_expected" type="date" value="${this.fmtDate(po.expected_date)}"></div>
      <div class="form-group"><label>${this.t('pu_manual_status')}</label><select id="pu_e_manual">${msOpts}</select></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_remarks')}</label><textarea id="pu_e_remarks" rows="2">${this.docEsc(po.remarks || '')}</textarea></div>
    </div>`;
  },

  puReadEditForm() {
    const val = id => document.getElementById(id)?.value.trim() || '';
    return {
      po_no: val('pu_e_no'),
      date: document.getElementById('pu_e_date')?.value || '',
      supplier: val('pu_e_supplier'),
      contract_no: val('pu_e_contract'),
      project: val('pu_e_project'),
      expected_date: document.getElementById('pu_e_expected')?.value || '',
      manual_status: document.getElementById('pu_e_manual')?.value || '',
      remarks: val('pu_e_remarks'),
    };
  },

  // 编辑页单价列是否展示：能看（price:view）或能填（price:edit）都展示，是否可编辑另判
  puEditPriceVisible() {
    return this.canViewPrice() || this.canEditPrice();
  },
  // 单价是否可写：只由 price:edit 决定（新建单与编辑单口径一致）
  puEditPriceEditable() {
    return this.canEditPrice();
  },

  // 明细编辑表格（行内增删改；表头与明细一起保存）
  puRenderEditLines() {
    this.msClose();
    const box = document.getElementById('pu-edit-lines');
    if (!box) return;
    const vp = this.puEditPriceVisible();
    const lines = this._puEditLines || [];
    const status = this._puEditPo?.status || 'draft';
    const canEdit = status === 'draft' ? this.can('purchase', 'manage') : this.can('purchase', 'modify');
    const lk = this._puEditLookups || {};
    const mats = lk.materials || [];
    const cList = (lk.contracts || []).map(c => `<option value="${this.docEsc(c.contract_no)}"></option>`).join('');
    const matOpts = sel => {
      const list = this.puMatFiltered();
      if (sel && !list.some(m => m.code === sel)) {
        const cm = mats.find(m => m.code === sel);
        if (cm) list.unshift(cm);
      }
      return `<option value="">${this.t('please_select')}</option>` + list.map(m =>
        `<option value="${this.docEsc(m.code)}" ${m.code === sel ? 'selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
    };
    const cats = [...new Set(mats.map(m => m.category).filter(Boolean))].sort();
    const catOpts = `<option value="">${this.t('all')}</option>` + cats.map(c =>
      `<option value="${this.docEsc(c)}"${this._puMatCat === c ? ' selected' : ''}>${this.docEsc(c)}</option>`).join('');

    const colCount = vp ? 8 : 6;
    let tbody;
    if (!lines.length) {
      tbody = this.emptyRow(colCount, `
        ${this.t('pu_no_lines')}
        ${canEdit ? `<div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="App.puEditAddRow()">+ ${this.t('pu_add_line')}</button></div>` : ''}
      `, { pad: 26 });
    } else {
      tbody = lines.map((l, i) => {
        const recv = Number(l.received_qty || 0);
        const amt = (Number(l.order_qty) || 0) * (Number(l.order_price) || 0);
        return `<tr>
          <td style="min-width:220px"><select class="pu-line-mat" data-idx="${i}" onchange="App.puEditSet(${i},'code',this.value)">${matOpts(l.code)}</select><div class="line-error-tip" data-pu-tip="${i}"></div></td>
          <td style="min-width:110px"><div class="pu-qty-wrap"><input type="number" class="pu-line-qty" data-idx="${i}" step="0.0001" min="${recv}" value="${l.order_qty || ''}" oninput="App.puEditSet(${i},'order_qty',this.value)">${l.material_unit ? `<span class="pu-qty-unit">${this.docEsc(l.material_unit)}</span>` : ''}</div></td>
          ${vp ? `<td style="min-width:110px">${this.canEditPrice()
            ? `<input type="number" step="0.01" min="0" value="${this.fmtPrice2(l.order_price)}" oninput="App.puEditSet(${i},'order_price',this.value)">`
            : this.fmtMoney(l.order_price)}</td>
          <td class="pu-edit-amt" data-amt="${i}">${this.fmtMoney(amt)}</td>` : ''}
          <td style="min-width:130px"><input list="pu_e_clist" value="${this.docEsc(l.contract_no || '')}" oninput="App.puEditSet(${i},'contract_no',this.value)"></td>
          <td style="min-width:140px"><input value="${this.docEsc(l.remarks || '')}" oninput="App.puEditSet(${i},'remarks',this.value)"></td>
          <td class="pu-edit-amt">${recv > 0 ? this.fmtQty(recv) : '—'}</td>
          <td class="text-center">${canEdit && recv <= 0 && (status === 'draft' || lines.length > 1)
            ? `<button type="button" class="pu-edit-del" onclick="App.puEditRemoveRow(${i})">${this.t('in_remove_row')}</button>` : ''}</td>
        </tr>`;
      }).join('');
    }
    box.innerHTML = `<datalist id="pu_e_clist">${cList}</datalist>
      <div class="pu-matfilter">
        <label>${this.t('mat_category')}<select id="pu_mat_cat">${catOpts}</select></label>
        <span class="pu-msearch-host"><input id="pu_mat_kw" type="search" value="${this.docEsc(this._puMatKw || '')}" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}" oninput="App.puMatKwInput(this)" onfocus="App.puMsOpen(this)" onblur="App.msBlur()" onkeydown="App.msKey(event)" oncompositionstart="App.msCompositionStart()" oncompositionend="App.msCompositionEnd(this)"></span>
        <span class="pu-mu" id="pu_mat_cnt">${this.puMatFiltered().length} / ${mats.length}</span>
      </div>
      <div class="table-wrap"><table class="pu-edit-lines"><thead><tr>
        <th>${this.t('pu_material')}</th><th class="text-right">${this.t('pu_order_qty')}</th>
        ${vp ? `<th class="text-right">${this.t('pu_order_price')}</th><th class="text-right">${this.t('pu_line_amount')}</th>` : ''}
        <th>${this.t('pu_contract_filter')}</th><th>${this.t('pu_remarks')}</th>
        <th class="text-right">${this.t('pu_received_qty')}</th><th class="text-center"></th>
      </tr></thead><tbody>${tbody}</tbody></table></div>
      <div class="pu-edit-sum">
        <span>${this.t('pu_line_count')}: <b id="pu_es_lines">${lines.length}</b></span>
        <span>${this.t('pu_order_qty')}: <b id="pu_es_qty">${this.fmtQty(this.puEditTotalQty())}</b></span>
        ${vp ? `<span>${this.t('pu_order_amount')}: <b id="pu_es_amt">${this.fmtMoney(this.puEditTotalAmount())}</b></span>` : ''}
      </div>`;
    const cnt = document.getElementById('pu-edit-line-count');
    if (cnt) cnt.textContent = lines.length ? ' · ' + lines.length : '';
  },

  // 物料下拉文案：编码 · 名称 规格 · 品牌
  puMatLabel(m) {
    const base = `${this.docEsc(m.code)} · ${this.docEsc(m.name || '')} ${this.docEsc(m.spec || '')}`.trim();
    return m.brand ? `${base} · ${this.docEsc(m.brand)}` : base;
  },

  // 添加明细：物料即时搜索（候选与行内下拉同为全量物料，受类别筛选约束）
  puMatKwInput(el) {
    this._puMatKw = (el && el.value) || '';
    this.puRefreshMatOptions();
    if (!this._ms || this._ms.input !== el) this.puMsOpen(el);
    else this.msInput(el);
  },

  puMsOpen(el) {
    if (this._msSuppressFocus) return;
    this.msOpen(el, {
      mode: 'materials',
      rows: () => (this._puEditLookups || {}).materials || [],
      category: () => this._puMatCat || '',
      isAdded: m => (this._puEditLines || []).some(l => l.code === m.code),
      onPick: m => this.puAddFromSearch(m),
    });
  },

  puAddFromSearch(m) {
    if (!this._puEditLines) this._puEditLines = [];
    this._puMatKw = '';
    const def = document.getElementById('pu_e_contract');
    this._puEditLines.push({
      code: m.code, order_qty: '', order_price: '',
      contract_no: def ? (def.value || '').trim() : '', remarks: '',
    });
    this.puRenderEditLines();
  },

  // 物料筛选：类别（精确）+ 编码/名称/规格/品牌（多关键字模糊）
  puMatFiltered() {
    const mats = (this._puEditLookups || {}).materials || [];
    const cat = this._puMatCat || '';
    return mats.filter(m => {
      if (cat && m.category !== cat) return false;
      if (!this.matchKeywords([m.code, m.name, m.spec, m.brand], this._puMatKw)) return false;
      return true;
    });
  },

  // 筛选变化时就地刷新各行的物料下拉，保留已选值（不重建整张表，避免输入焦点丢失）
  puRefreshMatOptions() {
    const mats = (this._puEditLookups || {}).materials || [];
    const list = this.puMatFiltered();
    const cnt = document.getElementById('pu_mat_cnt');
    if (cnt) cnt.textContent = `${list.length} / ${mats.length}`;
    document.querySelectorAll('#pu-edit-lines select.pu-line-mat').forEach(sel => {
      const cur = sel.value;
      const opts = list.slice();
      if (cur && !opts.some(m => m.code === cur)) {
        const cm = mats.find(m => m.code === cur);
        if (cm) opts.unshift(cm);
      }
      sel.innerHTML = `<option value="">${this.t('please_select')}</option>` + opts.map(m =>
        `<option value="${this.docEsc(m.code)}"${m.code === cur ? ' selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
    });
  },

  puEditTotalQty() { return (this._puEditLines || []).reduce((s, l) => s + (Number(l.order_qty) || 0), 0); },
  puEditTotalAmount() { return (this._puEditLines || []).reduce((s, l) => s + (Number(l.order_qty) || 0) * (Number(l.order_price) || 0), 0); },

  puEditRefreshSummary() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('pu_es_lines', String((this._puEditLines || []).length));
    set('pu_es_qty', this.fmtQty(this.puEditTotalQty()));
    if (this.puEditPriceVisible()) set('pu_es_amt', this.fmtMoney(this.puEditTotalAmount()));
  },

  puEditSet(idx, field, val) {
    const l = (this._puEditLines || [])[idx];
    if (!l) return;
    if (field === 'order_qty' || field === 'order_price') l[field] = parseFloat(val) || 0;
    else l[field] = String(val == null ? '' : val);
    // 换料后单位随物料走：就地更新数量框后的单位后缀（不重建整表，避免打断输入）
    if (field === 'code') {
      const m = ((this._puEditLookups || {}).materials || []).find(x => x.code === l.code);
      l.material_unit = m ? (m.unit || '') : '';
      const sel = document.querySelector(`#pu-edit-lines select.pu-line-mat[data-idx="${idx}"]`);
      const wrap = sel ? sel.closest('tr').querySelector('.pu-qty-wrap') : null;
      if (wrap) {
        const sp = wrap.querySelector('.pu-qty-unit');
        if (!l.material_unit) { if (sp) sp.remove(); }
        else if (sp) sp.textContent = l.material_unit;
        else {
          const n = document.createElement('span');
          n.className = 'pu-qty-unit';
          n.textContent = l.material_unit;
          wrap.appendChild(n);
        }
      }
    }
    if (field === 'order_qty') this.puClearLineErrors();
    if (field === 'order_qty' || field === 'order_price') {
      if (this.puEditPriceVisible()) {
        const cell = document.querySelector(`#pu-edit-lines [data-amt="${idx}"]`);
        if (cell) cell.textContent = this.fmtMoney((Number(l.order_qty) || 0) * (Number(l.order_price) || 0));
      }
      this.puEditRefreshSummary();
    }
  },

  // 行级校验：红框 + 行首提示（与入库编辑页同一套样式），不再只弹整屏 toast
  puClearLineErrors() {
    document.querySelectorAll('#pu-edit-lines .line-error-tip.show').forEach(el => {
      el.classList.remove('show'); el.textContent = '';
    });
    document.querySelectorAll('#pu-edit-lines .pu-line-qty.error').forEach(el => el.classList.remove('error'));
  },

  puShowLineError(idx, msg) {
    this.puClearLineErrors();
    const tip = document.querySelector(`#pu-edit-lines [data-pu-tip="${idx}"]`);
    if (tip) { tip.textContent = msg || ''; tip.classList.add('show'); }
    const inp = document.querySelector(`#pu-edit-lines .pu-line-qty[data-idx="${idx}"]`);
    if (inp) {
      inp.classList.add('error');
      inp.focus();
      if (inp.scrollIntoView) inp.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  },

  // 后端行级错误 → 定位到具体行并给出行号/编码/数量；未命中返回 false 由调用方回退 toast
  puShowLineErrorFromApi(e) {
    const d = (e && e.code === 'PO_QTY_BELOW_RECEIVED' && e.details && e.details[0]) || null;
    if (!d) return false;
    let idx = (this._puEditLines || []).findIndex(l => Number(l.id) === Number(d.line_id));
    if (idx < 0) idx = (this._puEditLines || []).findIndex(l => l.code === d.code);
    if (idx < 0) return false;
    this.puShowLineError(idx, this.t('pu_qty_below_received_line', {
      n: idx + 1, code: d.code, qty: this.fmtQty(d.order_qty), received: this.fmtQty(d.received_qty)
    }));
    return true;
  },

  puEditAddRow() {
    const status = this._puEditPo?.status || 'draft';
    if (!this.can('purchase', status === 'draft' ? 'manage' : 'modify')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    if (!this._puEditLines) this._puEditLines = [];
    const defContract = document.getElementById('pu_e_contract')?.value.trim() || '';
    this._puEditLines.push({ code: '', order_qty: '', order_price: '', contract_no: defContract, remarks: '' });
    this.puRenderEditLines();
  },

  puEditRemoveRow(idx) {
    const l = (this._puEditLines || [])[idx];
    if (!l) return;
    const status = this._puEditPo?.status || 'draft';
    if (!this.can('purchase', status === 'draft' ? 'manage' : 'modify')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    if (Number(l.received_qty || 0) > 0) { this.toast(this.t('pu_line_has_received'), 'error'); return; }
    // 已确认单至少保留一行有效明细
    if (status !== 'draft' && (this._puEditLines || []).length <= 1) { this.toast(this.t('pu_last_line_required'), 'error'); return; }
    this._puEditLines.splice(idx, 1);
    this.puRenderEditLines();
  },

  puCollectEditLines() {
    const priceVisible = this.puEditPriceEditable();
    return (this._puEditLines || []).filter(l => l && l.code).map(l => {
      const o = {
        id: l.id || undefined,
        code: l.code,
        order_qty: Number(l.order_qty) || 0,
        contract_no: l.contract_no || '',
        remarks: l.remarks || '',
      };
      // 无价格权限：不提交 order_price，服务端按原行单价保留
      if (priceVisible) o.order_price = Number(l.order_price) || 0;
      return o;
    });
  },

  // 新建：POST 草稿单 → 进入明细编辑页
  async puCreateOrder() {
    if (!this.validateForm({ pu_e_date: [{ rule: 'required' }] })) return;
    const body = Object.assign(this.puReadEditForm(), { status: 'draft' });
    try {
      const r = await this.api('/api/purchase/orders', 'POST', body);
      this.toast(this.t('pu_order_created'));
      await this.puEditOrderPage(r.po_no);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // 采购单改价后的下游同步提示：同步张数 / 触发重算张数
  puPriceSyncText(r) {
    const ps = r && r.price_sync;
    if (!ps) return '';
    const n = (ps.synced_docs || []).length + (ps.synced_returns || []).length;
    const recalc = (ps.recalculated_docs || []).length + (ps.recalculated_returns || []).length;
    return n ? this.t('pu_price_sync_toast', { n, recalc }) : '';
  },

  puToastSaved(msg, r) {
    const extra = this.puPriceSyncText(r);
    this.toast(extra ? `${msg} · ${extra}` : msg);
  },

  // 保存：草稿走 manage，已确认单走 modify；保存后状态保持原状
  async puSaveOrderDraft() {
    const status = this._puEditPo?.status || 'draft';
    if (!this.can('purchase', status === 'draft' ? 'manage' : 'modify')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const head = this.puReadEditForm();
    this.puClearLineErrors();
    try {
      const r = await this.api('/api/purchase/orders/' + encodeURIComponent(head.po_no), 'PUT', Object.assign({}, head, { lines: this.puCollectEditLines() }));
      this.puToastSaved(this.t(status === 'draft' ? 'pu_draft_saved' : 'pu_modified_saved'), r);
      delete this._puDetail['orders:' + head.po_no];
      await this.puEditOrderPage(head.po_no);
    } catch (e) {
      if (!this.puShowLineErrorFromApi(e)) this.toast(e.message, 'error');
    }
  },

  // 确认采购单：先整单保存，再置为已确认
  puConfirmOrder() {
    if (!this.can('purchase', 'post')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const head = this.puReadEditForm();
    const lines = this.puCollectEditLines();
    if (!lines.length) { this.toast(this.t('pu_no_valid_line'), 'error'); return; }
    this.confirmDialog(this.t('pu_confirm_order'),
      `${this.t('pu_confirm_msg')}<br><br>${this.t('pu_line_count')}: ${lines.length}`,
      async () => {
        try {
          await this.api('/api/purchase/orders/' + encodeURIComponent(head.po_no), 'PUT', Object.assign({}, head, { lines }));
          const r = await this.api('/api/purchase/orders/' + encodeURIComponent(head.po_no) + '/confirm', 'POST', {});
          this.toast(this.t('pu_order_confirmed', { n: r.line_count }));
          delete this._puDetail['orders:' + head.po_no];
          await this.puBackToList(head.po_no);
        } catch (e) {
          if (!this.puShowLineErrorFromApi(e)) this.toast(e.message, 'error');
        }
      }, null, 'primary');
  },

  // 详情页直接过账草稿采购单：只调确认接口，不携带编辑内容（过账权可单独授予）
  puConfirmOrderDirect(poNo) {
    if (!this.can('purchase', 'post')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    this.confirmDialog(this.t('pu_confirm_order'), this.t('pu_confirm_msg'), async () => {
      try {
        const r = await this.api('/api/purchase/orders/' + encodeURIComponent(poNo) + '/confirm', 'POST', {});
        this.toast(this.t('pu_order_confirmed', { n: r.line_count }));
        delete this._puDetail['orders:' + poNo];
        await this.loadPurchaseList();
        await this.puOpen('orders', poNo);
      } catch (e) { this.toast(e.message, 'error'); }
    }, null, 'primary');
  },

  async puBackToList(openPo) {
    this.puState().view = 'list';
    this._puEditPo = null;
    this._puEditLines = [];
    this.puState().sel = openPo ? { t: 'orders', id: openPo } : null;
    await this.gotoPage('purchase');
  },

  deletePurchaseOrder(poNo) {
    const rec = this._puDetail['orders:' + poNo];
    if (rec && rec.d && rec.d.status !== 'draft') {
      this.toast(this.t('pu_delete_only_draft'), 'error');
      return;
    }
    this.puConfirmDelete(this.t('pu_delete_order'), `${this.docEsc(poNo)} — ${this.t('pu_delete_order_msg')}`, async () => {
      let snap = this._puDetail['orders:' + poNo];
      snap = snap && snap.d ? snap.d : null;
      if (!snap) { try { snap = await this.api('/api/purchase/orders/' + encodeURIComponent(poNo)); } catch (_) { snap = null; } }
      await this.api('/api/purchase/orders/' + encodeURIComponent(poNo), 'DELETE');
      delete this._puDetail['orders:' + poNo];
      await this.loadPurchaseList();
      if (this.puState().sel && this.puState().sel.t === 'orders' && this.puState().sel.id === poNo) await this.puCloseInspector();
      return async () => {
        if (snap) {
          await this.api('/api/purchase/orders', 'POST', {
            po_no: snap.po_no, date: snap.date, supplier: snap.supplier, contract_no: snap.contract_no,
            project: snap.project, expected_date: snap.expected_date, remarks: snap.remarks, manual_status: snap.manual_status,
            status: snap.status,
            lines: (snap.lines || []).map(l => {
              const o = { po_no: l.po_no, code: l.code, order_qty: l.order_qty, contract_no: l.contract_no || '', remarks: l.remarks || '' };
              if (this.canEditPrice()) o.order_price = l.order_price;
              return o;
            }),
          });
        }
        await this.loadPurchaseList();
      };
    }, this.t('pu_order_deleted'));
  },

  // ========== 采购明细增删改 ==========
  puFindLine(id) {
    const rec = this.puDetail();
    const lines = rec && rec.d ? (rec.d.lines || []) : (this._puList || []);
    return lines.find(l => Number(l.id) === Number(id)) || null;
  },

  // 单行弹窗的物料筛选：类别（精确）+ 编码/名称/规格/品牌（多关键字模糊）
  puLmFiltered() {
    const mats = this._puLmMats || [];
    const cat = this._puLmCat || '';
    return mats.filter(m => {
      if (cat && m.category !== cat) return false;
      if (!this.matchKeywords([m.code, m.name, m.spec, m.brand], this._puLmKw)) return false;
      return true;
    });
  },

  // 弹窗内筛选变化时就地刷新物料下拉（保留已选值，不重建输入框，避免焦点/中文输入被打断）
  puRefreshLmOptions() {
    const mats = this._puLmMats || [];
    const list = this.puLmFiltered();
    const cnt = document.getElementById('pu_lm_cnt');
    if (cnt) cnt.textContent = `${list.length} / ${mats.length}`;
    const sel = document.getElementById('pu_l_code');
    if (!sel) return;
    const cur = sel.value;
    const opts = list.slice();
    if (cur && !opts.some(m => m.code === cur)) {
      const cm = mats.find(m => m.code === cur);
      if (cm) opts.unshift(cm);
    }
    sel.innerHTML = opts.map(m =>
      `<option value="${this.docEsc(m.code)}"${m.code === cur ? ' selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
  },

  async puLineModal(line, poNo) {
    const { contracts, materials } = await this.puLookups();
    const isEdit = !!(line && line.id);
    const l = line || { code: '', order_qty: '', order_price: '', contract_no: '', remarks: '' };
    // 单价：能看或能填才展示；只有 price:edit 才渲染输入框并提交该字段
    const vp = this.canViewPrice() || this.canEditPrice();
    const priceEditable = this.canEditPrice();
    this._puLmMats = materials;
    this._puLmCat = '';
    this._puLmKw = '';
    const list = isEdit ? materials : this.puLmFiltered();
    const matOpts = list.map(m =>
      `<option value="${this.docEsc(m.code)}" ${m.code === l.code ? 'selected' : ''}>${this.puMatLabel(m)}</option>`
    ).join('');
    const cList = contracts.map(c => `<option value="${this.docEsc(c.contract_no)}"></option>`).join('');
    const cats = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    const catOpts = `<option value="">${this.t('all')}</option>` + cats.map(c =>
      `<option value="${this.docEsc(c)}">${this.docEsc(c)}</option>`).join('');
    // 仅新增时可筛选物料（编辑时物料锁定不可改）
    const matFilter = isEdit ? '' : `<div class="pu-matfilter">
        <label>${this.t('mat_category')}<select id="pu_lm_cat">${catOpts}</select></label>
        <input id="pu_lm_kw" type="search" value="" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}">
        <span class="pu-mu" id="pu_lm_cnt">${list.length} / ${materials.length}</span>
      </div>`;
    // 已到货行的数量下限：前端给出输入约束与提示，服务端仍做最终校验
    const recvFloor = Number(l.received_qty || 0);
    const body = `<div class="form-grid" style="max-width:none">
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_material')} *</label>
        ${matFilter}
        <select id="pu_l_code" ${isEdit ? 'disabled' : ''}>${matOpts}</select>
        <div class="form-error" id="pu_l_code_error"></div></div>
      <div class="form-group"><label>${this.t('pu_order_qty')} *</label><input id="pu_l_qty" type="number" step="0.0001" min="${recvFloor}" value="${l.order_qty}" oninput="App.clearFieldError('pu_l_qty')">${recvFloor > 0 ? `<div class="pu-mu" style="margin-top:4px">${this.t('pu_received_floor', { received: this.fmtQty(recvFloor) })}</div>` : ''}<div class="form-error" id="pu_l_qty_error"></div></div>
      ${vp ? `<div class="form-group"><label>${this.t('pu_order_price')}</label>${priceEditable
        ? `<input id="pu_l_price" type="number" step="0.01" min="0" value="${this.fmtPrice2(l.order_price)}">`
        : `<div class="pu-readonly" style="padding:7px 0">${this.fmtMoney(l.order_price)}</div>`}</div>` : ''}
      <div class="form-group"><label>${this.t('pu_contract_filter')}</label><input id="pu_l_contract" list="pu_l_c_list" value="${this.docEsc(l.contract_no || '')}"><datalist id="pu_l_c_list">${cList}</datalist></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_remarks')}</label><textarea id="pu_l_remarks" rows="2">${this.docEsc(l.remarks || '')}</textarea></div>
    </div>`;
    this.showModal(`<h3>${isEdit ? this.t('pu_edit_line') : this.t('pu_add_line')}</h3>`, body,
      isEdit ? this.t('save') : this.t('add'), async () => {
        if (!this.validateForm({ pu_l_qty: [{ rule: 'required' }, { rule: 'number' }, { rule: 'positive' }] })) return;
        const payload = {
          po_no: poNo,
          code: document.getElementById('pu_l_code').value,
          order_qty: Number(document.getElementById('pu_l_qty').value || 0),
          contract_no: document.getElementById('pu_l_contract').value.trim(),
          remarks: document.getElementById('pu_l_remarks').value.trim(),
        };
        // 没有 price:edit：不提交 order_price（编辑时服务端保留原值，新增时为 0）
        if (priceEditable) payload.order_price = Number(document.getElementById('pu_l_price').value || 0);
        if (!payload.code) { this.setFieldError('pu_l_code', this.t('pu_need_material')); return; }
        try {
          const r = await this.api('/api/purchase/lines' + (isEdit ? '/' + l.id : ''), isEdit ? 'PUT' : 'POST', payload);
          this.closeModal();
          this.puToastSaved(isEdit ? this.t('pu_line_updated') : this.t('pu_line_added'), r);
          this.puRefreshCurrent();
        } catch (e) { this.toast(e.message, 'error'); }
      }, null, true);
  },

  // 明细行所属采购单的编辑动作：草稿 manage / 已确认 modify
  puLineEditAction(line) {
    const rec = line && line.po_no ? this._puDetail['orders:' + line.po_no] : null;
    const status = (rec && rec.d && rec.d.status) || (line && line.status) || 'draft';
    return status === 'draft' ? 'manage' : 'modify';
  },

  addPurchaseLine(poNo) {
    const rec = this._puDetail['orders:' + poNo];
    const status = (rec && rec.d && rec.d.status) || 'draft';
    if (!this.can('purchase', status === 'draft' ? 'manage' : 'modify')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    this.puLineModal(null, poNo);
  },

  editPurchaseLine(id) {
    const line = this.puFindLine(id);
    if (!line) { this.toast(this.t('requestFailed'), 'error'); return; }
    if (!this.can('purchase', this.puLineEditAction(line))) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    this.puLineModal(line, line.po_no);
  },

  deletePurchaseLine(id) {
    const line = this.puFindLine(id);
    if (!line) { this.toast(this.t('requestFailed'), 'error'); return; }
    if (!this.can('purchase', this.puLineEditAction(line))) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    if (Number(line.received_qty || 0) > 0) { this.toast(this.t('pu_line_has_received'), 'error'); return; }
    const rec = this._puDetail['orders:' + line.po_no];
    const status = (rec && rec.d && rec.d.status) || 'draft';
    if (status !== 'draft' && ((rec && rec.d && rec.d.lines) || []).length <= 1) {
      this.toast(this.t('pu_last_line_required'), 'error');
      return;
    }
    const label = `${line.code} ${line.material_name || ''}`;
    this.puConfirmDelete(this.t('pu_delete_line'), label, async () => {
      await this.api('/api/purchase/lines/' + id, 'DELETE');
      this.puRefreshCurrent();
      return async () => {
        await this.api('/api/purchase/lines', 'POST', Object.assign({
          po_no: line.po_no, code: line.code, order_qty: line.order_qty,
          contract_no: line.contract_no || '', remarks: line.remarks || '',
        }, this.canEditPrice() ? { order_price: line.order_price } : {}));
        this.puRefreshCurrent();
      };
    }, this.t('pu_line_deleted'));
  },

  puRefreshCurrent() {
    const s = this.puState();
    if (s.sel) { delete this._puDetail[s.sel.t + ':' + s.sel.id]; this.puOpen(s.sel.t, s.sel.id); }
    else this.loadPurchaseList();
  },

  // ========== 合同增删改 ==========
  async editContract(contractNo) {
    const isEdit = !!contractNo;
    let c = { contract_no: '', name: '', supplier: '', sign_date: '', amount: '', status: 'active', remarks: '' };
    if (isEdit) {
      const rec = this._puDetail['contracts:' + contractNo];
      if (rec && rec.d) c = rec.d;
      else {
        try { c = await this.api('/api/purchase/contracts/' + encodeURIComponent(contractNo)); }
        catch (e) { this.toast(e.message, 'error'); return; }
      }
    }
    // 合同金额：只有 price:edit 能填；只有查看权限时编辑页只读展示；新建时无权限则不渲染
    const canEditAmount = this.canEditPrice();
    const showAmount = canEditAmount || (isEdit && this.canViewPrice());
    const { suppliers } = await this.puLookups();
    const supList = this.puSupplierOptionsHtml(suppliers);
    const stOpts = [['active', this.t('pu_status_active')], ['closed', this.t('pu_status_closed_c')]]
      .map(([v, label]) => `<option value="${v}" ${(c.status || 'active') === v ? 'selected' : ''}>${label}</option>`).join('');
    const body = `<div class="form-grid" style="max-width:none">
      <div class="form-group"><label>${this.t('pu_contract_no')} *</label><input id="pu_c_no" value="${this.docEsc(c.contract_no)}" ${isEdit ? 'readonly' : ''} oninput="App.clearFieldError('pu_c_no')"><div class="form-error" id="pu_c_no_error"></div></div>
      <div class="form-group"><label>${this.t('pu_contract_name')}</label><input id="pu_c_name" value="${this.docEsc(c.name || '')}"></div>
      <div class="form-group"><label>${this.t('pu_supplier')}</label><input id="pu_c_supplier" list="pu_c_sup_list" value="${this.docEsc(c.supplier || '')}"><datalist id="pu_c_sup_list">${supList}</datalist></div>
      <div class="form-group"><label>${this.t('pu_sign_date')}</label><input id="pu_c_sign" type="date" value="${this.fmtDate(c.sign_date)}"></div>
      ${showAmount ? `<div class="form-group"><label>${this.t('pu_contract_amount')}</label>${canEditAmount
        ? `<input id="pu_c_amount" type="number" step="0.01" min="0" value="${c.amount || ''}">`
        : `<div style="padding:7px 0">${this.fmtMoney(c.amount)}</div>`}</div>` : ''}
      <div class="form-group"><label>${this.t('pu_status')}</label><select id="pu_c_status">${stOpts}</select></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_remarks')}</label><textarea id="pu_c_remarks" rows="2">${this.docEsc(c.remarks || '')}</textarea></div>
    </div>`;
    this.showModal(`<h3>${isEdit ? this.t('pu_edit_contract') : this.t('pu_new_contract')}</h3>`, body,
      isEdit ? this.t('save') : this.t('create'), async () => {
        if (!this.validateForm({ pu_c_no: [{ rule: 'required' }] })) return;
        const payload = {
          contract_no: document.getElementById('pu_c_no').value.trim(),
          name: document.getElementById('pu_c_name').value.trim(),
          supplier: document.getElementById('pu_c_supplier').value.trim(),
          sign_date: document.getElementById('pu_c_sign').value,
          status: document.getElementById('pu_c_status').value,
          remarks: document.getElementById('pu_c_remarks').value.trim(),
        };
        // 没有 price:edit 时不提交 amount（编辑时服务端保留原值，新建为 0）
        if (canEditAmount) payload.amount = Number(document.getElementById('pu_c_amount').value || 0);
        try {
          await this.api('/api/purchase/contracts' + (isEdit ? '/' + encodeURIComponent(contractNo) : ''), isEdit ? 'PUT' : 'POST', payload);
          this.closeModal();
          this.toast(isEdit ? this.t('pu_contract_updated') : this.t('pu_contract_created'));
          if (isEdit) { delete this._puDetail['contracts:' + contractNo]; if (this.puState().sel && this.puState().sel.id === contractNo) this.puOpen('contracts', contractNo); else this.loadPurchaseList(); }
          else await this.loadPurchaseList();
        } catch (e) { this.toast(e.message, 'error'); }
      }, null, true);
  },

  deleteContract(contractNo) {
    this.puConfirmDelete(this.t('pu_delete_contract'), `${this.docEsc(contractNo)} — ${this.t('pu_delete_contract_msg')}`, async () => {
      let snap = this._puDetail['contracts:' + contractNo];
      snap = snap && snap.d ? snap.d : null;
      if (!snap) { try { snap = await this.api('/api/purchase/contracts/' + encodeURIComponent(contractNo)); } catch (_) { snap = null; } }
      await this.api('/api/purchase/contracts/' + encodeURIComponent(contractNo), 'DELETE');
      delete this._puDetail['contracts:' + contractNo];
      if (this.puState().sel && this.puState().sel.t === 'contracts' && this.puState().sel.id === contractNo) this.puCloseInspector();
      await this.loadPurchaseList();
      return async () => {
        if (snap) {
          await this.api('/api/purchase/contracts', 'POST', {
            contract_no: snap.contract_no, name: snap.name, supplier: snap.supplier,
            sign_date: snap.sign_date, amount: snap.amount, status: snap.status, remarks: snap.remarks,
          });
        }
        await this.loadPurchaseList();
      };
    }, this.t('pu_contract_deleted'));
  },

  // ========== 语言切换：保持整单编辑页与已填内容（由 01-core 调度） ==========
  capturePurchaseView() {
    if (this.puState().view !== 'edit' || !document.getElementById('pu-edit-root')) return null;
    return {
      isNew: !this._puEditPo,
      poNo: this._puEditPo ? this._puEditPo.po_no : '',
      draft: this.puReadEditForm(),
      lines: JSON.parse(JSON.stringify(this._puEditLines || [])),
      priceVisible: this._puPriceVisible,
    };
  },

  async restorePurchaseView(v) {
    if (v.isNew) await this.puNewOrderPage();
    else await this.puEditOrderPage(v.poNo);
    // 两个入口都会从服务端/默认值重建表单，这里覆盖回切换前的表头与明细
    this._puEditDraft = v.draft;
    this._puEditLines = v.lines;
    this._puPriceVisible = v.priceVisible;
    this.puRenderEditForm();
    if (!v.isNew) this.puRenderEditLines();
  },
});
