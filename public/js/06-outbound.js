/**
 * 出库管理 —— 单据列表 / 详情 / 独立编辑页面
 *
 * 设计说明（对齐入库页 2026-11-03）：
 *  - 列表展示出库单据（单号/日期/类型/去向/行数/数量/状态），点击进入详情页
 *  - 详情页参考入库详情页设计：单据基本信息 + 全部物料明细 + 创建/审核信息 + 操作日志
 *  - 新建/编辑用独立编辑页面（非模态窗口），支持存草稿、草稿继续编辑
 *  - 确认出库（过账）后生成库存流水，已过账单据不可直接修改，只能通过「更正重开」调整
 *  - 草稿可作废/删除；同一张单据可添加多条不同物料；删明细只删当前行
 *  - 选择物料弹出物料选择窗口
 *  - 视图：list / detail / new / edit
 */
Object.assign(App, {

  // ========== 状态（对齐入库 ibState） ==========
  obState() {
    if (!this._ob) this._ob = {};
    const s = this._ob;
    if (s.tab === undefined) s.tab = '';      // 视图页签：'' | 正常出库 | voided（作废记录）
    if (s.hist === undefined) s.hist = false; // 历史版本开关
    if (s.sel === undefined) s.sel = null;    // 右侧详情栏当前单据号
    if (!s.dt) s.dt = 'lines';                // 详情子页签：lines | related | logs
    if (s.wide === undefined) s.wide = false;
    if (s.dense === undefined) s.dense = false;
    if (s.kpi === undefined) s.kpi = '';
    if (!s.f) s.f = { kw: '', from: '', to: '' };
    if (!s.lq) s.lq = '';
    if (s.lim === undefined) s.lim = 15;
    if (!s.ex) s.ex = new Set();
    if (!this._obDetailCache) this._obDetailCache = {};
    if (!this._obList) this._obList = [];
    return s;
  },

  // ========== 页面骨架（对齐入库：页签 + 条件区 + KPI + 列表/详情栏） ==========
  async renderOutbound() {
    const s = this.obState();
    this._obView = 'list';
    this.setMain(this.pageWrap('📤 ' + this.t('obd_title'), this.t('obd_desc'), '', this.obSkeleton()));
    const pb = document.querySelector('.page-body');
    if (pb) pb.classList.add('pu-page-body');
    this.obBindEvents();
    this.obRenderTabs();
    this.obRenderFilters();
    this.obRenderHeadActions();
    const root = document.getElementById('ob-root');
    if (root) root.classList.toggle('ob-dense', !!s.dense);
    await this.loadOutboundList();
    // 跨模块跳转（查询中心「在原模块打开」等）：先按单据真实状态把行定位到列表
    const reveal = this._obRevealDoc;
    if (reveal) {
      this._obRevealDoc = null;
      this.obRevealDoc(reveal);
    }
    // 进入页面时若有选中的单据，强制重取详情，避免复用上次的快照
    if (s.sel) await this.obOpen(s.sel); else this.obRenderInspector();
    if (reveal) this.docRowFlash('ob-scroll', 'tr[data-ra="outbound"][data-id="' + CSS.escape(String(reveal)) + '"]');
  },

  obSkeleton() {
    return `<div id="ob-root" class="data-page">
      <div class="data-toolbar">
        <nav id="ob-tabs" class="pu-viewtabs" role="tablist" aria-label="${this.t('obd_title')}"></nav>
        <div class="pu-toolbar">
          <div id="ob-filters" class="pu-filter-inner"></div>
          <div id="ob-head-actions" class="pu-head-actions"></div>
        </div>
      </div>
      <div id="ob-kpis" class="pu-kpis" role="group" aria-label="${this.t('obd_status')}"></div>
      <div class="pu-split" id="ob-split">
        <section class="pu-list">
          <div class="data-scroll" id="ob-scroll"></div>
          <div class="pu-pager" id="ob-pager"></div>
        </section>
        <aside class="pu-insp" id="ob-insp" hidden aria-label="${this.t('obd_view_detail')}"></aside>
      </div>
    </div>`;
  },

  // 视图页签：全部 / 正常出库 / 作废记录（草稿/已过账走 KPI 卡片）
  obTabDefs() {
    return [
      ['', this.t('all')],
      ['正常出库', this.t('out_normal')],
      ['voided', this.t('ibd_void_tab')],
    ];
  },

  obRenderTabs() {
    const box = document.getElementById('ob-tabs');
    if (!box) return;
    const s = this.obState();
    box.innerHTML = this.obTabDefs().map(([k, label]) =>
      `<button type="button" class="pu-viewtab" role="tab" aria-selected="${s.tab === k}" data-ob="tab" data-id="${k}">${label}</button>`
    ).join('');
  },

  obRenderHeadActions() {
    const box = document.getElementById('ob-head-actions');
    if (!box) return;
    box.innerHTML = this.can('outbound', 'create')
      ? `<button type="button" class="btn btn-primary" data-ob="new">+ ${this.t('obd_add')}</button>` : '';
  },

  obRenderFilters() {
    const box = document.getElementById('ob-filters');
    if (!box) return;
    const s = this.obState();
    const ph = this.t('obd_filter_hint');
    box.innerHTML = `<div class="pu-search" role="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="ob_f_kw" type="search" value="${this.ibEsc(s.f.kw)}" placeholder="${ph}" aria-label="${ph}">
      </div>
      <div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="ob_f_from">${this.t('pu_date')}</label>
        <input id="ob_f_from" type="date" value="${this.ibEsc(s.f.from)}" aria-label="${this.t('pu_date')}">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="ob_f_to" type="date" value="${this.ibEsc(s.f.to)}" aria-label="${this.t('pu_date')}">
      </div>
      <button type="button" class="btn btn-outline btn-sm" data-ob="clr">${this.t('pu_clear_filter')}</button>
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.hist}" data-ob="hist">${this.t('ibd_corr_history')}</button>
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.dense}" data-ob="dense">${this.t('pu_dense')}</button>`;
  },

  async loadOutboundList() {
    try {
      // 领料退库已迁入「退货与退库」模块，出库列表默认排除，避免重复展示
      this._obList = await this.api('/api/outbound-docs?excludeType=' + encodeURIComponent('领料退库') + '&includeHistory=1');
    } catch (e) {
      this._obList = [];
      const scroll = document.getElementById('ob-scroll');
      if (scroll) scroll.innerHTML = `<div class="pu-empty">${this.ibEsc(e.message)}</div>`;
      const pg = document.getElementById('ob-pager'); if (pg) pg.innerHTML = '';
      const kp = document.getElementById('ob-kpis'); if (kp) kp.innerHTML = '';
      return;
    }
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['outbound'] = () => this.obRenderList();
    this.obRenderList();
    this.markFresh('outbound');
  },

  // ========== 列表渲染（KPI 卡片 + 条件吸附分页） ==========
  obKpiDefs() {
    return [
      ['', this.t('all'), r => true],
      ['draft', this.t('obd_status_draft'), r => r.status === 'draft'],
      ['posted', this.t('obd_status_posted'), r => r.status === 'posted'],
      ['voided', this.t('ibd_status_voided'), r => r.status === 'voided'],
    ];
  },

  obHasFilter() {
    const s = this.obState();
    return !!(s.f.kw || s.f.from || s.f.to || s.kpi || s.tab);
  },

  // 页签 + 历史版本口径（不含关键字/日期/状态卡片），KPI 与列表共用
  obScopeRows() {
    const s = this.obState();
    let rows = this._obList || [];
    if (s.tab === 'voided') rows = rows.filter(r => r.status === 'voided');
    else if (s.tab) rows = rows.filter(r => r.txn_type === s.tab && r.status !== 'voided');
    // 默认隐藏作废单；打开历史版本、输入关键字、或切到作废记录页签时展示
    const showHist = !!s.hist || !!s.f.kw || s.tab === 'voided';
    if (!showHist) rows = rows.filter(r => r.status !== 'voided');
    return rows;
  },

  // 过滤顺序：业务类型页签 → 历史版本 → 关键字 → 日期区间 → 状态卡片
  obVisibleRows() {
    const s = this.obState();
    let rows = this.obScopeRows();
    if (s.f.kw) rows = this.filterByKeywords(rows, s.f.kw, ['doc_no', 'date', 'txn_type', 'destination', 'receiver', 'handler', 'remarks', 'corrects_doc_no', 'corrected_by_doc_no']);
    rows = this.filterByDateRange(rows, 'date', s.f.from, s.f.to);
    const def = this.obKpiDefs().find(d => d[0] === s.kpi);
    return def ? rows.filter(def[2]) : rows;
  },

  obRenderList() {
    const s = this.obState();
    const kp = document.getElementById('ob-kpis');
    if (kp) {
      kp.innerHTML = this.obKpiDefs().map(([k, label, fn]) =>
        `<button type="button" class="pu-kpi" aria-pressed="${s.kpi === k}" data-ob="kpi" data-id="${k}"><small>${label}</small><strong>${this.obScopeRows().filter(fn).length}</strong></button>`
      ).join('');
    }
    const rows = this.obVisibleRows();
    const st = this.getTableState('outbound');
    const sorted = this.sortData(rows, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const scroll = document.getElementById('ob-scroll');
    if (scroll) {
      scroll.innerHTML = sorted.length
        ? this.obListTable(pageData)
        : `<div class="pu-empty">${this.t('pu_no_result')}<br><span class="pu-mu">${this.obHasFilter() ? this.t('pu_no_result_hint') : this.t('pu_empty_hint')}</span></div>`;
    }
    this.obRenderPager(sorted);
    this.obUpdatePagerSticky();
  },

  obListTable(pageData) {
    // 金额列：以接口是否下发 total_amount 为准
    const vp = pageData.length > 0 ? this.hasField(pageData[0], 'total_amount') : this.canViewPrice();
    const sel = this.obState().sel;
    const tid = 'outbound';
    const cols = [
      ['doc_no', this.t('obd_no'), r => {
        const subs = [];
        if (r.corrects_doc_no) subs.push(`✎ ${this.t('ibd_corr_from')} ${this.ibEsc(r.corrects_doc_no)}`);
        if (r.corrected_by_doc_no) subs.push(`→ ${this.t('ibd_corr_to')} ${this.ibEsc(r.corrected_by_doc_no)}`);
        const sub = subs.length ? `<br><span class="pu-mu">${subs.join('<br>')}</span>` : '';
        return `<button type="button" class="pu-lk" data-ob="open" data-id="${this.ibEsc(r.doc_no)}">${this.ibEsc(r.doc_no)}</button>${this.docRevisionBadge(r.doc_no)}${sub}`;
      }],
      ['date', this.t('obd_date'), r => this.fmtDocDate(r.date, r.created_at, r.confirmed_at)],
      ['txn_type', this.t('obd_type'), r => this.obTypeBadge(r.txn_type)
        + (r.no_origin ? ` <span class="badge badge-muted">${this.t('ret_no_origin_badge')}</span>` : ''), 'center'],
      ['destination', this.t('obd_destination'), r => this.ibEsc(r.destination || '')],
      ['line_count', this.t('obd_lines'), r => r.line_count || 0, true],
      ['total_qty', this.t('obd_qty'), r => this.fmtQty(this.qtyAbs(r.total_qty)), true],
      ['total_amount', this.t('obd_amount'), r => this.fmtMoney(r.total_amount), true, vp],
      ['handler', this.t('obd_handler'), r => this.ibEsc(r.handler || '')],
      ['status', this.t('obd_status'), r => this.obdStatusBadge(r.status), 'center'],
      ['remarks', this.t('obd_remarks'), r => this.ibEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = pageData.map(r => {
      const on = sel === r.doc_no;
      const voided = r.status === 'voided';
      return `<tr class="pu-row${on ? ' sel' : ''}${voided ? ' ob-voided-row' : ''}" data-ra="outbound" data-id="${this.ibEsc(r.doc_no)}">` +
        shown.map(c => `<td class="${this.colAlignClass(c[3])}">${c[2](r)}</td>`).join('') + '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  obTypeBadge(t) {
    const key = t === '领料退库' ? 'out_return' : 'out_normal';
    return `<span class="badge ${this.docTypeBadgeClass(t === '领料退库' ? '领料退库' : '正常出库')}">${this.t(key)}</span>`;
  },

  obTypeLabel(t) {
    if (t === '领料退库') return this.t('out_return');
    if (t === '正常出库') return this.t('out_normal');
    return t || '-';
  },

  obRenderPager(rows) {
    const box = document.getElementById('ob-pager');
    if (!box) return;
    const st = this.getTableState('outbound');
    const tp = Math.max(1, Math.ceil(rows.length / st.pageSize));
    if (st.page > tp) st.page = tp;
    if (!rows.length) { box.innerHTML = ''; return; }
    // 各物料单位不统一时数量求和意义有限，底部只统计单据数与金额
    const sum = k => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    let tot = `${this.t('pu_sum_orders', { n: rows.length })}`
      + ` · ${this.t('obd_status_draft')} ${rows.filter(r => r.status === 'draft').length}`
      + ` · ${this.t('obd_status_posted')} ${rows.filter(r => r.status === 'posted').length}`;
    if (rows.length && this.hasField(rows[0], 'total_amount')) tot += ` · ${this.t('obd_amount')} ${this.fmtMoney(sum('total_amount'))}`;
    box.innerHTML = `<span class="pu-tot">${tot}</span>
      <span>${st.page} / ${tp} ${this.t('page')}</span>
      <label>${this.t('pageSize')} <select id="ob-psz">${[10, 15, 20, 50].map(n => `<option value="${n}"${n === st.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-outline btn-sm" data-ob="pg" data-id="-1"${st.page <= 1 ? ' disabled' : ''}>${this.t('pu_prev')}</button>
      <button type="button" class="btn btn-outline btn-sm" data-ob="pg" data-id="1"${st.page >= tp ? ' disabled' : ''}>${this.t('pu_next')}</button>`;
  },

  // 只有内容超出视口时才把分页条吸附到底部
  obUpdatePagerSticky() {
    const pb = document.querySelector('.page-body');
    const pager = document.getElementById('ob-pager');
    if (!pb || !pager) return;
    pager.classList.toggle('pin', pb.scrollHeight > pb.clientHeight + 2);
  },

  // ========== 事件委托 ==========
  obBindEvents() {
    if (this._obBound) return;
    this._obBound = true;

    document.addEventListener('click', e => {
      if (this.currentPage !== 'outbound') return;
      const el = e.target.closest('[data-ob]');
      if (el) { e.preventDefault(); this.obAction(el.dataset.ob, el.dataset.id, el); return; }
      const row = e.target.closest('#ob-root tr[data-ra]');
      if (row && !String(window.getSelection())) this.obAction('open', row.dataset.id, row);
    });

    // 点击详情栏以外的区域 → 自动收起详情栏，返回列表
    document.addEventListener('click', e => {
      const s = this.obState();
      if (!s.sel) return;
      const insp = document.getElementById('ob-insp');
      if (!insp || insp.hidden) return;
      if (e.target.closest('#ob-insp, #ob-root tr[data-ra], [data-ob], #modal-overlay, .pu-ov, .toast')) return;
      this.obCloseInspector();
    }, true);

    document.addEventListener('input', e => {
      if (this.currentPage !== 'outbound') return;
      const s = this.obState();
      if (e.target.id === 'ob_f_kw') {
        s.f.kw = e.target.value;
        clearTimeout(this._obFilterTimer);
        this._obFilterTimer = setTimeout(() => { this.getTableState('outbound').page = 1; this.obRenderList(); }, 250);
      } else if (e.target.id === 'ob_lqi') {
        s.lq = e.target.value;
        // 组词过程中不重绘：重绘会重建输入框，打断中文输入法
        if (e.isComposing || this._obLqComposing) return;
        this.obRenderLinesPanel(); this.ibFocusEnd('ob_lqi');
      }
    });

    document.addEventListener('compositionstart', e => {
      if (e.target.id === 'ob_lqi') this._obLqComposing = true;
    });
    document.addEventListener('compositionend', e => {
      if (e.target.id !== 'ob_lqi') return;
      this._obLqComposing = false;
      if (this.currentPage !== 'outbound') return;
      this.obState().lq = e.target.value;
      this.obRenderLinesPanel(); this.ibFocusEnd('ob_lqi');
    });

    document.addEventListener('change', e => {
      if (this.currentPage !== 'outbound') return;
      const s = this.obState();
      const st = this.getTableState('outbound');
      if (e.target.id === 'ob_f_from') { s.f.from = e.target.value; st.page = 1; this.obRenderList(); }
      else if (e.target.id === 'ob_f_to') { s.f.to = e.target.value; st.page = 1; this.obRenderList(); }
      else if (e.target.id === 'ob-psz') { st.pageSize = parseInt(e.target.value, 10) || 15; st.page = 1; this.obRenderList(); }
    });

    document.addEventListener('keydown', e => {
      if (this.currentPage !== 'outbound') return;
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === '/' && !inField && document.getElementById('ob_f_kw')) { e.preventDefault(); document.getElementById('ob_f_kw').focus(); return; }
      if (e.key === 'Escape') {
        if (document.getElementById('modal-overlay')) { this.closeModal(); return; }
        const ov = document.querySelector('.pu-ov');
        if (ov) { ov.remove(); return; }
        if (this.obState().sel) this.obCloseInspector();
      }
    });

    window.addEventListener('resize', () => {
      if (this.currentPage === 'outbound') this.obUpdatePagerSticky();
    });
  },

  async obCloseInspector() {
    const s = this.obState();
    const prev = s.sel;
    s.sel = null; s.wide = false;
    if (this.isStale('outbound')) {
      // 详情栏开着期间发生过写操作：关闭前补拉一次列表，避免回到旧数据
      await this.loadOutboundList();
    } else {
      this.obRenderList();
    }
    this.obRenderInspector();
    if (prev) {
      const el = document.querySelector(`#ob-scroll [data-ob="open"][data-id="${CSS.escape(String(prev))}"]`);
      if (el) el.focus();
    }
  },

  obAction(name, id, el) {
    const s = this.obState();
    const st = this.getTableState('outbound');
    switch (name) {
      case 'tab': s.tab = id; s.kpi = ''; st.page = 1; this.obRenderTabs(); this.obRenderList(); return;
      case 'open': return this.obOpen(id);
      case 'icl': return this.obCloseInspector();
      case 'wide': s.wide = !s.wide; this.obRenderInspector(); return;
      case 'dt': s.dt = id; s.lim = 15; this.obRenderInspector(); return;
      case 'kpi': s.kpi = s.kpi === id ? '' : id; st.page = 1; this.obRenderList(); return;
      case 'hist': s.hist = !s.hist; st.page = 1; this.obRenderFilters(); this.obRenderList(); return;
      case 'clr': s.f = { kw: '', from: '', to: '' }; s.kpi = ''; st.page = 1; this.obRenderFilters(); this.obRenderList(); return;
      case 'dense': s.dense = !s.dense; document.getElementById('ob-root').classList.toggle('ob-dense', s.dense); if (el) el.setAttribute('aria-pressed', String(s.dense)); return;
      case 'pg': st.page += Number(id); this.obRenderList(); return;
      case 'ex': { const k = String(id); if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k); this.obRenderLinesPanel(); return; }
      case 'more': s.lim += 15; this.obRenderLinesPanel(); return;
      case 'new': return this.newOutboundDoc();
      case 'edit': return this.editOutboundDoc(s.sel);
      case 'confirm': return this.confirmOutboundDoc();
      case 'correct': return this.startOutboundCorrection(s.sel);
      case 'del': return this.deleteOutboundDoc(s.sel);
      case 'to-return': return this.newOutboundDoc('领料退库', s.sel);
    }
  },

  // 状态徽标
  obdStatusBadge(status) {
    const label = { draft: 'obd_status_draft', posted: 'obd_status_posted', voided: 'ibd_status_voided' };
    const cls = this.docStatusMeta(status).cls;
    return `<span class="badge ${cls}">${label[status] ? this.t(label[status]) : status}</span>`;
  },

  // 出库编辑页统一壳：新建 / 编辑 / 更正三态共用（对齐入库、采购编辑页）
  // o: { icon, title, desc, backHtml, badge, formHtml, showLines, linesTitleKey, extraHtml, actions }
  obEditShell(o) {
    this.setMain(this.pageWrap(o.icon + ' ' + o.title, o.desc || '', '',
      `<div class="data-page" id="outbound-content">
        <div class="pu-edit-bar">
          ${o.backHtml || ''}
          ${o.badge || ''}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('pu_section_header')}</div></div>
          <div id="ob-edit-form">${o.formHtml || ''}</div>
        </div>
        ${o.showLines ? `<div class="pu-card">
          <div class="pu-card-title"><span>02</span><div>${this.t(o.linesTitleKey || 'obd_tab_lines')}<small id="ob-edit-line-count"></small></div></div>
          <div id="ob-edit-lines"></div>
        </div>` : ''}
        ${o.extraHtml || ''}
        <div class="pu-edit-actions" id="ob-edit-buttons">${o.actions || ''}</div>
      </div>`));
  },

  // 去向候选：destinations 词库 + 最近出库单实际值（去重）
  obDestCandidates(extra) {
    const set = new Set();
    (this.params?.destinations || []).forEach(d => {
      const v = String(d.name || '').trim();
      if (v) set.add(v);
    });
    (this._obList || []).forEach(d => {
      const v = String(d.destination || '').trim();
      if (v) set.add(v);
    });
    (extra || []).forEach(v => {
      const s = String(v || '').trim();
      if (s) set.add(s);
    });
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  },

  // 去向输入：可留空、可自由输入，历史文本原样回显
  obDestInputHtml(id, value) {
    const opts = this.obDestCandidates([value])
      .map(v => `<option value="${this.ibEsc(v)}"></option>`).join('');
    return `<input id="${id}" list="ob-dest-list" value="${this.ibEsc(value || '')}" autocomplete="off" oninput="this.dataset.auto='0'" placeholder="${this.t('obd_destination_ph')}"><datalist id="ob-dest-list">${opts}</datalist>`;
  },

  // 去向候选需要的最近出库单：列表未加载时补拉一次（失败不阻断）
  async obEnsureDestDocs() {
    if (this._obList && this._obList.length) return;
    try { this._obList = await this.api('/api/outbound-docs?includeHistory=1'); }
    catch (e) { /* 候选缺失不阻断 */ }
  },

  // ========== 新建出库单据：独立页面 ==========
  // presetType: 传入「领料退库」时由「退货与退库」模块复用本页创建领料退库单
  // originDocNo: 由原单选择器/出库详情带入的原出库单，进入页面即带出可退明细
  // noOrigin: 无原单退库（不选原出库单，手工添加物料明细；去向/领用人/退库原因必填）
  async newOutboundDoc(presetType, originDocNo, noOrigin) {
    // 新建页不是退库编辑态：显式重置，避免沿用上一张退库单编辑页的标记
    this._obIsReturn = false;
    this._obNoOrigin = false;
    const preset = presetType === '领料退库' ? '领料退库' : '';
    this._obNoOrigin = !!preset && !!noOrigin;
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    let docNo = '';
    try {
      const next = await this.api('/api/outbound-docs/next-no?date=' + date + '&txnType=' + encodeURIComponent(preset || '正常出库'));
      docNo = next.doc_no || '';
    } catch (e) { /* 单号预览失败不阻断创建 */ }
    await this.obEnsureDestDocs();

    // 领料退库已迁出到独立模块，出库页不再提供该类型；仅当外部显式预设时才出现
    const typeOptions = preset
      ? `<option value="领料退库">${this.t('out_return')}</option>`
      : `<option value="正常出库">${this.t('out_normal')}</option>`;
    const pageTitle = this._obNoOrigin ? this.t('ret_no_origin_new') : (preset ? this.t('ret_new_stock') : this.t('obd_add'));

    // 2C：领料退库可关联原出库单（只列已过账的正常出库单）；无原单退库不显示该字段
    let originOptions = '';
    this._obOriginCandidates = [];
    if (preset && !this._obNoOrigin) {
      try {
        const docs = await this.api('/api/outbound-docs?txnType=' + encodeURIComponent('正常出库'));
        this._obOriginCandidates = (docs || []).filter(d => d.status === 'posted');
        originOptions = this._obOriginCandidates
          .map(d => `<option value="${d.doc_no}"${d.doc_no === (originDocNo || '') ? ' selected' : ''}>${d.doc_no} · ${d.date} · ${d.destination || ''}</option>`).join('');
      } catch (e) { /* 原单列表拉取失败不阻断创建 */ }
    }
    const originField = (preset && !this._obNoOrigin) ? `
              <div class="form-group" style="grid-column:1/-1"><label>${this.t('ret_origin_doc')}</label>
                <select id="ob_f_origin_doc" onchange="App.obLoadOriginPreview()"><option value="">${this.t('ret_origin_none')}</option>${originOptions}</select>
                <small style="color:var(--text-muted);font-size:12px">${this.t('ret_origin_hint')}</small>
              </div>` : '';
    const reasonField = this._obNoOrigin ? `
              <div class="form-group" style="grid-column:1/-1"><label>${this.t('ret_return_reason')} *</label>
                <input id="ob_f_return_reason" value="" placeholder="${this.t('ret_return_reason_ph')}">
                <small style="color:var(--text-muted);font-size:12px">${this.t('ret_no_origin_hint')}</small>
              </div>` : '';
    const reqMark = this._obNoOrigin ? ' *' : '';

    this._obView = 'new';
    const formHtml = `<div class="form-grid" style="max-width:none">
            <div class="form-group"><label>${this.t('obd_no')}</label><input id="ob_f_no" value="${docNo}" readonly placeholder="${this.t('obd_no_after_save')}"></div>
            <div class="form-group"><label>${this.t('obd_date')} *</label><input id="ob_f_date" type="date" value="${date}"></div>
            <div class="form-group"><label>${this.t('obd_type')} *</label><select id="ob_f_txn_type">${typeOptions}</select></div>
            ${originField}
            <div class="form-group"><label>${this.t('obd_destination')}${reqMark}</label>${this.obDestInputHtml('ob_f_destination', '')}</div>
            <div class="form-group"><label>${this.t('obd_receiver')}${reqMark}</label><input id="ob_f_receiver" value="" oninput="this.dataset.auto='0'"></div>
            <div class="form-group"><label>${this.t('obd_handler')}</label><input id="ob_f_handler" value="${this.user?.name || this.user?.username || ''}"></div>
            ${reasonField}
            <div class="form-group" style="grid-column:1/-1"><label>${this.t('obd_remarks')}</label><textarea id="ob_f_remarks" rows="2"></textarea></div>
          </div>`;
    this.obEditShell({
      icon: '📤',
      title: pageTitle,
      desc: this._obNoOrigin ? this.t('ret_no_origin_hint') : this.t('obd_create_hint'),
      backHtml: `<span class="action-link" onclick="App.backToOutboundList()">← ${this.t('obd_back_list')}</span>`,
      badge: this.obdStatusBadge('draft'),
      formHtml,
      extraHtml: '<div id="ob-preload"></div>',
      actions: `<button class="btn btn-outline" onclick="App.backToOutboundList()">${this.t('cancel')}</button>
          <button class="btn btn-primary" onclick="App.createOutboundDoc()">${this.t('pu_create_and_add')}</button>`
    });
    if (preset && originDocNo && !this._obNoOrigin) this.obLoadOriginPreview();
  },

  // 退库建单/切原单：去向、领用人自动带出（不覆盖用户手改过的值）
  // dataset.auto='1' 自动带出值；'0' 用户手改过，任何情况下都不再覆盖
  obApplyOriginHeader(src) {
    if (!src) return;
    const isEdit = this._obView === 'edit';
    if (!document.getElementById(isEdit ? 'ob_e_origin_doc' : 'ob_f_origin_doc')) return;
    const fill = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      const auto = el.dataset.auto;
      if (auto === '0') return;
      if (auto !== '1' && String(el.value || '').trim() !== '') return;
      const v = String(val || '');
      el.value = v;
      if (v.trim()) el.dataset.auto = '1'; else delete el.dataset.auto;
    };
    fill(isEdit ? 'ob_e_destination' : 'ob_f_destination', src.destination);
    fill(isEdit ? 'ob_e_receiver' : 'ob_f_receiver', src.receiver);
  },

  // 原出库单可退明细预览（退库新建页，可填退库数量）
  async obLoadOriginPreview() {
    const box = document.getElementById('ob-preload');
    if (!box) return;
    this._obPreloadLines = null;
    const docNo = document.getElementById('ob_f_origin_doc')?.value || '';
    if (!docNo) { box.innerHTML = ''; return; }
    let res = {};
    try { res = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/returnable'); }
    catch (e) { box.innerHTML = `<div class="ib-empty-draft">${this.ibEsc(e.message)}</div>`; return; }
    this.obApplyOriginHeader(res);
    const usable = (res.lines || []).filter(r => Number(r.remaining) > 0);
    if (!usable.length) { box.innerHTML = `<div class="ib-empty-draft">${this.t('ret_no_returnable')}</div>`; return; }
    this._obPreloadLines = usable.map(r => ({
      code: r.code, qty: '', origin_line_id: r.id, max_qty: Number(r.remaining) || 0,
      cost_price: r.cost_price, material_name: r.material_name, material_spec: r.material_spec, material_brand: r.material_brand, remarks: ''
    }));
    const vp = usable.length > 0 && this.hasField(usable[0], 'cost_price');
    const trs = usable.map((r, i) => `<tr>
      <td>${this.ibLineLabel(r)}</td>
      <td class="text-right">${this.fmtQty(r.qty)}</td><td class="text-right">${this.fmtQty(r.returned_qty)}</td>
      <td class="text-right"><b>${this.fmtQty(r.remaining)}</b></td>
      <td style="min-width:110px"><input type="number" step="0.01" min="0.01" max="${r.remaining}" id="ob_pre_qty_${i}" oninput="App.obPreQtyInput(${i}, this)" onpaste="App.qtyPaste(event)"></td>
      ${vp ? `<td class="text-right">${this.fmtMoney(r.cost_price)}</td>` : ''}</tr>`).join('');
    box.innerHTML = `<div class="pu-card">
      <div class="pu-card-title"><span>02</span><div>${this.t('ret_lines_stock')}<small>${this.t('ret_source_preview_hint', { n: usable.length })}</small></div></div>
      <div class="table-wrap" style="max-height:280px;overflow:auto"><table><thead><tr>
        <th>${this.t('pu_material')}</th>
        <th class="text-right">${this.t('ret_source_orig_qty')}</th><th class="text-right">${this.t('ret_source_returned_qty')}</th>
        <th class="text-right">${this.t('ret_remaining_qty')}</th><th class="text-right">${this.t('ret_qty')}</th>
        ${vp ? `<th class="text-right">${this.t('out_cost_price')}</th>` : ''}
      </tr></thead><tbody>${trs}</tbody></table></div></div>`;
  },

  obPreQtyInput(idx, el) {
    const l = (this._obPreloadLines || [])[idx];
    if (l) l.qty = this.qtyInput(el);
  },

  // 新建页是否有实质内容：任一明细行，或单头关键字段（领用单位/领用人/来源/备注）任一非空
  obNewPageHasContent() {
    const rows = this._obPreloadLines || [];
    if (rows.some(l => String(l.code || '').trim())) return true;
    if (document.querySelectorAll('#ob-preload tbody tr').length > 0) return true;
    const dest = (document.getElementById('ob_f_destination')?.value || '').trim();
    const receiver = (document.getElementById('ob_f_receiver')?.value || '').trim();
    const remarks = (document.getElementById('ob_f_remarks')?.value || '').trim();
    const origin = (document.getElementById('ob_f_origin_doc')?.value || '').trim();
    const reason = (document.getElementById('ob_f_return_reason')?.value || '').trim();
    return !!(dest || receiver || remarks || origin || reason);
  },

  // 无原单退库单头必填校验：返回第一条缺失字段的提示 key；不适用时返回空串
  // isNew=true 读新建页 ob_f_*，否则读编辑页 ob_e_*
  obNoOriginHeaderMissing(isNew) {
    if (!this._obNoOrigin) return '';
    const p = isNew ? 'ob_f_' : 'ob_e_';
    const get = k => String(document.getElementById(p + k)?.value || '').trim();
    if (!get('destination')) return 'ret_no_origin_dest_required';
    if (!get('receiver')) return 'ret_no_origin_receiver_required';
    if (!get('return_reason')) return 'ret_no_origin_reason_required';
    return '';
  },

  // 离开编辑页前处理占位空草稿：零明细且单头无关键字段时自动删除
  async obDropEmptyDraftOnLeave() {
    const d = this._obDetail;
    const docNo = this._obDocNo;
    if (!d || !docNo || d.status !== 'draft') return false;
    if ((this._obEditLines || []).length > 0) return false;
    const dest = (document.getElementById('ob_e_destination')?.value || '').trim();
    const receiver = (document.getElementById('ob_e_receiver')?.value || '').trim();
    const remarks = (document.getElementById('ob_e_remarks')?.value || '').trim();
    const origin = (document.getElementById('ob_e_origin_doc')?.value || '').trim()
      || String(d.origin_doc_no || '').trim();
    const reason = (document.getElementById('ob_e_return_reason')?.value || '').trim()
      || String(d.return_reason || '').trim();
    if (dest || receiver || remarks || origin || reason) return false;
    try {
      await this.api('/api/outbound-docs/' + encodeURIComponent(docNo), 'DELETE');
      this.toast(this.t('empty_draft_not_saved'));
    } catch (e) {
      return false; // 删除失败不阻断返回
    }
    this._obDocNo = '';
    this._obDetail = null;
    this._obEditLines = [];
    return true;
  },

  async createOutboundDoc() {
    // 空草稿不落地：没有任何明细行，且单头关键字段全空时不建单
    if (!this.obNewPageHasContent()) {
      this.toast(this.t('empty_draft_not_saved'), 'error');
      return;
    }
    // 无原单退库：三项必填逐个拦（前端即时提示，后端另有硬校验）
    const missing = this.obNoOriginHeaderMissing(true);
    if (missing) {
      this.toast(this.t(missing), 'error');
      return;
    }
    if (!this.validateForm({ ob_f_date: [{ rule: 'required' }] })) return;
    const body = {
      doc_no: document.getElementById('ob_f_no')?.value || '',
      date: document.getElementById('ob_f_date')?.value,
      txn_type: document.getElementById('ob_f_txn_type')?.value,
      destination: document.getElementById('ob_f_destination')?.value,
      receiver: document.getElementById('ob_f_receiver')?.value.trim(),
      handler: document.getElementById('ob_f_handler')?.value.trim(),
      remarks: document.getElementById('ob_f_remarks')?.value.trim(),
      return_reason: document.getElementById('ob_f_return_reason')?.value.trim(),
      origin_doc_no: document.getElementById('ob_f_origin_doc')?.value || ''
    };
    const originSel = document.getElementById('ob_f_origin_doc');
    if (originSel) {
      body.origin_doc_no = originSel.value || '';
      if (!body.origin_doc_no) { this.toast(this.t('ret_origin_required'), 'error'); return; }
      const chosen = (this._obPreloadLines || []).filter(l => parseFloat(l.qty) > 0);
      if (!chosen.length) { this.toast(this.t('ret_qty_required'), 'error'); return; }
      for (const l of chosen) {
        if (parseFloat(l.qty) > Number(l.max_qty || 0) + 1e-9) {
          this.toast(this.t('ret_qty_over_available', { n: 1, max: this.fmtQty(l.max_qty) }), 'error');
          return;
        }
      }
      body.lines = chosen.map(l => ({ code: l.code, qty: parseFloat(l.qty), origin_line_id: l.origin_line_id, remarks: l.remarks || '' }));
    }
    try {
      const r = await this.api('/api/outbound-docs', 'POST', body);
      this.toast(this.t('obd_created'));
      await this.editOutboundDoc(r.doc_no);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // 出库/入库共用样式已收敛到 public/css/pages.css，不再运行时注入

  // ========== 出库单据详情（右侧栏，原地展开） ==========
  // 对外入口保持不变，入库/采购跨模块互链仍调用这个函数
  async openOutboundDoc(docNo) {
    if (!docNo) return;
    const s = this.obState();
    s.sel = docNo;
    if (this.currentPage !== 'outbound' || !document.getElementById('ob-root')) {
      // 由 renderOutbound 统一重取列表、定位并展开该单详情
      this._obRevealDoc = docNo;
      return this.gotoPage('outbound');
    }
    // 跨模块跳转/确认更正后，列表状态可能已变化，先刷新数据再展开详情栏
    await this.loadOutboundList();
    this.obRevealDoc(docNo);
    await this.obOpen(docNo);
    this.docRowFlash('ob-scroll', 'tr[data-ra="outbound"][data-id="' + CSS.escape(String(docNo)) + '"]');
  },

  // 按单据真实状态把行定位到列表：切对应页签 → 必要时清掉挡住该行的筛选 → 翻到该行所在页
  obRevealDoc(docNo) {
    const row = (this._obList || []).find(r => r.doc_no === docNo);
    if (!row) return false;
    const s = this.obState();
    const want = row.status === 'voided' ? 'voided' : (row.txn_type || '');
    s.tab = this.obTabDefs().some(d => d[0] === want) ? want : '';
    if (!this.obVisibleRows().some(r => r.doc_no === docNo)) {
      s.f = { kw: '', from: '', to: '' };
      s.kpi = '';
      this.obRenderFilters();
    }
    const st = this.getTableState('outbound');
    st.page = 1;
    const rows = this.sortData(this.obVisibleRows(), st.sortKey, st.sortDir);
    const idx = rows.findIndex(r => r.doc_no === docNo);
    if (idx >= 0) st.page = Math.floor(idx / st.pageSize) + 1;
    this.obRenderTabs();
    this.obRenderList();
    return true;
  },

  async obOpen(docNo) {
    const s = this.obState();
    if (s.sel !== docNo) {
      s.dt = 'lines'; s.lq = ''; s.lim = 15; s.ex = new Set();
    }
    s.sel = docNo;
    this._obDocNo = docNo;
    this._obDetail = null;
    this._obDetailCache[docNo] = { loading: true };
    this.obRenderList();
    this.obRenderInspector();
    try {
      const d = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo));
      this._obDetailCache[docNo] = { d };
      this._obDetail = d;
    } catch (e) {
      this._obDetailCache[docNo] = { error: e.message };
    }
    if (this.obState().sel !== docNo) return;
    this.obRenderInspector();
  },

  obRenderInspector() {
    const s = this.obState();
    const box = document.getElementById('ob-insp');
    const split = document.getElementById('ob-split');
    if (!box || !split) return;
    if (!s.sel) {
      box.hidden = true; box.innerHTML = '';
      split.classList.remove('open', 'wide');
      return;
    }
    box.hidden = false;
    split.classList.add('open');
    split.classList.toggle('wide', s.wide);
    const rec = this._obDetailCache[s.sel];
    if (!rec || rec.loading) { box.innerHTML = `<div class="pu-empty">${this.t('loading')}</div>`; return; }
    if (rec.error) { box.innerHTML = `<div class="pu-empty">${this.ibEsc(rec.error)}</div>`; return; }
    const d = rec.d;
    this._obDetail = d;
    const lines = d.lines || [];
    const related = Array.isArray(d.related_returns) ? d.related_returns : [];
    const logs = Array.isArray(d.logs) ? d.logs : [];
    if (!['lines', 'related', 'logs'].includes(s.dt)) s.dt = 'lines';

    const meta = [
      [this.t('obd_type'), this.obTypeLabel(d.txn_type)],
      [this.t('obd_date'), this.fmtDocDate(d.date, d.created_at, d.confirmed_at) || '–'],
      [this.t('obd_destination'), d.destination || '–'],
      [this.t('obd_receiver'), d.receiver || '–'],
      [this.t('obd_handler'), d.handler || '–'],
      [this.t('obd_created_by'), d.created_by || '–'],
      [this.t('obd_created_at'), this.fmtDateTime(d.created_at) || '–'],
    ];
    if (d.confirmed_by) meta.push([this.t('obd_confirmed_by'), d.confirmed_by]);
    if (d.confirmed_at) meta.push([this.t('obd_confirmed_at'), this.fmtDateTime(d.confirmed_at)]);
    // 无原单退库：退库原因随单头展示，便于追溯
    if (d.txn_type === '领料退库' && String(d.return_reason || '').trim()) {
      meta.push([this.t('ret_return_reason'), d.return_reason]);
    }
    if (d.status === 'voided') {
      meta.push([this.t('ibd_voided_at'), this.fmtDateTime(d.voided_at) || '–']);
      meta.push([this.t('ibd_voided_by'), d.voided_by || '–']);
    }
    meta.push([this.t('obd_remarks'), d.remarks || '–']);

    const tabs = [
      ['lines', this.t('obd_tab_lines'), lines.length],
      ['related', this.t('obd_tab_related_returns'), related.length],
      ['logs', this.t('pu_tab_logs'), logs.length],
    ];

    const originBar = (d.txn_type === '领料退库')
      ? (String(d.origin_doc_no || '').trim()
        ? `<div class="ob-link-bar">${this.t('ret_origin_doc')}${this.t('colon')}<button type="button" class="pu-lk" data-ob="open" data-id="${this.ibEsc(d.origin_doc_no)}">${this.ibEsc(d.origin_doc_no)}</button></div>`
        : `<div class="ob-link-bar"><span class="badge badge-muted">${this.t('ret_no_origin_badge')}</span> ${this.t('ret_no_origin_tab_empty')}</div>`)
      : '';

    box.classList.toggle('ob-voided-panel', d.status === 'voided');
    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" data-ob="icl">← ${this.t('pu_back_list')}</button>
      ${this.crossLinkBackBtn('outbound', d.doc_no)}
      <div class="pu-insp-head">
        <div>
          <small>${this.obTypeLabel(d.txn_type)}</small>
          <h2>${this.ibEsc(d.doc_no)} ${this.docRevisionBadge(d.doc_no)}</h2>
          <span class="pu-badge">${this.obdStatusBadge(d.status)}</span>
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" data-ob="wide" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}">${s.wide ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" data-ob="icl" title="${this.t('pu_close_detail')}">✕</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${this.ibEsc(m[0])}</dt><dd>${this.ibEsc(m[1])}</dd></div>`).join('')}</dl>
      ${originBar}
      ${this.obCorrectionBarHtml(d)}
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" data-ob="dt" data-id="${k}">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="ob-dpanel"></div>
      <div class="pu-insp-foot">${this.obRenderFoot(d, lines)}</div>`;
    this.obRenderDetailPanel();
    this.obUpdatePagerSticky();
  },

  obCorrectionBarHtml(d) {
    const c = d.correction;
    const parts = [];
    if (d.status === 'voided') {
      parts.push(`<span class="ib-corr-void">${this.t('ibd_voided_banner', {
        time: this.fmtDateTime(d.voided_at) || '–',
        by: d.voided_by || '–',
      })}${String(d.corrected_by_doc_no || '') ? ` <button type="button" class="pu-lk" data-ob="open" data-id="${this.ibEsc(d.corrected_by_doc_no)}">${this.ibEsc(d.corrected_by_doc_no)}</button>` : ''}</span>`);
    } else if (String(d.corrected_by_doc_no || '')) {
      parts.push(`<span>${this.t('ibd_corr_to')} <button type="button" class="pu-lk" data-ob="open" data-id="${this.ibEsc(d.corrected_by_doc_no)}">${this.ibEsc(d.corrected_by_doc_no)}</button></span>`);
    }
    if (String(d.corrects_doc_no || '')) {
      parts.push(`<span>✎ ${this.t('ibd_corr_from')} <button type="button" class="pu-lk" data-ob="open" data-id="${this.ibEsc(d.corrects_doc_no)}">${this.ibEsc(d.corrects_doc_no)}</button></span>`);
    }
    if (c && c.has_draft && String(c.draft_doc_no || '') && this.can('outbound', 'correct')) {
      parts.push(`<span>${this.t('ibd_corr_draft_link')} <button type="button" class="pu-lk" data-ob="open" data-id="${this.ibEsc(c.draft_doc_no)}">${this.ibEsc(c.draft_doc_no)}</button></span>`);
    }
    return parts.length ? `<div class="ib-corr-bar">${parts.join('<i>·</i>')}</div>` : '';
  },

  // 详情栏底部按钮组（原工具栏按钮，逻辑不变，只换容器）
  obRenderFoot(d, lines) {
    const isDraft = d.status === 'draft';
    const isCorrDraft = isDraft && !!String(d.corrects_doc_no || '');
    const hasLines = lines.length > 0;
    let foot = '';
    if (isDraft && this.can('outbound', isCorrDraft ? 'correct' : 'edit')) {
      foot += `<button type="button" class="btn btn-outline" data-ob="edit">${hasLines ? this.t('obd_edit') : this.t('obd_add_line')}</button>`;
      if (hasLines) foot += `<button type="button" class="btn btn-primary" data-ob="confirm">${this.t(d.txn_type === '领料退库' ? 'obd_confirm_return' : 'obd_confirm')}</button>`;
    }
    // 退库按钮（仅原单已过账时显示；退库单自身不重复出现）
    if (d.txn_type !== '领料退库' && d.status === 'posted' && this.can('returns', 'create')) {
      foot += `<button type="button" class="btn btn-outline" data-ob="to-return">${this.t('ret_from_outbound')}</button>`;
    }
    // 更正入口：已过账、未被更正过（作废单不可再更正）
    if (d.correction && d.correction.eligible && this.can('outbound', 'correct')) {
      foot += `<button type="button" class="btn btn-outline" data-ob="correct">${this.t('ibd_corr')}</button>`;
    }
    if (isDraft && this.can('outbound', 'delete')) {
      foot += `<button type="button" class="btn btn-danger" data-ob="del">${hasLines ? this.t('obd_delete_draft') : this.t('obd_delete_empty')}</button>`;
    }
    return foot;
  },

  // 详情子页签内容：明细 / 关联退库单 / 操作日志（日志永远最后）
  obRenderDetailPanel() {
    const s = this.obState();
    const box = document.getElementById('ob-dpanel');
    if (!box) return;
    const rec = this._obDetailCache[s.sel];
    if (!rec || !rec.d) { box.innerHTML = ''; return; }
    const d = rec.d;
    if (s.dt === 'related') return this.obRenderRelatedReturns(d);
    if (s.dt === 'logs') { box.innerHTML = this.obLogsPanel(d.logs || []); return; }
    return this.obRenderLinesPanel();
  },

  // 明细：窄栏用手风琴，宽屏用可排序表格
  obRenderLinesPanel() {
    const s = this.obState();
    const box = document.getElementById('ob-dpanel');
    if (!box) return;
    const rec = this._obDetailCache[s.sel];
    if (!rec || !rec.d) return;
    const d = rec.d;
    const lines = d.lines || [];

    if (s.wide) {
      this._tableRenderers['outbound_detail_lines'] = () => this.obRenderLinesPanel();
      box.innerHTML = `<div id="ob-lines-body">${this.obDetailLinesTable(lines)}</div>`;
      return;
    }

    if (!lines.length) {
      box.innerHTML = d.status === 'draft'
        ? `<div class="ib-empty-draft"><b>${this.t('obd_empty_draft_title')}</b><div style="font-size:12px;color:var(--text-muted);margin:6px 0 12px">${this.t('obd_empty_draft_desc')}</div>${this.can('outbound', 'edit') ? `<button class="btn btn-primary btn-sm" data-ob="edit">${this.t('obd_empty_draft_add')}</button>` : ''}</div>`
        : `<div class="pu-empty">${this.t('obd_no_lines')}</div>`;
      return;
    }

    const f = s.lq
      ? lines.filter(l => this.puKwMatch([l.code, l.material_name, l.material_spec, l.material_brand, l.receiver, l.remarks].join(' '), s.lq))
      : lines;
    const shown = Math.min(s.lim, f.length);
    let html = `<div class="pu-lqtoolbar">
      <input id="ob_lqi" type="search" value="${this.ibEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}">
    </div>
    <p class="pu-cnt">${this.t('pu_shown_count', { shown, total: f.length })}</p>`;
    if (!f.length) { box.innerHTML = html + `<div class="pu-empty">${this.t('pu_no_lines')}</div>`; return; }
    html += `<ul class="pu-lines">` + f.slice(0, shown).map(l => {
      const ex = s.ex.has(String(l.id));
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" data-ob="ex" data-id="${l.id}" aria-expanded="${ex}">
          <span class="pu-line-n"><strong>${this.ibEsc(l.code)}</strong> ${this.ibEsc(l.material_name || '')} <span class="pu-mu">${this.ibEsc(l.material_spec || '')}${l.material_brand ? ` · ${this.ibEsc(l.material_brand)}` : ''}</span></span>
          <span class="pu-line-q">${this.fmtQty(this.qtyAbs(l.qty))}${this.ibEsc(l.material_unit || '')}</span>
        </button>
        ${ex ? `<div class="pu-line-d">
          <div class="pu-mu">${this.hasField(l, 'cost_price') ? `${this.t('out_cost_price')} ${this.fmtMoney(l.cost_price)} · ${this.t('out_cost_amount')} ${this.fmtMoney(l.cost_amount)}` : ''}${l.cost_basis ? `${this.hasField(l, 'cost_price') ? ' · ' : ''}${this.t('cost_basis_label')} ${this.costBasisBadge(l.cost_basis)}` : ''}${l.receiver ? `${(this.hasField(l, 'cost_price') || l.cost_basis) ? ' · ' : ''}${this.t('out_receiver')} ${this.ibEsc(l.receiver)}` : ''}</div>
          ${l.remarks ? `<div>${this.t('out_remarks')}${this.t('colon')}${this.ibEsc(l.remarks)}</div>` : ''}
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    if (f.length > s.lim) html += `<button type="button" class="btn btn-outline btn-sm pu-more" data-ob="more">${this.t('pu_more', { n: f.length - s.lim })}</button>`;
    box.innerHTML = html;
  },

  obDetailLinesTable(lines) {
    const vp = lines.length > 0 && this.hasField(lines[0], 'cost_price');
    const tid = 'outbound_detail_lines';
    const cols = [
      ['code', this.t('pu_material'), r => this.ibLineLabel(r)],
      ['qty', this.t('out_qty'), r => this.fmtQty(this.qtyAbs(r.qty)), true],
      ['cost_basis', this.t('cost_basis_label'), r => this.costBasisBadge(r.cost_basis)],
      ['cost_price', this.t('out_cost_price'), r => this.fmtMoney(r.cost_price), true, vp],
      ['cost_amount', this.t('out_cost_amount'), r => this.fmtMoney(r.cost_amount), true, vp],
      ['receiver', this.t('out_receiver'), r => this.ibEsc(r.receiver || '')],
      ['remarks', this.t('out_remarks'), r => this.ibEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const st = this.getTableState(tid);
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = sorted.map(r => '<tr>' + shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>').join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${shown.length}" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('pu_no_lines')}</td></tr>`}</tbody></table></div>`;
  },

  obRenderRelatedReturns(d) {
    const box = document.getElementById('ob-dpanel');
    if (!box) return;
    const rows = Array.isArray(d.related_returns) ? d.related_returns : [];
    if (!rows.length) {
      const key = d.txn_type === '领料退库' ? 'obd_no_related_returns_self' : 'obd_no_related_returns';
      box.innerHTML = `<div class="pu-empty">${this.t(key)}</div>`;
      return;
    }
    box.innerHTML = `<div class="rel-list">${rows.map(r => this.relatedDocItemHtml({
      target: 'returns',
      doc: r,
      fromKind: 'outbound',
      fromDoc: d.doc_no,
      typeLabel: r.txn_type === '领料退库' ? this.t('out_return') : this.t('out_normal'),
      statusBadge: this.obdStatusBadge(r.status),
      qty: r.total_qty,
      amount: r.total_amount,
    })).join('')}</div>`;
  },

  // 日志动作标签：与入库/采购同一套 i18n 口径（不再硬编码中文）
  obLogLabel(a) {
    const m = {
      create: this.t('audit_act_create'),
      edit: this.t('audit_act_update'), update: this.t('audit_act_update'), save: this.t('audit_act_update'),
      add_line: this.t('audit_act_update'), update_line: this.t('audit_act_update'), delete_line: this.t('audit_act_update'),
      confirm: this.t('audit_act_confirm'), post: this.t('audit_act_confirm'),
      void: this.t('audit_act_cancel'), cancel: this.t('audit_act_cancel'),
      'correction-draft': this.t('ibd_log_corr_draft'), 'confirm-correction': this.t('ibd_log_corr_confirm'),
      'over-receipt': this.t('ibd_log_over'),
      delete: this.t('audit_act_delete')
    };
    return m[a] || a;
  },

  // 操作日志：与入库/采购统一渲染（ol.pu-log；动作 · 操作人 · 时间 + 详情 + 空态）
  obLogsPanel(logs) {
    const list = Array.isArray(logs) ? logs : [];
    if (!list.length) return `<div class="pu-empty">${this.t('st_log_empty')}</div>`;
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    return `<ol class="pu-log">` + list.map(l => {
      const detail = this.logDetailText(l);
      return `<li>
      <div>
        <strong>${esc(this.obLogLabel(l.action))}</strong>
        <span class="pu-log-meta">· ${esc(l.name || l.username || l.operator || l.created_by || '')} · ${esc(this.fmtDateTime(l.created_at))}</span>
        ${detail ? `<div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere">${esc(detail)}</div>` : ''}
      </div>
    </li>`;
    }).join('') + '</ol>';
  },

  // ========== 出库单据编辑页面（独立页面，非模态窗口） ==========

  async editOutboundDoc(docNo) {
    this._obView = 'edit';
    this._obDocNo = docNo;
    // 物料筛选条按单据重置（与入库一致），避免跨单残留筛选条件
    if (this._obEditFilterDoc !== docNo) { this._obMatCat = ''; this._obMatKw = ''; this._obEditFilterDoc = docNo; }

    const detail = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo));
    this._obDetail = detail;
    // 2C：领料退库需要维护原出库单与可退行
    this._obIsReturn = detail.txn_type === '领料退库';
    this._obOriginDocNo = this._obIsReturn ? (detail.origin_doc_no || '') : '';
    // 无原单退库：退库单未关联原出库单（单头三项必填，物料全仓自由选择）
    this._obNoOrigin = this._obIsReturn && !String(detail.origin_doc_no || '').trim();
    this._obReturnableMap = {};
    // 更正草稿：载入原单数量，用于逐行对比与锁定
    this._obCorrection = null;
    if (detail.status === 'draft' && String(detail.corrects_doc_no || '').trim()) {
      try {
        const info = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/correction-info');
        const origLines = info.lines || [];
        // 额外取原单表头与原单数量，用于「无改动」判断（草稿可能已保存过若干次）
        let origDoc = null;
        try { origDoc = await this.api('/api/outbound-docs/' + encodeURIComponent(detail.corrects_doc_no)); } catch (e) { origDoc = null; }
        const trueOrigLines = ((origDoc && origDoc.lines) || []).map(l => Object.assign({}, l, { qty: Math.abs(Number(l.qty)) }));
        this._obCorrection = {
          original_doc_no: detail.corrects_doc_no,
          lines: origLines,
          originByKey: new Map(origLines.map((l, i) => [this.obOutboundLineKeys(origLines)[i], l])),
          originalHeader: origDoc,
          origQtyByKey: new Map(this.obOutboundLineKeys(trueOrigLines).map((k, i) => [k, Number(trueOrigLines[i].qty) || 0]))
        };
      } catch (e) {
        this._obCorrection = { original_doc_no: detail.corrects_doc_no, lines: [], originByKey: new Map() };
      }
    }
    this._obEditLines = (detail.lines || []).map(l => ({
      id: l.id,
      code: l.code,
      material_name: l.material_name,
      material_spec: l.material_spec,
      material_brand: l.material_brand,
      material_unit: l.material_unit,
      qty: Math.abs(Number(l.qty)),
      cost_price: Number(l.cost_price) || 0,
      remarks: l.remarks || '',
      origin_line_id: Number(l.origin_line_id) || 0,
      max_qty: null,
      _locked: false
    }));
    if (this._obCorrection) {
      const keys = this.obOutboundLineKeys(this._obEditLines);
      this._obEditLines.forEach((l, i) => { l._locked = this._obCorrection.originByKey.has(keys[i]); });
    }

    // 加载物料和库存数据（on_hand 用于可用库存列，avg_price 仅作参考单价，不写回成本）
    const materials = await this.api('/api/materials');
    this._materialsCache = materials;
    let stockMap = {};
    let avgMap = {};
    let stockRows = [];
    try {
      stockRows = await this.api('/api/stock-summary');
      stockMap = Object.fromEntries(stockRows.map(s => [s.code, s.on_hand]));
      avgMap = Object.fromEntries(stockRows.map(s => [s.code, Number(s.avg_price) || 0]));
    } catch (e) {}
    this._outboundStockMap = stockMap;
    this._outboundAvgMap = avgMap;
    // 参考单价的可见性以 stock-summary 是否下发 avg_price 为准（新页面没有单据明细可判断）
    this._obPriceVisibleByStock = stockRows.length > 0 ? this.hasField(stockRows[0], 'avg_price') : null;
    await this.obEnsureDestDocs();

    // 2C：退库单加载原出库单候选与可退量上限
    if (this._obIsReturn) {
      await this.loadOutboundOriginCandidates();
      await this.loadReturnableMap();
      this.applyReturnableMax();
    }

    const isCorr = !!this._obCorrection;
    const backNo = isCorr ? this._obCorrection.original_doc_no : docNo;
    this.obEditShell({
      icon: isCorr ? '✎' : '✏️',
      title: isCorr ? this._obCorrection.original_doc_no : detail.doc_no,
      desc: `${this.t(isCorr ? 'ibd_corr_title' : (this._obIsReturn ? 'obd_edit_title_return' : 'obd_edit_title'))} · ${this.obTypeLabel(detail.txn_type)}`,
      backHtml: `<span class="action-link" onclick="App.backToOutboundDetail('${backNo}')">← ${this.t('obd_back_detail')}</span>`,
      badge: this.obdStatusBadge(detail.status),
      showLines: true,
      linesTitleKey: isCorr ? 'ibd_corr_section_lines' : (this._obIsReturn ? 'obd_section_lines_return' : 'obd_tab_lines')
    });
    this.renderOutboundEdit();
  },

  // ========== 2C：领料退库的原出库单关联 ==========
  async loadOutboundOriginCandidates() {
    if (this._obOriginCandidates && this._obOriginCandidates.length) return;
    try {
      const docs = await this.api('/api/outbound-docs?txnType=' + encodeURIComponent('正常出库'));
      this._obOriginCandidates = (docs || []).filter(d => d.status === 'posted');
    } catch (e) { this._obOriginCandidates = []; }
  },

  // 可退明细：以“排除本单”的口径计算剩余可退量
  async loadReturnableMap() {
    this._obReturnableMap = {};
    this._obReturnableHeader = null;
    if (!this._obOriginDocNo) return;
    try {
      const r = await this.api('/api/outbound-docs/' + encodeURIComponent(this._obOriginDocNo)
        + '/returnable?excludeDocNo=' + encodeURIComponent(this._obDocNo || ''));
      (r.lines || []).forEach(l => { this._obReturnableMap[String(l.id)] = l; });
      this._obReturnableHeader = r;
    } catch (e) { this._obReturnableMap = {}; }
  },

  applyReturnableMax() {
    (this._obEditLines || []).forEach(l => {
      const r = this._obReturnableMap[String(l.origin_line_id)];
      if (r) l.max_qty = r.remaining;
    });
  },

  // 一键带出原单剩余可退明细（覆盖当前明细行）
  async fillOutboundOriginLines() {
    if (!this._obOriginDocNo) { this.toast(this.t('ret_origin_required'), 'error'); return; }
    await this.loadReturnableMap();
    const rows = Object.values(this._obReturnableMap).filter(r => r.remaining > 0);
    if (rows.length === 0) { this.toast(this.t('ret_origin_no_remaining'), 'error'); return; }
    this._obEditLines = rows.map(r => ({
      code: r.code,
      material_name: r.material_name,
      material_spec: r.material_spec,
      material_brand: r.material_brand,
      material_unit: r.material_unit,
      qty: r.remaining,
      cost_price: r.cost_price,
      remarks: '',
      origin_line_id: r.id,
      max_qty: r.remaining
    }));
    this.renderOutboundEditTable();
  },

  async onOutboundOriginChange() {
    this._obOriginDocNo = document.getElementById('ob_e_origin_doc')?.value || '';
    this._obEditLines = [];
    this._obReturnableHeader = null;
    await this.fillOutboundOriginLines();
    this.obApplyOriginHeader(this._obReturnableHeader);
  },

  renderOutboundEdit() {
    const d = this._obDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';

    // 表单字段（草稿态可编辑）
    const formEl = document.getElementById('ob-edit-form');
    if (formEl) {
      if (isDraft) {
        const originSelect = (this._obIsReturn && !this._obCorrection && !this._obNoOrigin) ? `<div class="form-group" style="grid-column:1/-1">
            <label>${this.t('ret_origin_doc')}</label>
            <select id="ob_e_origin_doc" onchange="App.onOutboundOriginChange()">
              <option value="">${this.t('ret_origin_none')}</option>
              ${(this._obOriginCandidates || []).map(o => `<option value="${o.doc_no}" ${o.doc_no === this._obOriginDocNo ? 'selected' : ''}>${o.doc_no} · ${o.date} · ${o.destination || ''}</option>`).join('')}
            </select>
            <small style="color:var(--text-muted);font-size:12px">${this.t('ret_origin_hint')}</small>
          </div>` : '';
        const reasonField = (this._obIsReturn && this._obNoOrigin) ? `<div class="form-group" style="grid-column:1/-1">
            <label>${this.t('ret_return_reason')} *</label>
            <input id="ob_e_return_reason" value="${this.ibEsc(d.return_reason || '')}" placeholder="${this.t('ret_return_reason_ph')}">
          </div>` : '';
        const reqMark = this._obNoOrigin ? ' *' : '';
        const corrField = this._obCorrection ? `<div class="form-group"><label>${this.t('ibd_corr_from')}</label><input value="${this._obCorrection.original_doc_no}" readonly></div>` : '';
        const corrHint = this._obCorrection ? `<div class="form-group" style="grid-column:1/-1"><div class="ib-posted-hint" style="margin:0">${this.t('ibd_corr_confirm_hint')}</div></div>` : '';
        formEl.innerHTML = `<div class="form-grid" style="max-width:none">
          <div class="form-group"><label>${this.t('obd_no')}</label><input value="${d.doc_no}" readonly></div>
          <div class="form-group"><label>${this.t('obd_date')} *</label><input id="ob_e_date" type="date" value="${this.fmtDate(d.date)}"></div>
          <div class="form-group"><label>${this.t('obd_type')}</label><input value="${this.obTypeLabel(d.txn_type)}" readonly></div>
          ${corrField}
          <div class="form-group"><label>${this.t('obd_destination')}${reqMark}</label>${this.obDestInputHtml('ob_e_destination', d.destination || '')}</div>
          <div class="form-group"><label>${this.t('obd_receiver')}${reqMark}</label><input id="ob_e_receiver" value="${d.receiver || ''}" oninput="this.dataset.auto='0'"></div>
          <div class="form-group"><label>${this.t('obd_handler')}</label><input id="ob_e_handler" value="${d.handler || ''}"></div>
          ${originSelect}
          ${reasonField}
          <div class="form-group" style="grid-column:1/-1"><label>${this.t('obd_remarks')}</label><textarea id="ob_e_remarks" rows="2">${d.remarks || ''}</textarea></div>
          ${corrHint}
        </div>`;
      } else {
        formEl.innerHTML = `<div class="ib-posted-hint" style="margin:0">${this.t('obd_posted_hint')}</div>`;
      }
    }

    // 按钮组
    const btnBox = document.getElementById('ob-edit-buttons');
    if (btnBox) {
      let btns = '';
      if (isDraft) {
        if (this._obCorrection) {
          btns += `<button class="btn btn-outline" onclick="App.addOutboundEditRow()">+ ${this.t('obd_add_line')}</button>`;
          btns += `<button class="btn btn-outline" onclick="App.showOutboundBatchPicker()">${this.t('obd_batch_add')}</button>`;
          btns += `<button class="btn btn-outline" onclick="App.saveOutboundDraft()">${this.t('ibd_corr_save')}</button>`;
          btns += `<button class="btn btn-primary" onclick="App.confirmOutboundCorrection()">${this.t('ibd_corr_confirm')}</button>`;
        } else {
          if (this._obIsReturn && !this._obNoOrigin) {
            btns += `<button class="btn btn-outline" onclick="App.fillOutboundOriginLines()">${this.t('ret_fill_origin')}</button>`;
          } else {
            btns += `<button class="btn btn-outline" onclick="App.addOutboundEditRow()">+ ${this.t('obd_add_line')}</button>`;
            btns += `<button class="btn btn-outline" onclick="App.showOutboundBatchPicker()">${this.t('obd_batch_add')}</button>`;
          }
          btns += `<button class="btn btn-outline" onclick="App.saveOutboundDraft()">${this.t('obd_save_draft')}</button>`;
          btns += `<button class="btn btn-primary" onclick="App.confirmOutboundDocFromEdit()">${this.t(this._obIsReturn ? 'obd_confirm_return' : 'obd_confirm')}</button>`;
        }
      }
      btnBox.innerHTML = btns;
    }

    this.renderOutboundEditTable();
  },

  // 只重渲染表格部分（避免重建工具栏打断 IME）
  renderOutboundEditTable() {
    this.msClose();
    const d = this._obDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const lines = this._obEditLines || [];
    // 参考单价列：_obPriceVisibleByStock 在 loadOutboundEdit 里由 stock-summary 的 avg_price 字段赋值；
    // 无库存数据时为 null，退回角色判断
    const vp = (this._obPriceVisibleByStock === null || this._obPriceVisibleByStock === undefined)
      ? this.canViewPrice() : this._obPriceVisibleByStock;
    const corrKeys = this._obCorrection ? this.obOutboundLineKeys(lines) : [];
    const availLabel = this._obCorrection ? this.t('ibd_corr_orig_qty')
      : (this._obIsReturn && !this._obNoOrigin ? this.t('ret_origin_remaining') : this.t('out_available'));
    const refLabel = isDraft ? this.t('obd_ref_price') : this.t('out_cost_price');
    const refAmtLabel = isDraft ? this.t('obd_ref_amount') : this.t('pu_line_amount');

    const headers = [
      this.t('pu_material'),
      this.t('out_qty'), availLabel,
      ...(vp ? [refLabel, refAmtLabel] : []),
      this.t('out_remarks'), ''
    ];
    const numCols = 2 + (vp ? 2 : 0);
    let thHtml = headers.map((h, i) => `<th${i >= 1 && i < 1 + numCols ? ' class="text-right"' : ''}>${h}</th>`).join('');

    let tbody = '';
    if (lines.length === 0) {
      tbody = `<tr><td colspan="${headers.length}" style="text-align:center;padding:26px;color:var(--text-muted)">
        ${this.t('obd_no_lines')}
        ${this._obCorrection ? `<div style="margin-top:8px;color:var(--warning)">${this.t('ibd_corr_void_only_hint')}</div>` : ''}
        <div style="margin-top:10px">${isDraft ? `<button class="btn btn-primary btn-sm" onclick="App.addOutboundEditRow()">+ ${this.t('obd_add_line')}</button>` : ''}</div>
      </td></tr>`;
    } else {
      tbody = lines.map((l, i) => {
        const isLinked = !!(this._obIsReturn && l.origin_line_id);
        const locked = !!(this._obCorrection && this._obCorrection.originByKey.has(corrKeys[i]));
        const origLine = locked ? this._obCorrection.originByKey.get(corrKeys[i]) : null;
        // 退库行显示的原单剩余可退量；普通出库显示当前库存
        const remain = l.max_qty === null || l.max_qty === undefined ? undefined : l.max_qty;
        const available = this._outboundStockMap ? this._outboundStockMap[l.code] : undefined;
        const availText = locked ? (origLine ? origLine.qty : '-')
          : isLinked ? (remain === undefined ? '-' : remain)
          : (available === undefined || available === null ? '-' : available);
        const availCls = isLinked
          ? (remain === 0 ? 'num-warn' : '')
          : (available === undefined || available === null ? 'num-zero'
            : (available < 0 ? 'num-neg' : (available === 0 ? 'num-warn' : '')));
        // 参考单价：过账单取实际成本；草稿按来源（原出库行 / 原单行 / 当前加权平均）估算，不参与保存
        const refPrice = this.obRefPrice(l, locked, origLine);
        const refText = l.code ? this.fmtMoney(refPrice) : '-';
        const refAmountText = l.code ? this.fmtMoney((Number(l.qty) || 0) * refPrice) : '-';

        if (isDraft) {
          // 已关联原出库行的退库明细不允许换料，避免绕过可退量校验；更正草稿的预填行同样锁定物料
          const codeCell = (isLinked || locked)
            ? `<span class="ib-doc-no">${this.ibLineLabel(l)}</span>`
            : `<select class="ob-line-mat" data-idx="${i}" onchange="App.obPickMaterial(${i}, this.value)">${this.obMatOpts(l.code)}</select>`;
          const maxAttr = isLinked && remain !== undefined ? ` max="${remain}"` : '';
          const qtyInput = `<input type="number" step="0.01" min="0.01"${maxAttr} class="ob-edit-qty" data-idx="${i}" value="${l.qty || ''}" oninput="App.onOutEditQtyInput(${i}, this)" onpaste="App.qtyPaste(event)">`;
          const remarksInput = `<input class="ob-edit-remarks" data-idx="${i}" value="${l.remarks || ''}" oninput="App._obEditLines[${i}].remarks=this.value">`;
          const delBtn = `<button type="button" class="pu-edit-del" onclick="App.removeOutboundEditRow(${i})">${this.t('in_remove_row')}</button>`;
          return `<tr>
            <td style="min-width:220px">${codeCell}</td>
            <td style="min-width:100px">${qtyInput}</td>
            <td class="pu-edit-amt${availCls ? ' ' + availCls : ''}" style="font-size:12px">${availText}</td>
            ${vp ? `<td class="pu-edit-amt" style="color:var(--text-muted)" title="${this.t('obd_ref_hint')}">${refText}</td><td class="pu-edit-amt" style="color:var(--text-muted)" data-line-amount="${i}">${refAmountText}</td>` : ''}
            <td style="min-width:140px">${remarksInput}</td>
            <td class="text-center">${delBtn}</td>
          </tr>`;
        } else {
          const qty = l.qty || 0;
          const qtyCls = qty < 0 ? 'num-neg' : '';
          return `<tr>
            <td>${this.ibLineLabel(l)}</td>
            <td class="text-right${qtyCls ? ' ' + qtyCls : ''}">${qty}</td>
            <td class="pu-edit-amt${availCls ? ' ' + availCls : ''}" style="font-size:12px">${availText}</td>
            ${vp ? `<td class="pu-edit-amt">${refText}</td><td class="pu-edit-amt">${refAmountText}</td>` : ''}
            <td>${l.remarks || ''}</td>
            <td></td>
          </tr>`;
        }
      }).join('');
    }

    // 汇总（与入库/采购一致：pu-edit-sum 内按项展示）；参考金额按行参考单价估算
    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const totalAmount = lines.reduce((s, l, i) => s + (Number(l.qty) || 0) * this.obRefPriceAt(i), 0);
    const sumHtml = `<div class="pu-edit-sum">
      <span>${this.t('pu_line_count')}: <b id="ob_es_lines">${lines.length}</b></span>
      <span>${this.t('out_total_qty')}: <b id="ob_es_qty">${totalQty}</b></span>
      ${vp ? `<span>${this.t('out_total_amount')}: <b id="ob_es_amt">${this.fmtMoney(totalAmount)}</b></span>` : ''}
    </div>` + (isDraft && vp ? `<div class="ob-ref-hint">${this.t('obd_ref_hint')}</div>` : '');

    // 物料筛选条（普通出库 / 无原单退库 / 更正新增行）：约束行内物料下拉；关联原单的退库不启用
    let filterHtml = '';
    if (isDraft && (!this._obIsReturn || this._obNoOrigin)) {
      const mats = this._materialsCache || [];
      const cats = [...new Set(mats.map(m => m.category).filter(Boolean))].sort();
      const catOpts = `<option value="">${this.t('all')}</option>` + cats.map(c =>
        `<option value="${this.ibEsc(c)}"${this._obMatCat === c ? ' selected' : ''}>${this.ibEsc(c)}</option>`).join('');
      filterHtml = `<div class="pu-matfilter">
        <label>${this.t('mat_category')}<select id="ob_mat_cat" onchange="App.obSetMatCat(this.value)">${catOpts}</select></label>
        <span class="pu-msearch-host"><input id="ob_mat_kw" type="search" value="${this.ibEsc(this._obMatKw || '')}" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}" oninput="App.obMatKwInput(this)" onfocus="App.obMsOpen(this)" onblur="App.msBlur()" onkeydown="App.msKey(event)" oncompositionstart="App.msCompositionStart()" oncompositionend="App.msCompositionEnd(this)"></span>
        <span class="pu-mu" id="ob_mat_cnt">${this.obMatFiltered().length} / ${mats.length}</span>
      </div>`;
    }

    const box = document.getElementById('ob-edit-lines');
    if (box) box.innerHTML = filterHtml + `<div class="table-wrap"><table class="pu-edit-lines"><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>` + sumHtml;
    const cnt = document.getElementById('ob-edit-line-count');
    if (cnt) cnt.textContent = lines.length ? ' · ' + lines.length : '';
  },

  // 参考单价：草稿态按来源估算；已过账单据显示实际成本
  obRefPrice(l, locked, origLine) {
    if (this._obDetail?.status !== 'draft') return Number(l.cost_price) || 0;
    if (locked && origLine) return Number(origLine.cost_price) || 0;
    if (this._obIsReturn && l.origin_line_id) {
      const r = (this._obReturnableMap || {})[String(l.origin_line_id)];
      const p = r && r.cost_price !== undefined && r.cost_price !== null ? r.cost_price : l.cost_price;
      return Number(p) || 0;
    }
    const avg = (this._outboundAvgMap || {})[l.code];
    return avg === undefined || avg === null ? 0 : Number(avg) || 0;
  },

  obRefPriceAt(idx) {
    const l = (this._obEditLines || [])[idx];
    if (!l) return 0;
    let locked = false, origLine = null;
    if (this._obCorrection) {
      const key = this.obOutboundLineKeys(this._obEditLines)[idx];
      origLine = this._obCorrection.originByKey.get(key) || null;
      locked = !!origLine;
    }
    return this.obRefPrice(l, locked, origLine);
  },

  // 行内物料下拉候选（受顶部类别 + 关键字筛选约束，保留当前已选）
  obMatFiltered() {
    const mats = this._materialsCache || [];
    const cat = this._obMatCat || '';
    return mats.filter(m => {
      if (cat && m.category !== cat) return false;
      return this.puKwMatch([m.code, m.name, m.spec, m.brand].join(' '), this._obMatKw);
    });
  },

  obMatOpts(sel) {
    const mats = this._materialsCache || [];
    const list = this.obMatFiltered();
    if (sel && !list.some(m => m.code === sel)) {
      const cm = mats.find(m => m.code === sel);
      if (cm) list.unshift(cm);
    }
    return `<option value="">${this.t('please_select')}</option>` + list.map(m =>
      `<option value="${this.ibEsc(m.code)}"${m.code === sel ? ' selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
  },

  obSetMatCat(val) { this._obMatCat = val || ''; this.obRefreshMatOptions(); },

  // 输入：既刷新行内下拉候选（原有行为），又触发即时搜索面板
  obMatKwInput(el) {
    this._obMatKw = (el && el.value) || '';
    this.obRefreshMatOptions();
    if (!this._ms || this._ms.input !== el) this.obMsOpen(el);
    else this.msInput(el);
  },

  obMsOpen(el) {
    if (this._msSuppressFocus) return;
    this.msOpen(el, {
      mode: 'materials',
      category: () => this._obMatCat || '',
      stockOf: code => (this._outboundStockMap || {})[code],
      isAdded: m => (this._obEditLines || []).some(l => l.code === m.code),
      onPick: m => this.obAddFromSearch(m),
    });
  },

  // 点选候选项：直接加入一行明细（不做来源限制，与行内下拉同口径）
  obAddFromSearch(m) {
    if (!this._obEditLines) this._obEditLines = [];
    this._obMatKw = '';
    this._obEditLines.push({ code: m.code, qty: '', cost_price: 0, remarks: '' });
    this.renderOutboundEditTable();
  },

  // 筛选变化时就地刷新各行物料下拉（不重建整张表，避免输入焦点丢失）
  obRefreshMatOptions() {
    const mats = this._materialsCache || [];
    const list = this.obMatFiltered();
    const cnt = document.getElementById('ob_mat_cnt');
    if (cnt) cnt.textContent = `${list.length} / ${mats.length}`;
    document.querySelectorAll('#ob-edit-lines select.ob-line-mat').forEach(sel => {
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

  // 行内选择物料（全仓库范围，不做来源行限制；仅关联原单的退库行锁定）
  obPickMaterial(idx, code) {
    const l = (this._obEditLines || [])[idx];
    if (!l || (this._obIsReturn && !this._obNoOrigin) || l._locked) return;
    const m = (this._materialsCache || []).find(x => x.code === code);
    l.code = m ? m.code : '';
    l.material_name = m ? m.name : '';
    l.material_spec = m ? m.spec : '';
    l.material_brand = m ? m.brand : '';
    l.material_unit = m ? m.unit : '';
    l.cost_price = 0; // 参考单价动态展示，不写回成本
    this.renderOutboundEditTable();
  },

  // 添加空行
  addOutboundEditRow() {
    if (!this._obEditLines) this._obEditLines = [];
    this._obEditLines.push({ code: '', qty: '', cost_price: 0, remarks: '' });
    this.renderOutboundEditTable();
  },

  // 数量输入：去掉负号（含粘贴）后写回缓存
  onOutEditQtyInput(idx, el) {
    const clean = this.qtyInput(el);
    this.onOutEditQtyChange(idx, clean);
  },

  // 数量变化时更新缓存（出库成本由后端过账时计算，前端不录入）
  onOutEditQtyChange(idx, val) {
    if (this._obEditLines && this._obEditLines[idx]) {
      this._obEditLines[idx].qty = parseFloat(val) || 0;
      // 同步本行参考金额（灰字只读），与汇总同口径
      const amtCell = document.querySelector(`#ob-edit-lines [data-line-amount="${idx}"]`);
      if (amtCell) {
        const l = this._obEditLines[idx];
        amtCell.textContent = l.code ? this.fmtMoney((Number(l.qty) || 0) * this.obRefPriceAt(idx)) : '-';
      }
      this.refreshOutboundEditTotals();
    }
  },

  refreshOutboundEditTotals() {
    const lines = this._obEditLines || [];
    const totalQty = lines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    // 汇总金额与表格内的参考金额同口径（草稿为估算，不写回成本）
    const totalAmount = lines.reduce((sum, line, i) => sum + (Number(line.qty) || 0) * this.obRefPriceAt(i), 0);
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('ob_es_lines', lines.length);
    setText('ob_es_qty', this.fmtQty(totalQty));
    // 汇总金额块只在有价格权限时渲染，用 DOM 是否存在判断
    if (document.getElementById('ob_es_amt')) setText('ob_es_amt', this.fmtMoney(totalAmount));
    const cnt = document.getElementById('ob-edit-line-count');
    if (cnt) cnt.textContent = lines.length ? ' · ' + lines.length : '';
  },

  // 删除明细行（只删当前行，不影响其他物料）
  removeOutboundEditRow(idx) {
    if (!this._obEditLines) return;
    this._obEditLines.splice(idx, 1);
    this.renderOutboundEditTable();
  },

  // ========== 批量添加物料弹层（普通出库 / 无原单退库 / 更正新增行；关联原单的退库不启用） ==========
  showOutboundBatchPicker() {
    if (this._obIsReturn && !this._obNoOrigin) return;
    const materials = this._materialsCache || [];
    if (materials.length === 0) {
      this.toast(this.t('selectMaterial'), 'error');
      return;
    }
    const categories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    const catOpts = `<option value="">${this.t('all')}</option>` + categories.map(c =>
      `<option value="${this.ibEsc(c)}">${this.ibEsc(c)}</option>`).join('');
    this._obBatch = { cat: '', kw: '', onlyStock: false, sel: new Set() };

    this.showModal(`<h3>${this.t('obd_batch_title')}</h3>`,
      `<div class="pu-matfilter" style="margin-bottom:10px">
        <label>${this.t('mat_category')}<select id="ob_batch_cat" onchange="App.obBatchFilter()">${catOpts}</select></label>
        <input id="ob_batch_kw" type="search" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}" oninput="App.obBatchFilter()">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)"><input type="checkbox" id="ob_batch_only" onchange="App.obBatchFilter()"> ${this.t('obd_batch_only_stock')}</label>
        <span class="pu-mu" id="ob_batch_cnt"></span>
      </div>
      <div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr>
        <th style="width:34px"><input type="checkbox" id="ob_batch_all" onchange="App.obBatchToggleAll(this.checked)" aria-label="${this.t('obd_batch_select_all')}"></th>
        <th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th>
        <th>${this.t('mat_brand')}</th><th>${this.t('mat_unit')}</th>
        <th class="text-right">${this.t('out_available')}</th>
      </tr></thead><tbody id="ob_batch_body"></tbody></table></div>`,
      this.t('obd_batch_join', { n: 0 }), () => this.obBatchConfirm(), null, true);

    this.obBatchRender();
  },

  // 可用库存：缺行按 0 处理，负库存允许勾选（保留后端软放行）
  obStockOf(code) {
    const v = (this._outboundStockMap || {})[code];
    return v === undefined || v === null ? 0 : Number(v);
  },

  obBatchFiltered() {
    const st = this._obBatch || {};
    return (this._materialsCache || []).filter(m => {
      if (st.cat && m.category !== st.cat) return false;
      if (!this.puKwMatch([m.code, m.name, m.spec, m.brand].join(' '), st.kw)) return false;
      if (st.onlyStock && this.obStockOf(m.code) <= 0) return false;
      return true;
    });
  },

  obBatchRender() {
    const tbody = document.getElementById('ob_batch_body');
    if (!tbody) return;
    const st = this._obBatch || { sel: new Set() };
    const list = this.obBatchFiltered();
    const total = (this._materialsCache || []).length;
    const cnt = document.getElementById('ob_batch_cnt');
    if (cnt) cnt.textContent = `${list.length} / ${total}`;
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">${this.t('noData')}</td></tr>`;
    } else {
      tbody.innerHTML = list.map(m => {
        const q = this.obStockOf(m.code);
        const cls = q < 0 ? 'num-neg' : (q === 0 ? 'num-warn' : '');
        return `<tr>
          <td><input type="checkbox" class="ob-batch-cb" data-code="${this.ibEsc(m.code)}"${st.sel.has(m.code) ? ' checked' : ''} onchange="App.obBatchToggle(this.dataset.code, this.checked)"></td>
          <td>${this.ibEsc(m.code)}</td>
          <td>${this.ibEsc(m.name || '')}</td>
          <td>${this.ibEsc(m.spec || '')}</td>
          <td>${this.ibEsc(m.brand || '')}</td>
          <td>${this.ibEsc(m.unit || '')}</td>
          <td class="text-right${cls ? ' ' + cls : ''}" style="font-variant-numeric:tabular-nums">${this.fmtQty(q)}</td>
        </tr>`;
      }).join('');
    }
    const all = document.getElementById('ob_batch_all');
    if (all) all.checked = list.length > 0 && list.every(m => st.sel.has(m.code));
    this.obBatchUpdateLabel();
  },

  obBatchUpdateLabel() {
    const btn = document.getElementById('modal-confirm-btn');
    const n = (this._obBatch?.sel || new Set()).size;
    if (btn) btn.textContent = this.t('obd_batch_join', { n });
  },

  obBatchToggle(code, checked) {
    if (!this._obBatch) return;
    if (checked) this._obBatch.sel.add(code);
    else this._obBatch.sel.delete(code);
    this.obBatchUpdateLabel();
  },

  obBatchToggleAll(checked) {
    if (!this._obBatch) return;
    this.obBatchFiltered().forEach(m => {
      if (checked) this._obBatch.sel.add(m.code);
      else this._obBatch.sel.delete(m.code);
    });
    this.obBatchRender();
  },

  obBatchFilter() {
    if (!this._obBatch) return;
    this._obBatch.cat = document.getElementById('ob_batch_cat')?.value || '';
    this._obBatch.kw = document.getElementById('ob_batch_kw')?.value || '';
    this._obBatch.onlyStock = !!document.getElementById('ob_batch_only')?.checked;
    this.obBatchRender();
  },

  // 加入明细：数量留空待填；已在明细中的物料不静默合并，提示并定位到已有行
  obBatchConfirm() {
    const codes = [...((this._obBatch?.sel) || new Set())];
    if (!codes.length) { this.toast(this.t('obd_batch_no_pick'), 'error'); return; }
    if (!this._obEditLines) this._obEditLines = [];
    const existing = new Map();
    this._obEditLines.forEach((l, i) => { if (l.code && !existing.has(l.code)) existing.set(l.code, i); });
    let added = 0, dup = 0, dupIdx = -1;
    codes.forEach(code => {
      if (existing.has(code)) { dup++; dupIdx = existing.get(code); return; }
      const m = (this._materialsCache || []).find(x => x.code === code);
      if (!m) return;
      this._obEditLines.push({
        code: m.code, material_name: m.name, material_spec: m.spec,
        material_brand: m.brand, material_unit: m.unit,
        qty: '', cost_price: 0, remarks: ''
      });
      existing.set(m.code, this._obEditLines.length - 1);
      added++;
    });
    this._obBatch = null;
    this.closeModal();
    this.renderOutboundEditTable();
    if (dup) this.toast(this.t('obd_batch_dup', { n: dup }), 'error');
    if (added) this.toast(this.t('obd_batch_added', { n: added }));
    if (dupIdx >= 0) {
      const input = document.querySelector(`#ob-edit-lines .ob-edit-qty[data-idx="${dupIdx}"]`);
      if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); }
    }
  },

  // 明细行校验：数量必须为正数；0/非法值显式报错，不再静默丢行
  obValidateEditLines() {
    const lines = this._obEditLines || [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.code && !l.qty && !l.remarks) continue;
      if (!l.code) return { ok: false, message: this.t('line_material_required', { n: i + 1 }) };
      if (!this.qtyIsValid(l.qty)) return { ok: false, message: this.t('qty_line_invalid', { n: i + 1 }) };
      // 2C：关联原出库行的退库数量不能超过剩余可退量
      if (this._obIsReturn && l.origin_line_id && l.max_qty !== null && l.max_qty !== undefined
        && Number(l.qty) > Number(l.max_qty) + 1e-4) {
        return { ok: false, message: this.t('ret_qty_over_origin', { n: i + 1, max: l.max_qty }) };
      }
    }
    return { ok: true };
  },

  // 更正草稿：行数/数量与原单完全一致且单头（日期/去向/领用人/备注）未改动
  obCorrectionUnchanged() {
    const corr = this._obCorrection;
    if (!corr || !corr.origQtyByKey) return false;
    const lines = (this._obEditLines || []).filter(l => l.code && Math.abs(Number(l.qty)) > 0);
    if (lines.length !== corr.origQtyByKey.size) return false;
    const keys = this.obOutboundLineKeys(lines);
    for (let i = 0; i < lines.length; i++) {
      const q = corr.origQtyByKey.get(keys[i]);
      if (q === undefined) return false;
      if (Math.abs(Math.abs(Number(lines[i].qty)) - q) > 1e-9) return false;
    }
    const orig = corr.originalHeader || {};
    const sameExceptRemarks = ['date', 'destination', 'receiver', 'handler'].every(f => {
      const now = String(document.getElementById('ob_e_' + f)?.value || '').trim();
      return now === String(orig[f] || '').trim();
    });
    if (!sameExceptRemarks) return false;
    // 无原单退库：退库原因属于单头可改字段，改了原因也算有改动
    if (this._obNoOrigin) {
      const reasonNow = String(document.getElementById('ob_e_return_reason')?.value || '').trim();
      if (reasonNow !== String(orig.return_reason || '').trim()) return false;
    }
    // 基线：原单备注，或创建更正草稿时自动写入的「更正自 XXX」标记
    const remarksNow = String(document.getElementById('ob_e_remarks')?.value || '').trim();
    const baseline = new Set([String(orig.remarks || '').trim()]);
    if (String(corr.original_doc_no || '').trim()) baseline.add('更正自 ' + String(corr.original_doc_no).trim());
    return baseline.has(remarksNow);
  },

  // ========== 保存草稿 ==========
  async saveOutboundDraft() {
    const docNo = this._obDocNo;

    // 无原单退库：单头三项必填（前端即时提示）
    const missing = this.obNoOriginHeaderMissing(false);
    if (missing) {
      this.toast(this.t(missing), 'error');
      return;
    }

    // 更正单：与原单完全一致且单头未改动时不允许保存
    if (this.obCorrectionUnchanged()) {
      this.toast(this.t('corr_no_change'), 'error');
      return;
    }

    const check = this.obValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = (this._obEditLines || []).filter(l => l.code);

    const body = {
      lines: lines.map(l => ({
        code: l.code,
        qty: parseFloat(l.qty) || 0,
        remarks: l.remarks || '',
        origin_line_id: l.origin_line_id || 0
      })),
      origin_doc_no: this._obIsReturn ? this._obOriginDocNo : undefined,
      return_reason: this._obNoOrigin ? (document.getElementById('ob_e_return_reason')?.value || '') : undefined,
      date: document.getElementById('ob_e_date')?.value,
      destination: document.getElementById('ob_e_destination')?.value,
      receiver: document.getElementById('ob_e_receiver')?.value,
      handler: document.getElementById('ob_e_handler')?.value,
      remarks: document.getElementById('ob_e_remarks')?.value
    };

    try {
      await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
      this.toast(this.t('obd_draft_saved'));
      await this.editOutboundDoc(docNo);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // ========== 确认出库（从编辑页面） ==========
  confirmOutboundDocFromEdit() {
    const docNo = this._obDocNo;
    const isReturn = !!this._obIsReturn;

    // 无原单退库：单头三项必填（过账前前端即时提示，后端硬校验兜底）
    const missing = this.obNoOriginHeaderMissing(false);
    if (missing) {
      this.toast(this.t(missing), 'error');
      return;
    }

    const check = this.obValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = (this._obEditLines || []).filter(l => l.code);

    if (lines.length === 0) {
      this.toast(this.t('obd_no_lines'), 'error');
      return;
    }

    this.confirmDialog(this.t(isReturn ? 'obd_confirm_return' : 'obd_confirm'),
      `${this.t(isReturn ? 'obd_confirm_return_hint' : 'obd_confirm_hint')}\n\n${this.t('obd_line_count', { n: lines.length })} | ${this.t('out_total_qty')}: ${lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)}`,
      async () => {
        const body = {
          lines: lines.map(l => ({
            code: l.code,
            qty: parseFloat(l.qty) || 0,
            remarks: l.remarks || '',
            origin_line_id: l.origin_line_id || 0
          })),
          origin_doc_no: this._obIsReturn ? this._obOriginDocNo : undefined,
          return_reason: this._obNoOrigin ? (document.getElementById('ob_e_return_reason')?.value || '') : undefined,
          date: document.getElementById('ob_e_date')?.value,
          destination: document.getElementById('ob_e_destination')?.value,
          receiver: document.getElementById('ob_e_receiver')?.value,
          handler: document.getElementById('ob_e_handler')?.value,
          remarks: document.getElementById('ob_e_remarks')?.value
        };
        try {
          await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
          try {
            const r = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', {});
            this.toast(this.t(isReturn ? 'obd_confirm_return_ok' : 'obd_confirm_ok', { n: r.line_count }));
            await this.openOutboundDoc(docNo);
          } catch (e) {
            if (e.code === 'INSUFFICIENT_STOCK') {
              this.handleOutboundDocStockError(e, docNo);
            } else if (e.code === 'NO_COST_BASIS') {
              // 该物料从未有过正库存：0 成本入账需管理员显式确认
              const codes = (e.details || []).map(d => d.code).join('、');
              this.confirmDialog(this.t('cost_basis_none'),
                `${this.t('cost_basis_none_tip')}\n\n${codes}`,
                async () => {
                  try {
                    const r2 = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', { accept_no_basis: true });
                    this.toast(this.t(isReturn ? 'obd_confirm_return_ok' : 'obd_confirm_ok', { n: r2.line_count }));
                    await this.openOutboundDoc(docNo);
                  } catch (e2) {
                    this.toast(e2.code === 'NO_BASIS_FORBIDDEN' ? this.t('cost_basis_none_forbidden') : e2.message, 'error');
                  }
                }, null, 'primary');
            } else {
              this.toast(e.message, 'error');
            }
          }
        } catch (e) {
          this.toast(e.message, 'error');
        }
      }, null, 'primary');
  },

  // ========== 更正重开（出库 / 退库） ==========
  // 行身份：关联原出库行的退库用 RL:origin_line_id，其余按 MC:code#序号
  obOutboundLineKeys(lines) {
    const seen = {};
    return (lines || []).map(l => {
      const rid = Number(l.origin_line_id) || 0;
      if (rid > 0) return 'RL:' + rid;
      const code = String(l.code || '');
      seen[code] = (seen[code] || 0) + 1;
      return 'MC:' + code + '#' + seen[code];
    });
  },

  // 详情页「更正」：生成/复用预填草稿并进入编辑页
  async startOutboundCorrection(docNo) {
    try {
      const info = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/correction-info');
      const corr = (info && info.correction) || {};
      if (!corr.eligible) {
        this.toast(this.t('ibd_corr_not_eligible'), 'error');
        return;
      }
      const r = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/correction', 'POST', {});
      await this.editOutboundDoc(r.doc_no);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // 编辑页「确认更正」：有行 → 作废原单 + 新单过账；无行 → 只作废原单
  confirmOutboundCorrection() {
    const docNo = this._obDocNo;
    // 无原单退库更正：单头三项必填（原因随更正继承，可改）
    const missing = this.obNoOriginHeaderMissing(false);
    if (missing) { this.toast(this.t(missing), 'error'); return; }
    // 与「保存草稿」共用同一套无改动判定：行数/每行数量/单头可改字段与原单完全一致时不允许确认
    if (this.obCorrectionUnchanged()) {
      this.toast(this.t('corr_no_change'), 'error');
      return;
    }
    const check = this.obValidateEditLines();
    if (!check.ok) { this.toast(check.message, 'error'); return; }
    const lines = (this._obEditLines || []).filter(l => l.code);
    const voidOnly = lines.length === 0;
    const body = {
      lines: lines.map(l => ({
        code: l.code,
        qty: parseFloat(l.qty) || 0,
        remarks: l.remarks || '',
        origin_line_id: l.origin_line_id || 0
      })),
      origin_doc_no: this._obIsReturn ? this._obOriginDocNo : undefined,
      return_reason: this._obNoOrigin ? (document.getElementById('ob_e_return_reason')?.value || '') : undefined,
      date: document.getElementById('ob_e_date')?.value,
      destination: document.getElementById('ob_e_destination')?.value,
      receiver: document.getElementById('ob_e_receiver')?.value,
      handler: document.getElementById('ob_e_handler')?.value,
      remarks: document.getElementById('ob_e_remarks')?.value
    };
    const self = this;
    const hint = voidOnly ? this.t('ibd_corr_void_only_hint') : this.t('ibd_corr_confirm_hint');
    this.confirmDialog(this.t('ibd_corr_confirm'), hint, async () => {
      try {
        await self.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
        try {
          const r = await self.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/confirm-correction', 'POST', {});
          self._obCorrection = null;
          if (r.mode === 'void-only') {
            self.toast(self.t('ibd_corr_void_only_done', { no: r.voided_doc_no }), 'success');
            await self.openOutboundDoc(r.voided_doc_no);
          } else {
            self.toast(self.t('ibd_corr_confirmed', { no: r.doc_no }), 'success');
            await self.openOutboundDoc(r.doc_no);
          }
        } catch (e) {
          if (e.code === 'INSUFFICIENT_STOCK') {
            const details = (e.details || []).map(d => this.t('obd_stock_detail', { code: d.code, requested: d.requested, available: d.available })).join('\n');
            self.toast(this.t('obd_stock_short_detail', { detail: details }), 'error');
          } else {
            self.toast(e.message, 'error');
          }
        }
      } catch (e) {
        self.toast(e.message, 'error');
      }
    }, null, 'primary');
  },

  // 确认出库（从详情页面，草稿已有明细行）
  confirmOutboundDoc() {
    const docNo = this._obDocNo;
    const d = this._obDetail;
    const isReturn = d?.txn_type === '领料退库';
    const lines = d?.lines || [];

    // 无原单退库：单头三项必填（详情页直接过账同样拦截）
    if (isReturn && d && !String(d.origin_doc_no || '').trim()) {
      if (!String(d.destination || '').trim()) { this.toast(this.t('ret_no_origin_dest_required'), 'error'); return; }
      if (!String(d.receiver || '').trim()) { this.toast(this.t('ret_no_origin_receiver_required'), 'error'); return; }
      if (!String(d.return_reason || '').trim()) { this.toast(this.t('ret_no_origin_reason_required'), 'error'); return; }
    }

    if (lines.length === 0) {
      this.toast(this.t('obd_no_lines'), 'error');
      return;
    }

    this.confirmDialog(this.t(isReturn ? 'obd_confirm_return' : 'obd_confirm'),
      `${this.t(isReturn ? 'obd_confirm_return_hint' : 'obd_confirm_hint')}\n\n${this.t('obd_line_count', { n: lines.length })} | ${this.t('out_total_qty')}: ${lines.reduce((s, l) => s + Number(l.qty || 0), 0)}`,
      async () => {
        try {
          const r = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', {});
          this.toast(this.t(isReturn ? 'obd_confirm_return_ok' : 'obd_confirm_ok', { n: r.line_count }));
          await this.openOutboundDoc(docNo);
        } catch (e) {
          if (e.code === 'INSUFFICIENT_STOCK') {
            this.handleOutboundDocStockError(e, docNo);
          } else {
            this.toast(e.message, 'error');
          }
        }
      }, null, 'primary');
  },

  // 出库库存不足：负库存硬拦，直接提示错误，不提供强制放行
  handleOutboundDocStockError(err) {
    const details = (err.details || []).map(d => this.t('obd_stock_detail', { code: d.code, requested: d.requested, available: d.available })).join('\n');
    this.toast(this.t('obd_stock_short_detail', { detail: details }), 'error');
  },

  // ========== 删除出库单据 ==========
  deleteOutboundDoc(docNo) {
    const d = this._obDetail && this._obDetail.doc_no === docNo ? this._obDetail : null;
    const lineCount = d ? (d.lines || []).length : null;
    const detailText = lineCount === null ? this.t('obd_delete_confirm')
      : this.t('obd_delete_confirm_lines', { no: docNo, n: lineCount });
    this.confirmDialog(this.t('delete'), detailText, async () => {
      try {
        await this.api('/api/outbound-docs/' + encodeURIComponent(docNo), 'DELETE');
        this.toast(this.t('deleted'));
        const s = this.obState();
        s.sel = null; s.wide = false;
        this._obDetail = null;
        this._obDocNo = null;
        await this.gotoPage('outbound');
      } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  // ========== 导航 ==========
  async backToOutboundList() {
    const newForm = !!document.getElementById('ob_f_txn_type');
    const type = newForm ? document.getElementById('ob_f_txn_type').value : (this._obDetail?.txn_type || '');
    await this.obDropEmptyDraftOnLeave();
    if (type === '领料退库') {
      this.retState().tab = '领料退库';
      this.retState().sel = '';
      return this.gotoPage('returns');
    }
    this._obView = 'list';
    const s = this.obState();
    s.sel = null; s.wide = false;
    this.gotoPage('outbound');
  },

  async backToOutboundDetail(docNo) {
    const d = this._obDetail;
    const isReturn = d && d.txn_type === '领料退库';
    const dropped = await this.obDropEmptyDraftOnLeave();
    if (dropped) {
      if (isReturn) {
        this.retState().tab = '领料退库';
        this.retState().sel = '';
        return this.gotoPage('returns');
      }
      this._obView = 'list';
      return this.gotoPage('outbound');
    }
    if (isReturn) {
      this.retState().tab = '领料退库';
      return this.openReturnDoc(docNo);
    }
    this.openOutboundDoc(docNo);
  },

});
