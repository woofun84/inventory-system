/**
 * 库存盘点 —— 盘点单列表 / 右侧详情栏 / 录入实盘编辑页 / 确认 / 删除草稿
 *
 * 交互范式对齐入库 / 出库 / 采购（见 05-inbound.js）：
 *  - 单页三段式：视图页签（全部 / 草稿 / 已确认）+ 条件区 + 状态统计卡片 + 列表
 *  - 列表右侧 sticky 详情栏（.pu-split.open），点行原地展开，不跳页
 *  - 详情子页签带计数：盘点明细 / 关联单据 / 操作日志（日志恒最后）
 *  - 录入实盘 / 新建：独立页面（.pu-edit-bar + 01 单据信息 + 02 盘点明细 + .pu-edit-actions）
 *  - 列表 / 详情 / 日志复用 pages.css 中的 .pu-* 组件样式，保证各模块观感一致
 *
 * 业务口径不变（本次只改前端）：
 *  - 盘点以实盘为准，确认时仅为「有差异」的行生成库存调整流水（adjust）
 *  - 盘盈盘亏按确认时的当时均价计价，确认不改动物料均价
 *  - 账面数量在建单生成明细时固化为快照（book_qty）
 *  - 权限动作粒度：view / create（建单+录实盘+删草稿）/ confirm（确认并生成流水）
 */
