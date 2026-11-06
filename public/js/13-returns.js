/**
 * 退货与退库模块
 *
 * 只做聚合展示：采购退货（入库账本）、领用退库（出库账本）以及它们的红冲单。
 * 写入复用现有 inbound/outbound 接口与页面，不复制业务逻辑。
 *
 * 交互与视觉以「入库模块」（05-inbound.js）为唯一标准：
 *  - 页签（全部 / 采购退货 / 领用退库 / 退货冲销）+ 条件区 + 状态 KPI + 列表
 *  - 点行在右侧 .pu-insp 面板原地展开（.pu-split.open），不再整页跳转
 *  - 详情面板：类型小标题 + 单号 + 状态徽标 + 两列字段 + 子页签（明细 / 冲销记录 / 操作日志）
 *    + 底部固定操作条（编辑/确认 → 打印 → 导出 → 冲销 → 删除）
 *  - 分页条与入库一致（共 N 单 · 草稿 · 已过账 · 金额 | 页码 | 每页 | 上一页/下一页）
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
      this._retState = {
        tab: '', kpi: '', kw: '', from: '', to: '', sel: '',
        dt: 'lines', wide: false, dense: false,
        lq: '', lf: '', lim: 15, ex: new Set(),
      };
    }
    return this._retState;
  },

  retTabDefs() {
    return [
      ['', this.t('ret_tab_all')],
      ['采购退货', this.t('ret_tab_purchase')],
      ['领用退库', this.t('ret_tab_stock')],
      ['退货冲销', this.t('ret_tab_reversal')],
    ];
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
    this.injectReturnsStyles();
    const root = document.getElementById('ret-root');
    if (root) root.classList.toggle('ret-dense', !!s.dense);

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
    } else {
      this.retRenderInspector();
    }
  },

  injectReturnsStyles() {
    if (document.getElementById('returns-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'returns-ui-styles';
    style.textContent = `
      #ret-root.ret-dense .table-wrap tbody td{padding:4px 10px;height:auto}
      #ret-root.ret-dense .table-wrap thead th{padding:6px 10px;height:auto}
    `;
    document.head.appendChild(style);
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
        <input id="ret_f_kw" type="search" value="${this.retEsc(s.kw)}" placeholder="${ph}" aria-label="${ph}"
          onkeydown="if(event.key==='Enter')App.retApplyFilter()">
      </div>
      <div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="ret_f_from">${this.t('pu_date')}</label>
        <input id="ret_f_from" type="date" value="${this.retEsc(s.from)}" aria-label="${this.t('pu_date')}" onchange="App.retApplyFilter()">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="ret_f_to" type="date" value="${this.retEsc(s.to)}" aria-label="${this.t('pu_date')}" onchange="App.retApplyFilter()">
      </div>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.retClearFilter()">${this.t('pu_clear_filter')}</button>
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.dense}" onclick="App.retToggleDense(this)">${this.t('pu_dense')}</button>`;
  },

  retRenderHeadActions() {
    const box = document.getElementById('ret-head-actions');
    if (!box) return;
    const s = this.retState();
    if (!this.can('returns', 'create') || s.tab === '退货冲销') { box.innerHTML = ''; return; }
    box.innerHTML = `<button type="button" class="btn btn-primary" onclick="App.newInboundDoc('采购退货')">+ ${this.t('ret_new_purchase')}</button>
      <button type="button" class="btn btn-outline" onclick="App.newOutboundDoc('退库出库')">+ ${this.t('ret_new_stock')}</button>`;
  },

  retSwitchTab(tab) {
    const s = this.retState();
    s.tab = tab;
    s.sel = '';
    const st = this.getTableState('returns');
    st.page = 1;
    this.retCloseInspector();
    this.retRenderTabs();
    this.retRenderHeadActions();
    this.retRenderList();
  },

  retToggleDense(el) {
    const s = this.retState();
    s.dense = !s.dense;
    const root = document.getElementById('ret-root');
    if (root) root.classList.toggle('ret-dense', s.dense);
    if (el) el.setAttribute('aria-pressed', String(s.dense));
  },

  retApplyFilter() {
    const s = this.retState();
    s.kw = (document.getElementById('ret_f_kw')?.value || '').trim();
    s.from = document.getElementById('ret_f_from')?.value || '';
    s.to = document.getElementById('ret_f_to')?.value || '';
    s.sel = '';
    this.getTableState('returns').page = 1;
    this.retCloseInspector();
    this.retRenderList();
  },

  retClearFilter() {
    const s = this.retState();
    s.kw = ''; s.from = ''; s.to = ''; s.kpi = ''; s.sel = '';
    this.getTableState('returns').page = 1;
    this.retRenderFilters();
    this.retCloseInspector();
    this.retRenderList();
  },

  retSetKpi(kpi) {
    const s = this.retState();
    s.kpi = s.kpi === kpi ? '' : kpi;
    s.sel = '';
    this.getTableState('returns').page = 1;
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

  retHasFilter() {
    const s = this.retState();
    return !!(s.kw || s.from || s.to || s.kpi || s.tab);
  },

  retStatusBadge(status) {
    const map = {
      draft: ['warning', 'ibd_status_draft'],
      posted: ['success', 'ibd_status_posted'],
      partially_reversed: ['warning', 'ibd_status_partial_rev'],
      reversed: ['muted', 'ibd_status_reversed'],
      cancelled: ['muted', 'ibd_status_cancelled'],
    };
    const hit = map[status];
    if (!hit) return `<span class="badge badge-muted">${this.retEsc(status || '-')}</span>`;
    return `<span class="badge badge-${hit[0]}">${this.t(hit[1])}</span>`;
  },

  // 明细页签文案按子类型区分：采购退货/领用退库/退货冲销各有专属叫法
  retLinesLabel(doc) {
    const st = (doc && doc.sub_type) || '';
    if (st === '采购退货') return this.t('ret_lines_purchase');
    if (st === '领用退库') return this.t('ret_lines_stock');
    if (st === '退货冲销') return this.t('ret_lines_reversal');
    return this.t('pu_tab_detail_lines');
  },

  retTypeLabel(doc) {
    const st = (doc && doc.sub_type) || '';
    if (st === '采购退货') return this.t('ret_tab_purchase');
    if (st === '领用退库') return this.t('ret_tab_stock');
    if (st === '退货冲销') return this.t('ret_tab_reversal');
    return st || '-';
  },

  retTierLabel(tier) {
    const labels = {
      inbound: this.t('ret_tier_inbound'),
      po: this.t('ret_tier_po'),
      contract: this.t('ret_tier_contract'),
      none: this.t('ret_tier_none'),
    };
    return labels[tier] || tier || '';
  },

  retSubTypeBadge(subType, noOrigin) {
    let badge = '';
    if (subType === '采购退货') badge = `<span class="badge badge-danger">${this.t('ret_tab_purchase')}</span>`;
    else if (subType === '退货冲销') badge = `<span class="badge badge-danger">${this.t('ret_tab_reversal')}</span>`;
    else badge = `<span class="badge badge-success">${this.t('ret_tab_stock')}</span>`;
    // 无原单采购退货（及其红冲单）单独打标，便于列表倒查
    if (noOrigin) badge += ` <span class="badge badge-warning">${this.t('ret_no_origin')}</span>`;
    return badge;
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
    this.retRenderPager(sorted);
    this.retUpdatePagerSticky();
  },

  retListTable(pageData) {
    const vp = this.canViewPrice();
    const s = this.retState();
    const tid = 'returns';
    const cols = [
      ['doc_no', this.t('ret_no'), r => {
        const sub = r.ref_no ? `<br><span class="pu-mu">← ${this.retEsc(r.ref_no)}</span>` : '';
        return `<button type="button" class="pu-lk" onclick="event.stopPropagation();App.retSelectDoc('${this.retEsc(r.doc_no)}')">${this.retEsc(r.doc_no)}</button>${sub}`;
      }],
      ['date', this.t('ret_date'), r => this.fmtDate(r.date)],
      ['sub_type', this.t('ret_subtype'), r => this.retSubTypeBadge(r.sub_type, r.no_origin)],
      ['party', this.t('ret_party'), r => this.retEsc(r.party || '-')],
      ['line_count', this.t('ret_lines'), r => r.line_count || 0, true],
      ['total_qty', this.t('ret_qty'), r => this.qtyCell(r.direction === 'in' ? r.total_qty : -r.total_qty), true],
      ['total_amount', this.t('ret_amount'), r => this.fmtMoney(r.total_amount), true, vp],
      ['status', this.t('ret_status'), r => this.retStatusBadge(r.status)],
      ['reversed_qty', this.t('ret_reversed'), r => (r.is_reversal ? '-' : this.qtyCell(r.direction === 'in' ? r.reversed_qty : -r.reversed_qty)), true],
      ['remaining_qty', this.t('ret_remaining'), r => (r.is_reversal ? '-' : this.qtyCell(r.direction === 'in' ? r.remaining_qty : -r.remaining_qty)), true],
      ['remarks', this.t('ibd_remarks'), r => this.retEsc(r.remarks || '')],
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

  // 分页条与入库模块完全一致：汇总 → 页码 → 每页 → 上一页/下一页
  retRenderPager(rows) {
    const box = document.getElementById('ret-pager');
    if (!box) return;
    const st = this.getTableState('returns');
    const tp = Math.max(1, Math.ceil(rows.length / st.pageSize));
    if (st.page > tp) st.page = tp;
    if (!rows.length) { box.innerHTML = ''; return; }
    const sum = k => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    let tot = `${this.t('pu_sum_orders', { n: rows.length })}`
      + ` · ${this.t('ibd_status_draft')} ${rows.filter(r => r.status === 'draft').length}`
      + ` · ${this.t('ibd_status_posted')} ${rows.filter(r => r.status === 'posted').length}`;
    if (this.canViewPrice()) tot += ` · ${this.t('ret_amount')} ${this.fmtMoney(sum('total_amount'))}`;
    box.innerHTML = `<span class="pu-tot">${tot}</span>
      <span>${st.page} / ${tp} ${this.t('page')}</span>
      <label>${this.t('pageSize')} <select id="ret-psz">${[10, 15, 20, 50].map(n => `<option value="${n}"${n === st.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.retPage(-1)"${st.page <= 1 ? ' disabled' : ''}>${this.t('pu_prev')}</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.retPage(1)"${st.page >= tp ? ' disabled' : ''}>${this.t('pu_next')}</button>`;
    const sel = box.querySelector('#ret-psz');
    if (sel) sel.onchange = () => this.retSetPageSize(sel.value);
  },

  retPage(delta) {
    const st = this.getTableState('returns');
    st.page += Number(delta);
    this.retRenderList();
  },

  retSetPageSize(v) {
    const st = this.getTableState('returns');
    st.pageSize = parseInt(v, 10) || 15;
    st.page = 1;
    this.retRenderList();
  },

  retUpdatePagerSticky() {
    const pb = document.querySelector('.page-body');
    const pager = document.getElementById('ret-pager');
    if (!pb || !pager) return;
    pager.classList.toggle('pin', pb.scrollHeight > pb.clientHeight + 2);
  },

  // ========== 右侧详情面板（结构对齐入库 pu-insp） ==========
  retCloseInspector() {
    const insp = document.getElementById('ret-insp');
    const split = document.getElementById('ret-split');
    const s = this.retState();
    s.sel = ''; s.wide = false;
    if (insp) { insp.hidden = true; insp.innerHTML = ''; }
    if (split) split.classList.remove('open', 'wide');
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

  async retSelectDoc(docNo, silent) {
    const s = this.retState();
    if (s.sel !== docNo) { s.dt = 'lines'; s.lq = ''; s.lf = ''; s.lim = 15; s.ex = new Set(); }
    s.sel = docNo;
    this._retLoading = true;
    this._retErr = '';
    this.retRenderList();
    this.retRenderInspector();
    try {
      this._retData = await this.api('/api/returns/docs/' + encodeURIComponent(docNo));
    } catch (e) {
      this._retData = null;
      this._retErr = e.message || this.t('ret_load_failed');
      if (!silent) this.toast(this._retErr, 'error');
    }
    this._retLoading = false;
    if (this.retState().sel !== docNo) return;
    this.retRenderInspector();
  },

  retRenderInspector() {
    const s = this.retState();
    const box = document.getElementById('ret-insp');
    const split = document.getElementById('ret-split');
    if (!box || !split) return;
    if (!s.sel) {
      box.hidden = true; box.innerHTML = '';
      split.classList.remove('open', 'wide');
      return;
    }
    box.hidden = false;
    split.classList.add('open');
    split.classList.toggle('wide', s.wide);
    if (this._retLoading) { box.innerHTML = `<div class="pu-empty">${this.t('loading')}</div>`; return; }
    if (this._retErr) { box.innerHTML = `<div class="pu-empty">${this.retEsc(this._retErr)}</div>`; return; }
    const d = this._retData;
    if (!d) { box.innerHTML = `<div class="pu-empty">${this.t('loading')}</div>`; return; }

    const lines = d.lines || [];
    const revs = d.reversals || [];
    const logs = d.logs || [];
    if (!['lines', 'rev', 'logs'].includes(s.dt)) s.dt = 'lines';

    const typeLabel = this.retTypeLabel(d);
    const dd = d.direction === 'in' ? 1 : -1;
    const vp = this.canViewPrice();
    const sum = d.summary || {};
    const meta = [
      [this.t('ret_subtype'), typeLabel],
      [this.t('ret_date'), this.fmtDate(d.date) || '–'],
      [this.t('ret_party'), d.party || '–'],
      [this.t('ret_handler'), d.handler || '–'],
      [this.t('ret_ref'), d.ref_no || '–'],
      [this.t('ret_lines'), String(lines.length)],
      [this.t('ret_qty'), this.fmtQty(dd * Number(sum.total_qty || 0))],
    ];
    if (d.return_tier) meta.push([this.t('ret_tier'), this.retTierLabel(d.return_tier)]);
    if (d.no_origin) meta.push([this.t('ret_no_origin_reason'), d.return_reason || '–']);
    if (vp) meta.push([this.t('ret_amount'), this.fmtMoney(sum.total_amount)]);
    if (!d.is_reversal) {
      meta.push([this.t('ret_reversed'), this.fmtQty(dd * Number(sum.reversed_qty || 0))]);
      meta.push([this.t('ret_remaining'), this.fmtQty(dd * Number(sum.remaining_qty || 0))]);
    }
    meta.push([this.t('ibd_remarks'), d.remarks || '–']);

    const tabs = [
      ['lines', this.retLinesLabel(d), lines.length],
      ['rev', this.t('ret_reversal_docs'), revs.length],
      ['logs', this.t('pu_tab_logs'), logs.length],
    ];

    // 底部操作条：业务操作 → 打印/导出 → 修改 → 删除（高危固定最右）
    const isDraft = d.status === 'draft';
    const canEdit = this.can(d.ledger, 'edit');
    const canDelete = this.can(d.ledger, 'delete');
    let foot = '';
    if (isDraft && d.is_reversal && canEdit) {
      foot += `<button type="button" class="btn btn-primary" onclick="App.retConfirmReversal('${this.retEsc(d.doc_no)}','${d.ledger}')">${this.t('ibd_rev_confirm')}</button>`;
    } else if (isDraft && canEdit) {
      if (d.can_edit) foot += `<button type="button" class="btn btn-outline" onclick="App.${d.ledger === 'inbound' ? 'editInboundDoc' : 'editOutboundDoc'}('${this.retEsc(d.doc_no)}')">${lines.length ? this.t('ret_edit') : '+ ' + this.t('ibd_add_line')}</button>`;
      if (d.can_confirm) foot += `<button type="button" class="btn btn-primary" onclick="App.retConfirm('${this.retEsc(d.doc_no)}','${d.ledger}')">${this.t('ret_confirm')}</button>`;
    }
    foot += `<button type="button" class="btn btn-outline" onclick="App.retPrintDoc()">${this.t('doc_print')}</button>`;
    foot += `<button type="button" class="btn btn-outline" onclick="App.retExportDoc()">${this.t('doc_export')}</button>`;
    if (!d.is_reversal && d.can_reverse && canEdit) {
      foot += `<button type="button" class="btn btn-outline" onclick="App.retReverse('${this.retEsc(d.doc_no)}','${d.ledger}')">${this.t('ibd_rev_create')}</button>`;
    }
    if (isDraft && canDelete) {
      foot += `<button type="button" class="btn btn-danger" onclick="App.retDelete('${this.retEsc(d.doc_no)}','${d.ledger}')">${this.t('ret_delete')}</button>`;
    }

    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" onclick="App.retBackToList()">← ${this.t('pu_back_list')}</button>
      <div class="pu-insp-head">
        <div>
          <small>${typeLabel}</small>
          <h2>${this.retEsc(d.doc_no)}</h2>
          <span class="pu-badge">${this.retStatusBadge(d.status)}</span>
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}" onclick="App.retToggleWide()">${s.wide ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" title="${this.t('pu_close_detail')}" onclick="App.retBackToList()">✕</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${this.retEsc(m[0])}</dt><dd>${this.retEsc(m[1])}</dd></div>`).join('')}</dl>
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" onclick="App.retSetDt('${k}')">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="ret-dpanel"></div>
      <div class="pu-insp-foot">${foot}</div>`;
    this.retRenderDetailPanel();
    this.retUpdatePagerSticky();
  },

  retToggleWide() {
    const s = this.retState();
    s.wide = !s.wide;
    this.retRenderInspector();
  },

  retBackToList() {
    this.retCloseInspector();
    this.retRenderList();
  },

  retSetDt(k) {
    const s = this.retState();
    s.dt = k; s.lim = 15;
    this.retRenderInspector();
  },

  retRenderDetailPanel() {
    const s = this.retState();
    const box = document.getElementById('ret-dpanel');
    if (!box) return;
    const d = this._retData;
    if (!d) { box.innerHTML = ''; return; }
    if (s.dt === 'lines') return this.retRenderLinesBody();
    if (s.dt === 'rev') { box.innerHTML = this.retReversalPanel(d.reversals || []); return; }
    box.innerHTML = this.ibLogsPanel(d.logs || []);
  },

  // --- 明细：与入库一致的手风琴（宽屏时切换为整表） ---
  retRenderLinesBody() {
    const s = this.retState();
    const box = document.getElementById('ret-dpanel');
    const d = this._retData;
    if (!box || !d) return;
    const lines = d.lines || [];
    const dd = d.direction === 'in' ? 1 : -1;
    const vp = this.canViewPrice();
    if (s.wide) {
      const cols = [
        [this.t('mat_code'), l => this.retEsc(l.code)],
        [this.t('mat_name'), l => this.retEsc(l.material_name || '')],
        [this.t('mat_spec'), l => this.retEsc(l.material_spec || '')],
        [this.t('mat_unit'), l => this.retEsc(l.material_unit || '')],
        [this.t('ret_qty'), l => this.qtyCell(dd * Math.abs(Number(l.qty || 0)))],
      ];
      if (vp) {
        cols.push([this.t('ledger_price'), l => this.fmtMoney(d.ledger === 'inbound' ? l.price : l.cost_price)]);
        cols.push([this.t('ledger_amount'), l => this.fmtMoney(d.ledger === 'inbound' ? l.amount : l.cost_amount)]);
      }
      if (!d.is_reversal) {
        cols.push([this.t('ret_reversed'), l => this.fmtQty(Math.abs(Number(l.reversed_qty || 0)))]);
        cols.push([this.t('ret_remaining'), l => this.fmtQty(Math.abs(Number(l.qty || 0)) - Math.abs(Number(l.reversed_qty || 0)))]);
      }
      cols.push([this.t('ibd_remarks'), l => this.retEsc(l.remarks || '')]);
      box.innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map((c, i) => `<th${i >= 4 && i < cols.length - 1 ? ' class="text-right"' : ''}>${c[0]}</th>`).join('')}</tr></thead><tbody>${
        lines.map(l => '<tr>' + cols.map((c, i) => `<td${i >= 4 && i < cols.length - 1 ? ' class="text-right"' : ''}>${c[1](l)}</td>`).join('') + '</tr>').join('')
      }</tbody></table></div>`;
      return;
    }
    const revQtyOf = l => Math.abs(Number(l.reversed_qty || 0));
    const f = lines.filter(l => {
      if (s.lq && !this.puKwMatch([l.code, l.material_name, l.material_spec, l.material_brand, l.remarks].join(' '), s.lq)) return false;
      if (s.lf === 'rev') return revQtyOf(l) > 0;
      if (s.lf === 'rem') return revQtyOf(l) < Math.abs(Number(l.qty || 0));
      return true;
    });
    const nRev = lines.filter(l => revQtyOf(l) > 0).length;
    const nRem = lines.filter(l => revQtyOf(l) < Math.abs(Number(l.qty || 0))).length;
    const shown = Math.min(s.lim, f.length);

    let html = `<div class="pu-lqtoolbar">
      <input id="ret_lqi" type="search" value="${this.retEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}"
        oninput="if(!event.isComposing)App.retLineSearch(this.value)" oncompositionend="App.retLineSearch(this.value)">
      <div class="pu-chips" role="group">${[['', this.t('all'), lines.length]]
        .concat(!d.is_reversal ? [['rev', this.t('ret_reversed'), nRev], ['rem', this.t('ret_remaining'), nRem]] : [])
        .map(([k, label, n]) => `<button type="button" class="pu-chip" aria-pressed="${s.lf === k}" onclick="App.retSetLf('${k}')">${label} ${n}</button>`).join('')}</div>
    </div>`;
    if (!lines.length) {
      html += `<div class="pu-empty">${this.t('pu_no_lines')}</div>`;
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
      const remain = Math.abs(Number(l.qty || 0)) - rq;
      const price = d.ledger === 'inbound' ? l.price : l.cost_price;
      const amount = d.ledger === 'inbound' ? l.amount : l.cost_amount;
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" aria-expanded="${ex}" onclick="App.retToggleEx('${l.id}')">
          <span class="pu-line-n"><strong>${this.retEsc(l.code)}</strong> ${this.retEsc(l.material_name || '')} <span class="pu-mu">${this.retEsc(l.material_spec || '')}</span></span>
          <span class="pu-line-q">${this.qtyCell(dd * Math.abs(Number(l.qty || 0)))}${this.retEsc(l.material_unit || '')}</span>
          ${rq > 0 ? `<span class="badge badge-danger">${this.t('ret_reversed')} ${this.fmtQty(rq)}</span>` : ''}
        </button>
        ${ex ? `<div class="pu-line-d">
          ${vp ? `<div class="pu-mu">${this.t('ledger_price')} ${this.fmtMoney(price)} · ${this.t('ledger_amount')} ${this.fmtMoney(amount)}</div>` : ''}
          ${!d.is_reversal ? `<div>${this.t('ret_reversed')} ${this.fmtQty(rq)} · ${this.t('ret_remaining')} ${this.fmtQty(remain)}</div>` : ''}
          ${l.remarks ? `<div>${this.t('pu_remarks')}：${this.retEsc(l.remarks)}</div>` : ''}
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    if (f.length > s.lim) html += `<button type="button" class="btn btn-outline btn-sm pu-more" onclick="App.retMoreLines()">${this.t('pu_more', { n: f.length - s.lim })}</button>`;
    box.innerHTML = html;
  },

  retFocusEnd(id) {
    const el = document.getElementById(id);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (_) {} }
  },

  retLineSearch(v) {
    this.retState().lq = v;
    this.retRenderLinesBody();
    this.retFocusEnd('ret_lqi');
  },

  retSetLf(k) {
    const s = this.retState();
    s.lf = s.lf === k ? '' : k;
    s.lim = 15;
    this.retRenderLinesBody();
  },

  retToggleEx(id) {
    const s = this.retState();
    const k = String(id);
    if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k);
    this.retRenderLinesBody();
  },

  retMoreLines() {
    this.retState().lim += 15;
    this.retRenderLinesBody();
  },

  // --- 冲销记录 ---
  retReversalPanel(revs) {
    if (!revs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    return `<ul class="pu-items">` + revs.map(r => `<li class="pu-item">
      <div class="pu-item-top">
        <div>
          <button type="button" class="pu-lk" onclick="App.retSelectDoc('${this.retEsc(r.doc_no)}')">${this.retEsc(r.doc_no)}</button>
          <div class="pu-log-meta">${this.fmtDate(r.date)}</div>
        </div>
        ${this.retStatusBadge(r.status)}
      </div></li>`).join('') + `</ul>`;
  },

  retDocModel() {
    const d = this._retData;
    if (!d) return null;
    const vp = this.canViewPrice();
    const dd = d.direction === 'in' ? 1 : -1;
    const sum = d.summary || {};
    const cols = [
      { label: this.t('mat_code'), key: 'code' },
      { label: this.t('mat_name'), key: 'material_name' },
      { label: this.t('mat_spec'), key: 'material_spec' },
      { label: this.t('mat_unit'), key: 'material_unit' },
      { label: this.t('ret_qty'), align: 'right', value: r => this.fmtQty(dd * Math.abs(Number(r.qty || 0))) },
    ];
    if (vp) {
      cols.push({ label: this.t('ledger_price'), align: 'right', value: r => this.fmtMoney(d.ledger === 'inbound' ? r.price : r.cost_price) });
      cols.push({ label: this.t('ledger_amount'), align: 'right', value: r => this.fmtMoney(d.ledger === 'inbound' ? r.amount : r.cost_amount) });
    }
    if (!d.is_reversal) {
      cols.push({ label: this.t('ret_reversed'), align: 'right', value: r => this.fmtQty(Math.abs(Number(r.reversed_qty || 0))) });
      cols.push({ label: this.t('ret_remaining'), align: 'right', value: r => this.fmtQty(Math.abs(Number(r.qty || 0)) - Math.abs(Number(r.reversed_qty || 0))) });
    }
    cols.push({ label: this.t('ibd_remarks'), value: r => r.remarks || '' });

    const meta = [
      [this.t('ret_subtype'), this.retTypeLabel(d)],
      [this.t('ret_date'), this.fmtDate(d.date)],
      [this.t('ret_party'), d.party || ''],
      [this.t('ret_handler'), d.handler || ''],
      [this.t('ret_ref'), d.ref_no || ''],
      [this.t('ret_status'), this.retStatusBadge(d.status).replace(/<[^>]+>/g, '')],
      [this.t('ret_lines'), String((d.lines || []).length)],
      [this.t('ret_qty'), this.fmtQty(dd * Number(sum.total_qty || 0))],
    ];
    if (d.return_tier) meta.push([this.t('ret_tier'), this.retTierLabel(d.return_tier)]);
    if (d.no_origin) meta.push([this.t('ret_no_origin_reason'), d.return_reason || '']);
    if (!d.is_reversal) {
      meta.push([this.t('ret_reversed'), this.fmtQty(dd * Number(sum.reversed_qty || 0))]);
      meta.push([this.t('ret_remaining'), this.fmtQty(dd * Number(sum.remaining_qty || 0))]);
    }
    meta.push([this.t('ibd_remarks'), d.remarks || '']);

    return {
      title: d.doc_no,
      subtitle: this.retTypeLabel(d),
      meta, columns: cols, rows: d.lines || [],
      filename: `${d.doc_no}_${this.today().replace(/-/g, '')}.csv`,
    };
  },

  retPrintDoc() {
    const doc = this.retDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.printDoc(doc);
  },

  retExportDoc() {
    const doc = this.retDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.exportDocCsv(doc);
    this.toast(this.t('doc_export_done', { name: doc.filename }));
  },

  async retConfirm(docNo, ledger) {
    if (!confirm(this.t('ret_confirm_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo) + '/confirm', 'POST');
      this.toast(this.t('ret_confirmed'));
      await this.retLoadList();
      await this.retSelectDoc(docNo, true);
    } catch (e) {
      this.toast(e.message || this.t('ret_confirm_failed'), 'error');
    }
  },

  async retConfirmReversal(docNo, ledger) {
    if (!confirm(this.t('ret_rev_confirm_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo) + '/reversal-confirm', 'POST', {});
      this.toast(this.t('ret_rev_confirmed'));
      await this.retLoadList();
      await this.retSelectDoc(docNo, true);
    } catch (e) {
      this.toast(e.message || this.t('ret_rev_confirm_failed'), 'error');
    }
  },

  async retDelete(docNo, ledger) {
    if (!confirm(this.t('ret_delete_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo), 'DELETE');
      this.toast(this.t('deleted'));
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
