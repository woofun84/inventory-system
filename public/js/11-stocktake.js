/**
 * 库存盘点 —— 盘点单列表 / 右侧详情栏 / 录入实盘编辑页 / 载入清单 / 确认 / 删除草稿
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
 *  - 账面数量在载入清单时固化为快照（book_qty）
 *  - 权限动作粒度：view / create（建单+载入+录实盘+删草稿）/ confirm（确认并生成流水）
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
    if (!s.lim) s.lim = 15;
    if (!s.ex) s.ex = new Set();
    if (!this._stCache) this._stCache = {};
    if (!this._stList) this._stList = [];
    return s;
  },

  // ========== 页面骨架（对齐入库：页签 + 条件区 + KPI + 列表/详情栏） ==========
  async renderStocktake() {
    const s = this.stState();
    this.setMain(this.pageWrap('📋 ' + this.t('st_title'), this.t('st_desc'), '', this.stSkeleton()));
    const pb = document.querySelector('.page-body');
    if (pb) pb.classList.add('pu-page-body');
    this.stBindEvents();
    this.stRenderTabs();
    this.stRenderToolbar();
    this.stRenderFilters();
    const root = document.getElementById('st-root');
    if (root) root.classList.toggle('st-dense', !!s.dense);
    await this.loadStocktakeList();
    // 进入页面时若有选中的盘点单，强制重取详情，避免复用上次的快照
    if (s.sel) await this.stOpen(s.sel); else this.stRenderInspector();
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

  stEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
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
    box.innerHTML = this.can('stocktake', 'create')
      ? `<button type="button" class="btn btn-primary" data-st="new">+ ${this.t('st_add')}</button>` : '';
  },

  stRenderFilters() {
    const box = document.getElementById('st-filters');
    if (!box) return;
    const s = this.stState();
    const ph = this.t('st_filter_hint');
    box.innerHTML = `<div class="pu-search" role="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="st_f_kw" type="search" value="${this.stEsc(s.f.kw)}" placeholder="${ph}" aria-label="${ph}">
      </div>
      <div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="st_f_from">${this.t('pu_date')}</label>
        <input id="st_f_from" type="date" value="${this.stEsc(s.f.from)}" aria-label="${this.t('pu_date')}">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="st_f_to" type="date" value="${this.stEsc(s.f.to)}" aria-label="${this.t('pu_date')}">
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
      if (scroll) scroll.innerHTML = `<div class="pu-empty">${this.stEsc(e.message)}</div>`;
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
    this.stUpdatePagerSticky();
  },

  stListTable(pageData) {
    const sel = this.stState().sel;
    const tid = 'stocktake';
    const cols = [
      ['stocktake_no', this.t('st_no'), r =>
        `<button type="button" class="pu-lk" data-st="open" data-id="${this.stEsc(r.stocktake_no)}">${this.stEsc(r.stocktake_no)}</button>`],
      ['date', this.t('adj_date'), r => this.fmtDate(r.date)],
      ['status', this.t('st_status'), r => this.stStatusBadge(r.status)],
      ['load_scope', this.t('st_scope'), r => this.stEsc(this.stScopeLabel(r))],
      ['handler', this.t('st_handler'), r => this.stEsc(r.handler || '')],
      ['line_count', this.t('st_lines'), r => r.line_count || 0, true],
      ['counted_count', this.t('st_counted'), r => r.counted_count || 0, true],
      ['diff_count', this.t('st_diff'), r => Number(r.diff_count) > 0
        ? `<span class="badge badge-warning">${r.diff_count}</span>`
        : `<span class="pu-mu">0</span>`, true],
      ['remarks', this.t('st_remark'), r => this.stEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = pageData.map(r => {
      const on = sel === r.stocktake_no;
      return `<tr class="pu-row${on ? ' sel' : ''}" data-ra="stocktake" data-id="${this.stEsc(r.stocktake_no)}">` +
        shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  stRenderPager(rows) {
    const box = document.getElementById('st-pager');
    if (!box) return;
    const st = this.getTableState('stocktake');
    const tp = Math.max(1, Math.ceil(rows.length / st.pageSize));
    if (st.page > tp) st.page = tp;
    if (!rows.length) { box.innerHTML = ''; return; }
    const tot = `${this.t('pu_sum_orders', { n: rows.length })}`
      + ` · ${this.t('st_status_draft')} ${rows.filter(r => r.status === 'draft').length}`
      + ` · ${this.t('st_status_confirmed')} ${rows.filter(r => r.status === 'confirmed').length}`
      + ` · ${this.t('st_diff')} ${rows.filter(r => Number(r.diff_count) > 0).length}`;
    box.innerHTML = `<span class="pu-tot">${tot}</span>
      <span>${st.page} / ${tp} ${this.t('page')}</span>
      <label>${this.t('pageSize')} <select id="st-psz">${[10, 15, 20, 50].map(n => `<option value="${n}"${n === st.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-outline btn-sm" data-st="pg" data-id="-1"${st.page <= 1 ? ' disabled' : ''}>${this.t('pu_prev')}</button>
      <button type="button" class="btn btn-outline btn-sm" data-st="pg" data-id="1"${st.page >= tp ? ' disabled' : ''}>${this.t('pu_next')}</button>`;
  },

  // 只有内容超出视口时才把分页条吸附到底部
  stUpdatePagerSticky() {
    const pb = document.querySelector('.page-body');
    const pager = document.getElementById('st-pager');
    if (!pb || !pager) return;
    pager.classList.toggle('pin', pb.scrollHeight > pb.clientHeight + 2);
  },

  // 状态徽标
  stStatusBadge(status) {
    const label = { draft: 'st_status_draft', confirmed: 'st_status_confirmed' };
    return `<span class="badge ${this.docStatusMeta(status).cls}">${label[status] ? this.t(label[status]) : status}</span>`;
  },

  // 行状态徽标
  stLineStatusBadge(status) {
    const map = {
      pending: [this.t('st_line_pending'), 'muted'],
      matched: [this.t('st_line_matched'), 'success'],
      adjusted: [this.t('st_line_adjusted'), 'info'],
    };
    const m = map[status] || [status, 'muted'];
    return `<span class="badge badge-${m[1]}">${m[0]}</span>`;
  },

  // 载入范围显示（真实反映载入方式，而非笼统的「全部类别」）
  stScopeLabel(r) {
    const scope = (r && r.load_scope) || '';
    const cats = String((r && r.category_filter) || '').split(',').map(s => s.trim()).filter(Boolean);
    if (scope === 'specified') return this.t('st_scope_specified');
    if (scope === 'category') return this.t('st_scope_category', { c: cats.join('、') || '-' });
    if (scope === 'all') return this.t('st_scope_all');
    return cats.length ? this.t('st_scope_category', { c: cats.join('、') }) : this.t('st_scope_all');
  },

  // ========== 详情栏（点行原地展开，不整页跳转） ==========
  async stOpen(no) {
    if (!no) return;
    const s = this.stState();
    if (s.sel !== no) { s.dt = 'lines'; s.lq = ''; s.lim = 15; s.ex = new Set(); }
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
    if (!rec || rec.loading) { box.innerHTML = `<div class="pu-empty">${this.t('loading')}</div>`; return; }
    if (rec.error) { box.innerHTML = `<div class="pu-empty">${this.stEsc(rec.error)}</div>`; return; }
    const d = rec.d;
    const lines = d.lines || [];
    const adjustments = d.adjustments || [];
    const logs = d.logs || [];
    if (!['lines', 'related', 'logs'].includes(s.dt)) s.dt = 'lines';

    const meta = [
      [this.t('st_handler'), d.handler || '–'],
      [this.t('st_scope'), this.stScopeLabel(d)],
      [this.t('adj_date'), this.fmtDate(d.date) || '–'],
      [this.t('ibd_created_by'), d.created_by || '–'],
      [this.t('ibd_created_at'), this.fmtDateTime(d.created_at) || '–'],
    ];
    if (d.confirmed_at) meta.push([this.t('st_confirmed_at'), this.fmtDateTime(d.confirmed_at)]);
    meta.push([this.t('st_remark'), d.remarks || '–']);

    // 页签顺序统一：明细 → 关联单据 → 操作日志（日志永远最后）
    // 关联页签恒显示，无数据时面板内给空态文案
    const tabs = [
      ['lines', this.t('st_tab_lines'), lines.length],
      ['related', this.t('st_tab_related'), adjustments.length],
      ['logs', this.t('pu_tab_logs'), logs.length],
    ];

    // 底部操作条：录入实盘 → 确认 → 删除草稿（高危固定最右）
    const isDraft = d.status === 'draft';
    let foot = '';
    if (isDraft && this.can('stocktake', 'create')) {
      foot += lines.length
        ? `<button type="button" class="btn btn-outline" data-st="e-doc">✎ ${this.t('st_edit_counts')}</button>`
        : `<button type="button" class="btn btn-primary" data-st="load">${this.t('st_load')}</button>`;
    }
    if (isDraft && lines.length && this.can('stocktake', 'confirm')) {
      foot += `<button type="button" class="btn btn-primary" data-st="confirm">✅ ${this.t('st_confirm')}</button>`;
    }
    if (isDraft && this.can('stocktake', 'create')) {
      foot += `<button type="button" class="btn btn-danger" data-st="del">${this.t('st_delete')}</button>`;
    }

    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" data-st="icl">← ${this.t('pu_back_list')}</button>
      <div class="pu-insp-head">
        <div>
          <small>${this.t('st_title')}</small>
          <h2>${this.stEsc(d.stocktake_no)}</h2>
          <span class="pu-badge">${this.stStatusBadge(d.status)}</span>
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" data-st="wide" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}">${s.wide ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" data-st="icl" title="${this.t('pu_close_detail')}">✕</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${this.stEsc(m[0])}</dt><dd>${this.stEsc(m[1])}</dd></div>`).join('')}</dl>
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" data-st="dt" data-id="${k}">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="st-dpanel"></div>
      ${foot ? `<div class="pu-insp-foot">${foot}</div>` : ''}`;
    this.stRenderDetailPanel();
    this.stUpdatePagerSticky();
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
    if (s.wide) {
      this._tableRenderers['stocktake_detail_lines'] = () => this.stRenderLinesBody();
      box.innerHTML = `<div id="st-lines-body">${this.stDetailLinesTable(lines)}</div>`;
      return;
    }
    const f = lines.filter(l => {
      if (s.lq && !this.puKwMatch([l.code, l.material_name, l.material_spec, l.material_brand, l.remarks].join(' '), s.lq)) return false;
      return true;
    });
    const shown = Math.min(s.lim, f.length);

    let html = `<div class="pu-lqtoolbar">
      <input id="st_lqi" type="search" value="${this.stEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}">
    </div>`;
    if (!lines.length) {
      html += `<div class="pu-empty">${this.t('st_empty_lines')}</div>`;
      box.innerHTML = html; return;
    }
    html += `<p class="pu-cnt">${this.t('pu_shown_count', { shown, total: f.length })}</p>`;
    if (!f.length) {
      html += `<div class="pu-empty">${this.t('pu_no_lines')}</div>`;
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
          <span class="pu-line-n"><strong>${this.stEsc(l.code)}</strong> ${this.stEsc(l.material_name || '')} <span class="pu-mu">${this.stEsc(l.material_spec || '')}</span></span>
          <span class="pu-line-q">${hasCount ? this.qtyCell(cnt) : '–'}${this.stEsc(l.material_unit || '')}</span>
        </button>
        ${ex ? `<div class="pu-line-d">
          <div class="pu-mu">${this.t('st_book_qty')} ${this.qtyCell(book)} · ${this.t('st_count_qty')} ${hasCount ? this.qtyCell(cnt) : '–'} · ${this.t('st_diff_qty')} ${diffHtml}</div>
          <div>${this.stLineStatusBadge(l.status)}${l.remarks ? ` · ${this.t('pu_remarks')}：${this.stEsc(l.remarks)}` : ''}</div>
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    if (f.length > s.lim) html += `<button type="button" class="btn btn-outline btn-sm pu-more" data-st="more">${this.t('pu_more', { n: f.length - s.lim })}</button>`;
    box.innerHTML = html;
  },

  stDetailLinesTable(lines) {
    const tid = 'stocktake_detail_lines';
    const cols = [
      ['code', this.t('mat_code'), r => this.stEsc(r.code)],
      ['material_name', this.t('mat_name'), r => this.stEsc(r.material_name || '')],
      ['material_spec', this.t('mat_spec'), r => this.stEsc(r.material_spec || '')],
      ['material_brand', this.t('mat_brand'), r => this.stEsc(r.material_brand || '')],
      ['material_unit', this.t('mat_unit'), r => this.stEsc(r.material_unit || '')],
      ['book_qty', this.t('st_book_qty'), r => this.qtyCell(Number(r.book_qty) || 0), true],
      ['count_qty', this.t('st_count_qty'), r => (r.count_qty === null || r.count_qty === undefined) ? '–' : this.qtyCell(r.count_qty), true],
      ['diff_qty', this.t('st_diff_qty'), r => {
        const has = r.count_qty !== null && r.count_qty !== undefined;
        if (!has) return '–';
        const diff = Number(r.diff_qty) || 0;
        const cls = diff > 0 ? 'num-pos' : (diff < 0 ? 'num-neg' : '');
        return `<span class="${cls}" style="font-weight:600">${diff > 0 ? '+' : ''}${this.fmtQty(diff)}</span>`;
      }, true],
      ['status', this.t('st_status_label'), r => this.stLineStatusBadge(r.status)],
      ['remarks', this.t('st_remark'), r => this.stEsc(r.remarks || '')],
    ];
    const st = this.getTableState(tid);
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const th = cols.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const body = sorted.map(r => '<tr>' + cols.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>').join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('noData')}</td></tr>`}</tbody></table></div>`;
  },

  // 关联单据：盘点确认后生成的库存调整流水（只读，按物料逐条追溯）
  stRenderRelated(d) {
    const box = document.getElementById('st-dpanel');
    if (!box) return;
    const rows = Array.isArray(d.adjustments) ? d.adjustments : [];
    if (!rows.length) {
      box.innerHTML = `<div class="pu-empty">${this.t('st_adj_empty')}</div>`;
      return;
    }
    box.innerHTML = `<div class="pu-items">` + rows.map(a => {
      const qty = Number(a.qty) || 0;
      const gain = qty > 0;
      return `<div class="pu-item">
        <div class="pu-item-top">
          <span><strong>${this.stEsc(a.code)}</strong> ${this.stEsc(a.material_name || '')} <span class="pu-mu">${this.stEsc(a.material_spec || '')}</span></span>
          <span class="pu-line-q ${gain ? 'num-pos' : 'num-neg'}" style="font-weight:600">${gain ? '+' : ''}${this.fmtQty(qty)}${this.stEsc(a.material_unit || '')}</span>
        </div>
        <div class="pu-mu" style="font-size:12px">${this.stEsc(a.adj_type || '')} · ${this.fmtDate(a.date)} · ${this.stEsc(a.handler || '')}${a.reason ? ' · ' + this.stEsc(a.reason) : ''}${a.cost_basis ? ` · ${this.t('cost_basis_label')} ${this.costBasisBadge(a.cost_basis)}` : ''}</div>
        ${a.remarks ? `<div class="pu-mu" style="font-size:12px">${this.stEsc(a.remarks)}</div>` : ''}
      </div>`;
    }).join('') + `</div>`;
  },

  // ========== 操作日志（ol.pu-log：动作加粗 + 操作人 + 时间 + 详情行） ==========
  stLogLabel(action) {
    const m = {
      create: this.t('audit_act_create'),
      load: this.t('audit_act_load'),
      save: this.t('audit_act_update'),
      add: this.t('audit_act_update'),
      remove: this.t('audit_act_delete'),
      confirm: this.t('audit_act_confirm'),
    };
    return m[action] || action;
  },

  stLogsPanel(logs) {
    if (!logs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    return `<ol class="pu-log">` + logs.map(l => {
      const detail = this.logDetailText(l);
      return `<li>
      <div>
        <strong>${this.stEsc(this.stLogLabel(l.action))}</strong>
        <span class="pu-log-meta">· ${this.stEsc(l.operator || '')} · ${this.fmtDateTime(l.created_at)}</span>
        ${detail ? `<div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere">${this.stEsc(detail)}</div>` : ''}
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
      if (e.target.closest('#st-insp, #st-root tr[data-ra], [data-st], #modal-overlay, .pu-ov, .toast')) return;
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
      else if (e.target.id === 'st-psz') { st.pageSize = parseInt(e.target.value, 10) || 15; st.page = 1; this.stRenderList(); }
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
      if (this.currentPage === 'stocktake') this.stUpdatePagerSticky();
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
      case 'dt': s.dt = id; s.lim = 15; this.stRenderInspector(); return;
      case 'kpi': s.kpi = s.kpi === id ? '' : id; this.getTableState('stocktake').page = 1; this.stRenderList(); return;
      case 'clr': s.f = { kw: '', from: '', to: '' }; s.kpi = ''; this.getTableState('stocktake').page = 1; this.stRenderFilters(); this.stRenderList(); return;
      case 'dense': s.dense = !s.dense; document.getElementById('st-root').classList.toggle('st-dense', s.dense); if (el) el.setAttribute('aria-pressed', String(s.dense)); return;
      case 'pg': this.getTableState('stocktake').page += Number(id); this.stRenderList(); return;
      case 'ex': { const k = String(id); if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k); this.stRenderLinesBody(); return; }
      case 'more': s.lim += 15; this.stRenderLinesBody(); return;
      case 'new': return this.newStocktake();
      case 'load': return this.openStocktakeLoadModal();
      case 'e-doc': return this.editStocktake(s.sel);
      case 'confirm': return this.confirmStocktake();
      case 'del': return this.deleteStocktake(s.sel);
    }
  },

  // ========== 新建盘点单：独立页面（01 单据信息 + 底部操作行） ==========
  async newStocktake() {
    const date = this.today();
    let no = '';
    try {
      const next = await this.api('/api/stocktakes/next-no?date=' + date);
      no = next.stocktake_no;
    } catch (e) { /* 单号预览失败不阻断 */ }

    this.setMain(this.pageWrap('🆕 ' + this.t('st_add'), this.t('st_create_hint'), '',
      `<div id="st-new-root" class="data-page">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.backToStocktakeList()">← ${this.t('st_nav_detail')}</span>
          ${this.stStatusBadge('draft')}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('st_sec_info')}<small>${this.t('st_sec_info_hint')}</small></div></div>
          <div class="form-grid" style="max-width:none">
            <div class="form-group"><label>${this.t('st_no')}</label><input id="st_f_no" value="${no}" readonly></div>
            <div class="form-group"><label>${this.t('adj_date')} *</label><input id="st_f_date" type="date" value="${date}" oninput="App.clearFieldError('st_f_date')"><div class="form-error" id="st_f_date_error"></div></div>
            <div class="form-group"><label>${this.t('st_handler')}</label><input id="st_f_handler" value="${this.stEsc(this.user?.name || this.user?.username || '')}"></div>
            <div class="form-group" style="grid-column:1/-1"><label>${this.t('st_remark')}</label><textarea id="st_f_remarks" rows="2" placeholder="${this.t('st_remark')}"></textarea></div>
          </div>
        </div>
        <div class="pu-edit-actions">
          <button class="btn btn-outline" onclick="App.backToStocktakeList()">${this.t('cancel')}</button>
          <button class="btn btn-primary" onclick="App.createStocktake()">${this.t('st_create_go')}</button>
        </div>
      </div>`));
  },

  async createStocktake() {
    if (!this.validateForm({ st_f_date: [{ rule: 'required' }] })) return;
    const body = {
      date: document.getElementById('st_f_date').value,
      handler: document.getElementById('st_f_handler').value.trim(),
      remarks: document.getElementById('st_f_remarks').value.trim(),
    };
    try {
      const r = await this.api('/api/stocktakes', 'POST', body);
      this.toast(this.t('st_created'));
      // 建单后进入详情并弹出「载入清单」窗口，由用户选择三种载入方式之一
      await this.openStocktake(r.stocktake_no);
      this.openStocktakeLoadModal();
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // ========== 录入实盘 / 编辑草稿：独立页面（01 单据信息 + 02 盘点明细 + 底部操作行） ==========
  async editStocktake(no) {
    no = no || this._stNo;
    if (!no) return;
    let d;
    try { d = await this.api('/api/stocktakes/' + encodeURIComponent(no)); }
    catch (e) { this.toast(e.message, 'error'); return; }
    this._stNo = no;
    this._stDetail = d;
    this._stCache[no] = { d };
    this._stEditLines = (d.lines || []).map(l => ({
      id: l.id, code: l.code, material_name: l.material_name, material_spec: l.material_spec,
      material_brand: l.material_brand, material_unit: l.material_unit,
      book_qty: Number(l.book_qty) || 0,
      count_qty: (l.count_qty === null || l.count_qty === undefined) ? '' : l.count_qty,
      status: l.status, remarks: l.remarks || '',
    }));

    this.setMain(this.pageWrap('✏️ ' + this.t('st_edit_title'),
      `${d.stocktake_no} · ${this.t('st_scope')} ${this.stScopeLabel(d)}`, '',
      `<div id="st-edit-root" class="data-page">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.openStocktake('${this.stEsc(d.stocktake_no)}')">← ${this.t('st_back_detail')}</span>
          ${this.stStatusBadge(d.status)}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('st_sec_info')}<small>${this.t('st_head_locked')}</small></div></div>
          <div class="form-grid" style="max-width:none">
            <div class="form-group"><label>${this.t('st_no')}</label><input value="${this.stEsc(d.stocktake_no)}" readonly></div>
            <div class="form-group"><label>${this.t('adj_date')}</label><input value="${this.fmtDate(d.date)}" readonly></div>
            <div class="form-group"><label>${this.t('st_handler')}</label><input value="${this.stEsc(d.handler || '')}" readonly></div>
            <div class="form-group"><label>${this.t('st_scope')}</label><input value="${this.stEsc(this.stScopeLabel(d))}" readonly></div>
            <div class="form-group" style="grid-column:1/-1"><label>${this.t('st_remark')}</label><input value="${this.stEsc(d.remarks || '')}" readonly></div>
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
      btnBox.innerHTML = isDraft
        ? `<button class="btn btn-outline" onclick="App.openStocktakeAddLinesModal()">+ ${this.t('st_add_line')}</button>
           <button class="btn btn-outline" onclick="App.saveStocktakeCounts()">${this.t('st_save_count')}</button>
           <button class="btn btn-primary" onclick="App.stConfirmFromEdit()">✅ ${this.t('st_confirm')}</button>`
        : `<div class="pu-empty" style="margin:0">${this.t('st_confirmed_at')}：${this.fmtDateTime(d.confirmed_at) || '–'}</div>`;
    }

    const box = document.getElementById('st-edit-lines');
    if (!box) return;
    const colCount = 10;
    if (!lines.length) {
      box.innerHTML = `<div class="pu-empty">${this.t('st_empty_lines')}
        ${isDraft ? `<div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="App.openStocktakeLoadModal()">${this.t('st_load')}</button></div>` : ''}
        <div style="margin-top:8px;font-size:12px">${this.t('st_load_hint')}</div></div>`;
      return;
    }

    const head = `<tr>
      <th>${this.t('mat_code')}</th>
      <th>${this.t('mat_name')}</th>
      <th>${this.t('mat_spec')}</th>
      <th>${this.t('mat_unit')}</th>
      <th class="text-right">${this.t('st_book_qty')}</th>
      <th>${this.t('st_count_qty')}</th>
      <th class="text-right">${this.t('st_diff_qty')}</th>
      <th>${this.t('st_status_label')}</th>
      <th>${this.t('st_remark')}</th>
      <th></th>
    </tr>`;

    const body = lines.map(l => {
      const hasCount = l.count_qty !== '' && l.count_qty !== null && l.count_qty !== undefined;
      const diff = hasCount ? Math.round((Number(l.count_qty) - l.book_qty) * 10000) / 10000 : null;
      const cntCell = isDraft
        ? `<input type="number" step="0.01" class="st-count-input" data-id="${l.id}" data-book="${l.book_qty}" value="${this.stEsc(l.count_qty)}" placeholder="${this.t('st_input_count')}" oninput="App.stEditCountInput(${l.id}, this)">`
        : (hasCount ? this.qtyCell(l.count_qty) : '–');
      return `<tr>
        <td>${this.stEsc(l.code)}</td>
        <td>${this.stEsc(l.material_name || '')}</td>
        <td>${this.stEsc(l.material_spec || '')}</td>
        <td>${this.stEsc(l.material_unit || '')}</td>
        <td class="pu-edit-amt">${this.qtyCell(l.book_qty)}</td>
        <td>${cntCell}</td>
        <td class="pu-edit-amt" id="st-diff-${l.id}">${this.stDiffCell(diff)}</td>
        <td>${this.stLineStatusBadge(l.status)}</td>
        <td>${this.stEsc(l.remarks || '')}</td>
        <td>${isDraft ? `<button type="button" class="pu-edit-del" onclick="App.removeStocktakeLine(${l.id}, '${this.stEsc(l.code).replace(/'/g, "\\'")}')">${this.t('st_remove_line')}</button>` : ''}</td>
      </tr>`;
    }).join('');

    box.innerHTML = `<div class="table-wrap pu-edit-lines"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  },

  stDiffCell(diff) {
    if (diff === null || diff === undefined) return '<span class="pu-mu">–</span>';
    const cls = diff > 0 ? 'num-pos' : (diff < 0 ? 'num-neg' : '');
    return `<span class="${cls}" style="font-weight:600">${diff > 0 ? '+' : ''}${this.fmtQty(diff)}</span>`;
  },

  // 实盘输入即时重算差异（只更新当前行的差异单元格，不重建页面，避免打断输入法）
  stEditCountInput(id, el) {
    const l = (this._stEditLines || []).find(x => Number(x.id) === Number(id));
    if (!l) return;
    const raw = String(el.value || '').trim();
    l.count_qty = raw === '' ? '' : (parseFloat(raw) || 0);
    const cell = document.getElementById('st-diff-' + id);
    if (cell) cell.innerHTML = this.stDiffCell(raw === '' ? null : Math.round((Number(l.count_qty) - l.book_qty) * 10000) / 10000);
  },

  // 返回列表页并打开该单详情（从编辑页 / 弹窗返回）
  async openStocktake(no) {
    this.stState().sel = no || null;
    await this.gotoPage('stocktake');
  },

  // ========== 保存实盘 ==========

  // 收集编辑页的实盘输入；返回 null 表示没有任何输入
  stCollectCounts() {
    const inputs = Array.from(document.querySelectorAll('.st-count-input'));
    const lines = [];
    inputs.forEach(inp => {
      const raw = String(inp.value || '').trim();
      if (raw === '') return;
      const n = parseFloat(raw);
      if (isNaN(n)) return;
      lines.push({ id: Number(inp.dataset.id), count_qty: n });
    });
    return lines;
  },

  async saveStocktakeCounts() {
    const no = this._stNo;
    if (!no) return;
    const lines = this.stCollectCounts();
    if (lines.length === 0) { this.toast(this.t('st_input_count_hint'), 'error'); return; }
    try {
      await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'PUT', { lines });
      this.toast(this.t('st_save_ok'));
      await this.openStocktake(no);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // 编辑页直接确认：先保存本轮录入的实盘，再走与详情栏一致的确认流程
  async stConfirmFromEdit() {
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

  // ========== 载入盘点清单 ==========
  // 三种方式：全盘 / 按物料类别 / 指定物料（见后端 /load）
  // 关键约束：账面数量在载入时固化为快照；同一物料仅出现一次。

  async openStocktakeLoadModal() {
    const no = this._stNo;
    if (!no) return;
    const cats = (this.params?.categories || []).map(c => c.name).filter(Boolean);

    this._stLoad = {
      mode: 'all',
      categories: [],
      codes: [],          // 已选物料编码（指定物料）
      catKeyword: '',
      pickKeyword: '',
      pickResults: [],
    };
    this._stLoadCats = cats;

    this.showModal(
      `<h3>${this.t('st_load')}</h3>`,
      `<div class="st-load-tabs" id="st-load-tabs">
        <span class="st-load-tab active" data-mode="all" onclick="App.switchStocktakeLoadMode('all')">${this.t('st_load_mode_all')}</span>
        <span class="st-load-tab" data-mode="category" onclick="App.switchStocktakeLoadMode('category')">${this.t('st_load_mode_category')}</span>
        <span class="st-load-tab" data-mode="specified" onclick="App.switchStocktakeLoadMode('specified')">${this.t('st_load_mode_specified')}</span>
      </div>
      <div id="st-load-panel" class="st-load-panel"></div>`,
      this.t('st_load_action'), () => this.doStocktakeLoad(), null, true);

    this.renderStocktakeLoadPanel();
    this.refreshStocktakeLoadStats();
  },

  switchStocktakeLoadMode(mode) {
    if (!this._stLoad) return;
    this._stLoad.mode = mode;
    document.querySelectorAll('#st-load-tabs .st-load-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.mode === mode);
    });
    this.renderStocktakeLoadPanel();
    this.refreshStocktakeLoadStats();
  },

  renderStocktakeLoadPanel() {
    const box = document.getElementById('st-load-panel');
    const s = this._stLoad;
    if (!box || !s) return;

    if (s.mode === 'all') {
      box.innerHTML = `<div class="st-load-hint">${this.t('st_load_mode_all_hint')}</div>
        <div class="st-load-stat" id="st-load-stat"></div>`;
      return;
    }

    if (s.mode === 'category') {
      box.innerHTML = `<div class="st-load-hint">${this.t('st_load_mode_category_hint')}</div>
        <input id="st-load-cat-kw" type="text" placeholder="${this.t('st_load_cat_filter')}" value="${s.catKeyword || ''}"
          oninput="App._stLoad.catKeyword=this.value;App.renderStocktakeCatList()" class="st-load-search">
        <div class="st-load-cat-list" id="st-load-cat-list"></div>
        <div class="st-load-stat" id="st-load-stat"></div>`;
      this.renderStocktakeCatList();
      return;
    }

    // specified
    box.innerHTML = `<div class="st-load-hint">${this.t('st_load_mode_specified_hint')}</div>
      <input id="st-load-pick-kw" type="text" placeholder="${this.t('st_load_search_ph')}" value="${s.pickKeyword || ''}"
        oninput="App.onStocktakePickSearch(this.value)" class="st-load-search">
      <div class="st-pick-selected" id="st-pick-selected"></div>
      <div class="table-wrap st-pick-results"><table><thead><tr>
        <th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th>
        <th>${this.t('mat_unit')}</th><th class="text-right">${this.t('st_book_qty')}</th><th></th>
      </tr></thead><tbody id="st-pick-body"></tbody></table></div>
      <div class="st-load-stat" id="st-load-stat"></div>`;
    this.renderStocktakePickResults();
    this.renderStocktakeSelected();
  },

  renderStocktakeCatList() {
    const box = document.getElementById('st-load-cat-list');
    const s = this._stLoad;
    if (!box || !s) return;
    const kw = (s.catKeyword || '').trim().toLowerCase();
    const cats = (this._stLoadCats || []).filter(c => !kw || String(c).toLowerCase().includes(kw));
    if (cats.length === 0) {
      box.innerHTML = `<div class="pu-empty">${this.t('noData')}</div>`;
      return;
    }
    box.innerHTML = cats.map(c => {
      const checked = s.categories.includes(c) ? 'checked' : '';
      return `<label class="st-load-cat-item"><input type="checkbox" ${checked}
        onchange="App.toggleStocktakeLoadCat('${c.replace(/'/g, "\\'")}')"><span>${c}</span></label>`;
    }).join('');
  },

  toggleStocktakeLoadCat(cat) {
    const s = this._stLoad;
    if (!s) return;
    const i = s.categories.indexOf(cat);
    if (i >= 0) s.categories.splice(i, 1); else s.categories.push(cat);
    this.refreshStocktakeLoadStats();
  },

  onStocktakePickSearch(kw) {
    this._stLoad.pickKeyword = kw;
    this.searchStocktakeCandidates();
  },

  async searchStocktakeCandidates() {
    const s = this._stLoad;
    if (!s) return;
    const kw = (s.pickKeyword || '').trim();
    if (!kw) { s.pickResults = []; this.renderStocktakePickResults(); return; }
    try {
      const list = await this.api('/api/stocktakes/candidates?scope=specified&limit=100&keyword=' + encodeURIComponent(kw));
      s.pickResults = Array.isArray(list) ? list : [];
    } catch (e) {
      s.pickResults = [];
    }
    this.renderStocktakePickResults();
  },

  renderStocktakePickResults() {
    const tbody = document.getElementById('st-pick-body');
    const s = this._stLoad;
    if (!tbody || !s) return;
    const kw = (s.pickKeyword || '').trim();
    if (!kw) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_search_hint')}</td></tr>`;
      return;
    }
    const list = s.pickResults || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_empty')}</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(r => {
      const added = s.codes.includes(r.code);
      const newTag = r.is_new ? ` <span class="badge badge-warning">${this.t('st_pick_new')}</span>` : '';
      const btn = added
        ? `<button class="btn btn-outline btn-sm" disabled>${this.t('st_load_added')}</button>`
        : `<button class="btn btn-primary btn-sm" onclick="App.addStocktakePick('${r.code.replace(/'/g, "\\'")}')">${this.t('st_pick_add')}</button>`;
      return `<tr>
        <td>${r.code}</td>
        <td>${r.name || ''}${newTag}</td>
        <td>${r.spec || ''}</td>
        <td>${r.unit || ''}</td>
        <td class="text-right">${this.fmtQty(r.book_qty)}</td>
        <td>${btn}</td>
      </tr>`;
    }).join('');
  },

  addStocktakePick(code) {
    const s = this._stLoad;
    if (!s || s.codes.includes(code)) return;
    s.codes.push(code);
    this.renderStocktakePickResults();
    this.renderStocktakeSelected();
    this.refreshStocktakeLoadStats();
  },

  removeStocktakePick(code) {
    const s = this._stLoad;
    if (!s) return;
    const i = s.codes.indexOf(code);
    if (i >= 0) s.codes.splice(i, 1);
    this.renderStocktakePickResults();
    this.renderStocktakeSelected();
    this.refreshStocktakeLoadStats();
  },

  renderStocktakeSelected() {
    const box = document.getElementById('st-pick-selected');
    const s = this._stLoad;
    if (!box || !s) return;
    if (s.codes.length === 0) {
      box.innerHTML = `<span class="st-pick-selected-empty">${this.t('st_load_selected', { n: 0 })}</span>`;
      return;
    }
    const chips = s.codes.map(c =>
      `<span class="st-pick-chip">${c}<span class="st-pick-chip-x" onclick="App.removeStocktakePick('${c.replace(/'/g, "\\'")}')">&times;</span></span>`
    ).join('');
    box.innerHTML = `<span class="st-pick-selected-label">${this.t('st_load_selected', { n: s.codes.length })}</span>${chips}`;
  },

  // 实时刷新「符合条件项数」统计（全盘/按类别）
  async refreshStocktakeLoadStats() {
    const s = this._stLoad;
    if (!s) return;
    const box = document.getElementById('st-load-stat');
    if (!box) return;
    let url = '';
    if (s.mode === 'all') url = '/api/stocktakes/candidates?scope=all';
    else if (s.mode === 'category') {
      if (s.categories.length === 0) { box.textContent = ''; return; }
      url = '/api/stocktakes/candidates?scope=category&category=' + encodeURIComponent(s.categories.join(','));
    } else { return; }
    try {
      const list = await this.api(url);
      const n = Array.isArray(list) ? list.length : 0;
      const el = document.getElementById('st-load-stat');
      if (el) el.textContent = this.t('st_load_stat', { n });
    } catch (e) { /* 统计失败不阻断 */ }
  },

  async doStocktakeLoad(force = false) {
    const no = this._stNo;
    const s = this._stLoad;
    if (!no || !s) return;

    const body = { scope: s.mode };
    if (s.mode === 'category') {
      if (s.categories.length === 0) { this.toast(this.t('st_load_need_category'), 'error'); return; }
      body.categories = s.categories;
    }
    if (s.mode === 'specified') {
      if (s.codes.length === 0) { this.toast(this.t('st_load_need_material'), 'error'); return; }
      body.codes = s.codes;
    }
    if (force) body.force = true;

    try {
      const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/load', 'POST', body);
      this.closeModal();
      this.toast(this.t('st_load_ok', { n: r.loaded_count }));
      await this.openStocktake(no);
    } catch (e) {
      if (e.code === 'HAS_COUNT_DATA') {
        const n = (e.details && e.details.counted_count) || e.counted_count || 0;
        this.confirmDialog(this.t('st_load'),
          this.t('st_has_count', { n }) + '\n\n' + this.t('st_load_confirm'),
          () => this.doStocktakeLoad(true), null, 'primary');
      } else {
        this.toast(e.message, 'error');
      }
    }
  },

  // ========== 草稿态：增删物料行 ==========
  // 仅在草稿状态可增删；增行采用「增量追加」，不清空已有行与已录实盘。
  // 账面数量取「加入时刻」的库存快照（与载入清单同口径）。

  openStocktakeAddLinesModal() {
    const no = this._stNo;
    if (!no) return;
    const existing = new Set(((this._stDetail && this._stDetail.lines) || []).map(l => l.code));
    this._stAdd = { codes: [], keyword: '', results: [], existing };

    this.showModal(
      `<h3>${this.t('st_add_line')}</h3>`,
      `<div class="st-load-hint">${this.t('st_add_line_hint')}</div>
      <input id="st-add-kw" type="text" placeholder="${this.t('st_load_search_ph')}"
        oninput="App.onStocktakeAddSearch(this.value)" class="st-load-search">
      <div class="st-pick-selected" id="st-add-selected"></div>
      <div class="table-wrap st-pick-results"><table><thead><tr>
        <th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th>
        <th>${this.t('mat_unit')}</th><th class="text-right">${this.t('st_book_qty')}</th><th></th>
      </tr></thead><tbody id="st-add-body"></tbody></table></div>
      <div class="st-load-stat" id="st-add-stat"></div>`,
      this.t('st_add_line_action'), () => this.doStocktakeAddLines(), null, true);

    this.renderStocktakeAddResults();
    this.renderStocktakeAddSelected();
  },

  onStocktakeAddSearch(kw) {
    if (!this._stAdd) return;
    this._stAdd.keyword = kw;
    clearTimeout(this._stAdd.timer);
    if (!String(kw || '').trim()) {
      this._stAdd.results = [];
      this._stAdd.loading = false;
      this.renderStocktakeAddResults();
      return;
    }
    // 与行内即时搜索一致：200ms 防抖，避免每敲一个字查一次
    this._stAdd.loading = true;
    this.renderStocktakeAddResults();
    this._stAdd.timer = setTimeout(() => this.searchStocktakeAddCandidates(), 200);
  },

  async searchStocktakeAddCandidates() {
    const s = this._stAdd;
    if (!s) return;
    const kw = (s.keyword || '').trim();
    if (!kw) { s.results = []; s.loading = false; this.renderStocktakeAddResults(); return; }
    const seq = (s.seq = (s.seq || 0) + 1);
    try {
      const list = await this.api('/api/stocktakes/candidates?scope=specified&limit=100&keyword=' + encodeURIComponent(kw));
      if (s.seq !== seq) return; // 已有更新的输入，丢弃旧响应
      s.results = Array.isArray(list) ? list : [];
    } catch (e) {
      if (s.seq !== seq) return;
      s.results = [];
    }
    s.loading = false;
    this.renderStocktakeAddResults();
  },

  renderStocktakeAddResults() {
    const tbody = document.getElementById('st-add-body');
    const s = this._stAdd;
    if (!tbody || !s) return;
    const kw = (s.keyword || '').trim();
    if (!kw) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_search_hint')}</td></tr>`;
      return;
    }
    if (s.loading) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('ms_loading')}</td></tr>`;
      return;
    }
    const list = s.results || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_empty')}</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(r => {
      const inDoc = s.existing.has(r.code);
      const picked = s.codes.includes(r.code);
      let btn;
      if (inDoc) btn = `<button class="btn btn-outline btn-sm" disabled>${this.t('st_already_in_doc')}</button>`;
      else if (picked) btn = `<button class="btn btn-outline btn-sm" disabled>${this.t('st_load_added')}</button>`;
      else btn = `<button class="btn btn-primary btn-sm" onclick="App.addStocktakeAddPick('${r.code.replace(/'/g, "\\'")}')">${this.t('st_pick_add')}</button>`;
      // 规格与品牌拼接展示；品牌为空时不产生多余分隔符（与其它模块的即时候选一致）
      const specBrand = [r.spec, r.brand].filter(Boolean).join(' · ');
      return `<tr>
        <td>${r.code}</td>
        <td>${r.name || ''}</td>
        <td>${specBrand}</td>
        <td>${r.unit || ''}</td>
        <td class="text-right">${this.fmtQty(r.book_qty)}</td>
        <td>${btn}</td>
      </tr>`;
    }).join('');
  },

  addStocktakeAddPick(code) {
    const s = this._stAdd;
    if (!s || s.codes.includes(code)) return;
    s.codes.push(code);
    this.renderStocktakeAddResults();
    this.renderStocktakeAddSelected();
  },

  removeStocktakeAddPick(code) {
    const s = this._stAdd;
    if (!s) return;
    const i = s.codes.indexOf(code);
    if (i >= 0) s.codes.splice(i, 1);
    this.renderStocktakeAddResults();
    this.renderStocktakeAddSelected();
  },

  renderStocktakeAddSelected() {
    const box = document.getElementById('st-add-selected');
    const s = this._stAdd;
    if (!box || !s) return;
    if (s.codes.length === 0) {
      box.innerHTML = `<span class="st-pick-selected-empty">${this.t('st_load_selected', { n: 0 })}</span>`;
    } else {
      const chips = s.codes.map(c =>
        `<span class="st-pick-chip">${c}<span class="st-pick-chip-x" onclick="App.removeStocktakeAddPick('${c.replace(/'/g, "\\'")}')">&times;</span></span>`
      ).join('');
      box.innerHTML = `<span class="st-pick-selected-label">${this.t('st_load_selected', { n: s.codes.length })}</span>${chips}`;
    }
    const stat = document.getElementById('st-add-stat');
    if (stat) stat.textContent = s.codes.length ? this.t('st_add_selected_stat', { n: s.codes.length }) : '';
  },

  async doStocktakeAddLines() {
    const no = this._stNo;
    const s = this._stAdd;
    if (!no || !s) return;
    if (s.codes.length === 0) { this.toast(this.t('st_load_need_material'), 'error'); return; }
    try {
      const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'POST', { codes: s.codes });
      this.closeModal();
      this.toast(this.t('st_add_line_ok', { n: r.added_count }));
      await this.openStocktake(no);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // 移除某一行物料（仅草稿态）
  removeStocktakeLine(id, code) {
    const no = this._stNo;
    if (!no) return;
    const self = this;
    this.confirmDialog(this.t('st_remove_line'),
      this.t('st_remove_line_hint', { code }),
      async () => {
        try {
          await self.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines/' + id, 'DELETE');
          self.toast(self.t('st_remove_line_ok'));
          await self.openStocktake(no);
        } catch (e) {
          self.toast(e.message, 'error');
        }
      });
  },

  // ========== 确认盘点 ==========

  async confirmStocktake() {
    const no = this._stNo;
    if (!no) return;
    const d = this._stDetail;
    const s = d?.summary || {};

    const self = this;
    this.confirmDialog(this.t('st_confirm'),
      `${this.t('st_confirm_hint')}\n\n${this.t('st_counted')}: ${s.counted_count || 0} · ${this.t('st_diff')}: ${s.diff_count || 0}`,
      () => self.doConfirmStocktake(no, false), null, 'primary');
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

});
