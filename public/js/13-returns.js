/**
 * 退货与退库模块
 *
 * 只做聚合展示：采购退货（入库账本）与领用退库（出库账本）。
 * 写入复用现有 inbound/outbound 接口与页面，不复制业务逻辑。
 * 列表页形态（页签/筛选/KPI/分栏/右侧详情）与入库模块保持一致。
 */
Object.assign(App, {
  _retState: null,
  _retList: null,
  _retData: null,

  retEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  retState() {
    if (!this._retState) {
      this._retState = { tab: '', kpi: '', kw: '', from: '', to: '', sel: '' };
    }
    return this._retState;
  },

  retTabDefs() {
    return [['', this.t('ret_tab_all')], ['采购退货', this.t('ret_tab_purchase')], ['领用退库', this.t('ret_tab_stock')]];
  },

  retKpiDefs() {
    return [
      ['', this.t('ret_tab_all'), r => true],
      ['draft', this.t('ibd_status_draft'), r => r.status === 'draft'],
      ['posted', this.t('ibd_status_posted'), r => r.status === 'posted'],
      ['partially_reversed', this.t('ibd_status_partial_rev'), r => r.status === 'partially_reversed'],
      ['reversed', this.t('ibd_status_reversed'), r => r.status === 'reversed'],
      ['cancelled', this.t('ibd_status_cancelled'), r => r.status === 'cancelled'],
    ];
  },

  async renderReturns() {
    const s = this.retState();
    this._retData = null;
    const st = this.getTableState('returns');
    if (!this._retInit) { st.page = 1; st.pageSize = 20; this._retInit = true; }

    this.setMain(this.pageWrap('↩ ' + this.t('ret_title'), this.t('ret_desc'), '',
      `<div id="ret-root" class="data-page">
        <div class="data-toolbar">
          <nav id="ret-tabs" class="pu-viewtabs" role="tablist" aria-label="${this.t('ret_title')}"></nav>
          <div class="pu-toolbar">
            <div id="ret-filters" class="pu-filter-inner"></div>
            <div id="ret-head-actions" class="pu-head-actions"></div>
          </div>
        </div>
        <div id="ret-kpis" class="pu-kpis" role="group" aria-label="${this.t('ret_status')}"></div>
        <div class="pu-split" id="ret-split">
          <section class="pu-list">
            <div class="data-scroll" id="ret-scroll"></div>
            <div class="pu-pager" id="ret-pager"></div>
          </section>
          <aside class="pu-insp" id="ret-insp" hidden aria-label="${this.t('ret_detail')}"></aside>
        </div>
      </div>`));
    const pb = document.querySelector('.page-body');
    if (pb) pb.classList.add('pu-page-body');

    this.injectPurchaseStyles();
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['returns'] = () => this.retRenderList();

    this.retRenderTabs();
    this.retRenderFilters();
    this.retRenderHeadActions();
    await this.retLoadList();

    if (this._retPendingDoc) {
      const no = this._retPendingDoc;
      this._retPendingDoc = null;
      await this.retSelectDoc(no);
    } else if (s.sel) {
      await this.retSelectDoc(s.sel, true);
    }
  },

  retRenderTabs() {
    const box = document.getElementById('ret-tabs');
    if (!box) return;
    const s = this.retState();
    box.innerHTML = this.retTabDefs().map(([k, label]) =>
      `<button type="button" class="pu-viewtab" role="tab" aria-selected="${s.tab === k}" onclick="App.retSwitchTab('${k}')">${label}</button>`
    ).join('');
  },

  retRenderFilters() {
    const box = document.getElementById('ret-filters');
    if (!box) return;
    const s = this.retState();
    const ph = this.t('ret_filter_ph');
    box.innerHTML = `<div class="pu-search" role="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="ret_f_kw" type="search" value="${this.retEsc(s.kw)}" placeholder="${ph}" aria-label="${ph}" onkeydown="if(event.key==='Enter')App.retApplyFilter()">
      </div>
      <div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="ret_f_from">${this.t('pu_date')}</label>
        <input id="ret_f_from" type="date" value="${this.retEsc(s.from)}" aria-label="${this.t('pu_date')}" onchange="App.retApplyFilter()">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="ret_f_to" type="date" value="${this.retEsc(s.to)}" aria-label="${this.t('pu_date')}" onchange="App.retApplyFilter()">
      </div>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.retClearFilter()">${this.t('pu_clear_filter')}</button>`;
  },

  retRenderHeadActions() {
    const box = document.getElementById('ret-head-actions');
    if (!box) return;
    box.innerHTML = this.can('returns', 'create')
      ? `<button type="button" class="btn btn-primary" onclick="App.newInboundDoc('采购退货')">+ ${this.t('ret_new_purchase')}</button>
         <button type="button" class="btn btn-outline" onclick="App.newOutboundDoc('退库出库')">+ ${this.t('ret_new_stock')}</button>`
      : '';
  },

  retSwitchTab(tab) {
    const s = this.retState();
    s.tab = tab;
    s.sel = '';
    const st = this.getTableState('returns');
    st.page = 1;
    this.retCloseInspector();
    this.retRenderTabs();
    this.retRenderList();
  },

  retApplyFilter() {
    const s = this.retState();
    s.kw = (document.getElementById('ret_f_kw')?.value || '').trim();
    s.from = document.getElementById('ret_f_from')?.value || '';
    s.to = document.getElementById('ret_f_to')?.value || '';
    s.sel = '';
    const st = this.getTableState('returns');
    st.page = 1;
    this.retCloseInspector();
    this.retRenderList();
  },

  retClearFilter() {
    this._retState = { tab: this.retState().tab, kpi: this.retState().kpi, kw: '', from: '', to: '', sel: '' };
    const st = this.getTableState('returns');
    st.page = 1;
    this.retRenderFilters();
    this.retCloseInspector();
    this.retRenderList();
  },

  retSetKpi(kpi) {
    const s = this.retState();
    s.kpi = kpi;
    s.sel = '';
    const st = this.getTableState('returns');
    st.page = 1;
    this.retCloseInspector();
    this.retRenderList();
  },

  // 聚合接口按页返回，这里全量拉取后在前端做筛选/排序/分页，与入库模块口径一致
  async retLoadList() {
    const PAGE = 200;
    try {
      const first = await this.api('/api/returns/docs?page=1&pageSize=' + PAGE);
      let items = (first.items || []).slice();
      const totalPages = Number(first.totalPages || 1);
      for (let p = 2; p <= totalPages; p++) {
        const next = await this.api('/api/returns/docs?page=' + p + '&pageSize=' + PAGE);
        items = items.concat(next.items || []);
      }
      this._retList = items;
    } catch (e) {
      this._retList = [];
      this.toast(e.message || this.t('ret_load_failed'), 'error');
    }
    this.retRenderList();
  },

  retRowsByTab() {
    const s = this.retState();
    const rows = this._retList || [];
    return s.tab ? rows.filter(r => r.sub_type === s.tab) : rows;
  },

  retVisibleRows() {
    const s = this.retState();
    let rows = this.retRowsByTab();
    if (s.kw) rows = this.filterByKeywords(rows, s.kw, ['doc_no', 'sub_type', 'party', 'ref_no', 'handler', 'remarks']);
    rows = this.filterByDateRange(rows, 'date', s.from, s.to);
    if (s.kpi) rows = rows.filter(r => r.status === s.kpi);
    return rows;
  },

  retStatusBadge(status) {
    const map = {
      draft: ['warning', 'ibd_status_draft'],
      posted: ['success', 'ibd_status_posted'],
      partially_reversed: ['warning', 'ibd_status_partial_rev'],
      reversed: ['danger', 'ibd_status_reversed'],
      cancelled: ['danger', 'ibd_status_cancelled'],
    };
    const hit = map[status];
    if (!hit) return `<span class="badge">${this.retEsc(status || '-')}</span>`;
    return `<span class="badge badge-${hit[0]}">${this.t(hit[1])}</span>`;
  },

  retSubTypeBadge(subType) {
    if (subType === '采购退货') return `<span class="badge badge-danger">${this.t('ret_tab_purchase')}</span>`;
    return `<span class="badge badge-success">${this.t('ret_tab_stock')}</span>`;
  },

  retRenderList() {
    const s = this.retState();
    const kp = document.getElementById('ret-kpis');
    if (kp) {
      const rows = this.retRowsByTab();
      kp.innerHTML = this.retKpiDefs().map(([k, label, fn]) =>
        `<button type="button" class="pu-kpi" aria-pressed="${s.kpi === k}" onclick="App.retSetKpi('${k}')"><small>${label}</small><strong>${rows.filter(fn).length}</strong></button>`
      ).join('');
    }

    const rows = this.retVisibleRows();
    const st = this.getTableState('returns');
    const sorted = this.sortData(rows, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const scroll = document.getElementById('ret-scroll');
    if (scroll) {
      scroll.innerHTML = sorted.length
        ? this.retListTable(pageData)
        : `<div class="pu-empty">${this.t('pu_no_result')}<br><span class="pu-mu">${this.retHasFilter() ? this.t('pu_no_result_hint') : this.t('ret_empty')}</span></div>`;
    }
    const pager = document.getElementById('ret-pager');
    if (pager) pager.innerHTML = this.renderPager('returns', sorted.length);
  },

  retHasFilter() {
    const s = this.retState();
    return !!(s.kw || s.from || s.to || s.kpi || s.tab);
  },

  retListTable(pageData) {
    const vp = this.canViewPrice();
    const s = this.retState();
    const tid = 'returns';
    const cols = [
      ['doc_no', this.t('ret_no'), r => `<button type="button" class="pu-lk" onclick="event.stopPropagation();App.retSelectDoc('${this.retEsc(r.doc_no)}')">${this.retEsc(r.doc_no)}</button>`],
      ['date', this.t('ret_date'), r => this.fmtDate(r.date)],
      ['sub_type', this.t('ret_subtype'), r => this.retSubTypeBadge(r.sub_type)],
      ['party', this.t('ret_party'), r => this.retEsc(r.party || '-')],
      ['ref_no', this.t('ret_ref'), r => this.retEsc(r.ref_no || '-')],
      ['line_count', this.t('ret_lines'), r => r.line_count || 0, true],
      ['total_qty', this.t('ret_qty'), r => this.qtyCell(r.direction === 'in' ? r.total_qty : -r.total_qty), true],
      ['total_amount', this.t('ret_amount'), r => this.fmtMoney(r.total_amount), true, vp],
      ['status', this.t('ret_status'), r => this.retStatusBadge(r.status)],
      ['reversed_qty', this.t('ret_reversed'), r => this.qtyCell(r.direction === 'in' ? r.reversed_qty : -r.reversed_qty), true],
      ['remaining_qty', this.t('ret_remaining'), r => this.qtyCell(r.direction === 'in' ? r.remaining_qty : -r.remaining_qty), true],
      ['actions', this.t('ret_actions'), r => `<span class="action-link" onclick="event.stopPropagation();App.retSelectDoc('${this.retEsc(r.doc_no)}')">${this.t('ret_view')}</span>`],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = pageData.map(r => {
      const on = s.sel === r.doc_no;
      return `<tr class="pu-row${on ? ' sel' : ''}" onclick="App.retSelectDoc('${this.retEsc(r.doc_no)}')">` +
        shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  retCloseInspector() {
    const insp = document.getElementById('ret-insp');
    if (insp) { insp.hidden = true; insp.innerHTML = ''; }
  },

  async retSelectDoc(docNo, silent) {
    const s = this.retState();
    s.sel = docNo;
    this.retRenderList();
    try {
      this._retData = await this.api('/api/returns/docs/' + encodeURIComponent(docNo));
    } catch (e) {
      if (!silent) this.toast(e.message || this.t('ret_load_failed'), 'error');
      return;
    }
    const insp = document.getElementById('ret-insp');
    if (!insp) return;
    insp.hidden = false;
    insp.innerHTML = this.retDetailHtml(this._retData);
  },

  // 兼容旧入口：从采购单详情等直接打开退货单
  openReturnDoc(docNo) {
    if (!this.can('returns', 'view')) {
      this.toast(this.t('no_perm_msg'), 'error');
      return;
    }
    this._retPendingDoc = docNo;
    this.currentPage = 'returns';
    return this.renderReturns();
  },

  retOpenDoc(docNo) {
    return this.retSelectDoc(docNo);
  },

  retDetailHtml(doc) {
    const showPrice = this.canViewPrice();
    const s = doc.summary || {};
    const d = doc.direction === 'in' ? 1 : -1;
    const canEdit = this.can(doc.ledger, 'edit');
    const canDelete = this.can(doc.ledger, 'delete');
    const canReverse = doc.can_reverse && canEdit;

    const actionBtns = [
      doc.can_edit && canEdit ? `<button class="btn btn-outline" onclick="App.${doc.ledger === 'inbound' ? 'editInboundDoc' : 'editOutboundDoc'}('${this.retEsc(doc.doc_no)}')">${this.t('ret_edit')}</button>` : '',
      doc.can_confirm && canEdit ? `<button class="btn btn-primary" onclick="App.retConfirm('${this.retEsc(doc.doc_no)}','${doc.ledger}')">${this.t('ret_confirm')}</button>` : '',
      canReverse ? `<button class="btn btn-outline" onclick="App.retReverse('${this.retEsc(doc.doc_no)}','${doc.ledger}')">${this.t('ret_reverse')}</button>` : '',
      doc.status === 'draft' && canDelete ? `<button class="btn btn-outline" onclick="App.retDelete('${this.retEsc(doc.doc_no)}','${doc.ledger}')">${this.t('ret_delete')}</button>` : '',
    ].filter(Boolean).join(' ');

    // 领用退库的原出库单可直接跳转（2C）
    const refCell = doc.ref_no
      ? (doc.ledger === 'outbound'
          ? `<span class="action-link" onclick="App.openOutboundDoc('${this.retEsc(doc.ref_no)}')">${this.retEsc(doc.ref_no)}</span>`
          : this.retEsc(doc.ref_no))
      : '-';

    const lineRows = (doc.lines || []).map(l => {
      const qty = Math.abs(Number(l.qty || 0));
      const reversed = Math.abs(Number(l.reversed_qty || 0));
      const remain = Math.max(0, qty - reversed);
      return `<tr>
        <td>${this.retEsc(l.code || '-')}</td>
        <td>${this.retEsc(l.material_name || '-')}</td>
        <td>${this.retEsc(l.material_spec || '-')}</td>
        <td>${this.retEsc(l.material_unit || '')}</td>
        <td class="text-right">${this.qtyCell(d * qty)}</td>
        ${showPrice ? `<td class="text-right">${this.fmtMoney(doc.ledger === 'inbound' ? l.price : l.cost_price)}</td>
        <td class="text-right">${this.fmtMoney(doc.ledger === 'inbound' ? l.amount : l.cost_amount)}</td>` : ''}
        <td class="text-right">${this.qtyCell(d * reversed)}</td>
        <td class="text-right">${this.qtyCell(d * remain)}</td>
      </tr>`;
    }).join('');

    const revRows = (doc.reversals || []).map(r => `<tr>
      <td><span class="action-link" onclick="App.${doc.ledger === 'inbound' ? 'openInboundDoc' : 'openOutboundDoc'}('${this.retEsc(r.doc_no)}')">${this.retEsc(r.doc_no)}</span></td>
      <td>${this.fmtDate(r.date)}</td>
      <td>${this.retStatusBadge(r.status)}</td>
    </tr>`).join('');

    return `<div class="pu-edit-bar">
        <span class="action-link" onclick="App.retBackToList()">← ${this.t('ret_back')}</span>
        <span>${this.retEsc(doc.doc_no)} ${this.retStatusBadge(doc.status)}</span>
      </div>
      <div class="pu-card">
        <div class="pu-card-title"><span>01</span><div>${this.t('ret_detail')}</div></div>
        <div class="form-grid" style="max-width:none">
          <div class="form-group"><label>${this.t('ret_no')}</label><div>${this.retEsc(doc.doc_no)}</div></div>
          <div class="form-group"><label>${this.t('ret_date')}</label><div>${this.fmtDate(doc.date)}</div></div>
          <div class="form-group"><label>${this.t('ret_subtype')}</label><div>${this.retSubTypeBadge(doc.sub_type)}</div></div>
          <div class="form-group"><label>${this.t('ret_party')}</label><div>${this.retEsc(doc.party || '-')}</div></div>
          <div class="form-group"><label>${this.t('ret_ref')}</label><div>${refCell}</div></div>
          <div class="form-group"><label>${this.t('ret_handler')}</label><div>${this.retEsc(doc.handler || '-')}</div></div>
          <div class="form-group"><label>${this.t('ret_qty')}</label><div>${this.qtyCell(d * s.total_qty)}</div></div>
          ${showPrice ? `<div class="form-group"><label>${this.t('ret_amount')}</label><div>${this.fmtMoney(s.total_amount)}</div></div>` : ''}
          <div class="form-group"><label>${this.t('ret_reversed')}</label><div>${this.qtyCell(d * s.reversed_qty)}</div></div>
          <div class="form-group"><label>${this.t('ret_remaining')}</label><div>${this.qtyCell(d * s.remaining_qty)}</div></div>
          <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_remarks')}</label><div>${this.retEsc(doc.remarks || '-')}</div></div>
        </div>
        <div style="padding:12px 0 0;color:var(--text-muted);font-size:12px">
          ${s.remaining_qty <= 0 ? this.t('ret_reversed_full') : (s.reversed_qty > 0 ? this.t('ret_reversed_partial') : this.t('ret_no_reversal'))}
          ${doc.ledger === 'outbound' ? ' · ' + this.t('ret_origin_hint') : ''}
        </div>
      </div>
      ${actionBtns ? `<div class="pu-edit-actions">${actionBtns}</div>` : ''}
      <div class="pu-card">
        <div class="pu-card-title"><span>02</span><div>${this.t('ret_lines')}</div></div>
        <div class="table-wrap"><table><thead><tr>
          <th>${this.t('po_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th><th>${this.t('mat_unit')}</th>
          <th class="text-right">${this.t('ret_qty')}</th>
          ${showPrice ? `<th class="text-right">${this.t('ledger_price')}</th><th class="text-right">${this.t('ledger_amount')}</th>` : ''}
          <th class="text-right">${this.t('ret_reversed')}</th><th class="text-right">${this.t('ret_remaining')}</th>
        </tr></thead><tbody>${lineRows || `<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">${this.t('ret_empty')}</td></tr>`}</tbody></table></div>
      </div>
      <div class="pu-card">
        <div class="pu-card-title"><span>03</span><div>${this.t('ret_reversal_docs')}</div></div>
        <div class="table-wrap"><table><thead><tr>
          <th>${this.t('ret_no')}</th><th>${this.t('ret_date')}</th><th>${this.t('ret_status')}</th>
        </tr></thead><tbody>${revRows || `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">${this.t('ret_no_reversal')}</td></tr>`}</tbody></table></div>
      </div>`;
  },

  retBackToList() {
    const s = this.retState();
    s.sel = '';
    this.retCloseInspector();
    this.retRenderList();
  },

  async retConfirm(docNo, ledger) {
    if (!confirm(this.t('ret_confirm_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo) + '/confirm', { method: 'POST' });
      this.toast(this.t('ret_confirmed'));
      await this.retLoadList();
      await this.retSelectDoc(docNo, true);
    } catch (e) {
      this.toast(e.message || this.t('ret_confirm_failed'), 'error');
    }
  },

  async retDelete(docNo, ledger) {
    if (!confirm(this.t('ret_delete_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo), { method: 'DELETE' });
      this.toast(this.t('deleted'));
      const s = this.retState();
      s.sel = '';
      this.retCloseInspector();
      await this.retLoadList();
    } catch (e) {
      this.toast(e.message || this.t('requestFailed'), 'error');
    }
  },

  retReverse(docNo, ledger) {
    return ledger === 'inbound' ? this.showReversalPage(docNo) : this.showOutboundReversalPage(docNo);
  },
});