Object.assign(App, {

  // ========== 状态 ==========
  stState() {
    if (!this._st) this._st = {};
    const s = this._st;
    if (s.tab === undefined) s.tab = '';      // 视图页签：'' | draft | confirmed
    if (s.sel === undefined) s.sel = null;    // 详情栏当前盘点单号
    if (!s.dt) s.dt = 'lines';                // 详情子页签：lines | related | logs
    if (s.wide === undefined) s.wide = false;
    if (s.dense === undefined) s.dense = false;
    if (s.kpi === undefined) s.kpi = '';
    if (!s.f) s.f = { kw: '', from: '', to: '' };
    if (!s.lq) s.lq = '';
    if (!s.ex) s.ex = new Set();
    if (s.onlyUn === undefined) s.onlyUn = false;   // 明细只显示未盘行
    if (!this._stCache) this._stCache = {};
    if (!this._stList) this._stList = [];
    return s;
  },

  // ========== 页面骨架（对齐入库：页签 + 条件区 + KPI + 列表/详情栏） ==========
  async renderStocktake() {
    const s = this.stState();
    this.setMain(this.pageWrap(this.icon('clipboard', 'icon--title') + ' ' + this.t('st_title'), this.t('st_desc'), '', this.stSkeleton()));
    const pb = document.querySelector('.page-body');
    if (pb) pb.classList.add('pu-page-body');
    this.stBindEvents();
    this.stRenderTabs();
    this.stRenderToolbar();
    this.stRenderFilters();
    const root = document.getElementById('st-root');
    if (root) root.classList.toggle('st-dense', !!s.dense);
    await this.loadStocktakeList();
    // 跨模块跳转（查询中心「在原模块打开」等）：先按单据真实状态把行定位到列表
    const reveal = this._stRevealDoc;
    if (reveal) {
      this._stRevealDoc = null;
      this.stRevealDoc(reveal);
    }
    // 进入页面时若有选中的盘点单，强制重取详情，避免复用上次的快照
    if (s.sel) await this.stOpen(s.sel); else this.stRenderInspector();
    if (reveal) this.docRowFlash('st-scroll', 'tr[data-ra="stocktake"][data-id="' + CSS.escape(String(reveal)) + '"]');
  },

  stSkeleton() {
    return `<div id="st-root" class="data-page">
      <div class="data-toolbar">
        <nav id="st-tabs" class="pu-viewtabs" role="tablist" aria-label="${this.t('st_title')}"></nav>
        <div class="pu-toolbar">
          <div id="st-filters" class="pu-filter-inner"></div>
          <div id="st-head-actions" class="pu-head-actions"></div>
        </div>
      </div>
      <div id="st-kpis" class="pu-kpis" role="group" aria-label="${this.t('st_status')}"></div>
      <div class="pu-split" id="st-split">
        <section class="pu-list">
          <div class="data-scroll" id="st-scroll"></div>
          <div class="pu-pager" id="st-pager"></div>
        </section>
        <aside class="pu-insp" id="st-insp" hidden aria-label="${this.t('st_view_detail')}"></aside>
      </div>
    </div>`;
  },

  stTabDefs() {
    return [
      ['', this.t('all')],
      ['draft', this.t('st_status_draft')],
      ['confirmed', this.t('st_status_confirmed')],
    ];
  },

  stRenderTabs() {
    const box = document.getElementById('st-tabs');
    if (!box) return;
    const s = this.stState();
    box.innerHTML = this.stTabDefs().map(([k, label]) =>
      `<button type="button" class="pu-viewtab" role="tab" aria-selected="${s.tab === k}" data-st="tab" data-id="${k}">${label}</button>`
    ).join('');
  },

  stRenderToolbar() {
    const box = document.getElementById('st-head-actions');
    if (!box) return;
    box.innerHTML = this.can('stocktake', 'manage')
      ? `<button type="button" class="btn btn-primary" data-st="new">+ ${this.t('st_add')}</button>` : '';
  },

  stRenderFilters() {
    const box = document.getElementById('st-filters');
    if (!box) return;
    const s = this.stState();
    const ph = this.t('st_filter_hint');
    box.innerHTML = `<div class="pu-search" role="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="st_f_kw" type="search" value="${this.docEsc(s.f.kw)}" placeholder="${ph}" aria-label="${ph}">
      </div>
      <div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="st_f_from">${this.t('pu_date')}</label>
        <input id="st_f_from" type="date" value="${this.docEsc(s.f.from)}" aria-label="${this.t('pu_date')}">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="st_f_to" type="date" value="${this.docEsc(s.f.to)}" aria-label="${this.t('pu_date')}">
      </div>
      <button type="button" class="btn btn-outline btn-sm" data-st="clr">${this.t('pu_clear_filter')}</button>
      <button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.dense}" data-st="dense">${this.t('pu_dense')}</button>`;
  },

  async loadStocktakeList() {
    try {
      this._stList = await this.api('/api/stocktakes');
    } catch (e) {
      this._stList = [];
      const scroll = document.getElementById('st-scroll');
      if (scroll) scroll.innerHTML = `<div class="pu-empty">${this.docEsc(e.message)}</div>`;
      const kp = document.getElementById('st-kpis'); if (kp) kp.innerHTML = '';
      const pg = document.getElementById('st-pager'); if (pg) pg.innerHTML = '';
      return;
    }
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['stocktake'] = () => this.stRenderList();
    this.stRenderList();
    this.markFresh('stocktake');
  },

  // ========== 列表渲染（KPI 卡片 + 条件吸附分页） ==========
  stKpiDefs() {
    return [
      ['', this.t('all'), () => true],
      ['draft', this.t('st_status_draft'), r => r.status === 'draft'],
      ['confirmed', this.t('st_status_confirmed'), r => r.status === 'confirmed'],
      ['diff', this.t('st_diff'), r => Number(r.diff_count) > 0],
    ];
  },

  stHasFilter() {
    const s = this.stState();
    return !!(s.f.kw || s.f.from || s.f.to || s.kpi || s.tab);
  },

  // 页签口径（不含关键字/日期/状态卡片），KPI 与列表共用
  stScopeRows() {
    const s = this.stState();
    let rows = this._stList || [];
    if (s.tab) rows = rows.filter(r => r.status === s.tab);
    return rows;
  },

  // 过滤顺序：状态页签 → 关键字（空格 AND）→ 日期区间 → 统计卡片
  stVisibleRows() {
    const s = this.stState();
    let rows = this.stScopeRows();
    if (s.f.kw) rows = this.filterByKeywords(rows, s.f.kw, ['stocktake_no', 'handler', 'remarks', 'category_filter', 'load_scope']);
    rows = this.filterByDateRange(rows, 'date', s.f.from, s.f.to);
    const def = this.stKpiDefs().find(d => d[0] === s.kpi);
    return def ? rows.filter(def[2]) : rows;
  },

  stRenderList() {
    const s = this.stState();
    const kp = document.getElementById('st-kpis');
    if (kp) {
      kp.innerHTML = this.stKpiDefs().map(([k, label, fn]) =>
        `<button type="button" class="pu-kpi" aria-pressed="${s.kpi === k}" data-st="kpi" data-id="${k}"><small>${label}</small><strong>${this.stScopeRows().filter(fn).length}</strong></button>`
      ).join('');
    }
    const rows = this.stVisibleRows();
    const st = this.getTableState('stocktake');
    const sorted = this.sortData(rows, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const scroll = document.getElementById('st-scroll');
    if (scroll) {
      scroll.innerHTML = sorted.length
        ? this.stListTable(pageData)
        : `<div class="pu-empty">${this.t('pu_no_result')}<br><span class="pu-mu">${this.stHasFilter() ? this.t('pu_no_result_hint') : this.t('pu_empty_hint')}</span></div>`;
    }
    this.stRenderPager(sorted);
    this.pinPager('st-pager');
  },

  stListTable(pageData) {
    const sel = this.stState().sel;
    const tid = 'stocktake';
    const cols = [
      ['stocktake_no', this.t('st_no'), r =>
        `<button type="button" class="pu-lk" data-st="open" data-id="${this.docEsc(r.stocktake_no)}">${this.docEsc(r.stocktake_no)}</button>`],
      ['date', this.t('adj_date'), r => this.fmtDocDate(r.date, r.created_at, r.confirmed_at)],
      ['status', this.t('st_status'), r => this.stStatusBadge(r.status), 'center'],
      ['load_scope', this.t('st_scope'), r => this.docEsc(this.stScopeLabel(r))],
      ['handler', this.t('st_handler'), r => this.docEsc(r.handler || '')],
      ['line_count', this.t('st_lines'), r => r.line_count || 0, true],
      ['counted_count', this.t('st_counted'), r => r.counted_count || 0, true],
      ['diff_count', this.t('st_diff'), r => Number(r.diff_count) > 0
        ? `<span class="badge badge-warning">${r.diff_count}</span>`
        : `<span class="pu-mu">0</span>`, true],
      ['remarks', this.t('st_remark'), r => this.cellClip(r.remarks)],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = pageData.map(r => {
      const on = sel === r.stocktake_no;
      return `<tr class="pu-row${on ? ' sel' : ''}" data-ra="stocktake" data-id="${this.docEsc(r.stocktake_no)}">` +
        shown.map(c => `<td class="${this.colAlignClass(c[3])}">${c[2](r)}</td>`).join('') + '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  stRenderPager(rows) {
    const box = document.getElementById('st-pager');
    if (!box) return;
    const tot = `${this.t('pu_sum_orders', { n: rows.length })}`
      + ` · ${this.t('st_status_draft')} ${rows.filter(r => r.status === 'draft').length}`
      + ` · ${this.t('st_status_confirmed')} ${rows.filter(r => r.status === 'confirmed').length}`
      + ` · ${this.t('st_diff')} ${rows.filter(r => Number(r.diff_count) > 0).length}`;
    box.innerHTML = this.puPagerHtml('stocktake', rows.length, tot, { ns: 'st', hideEmpty: true });
  },

  // 状态徽标
  stStatusBadge(status) {
    return this.docStatusBadge('st', status);
  },

  // 行状态徽标
  stLineStatusBadge(status) {
    const map = {
      pending: [this.t('st_line_pending'), 'muted'],
      counted: [this.t('st_counted'), 'info'],
      matched: [this.t('st_line_matched'), 'success'],
      adjusted: [this.t('st_line_adjusted'), 'info'],
    };
    const m = map[status] || [status, 'muted'];
    return `<span class="badge badge-${m[1]}">${m[0]}</span>`;
  },

  // 盘点范围显示（建单时固化，三档：全盘 / 按类别 / 按物料盘点）
  stScopeLabel(r) {
    const scope = (r && r.load_scope) || '';
    const cats = String((r && r.category_filter) || '').split(',').map(s => s.trim()).filter(Boolean);
    const sep = this.lang === 'en' ? ', ' : '、';
    if (scope === 'specified') {
      // 按物料盘点：显示该单当前明细行数（列表用 line_count，详情用 summary / lines）
      let n = 0;
      if (r) {
        if (r.line_count !== undefined && r.line_count !== null) n = Number(r.line_count);
        else if (r.summary && r.summary.line_count !== undefined) n = Number(r.summary.line_count);
        else if (Array.isArray(r.lines)) n = r.lines.length;
      }
      return this.t('st_scope_specified', { n: n || 0 });
    }
    if (scope === 'category') return this.t('st_scope_category', { c: cats.join(sep) || '-' });
    if (scope === 'all') return this.t('st_scope_all');
    return cats.length ? this.t('st_scope_category', { c: cats.join(sep) }) : this.t('st_scope_all');
  },

  // ========== 详情栏（点行原地展开，不整页跳转） ==========
  async stOpen(no) {
    if (!no) return;
    const s = this.stState();
    if (s.sel !== no) { s.dt = 'lines'; s.lq = ''; s.ex = new Set(); s.onlyUn = false; }
    s.sel = no;
    this._stNo = no;
    this._stCache[no] = { loading: true };
    this.stRenderList();
    this.stRenderInspector();
    try {
      const d = await this.api('/api/stocktakes/' + encodeURIComponent(no));
      this._stCache[no] = { d };
      this._stDetail = d;
    } catch (e) {
      this._stCache[no] = { error: e.message };
    }
    if (this.stState().sel !== no) return;
    this.stRenderInspector();
  },

  async stCloseInspector() {
    const s = this.stState();
    const prev = s.sel;
    s.sel = null; s.wide = false;
    if (this.isStale('stocktake')) {
      // 详情栏开着期间发生过写操作：关闭前补拉一次列表，避免回到旧数据
      await this.loadStocktakeList();
    } else {
      this.stRenderList();
    }
    this.stRenderInspector();
    if (prev) {
      const el = document.querySelector(`#st-scroll [data-st="open"][data-id="${CSS.escape(String(prev))}"]`);
      if (el) el.focus();
    }
  },

  stRenderInspector() {
    const s = this.stState();
    const box = document.getElementById('st-insp');
    const split = document.getElementById('st-split');
    if (!box || !split) return;
    if (!s.sel) {
      box.hidden = true; box.innerHTML = '';
      split.classList.remove('open', 'wide');
      return;
    }
    box.hidden = false;
    split.classList.add('open');
    split.classList.toggle('wide', s.wide);
    const rec = this._stCache[s.sel];
    if (!rec || rec.loading) { box.innerHTML = `${this.skeleton('detail')}`; return; }
    if (rec.error) { box.innerHTML = `<div class="pu-empty">${this.docEsc(rec.error)}</div>`; return; }
    const d = rec.d;
    const lines = d.lines || [];
    const adjRows = this.stAdjRows(d);
    const logs = d.logs || [];
    if (!['lines', 'related', 'logs'].includes(s.dt)) s.dt = 'lines';

    const meta = [
      [this.t('st_handler'), d.handler || '–'],
      [this.t('st_scope'), this.stScopeLabel(d)],
      [this.t('adj_date'), this.fmtDocDate(d.date, d.created_at, d.confirmed_at) || '–'],
      [this.t('ibd_created_by'), d.created_by || '–'],
      [this.t('ibd_created_at'), this.fmtDateTime(d.created_at) || '–'],
    ];
    if (d.confirmed_at) meta.push([this.t('st_confirmed_at'), this.fmtDateTime(d.confirmed_at)]);
    meta.push([this.t('st_remark'), d.remarks || '–']);

    // 页签顺序统一：明细 → 调整记录 → 操作日志（日志永远最后）
    // 调整记录页签恒显示，无差异时面板内给空态文案
    const tabs = [
      ['lines', this.t('st_tab_lines'), lines.length],
      ['related', this.t('st_tab_related'), adjRows.length],
      ['logs', this.t('pu_tab_logs'), logs.length],
    ];

    // 顶部动作条：录入实盘 / 只显示未盘 / 批量填 0 与列表同屏可见，不再藏在抽屉底部
    const isDraft = d.status === 'draft';
    const uncounted = lines.filter(l => l.count_qty === null || l.count_qty === undefined).length;
    let acts = '';
    if (isDraft && this.can('stocktake', 'manage')) {
      acts += `<button type="button" class="btn btn-primary btn-sm" data-st="e-doc">${this.t('st_edit_counts')}</button>`;
      if (lines.length) {
        acts += `<button type="button" class="btn btn-outline btn-sm" aria-pressed="${!!s.onlyUn}" data-st="only-un">${this.t('st_only_uncounted')}</button>`;
        acts += `<button type="button" class="btn btn-outline btn-sm" data-st="zero"${uncounted ? '' : ' disabled'}>${this.t('st_bulk_zero')}</button>`;
      }
    }
    if (isDraft && lines.length && this.can('stocktake', 'post')) {
      acts += `<button type="button" class="btn btn-primary btn-sm" data-st="confirm">${this.t('st_confirm')}</button>`;
    }
    if (isDraft && this.can('stocktake', 'delete')) {
      acts += `<button type="button" class="btn btn-danger btn-sm" data-st="del">${this.t('st_delete')}</button>`;
    }
    // 盘点表打印：只读输出，详情卡已按查看权进入，不挂写权限
    acts += `<button type="button" class="btn btn-outline btn-sm" data-st="print">${this.t('doc_print')}</button>`;

    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" data-st="icl">← ${this.t('pu_back_list')}</button>
      <div class="pu-insp-head">
        <div>
          <small>${this.t('st_title')}</small>
          <h2>${this.docEsc(d.stocktake_no)}</h2>
          <span class="pu-badge">${this.stStatusBadge(d.status)}</span>
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" data-st="wide" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}">${this.icon(s.wide ? 'restore' : 'maximize', 'icon--tool')}</button>
          <button type="button" class="btn btn-outline btn-sm" data-st="icl" title="${this.t('pu_close_detail')}" aria-label="${this.t('pu_close_detail')}">${this.icon('close', 'icon--tool')}</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${this.docEsc(m[0])}</dt><dd>${this.docEsc(m[1])}</dd></div>`).join('')}</dl>
      ${acts ? `<div class="pu-lqtoolbar st-insp-actions">${acts}</div>` : ''}
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" data-st="dt" data-id="${k}">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="st-dpanel"></div>`;
    this.stRenderDetailPanel();
    this.pinPager('st-pager');
  },

  stRenderDetailPanel() {
    const s = this.stState();
    const box = document.getElementById('st-dpanel');
    if (!box) return;
    const rec = this._stCache[s.sel];
    if (!rec || !rec.d) { box.innerHTML = ''; return; }
    const d = rec.d;
    if (s.dt === 'lines') return this.stRenderLinesBody();
    if (s.dt === 'related') return this.stRenderRelated(d);
    box.innerHTML = this.stLogsPanel(d.logs || []);
  },

  // --- 明细：手风琴（宽屏时切换为全表） ---
  stRenderLinesBody() {
    const s = this.stState();
    const box = document.getElementById('st-dpanel');
    const rec = this._stCache[s.sel];
    if (!box || !rec || !rec.d) return;
    const d = rec.d;
    const lines = d.lines || [];
    this.docLinesBind('stocktake', () => { const s = this.stState(); s.dt = 'lines'; s.wide = true; this.stRenderInspector(); });
    if (s.wide) {
      this._tableRenderers['stocktake_detail_lines'] = () => this.stRenderLinesBody();
      box.innerHTML = `<div id="st-lines-body">${this.stDetailLinesTable(lines)}</div>`;
      return;
    }
    const f = lines.filter(l => {
      if (s.onlyUn && l.count_qty !== null && l.count_qty !== undefined) return false;
      if (s.lq && !this.matchKeywords([l.code, l.material_name, l.material_spec, l.material_brand, l.remarks], s.lq)) return false;
      return true;
    });
    const shown = this.docLinesShown('stocktake', f.length);

    let html = `<div class="pu-lqtoolbar">
      <input id="st_lqi" type="search" value="${this.docEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}">
    </div>`;
    if (!lines.length) {
      html += `<div class="pu-empty">${this.t('st_empty_lines')}</div>`;
      box.innerHTML = html; return;
    }
    html += `<p class="pu-cnt">${this.t('pu_shown_count', { shown, total: f.length })}</p>`;
    if (!f.length) {
      html += `<div class="pu-empty">${s.onlyUn && !s.lq ? this.t('st_all_counted') : this.t('pu_no_lines')}</div>`;
      box.innerHTML = html; return;
    }
    html += `<ul class="pu-lines">` + f.slice(0, shown).map(l => {
      const ex = s.ex.has(String(l.id));
      const hasCount = l.count_qty !== null && l.count_qty !== undefined;
      const cnt = hasCount ? Number(l.count_qty) : null;
      const book = Number(l.book_qty) || 0;
      const diff = hasCount ? Math.round((cnt - book) * 10000) / 10000 : null;
      let diffHtml = '–';
      if (diff !== null) {
        const cls = diff > 0 ? 'num-pos' : (diff < 0 ? 'num-neg' : '');
        diffHtml = `<span class="${cls}" style="font-weight:600">${diff > 0 ? '+' : ''}${this.fmtQty(diff)}</span>`;
      }
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" data-st="ex" data-id="${l.id}" aria-expanded="${ex}">
          <span class="pu-line-n"><strong>${this.docEsc(l.code)}</strong> ${this.docEsc(l.material_name || '')} <span class="pu-mu">${this.docEsc(l.material_spec || '')}</span></span>
          <span class="pu-line-q">${hasCount ? this.qtyWithUnit(cnt, l.material_unit) : '–'}</span>
        </button>
        ${ex ? `<div class="pu-line-d">
          <div class="pu-mu">${this.t('st_book_qty')} ${this.qtyCell(book)} · ${this.t('st_count_qty')} ${hasCount ? this.qtyCell(cnt) : '–'} · ${this.t('st_diff_qty')} ${diffHtml}</div>
          <div>${this.stLineStatusBadge(l.status)}${l.remarks ? ` · ${this.t('pu_remarks')}：${this.docEsc(l.remarks)}` : ''}</div>
          ${(this._stDetail && this._stDetail.status === 'confirmed' && hasCount && this.can('stocktake', 'correct')) ? `<div style="margin-top:6px"><button type="button" class="btn btn-outline btn-sm" onclick="App.stCorrectPrompt(${l.id})">${this.t('st_correct_line')}</button></div>` : ''}
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    html += this.docLinesToggleHtml('stocktake', f.length);
    box.innerHTML = html;
  },

  stDetailLinesTable(lines) {
    const tid = 'stocktake_detail_lines';
    const cols = [
      ['code', this.t('mat_code'), r => this.docEsc(r.code)],
      ['material_name', this.t('mat_name'), r => this.docEsc(r.material_name || '')],
      ['material_spec', this.t('mat_spec'), r => this.docEsc(r.material_spec || '')],
      ['material_brand', this.t('mat_brand'), r => this.docEsc(r.material_brand || '')],
      ['book_qty', this.t('st_book_qty'), r => this.qtyWithUnit(Number(r.book_qty) || 0, r.material_unit), true],
      ['count_qty', this.t('st_count_qty'), r => (r.count_qty === null || r.count_qty === undefined) ? '–' : this.qtyWithUnit(r.count_qty, r.material_unit), true],
      ['diff_qty', this.t('st_diff_qty'), r => {
        const has = r.count_qty !== null && r.count_qty !== undefined;
        if (!has) return '–';
        const diff = Number(r.diff_qty) || 0;
        const cls = diff > 0 ? 'num-pos' : (diff < 0 ? 'num-neg' : '');
        return `<span class="${cls}" style="font-weight:600">${diff > 0 ? '+' : ''}${this.fmtQty(diff)}</span>${r.material_unit ? ' ' + this.docEsc(r.material_unit) : ''}`;
      }, true],
      ['status', this.t('st_status_label'), r => this.stLineStatusBadge(r.status), 'center'],
      ['remarks', this.t('st_remark'), r => this.cellClip(r.remarks)],
    ];
    const st = this.getTableState(tid);
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const canCorrect = !!(this._stDetail && this._stDetail.status === 'confirmed') && this.can('stocktake', 'correct');
    const th = cols.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('') + (canCorrect ? '<th></th>' : '');
    const body = sorted.map(r => '<tr>' + cols.map(c => `<td class="${this.colAlignClass(c[3])}">${c[2](r)}</td>`).join('')
      + (canCorrect
        ? `<td class="text-center">${(r.count_qty !== null && r.count_qty !== undefined) ? `<button type="button" class="btn btn-outline btn-sm" onclick="App.stCorrectPrompt(${r.id})">${this.t('st_correct_line')}</button>` : ''}</td>`
        : '')
      + '</tr>').join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body || this.emptyRow(cols.length + (canCorrect ? 1 : 0), this.t('noData'), { pad: 24 })}</tbody></table></div>`;
  },

  // 调整记录：只列产生过差异或产生过调整的行（差异 0 且从未调整的行不出现）
  // 返回按明细顺序排列的行集合；修订记录随行返回，供行下折叠区渲染
  stAdjRows(d) {
    const lines = Array.isArray(d.lines) ? d.lines : [];
    const adjByCode = new Map();
    (Array.isArray(d.adjustments) ? d.adjustments : []).forEach(a => {
      if (!adjByCode.has(a.code)) adjByCode.set(a.code, []);
      adjByCode.get(a.code).push(a);
    });
    const verByCode = new Map();
    (Array.isArray(d.versions) ? d.versions : []).forEach(v => {
      if (!verByCode.has(v.code)) verByCode.set(v.code, []);
      verByCode.get(v.code).push(v);
    });
    const out = [];
    lines.forEach(l => {
      const adjs = (adjByCode.get(l.code) || []).slice().sort((a, b) => Number(b.id) - Number(a.id));
      const vers = (verByCode.get(l.code) || []).slice().sort((a, b) => Number(a.revision) - Number(b.revision));
      const curDiff = (l.diff_qty === null || l.diff_qty === undefined) ? 0 : Number(l.diff_qty);
      const everDiff = vers.some(v => Number(v.diff_before) !== 0 || Number(v.diff_after) !== 0);
      if (curDiff === 0 && !adjs.length && !everDiff) return;
      const active = adjs.find(a => a.status === 'active') || null;
      const any = adjs[0] || null;
      const latest = active || any;
      out.push({
        line: l, versions: vers, active, any,
        adjQty: latest ? Number(latest.qty) : null,
        status: active ? 'active' : (any ? 'voided' : 'none'),
      });
    });
    return out;
  },

  // 调整记录（精简列）：编码/名称、调整数量、调整状态
  // 更正历史收在行下的折叠区，不与调整行同层；「▸ + 记录数」内联在名称行内，不额外占行
  stRenderRelated(d) {
    const box = document.getElementById('st-dpanel');
    if (!box) return;
    const rows = this.stAdjRows(d);
    if (!rows.length) {
      box.innerHTML = `<div class="pu-empty">${this.t('st_adj_empty')}</div>`;
      return;
    }
    const stMap = {
      active: [this.t('st_adj_status_active'), 'badge-success'],
      voided: [this.t('st_adj_status_voided'), 'badge-muted'],
      none: [this.t('st_adj_status_none'), 'badge-warning'],
    };
    const body = rows.map(r => {
      const l = r.line;
      const adjQtyTxt = r.adjQty === null ? '–' : `${r.adjQty > 0 ? '+' : ''}${this.fmtQty(r.adjQty)}`;
      const qtyCls = (r.adjQty === null || r.status === 'voided')
        ? 'pu-mu' : (r.adjQty > 0 ? 'num-pos' : 'num-neg');
      const [stTxt, stCls] = stMap[r.status];
      const hasHist = r.versions.length > 0;
      return `<div class="st-adj-row${hasHist ? ' st-adj-row--openable' : ''}"${hasHist ? ' onclick="App.stAdjToggle(this)"' : ''}>
        <div class="st-adj-c-material"><span class="st-adj-caret" aria-hidden="true">▸</span><strong>${this.docEsc(l.code)}</strong><span class="st-adj-name pu-mu" title="${this.docEsc(l.material_name || '')}">${this.docEsc(l.material_name || '')}</span>${
          hasHist ? `<span class="st-adj-badge" title="${this.t('st_versions')} (${r.versions.length})">${r.versions.length}</span>` : ''
        }</div>
        <div class="st-adj-c-qty text-right"><span class="${qtyCls}" style="font-weight:600">${adjQtyTxt}</span></div>
        <div class="st-adj-c-status text-center"><span class="badge ${stCls}">${stTxt}</span></div>
        ${hasHist ? `<div class="st-adj-hist" hidden>${this.stVersionsInline(r.versions)}</div>` : ''}
      </div>`;
    }).join('');
    box.innerHTML = `<div class="table-wrap"><div class="st-adj-grid">
      <div class="st-adj-head">
        <div class="st-adj-c-material"><span class="st-adj-caret" aria-hidden="true">▸</span>${this.t('mat_code')} / ${this.t('mat_name')}</div>
        <div class="st-adj-c-qty text-right">${this.t('st_adj_qty')}</div>
        <div class="st-adj-c-status text-center">${this.t('st_adj_status')}</div>
      </div>
      ${body}</div></div>`;
  },

  // 点击整行展开/收起该行的更正记录；无记录行不绑定
  stAdjToggle(el) {
    if (!el) return;
    const hist = el.querySelector('.st-adj-hist');
    if (!hist) return;
    const open = el.classList.toggle('open');
    hist.hidden = !open;
  },

  // 更正历史（次级信息，默认折叠）：谁、何时、旧实盘/差异 → 新实盘/差异
  stVersionsInline(versions) {
    const f = v => (v === null || v === undefined) ? '–' : this.fmtQty(v);
    const fd = v => (v === null || v === undefined) ? '–' : ((Number(v) > 0 ? '+' : '') + this.fmtQty(v));
    const items = versions.map(v => {
      const initial = v.qty_before === null || v.qty_before === undefined;
      return `<li>
        <span class="st-ver-rev">${this.t('st_version_rev', { n: v.revision })}</span>
        ${initial ? `<span class="pu-mu">${this.t('st_version_initial')}</span>` : ''}
        <span class="st-ver-flow">${this.t('st_version_qty', { before: f(v.qty_before), after: f(v.qty_after) })}</span>
        <span class="st-ver-flow">${this.t('st_version_diff', { before: fd(v.diff_before), after: fd(v.diff_after) })}</span>
        <span class="pu-mu">${this.docEsc(v.operator || '')}${v.operator ? ' · ' : ''}${this.fmtDateTime(v.created_at)}</span>
      </li>`;
    }).join('');
    return `<ul class="st-ver-list">${items}</ul>`;
  },

  // ========== 操作日志（ol.pu-log：动作加粗 + 操作人 + 时间 + 详情行） ==========
  stLogLabel(action) {
    const m = {
      create: this.t('audit_act_create'),
      // 历史数据里仍有 action='load' 的记录：统一显示为「生成明细」，不再露出旧入口文案
      load: this.t('st_log_generated'),
      save: this.t('audit_act_update'),
      add: this.t('audit_act_update'),
      remove: this.t('audit_act_delete'),
      confirm: this.t('audit_act_confirm'),
      correct: this.t('st_correct_line'),
    };
    return m[action] || this.auditActionLabel(action);
  },

  stLogsPanel(logs) {
    if (!logs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    return `<ol class="pu-log">` + logs.map(l => {
      const detail = this.logDetailText(l);
      return `<li>
      <div>
        <strong>${this.docEsc(this.stLogLabel(l.action))}</strong>
        <span class="pu-log-meta">· ${this.docEsc(l.operator || '')} · ${this.fmtDateTime(l.created_at)}</span>
        ${detail ? `<div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere">${this.docEsc(detail)}</div>` : ''}
      </div>
    </li>`;
    }).join('') + `</ol>`;
  },

  // ========== 事件委托 ==========
  stBindEvents() {
    if (this._stBound) return;
    this._stBound = true;

    document.addEventListener('click', e => {
      if (this.currentPage !== 'stocktake') return;
      const el = e.target.closest('[data-st]');
      if (el) { e.preventDefault(); this.stAction(el.dataset.st, el.dataset.id, el); return; }
      const row = e.target.closest('#st-root tr[data-ra]');
      if (row && !String(window.getSelection())) this.stAction('open', row.dataset.id, row);
    });

    // 点击详情卡片以外的区域（含左侧菜单栏）→ 自动收起详情栏
    document.addEventListener('click', e => {
      const s = this.stState();
      if (!s.sel) return;
      const insp = document.getElementById('st-insp');
      if (!insp || insp.hidden) return;
      if (e.target.closest('#st-insp, #st-root tr[data-ra], [data-st], #modal-overlay, #confirm-overlay, .pu-ov, .toast')) return;
      this.stCloseInspector();
    }, true);

    document.addEventListener('input', e => {
      if (this.currentPage !== 'stocktake') return;
      const s = this.stState();
      if (e.target.id === 'st_f_kw') {
        s.f.kw = e.target.value;
        clearTimeout(this._stFilterTimer);
        this._stFilterTimer = setTimeout(() => { this.getTableState('stocktake').page = 1; this.stRenderList(); }, 250);
      } else if (e.target.id === 'st_lqi') {
        s.lq = e.target.value;
        // 组词过程中不重绘：重绘会重建输入框，导致中文输入法组词被打断
        if (e.isComposing || this._stLqComposing) return;
        this.stRenderLinesBody(); this.stFocusEnd('st_lqi');
      }
    });

    document.addEventListener('compositionstart', e => {
      if (e.target.id === 'st_lqi') this._stLqComposing = true;
    });
    document.addEventListener('compositionend', e => {
      if (e.target.id !== 'st_lqi') return;
      this._stLqComposing = false;
      if (this.currentPage !== 'stocktake') return;
      this.stState().lq = e.target.value;
      this.stRenderLinesBody(); this.stFocusEnd('st_lqi');
    });

    document.addEventListener('change', e => {
      if (this.currentPage !== 'stocktake') return;
      const s = this.stState();
      const st = this.getTableState('stocktake');
      if (e.target.id === 'st_f_from') { s.f.from = e.target.value; st.page = 1; this.stRenderList(); }
      else if (e.target.id === 'st_f_to') { s.f.to = e.target.value; st.page = 1; this.stRenderList(); }
      else if (e.target.id === 'st-psz') { st.pageSize = this.normalizePageSize(e.target.value); st.page = 1; this.stRenderList(); }
    });

    document.addEventListener('keydown', e => {
      if (this.currentPage !== 'stocktake') return;
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === '/' && !inField && document.getElementById('st_f_kw')) { e.preventDefault(); document.getElementById('st_f_kw').focus(); return; }
      if (e.key === 'Escape') {
        if (document.getElementById('modal-overlay')) { this.closeModal(); return; }
        if (this.stState().sel) this.stCloseInspector();
      }
    });

    window.addEventListener('resize', () => {
      if (this.currentPage === 'stocktake') this.pinPager('st-pager');
    });
  },

  stFocusEnd(id) {
    const el = document.getElementById(id);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (_) {} }
  },

  stAction(name, id, el) {
    const s = this.stState();
    switch (name) {
      case 'tab': s.tab = id; s.kpi = ''; this.getTableState('stocktake').page = 1; this.stRenderTabs(); this.stRenderList(); return;
      case 'open': return this.stOpen(id);
      case 'icl': return this.stCloseInspector();
      case 'wide': s.wide = !s.wide; this.stRenderInspector(); return;
      case 'dt': s.dt = id; this.stRenderInspector(); return;
      case 'kpi': s.kpi = s.kpi === id ? '' : id; this.getTableState('stocktake').page = 1; this.stRenderList(); return;
      case 'clr': s.f = { kw: '', from: '', to: '' }; s.kpi = ''; this.getTableState('stocktake').page = 1; this.stRenderFilters(); this.stRenderList(); return;
      case 'dense': s.dense = !s.dense; document.getElementById('st-root').classList.toggle('st-dense', s.dense); if (el) el.setAttribute('aria-pressed', String(s.dense)); return;
      case 'pg': this.getTableState('stocktake').page += Number(id); this.stRenderList(); return;
      case 'ex': { const k = String(id); if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k); this.stRenderLinesBody(); return; }
      case 'new': return this.newStocktake();
      case 'only-un': s.onlyUn = !s.onlyUn; this.stRenderInspector(); return;
      case 'zero': return this.stBulkZero();
      case 'e-doc': return this.editStocktake(s.sel);
      case 'confirm': return this.confirmStocktake();
      case 'del': return this.deleteStocktake(s.sel);
      case 'print': return this.stPrintDoc();
    }
  },

  // 打印盘点表：复用 printDoc，按当前数据全量输出（含未盘 / 零差异行），实盘为空留白供现场手填
  stPrintDoc() {
    const s = this.stState();
    const rec = this._stCache[s.sel];
    if (!rec || !rec.d) { this.toast(this.t('requestFailed'), 'error'); return; }
    const d = rec.d;
    const lines = d.lines || [];
    const num = v => (v === null || v === undefined || v === '') ? '' : this.fmtQty(Number(v));
    const counted = r => r.count_qty !== null && r.count_qty !== undefined && r.count_qty !== '';
    const rows = lines.map((l, i) => ({ ...l, __seq: i + 1 }));
    const cols = [
      { label: this.t('st_print_seq'), value: r => String(r.__seq) },
      { label: this.t('mat_code'), value: r => r.code || '' },
      { label: this.t('mat_name'), value: r => r.material_name || '' },
      { label: this.t('mat_spec'), value: r => r.material_spec || '' },
      { label: this.t('mat_brand'), value: r => r.material_brand || '' },
      { label: this.t('mat_unit'), value: r => r.material_unit || '' },
      { label: this.t('st_book_qty'), align: 'right', value: r => num(r.book_qty) },
      { label: this.t('st_count_qty'), align: 'right', value: r => num(r.count_qty) },
      { label: this.t('st_diff_qty'), align: 'right', value: r => {
          if (!counted(r)) return '';
          const diff = Number.isFinite(Number(r.diff_qty)) ? Number(r.diff_qty) : (Number(r.count_qty) - (Number(r.book_qty) || 0));
          return (diff > 0 ? '+' : '') + this.fmtQty(diff);
        } },
    ];
    const meta = [
      [this.t('st_no'), d.stocktake_no || ''],
      [this.t('adj_date'), this.fmtDate(d.date) || ''],
      [this.t('st_scope'), this.stScopeLabel(d)],
      [this.t('st_status'), this.stStatusBadge(d.status).replace(/<[^>]+>/g, '')],
      [this.t('st_handler'), d.handler || ''],
      [this.t('st_remark'), d.remarks || ''],
    ];
    this.printDoc({
      title: d.stocktake_no,
      subtitle: this.t('st_title'),
      meta, columns: cols, rows,
      signatures: [this.t('st_handler'), this.t('st_print_sign_reviewer'), this.t('adj_date')],
    });
  },

  // 批量把未盘行的实盘数量填 0（带二次确认，写库后刷新详情）
  stBulkZero() {
    if (!this.can('stocktake', 'manage')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const no = this.stState().sel;
    if (!no) return;
    const rec = this._stCache[no];
    const d = rec && rec.d;
    if (!d) return;
    const rows = (d.lines || []).filter(l => l.count_qty === null || l.count_qty === undefined);
    if (!rows.length) { this.toast(this.t('st_all_counted')); return; }
    this.confirmDialog(this.t('st_bulk_zero'), this.t('st_bulk_zero_hint', { n: rows.length }), async () => {
      try {
        await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'PUT',
          { lines: rows.map(l => ({ id: l.id, count_qty: 0 })) });
        this.toast(this.t('st_bulk_zero_ok', { n: rows.length }));
        await this.stOpen(no);
      } catch (e) {
        this.toast(e.message, 'error');
      }
    }, null, 'primary');
  },

  // ========== 新建盘点单：弹窗内选范围（全盘 / 按类别 / 按物料盘点），创建即生成明细并直接进入录入态 ==========
  async newStocktake() {
    if (!this.can('stocktake', 'manage')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const date = this.today();
    let no = '';
    try {
      const next = await this.api('/api/stocktakes/next-no?date=' + date);
      no = next.stocktake_no;
    } catch (e) { /* 单号预览失败不阻断 */ }

    this._stNew = {
      scope: 'all',
      categories: [],
      catKeyword: '',
      // 按物料盘点：即时搜索 + 点击候选加入已选列表，按加入顺序生成明细
      matRows: [],
      matCategory: '',
    };
    this._stNewCats = (this.params?.categories || []).map(c => c.name).filter(Boolean);
    this._stNewMats = null; // 全量候选，打开弹窗时异步加载
    this.loadStNewMats();

    this.showModal(
      `<h3>${this.t('st_add')}</h3>`,
      `<div class="ui-note ui-note--info">${this.t('st_create_hint')}</div>
      <div class="form-grid" style="max-width:none">
        <div class="form-group"><label>${this.t('st_no')}</label><input value="${this.docEsc(no)}" readonly></div>
        <div class="form-group"><label>${this.t('adj_date')} *</label><input id="st_f_date" type="date" value="${date}" oninput="App.clearFieldError('st_f_date')"><div class="form-error" id="st_f_date_error"></div></div>
        <div class="form-group"><label>${this.t('st_handler')}</label><input id="st_f_handler" value="${this.docEsc(this.user?.name || this.user?.username || '')}"></div>
        <div class="form-group u-full"><label>${this.t('st_remark')}</label><input id="st_f_remarks" placeholder="${this.t('st_remark')}"></div>
      </div>
      <div class="st-load-tabs" id="st-new-tabs" role="tablist" aria-label="${this.t('st_new_scope')}">
        <span class="st-load-tab active" role="tab" data-mode="all" onclick="App.switchStNewScope('all')">${this.t('st_scope_mode_all')}</span>
        <span class="st-load-tab" role="tab" data-mode="category" onclick="App.switchStNewScope('category')">${this.t('st_scope_mode_category')}</span>
        <span class="st-load-tab" role="tab" data-mode="specified" onclick="App.switchStNewScope('specified')">${this.t('st_scope_mode_specified')}</span>
      </div>
      <div id="st-new-panel" class="st-load-panel"></div>`,
      this.t('st_create_go'), () => this.createStocktake(), null, true, { fit: true });

    this.renderStNewPanel();
  },

  switchStNewScope(mode) {
    if (!this._stNew) return;
    this.msClose();
    this._stNew.scope = mode;
    document.querySelectorAll('#st-new-tabs .st-load-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.mode === mode);
      el.setAttribute('aria-selected', String(el.dataset.mode === mode));
    });
    this.renderStNewPanel();
  },

  renderStNewPanel() {
    const box = document.getElementById('st-new-panel');
    const s = this._stNew;
    if (!box || !s) return;
    if (s.scope === 'all') {
      box.innerHTML = `<div class="ui-note ui-note--info">${this.t('st_scope_mode_all_hint')}</div>
        <div class="st-load-stat" id="st-new-stat"></div>`;
      this.refreshStNewStat();
      return;
    }
    if (s.scope === 'category') {
      box.innerHTML = `<div class="ui-note ui-note--info">${this.t('st_scope_mode_category_hint')}</div>
        <input id="st-new-cat-kw" type="text" class="st-load-search" placeholder="${this.t('st_cat_filter')}" value="${this.docEsc(s.catKeyword || '')}"
          oninput="App._stNew.catKeyword=this.value;App.renderStNewCats()">
        <div class="st-load-cat-list" id="st-new-cat-list"></div>
        <div class="st-load-stat" id="st-new-stat"></div>`;
      this.renderStNewCats();
      this.refreshStNewStat();
      return;
    }
    // 按物料盘点：即时搜索 + 点击候选加入已选列表（与采购明细编辑页同一套候选项交互）
    const mats = this._stNewMats || [];
    const cats = [...new Set(mats.map(m => m.category).filter(Boolean))];
    box.innerHTML = `<div class="ui-note ui-note--info">${this.t('st_scope_mode_specified_hint')}</div>
      <div class="st-new-mat-filter">
        <select id="st-new-mat-cat" onchange="App._stNew.matCategory=this.value;App.msClose()">
          <option value="">${this.t('st_all_categories')}</option>
          ${cats.map(c => `<option value="${this.docEsc(c)}"${s.matCategory === c ? ' selected' : ''}>${this.docEsc(c)}</option>`).join('')}
        </select>
        <span class="pu-msearch-host st-new-mat-search">
          <input id="st-new-mat-kw" type="search" value="" placeholder="${this.t('st_pick_search_ph')}"
            aria-label="${this.t('st_pick_search_ph')}"
            oninput="App.stNewMatKwInput(this)" onfocus="App.stNewMsOpen(this)" onblur="App.msBlur()"
            onkeydown="App.msKey(event)" oncompositionstart="App.msCompositionStart()" oncompositionend="App.msCompositionEnd(this)">
        </span>
        <span class="st-load-stat" id="st-new-mat-stat"></span>
      </div>
      <div class="st-new-rows" id="st-new-mat-rows"></div>`;
    this.renderStNewMatRows();
  },

  renderStNewCats() {
    const box = document.getElementById('st-new-cat-list');
    const s = this._stNew;
    if (!box || !s) return;
    const cats = (this._stNewCats || []).filter(c => this.matchKeywords([c], s.catKeyword));
    if (!cats.length) { box.innerHTML = `<div class="pu-empty">${this.t('noData')}</div>`; return; }
    box.innerHTML = cats.map(c => {
      // 分类名作为 onclick 字符串参数：先 JSON 字符串化，再做 HTML 属性转义
      const catArg = this.docEsc(JSON.stringify(String(c == null ? '' : c)));
      return `<label class="st-load-cat-item"><input type="checkbox" ${s.categories.includes(c) ? 'checked' : ''}
      onchange="App.toggleStNewCat(${catArg})"><span>${this.docEsc(c)}</span></label>`;
    }).join('');
  },

  toggleStNewCat(cat) {
    const s = this._stNew;
    if (!s) return;
    const i = s.categories.indexOf(cat);
    if (i >= 0) s.categories.splice(i, 1); else s.categories.push(cat);
    this.refreshStNewStat();
  },

  // ---- 按物料盘点 / 追加物料：共用「即时搜索 + 点击候选加入」组件（与采购、入库明细录入同一套候选面板） ----
  async loadStNewMats() {
    try {
      const list = await this.api('/api/stocktakes/candidates?scope=specified');
      this._stNewMats = Array.isArray(list) ? list : [];
    } catch (e) {
      this._stNewMats = [];
    }
    if (this._stNew && this._stNew.scope === 'specified') this.renderStNewPanel();
    // 追加物料弹窗打开时同步刷新已选列表（候选刚加载完成）
    else if (this._stAdd && document.getElementById('st-add-selected')) this.renderStocktakeAddSelected();
  },

  // 共用入口：候选取数、类别过滤、已添加标记与点击回调由调用方给出
  stMatMsOpen(el, cfg) {
    if (this._msSuppressFocus) return;
    this.msOpen(el, {
      mode: 'materials',
      rows: () => this._stNewMats || [],
      category: cfg.category || (() => ''),
      // msStockOf 传入的是编码，不是整行；这里回查候选缓存拿账面数量
      stockOf: code => {
        const hit = (this._stNewMats || []).find(m => m.code === code);
        return hit ? hit.book_qty : null;
      },
      isAdded: cfg.isAdded,
      onPick: m => cfg.onPick(m),
    });
  },

  stMatMsInput(el, openFn) {
    if (!this._ms || this._ms.input !== el) openFn.call(this, el);
    else this.msInput(el);
  },

  // 新建盘点弹窗：按物料盘点搜索入口
  stNewMsOpen(el) {
    const s = this._stNew;
    if (!s) return;
    this.stMatMsOpen(el, {
      category: () => s.matCategory || '',
      isAdded: m => (s.matRows || []).includes(m.code),
      onPick: m => this.stNewPickMat(m),
    });
  },

  stNewMatKwInput(el) {
    this.stMatMsInput(el, this.stNewMsOpen);
  },

  stNewPickMat(m) {
    const s = this._stNew;
    if (!s || !m) return;
    if ((s.matRows || []).includes(m.code)) {
      this.toast(this.t('st_dup_material'), 'error');
      return;
    }
    s.matRows.push(m.code);
    this.renderStNewMatRows();
  },

  // 行文案：编码 · 名称 规格 · 品牌
  stMatLineText(m) {
    const base = `${m.code} · ${m.name || ''}${m.spec ? ' ' + m.spec : ''}`.trim();
    return m.brand ? `${base} · ${m.brand}` : base;
  },

  // 已选列表（新建弹窗与追加弹窗共用）：# / 物料 / 账面数量 / 单位 / 操作
  stSelectedTable(codes, removeFn) {
    const mats = this._stNewMats || [];
    const rows = codes.map((code, i) => {
      const m = mats.find(x => x.code === code) || { code };
      return `<tr>
        <td class="text-center">${i + 1}</td>
        <td>${this.docEsc(this.stMatLineText(m))}</td>
        <td class="text-right">${m.book_qty === undefined ? '-' : this.fmtQty(m.book_qty)}</td>
        <td>${this.docEsc(m.unit || '') || '-'}</td>
        <td class="text-center"><button type="button" class="btn btn-outline btn-xs" onclick="App.${removeFn}(${i})">${this.t('in_remove_row')}</button></td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="st-new-mat-table"><thead><tr>
      <th class="text-center" style="width:40px">#</th><th>${this.t('st_col_material')}</th>
      <th class="text-right">${this.t('st_book_qty')}</th><th>${this.t('mat_unit')}</th>
      <th style="width:72px">${this.t('st_row_action')}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  renderStNewMatRows() {
    const box = document.getElementById('st-new-mat-rows');
    const s = this._stNew;
    if (!box || !s) return;
    if (this._stNewMats === null) {
      box.innerHTML = `<div class="pu-empty">${this.t('ms_loading')}</div>`;
      return;
    }
    const codes = s.matRows || [];
    box.innerHTML = codes.length
      ? this.stSelectedTable(codes, 'stNewRemoveMatRow')
      : `<div class="pu-empty">${this.t('st_pick_none_selected')}</div>`;
    const stat = document.getElementById('st-new-mat-stat');
    if (stat) stat.textContent = this.t('st_pick_selected', { n: codes.length });
  },

  stNewRemoveMatRow(i) {
    const s = this._stNew;
    if (!s) return;
    s.matRows.splice(i, 1);
    this.renderStNewMatRows();
  },

  async refreshStNewStat() {
    const s = this._stNew;
    if (!s) return;
    let url = '';
    if (s.scope === 'all') url = '/api/stocktakes/candidates?scope=all';
    else if (s.scope === 'category') {
      if (!s.categories.length) {
        const el = document.getElementById('st-new-stat'); if (el) el.textContent = '';
        return;
      }
      url = '/api/stocktakes/candidates?scope=category&category=' + encodeURIComponent(s.categories.join(','));
    } else return;
    const seq = (this._stNewSeq = (this._stNewSeq || 0) + 1);
    try {
      const list = await this.api(url);
      if (seq !== this._stNewSeq) return; // 丢弃过期响应，避免类别勾选后数字回跳
      const el = document.getElementById('st-new-stat');
      if (el) el.textContent = this.t('st_scope_stat', { n: Array.isArray(list) ? list.length : 0 });
    } catch (e) { /* 统计失败不阻断建单 */ }
  },

  async createStocktake() {
    if (!this.validateForm({ st_f_date: [{ rule: 'required' }] })) return;
    const s = this._stNew || { scope: 'all', categories: [], codes: [] };
    if (s.scope === 'category' && !s.categories.length) {
      this.toast(this.t('st_need_category'), 'error');
      return;
    }
    // 按物料盘点：已选列表顺序即明细行顺序；未选时提示
    const matCodes = s.scope === 'specified' ? (s.matRows || []).slice() : [];
    if (s.scope === 'specified' && !matCodes.length) {
      this.toast(this.t('st_need_material'), 'error');
      return;
    }
    if (s.scope === 'specified' && new Set(matCodes).size !== matCodes.length) {
      this.toast(this.t('st_dup_material'), 'error');
      return;
    }
    const body = {
      date: document.getElementById('st_f_date').value,
      handler: document.getElementById('st_f_handler').value.trim(),
      remarks: document.getElementById('st_f_remarks').value.trim(),
      scope: s.scope,
    };
    if (s.scope === 'category') body.categories = s.categories.slice();
    if (s.scope === 'specified') body.codes = matCodes;

    let created;
    try {
      // 建单与生成明细由后端在同一事务内完成，前端只发一次请求
      created = await this.api('/api/stocktakes', 'POST', body);
    } catch (e) {
      this.toast(e.message, 'error');
      return;
    }

    this.closeModal();
    const n = Number(created.loaded_count) || 0;
    this.toast(n ? this.t('st_create_loaded', { n }) : this.t('st_created'));
    await this.editStocktake(created.stocktake_no);
  },

  // ========== 录入实盘 / 编辑草稿：独立页面（01 单据信息 + 02 盘点明细 + 底部操作行） ==========
  async editStocktake(no) {
    if (!this.can('stocktake', 'manage')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    no = no || this._stNo;
    if (!no) return;
    let d;
    try { d = await this.api('/api/stocktakes/' + encodeURIComponent(no)); }
    catch (e) { this.toast(e.message, 'error'); return; }
    this._stNo = no;
    this._stDetail = d;
    this._stCache[no] = { d };
    this._stEditLines = this.stMapEditLines(d);

    this.setMain(this.pageWrap(this.icon('edit', 'icon--title') + ' ' + this.t('st_edit_title'),
      `${d.stocktake_no} · ${this.t('st_scope')} ${this.stScopeLabel(d)}`, '',
      `<div id="st-edit-root" class="data-page">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.openStocktake('${this.docEsc(d.stocktake_no)}')">← ${this.t('st_back_detail')}</span>
          ${this.stStatusBadge(d.status)}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('st_sec_info')}<small>${this.t('st_head_locked')}</small></div></div>
          <div class="form-grid" style="max-width:none">
            <div class="form-group"><label>${this.t('st_no')}</label><input value="${this.docEsc(d.stocktake_no)}" readonly></div>
            <div class="form-group"><label>${this.t('adj_date')}</label><input value="${this.fmtDate(d.date)}" readonly></div>
            <div class="form-group"><label>${this.t('st_handler')}</label><input value="${this.docEsc(d.handler || '')}" readonly></div>
            <div class="form-group"><label>${this.t('st_scope')}</label><input value="${this.docEsc(this.stScopeLabel(d))}" readonly></div>
            <div class="form-group u-full"><label>${this.t('st_remark')}</label><input value="${this.docEsc(d.remarks || '')}" readonly></div>
          </div>
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>02</span><div>${this.t('st_tab_lines')}<small id="st-edit-line-count"></small></div></div>
          <div id="st-edit-lines"></div>
        </div>
        <div class="pu-edit-actions" id="st-edit-buttons"></div>
      </div>`));

    this.renderStocktakeEdit();
  },

  // 详情 → 编辑页行模型（保存草稿后原地重建时复用，保持同一口径）
  stMapEditLines(d) {
    return ((d && d.lines) || []).map(l => ({
      id: l.id, code: l.code, material_name: l.material_name, material_spec: l.material_spec,
      material_brand: l.material_brand, material_unit: l.material_unit,
      book_qty: Number(l.book_qty) || 0,
      count_qty: (l.count_qty === null || l.count_qty === undefined) ? '' : l.count_qty,
      status: l.status, remarks: l.remarks || '',
    }));
  },

  renderStocktakeEdit() {
    const d = this._stDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const lines = this._stEditLines || [];

    const cntEl = document.getElementById('st-edit-line-count');
    if (cntEl) cntEl.textContent = this.t('st_line_count', { n: lines.length });

    // 底部操作行（与入库编辑页一致：添加物料 → 保存草稿 → 确认，确认固定最右）
    const btnBox = document.getElementById('st-edit-buttons');
    if (btnBox) {
      const btns = [];
      if (this.can('stocktake', 'manage')) {
        btns.push(`<button class="btn btn-outline" onclick="App.openStocktakeAddLinesModal()">+ ${this.t('st_add_line')}</button>`);
        btns.push(`<button class="btn btn-outline" onclick="App.saveStocktakeCounts()">${this.t('st_save_count')}</button>`);
      }
      if (this.can('stocktake', 'post')) {
        btns.push(`<button class="btn btn-primary" onclick="App.stConfirmFromEdit()">${this.t('st_confirm')}</button>`);
      }
      btnBox.innerHTML = isDraft
        ? (btns.join('') || `<div class="pu-empty" style="margin:0">${this.t('no_perm_msg')}</div>`)
        : `<div class="pu-empty" style="margin:0">${this.t('st_confirmed_at')}：${this.fmtDateTime(d.confirmed_at) || '–'}</div>`;
    }

    const box = document.getElementById('st-edit-lines');
    if (!box) return;
    if (!lines.length) {
      box.innerHTML = `<div class="pu-empty">${this.t('st_empty_lines')}
        <div style="margin-top:8px;font-size:12px">${this.t('st_empty_lines_hint')}</div></div>`;
      return;
    }

    const head = `<tr>
      <th>${this.t('mat_code')}</th>
      <th>${this.t('mat_name')}</th>
      <th>${this.t('mat_spec')}</th>
      <th>${this.t('mat_unit')}</th>
      <th class="text-right">${this.t('st_book_qty')}</th>
      <th class="text-right">${this.t('st_count_qty')}</th>
      <th class="text-right">${this.t('st_diff_qty')}</th>
      <th class="text-center">${this.t('st_status_label')}</th>
      <th>${this.t('st_remark')}</th>
      <th class="text-center"></th>
    </tr>`;

    const body = lines.map(l => {
      const hasCount = l.count_qty !== '' && l.count_qty !== null && l.count_qty !== undefined;
      const diff = hasCount ? Math.round((Number(l.count_qty) - l.book_qty) * 10000) / 10000 : null;
      const cntCell = isDraft
        ? `<input type="number" step="0.01" class="st-count-input" data-id="${l.id}" data-book="${l.book_qty}" value="${this.docEsc(l.count_qty)}" placeholder="${this.t('st_input_count')}" oninput="App.stEditCountInput(${l.id}, this)">`
        : (hasCount ? this.qtyCell(l.count_qty) : '–');
      return `<tr>
        <td>${this.docEsc(l.code)}</td>
        <td>${this.docEsc(l.material_name || '')}</td>
        <td>${this.docEsc(l.material_spec || '')}</td>
        <td>${this.docEsc(l.material_unit || '')}</td>
        <td class="pu-edit-amt">${this.qtyCell(l.book_qty)}</td>
        <td class="text-right">${cntCell}</td>
        <td class="pu-edit-amt" id="st-diff-${l.id}">${this.stDiffCell(diff)}</td>
        <td class="text-center" id="st-lstatus-${l.id}">${this.stLineStatusBadge(l.status)}</td>
        <td>${this.docEsc(l.remarks || '')}</td>
        <td class="text-center">${isDraft ? `<button type="button" class="pu-edit-del" onclick="App.removeStocktakeLine(${l.id})">${this.t('st_remove_line')}</button>` : ''}</td>
      </tr>`;
    }).join('');

    box.innerHTML = `<div class="table-wrap pu-edit-lines"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  },

  stDiffCell(diff) {
    if (diff === null || diff === undefined) return '<span class="pu-mu">–</span>';
    const cls = diff > 0 ? 'num-pos' : (diff < 0 ? 'num-neg' : '');
    return `<span class="${cls}" style="font-weight:600">${diff > 0 ? '+' : ''}${this.fmtQty(diff)}</span>`;
  },

  // 实盘输入即时重算差异 + 行状态（只更新当前行的差异/状态单元格，不重建页面，避免打断输入法）
  stEditCountInput(id, el) {
    const l = (this._stEditLines || []).find(x => Number(x.id) === Number(id));
    if (!l) return;
    const raw = String(el.value || '').trim();
    l.count_qty = raw === '' ? '' : (parseFloat(raw) || 0);
    const cell = document.getElementById('st-diff-' + id);
    if (cell) cell.innerHTML = this.stDiffCell(raw === '' ? null : Math.round((Number(l.count_qty) - l.book_qty) * 10000) / 10000);
    // 行状态即时反馈：非空 → 已录入但未保存；清空 → 回到保存前的状态
    const stCell = document.getElementById('st-lstatus-' + id);
    if (stCell) {
      stCell.innerHTML = raw === ''
        ? this.stLineStatusBadge(l.status)
        : `<span class="badge badge-warning">${this.t('st_line_unsaved')}</span>`;
    }
  },

  // 返回列表页并打开该单详情（从编辑页 / 弹窗返回）
  async openStocktake(no) {
    this.stState().sel = no || null;
    // 跨模块跳转时由 renderStocktake 负责切页签、清筛选并定位该行
    this._stRevealDoc = no || null;
    await this.gotoPage('stocktake');
  },

  // 按单据真实状态把行定位到列表：切对应页签 → 必要时清掉挡住该行的筛选 → 翻到该行所在页
  stRevealDoc(no) {
    const row = (this._stList || []).find(r => r.stocktake_no === no);
    if (!row) return false;
    const s = this.stState();
    const want = row.status || '';
    s.tab = this.stTabDefs().some(d => d[0] === want) ? want : '';
    if (!this.stVisibleRows().some(r => r.stocktake_no === no)) {
      s.f = { kw: '', from: '', to: '' };
      s.kpi = '';
      this.stRenderFilters();
    }
    const st = this.getTableState('stocktake');
    st.page = 1;
    const rows = this.sortData(this.stVisibleRows(), st.sortKey, st.sortDir);
    const idx = rows.findIndex(r => r.stocktake_no === no);
    if (idx >= 0) st.page = Math.floor(idx / st.pageSize) + 1;
    this.stRenderTabs();
    this.stRenderList();
    return true;
  },

  // ========== 保存实盘 ==========

  // 收集编辑页的实盘输入：留空表示「未盘」，一并提交以便清空已录数据
  stCollectCounts() {
    const inputs = Array.from(document.querySelectorAll('.st-count-input'));
    const lines = [];
    inputs.forEach(inp => {
      const raw = String(inp.value || '').trim();
      const n = parseFloat(raw);
      lines.push({ id: Number(inp.dataset.id), count_qty: (raw === '' || isNaN(n)) ? null : n });
    });
    return lines;
  },

  async saveStocktakeCounts() {
    if (!this.can('stocktake', 'manage')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const no = this._stNo;
    if (!no) return;
    const lines = this.stCollectCounts();
    if (!lines.length) {
      // 0 行明细：没有可保存的内容，保持空单原样并提示已保存
      if (!(this._stEditLines || []).length) { this.toast(this.t('st_save_ok')); return; }
      this.toast(this.t('st_input_count_hint'), 'error');
      return;
    }
    try {
      await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'PUT', { lines });
      // 留在当前编辑页：重新拉详情并以最新状态原地重绘（不跳回列表）
      try {
        const d = await this.api('/api/stocktakes/' + encodeURIComponent(no));
        this._stDetail = d;
        this._stCache[no] = { d };
        this._stEditLines = this.stMapEditLines(d);
        this.renderStocktakeEdit();
      } catch (e) { /* 刷新失败时保留已保存提示 */ }
      this.toast(this.t('st_save_ok'));
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // 编辑页直接确认：先保存本轮录入的实盘，再走与详情栏一致的确认流程
  async stConfirmFromEdit() {
    if (!this.can('stocktake', 'post')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const no = this._stNo;
    if (!no) return;
    const lines = this.stCollectCounts();
    if (lines.length) {
      try {
        await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'PUT', { lines });
      } catch (e) { this.toast(e.message, 'error'); return; }
    }
    try {
      const d = await this.api('/api/stocktakes/' + encodeURIComponent(no));
      this._stDetail = d;
      this._stCache[no] = { d };
    } catch (e) { this.toast(e.message, 'error'); return; }
    this.confirmStocktake();
  },

  fmtQty(v) {
    if (v === null || v === undefined || v === '') return '-';
    const n = Number(v);
    if (isNaN(n)) return String(v);
    return String(Math.round(n * 10000) / 10000);
  },

  // ========== 草稿态：增删物料行 ==========
  // 仅在草稿状态可增删；增行采用「增量追加」，不清空已有行与已录实盘。
  // 账面数量取「加入时刻」的库存快照（与建单生成明细同口径）。

  openStocktakeAddLinesModal() {
    if (!this.can('stocktake', 'manage')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const no = this._stNo;
    if (!no) return;
    const existing = new Set(((this._stDetail && this._stDetail.lines) || []).map(l => l.code));
    this._stAdd = { codes: [], existing };
    // 与新建弹窗共用同一份候选缓存；未加载时补一次
    if (!this._stNewMats) this.loadStNewMats();

    this.showModal(
      `<h3>${this.t('st_add_line')}</h3>`,
      `<div class="ui-note ui-note--info">${this.t('st_add_line_hint')}</div>
      <span class="pu-msearch-host st-new-mat-search">
        <input id="st-add-kw" type="search" value="" placeholder="${this.t('st_pick_search_ph')}"
          aria-label="${this.t('st_pick_search_ph')}"
          oninput="App.stAddMatKwInput(this)" onfocus="App.stAddMsOpen(this)" onblur="App.msBlur()"
          onkeydown="App.msKey(event)" oncompositionstart="App.msCompositionStart()" oncompositionend="App.msCompositionEnd(this)">
      </span>
      <div class="st-new-rows" id="st-add-selected"></div>`,
      this.t('st_add_line_action'), () => this.doStocktakeAddLines(), null, true, { fit: true });

    this.renderStocktakeAddSelected();
  },

  // 追加物料：搜索入口（与新建弹窗的按物料盘点共用 stMatMsOpen）
  stAddMsOpen(el) {
    const s = this._stAdd;
    if (!s) return;
    this.stMatMsOpen(el, {
      isAdded: m => s.existing.has(m.code) || (s.codes || []).includes(m.code),
      onPick: m => this.stAddPick(m),
    });
  },

  stAddMatKwInput(el) {
    this.stMatMsInput(el, this.stAddMsOpen);
  },

  stAddPick(m) {
    const s = this._stAdd;
    if (!s || !m) return;
    if (s.existing.has(m.code)) { this.toast(this.t('st_already_in_doc'), 'error'); return; }
    if ((s.codes || []).includes(m.code)) { this.toast(this.t('st_dup_material'), 'error'); return; }
    s.codes.push(m.code);
    this.renderStocktakeAddSelected();
  },

  renderStocktakeAddSelected() {
    const box = document.getElementById('st-add-selected');
    const s = this._stAdd;
    if (!box || !s) return;
    if (this._stNewMats === null) {
      box.innerHTML = `<div class="pu-empty">${this.t('ms_loading')}</div>`;
      return;
    }
    box.innerHTML = s.codes.length
      ? this.stSelectedTable(s.codes, 'removeStocktakeAddPick')
      : `<div class="pu-empty">${this.t('st_pick_none_selected')}</div>`;
  },

  removeStocktakeAddPick(i) {
    const s = this._stAdd;
    if (!s) return;
    s.codes.splice(i, 1);
    this.renderStocktakeAddSelected();
  },

  async doStocktakeAddLines() {
    const no = this._stNo;
    const s = this._stAdd;
    if (!no || !s) return;
    if (s.codes.length === 0) { this.toast(this.t('st_need_material'), 'error'); return; }
    // 追加物料前保留未保存的实盘，刷新后原样带回
    const pending = this.stCollectCounts();
    try {
      const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'POST', { codes: s.codes });
      this.closeModal();
      // 留在录入页原地追加并重绘：不跳回详情，形成「新建 → 录入 → 追加 → 确认」直线
      try {
        const d = await this.api('/api/stocktakes/' + encodeURIComponent(no));
        this._stDetail = d;
        this._stCache[no] = { d };
        this._stEditLines = this.stMapEditLines(d);
        const typed = new Map(pending.map(p => [p.id, p.count_qty]));
        this._stEditLines.forEach(l => {
          if (typed.has(l.id)) l.count_qty = typed.get(l.id) === null ? '' : typed.get(l.id);
        });
        this.renderStocktakeEdit();
      } catch (e) { /* 刷新失败时至少已追加成功 */ }
      this.toast(this.t('st_add_line_ok', { n: r.added_count }));
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // 移除某一行物料（仅草稿态）：点击即移除，不弹二次确认
  async removeStocktakeLine(id) {
    const no = this._stNo;
    if (!no) return;
    // 先记下其它行已录入但未保存的实盘，重绘后原样带回（被删行自然消失）
    const pending = this.stCollectCounts();
    try {
      await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines/' + id, 'DELETE');
      // 留在编辑页原地重绘：行立即消失，行数与差异同步刷新
      try {
        const d = await this.api('/api/stocktakes/' + encodeURIComponent(no));
        this._stDetail = d;
        this._stCache[no] = { d };
        this._stEditLines = this.stMapEditLines(d);
        const typed = new Map(pending.map(p => [p.id, p.count_qty]));
        this._stEditLines.forEach(l => {
          if (typed.has(l.id)) l.count_qty = typed.get(l.id) === null ? '' : typed.get(l.id);
        });
        this.renderStocktakeEdit();
      } catch (e) { /* 刷新失败时至少已删除成功 */ }
      this.toast(this.t('st_remove_line_ok'));
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // ========== 确认盘点（弹窗内嵌差异小表，可直接改实盘 / 一键更正单行） ==========

  async confirmStocktake() {
    if (!this.can('stocktake', 'post')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const no = this._stNo;
    if (!no) return;
    let d = this._stDetail;
    if (!d || d.stocktake_no !== no) {
      try {
        d = await this.api('/api/stocktakes/' + encodeURIComponent(no));
        this._stDetail = d;
        this._stCache[no] = { d };
      } catch (e) { this.toast(e.message, 'error'); return; }
    }
    const s = d.summary || {};
    const diffs = (d.lines || []).filter(l => l.count_qty !== null && l.count_qty !== undefined
      && Math.round((Number(l.count_qty) - Number(l.book_qty)) * 10000) / 10000 !== 0);

    const rows = diffs.map(l => `<tr data-line="${l.id}">
        <td>${this.docEsc(l.code)}</td>
        <td class="text-right">${this.qtyCell(Number(l.book_qty) || 0)}</td>
        <td class="text-right"><input class="st-cf-count" type="number" step="0.01" data-id="${l.id}" data-book="${l.book_qty}" value="${this.docEsc(l.count_qty)}" oninput="App.stCfDiffInput(${l.id}, this)"></td>
        <td class="text-right" id="st-cf-diff-${l.id}">${this.stDiffCell(Number(l.diff_qty) || 0)}</td>
        <td class="text-center">${this.can('stocktake', 'correct') ? `<button type="button" class="btn btn-outline btn-sm" onclick="App.stCorrectFromConfirm(${l.id}, this)">${this.t('st_correct_line')}</button>` : ''}</td>
      </tr>`).join('');

    const table = diffs.length
      ? `<div class="table-wrap"><table class="st-cf-table"><thead><tr>
          <th>${this.t('mat_code')}</th>
          <th class="text-right">${this.t('st_book_qty')}</th>
          <th class="text-right">${this.t('st_count_qty')}</th>
          <th class="text-right">${this.t('st_diff_qty')}</th>
          <th></th>
        </tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="pu-empty">${this.t('st_confirm_diff_empty')}</div>`;

    this.showModal(
      `<h3>${this.t('st_confirm')}</h3>`,
      `<div class="ui-note ui-note--info">${this.t('st_confirm_hint')}</div>
      <div style="font-size:13px;margin-bottom:8px">${this.t('st_counted')}: ${s.counted_count || 0} · ${this.t('st_diff')}: ${s.diff_count || 0}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${this.t('st_confirm_diff_title')}</div>
      ${table}`,
      this.t('st_confirm'), () => this.stConfirmWithDiffs(no), null, true);
  },

  // 弹窗内实盘输入：即时重算该行差异
  stCfDiffInput(id, el) {
    const raw = String(el.value || '').trim();
    const book = parseFloat(el.dataset.book) || 0;
    const cell = document.getElementById('st-cf-diff-' + id);
    if (!cell) return;
    if (raw === '') { cell.innerHTML = '<span class="pu-mu">–</span>'; return; }
    const n = parseFloat(raw);
    cell.innerHTML = this.stDiffCell(isNaN(n) ? null : Math.round((n - book) * 10000) / 10000);
  },

  // 先保存弹窗里改过的实盘，再按现有确认流程提交
  async stConfirmWithDiffs(no) {
    const lines = [];
    document.querySelectorAll('.st-cf-count').forEach(inp => {
      const raw = String(inp.value || '').trim();
      const n = parseFloat(raw);
      if (raw === '' || isNaN(n)) return;
      lines.push({ id: Number(inp.dataset.id), count_qty: n });
    });
    if (lines.length) {
      try {
        await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'PUT', { lines });
        const d = await this.api('/api/stocktakes/' + encodeURIComponent(no));
        this._stDetail = d;
        this._stCache[no] = { d };
      } catch (e) {
        this.toast(e.message, 'error');
        return;
      }
    }
    this.closeModal();
    this.doConfirmStocktake(no, false);
  },

  // 确认弹窗内「更正此差异」：按该行当前输入值直接生成这一行的调整，不必整单确认
  // 更正结果提示：覆盖式更正后展示「新差异」；相同值重复提交返回 unchanged
  stCorrectToast(r) {
    if (r && r.unchanged) return this.toast(this.t('st_correct_no_change'));
    const q = Number(r && r.adjusted_qty) || 0;
    const txt = (q > 0 ? '+' : '') + this.fmtQty(q);
    this.toast(this.t('st_correct_ok', { qty: txt }));
  },

  async stCorrectFromConfirm(lineId, btn) {
    if (!this.can('stocktake', 'correct')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const no = this._stNo;
    if (!no) return;
    const inp = document.querySelector(`.st-cf-count[data-id="${lineId}"]`);
    const raw = inp ? String(inp.value || '').trim() : '';
    // 空值本地拦截，避免发空 body 被后端 COUNT_REQUIRED 回弹成服务端错误提示
    if (raw === '') { this.toast(this.t('st_input_count_hint'), 'error'); return; }
    const count = parseFloat(raw);
    if (isNaN(count) || count < 0) { this.toast(this.t('st_input_count_hint'), 'error'); return; }
    if (btn) btn.disabled = true;
    try {
      const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines/' + lineId + '/correct', 'POST',
        { count_qty: count });
      this.stCorrectToast(r);
      this.closeModal();
      await this.openStocktake(no);
    } catch (e) {
      if (btn) btn.disabled = false;
      this.stHandleCorrectError(no, lineId, count, e);
    }
  },

  // 已确认单据：在明细表里对单行差异做更正（弹窗填更正后实盘 + 原因）
  stCorrectPrompt(lineId) {
    if (!this.can('stocktake', 'correct')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const no = this._stNo;
    const d = this._stDetail;
    if (!no || !d) return;
    const l = (d.lines || []).find(x => Number(x.id) === Number(lineId));
    if (!l) return;
    this.showModal(
      `<h3>${this.t('st_correct_line')}</h3>`,
      `<div class="ui-note ui-note--info">${this.t('st_correct_hint')}</div>
      <div class="form-grid" style="max-width:none">
        <div class="form-group"><label>${this.t('mat_code')}</label><input value="${this.docEsc(l.code)}" readonly></div>
        <div class="form-group"><label>${this.t('st_book_qty')}</label><input value="${this.fmtQty(l.book_qty)}" readonly></div>
        <div class="form-group"><label>${this.t('st_count_qty')} *</label><input id="st-cf-target" type="number" step="0.01" value="${this.docEsc(l.count_qty)}"></div>
        <div class="form-group u-full"><label>${this.t('st_correct_reason')}</label><input id="st-cf-reason" value=""></div>
      </div>`,
      this.t('st_correct_line'), () => this.stApplyCorrect(no, l, null), null, false);
  },

  async stApplyCorrect(no, line, btn) {
    const el = document.getElementById('st-cf-target');
    const reasonEl = document.getElementById('st-cf-reason');
    const n = el ? parseFloat(el.value) : NaN;
    if (isNaN(n) || n < 0) { this.toast(this.t('st_input_count_hint'), 'error'); return; }
    if (btn) btn.disabled = true;
    const body = { count_qty: n };
    if (reasonEl && reasonEl.value.trim()) body.reason = reasonEl.value.trim();
    try {
      const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines/' + line.id + '/correct', 'POST', body);
      this.closeModal();
      this.stCorrectToast(r);
      await this.stOpen(no);
    } catch (e) {
      if (btn) btn.disabled = false;
      this.stHandleCorrectError(no, line.id, n, e);
    }
  },

  // 更正失败分流：0 成本入账需管理员确认；无差异直接提示
  stHandleCorrectError(no, lineId, count, e) {
    if (e.code === 'NO_COST_BASIS') {
      this.confirmDialog(this.t('cost_basis_none'), this.t('cost_basis_none_tip'), async () => {
        try {
          const body = { accept_no_basis: true };
          if (count !== undefined && count !== null) body.count_qty = count;
          const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines/' + lineId + '/correct', 'POST', body);
          this.stCorrectToast(r);
          this.closeModal();
          await this.openStocktake(no);
        } catch (err) { this.toast(err.message, 'error'); }
      }, null, 'primary');
      return;
    }
    if (e.code === 'NO_DIFF') { this.toast(this.t('st_correct_no_diff')); return; }
    if (e.code === 'NO_BASIS_FORBIDDEN') { this.toast(this.t('cost_basis_none_forbidden'), 'error'); return; }
    this.toast(e.message, 'error');
  },

  // 真正调用确认接口；force=true 表示用户已知晓盘点期间库存变动并继续
  async doConfirmStocktake(no, force, acceptNoBasis = false) {
    const self = this;
    const body = {};
    if (force) body.force = true;
    if (acceptNoBasis) body.accept_no_basis = true;
    try {
      const r = await self.api('/api/stocktakes/' + encodeURIComponent(no) + '/confirm', 'POST', body);
      self.toast(self.t('st_confirm_ok', { n: r.adjusted_count }));
      self.clearFormDirty();
      await self.openStocktake(no);
    } catch (e) {
      if (e.code === 'STOCK_CHANGED') {
        // 盘点期间有出入库等其他单据改动了账面：列出受影响物料，二次确认后再以 force 重试
        const items = (e.details && e.details.items) || [];
        const n = (e.details && e.details.changed_count) || items.length;
        const rows = items.slice(0, 10).map(it =>
          `· ${it.code}${it.name ? ' ' + it.name : ''}：${self.t('st_book_qty')} ${self.fmtQty(it.snapshot_book)} → ${self.fmtQty(it.current_book)}`
        ).join('\n');
        const more = items.length > 10 ? `\n${self.t('st_changed_more', { n: items.length - 10 })}` : '';
        self.confirmDialog(self.t('st_confirm'),
          `${self.t('st_stock_changed', { n })}\n\n${rows}${more}\n\n${self.t('st_stock_changed_hint')}`,
          () => self.doConfirmStocktake(no, true, acceptNoBasis), null, 'primary');
      } else if (e.code === 'NO_COST_BASIS') {
        // 盘盈物料从未有过正库存：0 成本入账需管理员显式确认
        const codes = (e.details || []).map(d => d.code).join('、');
        self.confirmDialog(self.t('cost_basis_none'),
          `${self.t('cost_basis_none_tip')}\n\n${codes}`,
          () => self.doConfirmStocktake(no, force, true), null, 'primary');
      } else if (e.code === 'NO_BASIS_FORBIDDEN') {
        self.toast(self.t('cost_basis_none_forbidden'), 'error');
      } else {
        self.toast(e.message, 'error');
      }
    }
  },

  // ========== 删除草稿盘点单 ==========

  async deleteStocktake(no) {
    if (!this.can('stocktake', 'delete')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    no = no || this._stNo;
    if (!no) return;
    const self = this;
    this.confirmDialog(this.t('st_delete'), this.t('st_delete_hint'), async () => {
      try {
        await self.api('/api/stocktakes/' + encodeURIComponent(no), 'DELETE');
        self.toast(self.t('st_delete_ok'));
        self.backToStocktakeList();
      } catch (e) {
        self.toast(e.message, 'error');
      }
    });
  },

  // 返回列表（同步 hash 并重取，避免停留在已删除/已确认单据的旧快照）
  async backToStocktakeList() {
    this.stState().sel = null;
    await this.gotoPage('stocktake');
  },

  // ========== 语言切换：保持实盘录入页/详情与已填数量（由 01-core 调度） ==========
  captureStocktakeView() {
    if (document.getElementById('st-edit-root')) {
      return {
        kind: 'edit', no: this._stNo,
        detail: JSON.parse(JSON.stringify(this._stDetail || null)),
        lines: JSON.parse(JSON.stringify(this._stEditLines || [])),
      };
    }
    const s = this.stState();
    if (!s.sel || !this._stDetail) return null;
    return { kind: 'detail', detail: JSON.parse(JSON.stringify(this._stDetail)) };
  },

  async restoreStocktakeView(v) {
    if (v.kind === 'edit') {
      await this.editStocktake(v.no);
      // editStocktake 会重取详情，这里覆盖回切换前的行内录入
      this._stDetail = v.detail;
      this._stEditLines = v.lines;
      this.renderStocktakeEdit();
      return;
    }
    // 列表重渲染已重取详情，覆盖回切换前（含尚未保存的实盘数量）再重绘详情栏
    this._stDetail = v.detail;
    this.stRenderInspector();
  },

});
