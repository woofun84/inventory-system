/**
 * 入库管理 —— 入库单列表 / 右侧详情栏 / 独立编辑页 / 更正重开
 *
 * 交互范式对齐采购管理（10-purchase.js，2026-11-05 改造）：
 *  - 单页三段式：视图页签（按业务类型：全部 / 采购入库 / 零星入库 / 作废记录）
 *    + 条件区 + 状态统计卡片 + 列表
 *  - 列表右侧 sticky 详情栏（.pu-split.open），点行原地展开，不再整页跳转
 *  - 详情子页签带计数：明细 / 操作日志
 *  - 底部固定操作条：添加物料 → 确认入库 → 打印 → 导出 → 更正 → 删除（高危固定最右）
 *  - 列表/详情复用 pages.css 中的 .pu-* 组件样式，保证各模块观感一致
 *
 * 仍以独立整页呈现的部分（不套详情栏）：
 *  - 新建入库单 newInboundDoc()：单据信息表单
 *  - 编辑草稿 editInboundDoc()：明细编辑（存草稿 / 确认入库）
 *  - 更正重开：prefill 草稿 → 确认后原单作废 + 新单直接过账；明细全删则只作废原单
 */
Object.assign(App, {

  // ========== 状态 ==========
  ibState() {
    if (!this._ib) this._ib = {};
    const s = this._ib;
    if (s.tab === undefined) s.tab = '';      // 视图页签：'' | 采购入库 | 零星入库 | voided（作废记录）
    if (s.hist === undefined) s.hist = false; // 历史版本开关：默认不显示已作废单据
    if (s.sel === undefined) s.sel = null;    // 右侧详情栏当前单据号
    if (!s.dt) s.dt = 'lines';                // 详情子页签：lines | logs
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
    this.ibBindEvents();
    this.ibRenderTabs();
    this.ibRenderToolbar();
    this.ibRenderFilters();
    const root = document.getElementById('ib-root');
    if (root) root.classList.toggle('ib-dense', !!s.dense);
    await this.loadInboundList();
    // 进入页面时若有选中的单据，强制重取详情，避免复用上次的快照
    if (s.sel) await this.ibOpen(s.sel); else this.ibRenderInspector();
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

  // 视图页签按「业务类型」划分：全部 / 采购入库 / 零星入库 / 作废记录
  // 「作废记录」展示被更正作废的原单及其后继新单，便于双向追溯
  // 采购退货已迁出到「退货与退库」模块，不在本页展示
  ibTabDefs() {
    return [
      ['', this.t('all')],
      ['采购入库', this.t('in_purchase')],
      ['零星入库', this.t('in_other')],
      ['voided', this.t('ibd_void_tab')],
    ];
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
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.hist}" data-ib="hist">${this.t('ibd_corr_history')}</button>
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.dense}" data-ib="dense">${this.t('pu_dense')}</button>`;
  },

  ibEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  },

  async loadInboundList() {
    try {
      // 列表始终带历史版本，默认只展示链条末端；开关 / 关键字搜索时放开
      this._ibList = await this.api('/api/inbound-docs?excludeType=' + encodeURIComponent('采购退货') + '&includeHistory=1');
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
    this.markFresh('inbound');
  },

  // ========== 列表渲染（对齐采购：KPI 卡片 + 条件吸附分页） ==========
  // KPI 状态定义：[key, label, 计数判定]
  ibKpiDefs() {
    return [
      ['', this.t('all'), r => true],
      ['draft', this.t('ibd_status_draft'), r => r.status === 'draft'],
      ['posted', this.t('ibd_status_posted'), r => r.status === 'posted'],
      ['voided', this.t('ibd_status_voided'), r => r.status === 'voided'],
    ];
  },

  ibHasFilter() {
    const s = this.ibState();
    return !!(s.f.kw || s.f.from || s.f.to || s.kpi || s.tab);
  },

  // 页签 + 历史版本口径（不含关键字/日期/状态卡片），KPI 与列表共用
  ibScopeRows() {
    const s = this.ibState();
    let rows = this._ibList || [];
    if (s.tab === 'voided') {
      // 「作废记录」只展示被更正作废的原单
      rows = rows.filter(r => r.status === 'voided');
    } else if (s.tab) {
      rows = rows.filter(r => r.txn_type === s.tab);
    } else {
      rows = rows.filter(r => r.txn_type !== '采购退货');
    }
    // 默认隐藏作废单；打开历史版本、输入关键字、或切到作废记录页签时展示
    const showHist = !!s.hist || !!s.f.kw || s.tab === 'voided';
    if (!showHist) rows = rows.filter(r => r.status !== 'voided');
    return rows;
  },

  // 过滤顺序：业务类型页签 → 历史版本 → 关键字（空格 AND）→ 日期区间 → 状态卡片
  ibVisibleRows() {
    const s = this.ibState();
    let rows = this.ibScopeRows();
    if (s.f.kw) rows = this.filterByKeywords(rows, s.f.kw, ['doc_no', 'date', 'txn_type', 'supplier', 'handler', 'po_no', 'contract_no', 'remarks', 'corrects_doc_no', 'corrected_by_doc_no']);
    rows = this.filterByDateRange(rows, 'date', s.f.from, s.f.to);
    const def = this.ibKpiDefs().find(d => d[0] === s.kpi);
    return def ? rows.filter(def[2]) : rows;
  },

  ibRenderList() {
    const s = this.ibState();
    const kp = document.getElementById('ib-kpis');
    if (kp) {
      kp.innerHTML = this.ibKpiDefs().map(([k, label, fn]) =>
        `<button type="button" class="pu-kpi" aria-pressed="${s.kpi === k}" data-ib="kpi" data-id="${k}"><small>${label}</small><strong>${this.ibScopeRows().filter(fn).length}</strong></button>`
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
    // 金额列：以接口是否下发 total_amount 为准
    const vp = pageData.length > 0 ? this.hasField(pageData[0], 'total_amount') : this.canViewPrice();
    const sel = this.ibState().sel;
    const tid = 'inbound';
    const cols = [
      ['doc_no', this.t('ibd_no'), r => {
        const subs = [];
        if (r.corrects_doc_no) subs.push(`✎ ${this.t('ibd_corr_from')} ${this.ibEsc(r.corrects_doc_no)}`);
        if (r.corrected_by_doc_no) subs.push(`→ ${this.t('ibd_corr_to')} ${this.ibEsc(r.corrected_by_doc_no)}`);
        const sub = subs.length ? `<br><span class="pu-mu">${subs.join('<br>')}</span>` : '';
        return `<button type="button" class="pu-lk" data-ib="open" data-id="${this.ibEsc(r.doc_no)}">${this.ibEsc(r.doc_no)}</button>${this.docRevisionBadge(r.doc_no)}${sub}`;
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
      const voided = r.status === 'voided';
      return `<tr class="pu-row${on ? ' sel' : ''}${voided ? ' ib-voided-row' : ''}" data-ra="inbound" data-id="${this.ibEsc(r.doc_no)}">` +
        shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  ibTypeBadge(t) {
    const keyMap = { '采购入库': 'in_purchase', '零星入库': 'in_other', '采购退货': 'in_return' };
    if (keyMap[t]) return `<span class="badge ${this.docTypeBadgeClass(t)}">${this.t(keyMap[t])}</span>`;
    return `<span class="badge badge-muted">${this.ibEsc(t || this.t('ibd_unknown_type'))}</span>`;
  },

  ibTypeLabel(t) {
    const keyMap = { '采购入库': 'in_purchase', '采购退货': 'in_return', '零星入库': 'in_other' };
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
    if (rows.length && this.hasField(rows[0], 'total_amount')) tot += ` · ${this.t('ibd_amount')} ${this.fmtMoney(sum('total_amount'))}`;
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
    const label = { draft: 'ibd_status_draft', posted: 'ibd_status_posted', voided: 'ibd_status_voided' };
    const cls = this.docStatusMeta(status).cls;
    return `<span class="badge ${cls}">${label[status] ? this.t(label[status]) : status}</span>`;
  },

  // ========== 采购退货：只认原入库单 ==========
  // 新建采购退货单：唯一的来源选择就是原入库单（已过账且仍有可退量）
  ibReturnOriginFieldHtml(selected) {
    const origins = this._ibReturnOrigins || [];
    const originOpts = origins.map(o =>
      '<option value="' + this.ibEsc(o.doc_no) + '" data-supplier="' + this.ibEsc(o.supplier || '') + '"' +
      (o.doc_no === selected ? ' selected' : '') + '>' +
      this.ibEsc(o.doc_no) + ' · ' + this.ibEsc(o.date || '') + (o.supplier ? ' · ' + this.ibEsc(o.supplier) : '') + '</option>'
    ).join('');
    return '<div class="form-group" style="grid-column:1/-1"><label>' + this.t('ret_origin_inbound_doc') + ' *</label>' +
      '<select id="ib_f_origin_doc" onchange="App.ibOnReturnOriginChange()">' +
      '<option value="">' + this.t('please_select') + '</option>' + originOpts + '</select>' +
      '<small style="color:var(--text-muted);font-size:12px">' + this.t('ret_origin_inbound_hint') + '</small></div>';
  },

  // 原入库单切换：清空预览并重新带出可退明细
  ibOnReturnOriginChange() {
    this._ibReturnTier = 'inbound';
    this._ibPreloadLines = null;
    const box = document.getElementById('ib-preload');
    if (box) box.innerHTML = '';
    this.ibLoadReturnSources();
  },

  // 选择原单后把供应商带入单头（仍允许人工修改）
  ibSyncReturnSupplier() {
    const input = document.getElementById('ib_f_supplier');
    const el = document.getElementById('ib_f_origin_doc');
    if (!input || !el || !el.value) return;
    const opt = el.options[el.selectedIndex];
    const sup = opt && opt.dataset ? (opt.dataset.supplier || '') : '';
    if (sup) input.value = sup;
  },

  // 载入原入库单的可退明细：原数量 / 已退 / 剩余可退 / 单价
  async ibLoadReturnSources() {
    const box = document.getElementById('ib-preload');
    if (!box) return;
    this._ibPreloadLines = null;
    const docNo = document.getElementById('ib_f_origin_doc')?.value || '';
    this.ibSyncReturnSupplier();
    if (!docNo) { box.innerHTML = ''; return; }
    let rows = [];
    try { rows = await this.api('/api/returns/purchase/origin-lines?docNo=' + encodeURIComponent(docNo)); }
    catch (e) { box.innerHTML = '<div class="ib-empty-draft">' + e.message + '</div>'; return; }
    const usable = (rows || []).filter(r => Number(r.available) > 0);
    this._ibPreloadLines = usable.map(r => ({
      code: r.code, qty: '', price: Number(r.price) || 0,
      origin_line_id: r.id, source_doc_no: r.doc_no,
      max_qty: Number(r.available) || 0, available: Number(r.available) || 0,
      po_no: r.po_no || '', contract_no: r.contract_no || '', order_line_id: r.order_line_id || 0,
      material_name: r.material_name || '', material_spec: r.material_spec || '',
      material_brand: r.material_brand || '', material_unit: r.material_unit || '', remarks: ''
    }));
    if (usable.length === 0) {
      box.innerHTML = '<div class="ib-empty-draft">' + this.t('ret_no_returnable') + '</div>';
      return;
    }
    const vp = usable.length > 0 && this.hasField(usable[0], 'price');
    const body = usable.map((r, i) => {
      const orig = Math.abs(Number(r.qty) || 0);
      const remain = Math.abs(Number(r.available) || 0);
      return '<tr>' +
        '<td>' + this.ibEsc(r.code) + '</td><td>' + this.ibEsc(r.material_name || '') + '</td><td>' + this.ibEsc(r.material_spec || '') + '</td>' +
        '<td style="font-size:12px">' + this.ibEsc(r.doc_no || '') + '</td>' +
        '<td class="text-right">' + this.fmtQty(orig) + '</td>' +
        '<td class="text-right">' + this.fmtQty(Math.max(0, orig - remain)) + '</td>' +
        '<td class="text-right"><b>' + this.fmtQty(remain) + '</b></td>' +
        '<td style="min-width:110px"><input type="number" step="0.01" min="0.01" max="' + remain +
        '" id="ib_pre_qty_' + i + '" oninput="App.ibPreQtyInput(' + i + ', this)" onpaste="App.qtyPaste(event)"></td>' +
        (vp ? '<td class="text-right">' + this.fmtMoney(r.price) + '</td>' : '') +
        '</tr>';
    }).join('');
    box.innerHTML = '<div class="pu-card">' +
      '<div class="pu-card-title"><span>02</span><div>' + this.t('ret_lines_purchase') +
      '<small>' + this.t('ret_source_preview_hint', { n: usable.length }) + '</small></div></div>' +
      '<div class="table-wrap" style="max-height:280px;overflow:auto"><table><thead><tr>' +
      '<th>' + this.t('mat_code') + '</th><th>' + this.t('mat_name') + '</th><th>' + this.t('mat_spec') + '</th>' +
      '<th>' + this.t('ret_source_doc') + '</th>' +
      '<th class="text-right">' + this.t('ret_source_orig_qty') + '</th>' +
      '<th class="text-right">' + this.t('ret_source_returned_qty') + '</th>' +
      '<th class="text-right">' + this.t('ret_remaining_qty') + '</th>' +
      '<th>' + this.t('ret_qty') + '</th>' +
      (vp ? '<th class="text-right">' + this.t('in_price') + '</th>' : '') +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
  },

  // 新建退货单的可退明细数量输入（正数、min=0.01、粘贴纠正）
  ibPreQtyInput(idx, el) {
    const l = (this._ibPreloadLines || [])[idx];
    if (!l) return;
    l.qty = this.qtyInput(el);
  },

  // ========== 新建入库单据：独立页面，不再使用首屏弹窗 ==========
  // presetType: 传入「采购退货」时由「退货与退库」模块复用本页创建退货单
  // originDocNo: 由原单选择器/入库详情带入的原入库单，进入页面即带出可退明细
  async newInboundDoc(presetType, originDocNo) {
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
    // 单头来源：采购单/合同混排，只列还有未到货行的来源（已全部到货的不出现）
    this._ibSourceList = await this.api('/api/purchase/inbound-sources').catch(() => []);
    this._ibSource = null;
    this._ibSourceLines = [];
    const sourceOptions = this.ibSourceOptionsHtml('');
    // 采购退货只认原入库单
    let returnOrigins = [];
    if (preset) returnOrigins = await this.api('/api/returns/purchase/origins').catch(() => []);
    this._ibReturnOrigins = returnOrigins || [];
    this._ibReturnTier = 'inbound';
    const returnFields = preset ? this.ibReturnOriginFieldHtml(originDocNo || '') : '';
    const supOptions = suppliers.map(s => `<option value="${this.ibEsc(s.name)}"></option>`).join('');
    // 普通入库/零星入库：类型下拉；采购退货：只读展示「单据类型」，来源只能是原入库单
    const typeField = preset
      ? `<div class="form-group"><label>${this.t('ibd_doc_type')}</label><input id="ib_f_type_text" value="${this.t('in_return')}" readonly><input type="hidden" id="ib_f_txn_type" value="采购退货"></div>`
      : `<div class="form-group"><label>${this.t('ibd_type')} *</label><select id="ib_f_txn_type" onchange="App.ibOnTypeChange()"><option value="采购入库">${this.t('in_purchase')}</option><option value="零星入库">${this.t('in_other')}</option></select></div>`;
    const pageTitle = preset ? this.t('ret_new_purchase') : this.t('ibd_add');

    this.setMain(this.pageWrap('🆕 ' + pageTitle, this.t('ibd_create_hint'), '',
      `<div class="data-page" id="ib-new-root">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.backToInboundList()">← ${this.t('ibd_back_list')}</span>
          ${this.ibdStatusBadge('draft')}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('pu_section_header')}</div></div>
          <div class="form-grid" style="max-width:none">
            <div class="form-group"><label>${this.t('ibd_no')}</label><input id="ib_f_no" value="${docNo}" readonly></div>
            <div class="form-group"><label>${this.t('ibd_date')} *</label><input id="ib_f_date" type="date" value="${date}"></div>
            ${typeField}
            <div class="form-group"><label id="ib_f_supplier_label">${this.t('ibd_supplier')} *</label><input id="ib_f_supplier" list="ib_sup_list" autocomplete="off" oninput="this.dataset.auto=''"><datalist id="ib_sup_list">${supOptions}</datalist><div class="form-error" id="ib_f_supplier_error"></div></div>
            <div class="form-group"><label>${this.t('ibd_handler')}</label><input id="ib_f_handler" value="${this.user?.name || this.user?.username || ''}"></div>
            <div class="form-group" id="ib_f_source_wrap"><label>${this.t('ibd_source')} *</label><select id="ib_f_source" onchange="App.ibOnSourceChange()"><option value="">${this.t('ibd_src_pick')}</option>${sourceOptions}</select></div>
            <div class="form-group" id="ib_f_source_refs_wrap"><label>${this.t('ibd_source_refs')}</label><input id="ib_f_source_refs" readonly></div>
            ${returnFields}
            <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_remarks')}</label><textarea id="ib_f_remarks" rows="2"></textarea></div>
          </div>
        </div>
        <div id="ib-preload"></div>
        <div class="pu-edit-actions">
          <button class="btn btn-outline" onclick="App.backToInboundList()">${this.t('cancel')}</button>
          <button class="btn btn-primary" onclick="App.createInboundDoc()">${this.t('pu_create_and_add')}</button>
        </div>
      </div>`));
    this.ibOnTypeChange();
  },

  // 入库类型切换：采购入库显示来源（采购单/合同二选一）；零星入库只保留可空的「来源单位」
  // 采购退货不需要来源预载，避免误带「未到货明细」
  ibOnTypeChange() {
    const type = document.getElementById('ib_f_txn_type')?.value || '采购入库';
    const isOther = type === '零星入库';
    const isReturn = type === '采购退货';
    const hideSource = isOther || isReturn;
    const label = document.getElementById('ib_f_supplier_label');
    const input = document.getElementById('ib_f_supplier');
    const srcWrap = document.getElementById('ib_f_source_wrap');
    const refsWrap = document.getElementById('ib_f_source_refs_wrap');
    const srcEl = document.getElementById('ib_f_source');
    const refsEl = document.getElementById('ib_f_source_refs');
    const box = document.getElementById('ib-preload');
    if (label) label.textContent = isOther ? this.t('ibd_source_unit') : this.t('ibd_supplier') + ' *';
    if (input) {
      input.placeholder = isOther ? this.t('ibd_source_unit_ph') : '';
      this.clearFieldError('ib_f_supplier');
    }
    if (srcWrap) srcWrap.style.display = hideSource ? 'none' : '';
    if (refsWrap) refsWrap.style.display = hideSource ? 'none' : '';
    if (hideSource) {
      if (srcEl) srcEl.value = '';
      if (refsEl) refsEl.value = '';
      this._ibSource = null;
      this._ibSourceLines = [];
      this._ibPreloadLines = null;
      if (box) box.innerHTML = '';
    }
    // 采购退货：先选原入库单，选中后带出可退明细
    if (isReturn) {
      this.ibOnReturnOriginChange();
    }
  },

  // 来源下拉：采购单/合同分组混排，只含「还有未到货行」的来源；当前单据的来源即使已完成也保留
  ibSourceOptionsHtml(currentVal) {
    const cur = String(currentVal || '');
    const list = (this._ibSourceList || []).slice();
    if (cur && !list.some(s => `${s.kind}:${s.no}` === cur)) {
      const i = cur.indexOf(':');
      list.push({ kind: cur.slice(0, i), no: cur.slice(i + 1), supplier: '', pending_lines: 0, refs: [], _completed: true });
    }
    const group = (kind, labelKey) => {
      const items = list.filter(s => s.kind === kind);
      if (!items.length) return '';
      return `<optgroup label="${this.t(labelKey)}">` + items.map(s => {
        const val = `${s.kind}:${s.no}`;
        const suffix = s._completed ? this.t('ibd_src_completed') : this.t('ibd_src_pending', { n: s.pending_lines });
        return `<option value="${this.ibEsc(val)}"${val === cur ? ' selected' : ''}>${this.ibEsc(s.no)}` +
          `${s.supplier ? ' · ' + this.ibEsc(s.supplier) : ''} · ${suffix}</option>`;
      }).join('') + '</optgroup>';
    };
    return group('po', 'ibd_src_group_po') + group('contract', 'ibd_src_group_contract');
  },

  // 只读派生的另一侧：选采购单显示涉及的合同，选合同显示覆盖的采购单
  ibSourceRefsText() {
    if (!this._ibSource) return '';
    const src = (this._ibSourceList || []).find(s => s.kind === this._ibSource.kind && s.no === this._ibSource.no);
    if (src && src.refs && src.refs.length) return src.refs.join('、');
    const lines = this._ibSourceLines || [];
    const refs = this._ibSource.kind === 'po'
      ? lines.map(l => l.contract_no_eff)
      : lines.map(l => l.po_no);
    return [...new Set(refs.filter(Boolean))].sort().join('、') || '—';
  },

  // 编辑态切换来源：先算失配行，确认后只标记不删行、不清数量
  async ibOnEditSourceChange(el) {
    const d = this._ibDetail;
    if (!d || d.status !== 'draft' || d.txn_type !== '采购入库') return;
    const raw = el?.value || '';
    const prev = this._ibSource ? `${this._ibSource.kind}:${this._ibSource.no}` : '';
    const sep = raw.indexOf(':');
    const next = raw ? { kind: raw.slice(0, sep), no: raw.slice(sep + 1) } : null;
    if (!next) {
      this._ibSource = null;
      this._ibSourceLines = [];
      (this._ibEditLines || []).forEach(l => { l._outOfScope = false; });
      this.renderInboundEdit();
      return;
    }
    let lines = [];
    try {
      const qs = next.kind === 'po' ? 'poNo=' : 'contractNo=';
      lines = await this.api('/api/purchase/inbound-scope-lines?' + qs + encodeURIComponent(next.no));
    } catch (e) { this.toast(e.message, 'error'); el.value = prev; return; }
    const mismatch = this.ibMismatchLines(lines);
    if (!mismatch.length) { this.ibApplySource(next, lines); return; }
    const text = mismatch.map(({ l, i }) => `${i + 1}. ${l.code || '—'} × ${this.fmtQty(l.qty)}`).join('<br>');
    this.confirmDialog(this.t('ibd_switch_mismatch_title'),
      `${this.t('ibd_switch_mismatch')}<br>${text}`,
      () => this.ibApplySource(next, lines, mismatch),
      () => { el.value = prev; }, 'primary');
  },

  ibMismatchLines(lines) {
    const ids = new Set((lines || []).map(x => Number(x.id)));
    const codes = new Set((lines || []).map(x => String(x.code)));
    return (this._ibEditLines || []).map((l, i) => ({ l, i })).filter(({ l }) => {
      if (Number(l.origin_line_id) > 0) return false;
      const oid = Number(l.order_line_id) || 0;
      if (oid > 0) return !ids.has(oid);
      return l.code ? !codes.has(l.code) : false;
    });
  },

  ibApplySource(next, lines, mismatch) {
    this._ibSource = next;
    this._ibSourceLines = lines || [];
    const outIds = new Set((mismatch || []).filter(({ l }) => Number(l.order_line_id) > 0).map(({ l }) => Number(l.order_line_id)));
    const outCodes = new Set((mismatch || []).filter(({ l }) => !Number(l.order_line_id)).map(({ l }) => l.code));
    (this._ibEditLines || []).forEach(l => {
      l._outOfScope = Number(l.order_line_id) > 0 ? outIds.has(Number(l.order_line_id)) : outCodes.has(l.code);
    });
    this.renderInboundEdit();
  },

  // 新建页是否有实质内容：任一带物料的明细行，或单头关键字段（供应商/来源/备注/原单）任一非空
  ibNewPageHasContent() {
    const rows = this._ibPreloadLines || [];
    if (rows.some(l => String(l.code || '').trim())) return true;
    if (document.querySelectorAll('#ib-preload tbody tr').length > 0) return true;
    const supplier = (document.getElementById('ib_f_supplier')?.value || '').trim();
    const source = (document.getElementById('ib_f_source')?.value || '').trim()
      || (this._ibSource && this._ibSource.no) || '';
    const remarks = (document.getElementById('ib_f_remarks')?.value || '').trim();
    const origin = (document.getElementById('ib_f_origin_doc')?.value || '').trim();
    return !!(supplier || source || remarks || origin);
  },

  // 离开编辑页前处理占位空草稿：零明细且单头无关键字段时自动删除（更正草稿不在此列）
  async ibDropEmptyDraftOnLeave() {
    const d = this._ibDetail;
    const docNo = this._ibDocNo;
    if (!d || !docNo || d.status !== 'draft') return false;
    if (String(d.corrects_doc_no || '').trim()) return false;
    if ((this._ibEditLines || []).length > 0) return false;
    const supplier = (document.getElementById('ib_e_supplier')?.value || '').trim();
    const source = (document.getElementById('ib_e_source')?.value || '').trim();
    const remarks = (document.getElementById('ib_e_remarks')?.value || '').trim();
    const origin = (document.getElementById('ib_e_origin_doc')?.value || '').trim()
      || String(d.origin_doc_no || '').trim();
    if (supplier || source || remarks || origin) return false;
    try {
      await this.api('/api/inbound-docs/' + encodeURIComponent(docNo), 'DELETE');
      this.toast(this.t('empty_draft_not_saved'));
    } catch (e) {
      return false; // 删除失败不阻断返回
    }
    this._ibDocNo = '';
    this._ibDetail = null;
    this._ibEditLines = [];
    this._ibCorrection = null;
    return true;
  },

  // 更正草稿：行数/数量与原单完全一致且单头（仅备注可改）未改动
  ibCorrectionUnchanged() {
    const corr = this._ibCorrection;
    if (!corr) return false;
    const cur = corr.current || {};
    const keys = Object.keys(cur);
    const lines = this.ibSelectedEditLines();
    if (lines.length !== keys.length) return false;
    for (const l of lines) {
      const k = this.ibCorrKey(l);
      if (!(k in cur)) return false;
      if (Math.abs(Number(l.qty) - Number(cur[k])) > 1e-9) return false;
    }
    const remarksNow = (document.getElementById('ib_e_remarks')?.value || '').trim();
    // 基线：原单备注，或创建更正草稿时自动写入的「更正自 XXX」标记
    const baseline = new Set([String(corr.originalRemarks || '').trim()]);
    if (String(corr.originalDocNo || '').trim()) baseline.add('更正自 ' + String(corr.originalDocNo).trim());
    return baseline.has(remarksNow);
  },

  async createInboundDoc() {
    // 空草稿不落地：没有任何明细行，且单头关键字段（供应商/来源/备注）全空时不建单
    if (!this.ibNewPageHasContent()) {
      this.toast(this.t('empty_draft_not_saved'), 'error');
      return;
    }
    if (!this.validateForm({ ib_f_date: [{ rule: 'required' }] })) return;
    const txnType = document.getElementById('ib_f_txn_type')?.value;
    const isReturn = txnType === '采购退货';
    if (txnType === '采购入库' && !this._ibSource) {
      this.toast(this.t('ibd_source_required_first'), 'error');
      return;
    }
    const body = {
      doc_no: document.getElementById('ib_f_no')?.value || '',
      date: document.getElementById('ib_f_date')?.value,
      txn_type: txnType,
      supplier: document.getElementById('ib_f_supplier')?.value?.trim(),
      handler: document.getElementById('ib_f_handler')?.value.trim(),
      po_no: this._ibSource && this._ibSource.kind === 'po' ? this._ibSource.no : '',
      contract_no: this._ibSource && this._ibSource.kind === 'contract' ? this._ibSource.no : '',
      remarks: document.getElementById('ib_f_remarks')?.value.trim()
    };
    if (isReturn) {
      if (!this.validateForm({ ib_f_supplier: [{ rule: 'required' }] })) return;
      body.return_tier = 'inbound';
      body.origin_doc_no = document.getElementById('ib_f_origin_doc')?.value || '';
      if (!body.origin_doc_no) { this.toast(this.t('ret_origin_inbound_required'), 'error'); return; }
      if (!this._ibPreloadLines || this._ibPreloadLines.length === 0) {
        this.toast(this.t('ret_no_returnable'), 'error');
        return;
      }
      const chosen = (this._ibPreloadLines || []).filter(l => parseFloat(l.qty) > 0);
      if (chosen.length === 0) { this.toast(this.t('ret_qty_required'), 'error'); return; }
      for (const l of chosen) {
        if (parseFloat(l.qty) > Number(l.max_qty || 0) + 1e-9) {
          this.toast(this.t('ret_qty_over_available', { n: 1, max: this.fmtQty(l.max_qty) }), 'error');
          return;
        }
      }
      body.lines = chosen.map(l => ({
        code: l.code, qty: parseFloat(l.qty), price: Number(l.price) || 0,
        origin_line_id: l.origin_line_id, po_no: l.po_no || '', contract_no: l.contract_no || '',
        remarks: l.remarks || ''
      }));
    }
    try {
      const r = await this.api('/api/inbound-docs', 'POST', body);
      this.toast(this.t('ibd_created'));
      // 退货单：明细已随创建提交，直接进入编辑页复核
      if (isReturn) await this.editInboundDoc(r.doc_no);
      else await this.editInboundDoc(r.doc_no, this._ibPreloadLines || []);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // 新建入库单：选择来源（采购单/合同）后，自动带出该来源下全部未到货明细（数量留空）
  // 手选采购单/合同后把供应商带到单头（采购单与合同都用 inbound-sources 的 supplier 字段）。
  // 只补空值或仍为自动带入的值，用户手填后不再覆盖；零星入库与编辑页不调用本方法。
  ibApplySourceSupplier(src) {
    const input = document.getElementById('ib_f_supplier');
    if (!input) return;
    const sup = String((src && src.supplier) || '').trim();
    if (!sup) return;
    if (input.value.trim() && input.dataset.auto !== '1') return;
    input.value = sup;
    input.dataset.auto = '1';
  },

  async ibOnSourceChange() {
    const srcEl = document.getElementById('ib_f_source');
    const refsEl = document.getElementById('ib_f_source_refs');
    const box = document.getElementById('ib-preload');
    const raw = srcEl?.value || '';
    this._ibPreloadLines = null;
    this._ibSourceLines = [];
    const sep = raw.indexOf(':');
    this._ibSource = raw ? { kind: raw.slice(0, sep), no: raw.slice(sep + 1) } : null;
    if (refsEl) refsEl.value = '';
    if (!box) return;
    box.innerHTML = '';
    if (!this._ibSource) return;
    const src = (this._ibSourceList || []).find(s => s.kind === this._ibSource.kind && s.no === this._ibSource.no);
    if (refsEl && src) refsEl.value = (src.refs || []).join('、') || '—';
    this.ibApplySourceSupplier(src);

    const qs = this._ibSource.kind === 'po'
      ? 'poNo=' + encodeURIComponent(this._ibSource.no)
      : 'contractNo=' + encodeURIComponent(this._ibSource.no);
    let lines = [];
    try { lines = await this.api('/api/purchase/inbound-scope-lines?' + qs); }
    catch (e) { box.innerHTML = `<div class="ib-empty-draft">${e.message}</div>`; return; }
    this._ibSourceLines = lines || [];
    const pending = (this._ibSourceLines || []).filter(l => Number(l.unreceived_qty) > 0);
    this._ibPreloadLines = pending.map(l => ({
      order_line_id: l.id,
      code: l.code,
      contract_no: l.contract_no_eff || '',
      po_no: l.po_no || '',
      material_name: l.material_name || '',
      material_spec: l.material_spec || '',
      material_brand: l.material_brand || '',
      material_unit: l.material_unit || '',
      qty: '',
      price: Number(l.order_price) || 0,
      remarks: ''
    }));
    this.ibRenderPreload(pending);
  },

  ibRenderPreload(pending) {
    const box = document.getElementById('ib-preload');
    if (!box) return;
    if (!pending.length) {
      box.innerHTML = `<div class="ib-empty-draft">${this.t('ibd_no_unreceived_lines')}</div>`;
      return;
    }
    box.innerHTML = `<div class="pu-card">
      <div class="pu-card-title"><span>02</span><div>${this.t('pu_next_add_lines')}<small>${this.t('ibd_next_add_lines_hint', { n: pending.length })}</small></div></div>
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

  // ========== 详情栏（对齐采购：点行原地展开，不再整页跳转） ==========
  // 对外入口保持不变，供采购模块「入库单」链接跳转使用
  async openInboundDoc(docNo) {
    if (!docNo) return;
    const s = this.ibState();
    s.sel = docNo;
    if (this.currentPage !== 'inbound' || !document.getElementById('ib-root')) {
      // 由 renderInbound 统一重取列表并展开该单详情
      return this.gotoPage('inbound');
    }
    // 同页内操作后打开单据：先刷新列表，避免列表/详情状态不一致
    await this.loadInboundList();
    return this.ibOpen(docNo);
  },

  // ========== 跨单据互链：跳转与返回 ==========
  // kind: inbound | returns | outbound；fromKind/fromDoc 为来源单据，用于目标页显示「返回」按钮
  async crossDocJump(kind, docNo, fromKind, fromDoc) {
    if (!docNo) return;
    this._linkBack = (fromKind && fromDoc) ? { fromKind, fromDoc, toKind: kind, toDoc: docNo } : null;
    if (kind === 'inbound') return this.openInboundDoc(docNo);
    if (kind === 'outbound') return this.openOutboundDoc(docNo);
    return this.openReturnDoc(docNo);
  },

  async crossLinkBack() {
    const b = this._linkBack;
    if (!b) return;
    this._linkBack = null;
    if (b.fromKind === 'inbound') return this.openInboundDoc(b.fromDoc);
    if (b.fromKind === 'outbound') return this.openOutboundDoc(b.fromDoc);
    return this.openReturnDoc(b.fromDoc);
  },

  // 目标详情页顶部「← 返回 <来源单号>」（仅跨单据跳转后出现）
  crossLinkBackBtn(kind, docNo) {
    const b = this._linkBack;
    if (!b || b.toKind !== kind || b.toDoc !== docNo) return '';
    return `<button type="button" class="btn btn-outline btn-sm" onclick="App.crossLinkBack()">← ${this.t('doc_back_to_source', { doc: this.ibEsc(b.fromDoc) })}</button>`;
  },

  async ibOpen(docNo) {
    const s = this.ibState();
    if (s.sel !== docNo) { s.dt = 'lines'; s.lq = ''; s.lim = 15; s.ex = new Set(); }
    s.sel = docNo;
    this._ibDocNo = docNo;
    this._ibDetail = null;
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
  },

  async ibCloseInspector() {
    const s = this.ibState();
    const prev = s.sel;
    s.sel = null; s.wide = false;
    if (this.isStale('inbound')) {
      // 详情栏开着期间发生过写操作：关闭前补拉一次列表，避免回到旧数据
      await this.loadInboundList();
    } else {
      this.ibRenderList();
    }
    this.ibRenderInspector();
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
    const logs = d.logs || [];
    if (!['lines', 'logs', 'related'].includes(s.dt)) s.dt = 'lines';

    // 更正草稿标记在底部操作区计算（依赖 isDraft）
    const typeLabel = this.ibTypeLabel(d.txn_type);
    const meta = [
      [d.txn_type === '采购退货' ? this.t('ibd_doc_type') : this.t('ibd_type'), typeLabel],
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
    if (d.status === 'voided') {
      meta.push([this.t('ibd_voided_at'), this.fmtDateTime(d.voided_at) || '–']);
      meta.push([this.t('ibd_voided_by'), d.voided_by || '–']);
    }
    meta.push([this.t('ibd_remarks'), d.remarks || '–']);

    const relatedReturns = Array.isArray(d.related_returns) ? d.related_returns : [];
    // 页签顺序统一：明细 → 关联退货单 → 操作日志（日志永远最后）
    // 关联页签恒显示（第二步统一口径），无数据时面板内给空态文案
    const tabs = [
      ['lines', this.t('ibd_tab_lines'), lines.length],
      ['related', this.t('ibd_tab_related_returns'), relatedReturns.length],
      ['logs', this.t('pu_tab_logs'), logs.length],
    ];

    // 底部操作条：业务操作 → 只读输出（打印/导出） → 修改 → 删除（高危固定最右）
    const isDraft = d.status === 'draft';
    const isCorrDraft = isDraft && !!String(d.corrects_doc_no || '');
    let foot = '';
    if (isDraft && this.can('inbound', 'edit')) {
      if (isCorrDraft) {
        foot += `<button type="button" class="btn btn-primary" data-ib="e-doc">✎ ${this.t('ibd_corr_continue')}</button>`;
      } else {
        foot += `<button type="button" class="btn btn-outline" data-ib="e-doc">${lines.length ? this.t('ibd_edit') : '+ ' + this.t('ibd_add_line')}</button>`;
        if (lines.length) foot += `<button type="button" class="btn btn-primary" data-ib="confirm">✅ ${this.t(d.txn_type === '采购退货' ? 'ibd_confirm_return' : 'ibd_confirm')}</button>`;
      }
    }
    foot += `<button type="button" class="btn btn-outline" data-ib="print">🖨 ${this.t('doc_print')}</button>`;
    foot += `<button type="button" class="btn btn-outline" data-ib="export">⬇ ${this.t('doc_export')}</button>`;
    // 入库单详情直达退货（退货单自身不重复出现）
    if (d.txn_type !== '采购退货' && d.status === 'posted' && this.can('returns', 'create')) {
      foot += `<button type="button" class="btn btn-outline" data-ib="to-return">↩ ${this.t('ret_from_inbound')}</button>`;
    }
    // 更正入口：已过账、非更正草稿、未被更正过（作废单不可再更正）
    if (!isCorrDraft && d.correction && d.correction.eligible && this.can('inbound', 'edit')) {
      foot += `<button type="button" class="btn btn-outline" data-ib="correct">✎ ${this.t('ibd_corr')}</button>`;
    }
    if (isDraft && this.can('inbound', 'delete')) {
      foot += `<button type="button" class="btn btn-danger" data-ib="del">${lines.length ? this.t('ibd_delete_draft') : this.t('ibd_delete_empty')}</button>`;
    }

    box.classList.toggle('ib-voided-panel', d.status === 'voided');
    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" data-ib="icl">← ${this.t('pu_back_list')}</button>
      ${this.crossLinkBackBtn('inbound', d.doc_no)}
      <div class="pu-insp-head">
        <div>
          <small>${typeLabel}</small>
          <h2>${this.ibEsc(d.doc_no)} ${this.docRevisionBadge(d.doc_no)}</h2>
          <span class="pu-badge">${this.ibdStatusBadge(d.status)}</span>
          ${d.status === 'voided' ? `<span class="badge badge-muted">${this.t('ibd_voided_badge')}</span>` : ''}
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" data-ib="wide" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}">${s.wide ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" data-ib="icl" title="${this.t('pu_close_detail')}">✕</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${this.ibEsc(m[0])}</dt><dd>${this.ibEsc(m[1])}</dd></div>`).join('')}</dl>
      ${this.ibCorrectionBarHtml(d)}
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" data-ib="dt" data-id="${k}">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="ib-dpanel"></div>
      <div class="pu-insp-foot">${foot}</div>`;
    this.ibRenderDetailPanel();
    this.ibUpdatePagerSticky();
  },

  // 更正留痕条：作废原单 ↔ 新单双向跳转；更正草稿可继续编辑
  ibCorrectionBarHtml(d) {
    const c = d.correction;
    if (!c) return '';
    const parts = [];
    if (d.status === 'voided') {
      parts.push(`<span class="ib-corr-void">${this.t('ibd_voided_banner', {
        time: this.fmtDateTime(d.voided_at) || '–',
        doc: ''
      })} ${String(d.corrected_by_doc_no || '') ? `<button type="button" class="pu-lk" data-ib="open" data-id="${this.ibEsc(d.corrected_by_doc_no)}">${this.ibEsc(d.corrected_by_doc_no)}</button>` : ''}</span>`);
    }
    if (String(d.corrects_doc_no || '')) {
      parts.push(`<span>${this.t('ibd_corr_from')} <button type="button" class="pu-lk" data-ib="open" data-id="${this.ibEsc(d.corrects_doc_no)}">${this.ibEsc(d.corrects_doc_no)}</button></span>`);
    } else if (String(d.corrected_by_doc_no || '') && d.status !== 'voided') {
      parts.push(`<span>${this.t('ibd_corr_to')} <button type="button" class="pu-lk" data-ib="open" data-id="${this.ibEsc(d.corrected_by_doc_no)}">${this.ibEsc(d.corrected_by_doc_no)}</button></span>`);
    }
    if (c.has_draft && String(c.draft_doc_no || '')) {
      parts.push(`<span>${this.t('ibd_corr_draft_link')} <button type="button" class="pu-lk" data-ib="open" data-id="${this.ibEsc(c.draft_doc_no)}">${this.ibEsc(c.draft_doc_no)}</button></span>`);
    }
    return parts.length ? `<div class="ib-corr-bar">${parts.join('<i>·</i>')}</div>` : '';
  },


  ibRenderDetailPanel() {
    const s = this.ibState();
    const box = document.getElementById('ib-dpanel');
    if (!box) return;
    const rec = this._ibDetailCache[s.sel];
    if (!rec || !rec.d) { box.innerHTML = ''; return; }
    const d = rec.d;
    if (s.dt === 'lines') return this.ibRenderLinesBody();
    if (s.dt === 'related') return this.ibRenderRelatedReturns(d);
    box.innerHTML = this.ibLogsPanel(d.logs || []);
  },

  // 关联单据行：一单一行（宽屏单行；窄栏自动折为两行）——六处关联列表共用
  // o.doc 必须是被渲染的那张单（类型/状态都取它自己的字段，不能取当前单据）
  relatedDocItemHtml(o) {
    const voided = String(o.doc.status || '') === 'voided';
    const cells = [];
    if (o.party) cells.push(`<span class="rel-cell rel-party"><small>${this.t('rel_party')}</small>${this.ibEsc(o.party)}</span>`);
    if (o.qty != null) cells.push(`<span class="rel-cell rel-qty"><small>${this.t('rel_qty_total')}</small><b>${this.fmtQty(Number(o.qty || 0))}</b></span>`);
    if (o.amount != null) cells.push(`<span class="rel-cell rel-amount"><small>${this.t('rel_amount_total')}</small><b>${this.fmtMoney(Number(o.amount || 0))}</b></span>`);
    if (o.note) cells.push(`<span class="rel-cell rel-note">${this.ibEsc(o.note)}</span>`);
    const jump = o.onClick || `App.crossDocJump('${o.target}','${this.ibEsc(o.doc.doc_no)}','${o.fromKind}','${this.ibEsc(o.fromDoc)}')`;
    return `<div class="rel-item${voided ? ' rel-item-voided' : ''}">
      <div class="rel-line">
        <button type="button" class="pu-lk rel-no" onclick="${jump.replace(/"/g, '&quot;')}">${this.ibEsc(o.doc.doc_no)}</button>
        <span class="rel-cell rel-date">${this.ibEsc(o.doc.date || '–')}</span>
        <span class="rel-cell rel-type">${this.ibEsc(o.typeLabel || '')}</span>
        <span class="rel-cell rel-status">${o.statusBadge || ''}</span>
        <i class="rel-break" aria-hidden="true"></i>
        ${cells.join('')}
      </div>
    </div>`;
  },

  // 关联退货单：列出以当前入库单为原单的采购退货（含草稿/已过账/已作废）
  ibRenderRelatedReturns(d) {
    const box = document.getElementById('ib-dpanel');
    if (!box) return;
    const rows = Array.isArray(d.related_returns) ? d.related_returns : [];
    if (!rows.length) {
      const key = d.txn_type === '采购退货' ? 'ibd_no_related_returns_self' : 'ibd_no_related_returns';
      box.innerHTML = `<div class="pu-empty">${this.t(key)}</div>`;
      return;
    }
    box.innerHTML = `<div class="rel-list">${rows.map(r => this.relatedDocItemHtml({
      target: 'returns',
      doc: r,
      fromKind: 'inbound',
      fromDoc: d.doc_no,
      typeLabel: this.ibTypeLabel(r.txn_type || '采购退货'),
      statusBadge: this.ibdStatusBadge(r.status),
      qty: r.total_qty,
      amount: r.total_amount,
    })).join('')}</div>`;
  },

  // --- 明细：手风琴（宽屏时切换为全表） ---
  ibRenderLinesBody() {
    const s = this.ibState();
    const box = document.getElementById('ib-dpanel');
    const rec = this._ibDetailCache[s.sel];
    if (!box || !rec || !rec.d) return;
    const d = rec.d;
    const lines = d.lines || [];
    if (s.wide) {
      this._tableRenderers['inbound_detail_lines'] = () => this.ibRenderLinesBody();
      box.innerHTML = `<div id="ib-lines-body">${this.ibDetailLinesTable(lines)}</div>`;
      return;
    }
    const f = lines.filter(l => {
      if (s.lq && !this.puKwMatch([l.code, l.material_name, l.material_spec, l.material_brand, l.contract_no, l.remarks].join(' '), s.lq)) return false;
      return true;
    });
    const shown = Math.min(s.lim, f.length);

    let html = `<div class="pu-lqtoolbar">
      <input id="ib_lqi" type="search" value="${this.ibEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}">
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
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" data-ib="ex" data-id="${l.id}" aria-expanded="${ex}">
          <span class="pu-line-n"><strong>${this.ibEsc(l.code)}</strong> ${this.ibEsc(l.material_name || '')} <span class="pu-mu">${this.ibEsc(l.material_spec || '')}</span></span>
          <span class="pu-line-q">${this.qtyCell(l.qty)}${this.ibEsc(l.material_unit || '')}</span>
        </button>
        ${ex ? `<div class="pu-line-d">
          <div class="pu-mu">${this.hasField(l, 'price') ? `${this.t('in_price')} ${this.fmtMoney(l.price)} · ${this.t('in_total_amount')} ${this.fmtMoney(l.amount)}` : ''}${l.contract_no ? `${this.hasField(l, 'price') ? ' · ' : ''}${this.t('in_contract')} ${this.ibEsc(l.contract_no)}` : ''}</div>
          ${l.remarks ? `<div>${this.t('pu_remarks')}：${this.ibEsc(l.remarks)}</div>` : ''}
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    if (f.length > s.lim) html += `<button type="button" class="btn btn-outline btn-sm pu-more" data-ib="more">${this.t('pu_more', { n: f.length - s.lim })}</button>`;
    box.innerHTML = html;
  },

  ibDetailLinesTable(lines) {
    const vp = lines.length > 0 && this.hasField(lines[0], 'price');
    const d = this._ibDetail || {};
    const tid = 'inbound_detail_lines';
    const cols = [
      ['code', this.t('mat_code'), r => this.ibEsc(r.code)],
      ['material_name', this.t('mat_name'), r => this.ibEsc(r.material_name || '')],
      ['material_spec', this.t('mat_spec'), r => this.ibEsc(r.material_spec || '')],
      ['material_brand', this.t('mat_brand'), r => this.ibEsc(r.material_brand || '')],
      ['material_unit', this.t('mat_unit'), r => this.ibEsc(r.material_unit || '')],
      ['contract_no', this.t('in_contract'), r => this.ibEsc(r.contract_no || d.contract_no || '')],
      ['qty', this.t('in_qty'), r => this.qtyCell(r.qty), true],
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

  ibLogLabel(a) {
    const m = {
      create: this.t('ibd_log_create'), edit: this.t('ibd_log_edit'), update: this.t('ibd_log_edit'),
      confirm: this.t('ibd_log_confirm'), post: this.t('ibd_log_confirm'), save: this.t('ibd_log_edit'),
      cancel: this.t('ibd_log_cancel'), void: this.t('ibd_log_cancel'), delete: this.t('ibd_log_delete'),
      add_line: this.t('ibd_log_edit'), update_line: this.t('ibd_log_edit'), delete_line: this.t('ibd_log_edit'),
    };
    return m[a] || a;
  },

  ibLogsPanel(logs) {
    if (!logs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    return `<ol class="pu-log">` + logs.map(l => {
      const detail = this.logDetailText(l);
      return `<li>
      <div>
        <strong>${this.ibEsc(this.ibLogLabel(l.action))}</strong>
        <span class="pu-log-meta">· ${this.ibEsc(l.name || l.username || l.operator || l.created_by || '')} · ${this.fmtDateTime(l.created_at)}</span>
        ${detail ? `<div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere">${this.ibEsc(detail)}</div>` : ''}
      </div>
    </li>`;
    }).join('') + '</ol>';
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
      case 'hist': s.hist = !s.hist; this.getTableState('inbound').page = 1; this.ibRenderFilters(); this.ibRenderList(); return;
      case 'clr': s.f = { kw: '', from: '', to: '' }; s.kpi = ''; this.getTableState('inbound').page = 1; this.ibRenderFilters(); this.ibRenderList(); return;
      case 'dense': s.dense = !s.dense; document.getElementById('ib-root').classList.toggle('ib-dense', s.dense); if (el) el.setAttribute('aria-pressed', String(s.dense)); return;
      case 'pg': this.getTableState('inbound').page += Number(id); this.ibRenderList(); return;
      case 'ex': { const k = String(id); if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k); this.ibRenderLinesBody(); return; }
      case 'more': s.lim += 15; this.ibRenderLinesBody(); return;
      case 'new': return this.newInboundDoc();
      case 'e-doc': return this.editInboundDoc(s.sel);
      case 'confirm': return this.confirmInboundDoc();
      case 'correct': return this.startInboundCorrection(s.sel);
      case 'del': return this.deleteInboundDoc(s.sel);
      case 'print': return this.ibPrintDoc();
      case 'export': return this.ibExportDoc();
      case 'to-return': return this.newInboundDoc('采购退货', s.sel);
    }
  },

  // ========== 单据打印 / 导出（组装通用 doc，细节由 02-ui-kit 统一处理） ==========
  ibDocModel() {
    const s = this.ibState();
    const rec = this._ibDetailCache[s.sel];
    if (!rec || !rec.d) return null;
    const d = rec.d;
    const lines = d.lines || [];
    // 导出/打印：金额列以明细是否带 price/amount 为准（无权限时服务端已删键）
    const vp = lines.length > 0 && this.hasField(lines[0], 'price');
    const showAmount = lines.length > 0 && this.hasField(lines[0], 'amount');
    const cols = [
      { label: this.t('mat_code'), key: 'code' },
      { label: this.t('mat_name'), key: 'material_name' },
      { label: this.t('mat_spec'), key: 'material_spec' },
      { label: this.t('mat_brand'), key: 'material_brand' },
      { label: this.t('mat_unit'), key: 'material_unit' },
      { label: this.t('in_contract'), value: r => r.contract_no || d.contract_no || '' },
      { label: this.t('in_qty'), align: 'right', value: r => this.fmtQty(r.qty) },
    ];
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
    if (showAmount) meta.push([this.t('in_total_amount'), this.fmtMoney(sum('amount'))]);
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
      draft: 'ibd_status_draft', posted: 'ibd_status_posted',
      voided: 'ibd_status_voided',
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

    // 更正草稿：加载原单当前明细，用于展示「当前数量」
    this._ibCorrection = null;
    if (detail.status === 'draft' && String(detail.corrects_doc_no || '')) {
      let info = null;
      try {
        info = await this.api('/api/inbound-docs/' + encodeURIComponent(detail.corrects_doc_no) + '/correction-info');
      } catch (e) { info = null; }
      const srcLines = (info && info.lines) || [];
      const current = Object.fromEntries(srcLines.map(l => [String(l.line_key || this.ibCorrKey(l)), Number(l.qty) || 0]));
      this._ibCorrection = {
        originalDocNo: detail.corrects_doc_no,
        originalDate: (info && info.original_date) || '',
        originalRemarks: (info && info.doc && info.doc.remarks) || '',
        current
      };
    }

    const corrCurrent = this._ibCorrection ? this._ibCorrection.current : null;
    this._ibEditLines = (detail.lines || []).map(l => {
      const mapped = {
        id: l.id,
        code: l.code,
        material_name: l.material_name,
        material_spec: l.material_spec,
        material_brand: l.material_brand,
        material_unit: l.material_unit,
        qty: Math.abs(Number(l.qty)),
        price: this.hasField(l, 'price') ? Math.abs(Number(l.price)) : '',
        remarks: l.remarks || '',
        contract_no: l.contract_no || '',
        po_no: l.po_no || '',
        origin_line_id: Number(l.origin_line_id) || 0,
        order_line_id: Number(l.order_line_id) || 0,
        source_doc_no: l.source_doc_no || ''
      };
      mapped._locked = !!corrCurrent && corrCurrent[this.ibCorrKey(mapped)] !== undefined;
      return mapped;
    });
    // 从采购单/合同「收货」进入时，自动载入未到货明细（数量留空待人工填写）
    if (this._ibEditLines.length === 0 && Array.isArray(preloadLines) && preloadLines.length > 0) {
      this._ibEditLines = preloadLines.map(l => ({ ...l }));
    }

    // 采购退货三档：关联档锁定来源行与单价，并载入实时可退量（排除本单据）
    this._ibReturnTier = String(detail.return_tier || '').trim();
    this._ibReturnLinked = detail.txn_type === '采购退货'
      && ['inbound', 'po', 'contract'].includes(this._ibReturnTier);
    this._ibNoOrigin = detail.txn_type === '采购退货' && this._ibReturnTier === 'none';
    this._ibReturnSourceMap = null;
    if (this._ibReturnLinked) {
      let srcUrl = '';
      if (this._ibReturnTier === 'inbound') {
        srcUrl = '/api/returns/purchase/origin-lines?docNo=' + encodeURIComponent(detail.origin_doc_no || '')
          + '&excludeDocNo=' + encodeURIComponent(docNo);
      } else {
        srcUrl = '/api/returns/purchase/scope-lines?scope=' + encodeURIComponent(this._ibReturnTier)
          + '&refNo=' + encodeURIComponent(detail.return_ref_no || '')
          + '&excludeDocNo=' + encodeURIComponent(docNo);
      }
      try {
        const sources = await this.api(srcUrl);
        this._ibReturnSourceMap = Object.fromEntries((sources || []).map(s => [String(s.id), s]));
      } catch (e) { this._ibReturnSourceMap = null; }
      this._ibEditLines.forEach(l => {
        const src = this._ibReturnSourceMap && l.origin_line_id
          ? this._ibReturnSourceMap[String(l.origin_line_id)] : null;
        if (src) {
          l.max_qty = Number(src.available) || 0;
          l.available = l.max_qty;
          l.source_doc_no = src.doc_no || l.source_doc_no || '';
        } else if (l.max_qty === undefined) {
          l.max_qty = 0;
        }
      });
    }

    // 采购入库（含更正草稿）：加载单头来源与该来源的全量采购行（未到货展示、物料范围、超收校验共用）
    // 更正草稿来源继承原单单头（只读、不换来源），因此不加载候选清单，只按继承的来源取采购行
    this._ibSource = null;
    this._ibSourceLines = [];
    this._ibSourceList = [];
    if (detail.txn_type === '采购入库') {
      const poNo = String(detail.po_no || '').trim();
      const ctNo = String(detail.contract_no || '').trim();
      const isCorrDoc = !!String(detail.corrects_doc_no || '').trim();
      this._ibSource = poNo ? { kind: 'po', no: poNo } : (ctNo ? { kind: 'contract', no: ctNo } : null);
      if (!isCorrDoc) this._ibSourceList = await this.api('/api/purchase/inbound-sources').catch(() => []);
      if (this._ibSource) {
        const qs = this._ibSource.kind === 'po' ? 'poNo=' : 'contractNo=';
        // 更正草稿：原单确认后会被作废，取基准时要把原单自身的已过账量还回去
        const exDocNo = isCorrDoc && String(detail.status) === 'draft' ? String(detail.corrects_doc_no || '').trim() : '';
        const ex = exDocNo ? '&excludeDocNo=' + encodeURIComponent(exDocNo) : '';
        this._ibSourceLines = await this.api('/api/purchase/inbound-scope-lines?' + qs + encodeURIComponent(this._ibSource.no) + ex).catch(() => []);
      }
    }

    // 加载物料和库存数据（可用库存列只在零星入库/采购退货无原单档使用）
    const materials = await this.api('/api/materials');
    this._materialsCache = materials;
    let stockMap = {};
    if (detail.txn_type !== '采购入库') {
      try {
        const stock = await this.api('/api/stock-summary');
        stockMap = Object.fromEntries(stock.map(s => [s.code, s.on_hand]));
      } catch (e) {}
    }
    this._inboundStockMap = stockMap;

    const typeLabel = this.ibTypeLabel(detail.txn_type);
    const isReturn = detail.txn_type === '采购退货';
    const isCorr = !!String(detail.corrects_doc_no || '').trim();
    const backNo = isCorr ? detail.corrects_doc_no : docNo;

    this.setMain(this.pageWrap((isCorr ? '✎ ' : '✏️ ') + (isCorr ? detail.corrects_doc_no : detail.doc_no),
      `${this.t(isCorr ? 'ibd_corr_title' : (isReturn ? 'ibd_edit_title_return' : 'ibd_edit_title'))} · ${typeLabel}`, '',
      `<div id="ib-edit-root" class="data-page">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.backToInboundDetail('${backNo}')">← ${this.t('ibd_back_detail')}</span>
          ${this.ibdStatusBadge(detail.status)}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('pu_section_header')}</div></div>
          <div id="ib-edit-form"></div>
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>02</span><div>${isReturn ? this.t('ibd_section_lines_return') : (isCorr ? this.t('ibd_corr_section_lines') : this.t('ibd_section_lines'))}<small id="ib-edit-line-count"></small></div></div>
          <div id="ib-edit-lines"></div>
        </div>
        <div class="pu-edit-actions" id="ib-edit-buttons"></div>
      </div>`));

    this.renderInboundEdit();
  },

  renderInboundEdit() {
    const d = this._ibDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const typeLabel = this.ibTypeLabel(d.txn_type);
    const isOther = d.txn_type === '零星入库';
    const isReturn = d.txn_type === '采购退货';
    const tier = this._ibReturnTier || '';
    const linked = !!this._ibReturnLinked;
    const supOptions = (this._ibSupplierList || []).map(s => `<option value="${this.ibEsc(s.name)}"></option>`).join('');

    // 01 单据信息（草稿态可编辑；过账后仅提示不可改）
    const formEl = document.getElementById('ib-edit-form');
    if (formEl) {
      if (this._ibCorrection) {
        const corr = this._ibCorrection;
        formEl.innerHTML = `<div class="form-grid" style="max-width:none">
          <div class="form-group"><label>${this.t('ibd_no')}</label><input id="ib_e_no" value="${this.ibEsc(d.doc_no)}" readonly></div>
          <div class="form-group"><label>${this.t('ibd_date')}</label><input id="ib_e_date" type="date" value="${this.fmtDate(corr.originalDate || d.date)}" readonly></div>
          <div class="form-group"><label>${this.t('ibd_type')}</label><input id="ib_e_type" value="${this.ibEsc(typeLabel)}" readonly></div>
          <div class="form-group"><label>${this.t('ibd_corr_from')}</label><input value="${this.ibEsc(corr.originalDocNo)}" readonly></div>
          <div class="form-group"><label>${isOther ? this.t('ibd_source_unit') : this.t('ibd_supplier')}</label><input value="${this.ibEsc(d.supplier || '')}" readonly></div>
          <div class="form-group"><label>${this.t('ibd_handler')}</label><input value="${this.ibEsc(d.handler || '')}" readonly></div>
          <div class="form-group"><label>${this.t('in_po_no')}</label><input value="${this.ibEsc(d.po_no || '')}" readonly></div>
          <div class="form-group"><label>${this.t('in_contract')}</label><input value="${this.ibEsc(d.contract_no || '')}" readonly></div>
          <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_remarks')}</label><textarea id="ib_e_remarks" rows="2">${this.ibEsc(d.remarks || '')}</textarea></div>
          <div class="form-group" style="grid-column:1/-1"><div class="ib-posted-hint" style="margin:0">${this.t('ibd_corr_prefill_hint')}</div></div>
        </div>`;
      } else if (isDraft) {
        // 字段排布与采购编辑页一致：单据号(只读) → 日期 → 类型(只读) → 供应商/来源单位 → 经手人 → [采购单号 → 合同号] → 备注(整行)
        const supLabel = isOther ? this.t('ibd_source_unit') : this.t('ibd_supplier') + ' *';
        const supPlaceholder = isOther ? this.t('ibd_source_unit_ph') : '';
        let poFields = '';
        if (isOther) {
          poFields = '';
        } else if (isReturn) {
          // 采购退货只认原入库单（只读展示，来源在新建时选定）
          const originNo = tier === 'inbound' ? (d.origin_doc_no || '') : (d.return_ref_no || '');
          poFields = `<div class="form-group" style="grid-column:1/-1"><label>${this.t('ret_origin_inbound_doc')}</label><input value="${this.ibEsc(originNo)}" readonly></div>`;
        } else {
          const curVal = this._ibSource ? `${this._ibSource.kind}:${this._ibSource.no}` : '';
          poFields = `
            <div class="form-group"><label>${this.t('ibd_source')} *</label><select id="ib_e_source" onchange="App.ibOnEditSourceChange(this)"><option value="">${this.t('ibd_src_pick')}</option>${this.ibSourceOptionsHtml(curVal)}</select></div>
            <div class="form-group"><label>${this.t('ibd_source_refs')}</label><input id="ib_e_source_refs" value="${this.ibEsc(this.ibSourceRefsText())}" readonly></div>`;
        }
        const lockHint = linked
          ? `<div class="form-group" style="grid-column:1/-1"><div class="ib-posted-hint" style="margin:0">${this.t('ret_line_origin_locked')}</div></div>` : '';
        formEl.innerHTML = `<div class="form-grid" style="max-width:none">
          <div class="form-group"><label>${this.t('ibd_no')}</label><input id="ib_e_no" value="${this.ibEsc(d.doc_no)}" readonly></div>
          <div class="form-group"><label>${this.t('ibd_date')} *</label><input id="ib_e_date" type="date" value="${this.fmtDate(d.date)}"></div>
          <div class="form-group"><label>${isReturn ? this.t('ibd_doc_type') : this.t('ibd_type')}</label><input id="ib_e_type" value="${this.ibEsc(typeLabel)}" readonly></div>
          <div class="form-group"><label>${supLabel}</label><input id="ib_e_supplier" list="ib_e_sup_list" autocomplete="off" placeholder="${supPlaceholder}" value="${this.ibEsc(d.supplier || '')}"><datalist id="ib_e_sup_list">${supOptions}</datalist><div class="form-error"></div></div>
          <div class="form-group"><label>${this.t('ibd_handler')}</label><input id="ib_e_handler" value="${this.ibEsc(d.handler || '')}"></div>${poFields}${lockHint}
          <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_remarks')}</label><textarea id="ib_e_remarks" rows="2">${this.ibEsc(d.remarks || '')}</textarea></div>
        </div>`;
      } else {
        formEl.innerHTML = `<div class="ib-posted-hint">${this.t('ibd_posted_hint')}</div>`;
      }
    }

    // 底部操作行（对齐采购编辑页：添加明细 → 保存草稿 → 确认）
    const btnBox = document.getElementById('ib-edit-buttons');
    if (btnBox) {
      if (this._ibCorrection) {
        btnBox.innerHTML = `<button class="btn btn-outline" onclick="App.addInboundEditRow()">+ ${this.t('ibd_add_line')}</button>
           <button class="btn btn-outline" onclick="App.saveInboundDraft()">${this.t('ibd_corr_save')}</button>
           <button class="btn btn-primary" onclick="App.confirmCorrectionDoc()">✅ ${this.t('ibd_corr_confirm')}</button>`;
      } else {
        btnBox.innerHTML = isDraft
          ? `${linked ? '' : `<button class="btn btn-outline" onclick="App.addInboundEditRow()">+ ${this.t('ibd_add_line')}</button>`}
             <button class="btn btn-outline" onclick="App.saveInboundDraft()">${this.t('ibd_save_draft')}</button>
             <button class="btn btn-primary" onclick="App.confirmInboundDocFromEdit()">${this.t(isReturn ? 'ibd_confirm_return' : 'ibd_confirm')}</button>`
          : '';
      }
    }

    this.renderInboundEditTable();
  },

  // 添加空行
  addInboundEditRow() {
    if (this._ibReturnLinked) return; // 关联档的来源行已锁定，不允许新增
    const d = this._ibDetail;
    const corr = this._ibCorrection;
    // 采购入库的明细只能从单头来源的采购行里选（更正草稿的来源继承原单）
    if (d && d.txn_type === '采购入库') {
      if (!this._ibSource && !corr) { this.toast(this.t('ibd_source_required_first'), 'error'); return; }
      if (this._ibSource) {
        const pending = (this._ibSourceLines || []).filter(x => Number(x.unreceived_qty) > 0);
        if (!pending.length) { this.toast(this.t('ibd_no_unreceived_lines'), 'error'); return; }
      }
    }
    if (!this._ibEditLines) this._ibEditLines = [];
    this._ibEditLines.push({
      code: '', qty: '', price: '', remarks: '',
      po_no: (this._ibSource && this._ibSource.kind === 'po') ? this._ibSource.no : '',
      contract_no: (this._ibSource && this._ibSource.kind === 'contract') ? this._ibSource.no : '',
      order_line_id: 0, _locked: false
    });
    this.renderInboundEditTable();
  },

  // 只重渲染 02 明细区（物料筛选条 + 明细表 + 汇总），不重建 01 表单与底部按钮
  renderInboundEditTable() {
    this.msClose();
    const d = this._ibDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const linked = !!this._ibReturnLinked;
    const corr = this._ibCorrection;
    const isCorr = !!corr;
    const isPurchaseIn = d.txn_type === '采购入库';           // 物料只能从来源采购行里选（含更正草稿新增行）
    const isPurchaseInCol = isPurchaseIn && !isCorr;          // 「未到货」参照列只用于普通采购入库（更正列仍是当前有效数量）
    const lines = this._ibEditLines || [];
    // 单价列：已有明细按字段是否下发判断；空草稿（新增行场景）退回角色判断
    const vp = lines.length > 0 ? this.hasField(lines[0], 'price') : this.canViewPrice();
    const mats = this._materialsCache || [];
    const colCount = 7 + (vp ? 2 : 0) + ((isCorr && isPurchaseIn) ? 1 : 0);

    // 参照列：普通采购入库「未到货」；更正采购入库「未到货」+「当前有效数量」两列并存；
    // 关联档「可退量」；其他类型「可用库存」
    let refCols;
    if (linked) {
      refCols = `<th class="text-right">${this.t('ret_remaining_qty')}</th>`;
    } else if (isCorr) {
      refCols = (isPurchaseIn
        ? `<th class="text-right" title="${this.ibEsc(this.t('ibd_corr_unreceived_col_title'))}">${this.t('ibd_unreceived')}</th>` : '')
        + `<th class="text-right" title="${this.ibEsc(this.t('ibd_corr_current_qty_title'))}">${this.t('ibd_corr_current_qty')}</th>`;
    } else {
      refCols = `<th class="text-right">${isPurchaseIn ? this.t('ibd_unreceived') : this.t('out_available')}</th>`;
    }

    // 列序对齐采购编辑页：物料 / 数量 / 单价 / 行金额 / 合同号 / 备注 / 只读参照列 / 删除
    const headHtml = `<tr>
      <th>${this.t('pu_material')}</th>
      <th>${isCorr ? this.t('ibd_corr_target_qty') : this.t('in_qty')}</th>
      ${vp ? `<th>${this.t('in_price')}</th><th class="text-right">${this.t('pu_line_amount')}</th>` : ''}
      <th>${linked ? this.t('ret_source_doc') : this.t('in_contract')}</th>
      <th>${this.t('in_remarks')}</th>
      ${refCols}
      <th></th>
    </tr>`;

    let tbody = '';
    if (lines.length === 0) {
      tbody = `<tr><td colspan="${colCount}" style="text-align:center;padding:26px;color:var(--text-muted)">
        ${this.t('ibd_no_lines')}
        ${isCorr ? `<div style="margin-top:8px;color:var(--warning)">${this.t('ibd_corr_void_only_hint')}</div>` : ''}
        ${isDraft && !linked ? `<div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="App.addInboundEditRow()">+ ${this.t('ibd_add_line')}</button></div>` : ''}
      </td></tr>`;
    } else {
      tbody = lines.map((l, i) => {
        // 采购退货关联档：可退量取后端实时额度；更正：展示当前有效数量；其他类型取库存
        const linkedMax = linked ? (l.max_qty === undefined ? (l.available || 0) : l.max_qty) : null;
        let available;
        let availTitle = '';
        if (isPurchaseInCol) {
          const oid = Number(l.order_line_id) || 0;
          const src = oid ? (this._ibSourceLines || []).find(x => Number(x.id) === oid) : null;
          if (src) {
            const base = Number(src.unreceived_qty) || 0;
            // 草稿：未到货 − 本单已填（同一采购行拆多行只扣一次）；已过账：未到货已含本单
            const filled = isDraft ? lines.reduce((s, x) =>
              s + (Number(x.order_line_id) === oid ? Math.abs(Number(x.qty) || 0) : 0), 0) : 0;
            available = base - filled;
            availTitle = isDraft
              ? `${this.t('ibd_unreceived')} ${this.fmtQty(base)}（${this.t('ibd_not_this_doc')}）· ${this.t('ibd_filled_this_doc')} ${this.fmtQty(filled)}`
              : `${this.t('ibd_unreceived')} ${this.fmtQty(base)}`;
          } else {
            available = null;
          }
        } else {
          available = isCorr
            ? (corr.current[this.ibCorrKey(l)] !== undefined ? corr.current[this.ibCorrKey(l)] : 0)
            : (linked ? linkedMax : this._inboundStockMap[l.code]);
        }
        const availText = available === undefined || available === null ? '-' : this.fmtQty(available);
        const availCls = available === undefined || available === null ? 'num-zero'
          : (available < 0 ? 'num-neg' : (available === 0 ? 'num-warn' : ''));
        // 更正采购入库：另加一列「未到货」。更正单确认后原单作废，
        // 基准 = 该采购行可到总量（订单量 − 排除原单后的已过账量，_ibSourceLines 已按 excludeDocNo 取数），
        // 再减本单该采购行目标数量合计（同一采购行拆多行只扣一次）
        let corrUnrec = null;
        let corrUnrecTitle = '';
        if (isCorr && isPurchaseIn) {
          const oid = Number(l.order_line_id) || 0;
          const srcLine = oid ? (this._ibSourceLines || []).find(x => Number(x.id) === oid) : null;
          if (srcLine) {
            const base = Number(srcLine.unreceived_qty) || 0;
            const filled = isDraft ? lines.reduce((s, x) =>
              s + (Number(x.order_line_id) === oid ? Math.abs(Number(x.qty) || 0) : 0), 0) : 0;
            corrUnrec = base - filled;
            corrUnrecTitle = this.t('ibd_corr_unreceived_title', {
              base: this.fmtQty(base), filled: this.fmtQty(filled), remaining: this.fmtQty(corrUnrec)
            });
          }
        }
        const corrUnrecText = corrUnrec === null ? '-' : this.fmtQty(corrUnrec);
        const corrUnrecColor = corrUnrec === null ? 'var(--text-muted)'
          : (corrUnrec < 0 ? 'var(--danger)' : (corrUnrec === 0 ? 'var(--warning)' : 'var(--success)'));
        const corrUnrecCell = (isCorr && isPurchaseIn)
          ? `<td class="pu-edit-amt" style="font-size:12px;color:${corrUnrecColor}"${corrUnrecTitle ? ` title="${this.ibEsc(corrUnrecTitle)}"` : ''}>${corrUnrecText}</td>`
          : '';
        const contract = isCorr
          ? [l.po_no || d.po_no || '', l.contract_no || d.contract_no || ''].filter(Boolean).join(' · ')
          : (linked ? (l.source_doc_no || '') : (l.contract_no || d.contract_no || ''));
        const amt = (Number(l.qty) || 0) * (Number(l.price) || 0);

        if (!isDraft) {
          const qty = Number(l.qty) || 0;
          return `<tr>
            <td>${this.ibLineLabel(l)}</td>
            <td${qty < 0 ? ' class="num-neg"' : ''}>${this.fmtQty(qty)}</td>
            ${vp ? `<td>${this.fmtMoney(l.price)}</td><td class="pu-edit-amt">${this.fmtMoney(amt)}</td>` : ''}
            <td style="font-size:12px">${contract}</td>
            <td>${l.remarks || ''}</td>
            ${corrUnrecCell}
            <td class="pu-edit-amt${availCls ? ' ' + availCls : ''}"${isCorr ? ` title="${this.ibEsc(this.t('ibd_corr_current_qty_title'))}"` : ''}>${availText}</td>
            <td></td>
          </tr>`;
        }
        // 关联档 / 更正预填行：物料与单价锁定为原入库行，只允许修改数量与备注
        // 采购入库：已选定采购明细行的行锁定物料；未选来源时不允许再换物料
        // 更正草稿：继承自原单的行（_locked）保持只读展示，即使已不在来源范围内也不重选；新增行按来源选采购行
        const lockMat = linked || (isCorr && !!l._locked)
          || (isPurchaseIn && (Number(l.order_line_id) > 0 || (!this._ibSource && !isCorr)));
        let matCell;
        if (lockMat) {
          const outOfScope = isPurchaseIn && !!l._outOfScope;
          matCell = `<div style="font-size:13px">${this.ibLineLabel(l)}` +
            `${outOfScope ? `<small class="ib-out-scope"> ${this.t('ibd_line_out_of_scope')}</small>` : ''}</div>`;
        } else if (isPurchaseIn && (!isCorr || this._ibSource)) {
          matCell = `<select class="ib-line-ol" data-idx="${i}" onchange="App.ibPickOrderLine(${i}, this.value)">${this.ibOrderLineOpts(l)}</select>`;
        } else {
          matCell = `<select class="ib-line-mat" data-idx="${i}" onchange="App.ibEditSet(${i},'code',this.value)">${this.ibMatOpts(l.code)}</select>`;
        }
        const lockPrice = linked || isCorr;
        const priceCell = lockPrice
          ? `<td>${this.fmtMoney(l.price)}</td>`
          : `<td style="min-width:100px"><input type="number" step="0.01" min="0" value="${l.price === null || l.price === undefined ? '' : l.price}" oninput="App.ibEditSet(${i},'price',this.value)"></td>`;
        const qtyMax = linked ? ` max="${linkedMax}"` : '';
        const qtyMin = isCorr ? '0' : '0.01';
        return `<tr>
          <td style="min-width:220px">${matCell}</td>
          <td style="min-width:100px"><input type="number" step="0.01" min="${qtyMin}"${qtyMax} value="${l.qty === null || l.qty === undefined ? '' : l.qty}" oninput="App.ibEditQtyInput(${i}, this)" onpaste="App.qtyPaste(event)"></td>
          ${vp ? `${priceCell}
          <td class="pu-edit-amt" data-line-amount="${i}">${this.fmtMoney(amt)}</td>` : ''}
          <td style="min-width:120px;font-size:12px">${contract}</td>
          <td style="min-width:140px"><input value="${this.ibEsc(l.remarks || '')}" oninput="App.ibEditSet(${i},'remarks',this.value)"></td>
          ${corrUnrecCell}
          <td class="pu-edit-amt${availCls ? ' ' + availCls : ''}" style="font-size:12px"${(availTitle || isCorr) ? ` title="${this.ibEsc(isCorr ? this.t('ibd_corr_current_qty_title') : availTitle)}"` : ''}>${availText}</td>
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
      // 采购入库：候选限定在单头来源的未到货采购行内；点选即按采购行加入明细。
      // 采购退货关联档的物料来自原入库单，不能越出可退范围，不渲染筛选条。
      if (isDraft && !linked) {
        if (isPurchaseIn) {
          const pending = (this._ibSourceLines || []).filter(x => Number(x.unreceived_qty) > 0);
          filterHtml = `<div class="pu-matfilter">
            <span class="pu-msearch-host"><input id="ib_ol_kw" type="search" value="" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}" oninput="App.ibOlKwInput(this)" onfocus="App.ibOlMsOpen(this)" onblur="App.msBlur()" onkeydown="App.msKey(event)" oncompositionstart="App.msCompositionStart()" oncompositionend="App.msCompositionEnd(this)"></span>
            <span class="pu-mu" id="ib_ol_cnt">${pending.length}</span>
            ${isCorr ? `<button type="button" class="btn btn-outline btn-sm" onclick="App.loadInboundCorrectionPending()">${this.t('ibd_corr_load_pending')}</button>` : ''}
          </div>`;
        } else {
          const cats = [...new Set(mats.map(m => m.category).filter(Boolean))].sort();
          const catOpts = `<option value="">${this.t('all')}</option>` + cats.map(c =>
            `<option value="${this.ibEsc(c)}"${this._ibMatCat === c ? ' selected' : ''}>${this.ibEsc(c)}</option>`).join('');
          filterHtml = `<div class="pu-matfilter">
            <label>${this.t('mat_category')}<select id="ib_mat_cat">${catOpts}</select></label>
            <span class="pu-msearch-host"><input id="ib_mat_kw" type="search" value="${this.ibEsc(this._ibMatKw || '')}" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}" oninput="App.ibMatKwInput(this)" onfocus="App.ibMsOpen(this)" onblur="App.msBlur()" onkeydown="App.msKey(event)" oncompositionstart="App.msCompositionStart()" oncompositionend="App.msCompositionEnd(this)"></span>
            <span class="pu-mu" id="ib_mat_cnt">${this.ibMatFiltered().length} / ${mats.length}</span>
            ${isCorr ? `<button type="button" class="btn btn-outline btn-sm" onclick="App.loadInboundCorrectionPending()">${this.t('ibd_corr_load_pending')}</button>` : ''}
          </div>`;
        }
      }
      box.innerHTML = filterHtml + `<div id="ib-over-hint" class="ib-over-hint" style="display:none"></div>`
        + `<div class="table-wrap"><table class="pu-edit-lines"><thead>${headHtml}</thead><tbody>${tbody}</tbody></table></div>` + sumHtml;
    }
    this.ibMarkOverReceipt();
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

  // 采购明细行下拉：只列该来源下还有未到货的采购行（当前行即使已到齐也保留）
  // 选中即确定 order_line_id、单价与未到货，来源由此定死
  ibOrderLineOpts(l) {
    const oid = Number(l.order_line_id) || 0;
    const list = (this._ibSourceLines || []).filter(x => Number(x.unreceived_qty) > 0 || Number(x.id) === oid);
    // 存量行没有 order_line_id 时，按物料编码唯一匹配回显，避免下拉空白
    const fallbackId = oid || (() => {
      const same = (this._ibSourceLines || []).filter(x => String(x.code) === String(l.code || ''));
      return same.length === 1 ? Number(same[0].id) : 0;
    })();
    // 单价未下发（无价格权限）时下拉与选中行都不带单价，保存时由服务端按订单行推导
    const label = x => `${x.po_no || ''} · ${x.material_name || x.code}` +
      `${x.material_spec ? ' ' + x.material_spec : ''}${this.hasField(x, 'order_price') ? ' · ' + this.fmtMoney(x.order_price) : ''} · ${this.t('ibd_unreceived')} ${this.fmtQty(x.unreceived_qty)}`;
    return `<option value="">${this.t('ibd_order_line_pick')}</option>` + list.map(x =>
      `<option value="${x.id}"${Number(x.id) === fallbackId ? ' selected' : ''}>${this.ibEsc(label(x))}</option>`).join('');
  },

  ibPickOrderLine(idx, val) {
    const l = (this._ibEditLines || [])[idx];
    const oid = Number(val) || 0;
    if (!l || !oid) return;
    const src = (this._ibSourceLines || []).find(x => Number(x.id) === oid);
    if (!src) return;
    l.order_line_id = oid;
    l.code = src.code;
    l.po_no = src.po_no || '';
    l.contract_no = src.contract_no_eff || '';
    l.material_name = src.material_name || '';
    l.material_spec = src.material_spec || '';
    l.material_brand = src.material_brand || '';
    l.material_unit = src.material_unit || '';
    if (this.hasField(src, 'order_price')) l.price = Number(src.order_price) || 0;
    l._outOfScope = false;
    this.renderInboundEditTable();
  },

  // 超收明细：同一采购行在本单拆多行时按行合计判断，不是逐行各自比对
  ibOverReceiptDetails() {
    const d = this._ibDetail;
    // 更正草稿同样参与超收判断：基准来自按 excludeDocNo 取出的来源采购行（已把原单过账量还回）
    if (!d || d.txn_type !== '采购入库' || !this._ibSource) return [];
    const lines = this._ibEditLines || [];
    const groups = new Map();
    lines.forEach((l, i) => {
      if (Number(l.origin_line_id) > 0) return;
      const oid = Number(l.order_line_id) || 0;
      const code = String(l.code || '').trim();
      if (!code) return;
      let base;
      if (oid > 0) {
        const src = (this._ibSourceLines || []).find(x => Number(x.id) === oid);
        if (!src) return;
        base = Number(src.unreceived_qty) || 0;
      } else {
        const same = (this._ibSourceLines || []).filter(x => x.code === code);
        if (!same.length) return;
        base = same.reduce((s, x) => s + (Number(x.unreceived_qty) || 0), 0);
      }
      const key = oid > 0 ? 'OL:' + oid : 'MC:' + code;
      if (!groups.has(key)) groups.set(key, { line_no: i + 1, code, order_line_id: oid, unreceived: base, requested: 0 });
      groups.get(key).requested += Math.abs(Number(l.qty) || 0);
    });
    return [...groups.values()]
      .filter(g => g.requested > g.unreceived + 1e-6)
      .map(g => ({ ...g, over: Math.round((g.requested - g.unreceived) * 100) / 100 }));
  },

  // 输入时即时提示超收（软拦截：允许继续填，提交时二次确认），并给具体数字
  ibMarkOverReceipt() {
    const hint = document.getElementById('ib-over-hint');
    if (!hint) return;
    const overs = this.ibOverReceiptDetails();
    const overOids = new Set(overs.filter(o => o.order_line_id > 0).map(o => o.order_line_id));
    document.querySelectorAll('#ib-edit-lines tbody tr').forEach((tr, i) => {
      const l = (this._ibEditLines || [])[i];
      const input = tr.querySelector('input[type="number"]');
      if (!input) return;
      input.classList.toggle('ib-qty-over', !!(l && overOids.has(Number(l.order_line_id))));
    });
    if (!overs.length) { hint.style.display = 'none'; hint.innerHTML = ''; return; }
    hint.style.display = '';
    hint.innerHTML = overs.map(o => this.t('ibd_over_receipt_line', {
      n: o.line_no, code: o.code,
      unreceived: this.fmtQty(o.unreceived),
      requested: this.fmtQty(o.requested),
      over: this.fmtQty(o.over),
    })).join('<br>') + `<div class="ib-over-hint-tip">${this.t('ibd_over_receipt_soft_tip')}</div>`;
  },

  // ========== 添加明细：物料即时搜索 ==========
  // 零星入库用全量物料；采购入库用所选来源的未到货采购行（见 ibOlMsOpen）
  ibMatKwInput(el) {
    this._ibMatKw = (el && el.value) || '';
    this.ibRefreshMatOptions();
    if (!this._ms || this._ms.input !== el) this.ibMsOpen(el);
    else this.msInput(el);
  },

  ibMsOpen(el) {
    if (this._msSuppressFocus) return;
    this.msOpen(el, {
      mode: 'materials',
      category: () => this._ibMatCat || '',
      stockOf: code => (this._inboundStockMap || {})[code],
      isAdded: m => (this._ibEditLines || []).some(l => l.code === m.code),
      onPick: m => this.ibAddFromSearch(m),
    });
  },

  ibAddFromSearch(m) {
    if (!this._ibEditLines) this._ibEditLines = [];
    this._ibMatKw = '';
    const price = this.hasField(m, 'opening_price') ? (m.opening_price || '') : '';
    this._ibEditLines.push({ code: m.code, qty: '', price, remarks: '', order_line_id: 0, _locked: false });
    this.renderInboundEditTable();
  },

  ibOlKwInput(el) {
    if (!this._ms || this._ms.input !== el) this.ibOlMsOpen(el);
    else this.msInput(el);
  },

  ibOlMsOpen(el) {
    if (this._msSuppressFocus) return;
    this.msOpen(el, {
      mode: 'lines',
      rows: () => (this._ibSourceLines || []).filter(x => Number(x.unreceived_qty) > 0),
      sourceReady: () => !!this._ibSource,
      stockOf: code => (this._inboundStockMap || {})[code],
      isAdded: src => (this._ibEditLines || []).some(l => Number(l.order_line_id) === Number(src.id)),
      onPick: src => this.ibAddOrderLineFromSearch(src),
    });
  },

  // 点选采购行：字段与 ibPickOrderLine 完全一致，保证超收按 OL:<id> 分组校验
  ibAddOrderLineFromSearch(src) {
    if (!this._ibEditLines) this._ibEditLines = [];
    this._ibEditLines.push({
      code: src.code,
      qty: '',
      price: this.hasField(src, 'order_price') ? (Number(src.order_price) || 0) : '',
      remarks: '',
      po_no: src.po_no || '',
      contract_no: src.contract_no_eff || '',
      order_line_id: Number(src.id) || 0,
      material_name: src.material_name || '',
      material_spec: src.material_spec || '',
      material_brand: src.material_brand || '',
      material_unit: src.material_unit || '',
      _outOfScope: false,
      _locked: false,
    });
    this.renderInboundEditTable();
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
      if (m && this.hasField(m, 'opening_price') && (l.price === '' || l.price === null || l.price === undefined)) l.price = m.opening_price || '';
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
      this.ibMarkOverReceipt();
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
    // 汇总金额块只在有价格权限时渲染，用 DOM 是否存在判断，避免再走角色分支
    if (document.getElementById('ib_es_amt')) set('ib_es_amt', this.fmtMoney(totalAmount));
  },

  // 删除明细行（只删当前行，不影响其他物料）
  removeInboundEditRow(idx) {
    if (!this._ibEditLines) return;
    this._ibEditLines.splice(idx, 1);
    this.renderInboundEditTable();
  },

  // 明细行校验：数量必须为正数、单价不能为负；0/非法值显式报错，不再静默丢行
  // 更正草稿例外：数量为目标值，允许 0（表示该行删除），同单内行身份不得重复
  // 编辑页单价列是否可见：已有明细看接口是否下发 price；空草稿（新增行）退回角色判断
  ibEditPriceVisible() {
    const lines = this._ibEditLines || [];
    return lines.length > 0 ? this.hasField(lines[0], 'price') : this.canViewPrice();
  },

  ibValidateEditLines() {
    const lines = this._ibEditLines || [];
    const linked = !!this._ibReturnLinked;
    const corr = this._ibCorrection;
    const priceVisible = this.ibEditPriceVisible();
    const seenKeys = new Map();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // 完全空行（点了添加但未填任何内容）允许忽略
      if (!l.code && !l.qty && !l.price && !l.remarks) continue;
      if (!l.code) return { ok: false, message: this.t('line_material_required', { n: i + 1 }) };
      if (corr) {
        const n = Number(l.qty);
        if (l.qty === '' || l.qty === null || l.qty === undefined || !Number.isFinite(n) || n < 0) {
          return { ok: false, message: this.t('qty_line_invalid', { n: i + 1 }) };
        }
        if (n === 0) continue; // 目标 0 = 删除该行，不参与重复校验
        const key = this.ibCorrKey(l);
        if (seenKeys.has(key)) {
          return { ok: false, message: this.t('ibd_corr_duplicate_line', { n: i + 1, prev: seenKeys.get(key) + 1, code: l.code }) };
        }
        seenKeys.set(key, i);
        continue;
      }
      // 关联档来源行：数量留空/为 0 表示本次不退货，跳过该行
      if (linked && (l.qty === '' || l.qty === null || l.qty === undefined || Number(l.qty) === 0)) continue;
      if (!this.qtyIsValid(l.qty)) return { ok: false, message: this.t('qty_line_invalid', { n: i + 1 }) };
      // 无价格权限时单价列不渲染，不做单价校验（保存时由服务端推导）
      if (priceVisible && !this.priceIsValid(l.price)) return { ok: false, message: this.t('price_line_invalid', { n: i + 1 }) };
      if (linked) {
        const max = l.max_qty === undefined ? (l.available || 0) : l.max_qty;
        if (Number(l.qty) > Number(max) + 1e-4) {
          return { ok: false, message: this.t('ret_qty_over_available', { n: i + 1, max: this.fmtQty(max) }) };
        }
      }
    }
    if (corr && seenKeys.size === 0) {
      return { ok: true }; // 一行不剩 = 整单作废，不生成新单
    }
    return { ok: true };
  },

  // 关联档只提交填写了数量的来源行；更正只提交目标 > 0 的行；其他类型提交所有有效物料行
  ibSelectedEditLines() {
    const lines = this._ibEditLines || [];
    if (this._ibCorrection) return lines.filter(l => l.code && Number(l.qty) > 0);
    if (this._ibReturnLinked) return lines.filter(l => l.code && Number(l.qty) > 0);
    return lines.filter(l => l.code);
  },

  // ========== 保存草稿 ==========
  // 明细行提交体：带上行级合同号/采购单号（按采购单或合同载入的行可能各不相同），
  // 保留采购退货三档的 origin_line_id，供后端追溯原入库行成本。
  ibLinesPayload(lines) {
    const priceVisible = this.ibEditPriceVisible();
    return (lines || []).map(l => {
      const o = { code: l.code, qty: parseFloat(l.qty) || 0, remarks: l.remarks || '' };
      // 无价格权限：不提交 price，服务端按退货原行/订单价/原行价/期初价推导
      if (priceVisible) o.price = parseFloat(l.price) || 0;
      if (l.contract_no) o.contract_no = l.contract_no;
      if (l.po_no) o.po_no = l.po_no;
      if (l.origin_line_id) o.origin_line_id = Number(l.origin_line_id);
      // 采购入库：显式带上在「采购明细行」下拉里选中的行，后端据此校验归属与超收
      if (l.order_line_id) o.order_line_id = Number(l.order_line_id);
      return o;
    });
  },

  // ========== 入库更正（2026-11 第七批：作废重开） ==========
  // 行身份键（与后端 correctionLineKey 完全一致）
  ibCorrKey(l) {
    const rid = Number(l.origin_line_id) || 0;
    if (rid > 0) return 'RL:' + rid;
    const oid = Number(l.order_line_id) || 0;
    if (oid > 0) return 'OL:' + oid;
    const po = String(l.po_no || '').trim();
    const code = String(l.code || '').trim();
    const ct = String(l.contract_no || '').trim();
    if (po) return 'PC:' + po + '|' + code + '|' + ct;
    return 'MC:' + code;
  },

  // 详情页「更正」按钮：创建/复用更正草稿并进入更正编辑页
  async startInboundCorrection(docNo) {
    if (!docNo) return;
    try {
      const r = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/correction', 'POST', {});
      await this.editInboundDoc(r.doc_no);
    } catch (e) {
      if (e.code === 'CORRECTION_DRAFT_EXISTS') {
        try {
          const info = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/correction-info');
          const draftNo = (info && info.correction && info.correction.draft_doc_no) || '';
          if (draftNo) {
            this.toast(this.t('ibd_corr_draft_exists', { doc: draftNo }), 'info');
            return this.editInboundDoc(draftNo);
          }
        } catch (_) { /* 忽略，走下方统一报错 */ }
      }
      this.toast(e.message, 'error');
    }
  },

  // 更正页「载入未到货」：按「原单已过账」口径临时排除原单已过账数量
  async loadInboundCorrectionPending() {
    const d = this._ibDetail;
    if (!d) return;
    const origDocNo = (this._ibCorrection && this._ibCorrection.originalDocNo) || '';
    try {
      let rows = [];
      if (d.po_no) {
        rows = await this.api('/api/purchase/lines/by-po/' + encodeURIComponent(d.po_no)
          + '?excludeInboundDoc=' + encodeURIComponent(origDocNo));
      } else if (d.contract_no) {
        rows = await this.api('/api/purchase/lines/by-contract/' + encodeURIComponent(d.contract_no)
          + '?excludeInboundDoc=' + encodeURIComponent(origDocNo));
      } else {
        this.toast(this.t('ibd_corr_no_po'), 'error');
        return;
      }
      const existing = new Set((this._ibEditLines || []).map(l => this.ibCorrKey(l)));
      let added = 0;
      (rows || []).forEach(r => {
        const line = {
          code: r.code, material_name: r.material_name, material_spec: r.material_spec,
          material_brand: r.material_brand, material_unit: r.material_unit,
          qty: Number(r.unreceived_qty) || 0,
          price: Number(r.order_price) || 0,
          po_no: r.po_no || d.po_no || '',
          contract_no: r.contract_no_eff || r.contract_no || '',
          order_line_id: Number(r.id) || 0,
          _locked: true, remarks: ''
        };
        const key = this.ibCorrKey(line);
        if (existing.has(key)) return; // 已在更正明细中的采购行不重复载入
        existing.add(key);
        this._ibEditLines.push(line);
        added += 1;
      });
      this.renderInboundEditTable();
      this.toast(this.t('ibd_corr_load_ok', { n: added }), added ? 'success' : 'info');
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // 确认更正：保存目标数量 → 原单作废、退货单改指向、新单过账（后端单事务）
  // 任何冲突（已退量超过新数量 / 作废使库存转负）一律拒绝，无强制放行入口
  async confirmCorrectionDoc() {
    const docNo = this._ibDocNo;
    if (!docNo || !this._ibCorrection) return;
    // 与「保存草稿」共用同一套无改动判定：行数/每行数量/单头备注与原单完全一致时不允许确认
    if (this.ibCorrectionUnchanged()) {
      this.toast(this.t('corr_no_change'), 'error');
      return;
    }
    const check = this.ibValidateEditLines();
    if (!check.ok) { this.toast(check.message, 'error'); return; }

    const lines = this.ibSelectedEditLines();
    this.ibOverConfirm(force => this.ibDoConfirmCorrection(docNo, lines, force));
  },

  // 更正单确认：超收软拦截——本地先给二次确认，服务端未带放行标记时回 400，再确认后带标记重试
  async ibDoConfirmCorrection(docNo, lines, force) {
    const voidOnly = lines.length === 0;
    const body = {
      remarks: (document.getElementById('ib_e_remarks') || {}).value || '',
      lines: this.ibLinesPayload(lines)
    };
    if (force) body.over_receipt_confirm = true;
    const self = this;
    const hint = voidOnly ? this.t('ibd_corr_void_only_hint') : this.t('ibd_corr_confirm_hint');
    this.confirmDialog(this.t('ibd_corr_confirm'), hint, async () => {
      try {
        await self.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
        const r = await self.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/confirm-correction', 'POST',
          force ? { over_receipt_confirm: true } : {});
        self._ibCorrection = null;
        if (r.mode === 'void-only') {
          self.toast(self.t('ibd_corr_void_only_done', { no: r.voided_doc_no }), 'success');
          await self.openInboundDoc(r.voided_doc_no);
        } else {
          self.toast(self.t('ibd_corr_confirmed', { no: r.doc_no }), 'success');
          await self.openInboundDoc(r.doc_no);
        }
      } catch (e) {
        if (e.code === 'OVER_RECEIPT') {
          self.ibShowOverReceiptError(e, () => self.ibDoConfirmCorrection(docNo, lines, true));
        } else if (e.code === 'RETURN_EXCEEDS_CORRECTED_QTY') {
          self.handleCorrectionReturnConflict(e);
        } else if (e.code === 'INSUFFICIENT_STOCK') {
          const details = (e.details || []).map(x =>
            `${x.code}：${self.t('out_available')} ${self.fmtQty(x.available)}，${self.t('ibd_corr_after')} ${self.fmtQty(x.after)}`
          ).join('\n');
          self.confirmDialog(self.t('out_stock_short'),
            `${e.message}${details ? '\n' + details : ''}\n\n${self.t('ibd_corr_fix_outbound')}`, () => {}, null, 'primary');
        } else {
          self.toast(e.message, 'error');
        }
      }
    }, null, 'primary');
  },

  // 退货量冲突：列出具体退货单，确认后跳转到退货模块对应单据
  handleCorrectionReturnConflict(err) {
    const details = (err.details || []).map(c => {
      const docs = (c.return_docs || []).join('、');
      return `${c.code}：${this.t('ibd_corr_returned_qty')} ${this.fmtQty(c.returned_qty)}，` +
        `${this.t('ibd_corr_target_qty')} ${this.fmtQty(c.new_qty)}` +
        (docs ? `（${this.t('ibd_corr_return_docs')} ${docs}）` : '');
    }).join('\n');
    const firstDoc = (((err.details || [])[0] || {}).return_docs || [])[0] || '';
    const self = this;
    this.confirmDialog(this.t('ibd_corr_return_conflict'),
      `${err.message}\n\n${details}` +
      (firstDoc ? `\n\n${this.t('ibd_corr_goto_return_hint')}` : ''),
      firstDoc ? () => self.gotoReturnDoc(firstDoc) : null, null, 'primary');
  },

  // 跳转到退货模块并定位退货单
  gotoReturnDoc(docNo) {
    const s = this.retState();
    s.tab = '采购退货';
    s.kpi = '';
    s.kw = docNo;
    s.sel = docNo;
    return this.gotoPage('returns');
  },


  // 单头来源：采购入库取当前单选来源，其余类型沿用原单头
  ibSourceHeader() {
    const d = this._ibDetail || {};
    if (d.txn_type === '采购入库' && !this._ibCorrection) {
      return {
        po_no: this._ibSource && this._ibSource.kind === 'po' ? this._ibSource.no : '',
        contract_no: this._ibSource && this._ibSource.kind === 'contract' ? this._ibSource.no : ''
      };
    }
    return { po_no: d.po_no || '', contract_no: d.contract_no || '' };
  },

  // 超收二次确认：列出超收行，确认后仍按超收入库（带显式放行标记）
  ibOverConfirm(onDecided) {
    const overs = this.ibOverReceiptDetails();
    if (!overs.length) return onDecided(false);
    const text = overs.map(o => this.t('ibd_over_receipt_line', {
      n: o.line_no, code: o.code,
      unreceived: this.fmtQty(o.unreceived),
      requested: this.fmtQty(o.requested),
      over: this.fmtQty(o.over)
    })).join('<br>');
    this.confirmDialog(this.t('ibd_over_receipt_title'),
      `${text}<br><br><b>${this.t('ibd_over_receipt_confirm_hint')}</b>`,
      () => onDecided(true), null, 'primary');
  },

  ibShowOverReceiptError(e, retry) {
    const details = (e.details || []).map(o => this.t('ibd_over_receipt_line', {
      n: o.line_no, code: o.code,
      unreceived: this.fmtQty(o.unreceived),
      requested: this.fmtQty(o.requested),
      over: this.fmtQty(o.over)
    })).join('<br>');
    this.confirmDialog(this.t('ibd_over_receipt_title'),
      `${details || this.ibEsc(e.message)}<br><br><b>${this.t('ibd_over_receipt_confirm_hint')}</b>`,
      () => retry(), null, 'primary');
  },

  async saveInboundDraft() {
    const docNo = this._ibDocNo;
    // 更正单：行数/数量与原单完全一致、且单头未改动时不允许保存
    if (this.ibCorrectionUnchanged()) {
      this.toast(this.t('corr_no_change'), 'error');
      return;
    }

    const check = this.ibValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = this.ibSelectedEditLines();
    this.ibOverConfirm(force => this.ibDoSaveDraft(docNo, lines, force));
  },

  async ibDoSaveDraft(docNo, lines, force) {
    const h = this.ibSourceHeader();
    // 草稿允许暂时没有明细；只有确认过账时才强制要求至少一行有效物料。
    const body = {
      lines: this.ibLinesPayload(lines),
      date: document.getElementById('ib_e_date')?.value,
      supplier: document.getElementById('ib_e_supplier')?.value,
      handler: document.getElementById('ib_e_handler')?.value,
      po_no: h.po_no,
      contract_no: h.contract_no,
      remarks: document.getElementById('ib_e_remarks')?.value
    };
    if (force) body.over_receipt_confirm = true;
    if (this._ibNoOrigin) {
      body.return_reason = document.getElementById('ib_e_return_reason')?.value?.trim() || '';
    }

    try {
      await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
      this.toast(this.t('ibd_draft_saved'));
      // 刷新详情
      await this.editInboundDoc(docNo);
    } catch (e) {
      if (e.code === 'OVER_RECEIPT') {
        this.ibShowOverReceiptError(e, () => this.ibDoSaveDraft(docNo, lines, true));
        return;
      }
      this.toast(e.message, 'error');
    }
  },

  // ========== 确认入库（从编辑页面） ==========
  confirmInboundDocFromEdit() {
    const docNo = this._ibDocNo;
    const d = this._ibDetail;
    const isReturn = d?.txn_type === '采购退货';

    const check = this.ibValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = this.ibSelectedEditLines();

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
    // 采购入库确认前必须有来源；两头空的存量草稿在此拦下
    if (d?.txn_type === '采购入库' && !this._ibCorrection && !this._ibSource) {
      this.toast(this.t('ibd_source_required_confirm'), 'error');
      return;
    }

    this.ibOverConfirm(force => this.ibDoConfirmFromEdit(docNo, lines, force, isReturn));
  },

  async ibDoConfirmFromEdit(docNo, lines, force, isReturn) {
    this.confirmDialog(this.t(isReturn ? 'ibd_confirm_return' : 'ibd_confirm'),
      `${this.t(isReturn ? 'ibd_confirm_return_hint' : 'ibd_confirm_hint')}\n\n${this.t('ibd_line_count', { n: lines.length })} | ${this.t('in_total_qty')}: ${lines.reduce((s, l) => s + Math.abs(Number(l.qty) || 0), 0)}`,
      async () => {
        const h = this.ibSourceHeader();
        // 先保存明细，再确认
        const body = {
          lines: this.ibLinesPayload(lines),
          date: document.getElementById('ib_e_date')?.value,
          supplier: document.getElementById('ib_e_supplier')?.value,
          handler: document.getElementById('ib_e_handler')?.value,
          po_no: h.po_no,
          contract_no: h.contract_no,
          remarks: document.getElementById('ib_e_remarks')?.value
        };
        if (force) body.over_receipt_confirm = true;
        if (this._ibNoOrigin) {
          body.return_reason = document.getElementById('ib_e_return_reason')?.value?.trim() || '';
        }
        try {
          await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
          // 确认入库
          try {
            const r = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST',
              force ? { over_receipt_confirm: true } : {});
            this.toast(this.t(isReturn ? 'ibd_confirm_return_ok' : 'ibd_confirm_ok', { n: r.line_count }));
            if (isReturn) {
              this.retState().tab = '采购退货';
              await this.openReturnDoc(docNo);
            } else {
              await this.openInboundDoc(docNo);
            }
          } catch (e) {
            if (e.code === 'OVER_RECEIPT') {
              this.ibShowOverReceiptError(e, () => this.ibDoConfirmFromEdit(docNo, lines, true, isReturn));
            } else if (e.code === 'INSUFFICIENT_STOCK') {
              this.handleInboundDocStockError(e, docNo);
            } else {
              this.toast(e.message, 'error');
            }
          }
        } catch (e) {
          if (e.code === 'OVER_RECEIPT') {
            this.ibShowOverReceiptError(e, () => this.ibDoConfirmFromEdit(docNo, lines, true, isReturn));
            return;
          }
          this.toast(e.message, 'error');
        }
      }, null, 'primary');
  },

  // 确认入库（从详情页面，草稿已有明细行）
  confirmInboundDoc() {
    const docNo = this._ibDocNo;
    const d = this._ibDetail;
    const isReturn = d?.txn_type === '采购退货';
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

    this.confirmDialog(this.t(isReturn ? 'ibd_confirm_return' : 'ibd_confirm'),
      `${this.t(isReturn ? 'ibd_confirm_return_hint' : 'ibd_confirm_hint')}\n\n${this.t('ibd_line_count', { n: lines.length })} | ${this.t('in_total_qty')}: ${lines.reduce((s, l) => s + Math.abs(Number(l.qty) || 0), 0)}`,
      async () => {
        try {
          const r = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', {});
          this.toast(this.t(isReturn ? 'ibd_confirm_return_ok' : 'ibd_confirm_ok', { n: r.line_count }));
          if (isReturn) {
            this.retState().tab = '采购退货';
            await this.openReturnDoc(docNo);
          } else {
            await this.openInboundDoc(docNo);
          }
        } catch (e) {
          if (e.code === 'INSUFFICIENT_STOCK') {
            this.handleInboundDocStockError(e, docNo);
          } else {
            this.toast(e.message, 'error');
          }
        }
      }, null, 'primary');
  },

  // 采购退货库存不足：负库存硬拦，直接提示错误，不提供强制放行
  handleInboundDocStockError(err) {
    const details = (err.details || []).map(d => this.t('ibd_stock_short_line', { code: d.code, req: d.requested, avail: d.available })).join('\n');
    this.toast(`${this.t('out_stock_short')}: ${details}`, 'error');
  },

  // ========== 删除入库单据 ==========
  // 删除草稿：对齐采购模块（二次确认 + 7 秒内可撤销）
  deleteInboundDoc(docNo) {
    const rec = this._ibDetailCache[docNo];
    const d = (this._ibDetail && this._ibDetail.doc_no === docNo) ? this._ibDetail : (rec && rec.d) || null;
    const lineCount = d ? (d.lines || []).length : null;
    const detailText = lineCount === null ? this.t('ibd_delete_confirm')
      : `${this.t('ibd_delete_draft_confirm', { no: this.ibEsc(docNo), n: lineCount })}<br>${this.t('pu_delete_hint')}`;

    const doDelete = async () => {
      let snap = d;
      if (!snap) { try { snap = await this.api('/api/inbound-docs/' + encodeURIComponent(docNo)); } catch (_) { snap = null; } }
      await this.api('/api/inbound-docs/' + encodeURIComponent(docNo), 'DELETE');
      const s = this.ibState();
      if (s.sel === docNo) { s.sel = null; s.wide = false; }
      delete this._ibDetailCache[docNo];
      this._ibDetail = null; this._ibDocNo = null;
      await this.gotoPage('inbound');
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
        await this.gotoPage('inbound');
      };
    };
    this.puConfirmDelete(this.t('delete'), detailText, doDelete, this.t('deleted'));
  },

  // ========== 导航 ==========
  async backToInboundList() {
    const newForm = !!document.getElementById('ib_f_txn_type');
    const type = newForm ? document.getElementById('ib_f_txn_type').value : (this._ibDetail?.txn_type || '');
    await this.ibDropEmptyDraftOnLeave();
    if (type === '采购退货') {
      this.retState().tab = '采购退货';
      this.retState().sel = '';
      return this.gotoPage('returns');
    }
    this.gotoPage('inbound');
  },

  async backToInboundDetail(docNo) {
    const d = this._ibDetail;
    const isReturn = d && d.txn_type === '采购退货';
    const dropped = await this.ibDropEmptyDraftOnLeave();
    if (dropped) {
      // 占位空草稿已删除，详情不存在，回到列表
      if (isReturn) {
        this.retState().tab = '采购退货';
        this.retState().sel = '';
        return this.gotoPage('returns');
      }
      return this.gotoPage('inbound');
    }
    if (isReturn) {
      this.retState().tab = '采购退货';
      return this.openReturnDoc(docNo);
    }
    this.openInboundDoc(docNo);
  },

});
