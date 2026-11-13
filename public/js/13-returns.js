/**
 * 退货与退库模块
 *
 * 只做聚合展示：采购退货（入库账本）、领料退库（出库账本）。
 * 写入复用现有 inbound/outbound 接口与页面，不复制业务逻辑。
 *
 * 交互与视觉以「入库模块」（05-inbound.js）为唯一标准：
 *  - 页签（全部 / 采购退货 / 领料退库 / 作废记录）+ 条件区 + 状态 KPI + 列表
 *  - 点行在右侧 .pu-insp 面板原地展开（.pu-split.open），不再整页跳转
 *  - 详情面板：类型小标题 + 单号 + 状态徽标 + 两列字段 + 子页签（明细 / 操作日志）
 *    + 底部固定操作条（编辑/确认 → 打印 → 导出 → 更正 → 删除）
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
        tab: '', kpi: '', kw: '', from: '', to: '', sel: '', noOrigin: false,
        dt: 'lines', wide: false, dense: false,
        lq: '', lim: 15, ex: new Set(),
      };
    }
    return this._retState;
  },

  retTabDefs() {
    return [
      ['', this.t('ret_tab_all')],
      ['采购退货', this.t('ret_tab_purchase')],
      ['领料退库', this.t('ret_tab_stock')],
      ['voided', this.t('ibd_void_tab')],
    ];
  },

  retKpiDefs() {
    return [
      ['', this.t('ret_tab_all'), r => true],
      ['draft', this.t('ibd_status_draft'), r => r.status === 'draft'],
      ['posted', this.t('ibd_status_posted'), r => r.status === 'posted'],
      ['voided', this.t('ibd_status_voided'), r => r.status === 'voided'],
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
      // 跨模块跳转：按单据真实状态切页签、清掉挡住该行的筛选并翻到该行
      this.retRevealDoc(no);
      await this.retSelectDoc(no);
      this.docRowFlash('ret-scroll', 'tr[data-ra="returns"][data-id="' + CSS.escape(String(no)) + '"]');
    } else if (s.sel) {
      await this.retSelectDoc(s.sel, true);
    } else {
      this.retRenderInspector();
    }
  },

  // 退库页样式已收敛到 public/css/pages.css，不再运行时注入

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
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)"><input type="checkbox" id="ret_f_noorigin"${s.noOrigin ? ' checked' : ''} onchange="App.retApplyFilter()"> ${this.t('ret_filter_no_origin')}</label>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.retClearFilter()">${this.t('pu_clear_filter')}</button>
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.dense}" onclick="App.retToggleDense(this)">${this.t('pu_dense')}</button>`;
  },

  retRenderHeadActions() {
    const box = document.getElementById('ret-head-actions');
    if (!box) return;
    const s = this.retState();
    if (!this.can('returns', 'create') || s.tab === 'voided') { box.innerHTML = ''; return; }
    box.innerHTML = `<button type="button" class="btn btn-primary" onclick="App.retPickOrigin('purchase')">+ ${this.t('ret_new_purchase_origin')}</button>
      <button type="button" class="btn btn-outline" onclick="App.retPickOrigin('stock')">+ ${this.t('ret_new_stock_origin')}</button>`
      + ((s.tab === '' || s.tab === '领料退库')
        ? `<button type="button" class="btn btn-outline" onclick="App.newOutboundDoc('领料退库', null, true)">+ ${this.t('ret_no_origin_new')}</button>`
        : '');
  },

  // ========== 新建前置：先选原单 ==========
  // kind=purchase：列可退入库单；kind=stock：列可退出库单
  async retPickOrigin(kind) {
    const isPurchase = kind === 'purchase';
    let rows = [];
    try { rows = isPurchase ? await this.retPickPurchaseOrigins() : await this.retPickStockOrigins(); }
    catch (e) { this.toast(e.message, 'error'); return; }
    if (!rows.length) { this.toast(this.t('ret_pick_empty'), 'error'); return; }
    const title = isPurchase ? this.t('ret_pick_origin_title_purchase') : this.t('ret_pick_origin_title_stock');
    const partyLabel = isPurchase ? this.t('ibd_supplier') : this.t('ret_col_origin_party');
    const table = `<div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr>
        <th style="width:36px"></th><th>${this.t('ret_col_doc_no')}</th><th>${this.t('ret_col_date')}</th>
        <th>${partyLabel}</th><th class="text-right">${this.t('ret_col_origin_total')}</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr style="cursor:pointer" onclick="document.getElementById('ret_pick_${i}').checked=true">
          <td><input type="radio" name="ret_pick" id="ret_pick_${i}" value="${this.retEsc(r.doc_no)}"></td>
          <td><b>${this.retEsc(r.doc_no)}</b></td><td>${this.retEsc(this.fmtDocDate(r.date, r.created_at, r.confirmed_at) || '')}</td>
          <td>${this.retEsc(r.party || '-')}</td><td class="text-right"><b>${this.fmtQty(r.total)}</b></td></tr>`).join('')}
        </tbody></table></div><div style="font-size:12px;color:var(--text-muted);margin-top:10px">${this.t('ret_pick_origin_hint')}</div>`;
    this.showModal(title, table, this.t('ret_pick_enter'), () => {
      const sel = document.querySelector('input[name="ret_pick"]:checked');
      if (!sel) { this.toast(this.t('ret_pick_required'), 'error'); return; }
      this.closeModal();
      if (isPurchase) this.newInboundDoc('采购退货', sel.value);
      else this.newOutboundDoc('领料退库', sel.value);
    }, null, true);
    if (rows.length === 1) document.getElementById('ret_pick_0')?.click();
  },

  async retPickPurchaseOrigins() {
    const origins = await this.api('/api/returns/purchase/origins') || [];
    const out = [];
    for (const o of origins) {
      let lines = [];
      try { lines = await this.api('/api/returns/purchase/origin-lines?docNo=' + encodeURIComponent(o.doc_no)); } catch { lines = []; }
      const total = (lines || []).reduce((sum, l) => sum + Math.max(0, Number(l.available) || 0), 0);
      if (total > 0) out.push({ doc_no: o.doc_no, date: o.date || '', party: o.supplier || '', total });
    }
    return out;
  },

  async retPickStockOrigins() {
    const res = await this.api('/api/outbound-docs?txnType=' + encodeURIComponent('正常出库') + '&pageSize=200');
    const docs = (res.items && res.items.length ? res.items : res) || [];
    const out = [];
    for (const d of docs.filter(x => x.status === 'posted')) {
      let res = {};
      try { res = await this.api('/api/outbound-docs/' + encodeURIComponent(d.doc_no) + '/returnable'); } catch { res = {}; }
      const total = (res.lines || []).reduce((sum, l) => sum + Math.max(0, Number(l.remaining) || 0), 0);
      if (total > 0) out.push({ doc_no: d.doc_no, date: d.date || '', party: d.destination || '', total });
    }
    return out;
  },

  // 跨模块跳转定位：按单据真实状态（作废 / 采购退货 / 领料退库）切页签，
  // 当前筛选若把该单挡在外面则清掉，并翻到该行所在页
  retRevealDoc(docNo) {
    const row = (this._retList || []).find(r => r.doc_no === docNo);
    if (!row) return false;
    const s = this.retState();
    const want = row.status === 'voided' ? 'voided' : (row.sub_type || '');
    s.tab = this.retTabDefs().some(d => d[0] === want) ? want : '';
    if (!this.retVisibleRows().some(r => r.doc_no === docNo)) {
      s.kw = ''; s.from = ''; s.to = ''; s.kpi = ''; s.noOrigin = false;
      this.retRenderFilters();
    }
    const st = this.getTableState('returns');
    st.page = 1;
    const rows = this.sortData(this.retVisibleRows(), st.sortKey, st.sortDir);
    const idx = rows.findIndex(r => r.doc_no === docNo);
    if (idx >= 0) st.page = Math.floor(idx / st.pageSize) + 1;
    this.retRenderTabs();
    this.retRenderHeadActions();
    this.retRenderList();
    return true;
  },

  retSwitchTab(tab) {
    const s = this.retState();
    s.tab = tab;
    s.sel = '';
    const st = this.getTableState('returns');
    st.page = 1;
    this.retCloseInspector().then(reloaded => { if (!reloaded) this.retRenderList(); });
    this.retRenderTabs();
    this.retRenderHeadActions();
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
    s.noOrigin = !!document.getElementById('ret_f_noorigin')?.checked;
    s.sel = '';
    this.getTableState('returns').page = 1;
    this.retCloseInspector().then(reloaded => { if (!reloaded) this.retRenderList(); });
  },

  retClearFilter() {
    const s = this.retState();
    s.kw = ''; s.from = ''; s.to = ''; s.kpi = ''; s.sel = ''; s.noOrigin = false;
    this.getTableState('returns').page = 1;
    this.retRenderFilters();
    this.retCloseInspector().then(reloaded => { if (!reloaded) this.retRenderList(); });
  },

  retSetKpi(kpi) {
    const s = this.retState();
    s.kpi = s.kpi === kpi ? '' : kpi;
    s.sel = '';
    this.getTableState('returns').page = 1;
    this.retCloseInspector().then(reloaded => { if (!reloaded) this.retRenderList(); });
  },

  // 聚合接口按页返回，这里全量拉取后在前端做筛选/排序/分页，与入库模块口径一致
  async retLoadList() {
    const PAGE = 200;
    try {
      const first = await this.api('/api/returns/docs?includeHistory=1&page=1&pageSize=' + PAGE);
      let items = (first.items || []).slice();
      const totalPages = Number(first.totalPages || 1);
      for (let p = 2; p <= totalPages; p++) {
        const next = await this.api('/api/returns/docs?includeHistory=1&page=' + p + '&pageSize=' + PAGE);
        items = items.concat(next.items || []);
      }
      this._retList = items;
    } catch (e) {
      this._retList = [];
      this.toast(e.message || this.t('ret_load_failed'), 'error');
    }
    this.retRenderList();
    this.markFresh('returns');
  },

  retRowsByTab() {
    const s = this.retState();
    const rows = this._retList || [];
    if (s.tab === 'voided') return rows.filter(r => r.status === 'voided');
    const scoped = s.tab ? rows.filter(r => r.sub_type === s.tab) : rows;
    return scoped.filter(r => r.status !== 'voided');
  },

  retVisibleRows() {
    const s = this.retState();
    let rows = this.retRowsByTab();
    if (s.kw) {
      // 关键字搜索时补回作废单（灰显）
      const all = s.tab === 'voided'
        ? (this._retList || []).filter(r => r.status === 'voided')
        : (this._retList || []).filter(r => (s.tab ? r.sub_type === s.tab : true));
      rows = all;
      rows = this.filterByKeywords(rows, s.kw, ['doc_no', 'sub_type', 'party', 'ref_no', 'handler', 'remarks', 'corrected_by_doc_no']);
    }
    rows = this.filterByDateRange(rows, 'date', s.from, s.to);
    if (s.noOrigin) rows = rows.filter(r => r.no_origin);
    if (s.kpi) rows = rows.filter(r => r.status === s.kpi);
    return rows;
  },

  retHasFilter() {
    const s = this.retState();
    return !!(s.kw || s.from || s.to || s.kpi || s.tab || s.noOrigin);
  },

  retStatusBadge(status) {
    const label = { draft: 'ibd_status_draft', posted: 'ibd_status_posted', voided: 'ibd_status_voided' };
    if (!label[status]) return `<span class="badge badge-muted">${this.retEsc(status || '-')}</span>`;
    return `<span class="badge ${this.docStatusMeta(status).cls}">${this.t(label[status])}</span>`;
  },

  // 明细页签文案按子类型区分：采购退货/领料退库各有专属叫法
  retLinesLabel(doc) {
    const st = (doc && doc.sub_type) || '';
    if (st === '采购退货') return this.t('ret_lines_purchase');
    if (st === '领料退库') return this.t('ret_lines_stock');
    return this.t('pu_tab_detail_lines');
  },

  retTypeLabel(doc) {
    const st = (doc && doc.sub_type) || '';
    if (st === '采购退货') return this.t('ret_tab_purchase');
    if (st === '领料退库') return this.t('ret_tab_stock');
    return st || '-';
  },

  retSubTypeBadge(subType) {
    const isPurchase = subType === '采购退货';
    const cls = this.docTypeBadgeClass(isPurchase ? '采购退货' : '领料退库');
    return `<span class="badge ${cls}">${this.t(isPurchase ? 'ret_tab_purchase' : 'ret_tab_stock')}</span>`;
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
    // 金额列：以接口是否下发 total_amount 为准
    const vp = pageData.length > 0 ? this.hasField(pageData[0], 'total_amount') : this.canViewPrice();
    const s = this.retState();
    const tid = 'returns';
    const cols = [
      ['doc_no', this.t('ret_no'), r => {
        const subs = [];
        if (r.ref_no) subs.push(`← ${this.retEsc(r.ref_no)}`);
        if (r.corrected_by_doc_no) subs.push(`✎ ${this.retEsc(r.corrected_by_doc_no)}`);
        const sub = subs.length ? `<br><span class="pu-mu">${subs.join('<br>')}</span>` : '';
        return `<button type="button" class="pu-lk" onclick="event.stopPropagation();App.retSelectDoc('${this.retEsc(r.doc_no)}')">${this.retEsc(r.doc_no)}</button>${this.docRevisionBadge(r.doc_no)}${sub}`;
      }],
      ['date', this.t('ret_date'), r => this.fmtDocDate(r.date, r.created_at, r.confirmed_at)],
      ['sub_type', this.t('ret_subtype'), r => this.retSubTypeBadge(r.sub_type)
        + (r.no_origin ? ` <span class="badge badge-muted">${this.t('ret_no_origin_badge')}</span>` : ''), 'center'],
      ['party', this.t('ret_party'), r => this.retEsc(r.party || '-')],
      ['line_count', this.t('ret_lines'), r => r.line_count || 0, true],
      ['total_qty', this.t('ret_qty'), r => this.qtyCell(r.direction === 'in' ? r.total_qty : -r.total_qty), true],
      ['total_amount', this.t('ret_amount'), r => this.fmtMoney(r.total_amount), true, vp],
      ['status', this.t('ret_status'), r => this.retStatusBadge(r.status), 'center'],
      ['remarks', this.t('ibd_remarks'), r => this.retEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = pageData.map(r => {
      const on = s.sel === r.doc_no;
      return `<tr class="pu-row${on ? ' sel' : ''}${r.status === 'voided' ? ' ret-voided-row' : ''}" data-ra="returns" data-id="${this.retEsc(r.doc_no)}" onclick="App.retSelectDoc('${this.retEsc(r.doc_no)}')">` +
        shown.map(c => `<td class="${this.colAlignClass(c[3])}">${c[2](r)}</td>`).join('') + '</tr>';
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
      + ` · ${this.t('ibd_status_posted')} ${rows.filter(r => r.status === 'posted').length}`
      + ` · ${this.t('ibd_status_voided')} ${rows.filter(r => r.status === 'voided').length}`;
    if (rows.length && this.hasField(rows[0], 'total_amount')) tot += ` · ${this.t('ret_amount')} ${this.fmtMoney(sum('total_amount'))}`;
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
  // 返回 true 表示因数据已变化而补拉了列表
  async retCloseInspector() {
    const insp = document.getElementById('ret-insp');
    const split = document.getElementById('ret-split');
    const s = this.retState();
    s.sel = ''; s.wide = false;
    if (insp) { insp.hidden = true; insp.innerHTML = ''; }
    if (split) split.classList.remove('open', 'wide');
    if (this.isStale('returns')) { await this.retLoadList(); return true; }
    return false;
  },

  // 兼容旧入口：从采购单详情等直接打开退货单
  openReturnDoc(docNo) {
    if (!this.can('returns', 'view')) {
      this.toast(this.t('no_perm_msg'), 'error');
      return;
    }
    this._retPendingDoc = docNo;
    return this.gotoPage('returns');
  },

  retOpenDoc(docNo) {
    return this.retSelectDoc(docNo);
  },

  async retSelectDoc(docNo, silent) {
    const s = this.retState();
    if (s.sel !== docNo) { s.dt = 'lines'; s.lq = ''; s.lim = 15; s.ex = new Set(); }
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
    const logs = d.logs || [];
    if (!['lines', 'logs', 'origin'].includes(s.dt)) s.dt = 'lines';

    const typeLabel = this.retTypeLabel(d);
    const dd = d.direction === 'in' ? 1 : -1;
    const sum = d.summary || {};
    // 汇总金额以服务端是否下发 summary.total_amount 为准
    const vp = this.hasField(sum, 'total_amount');
    const meta = [
      [this.t('ret_subtype'), typeLabel],
      [this.t('ret_date'), this.fmtDocDate(d.date, d.created_at, d.confirmed_at) || '–'],
      [this.t('ret_party'), d.party || '–'],
      [this.t('ret_handler'), d.handler || '–'],
      [this.t('ret_ref'), d.ref_no || '–'],
      [this.t('ret_lines'), String(lines.length)],
      [this.t('ret_qty'), this.fmtQty(dd * Number(sum.total_qty || 0))],
    ];
    if (vp) meta.push([this.t('ret_amount'), this.fmtMoney(sum.total_amount)]);
    // 无原单退库：退库原因随单头展示
    if (d.ledger === 'outbound' && String(d.return_reason || '').trim()) {
      meta.push([this.t('ret_return_reason'), d.return_reason]);
    }
    meta.push([this.t('ibd_remarks'), d.remarks || '–']);

    // 关联原单页签恒显示（第二步统一口径），无原单时面板内给空态文案
    const tabs = [
      ['lines', this.retLinesLabel(d), lines.length],
      ['origin', this.t(d.ledger === 'inbound' ? 'retd_tab_origin_inbound' : 'retd_tab_origin_outbound'), d.origin_doc ? 1 : 0],
      ['logs', this.t('pu_tab_logs'), logs.length],
    ];

    // 底部操作条：业务操作 → 打印/导出 → 修改 → 删除（高危固定最右）
    const isDraft = d.status === 'draft';
    const isCorrDraft = isDraft && !!String(d.corrects_doc_no || '');
    const canEdit = this.can(d.ledger, isCorrDraft ? 'correct' : 'edit');
    const canDelete = this.can(d.ledger, 'delete');
    let foot = '';
    if (isDraft && canEdit) {
      if (d.can_edit) foot += `<button type="button" class="btn btn-outline" onclick="App.${d.ledger === 'inbound' ? 'editInboundDoc' : 'editOutboundDoc'}('${this.retEsc(d.doc_no)}')">${lines.length ? this.t('ret_edit') : '+ ' + this.t('ibd_add_line')}</button>`;
      if (d.can_confirm) foot += `<button type="button" class="btn btn-primary" onclick="App.retConfirm('${this.retEsc(d.doc_no)}','${d.ledger}')">${this.t('ret_confirm')}</button>`;
    }
    foot += `<button type="button" class="btn btn-outline" onclick="App.retPrintDoc()">${this.t('doc_print')}</button>`;
    foot += `<button type="button" class="btn btn-outline" onclick="App.retExportDoc()">${this.t('doc_export')}</button>`;
    // 更正入口：已过账、未被更正过（作废单不可再更正），且需该账本 correct 权限
    if (d.can_correct && this.can(d.ledger, 'correct')) {
      foot += `<button type="button" class="btn btn-outline" onclick="App.retStartCorrection('${this.retEsc(d.doc_no)}','${d.ledger}')">${this.t('ibd_corr')}</button>`;
    }
    if (isDraft && canDelete) {
      foot += `<button type="button" class="btn btn-danger" onclick="App.retDelete('${this.retEsc(d.doc_no)}','${d.ledger}')">${this.t('ret_delete')}</button>`;
    }

    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" onclick="App.retBackToList()">← ${this.t('pu_back_list')}</button>
      ${this.crossLinkBackBtn('returns', d.doc_no)}
      <div class="pu-insp-head">
        <div>
          <small>${typeLabel}${d.no_origin ? ` · ${this.t('ret_no_origin_badge')}` : ''}</small>
          <h2>${this.retEsc(d.doc_no)} ${this.docRevisionBadge(d.doc_no)}</h2>
          <span class="pu-badge">${this.retStatusBadge(d.status)}</span>
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}" onclick="App.retToggleWide()">${s.wide ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" title="${this.t('pu_close_detail')}" onclick="App.retBackToList()">✕</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${this.retEsc(m[0])}</dt><dd>${this.retEsc(m[1])}</dd></div>`).join('')}</dl>
      ${d.status === 'voided' ? `<div style="margin:8px 0;padding:8px 10px;border-radius:6px;background:var(--danger-bg);color:var(--danger);font-size:12px;font-weight:600">${this.t('ibd_voided_banner', { time: this.fmtDateTime(d.voided_at) || '–', by: d.voided_by || '–' })}${d.corrected_by_doc_no ? ` <button type="button" class="pu-lk" onclick="App.retSelectDoc('${this.retEsc(d.corrected_by_doc_no)}')">${this.retEsc(d.corrected_by_doc_no)}</button>` : ''}</div>` : ''}
      ${d.status !== 'voided' && d.corrected_by_doc_no ? `<div style="margin:8px 0;font-size:12px">${this.t('ibd_corr_to')} <button type="button" class="pu-lk" onclick="App.retSelectDoc('${this.retEsc(d.corrected_by_doc_no)}')">${this.retEsc(d.corrected_by_doc_no)}</button></div>` : ''}
      ${d.corrects_doc_no ? `<div style="margin:8px 0;font-size:12px">✎ ${this.t('ibd_corr_from')} <button type="button" class="pu-lk" onclick="App.retSelectDoc('${this.retEsc(d.corrects_doc_no)}')">${this.retEsc(d.corrects_doc_no)}</button></div>` : ''}
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
    this.retCloseInspector().then(reloaded => { if (!reloaded) this.retRenderList(); });
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
    if (s.dt === 'origin') return this.retRenderOriginDoc(d);
    box.innerHTML = this.ibLogsPanel(d.logs || []);
  },

  // 关联原单：采购退货 → 原入库单；领料退库 → 原出库单
  retRenderOriginDoc(d) {
    const box = document.getElementById('ret-dpanel');
    if (!box) return;
    const o = d.origin_doc;
    if (!o) {
      box.innerHTML = `<div class="pu-empty">${this.t(d.no_origin ? 'ret_no_origin_tab_empty' : 'ret_no_origin')}</div>`;
      return;
    }
    const target = d.ledger === 'inbound' ? 'inbound' : 'outbound';
    box.innerHTML = `<div class="rel-list">${this.relatedDocItemHtml({
      target,
      doc: o,
      fromKind: 'returns',
      fromDoc: d.doc_no,
      typeLabel: d.ledger === 'inbound'
        ? this.ibTypeLabel(o.txn_type)
        : (o.txn_type === '领料退库' ? this.t('out_return') : this.t('out_normal')),
      statusBadge: this.retStatusBadge(o.status),
      qty: o.total_qty,
      amount: o.total_amount,
    })}</div>`;
  },

  // --- 明细：与入库一致的手风琴（宽屏时切换为整表） ---
  retRenderLinesBody() {
    const s = this.retState();
    const box = document.getElementById('ret-dpanel');
    const d = this._retData;
    if (!box || !d) return;
    const lines = d.lines || [];
    const dd = d.direction === 'in' ? 1 : -1;
    const vp = lines.length > 0 && this.hasField(lines[0], d.ledger === 'inbound' ? 'price' : 'cost_price');
    if (s.wide) {
      const cols = [
        [this.t('pu_material'), l => this.ibLineLabel(l)],
        [this.t('ret_qty'), l => this.qtyCell(dd * Math.abs(Number(l.qty || 0)))],
      ];
      if (vp) {
        cols.push([this.t('ledger_price'), l => this.fmtMoney(d.ledger === 'inbound' ? l.price : l.cost_price)]);
        cols.push([this.t('ledger_amount'), l => this.fmtMoney(d.ledger === 'inbound' ? l.amount : l.cost_amount)]);
      }
      cols.push([this.t('ibd_remarks'), l => this.retEsc(l.remarks || '')]);
      box.innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map((c, i) => `<th${i >= 1 && i < cols.length - 1 ? ' class="text-right"' : ''}>${c[0]}</th>`).join('')}</tr></thead><tbody>${
        lines.map(l => '<tr>' + cols.map((c, i) => `<td${i >= 1 && i < cols.length - 1 ? ' class="text-right"' : ''}>${c[1](l)}</td>`).join('') + '</tr>').join('')
      }</tbody></table></div>`;
      return;
    }
    const f = lines.filter(l => {
      if (s.lq && !this.puKwMatch([l.code, l.material_name, l.material_spec, l.material_brand, l.remarks].join(' '), s.lq)) return false;
      return true;
    });
    const shown = Math.min(s.lim, f.length);

    let html = `<div class="pu-lqtoolbar">
      <input id="ret_lqi" type="search" value="${this.retEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}"
        oninput="if(!event.isComposing)App.retLineSearch(this.value)" oncompositionend="App.retLineSearch(this.value)">
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
      const price = d.ledger === 'inbound' ? l.price : l.cost_price;
      const amount = d.ledger === 'inbound' ? l.amount : l.cost_amount;
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" aria-expanded="${ex}" onclick="App.retToggleEx('${l.id}')">
          <span class="pu-line-n"><strong>${this.retEsc(l.code)}</strong> ${this.retEsc(l.material_name || '')} <span class="pu-mu">${this.retEsc(l.material_spec || '')}${l.material_brand ? ` · ${this.retEsc(l.material_brand)}` : ''}</span></span>
          <span class="pu-line-q">${this.qtyCell(dd * Math.abs(Number(l.qty || 0)))}${this.retEsc(l.material_unit || '')}</span>
        </button>
        ${ex ? `<div class="pu-line-d">
          ${vp ? `<div class="pu-mu">${this.t('ledger_price')} ${this.fmtMoney(price)} · ${this.t('ledger_amount')} ${this.fmtMoney(amount)}</div>` : ''}
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

  retDocModel() {
    const d = this._retData;
    if (!d) return null;
    // 导出金额列以汇总是否下发 total_amount 为准
    const vp = this.hasField(d.summary || {}, 'total_amount');
    const dd = d.direction === 'in' ? 1 : -1;
    const sum = d.summary || {};
    const cols = [
      {
        label: this.t('pu_material'),
        value: r => {
          const base = `${r.code || ''} · ${r.material_name || ''} ${r.material_spec || ''}`.trim();
          return r.material_brand ? `${base} · ${r.material_brand}` : base;
        },
      },
      { label: this.t('ret_qty'), align: 'right', value: r => this.fmtQty(dd * Math.abs(Number(r.qty || 0))) },
    ];
    if (vp) {
      cols.push({ label: this.t('ledger_price'), align: 'right', value: r => this.fmtMoney(d.ledger === 'inbound' ? r.price : r.cost_price) });
      cols.push({ label: this.t('ledger_amount'), align: 'right', value: r => this.fmtMoney(d.ledger === 'inbound' ? r.amount : r.cost_amount) });
    }
    cols.push({ label: this.t('ibd_remarks'), value: r => r.remarks || '' });

    const meta = [
      [this.t('ret_subtype'), this.retTypeLabel(d)],
      [this.t('ret_date'), this.fmtDocDate(d.date, d.created_at, d.confirmed_at)],
      [this.t('ret_party'), d.party || ''],
      [this.t('ret_handler'), d.handler || ''],
      [this.t('ret_ref'), d.ref_no || ''],
      [this.t('ret_status'), this.retStatusBadge(d.status).replace(/<[^>]+>/g, '')],
      [this.t('ret_lines'), String((d.lines || []).length)],
      [this.t('ret_qty'), this.fmtQty(dd * Number(sum.total_qty || 0))],
    ];
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

  async retDelete(docNo, ledger) {
    if (!confirm(this.t('ret_delete_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo), 'DELETE');
      this.toast(this.t('deleted'));
      await this.retLoadList();
      await this.retCloseInspector();
    } catch (e) {
      this.toast(e.message || this.t('requestFailed'), 'error');
    }
  },

  // 更正入口：按账本路由到入库/出库更正流程
  retStartCorrection(docNo, ledger) {
    return ledger === 'inbound' ? this.startInboundCorrection(docNo) : this.startOutboundCorrection(docNo);
  },
});
