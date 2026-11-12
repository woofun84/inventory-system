/**
 * 库存视图 —— 查询中心（四个板块：库存查询 / 单据查询 / 领用人查询 / 库存分析）
 * 物料详情是「库存查询」右侧的页签卡片（基本信息 / 库存流水），展开为原地放大，不是独立页面。
 * 四个板块共用 query 权限；页签右侧的全局搜索跨库存 / 单据 / 领用人，结果就地展开（不浮层）。
 */
Object.assign(App, {
  // ========== 查询中心：四个板块骨架 ==========
  qBoards() {
    return [
      ['stock', 'q_tab_stock', '▦'],
      ['docs', 'q_tab_docs', '▤'],
      ['receivers', 'q_tab_receivers', '♙'],
      ['analysis', 'q_tab_analysis', '▥'],
    ];
  },

  async renderQuery() {
    // 路由导航：固定落到默认「库存查询」；非导航重渲染（切语言/主题）保留当前板块
    const board = this.qNav ? 'stock' : (this.qBoard || 'stock');
    this.qNav = false;
    // 深链带物料编码：进入该物料的展开态详情卡（列表仍在，不整页替换）；语言/主题切换不打断
    if (this.qPendingCode !== undefined) {
      const code = this.qPendingCode || '';
      this.qPendingCode = undefined;
      if (code) this._qCardPending = { code, expanded: true };
    }
    this.qBoard = board;
    this.setMain(this.pageWrap('🔍 ' + this.t('q_title'), this.t('q_desc'), '', `<div id="q-root" class="data-page">
      <div class="data-toolbar q-global-bar">
        <nav id="q-tabs" class="pu-viewtabs" role="tablist" aria-label="${this.t('q_title')}"></nav>
        <div class="q-gsearch"><div class="pu-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
          <input id="q_global" autocomplete="off" placeholder="${this.t('q_search_ph')}" aria-label="${this.t('q_search_ph')}" onfocus="App.qSearchFocus()" onblur="App.qSearchBlur()" oninput="App.qSearchInput()" onkeydown="App.qSearchKey(event)">
        </div></div>
      </div>
      <div id="q-search-panel" class="q-search-panel" hidden></div>
      <div id="q-panel"></div>
    </div>`));
    document.querySelector('.page-body')?.classList.add('pu-page-body');
    this.qRenderTabs();
    // 与入库/出库详情一致：document 捕获阶段监听，点击卡片以外区域逐层收起（三个板块共用，只绑定一次）
    if (!this._qOutBound) {
      this._qOutBound = true;
      document.addEventListener('click', e => this.qCardOutsideClick(e), true);
    }
    this.qSwitchBoard(board);
  },

  qRenderTabs() {
    const nav = document.getElementById('q-tabs');
    if (!nav) return;
    const active = this.qBoard || 'stock';
    nav.innerHTML = this.qBoards().map(b => `<button type="button" class="pu-viewtab" role="tab" data-board="${b[0]}" aria-selected="${b[0] === active}" onclick="App.qSwitchBoard('${b[0]}')"><span style="margin-right:5px">${b[2]}</span>${this.t(b[1])}</button>`).join('');
  },

  // 按需渲染：切换板块才装配该板块内容，避免首次加载把四个板块一起拉起来
  qSwitchBoard(key) {
    if (!this.qBoards().some(b => b[0] === key)) key = 'stock';
    this.qBoard = key;
    // 切换板块：清掉三个板块的主卡/单据卡状态，避免上一板块的卡片残留
    this._qCard = null;
    this._qCardData = null;
    this._qCardRows = [];
    this._qDocsCard = null;
    this._qDocsCardData = null;
    this._qDocsCardRows = [];
    this._qRcvCard = null;
    this._qRcvCardData = null;
    this._qDocData = null;
    this._qDocSrc = '';
    // 离开库存查询时 hash 不再保留 ?code=
    if (key !== 'stock') {
      this._qCardPending = null;
      if (location.hash.indexOf('?code=') >= 0) history.replaceState(null, '', '#query');
    }
    document.querySelectorAll('#q-tabs .pu-viewtab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.board === key)));
    const panel = document.getElementById('q-panel');
    if (!panel) return;
    if (key === 'docs') { this.qBoardDocs(panel); return; }
    if (key === 'receivers') { this.qBoardReceivers(panel); return; }
    if (key === 'analysis') { this.qBoardAnalysis(panel); return; }
    this.qBoardStock(panel);
  },

  // ========== 板块 1：库存查询（列表 + 右侧物料详情卡） ==========

  qBoardStock(panel) {
    panel.innerHTML = `<div id="q-stock">
      <div class="pu-toolbar">
        <div class="pu-filter-inner">
          <div class="pu-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><input id="q_keyword" placeholder="${this.t('quick_filter_ph')}" oninput="App.qStockFilter()"></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('stock_category')}</label><select id="q_category" onchange="App.qStockFilter()" style="border:0;background:transparent;color:var(--text);font-size:13px;min-width:132px"><option value="">${this.t('stock_all')}</option>${this.params.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}</select></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('stock_status')}</label><select id="q_status" onchange="App.qStockFilter()" style="border:0;background:transparent;color:var(--text);font-size:13px;min-width:96px"><option value="">${this.t('stock_all')}</option><option value="正常">${this.t('st_normal')}</option><option value="补货">${this.t('st_restock')}</option><option value="缺货">${this.t('st_out')}</option></select></div>
        </div>
        <div class="pu-head-actions">
          <button class="btn btn-outline btn-sm" onclick="App.qStockExport()">${this.t('doc_export')}</button>
          <button class="btn btn-outline btn-sm" onclick="App.qStockPrint()">${this.t('doc_print')}</button>
        </div>
      </div>
      <div class="pu-kpis" id="q_stock_kpis"></div>
      <div class="pu-split q-ins-split" id="q_stock_split">
        <section class="pu-list" style="min-width:0">
          <div class="data-scroll" id="q_stock_scroll" style="overflow-x:auto"></div>
          <div class="pu-pager" id="q_stock_pager"></div>
        </section>
        <aside class="pu-insp q-ins-insp q-ins-main" id="q_stock_insp" hidden aria-label="${this.t('q_card_info')}"></aside>
        <aside class="pu-insp q-ins-insp q-ins-doc" id="q_doc_insp" hidden aria-label="${this.t('q_doc_head')}"></aside>
      </div>
    </div>`;
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['stock'] = () => this.qStockTable();
    // 库存分析预警行：切到库存查询后按编码过滤并打开详情卡
    if (this._qAlertCode) {
      const code = this._qAlertCode;
      this._qAlertCode = null;
      this._qCardPending = { code, expanded: false };
      const kw = document.getElementById('q_keyword');
      if (kw) kw.value = code;
    }
    // 库存汇总每次进入板块都强制重取，避免命中会话级旧快照
    this.qLoadStock();
  },

  // 筛选变化时回到第一页，避免结果变少后停留在空页
  qStockFilter() {
    this.getTableState('stock').page = 1;
    this.qStockTable();
  },

  async qLoadStock() {
    const scroll = document.getElementById('q_stock_scroll');
    if (scroll) scroll.innerHTML = `<div class="empty-state"><p>${this.t('q_loading')}</p></div>`;
    try {
      this._stockData = await this.api('/api/stock-summary');
      this.getTableState('stock').page = 1;
      this.qStockTable();
    } catch (e) {
      if (scroll) scroll.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`;
    }
  },

  // 库存查询当前筛选 + 排序的全量行（列表渲染与导出/打印共用，保证口径一致）
  qStockRows() {
    const data = this._stockData || [];
    // 价格可见性由服务端决定：无价格权限时 stock_value 字段不存在
    const vp = data.length ? ('stock_value' in data[0]) : false;
    if (data.length) this._qPriceOn = vp;
    const st = this.getTableState('stock');
    // 多关键字 + 类别 + 状态筛选（前端），口径与旧「库存汇总」一致
    const keywords = document.getElementById('q_keyword')?.value || '';
    const category = document.getElementById('q_category')?.value || '';
    const status = document.getElementById('q_status')?.value || '';
    const filterFields = ['code','name','spec','category','unit','brand','stock_status','on_hand','min_stock','opening_qty','total_in','total_out','total_adj'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    if (category) filtered = filtered.filter(m => m.category === category);
    if (status) filtered = filtered.filter(m => m.stock_status === status);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const totalValue = sorted.reduce((s, m) => s + Number(m.stock_value || 0), 0);
    const alerts = sorted.filter(m => m.stock_status === '补货' || m.stock_status === '缺货').length;
    return { st, sorted, vp, totalValue, alerts, keywords, category, status };
  },

  // 列表导出/打印共用：筛选条件 + 导出行数
  qExportMeta(pairs, total) {
    const meta = (pairs || []).filter(p => p && p[1] !== '' && p[1] != null);
    if (!meta.length) meta.push([this.t('q_export_filters'), this.t('stock_all')]);
    meta.push([this.t('q_export_rows'), String(total)]);
    return meta;
  },

  // 导出 CSV 前补导出时间（打印页头已有打印时间，不重复）
  qListCsv(doc) {
    const ts = this.fmtDateTime(new Date().toISOString());
    const d = Object.assign({}, doc, { meta: (doc.meta || []).concat([[this.t('q_export_time'), ts]]) });
    this.exportDocCsv(d);
  },

  qStockDoc() {
    const { sorted, vp, keywords, category, status } = this.qStockRows();
    const meta = this.qExportMeta([
      [this.t('q_keyword'), keywords],
      [this.t('stock_category'), category],
      [this.t('stock_status'), this.qStockStatusText(status)]
    ], sorted.length);
    const cols = [
      { key: 'code', label: this.t('mat_code') },
      { key: 'name', label: this.t('mat_name') },
      { key: 'spec', label: this.t('mat_spec') },
      { key: 'category', label: this.t('mat_category') },
      { key: 'brand', label: this.t('mat_brand') },
      { key: 'unit', label: this.t('mat_unit') },
      { key: 'on_hand', label: this.t('stock_on_hand'), align: 'right' },
      { key: 'min_stock', label: this.t('stock_min'), align: 'right' },
      { key: 'stock_status', label: this.t('mat_status'), value: r => this.qStockStatusText(r.stock_status) }
    ];
    if (vp) cols.push({ key: 'stock_value', label: this.t('stock_value'), align: 'right', value: r => this.fmtMoney(r.stock_value) });
    return {
      title: this.t('q_tab_stock'),
      meta,
      columns: cols,
      rows: sorted,
      filename: `${this.t('q_tab_stock')}_${this.today().replace(/-/g, '')}.csv`
    };
  },

  qStockStatusText(s) {
    if (!s) return '';
    const map = { '正常': 'st_normal', '补货': 'st_restock', '缺货': 'st_out' };
    return this.t(map[s] || s);
  },

  qStockExport() {
    const doc = this.qStockDoc();
    this.qListCsv(doc);
    this.toast(this.t('doc_export_done', { name: doc.filename }));
  },

  qStockPrint() {
    this.printDoc(this.qStockDoc());
  },

  qStockTable() {
    const data = this._stockData;
    if (!data) return;
    const tid = 'stock';
    const { st, sorted, vp, totalValue, alerts } = this.qStockRows();
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
      ['category', this.t('mat_category')], ['brand', this.t('mat_brand')], ['unit', this.t('mat_unit')],
      ['on_hand', this.t('stock_on_hand'), true], ['min_stock', this.t('stock_min'), true],
      ['stock_status', this.t('mat_status')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid, h[2])).join('');
    const colCount = headers.length;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else {
      const esc = v => String(v == null ? '' : v).replace(/"/g, '&quot;');
      tbody = pageData.map(m => `<tr class="pu-row" data-key="${this.docEsc(m.code)}" onclick="App.qCardOpen('${m.code}')"><td class="cell-code">${m.code}</td><td class="q-ell" title="${esc(m.name)}">${m.name}</td><td class="q-ell" title="${esc(m.spec)}">${m.spec || ''}</td><td>${m.category}</td><td class="q-ell" title="${esc(m.brand)}">${m.brand || ''}</td><td>${m.unit}</td><td class="text-right"><strong>${m.on_hand}</strong></td><td class="text-right">${m.min_stock}</td><td>${this.statusBadge(m.stock_status)}</td></tr>`).join('');
    }
    const kpis = [[this.t('stock_types'), sorted.length], ...(vp ? [[this.t('stock_total_value'), this.fmtMoney(totalValue)]] : []), [this.t('stock_alerts'), alerts]];
    document.getElementById('q_stock_kpis').innerHTML = kpis.map(k => `<div class="pu-kpi"><small>${k[0]}</small><strong>${k[1]}</strong></div>`).join('');
    document.getElementById('q_stock_scroll').innerHTML = `<div class="table-wrap"><table style="table-layout:fixed"><colgroup><col style="width:9%"><col style="width:21%"><col style="width:16%"><col style="width:9%"><col style="width:10%"><col style="width:7%"><col style="width:9%"><col style="width:9%"><col style="width:10%"></colgroup><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('q_stock_pager').innerHTML = this.puPagerHtml(tid, sorted.length);
    this.qInsRemark('stock');
    // 从库存分析预警清单 / 深链进入：列表渲染完再打开详情卡，保证行能高亮
    if (this._qCardPending) {
      const p = this._qCardPending;
      this._qCardPending = null;
      this.qCardOpen(p.code, { expanded: !!p.expanded });
    }
  },

  // 库存分析预警清单 → 库存查询：切板块、按编码过滤并打开右侧详情卡
  qAlertOpen(code) {
    if (!code) return;
    this._qAlertCode = code;
    this.qSwitchBoard('stock');
  },

  // ========== 查询中心：全局搜索（跨库存 / 单据 / 领用人，结果就地分组展示） ==========
  // 只做「入口 + 落点」：查询走 /api/query/search 单次聚合，结果行只带跳转所需的键，
  // 点击后复用各板块原有的筛选与开卡逻辑，不另造一套详情。
  qSearchLimit() { return 5; },

  qSearchFocus() {
    const el = document.getElementById('q_global');
    if (!el || el.value.trim()) return;
    this.qSearchPanelRender({ hint: true });
  },

  // 失焦时收起空态提示；延迟到 click 之后，避免点结果时面板先消失
  qSearchBlur() {
    clearTimeout(this._qSearchBlurTimer);
    this._qSearchBlurTimer = setTimeout(() => {
      const el = document.getElementById('q_global');
      if (!el || !el.value.trim()) this.qSearchPanelClose();
    }, 180);
  },

  qSearchInput() {
    const el = document.getElementById('q_global');
    const kw = (el && el.value || '').trim();
    clearTimeout(this._qSearchTimer);
    this._qSearchSeq = (this._qSearchSeq || 0) + 1; // 作废在途请求，避免旧结果覆盖新输入
    if (!kw) { this.qSearchPanelRender({ hint: true }); return; }
    this.qSearchPanelRender({ loading: true });
    this._qSearchTimer = setTimeout(() => this.qSearchRun(kw), 260);
  },

  qSearchKey(e) {
    if (e.key === 'Escape') {
      e.target.value = '';
      clearTimeout(this._qSearchTimer);
      this._qSearchSeq = (this._qSearchSeq || 0) + 1;
      this.qSearchPanelClose();
      return;
    }
    if (e.key !== 'Enter') return;
    clearTimeout(this._qSearchTimer);
    const kw = (e.target.value || '').trim();
    if (kw) this.qSearchRun(kw);
  },

  async qSearchRun(kw) {
    const panel = document.getElementById('q-search-panel');
    if (!panel || !kw) return;
    this._qSearchSeq = (this._qSearchSeq || 0) + 1;
    const seq = this._qSearchSeq;
    this.qSearchPanelRender({ loading: true });
    try {
      const d = await this.api('/api/query/search?q=' + encodeURIComponent(kw) + '&limit=' + this.qSearchLimit());
      if (seq !== this._qSearchSeq) return;
      this.qSearchPanelRender({ data: d });
    } catch (e) {
      if (seq !== this._qSearchSeq) return;
      const box = document.getElementById('q-search-panel');
      if (box) { box.hidden = false; box.innerHTML = `<div class="q-search-state">${this.docEsc(e.message)}</div>`; }
    }
  },

  qSearchPanelClose() {
    const panel = document.getElementById('q-search-panel');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
  },

  qSearchPanelRender(o) {
    o = o || {};
    const panel = document.getElementById('q-search-panel');
    if (!panel) return;
    panel.hidden = false;
    if (o.hint) { panel.innerHTML = `<div class="q-search-state">${this.t('q_search_hint')}</div>`; return; }
    if (o.loading) { panel.innerHTML = `<div class="q-search-state">${this.t('q_loading')}</div>`; return; }
    const d = o.data || {};
    const g = d.groups || {};
    const mats = g.materials || { total: 0, rows: [] };
    const docs = g.docs || { total: 0, rows: [] };
    const rcvs = g.receivers || { total: 0, rows: [] };
    if (!mats.total && !docs.total && !rcvs.total) {
      panel.innerHTML = `<div class="q-search-state">${this.t('q_search_none')}</div>`;
      return;
    }
    const esc = v => this.docEsc(v == null ? '' : v);
    const head = (label, group) => `<div class="q-search-ghead">${label}<span class="q-search-count">${this.t('q_search_total', { n: group.total })}${group.total > group.rows.length ? ' · ' + this.t('q_search_top', { n: group.rows.length }) : ''}</span></div>`;
    const item = (kind, key, source, main, meta) => `<div class="q-search-item" data-kind="${kind}" data-key="${esc(key)}"${source ? ` data-source="${esc(source)}"` : ''} onclick="App.qSearchGo(this)"><span class="q-search-main">${main}</span><span class="q-search-meta">${meta}</span></div>`;
    let html = '';
    if (mats.total) {
      html += `<div class="q-search-group">${head(this.t('q_search_group_mat'), mats)}`
        + mats.rows.map(r => item('material', r.code, '',
          `<span class="q-search-code">${esc(r.code)}</span><span class="q-search-sub">${esc(r.name)}${r.spec ? ' · ' + esc(r.spec) : ''}</span>`,
          `${r.on_hand}${r.unit ? ' ' + esc(r.unit) : ''}`)).join('')
        + '</div>';
    }
    if (docs.total) {
      html += `<div class="q-search-group">${head(this.t('q_search_group_doc'), docs)}`
        + docs.rows.map(r => item('doc', r.doc_no, r.source,
          `<span class="q-search-code">${esc(r.doc_no)}</span>${this.qDocTypeBadge(r.doc_type)}<span class="q-search-sub">${esc(r.date)}${r.party ? ' · ' + esc(r.party) : ''}</span>`,
          `${this.qDocStatusLabel(r.status)}${r.amount != null ? ' · ' + this.fmtMoney(r.amount) : ''}`)).join('')
        + '</div>';
    }
    if (rcvs.total) {
      html += `<div class="q-search-group">${head(this.t('q_search_group_rcv'), rcvs)}`
        + rcvs.rows.map(r => item('receiver', r.receiver, '',
          `<span class="q-search-code">${esc(r.receiver)}</span>`,
          `${r.doc_count} ${this.t('q_rcv_docs')}${r.last_date ? ' · ' + esc(r.last_date) : ''}`)).join('')
        + '</div>';
    }
    panel.innerHTML = html;
  },

  // 点结果：落到对应板块 → 列表按该对象过滤 → 打开详情卡（不跳页、不重建搜索框）
  qSearchGo(el) {
    if (!el) return;
    const kind = el.dataset.kind;
    const key = el.dataset.key;
    const source = el.dataset.source || '';
    if (!key) return;
    this.qSearchPanelClose();
    const input = document.getElementById('q_global');
    if (input) input.blur();
    if (kind === 'material') { this.qAlertOpen(key); return; }
    if (kind === 'doc') { this._qDocsFocus = { docNo: key, source }; this.qSwitchBoard('docs'); return; }
    this._qRcvFocus = key;
    this.qSwitchBoard('receivers');
  },

  // ========== 查询中心共用：右侧详情卡骨架（库存 / 单据 / 领用人三板块共用一套） ==========
  // 每个板块的 .pu-split 都带 q-ins-split，卡片 aside 带 q-ins-insp（主卡 q-ins-main / 单据卡 q-ins-doc）；
  // open/wide/has-doc/doc-wide 与逐级点外关闭都在这一层实现，板块只提供「卡片渲染内容」。
  // 布局样式在 pages.css 的「查询中心样式包」段，静态加载，不再注入 <style>。

  // 板块 → split / 主卡 / 列表容器：三板块共用这一张映射
  qInsIds(board) {
    const map = {
      stock: { split: 'q_stock_split', main: 'q_stock_insp', scroll: 'q_stock_scroll' },
      docs: { split: 'q_docs_split', main: 'q_docs_insp', scroll: 'q_docs_scroll' },
      receivers: { split: 'q_rcv_split', main: 'q_rcv_insp', scroll: 'q_rcv_scroll' },
    };
    return map[board] || map.stock;
  },

  qInsStateKey(board) {
    return { stock: '_qCard', docs: '_qDocsCard', receivers: '_qRcvCard' }[board] || '_qCard';
  },

  // 状态对象：每个板块一份（同一时刻只挂载一张主卡）
  qInsState(board) { return this[this.qInsStateKey(board)] || null; },
  qInsSetState(board, st) { this[this.qInsStateKey(board)] = st; },

  qInsBoard() {
    return (this.qBoard === 'docs' || this.qBoard === 'receivers') ? this.qBoard : 'stock';
  },

  // 共用卡片外壳：标题 / 副标题 / 徽标 + ⤢ 原地放大 + ✕ 关闭 + 页签；宽屏没有「← 返回」
  qInsShell(board, o) {
    const tabs = (o.tabs || []).map(t => `<button type="button" class="pu-dtab" role="tab" aria-selected="${o.active === t.k}" onclick="App.qInsTab('${board}','${t.k}')">${t.label}${t.n != null ? ` ${t.n}` : ''}</button>`).join('');
    return `<div class="pu-insp-head">
        <div><h2>${o.title}${o.badge ? ' ' + o.badge : ''}</h2>${o.sub ? `<small>${o.sub}</small>` : ''}</div>
        <div style="display:flex;gap:4px">
          <button type="button" class="btn btn-outline btn-sm" title="${this.t(o.expanded ? 'pu_collapse' : 'pu_expand')}" onclick="App.qInsExpand('${board}')">${o.expanded ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" title="${this.t('close')}" onclick="App.qInsClose('${board}')">✕</button>
        </div>
      </div>
      ${tabs ? `<div class="pu-dtabs" role="tablist">${tabs}</div>` : ''}`;
  },

  qInsTab(board, tab) {
    const st = this.qInsState(board);
    if (!st || st.tab === tab) return;
    st.tab = tab;
    this.qInsResetPage(board);
    this.qInsRender(board);
  },

  // 页签切换 / 查看全部：对应表格回到第 1 页
  qInsResetPage(board) {
    const tids = board === 'docs' ? ['qdocs_lines']
      : (board === 'receivers' ? ['qrcv_docs', 'qrcv_mats'] : ['qcard']);
    tids.forEach(t => { this.getTableState(t).page = 1; });
  },

  // 页签底部「查看全部」= 就地展开并定位到该页签（列表 DOM 不动）
  qInsViewAll(board, tab) {
    const st = this.qInsState(board);
    if (!st) return;
    st.tab = tab;
    st.expanded = true;
    this.qInsResetPage(board);
    document.getElementById(this.qInsIds(board).split)?.classList.add('wide');
    this.qInsRender(board);
  },

  // 展开 / 收起：卡片原地放大，列表 DOM 不重建（筛选、页码、滚动位置不丢）
  qInsExpand(board) {
    const st = this.qInsState(board);
    if (!st) return;
    st.expanded = !st.expanded;
    const split = document.getElementById(this.qInsIds(board).split);
    if (split) {
      split.classList.toggle('wide', st.expanded);
      if (!st.expanded) this.qCardDocClose();
    }
    this.qInsRender(board);
  },

  // 打开主卡：只切布局类 + 行高亮，列表 DOM 不动
  qInsOpenDom(board, st) {
    const ids = this.qInsIds(board);
    const main = document.getElementById(ids.main);
    const split = document.getElementById(ids.split);
    if (!main || !split) return false;
    this.qInsSetState(board, st);
    main.hidden = false;
    split.classList.add('open');
    split.classList.toggle('wide', !!st.expanded);
    split.classList.remove('has-doc', 'doc-wide');
    this.qInsDocClear();
    this.qInsMark(board, st.key);
    return true;
  },

  // 关闭主卡：三板块统一入口（清状态 / 行高亮 / hash 深链）
  qInsClose(board) {
    const ids = this.qInsIds(board);
    const main = document.getElementById(ids.main);
    const split = document.getElementById(ids.split);
    if (main) { main.hidden = true; main.innerHTML = ''; }
    this.qInsDocClear();
    if (split) split.classList.remove('open', 'wide', 'has-doc', 'doc-wide');
    this.qInsMark(board, null);
    this.qInsSetState(board, null);
    if (board === 'stock') {
      this._qCardData = null;
      this._qCardRows = [];
      history.replaceState(null, '', '#query');
    } else if (board === 'docs') {
      this._qDocsCardData = null;
      this._qDocsCardRows = [];
    } else {
      this._qRcvCardData = null;
    }
  },

  // 列表行高亮（三板块统一用 .sel，行上带 data-key）
  qInsMark(board, key) {
    const root = document.getElementById(this.qInsIds(board).scroll);
    if (!root) return;
    root.querySelectorAll('tbody tr').forEach(tr => {
      tr.classList.remove('sel', 'on');
      if (key != null && tr.dataset.key === String(key)) tr.classList.add('sel');
    });
  },

  // 列表重建（排序/翻页/筛选/每页条数）后，按当前仍打开的主卡恢复高亮。
  // 卡行不在当前结果集时不强行补行，也不关卡片，只是没有高亮。
  qInsRemark(board) {
    const st = this.qInsState(board);
    this.qInsMark(board, st ? st.key : null);
  },

  qInsDocClear() {
    const box = document.getElementById('q_doc_insp');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    this._qDocData = null;
    this._qDocSrc = '';
  },

  // 主卡渲染分发：库存 / 单据 / 领用人各自的卡片内容
  qInsRender(board) {
    if (board === 'stock') return this.qCardRender();
    if (board === 'docs') return this.qDocsCardRender();
    return this.qRcvCardRender();
  },

  // ===== 单据小卡（has-doc / doc-wide）：三个板块共用 =====
  qCardDocOpen(no, row) {
    const board = this.qInsBoard();
    const st = this.qInsState(board);
    if (!st || !no) return;
    st.docNo = no;
    st.docExpanded = false;
    st.docData = null;
    st.docSrc = this.qCardDocSrc(no, row || {});
    st.expanded = true;
    const split = document.getElementById(this.qInsIds(board).split);
    if (split) { split.classList.add('open', 'wide', 'has-doc'); split.classList.remove('doc-wide'); }
    this.qInsRender(board);
    const box = document.getElementById('q_doc_insp');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = this.qCardDocHtml(board, null, st.docSrc);
    this._qDocSeq = (this._qDocSeq || 0) + 1;
    const seq = this._qDocSeq;
    const src = st.docSrc;
    (async () => {
      let d = null;
      try { d = await this.qDocFetch(src, no); } catch (_) { d = null; }
      const cur = this.qInsState(board);
      if (seq !== this._qDocSeq || !cur || cur.docNo !== no) return;
      cur.docData = d;
      this.qCardDocRender();
    })();
  },

  qCardDocRender() {
    const board = this.qInsBoard();
    const st = this.qInsState(board);
    const box = document.getElementById('q_doc_insp');
    if (!st || !box || !st.docNo) return;
    const split = document.getElementById(this.qInsIds(board).split);
    if (split) {
      split.classList.add('wide');
      split.classList.toggle('doc-wide', !!st.docExpanded);
      split.classList.toggle('has-doc', !st.docExpanded);
    }
    box.innerHTML = this.qCardDocHtml(board, st.docData, st.docSrc);
  },

  // 单据卡复用同一个只读详情渲染（单据查询 / 领用人 / 物料卡右侧单据卡共用）
  qCardDocHtml(board, d, src) {
    const st = this.qInsState(board);
    const expanded = !!(st && st.docExpanded);
    const esc = v => this.docEsc(v == null ? '' : v);
    const no = (d && (src === 'stocktake' ? d.stocktake_no : d.doc_no)) || (st && st.docNo) || '';
    const kind = src === 'returns' ? 'returns' : (src === 'stocktake' ? 'stocktake' : src);
    const headExtra = `<button type="button" class="btn btn-outline btn-sm" title="${this.t(expanded ? 'pu_collapse' : 'pu_expand')}" onclick="App.qCardDocExpand()">${expanded ? '⤡' : '⤢'}</button>`
      + `<button type="button" class="btn btn-outline btn-sm" title="${this.t('close')}" onclick="App.qCardDocClose()">✕</button>`;
    if (!d) {
      return `<div class="pu-insp-head"><div><h2>${esc(no || '–')}</h2></div><div style="display:flex;gap:4px">${headExtra}</div></div><div class="pu-dpanel"><div class="empty-state"><p>${this.t('q_no_data')}</p></div></div>`;
    }
    return this.qDocPanel(src, d, {
      closeBtn: false,
      headExtra,
      maxLines: expanded ? 0 : 5,
      related: expanded,
      foot: expanded,
      kind,
    });
  },

  qCardDocExpand() {
    const board = this.qInsBoard();
    const st = this.qInsState(board);
    if (!st || !st.docNo) return;
    st.docExpanded = !st.docExpanded;
    this.qCardDocRender();
  },

  // 关闭单据卡回到板块主卡（主卡保持展开态）
  qCardDocClose() {
    const board = this.qInsBoard();
    const st = this.qInsState(board);
    const box = document.getElementById('q_doc_insp');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    const split = document.getElementById(this.qInsIds(board).split);
    if (split) split.classList.remove('has-doc', 'doc-wide');
    if (st) { st.docNo = ''; st.docExpanded = false; st.docData = null; st.docSrc = ''; }
    this._qDocData = null;
    this._qDocSrc = '';
  },

  // 点外部空白：逐级关闭 —— 单据展开 → 单据小卡 → 板块主卡 → 列表
  qCardOutsideClick(e) {
    if (this.currentPage !== 'query') return;
    const board = this.qInsBoard();
    const st = this.qInsState(board);
    if (!st) return;
    const ids = this.qInsIds(board);
    const main = document.getElementById(ids.main);
    if (!main || main.hidden) return;
    // 列表自身的工具栏（筛选）/ 表头（排序）/ 分页属于列表内操作，不按「点外」关闭卡片
    const allow = `#q_doc_insp, #${ids.main}, #${ids.scroll} tbody tr, #${ids.scroll}, .pu-toolbar, #${ids.scroll.replace('_scroll', '_pager')}, #q-gsearch, #q-search-panel, #q_global, #modal-overlay, .pu-ov, .toast`;
    if (e.target.closest(allow)) return;
    if (st.docExpanded) { this.qCardDocExpand(); return; }
    if (st.docNo) { this.qCardDocClose(); return; }
    this.qInsClose(board);
  },

  // ========== 物料详情卡：基本信息 / 库存流水，两页签 + 原地展开 ==========
  // 进卡只取最近 5 条摘要与汇总；展开态的筛选、排序、分页全部走服务端，不再全量拉取
  async qCardOpen(code, opts) {
    if (!code) return;
    opts = opts || {};
    const insp = document.getElementById('q_stock_insp');
    if (!insp) return;
    const same = this._qCard && this._qCard.key === code && !insp.hidden;
    if (same && !opts.expanded) return;
    const st = {
      key: code,
      tab: (same && this._qCard.tab) || 'info',
      expanded: !!(opts.expanded || (same && this._qCard.expanded)),
      docNo: '', docExpanded: false,
    };
    this._qCardData = null;
    this._qCardRows = [];
    this._qCardTotal = 0;
    this._qCardFlowSeq = (this._qCardFlowSeq || 0) + 1;
    if (!this.qInsOpenDom('stock', st)) return;
    this.qCardRender();
    history.replaceState(null, '', '#query?code=' + encodeURIComponent(code));
    this._qCardSeq = (this._qCardSeq || 0) + 1;
    const seq = this._qCardSeq;
    try {
      const d = await this.api('/api/ledger/' + encodeURIComponent(code) + '?page=1&pageSize=5');
      if (seq !== this._qCardSeq || !this._qCard || this._qCard.key !== code) return;
      this._qCardData = d;
      this._qCardRows = d.rows || [];
      this._qCardTotal = d.total == null ? this._qCardRows.length : d.total;
      this.qCardRender();
    } catch (e) {
      if (seq !== this._qCardSeq) return;
      const box = document.getElementById('q_stock_insp');
      if (box) box.innerHTML = `<div class="pu-insp-head"><div><h2>${this.ibEsc(code)}</h2></div><button class="btn btn-outline btn-sm" onclick="App.qInsClose('stock')">✕</button></div><div class="pu-dpanel"><div class="empty-state"><p>${this.docEsc(e.message)}</p></div></div>`;
    }
  },

  qCardRender() {
    const box = document.getElementById('q_stock_insp');
    const st = this._qCard;
    if (!box || !st) return;
    const d = this._qCardData;
    const m = (d && d.material) || {};
    const row = (this._stockData || []).find(x => x.code === st.key) || {};
    const status = row.stock_status || m.status || '';
    const sub = [st.key, m.spec].filter(Boolean).join(' · ');
    box.innerHTML = this.qInsShell('stock', {
      title: this.docEsc(m.name || st.key),
      badge: status ? this.statusBadge(status) : '',
      sub: this.docEsc(sub),
      tabs: [
        { k: 'info', label: this.t('q_tab_info') },
        { k: 'flow', label: this.t('q_tab_flow'), n: this._qCardTotal || 0 },
      ],
      active: st.tab,
      expanded: st.expanded,
    }) + (d
      ? `<div class="pu-dpanel" id="q_card_panel">${this.qCardPanelHtml()}</div>`
      : `<div class="pu-dpanel"><div class="empty-state"><p>${this.t('q_loading')}</p></div></div>`);
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['qcard'] = () => this.qCardFlowRender();
    if (d && st.tab === 'flow' && st.expanded) this.qCardFlowRender();
  },

  qCardPanelHtml() {
    return this._qCard.tab === 'flow' ? this.qCardFlowPanel() : this.qCardInfoPanel();
  },

  qCardInfoPanel() {
    const d = this._qCardData || {};
    const m = d.material || {};
    const row = (this._stockData || []).find(x => x.code === (this._qCard && this._qCard.key)) || {};
    const esc = v => this.docEsc(v == null ? '' : v);
    const status = row.stock_status || m.status || '';
    // 无价格权限时服务端不下发 close_amount / close_avg
    const vp = 'closing_amount' in d;
    const meta = [
      [this.t('mat_code'), esc(m.code || (this._qCard && this._qCard.key))],
      [this.t('mat_name'), esc(m.name || '')],
      [this.t('mat_spec'), esc(m.spec || '')],
      [this.t('mat_category'), esc(m.category || '')],
      [this.t('mat_brand'), esc(m.brand || '')],
      [this.t('mat_unit'), esc(m.unit || '')],
      [this.t('ledger_status'), status ? this.statusBadge(status) : '–', 'q-card-status'],
    ];
    const stats = [
      [this.t('stock_on_hand'), d.closing_qty == null ? '–' : d.closing_qty],
      [this.t('stock_min'), row.min_stock == null ? '–' : row.min_stock],
      ...(vp ? [
        [this.t('ledger_balance_avg'), this.fmtMoney(d.closing_avg)],
        [this.t('stock_value'), this.fmtMoney(d.closing_amount)],
      ] : []),
    ];
    const io = this.qCardMonth();
    return `<dl class="pu-insp-meta q-card-meta">${meta.map(x => `<div${x[2] ? ` class="${x[2]}"` : ''}><dt>${x[0]}</dt><dd>${x[1]}</dd></div>`).join('')}</dl>
      <dl class="pu-insp-meta q-card-meta q-card-stock">${stats.map(k => `<div><dt>${k[0]}</dt><dd class="q-num">${k[1]}</dd></div>`).join('')}</dl>
      <div class="q-card-month">${this.t('q_month_in_qty')} <strong style="color:var(--success)">+${io.in}</strong> · ${this.t('q_month_out_qty')} <strong style="color:var(--warning)">−${io.out}</strong></div>`;
  },

  qCardFlowPanel() {
    const st = this._qCard;
    if (!st.expanded) {
      // 摘要固定取服务端返回的最近 5 条（已按时间倒序），不再本地截取全量
      const rows = (this._qCardRows || []).slice(0, 5);
      const body = rows.length
        ? rows.map(r => `<tr>
            <td>${this.ledgerDateCell(r)}</td>
            <td>${r.doc_no ? `<button type="button" class="pu-lk" onclick="App.qCardDocOpen('${this.docEsc(r.doc_no)}',{source:'${this.qCardDocSrc(r.doc_no, r)}'})"><span class="q-h-clip q-h-w-doc">${this.docEsc(r.doc_no)}</span></button>` : '–'}</td>
            <td>${this.ledgerTypeBadge(r)}</td>
            <td class="text-right">${this.qFlowQtyText(r)}</td>
            <td class="text-right">${r.balance == null ? '' : r.balance}</td>
          </tr>`).join('')
        : `<tr><td colspan="5" class="text-center">${this.t('q_no_data')}</td></tr>`;
      return `<div class="table-wrap"><table class="q-flow" style="width:100%;font-size:12px"><thead><tr><th>${this.t('q_col_time')}</th><th>${this.t('ledger_doc')}</th><th>${this.t('q_col_biz')}</th><th class="text-right">${this.t('q_qty')}</th><th class="text-right">${this.t('q_col_balance')}</th></tr></thead><tbody>${body}</tbody></table></div>
        <button type="button" class="btn btn-outline btn-sm pu-more" onclick="App.qInsViewAll('stock','flow')">${this.t('q_view_all')}</button>`;
    }
    const biz = [['', 'stock_all'], ['采购入库', 'in_purchase'], ['零星入库', 'in_other'], ['采购退货', 'in_return'], ['正常出库', 'out_normal'], ['领料退库', 'out_return'], ['盘盈', 'ledger_adj_gain'], ['盘亏', 'ledger_adj_loss'], ['其它', 'ledger_adj_other'], ['期初结存', 'ledger_opening_flow']]
      .map(o => `<option value="${o[0]}">${this.t(o[1])}</option>`).join('');
    return `<div class="pu-toolbar" style="margin:0 0 10px;padding:0">
        <div class="pu-filter-inner">
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('ledger_start')}</label><input id="q_c_start" type="date" onchange="App.qCardFlowReload()"></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('ledger_end')}</label><input id="q_c_end" type="date" onchange="App.qCardFlowReload()"></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('ledger_type')}</label><select id="q_c_type" onchange="App.qCardFlowReload()" style="border:0;background:transparent;color:var(--text);font-size:13px;min-width:104px">${biz}</select></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('q_direction')}</label><select id="q_c_dir" onchange="App.qCardFlowReload()" style="border:0;background:transparent;color:var(--text);font-size:13px;min-width:80px"><option value="">${this.t('stock_all')}</option><option value="in">${this.t('q_dir_in')}</option><option value="out">${this.t('q_dir_out')}</option><option value="adj">${this.t('q_dir_adj')}</option></select></div>
          <label style="display:inline-flex;align-items:center;gap:6px;height:34px;color:var(--text);font-size:13px;white-space:nowrap"><input type="checkbox" id="q_c_voided" style="width:auto;margin:0" onchange="App.qCardFlowReload()"> ${this.t('ledger_show_voided')}</label>
        </div>
      </div>
      <div class="data-scroll" id="q_card_flow_scroll" style="overflow-x:auto"></div>
      <div class="pu-pager" id="q_card_flow_pager"></div>`;
  },

  qCardMonth() {
    // 本月入/出数量由服务端按同一份 getFlowTotalsMap 口径算好（期初不计入、仅有效流水）
    const d = this._qCardData || {};
    return { in: d.month_in || 0, out: d.month_out || 0 };
  },

  // ========== 查询中心共用：单据徽标 / 跨板块跳转 ==========
  // 流水表样式（列宽截断、行交互、收缩策略）在 pages.css 的「查询中心样式包」段。

  qDocStatusLabel(st) {
    const map = { draft: 'q_status_draft', posted: 'q_status_posted', voided: 'q_status_voided', confirmed: 'q_status_posted' };
    return this.t(map[st] || 'q_status_posted');
  },

  qDocStatusBadge(st) {
    return `<span class="badge ${this.docStatusMeta(st).cls}">${this.qDocStatusLabel(st)}</span>`;
  },

  qDocTypeLabel(type) {
    const map = { '采购入库': 'in_purchase', '零星入库': 'in_other', '采购退货': 'in_return', '正常出库': 'out_normal', '领料退库': 'out_return', '盘点单': 'q_doc_stocktake' };
    return map[type] ? this.t(map[type]) : this.docEsc(type || '');
  },

  qDocTypeBadge(type) {
    return `<span class="badge ${this.docTypeBadgeClass(type)}">${this.qDocTypeLabel(type)}</span>`;
  },

  // 单号前缀 → 单据来源（入库 GRN / 出库 GIN / 盘点 ST）
  qDocSourceOf(no) {
    const s = String(no || '');
    if (s.startsWith('ST-')) return 'stocktake';
    if (s.startsWith('GIN-')) return 'outbound';
    return 'inbound';
  },

  // 在原模块打开该单据：入库 / 出库 / 退货退库 / 盘点
  // 各模块入口自行通过 gotoPage 同步 hash 并渲染，这里不再直接改 currentPage
  qOpenModuleDoc(kind, no) {
    if (!no) return;
    if (kind === 'stocktake') return this.openStocktake(no);
    return this.crossDocJump(kind, no);
  },

  // ========== 物料流水钻取视图（库存查询板块内） ==========

  // 数量展示口径：入库 +、出库 −、调整按带符号调整量；无数量显示空
  qFlowQtyText(r) {
    // 调整行：服务端 direction='adj'（新）或仅带 adj_type（旧响应）都按带符号调整量展示
    if (r.direction === 'adj' || r.adj_type) {
      const a = Number(r.adj_qty) || 0;
      return a > 0 ? '+' + a : (a < 0 ? '−' + Math.abs(a) : '');
    }
    if (r.direction === 'in') return r.in_qty ? '+' + r.in_qty : '';
    if (r.direction === 'out') return r.out_qty ? '−' + r.out_qty : '';
    return '';
  },

  // 单据金额：入库取明细 amount 之和，出库取 cost_amount 之和
  qDocAmount(d) {
    const lines = d && d.lines ? d.lines : [];
    return lines.reduce((s, l) => s + Number(l.amount || l.cost_amount || 0), 0);
  },

  // 关联单据 / 来源单据（直接复用各模块详情接口返回的 related_returns 与 origin_doc_no）
  // 点击在同页开单据小卡，不跳页
  qRelatedHtml(detail) {
    if (!detail) return '';
    const esc = v => this.docEsc(v == null ? '' : v);
    const srcOf = x => {
      if (x && (x.txn_type === '采购退货' || x.txn_type === '领料退库')) return 'returns';
      return this.qDocSourceOf(x && x.doc_no);
    };
    const items = [];
    if (detail.origin_doc_no) items.push({ doc_no: detail.origin_doc_no, type: this.t('q_source_doc'), status: '', src: this.qDocSourceOf(detail.origin_doc_no) });
    (detail.related_returns || []).forEach(x => items.push({ doc_no: x.doc_no, type: x.txn_type ? this.qDocTypeLabel(x.txn_type) : this.t('q_related_docs'), status: x.status, src: srcOf(x) }));
    if (!items.length) return `<div style="margin-top:12px"><div style="font-weight:600;margin-bottom:6px">${this.t('q_related_docs')}</div><div style="color:var(--text-muted);font-size:12px">${this.t('q_no_related')}</div></div>`;
    return `<div style="margin-top:12px"><div style="font-weight:600;margin-bottom:6px">${this.t('q_related_docs')}</div>
      ${items.map(x => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0">
        <button class="pu-lk" onclick="App.qCardDocOpen('${esc(x.doc_no)}',{source:'${x.src}'})">${esc(x.doc_no)}</button>
        <small style="color:var(--text-muted)">${esc(x.type)}</small>
        ${x.status ? this.qDocStatusBadge(x.status) : ''}
      </div>`).join('')}</div>`;
  },

  // ========== 库存流水（展开态）：筛选 + 完整明细 + 分页 ==========
  qCardFlowReload() {
    this.getTableState('qcard').page = 1;
    this.qCardFlowRender();
  },

  // 展开态：筛选 / 排序 / 分页全部下推服务端，每次交互只发一次台账请求
  async qCardFlowRender() {
    const d = this._qCardData;
    const scroll = document.getElementById('q_card_flow_scroll');
    const pager = document.getElementById('q_card_flow_pager');
    if (!d || !scroll || !this._qCard) return;
    const tid = 'qcard';
    const st = this.getTableState(tid);
    // 无价格权限时台账行不带 price / amount / balance_amount / balance_avg
    const vp = 'closing_amount' in d;
    const esc = v => this.docEsc(v == null ? '' : v);
    const from = document.getElementById('q_c_start')?.value || '';
    const to = document.getElementById('q_c_end')?.value || '';
    const btype = document.getElementById('q_c_type')?.value || '';
    const dir = document.getElementById('q_c_dir')?.value || '';
    const withVoid = !!document.getElementById('q_c_voided')?.checked;

    // 列：方向已由业务类型徽标表达，不再单列（14 列 / 无价格权限 10 列）
    const cols = [
      { key: 'date', label: this.t('q_col_time'), w: 84 },
      { key: 'doc_no', label: this.t('ledger_doc'), w: 146, clip: 'q-h-w-doc' },
      { key: 'business_type', label: this.t('q_col_biz'), w: 84 },
      { key: 'qty', label: this.t('q_qty'), align: 'right', w: 48 },
    ];
    if (vp) cols.push(
      { key: 'price', label: this.t('q_col_price'), align: 'right', w: 66 },
      { key: 'amount', label: this.t('ledger_amount'), align: 'right', w: 76 }
    );
    cols.push({ key: 'balance', label: this.t('q_col_balance'), align: 'right', w: 86 });
    if (vp) cols.push(
      { key: 'balance_amount', label: this.t('q_col_bal_amt'), align: 'right', w: 90 },
      { key: 'balance_avg', label: this.t('q_col_bal_avg'), align: 'right', w: 60 }
    );
    cols.push(
      { key: 'cost_basis', label: this.t('q_col_basis'), w: 92 },
      { key: 'status', label: this.t('ledger_status'), w: 56 },
      { key: 'party', label: this.t('ledger_party'), w: 124, clip: 'q-h-w-party' },
      { key: 'handler', label: this.t('in_handler'), w: 80, clip: 'q-h-w-handler' },
      { key: 'remarks', label: this.t('in_remarks'), clip: 'q-h-w-remarks', w: 124 }
    );
    // 无价格权限时，省下的金额列宽度分给单号 > 对方 > 结存，不让备注吃掉
    if (!vp) {
      const add = { doc_no: 96, party: 100, balance: 96 };
      cols.forEach(c => { if (add[c.key]) c.w += add[c.key]; });
    }
    const minW = cols.reduce((s, c) => s + (c.w || 0), 0);
    // 对方 / 经手人 / 备注是跨表回查拼装的展示值，SQL 层无对应列可排，表头不做排序
    const noSort = { qty: 1, status: 1, party: 1, handler: 1, remarks: 1 };
    const head = cols.map(c => {
      const th = noSort[c.key]
        ? `<th class="${c.align === 'right' ? 'text-right' : ''}">${c.label}</th>`
        : this.sortTh(c.label, c.key, tid, c.align === 'right');
      return c.tight ? th.replace('<th ', '<th data-tight="1" ') : th;
    }).join('');

    const p = new URLSearchParams();
    p.set('page', String(st.page));
    p.set('pageSize', String(st.pageSize));
    if (from) p.set('startDate', from);
    if (to) p.set('endDate', to);
    if (btype) p.set('bizType', btype);
    if (dir) p.set('direction', dir);
    p.set('includeVoided', withVoid ? '1' : '0');
    if (st.sortKey) { p.set('sortKey', st.sortKey); p.set('sortDir', st.sortDir); }

    const code = this._qCard.key;
    this._qCardFlowSeq = (this._qCardFlowSeq || 0) + 1;
    const seq = this._qCardFlowSeq;
    if (!scroll.innerHTML) scroll.innerHTML = `<div class="empty-state"><p>${this.t('q_loading')}</p></div>`;
    let res;
    try {
      res = await this.api('/api/ledger/' + encodeURIComponent(code) + '?' + p.toString());
    } catch (e) {
      if (seq === this._qCardFlowSeq) scroll.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`;
      return;
    }
    if (seq !== this._qCardFlowSeq || !this._qCard || this._qCard.key !== code) return;
    const pageData = res.rows || [];

    let tbody = '';
    if (!pageData.length) tbody = this.emptyRow(cols.length);
    else {
      tbody = pageData.map(r => {
        const cells = [
          `<td>${this.ledgerDateCell(r)}</td>`,
          `<td title="${esc(r.doc_no)}">${r.doc_no ? `<button type="button" class="pu-lk" onclick="App.qCardDocOpen('${esc(r.doc_no)}',{source:'${this.qCardDocSrc(r.doc_no, r)}'})"><span class="q-h-clip q-h-w-doc">${esc(r.doc_no)} ${this.docRevisionBadge(r.doc_no)}</span></button>` : '–'}</td>`,
          `<td>${this.ledgerTypeBadge(r)}</td>`,
          `<td class="text-right">${this.qFlowQtyText(r)}</td>`,
        ];
        if (vp) cells.push(
          `<td class="text-right">${r.price ? this.fmtMoney(r.price) : ''}</td>`,
          `<td class="text-right">${r.amount ? this.fmtMoney(r.amount) : ''}</td>`
        );
        cells.push(`<td class="text-right"><strong>${r.balance == null ? '' : r.balance}</strong></td>`);
        if (vp) cells.push(
          `<td class="text-right">${this.fmtMoney(r.balance_amount)}</td>`,
          `<td class="text-right">${this.fmtMoney(r.balance_avg)}</td>`
        );
        cells.push(
          `<td>${this.costBasisBadge(r.cost_basis)}</td>`,
          `<td>${r.voided ? `<span class="badge badge-muted">${this.t('ledger_voided')}</span>` : this.t('ledger_active')}</td>`,
          `<td title="${esc(r.party)}"><span class="q-h-clip q-h-w-party">${esc(r.party)}</span></td>`,
          `<td title="${esc(r.handler)}"><span class="q-h-clip q-h-w-handler">${esc(r.handler)}</span></td>`,
          `<td title="${esc(r.remarks)}"><span class="q-h-clip q-h-w-remarks">${esc(r.remarks)}</span></td>`
        );
        return `<tr class="q-row${r.voided ? ' is-voided' : ''}">${cells.join('')}</tr>`;
      }).join('');
    }
    const colgroup = `<colgroup>${cols.map(c => c.w ? `<col style="width:${c.w}px">` : '<col>').join('')}</colgroup>`;
    scroll.innerHTML = `<div class="table-wrap"><table style="min-width:${minW}px">${colgroup}<thead><tr>${head}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    pager.innerHTML = this.puPagerHtml(tid, res.total == null ? pageData.length : res.total);
  },

  // 退货/退库单据单独走 returns；单据查询行自带 source；领用人只产生出库单；其余按单号前缀定位模块
  qCardDocSrc(no, row) {
    if (row && row.source) return row.source;
    let bt = (row && row.business_type) || '';
    if (!bt && this.qBoard === 'stock') {
      const r = (this._qCardRows || []).find(x => x.doc_no === no);
      bt = (r && r.business_type) || '';
    }
    if (bt === '采购退货' || bt === '领料退库') return 'returns';
    if (this.qBoard === 'receivers') return 'outbound';
    return this.qDocSourceOf(no);
  },

  // ========== 板块 3：单据查询 ==========
  qBoardDocs(panel) {
    const types = [['', 'stock_all'], ['采购入库', 'in_purchase'], ['零星入库', 'in_other'], ['采购退货', 'in_return'], ['正常出库', 'out_normal'], ['领料退库', 'out_return'], ['盘点单', 'q_doc_stocktake']]
      .map(o => `<option value="${o[0]}">${this.t(o[1])}</option>`).join('');
    panel.innerHTML = `<div id="q-docs">
      <div class="pu-toolbar">
        <div class="pu-filter-inner">
          <div class="pu-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><input id="q_d_keyword" autocomplete="off" placeholder="${this.t('q_doc_search_ph')}" aria-label="${this.t('q_doc_search_ph')}" oninput="App.qDocsReload()"></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('q_doc_type')}</label><select id="q_d_type" onchange="App.qDocsReload()" style="border:0;background:transparent;color:var(--text);font-size:13px;min-width:104px">${types}</select></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('q_doc_status')}</label><select id="q_d_status" onchange="App.qDocsReload()" style="border:0;background:transparent;color:var(--text);font-size:13px;min-width:84px"><option value="">${this.t('stock_all')}</option><option value="draft">${this.t('q_status_draft')}</option><option value="posted">${this.t('q_status_posted')}</option><option value="voided">${this.t('q_status_voided')}</option></select></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('ledger_start')}</label><input id="q_d_start" type="date" onchange="App.qDocsReload()"></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('ledger_end')}</label><input id="q_d_end" type="date" onchange="App.qDocsReload()"></div>
        </div>
        <div class="pu-head-actions">
          <button class="btn btn-outline btn-sm" onclick="App.qDocsExport()">${this.t('doc_export')}</button>
          <button class="btn btn-outline btn-sm" onclick="App.qDocsPrint()">${this.t('doc_print')}</button>
        </div>
      </div>
      <div class="pu-split q-ins-split" id="q_docs_split">
        <section class="pu-list" style="min-width:0">
          <div class="pu-kpis" id="q_docs_kpis"></div>
          <div class="data-scroll" id="q_docs_scroll" style="overflow-x:auto"></div>
          <div class="pu-pager" id="q_docs_pager"></div>
        </section>
        <aside class="pu-insp q-ins-insp q-ins-main" id="q_docs_insp" hidden aria-label="${this.t('q_doc_head')}"></aside>
        <aside class="pu-insp q-ins-insp q-ins-doc" id="q_doc_insp" hidden aria-label="${this.t('q_doc_head')}"></aside>
      </div>
    </div>`;
    this.getTableState('docs').page = 1;
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['docs'] = () => this.qDocsTable();
    this._tableRenderers['qdocs_lines'] = () => this.qDocsCardRender();
    // 全局搜索点单据结果：先把单号写进关键字框过滤列表，再打开该单详情卡
    const focus = this._qDocsFocus;
    this._qDocsFocus = null;
    const kwEl = document.getElementById('q_d_keyword');
    if (focus && kwEl) kwEl.value = focus.docNo;
    this.qDocsTable();
    if (focus) this.qDocsCardOpen(focus.docNo, focus.source);
  },

  // 单据查询当前筛选 + 排序参数（分页参数由 includePage 控制；导出/打印用不带分页的全量）
  qDocsParams(st, includePage) {
    const p = new URLSearchParams();
    if (includePage !== false) {
      p.set('page', st.page);
      p.set('pageSize', st.pageSize);
    }
    if (st.sortKey) { p.set('sortKey', st.sortKey); p.set('sortDir', st.sortDir); }
    [['docType', 'q_d_type'], ['status', 'q_d_status'], ['startDate', 'q_d_start'], ['endDate', 'q_d_end'], ['keyword', 'q_d_keyword']]
      .forEach(([k, id]) => { const v = (document.getElementById(id)?.value || '').trim(); if (v) p.set(k, v); });
    return p;
  },

  // 服务端上限 200/页，按页取完当前筛选的全量结果
  async qDocsAllRows() {
    const st = this.getTableState('docs');
    const p = this.qDocsParams(st, false);
    p.set('page', '1');
    p.set('pageSize', '200');
    const first = await this.api('/api/query/docs?' + p.toString());
    let rows = first.rows || [];
    const total = Number(first.total || 0);
    for (let page = 2; rows.length < total; page++) {
      p.set('page', String(page));
      const d = await this.api('/api/query/docs?' + p.toString());
      const batch = d.rows || [];
      if (!batch.length) break;
      rows = rows.concat(batch);
    }
    return { rows, total, vp: 'amount' in (first.totals || {}) };
  },

  qDocsDoc() {
    const rows = this._qDocsExportRows || [];
    const vp = !!this._qDocsExportVp;
    const optText = id => {
      const el = document.getElementById(id);
      return el && el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '';
    };
    const val = id => (document.getElementById(id)?.value || '').trim();
    const meta = this.qExportMeta([
      [this.t('q_doc_type'), val('q_d_type') ? optText('q_d_type') : ''],
      [this.t('q_doc_status'), val('q_d_status') ? optText('q_d_status') : ''],
      [this.t('ledger_start'), val('q_d_start')],
      [this.t('ledger_end'), val('q_d_end')],
      [this.t('q_doc_search'), val('q_d_keyword')]
    ], rows.length);
    const cols = [
      { key: 'doc_no', label: this.t('ledger_doc') },
      { key: 'doc_type', label: this.t('q_doc_type') },
      { key: 'date', label: this.t('ledger_date'), value: r => this.fmtDate(r.date) },
      { key: 'party', label: this.t('q_doc_party') }
    ];
    if (vp) cols.push({ key: 'amount', label: this.t('ledger_amount'), align: 'right', value: r => this.fmtMoney(r.amount) });
    cols.push(
      { key: 'status', label: this.t('ledger_status'), value: r => this.qDocStatusLabel(r.status) },
      { key: 'handler', label: this.t('in_handler') }
    );
    return {
      title: this.t('q_tab_docs'),
      meta,
      columns: cols,
      rows,
      filename: `${this.t('q_tab_docs')}_${this.today().replace(/-/g, '')}.csv`
    };
  },

  async qDocsExport() {
    try { await this.qDocsPrepare(); } catch (e) { this.toast(e.message); return; }
    const doc = this.qDocsDoc();
    this.qListCsv(doc);
    this.toast(this.t('doc_export_done', { name: doc.filename }));
  },

  async qDocsPrint() {
    try { await this.qDocsPrepare(); } catch (e) { this.toast(e.message); return; }
    this.printDoc(this.qDocsDoc());
  },

  qDocsPrepare() {
    return this.qDocsAllRows().then(d => {
      this._qDocsExportRows = d.rows;
      this._qDocsExportVp = d.vp;
    });
  },

  qDocsReload() {
    clearTimeout(this._qDocsTimer);
    this._qDocsTimer = setTimeout(() => {
      this.getTableState('docs').page = 1;
      this.qDocsTable();
    }, 260);
  },

  async qDocsTable() {
    if (!document.getElementById('q_docs_scroll')) return;
    const tid = 'docs';
    const st = this.getTableState(tid);
    const p = this.qDocsParams(st);
    this._qDocsSeq = (this._qDocsSeq || 0) + 1;
    const seq = this._qDocsSeq;
    try {
      const d = await this.api('/api/query/docs?' + p.toString());
      if (seq !== this._qDocsSeq) return;
      this.qDocsRender(d);
    } catch (e) {
      const el = document.getElementById('q_docs_scroll');
      if (el) el.innerHTML = `<div class="empty-state"><p>${this.docEsc(e.message)}</p></div>`;
    }
  },

  qDocsRender(d) {
    const tid = 'docs';
    // 无价格权限时 totals 里没有 amount；单据卡复用同一判定
    const vp = 'amount' in (d.totals || {});
    this._qPriceOn = vp;
    const esc = v => this.docEsc(v == null ? '' : v);
    const cols = [
      { key: 'doc_no', label: this.t('ledger_doc'), clip: 'q-h-w-doc' },
      { key: 'doc_type', label: this.t('q_doc_type'), tight: true },
      { key: 'date', label: this.t('ledger_date') },
      { key: 'party', label: this.t('q_doc_party'), clip: 'q-h-w-doc' },
    ];
    if (vp) cols.push({ key: 'amount', label: this.t('ledger_amount'), align: 'right' });
    cols.push(
      { key: 'status', label: this.t('ledger_status'), tight: true },
      { key: 'handler', label: this.t('in_handler'), clip: 'q-h-w-handler' }
    );
    const head = cols.map(c => {
      const th = this.sortTh(c.label, c.key, tid, c.align === 'right');
      return c.tight ? th.replace('<th ', '<th data-tight="1" ') : th;
    }).join('');

    let tbody = '';
    if (!d.rows.length) tbody = this.emptyRow(cols.length);
    else {
      tbody = d.rows.map(r => {
        const cells = [
          `<td title="${esc(r.doc_no)}"><button type="button" class="pu-lk${r.status === 'voided' ? ' is-voided' : ''}"><span class="q-h-clip q-h-w-doc">${esc(r.doc_no)}</span></button></td>`,
          `<td>${this.qDocTypeBadge(r.doc_type)}</td>`,
          `<td>${esc(r.date)}</td>`,
          `<td title="${esc(r.party)}"><span class="q-h-clip q-h-w-doc">${esc(r.party)}</span></td>`,
        ];
        if (vp) cells.push(`<td class="text-right">${r.amount == null ? '–' : this.fmtMoney(r.amount)}</td>`);
        cells.push(
          `<td>${this.qDocStatusBadge(r.status)}</td>`,
          `<td title="${esc(r.handler)}"><span class="q-h-clip q-h-w-handler">${esc(r.handler)}</span></td>`
        );
        return `<tr class="q-row${r.status === 'voided' ? ' is-voided' : ''}" data-key="${esc(r.doc_no)}" onclick="App.qDocsCardOpen('${esc(r.doc_no)}','${r.source}')">${cells.join('')}</tr>`;
      }).join('');
    }
    const t = d.totals || {};
    const kpis = [[this.t('q_doc_count'), d.total]];
    if (vp) kpis.push([this.t('q_doc_amount'), t.amount == null ? '–' : this.fmtMoney(t.amount)]);
    document.getElementById('q_docs_kpis').innerHTML = kpis.map(k => `<div class="pu-kpi"><small>${k[0]}</small><strong>${k[1]}</strong></div>`).join('');
    document.getElementById('q_docs_scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('q_docs_pager').innerHTML = this.puPagerHtml(tid, d.total);
    this.qInsRemark('docs');
  },

  qDocsClose() { this.qInsClose('docs'); },

  // 各模块只读详情接口：单据卡 / 单据查询卡 / 关联单据共用同一入口
  qDocFetch(source, no) {
    if (source === 'stocktake') return this.api('/api/stocktakes/' + encodeURIComponent(no));
    if (source === 'returns') return this.api('/api/returns/docs/' + encodeURIComponent(no));
    if (source === 'outbound') return this.api('/api/outbound-docs/' + encodeURIComponent(no));
    return this.api('/api/inbound-docs/' + encodeURIComponent(no));
  },

  qDocTypeOf(source, d) {
    if (!d) return '';
    if (source === 'stocktake') return '盘点单';
    if (source === 'returns') return d.sub_type || '';
    return d.txn_type || '';
  },

  qDocStatusOf(source, d) {
    if (!d) return '';
    if (source === 'stocktake') return d.status === 'confirmed' ? 'posted' : d.status;
    return d.status;
  },

  qDocKindOf(source, d) {
    const type = this.qDocTypeOf(source, d);
    if (type === '采购退货' || type === '领料退库') return 'returns';
    return source === 'stocktake' ? 'stocktake' : source;
  },

  // 单据查询：点行开卡（不跳页），页签 = 基本信息 / 单据明细 / 关联单据
  async qDocsCardOpen(no, source) {
    if (!no) return;
    const insp = document.getElementById('q_docs_insp');
    if (!insp) return;
    if (this._qDocsCard && this._qDocsCard.key === no && !insp.hidden) return;
    const st = {
      key: no,
      source: source || this.qDocSourceOf(no),
      tab: 'info',
      expanded: false,
      docNo: '', docExpanded: false,
    };
    this._qDocsCardData = null;
    this._qDocsCardRows = [];
    if (!this.qInsOpenDom('docs', st)) return;
    this.qDocsCardRender();
    this._qDocsCardSeq = (this._qDocsCardSeq || 0) + 1;
    const seq = this._qDocsCardSeq;
    let d = null;
    try { d = await this.qDocFetch(st.source, no); } catch (_) { d = null; }
    if (seq !== this._qDocsCardSeq || !this._qDocsCard || this._qDocsCard.key !== no) return;
    this._qDocsCardData = d;
    this._qDocsCardRows = (d && d.lines) || [];
    this.qDocsCardRender();
  },

  qDocsCardRender() {
    const box = document.getElementById('q_docs_insp');
    const st = this._qDocsCard;
    if (!box || !st) return;
    const d = this._qDocsCardData;
    const sc = st.source;
    const lines = (d && d.lines) || [];
    const head = this.qInsShell('docs', {
      title: this.docEsc(st.key),
      sub: d ? this.qDocTypeLabel(this.qDocTypeOf(sc, d)) : '',
      badge: d ? this.qDocStatusBadge(this.qDocStatusOf(sc, d)) : '',
      tabs: [
        { k: 'info', label: this.t('q_tab_info') },
        { k: 'lines', label: this.t('q_tab_lines'), n: lines.length },
        { k: 'related', label: this.t('q_related_docs') },
      ],
      active: st.tab,
      expanded: st.expanded,
    });
    if (!d) {
      box.innerHTML = head + `<div class="pu-dpanel"><div class="empty-state"><p>${this.t('q_loading')}</p></div></div>`;
      return;
    }
    // 无论窄卡还是展开态，都只渲染当前页签的内容：展开 = 完整表格（+分页），窄卡 = 摘要 5 条
    let body;
    if (st.tab === 'lines') {
      const tid = 'qdocs_lines';
      if (st.expanded) {
        const ps = this.getTableState(tid);
        body = this.qDocPanel(sc, d, { section: 'lines', maxLines: 0, rows: this.paginate(lines, ps.page, ps.pageSize) })
          + (lines.length > ps.pageSize ? `<div class="pu-pager" style="margin-top:8px">${this.puPagerHtml(tid, lines.length)}</div>` : '');
      } else {
        body = this.qDocPanel(sc, d, { section: 'lines', maxLines: 5 })
          + (lines.length > 5 ? `<button type="button" class="btn btn-outline btn-sm pu-more" onclick="App.qInsViewAll('docs','lines')">${this.t('q_view_all')}</button>` : '');
      }
    } else if (st.tab === 'related') {
      body = this.qDocPanel(sc, d, { section: 'related' });
    } else {
      body = this.qDocPanel(sc, d, { section: 'meta', showNo: true });
    }
    box.innerHTML = head
      + `<div class="pu-dpanel">${body}</div>`
      + `<div class="pu-insp-foot"><button class="btn btn-primary" onclick="App.qOpenModuleDoc('${this.qDocKindOf(sc, d)}','${this.docEsc(st.key)}')">${this.t('q_open_module')}</button></div>`;
  },

  // 单据只读详情：头摘要 + 明细行 + 关联/来源 + 状态 + 原模块跳转
  // opts：{closeBtn, headExtra, maxLines, related, foot, footExtra, kind}，供物料卡右侧单据卡复用
  qDocPanel(source, d, opts) {
    opts = opts || {};
    const esc = v => this.docEsc(v == null ? '' : v);
    const isSt = source === 'stocktake';
    const isRet = source === 'returns';
    const no = isSt ? d.stocktake_no : d.doc_no;
    const type = isSt ? '盘点单' : (isRet ? (d.sub_type || '') : (d.txn_type || ''));
    const status = isSt ? (d.status === 'confirmed' ? 'posted' : d.status) : d.status;
    const party = isSt ? '' : (isRet ? (d.party || '') : (d.supplier || [d.destination, d.receiver].filter(Boolean).join(' / ')));
    const lines = d.lines || [];
    // 单据卡读的是各业务模块详情接口：无价格权限时服务端已删键，
    // 这里直接按详情本身的字段判断，避免再依赖列表页的 _qPriceOn
    const vp = isSt
      ? false
      : (d.summary && 'total_amount' in d.summary) ||
        (lines.length > 0 && ('price' in lines[0] || 'cost_price' in lines[0]));
    const amount = isRet && d.summary && d.summary.total_amount != null ? d.summary.total_amount : this.qDocAmount(d);
    const meta = [
      [this.t('ledger_date'), esc(d.date || '')],
      [this.t('q_doc_type'), this.qDocTypeBadge(type)],
      [this.t('q_doc_status'), this.qDocStatusBadge(status)],
      [this.t('q_doc_party'), esc(party || '–')],
      [this.t('in_handler'), esc(d.handler || '–')],
      [this.t('q_doc_lines'), lines.length],
    ];
    if (vp && !isSt) meta.push([this.t('ledger_amount'), this.fmtMoney(amount)]);
    if (d.remarks) meta.push([this.t('in_remarks'), esc(d.remarks)]);
    if (opts.showNo) meta.unshift([this.t('ledger_doc'), esc(no)]);

    const header = isSt
      ? `<tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th class="text-right">${this.t('st_book_qty')}</th><th class="text-right">${this.t('st_count_qty')}</th><th class="text-right">${this.t('st_diff_qty')}</th></tr>`
      : `<tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th class="text-right">${this.t('q_qty')}</th>${vp ? `<th class="text-right">${this.t('ledger_price')}</th><th class="text-right">${this.t('ledger_amount')}</th>` : ''}</tr>`;
    const shown = opts.rows || (opts.maxLines ? lines.slice(0, opts.maxLines) : lines);
    const rows = shown.length
      ? shown.map(l => isSt
        ? `<tr><td>${esc(l.code)}</td><td title="${esc(l.material_name)}"><span class="q-h-clip q-h-w-name">${esc(l.material_name)}</span></td><td class="text-right">${l.book_qty}</td><td class="text-right">${l.count_qty == null ? '–' : l.count_qty}</td><td class="text-right" style="color:${l.diff_qty > 0 ? 'var(--success)' : (l.diff_qty < 0 ? 'var(--danger)' : 'inherit')}">${l.diff_qty > 0 ? '+' + l.diff_qty : l.diff_qty}</td></tr>`
        : `<tr><td>${esc(l.code)}</td><td title="${esc(l.material_name)}"><span class="q-h-clip q-h-w-name">${esc(l.material_name)}</span></td><td class="text-right">${l.qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(l.price || l.cost_price || 0)}</td><td class="text-right">${this.fmtMoney(l.amount || l.cost_amount || 0)}</td>` : ''}</tr>`)
        .join('')
      : `<tr><td colspan="${isSt ? 5 : (vp ? 5 : 3)}" class="text-center">${this.t('q_no_data')}</td></tr>`;
    const more = opts.maxLines && lines.length > opts.maxLines
      ? `<div style="margin-top:6px;font-size:11px;color:var(--text-muted)">${this.t('q_flow_more').replace('{n}', lines.length - opts.maxLines)}</div>` : '';
    const kind = opts.kind || ((type === '采购退货' || type === '领料退库') ? 'returns' : (isSt ? 'stocktake' : source));
    // 分段渲染：单据查询 / 领用人详情卡按页签取用，其余调用方不传 section 时保持整卡输出
    if (opts.section === 'meta') {
      return `<dl class="pu-insp-meta" style="margin:0 0 10px">${meta.map(x => `<div><dt>${x[0]}</dt><dd>${x[1]}</dd></div>`).join('')}</dl>`;
    }
    if (opts.section === 'lines') {
      return `<div style="font-weight:600;margin-bottom:6px">${this.t('q_doc_lines')}</div>
        <div class="table-wrap"><table class="q-flow"><thead>${header}</thead><tbody>${rows}</tbody></table></div>
        ${more}`;
    }
    if (opts.section === 'related') {
      return this.qRelatedHtml(d)
        + (isSt && d.summary ? `<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">${this.t('st_gain')}: ${d.summary.gain_qty} · ${this.t('st_loss')}: ${d.summary.loss_qty}</div>` : '');
    }
    const closeBtn = opts.closeBtn === false ? '' : `<button class="btn btn-outline btn-sm" onclick="App.qDocsClose()">${this.t('close')}</button>`;
    const foot = opts.foot === false ? '' : `<div class="pu-insp-foot" style="gap:8px">${opts.footExtra || ''}<button class="btn btn-primary" onclick="App.qOpenModuleDoc('${kind}','${esc(no)}')">${this.t('q_open_module')}</button></div>`;
    return `<div class="pu-insp-head"><div><h2>${esc(no)} ${this.qDocStatusBadge(status)}</h2><small>${this.qDocTypeBadge(type)} · ${esc(d.date || '')}</small></div><div style="display:flex;gap:4px">${closeBtn}${opts.headExtra || ''}</div></div>
      <div class="pu-dpanel">
        <dl class="pu-insp-meta" style="margin:0 0 10px">${meta.map(x => `<div><dt>${x[0]}</dt><dd>${x[1]}</dd></div>`).join('')}</dl>
        <div style="font-weight:600;margin-bottom:6px">${this.t('q_doc_lines')}</div>
        <div class="table-wrap"><table class="q-flow"><thead>${header}</thead><tbody>${rows}</tbody></table></div>
        ${more}
        ${opts.related === false ? '' : this.qRelatedHtml(d)}
        ${isSt && d.summary ? `<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">${this.t('st_gain')}: ${d.summary.gain_qty} · ${this.t('st_loss')}: ${d.summary.loss_qty}</div>` : ''}
      </div>
      ${foot}`;
  },

  // ========== 板块 5：领用人查询 ==========
  qBoardReceivers(panel) {
    panel.innerHTML = `<div id="q-rcv">
      <div class="pu-toolbar">
        <div class="pu-filter-inner">
          <div class="pu-search" style="flex:1 1 220px;max-width:300px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
            <input id="q_r_kw" autocomplete="off" placeholder="${this.t('q_rcv_search_ph')}" oninput="App.qReceiversFilter()">
          </div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('ledger_start')}</label><input id="q_r_start" type="date" onchange="App.qReceiversFilter()"></div>
          <div class="pu-daterange"><label style="white-space:nowrap">${this.t('ledger_end')}</label><input id="q_r_end" type="date" onchange="App.qReceiversFilter()"></div>
        </div>
        <div class="pu-head-actions">
          <button class="btn btn-outline btn-sm" onclick="App.qReceiversExport()">${this.t('doc_export')}</button>
          <button class="btn btn-outline btn-sm" onclick="App.qReceiversPrint()">${this.t('doc_print')}</button>
        </div>
      </div>
      <div style="margin:0 0 10px;padding:8px 12px;border:1px dashed var(--border);border-radius:var(--radius-sm);color:var(--text-muted);font-size:12px">${this.t('q_rcv_rule')}</div>
      <div class="pu-split q-ins-split" id="q_rcv_split">
        <section class="pu-list" style="min-width:0">
          <div class="data-scroll" id="q_rcv_scroll" style="overflow-x:auto"></div>
          <div class="pu-pager" id="q_rcv_pager"></div>
        </section>
        <aside class="pu-insp q-ins-insp q-ins-main" id="q_rcv_insp" hidden aria-label="${this.t('q_rcv_docs_title')}"></aside>
        <aside class="pu-insp q-ins-insp q-ins-doc" id="q_doc_insp" hidden aria-label="${this.t('q_doc_head')}"></aside>
      </div>
    </div>`;
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['receivers'] = () => this.qReceiversTable();
    this._tableRenderers['qrcv_docs'] = () => this.qRcvCardRender();
    this._tableRenderers['qrcv_mats'] = () => this.qRcvCardRender();
    // 全局搜索点领用人结果：先按姓名过滤列表，再打开其详情卡
    const focus = this._qRcvFocus;
    this._qRcvFocus = null;
    const kwEl = document.getElementById('q_r_kw');
    if (focus && kwEl) kwEl.value = focus;
    this.qReceiversLoad();
    if (focus) this.qReceiverDetail(focus);
  },

  qReceiversFilter() {
    clearTimeout(this._qRcvTimer);
    this._qRcvTimer = setTimeout(() => {
      this.getTableState('receivers').page = 1;
      this.qReceiversLoad();
    }, 260);
  },

  async qReceiversLoad() {
    const scroll = document.getElementById('q_rcv_scroll');
    if (scroll) scroll.innerHTML = `<div class="empty-state"><p>${this.t('q_loading')}</p></div>`;
    const p = new URLSearchParams();
    const kw = (document.getElementById('q_r_kw')?.value || '').trim();
    const from = document.getElementById('q_r_start')?.value || '';
    const to = document.getElementById('q_r_end')?.value || '';
    if (kw) p.set('keyword', kw);
    if (from) p.set('startDate', from);
    if (to) p.set('endDate', to);
    this._qRcvSeq = (this._qRcvSeq || 0) + 1;
    const seq = this._qRcvSeq;
    try {
      const d = await this.api('/api/query/receivers?' + p.toString());
      if (seq !== this._qRcvSeq) return;
      this._qRcvData = d.rows || [];
      this.qReceiversTable();
    } catch (e) {
      if (scroll) scroll.innerHTML = `<div class="empty-state"><p>${this.docEsc(e.message)}</p></div>`;
    }
  },

  // 领用人当前筛选 + 排序的全量行（列表与导出共用）
  qReceiversRows() {
    const data = this._qRcvData || [];
    const st = this.getTableState('receivers');
    const vp = data.length ? ('amount' in data[0]) : false;
    if (data.length) this._qPriceOn = vp;
    return { st, vp, sorted: this.sortData(data, st.sortKey, st.sortDir) };
  },

  qReceiversDoc() {
    const { vp, sorted } = this.qReceiversRows();
    const val = id => (document.getElementById(id)?.value || '').trim();
    const meta = this.qExportMeta([
      [this.t('q_keyword'), val('q_r_kw')],
      [this.t('ledger_start'), val('q_r_start')],
      [this.t('ledger_end'), val('q_r_end')]
    ], sorted.length);
    const cols = [
      { key: 'receiver', label: this.t('out_receiver') },
      { key: 'doc_count', label: this.t('q_rcv_docs'), align: 'right' },
      { key: 'material_kinds', label: this.t('q_rcv_kinds'), align: 'right' },
      { key: 'out_qty', label: this.t('q_rcv_out_qty'), align: 'right' },
      { key: 'returned_qty', label: this.t('q_rcv_returned'), align: 'right' },
      { key: 'net_qty', label: this.t('q_rcv_net'), align: 'right' }
    ];
    if (vp) cols.push({ key: 'amount', label: this.t('q_rcv_amount'), align: 'right', value: r => this.fmtMoney(r.amount || 0) });
    cols.push({ key: 'last_date', label: this.t('q_rcv_last'), value: r => this.fmtDate(r.last_date) });
    return {
      title: this.t('q_tab_receivers'),
      meta,
      columns: cols,
      rows: sorted,
      filename: `${this.t('q_tab_receivers')}_${this.today().replace(/-/g, '')}.csv`
    };
  },

  qReceiversExport() {
    const doc = this.qReceiversDoc();
    this.qListCsv(doc);
    this.toast(this.t('doc_export_done', { name: doc.filename }));
  },

  qReceiversPrint() {
    this.printDoc(this.qReceiversDoc());
  },

  qReceiversTable() {
    const data = this._qRcvData;
    if (!data || !document.getElementById('q_rcv_scroll')) return;
    const tid = 'receivers';
    const { st, vp, sorted } = this.qReceiversRows();
    const esc = v => this.docEsc(v == null ? '' : v);
    const pageData = this.paginate(sorted, st.page, st.pageSize);

    const cols = [
      { key: 'receiver', label: this.t('out_receiver') },
      { key: 'doc_count', label: this.t('q_rcv_docs'), align: 'right' },
      { key: 'material_kinds', label: this.t('q_rcv_kinds'), align: 'right' },
      { key: 'out_qty', label: this.t('q_rcv_out_qty'), align: 'right' },
      { key: 'returned_qty', label: this.t('q_rcv_returned'), align: 'right' },
      { key: 'net_qty', label: this.t('q_rcv_net'), align: 'right' },
    ];
    if (vp) cols.push({ key: 'amount', label: this.t('q_rcv_amount'), align: 'right' });
    cols.push({ key: 'last_date', label: this.t('q_rcv_last') });
    const head = cols.map(c => this.sortTh(c.label, c.key, tid, c.align === 'right')).join('');

    let tbody = '';
    if (!pageData.length) tbody = this.emptyRow(cols.length);
    else {
      tbody = pageData.map(r => {
        const cells = [
          `<td title="${esc(r.receiver)}"><span class="q-h-clip q-h-w-party">${esc(r.receiver)}</span></td>`,
          `<td class="text-right">${r.doc_count}</td>`,
          `<td class="text-right">${r.material_kinds}</td>`,
          `<td class="text-right">${r.out_qty}</td>`,
          `<td class="text-right">${r.returned_qty || ''}</td>`,
          `<td class="text-right"><strong>${r.net_qty}</strong></td>`,
        ];
        if (vp) cells.push(`<td class="text-right">${this.fmtMoney(r.amount || 0)}</td>`);
        cells.push(`<td>${esc(r.last_date)}</td>`);
        return `<tr class="q-row" data-key="${esc(r.receiver)}" onclick="App.qReceiverDetail('${esc(r.receiver)}')">${cells.join('')}</tr>`;
      }).join('');
    }
    document.getElementById('q_rcv_scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('q_rcv_pager').innerHTML = this.puPagerHtml(tid, data.length);
    this.qInsRemark('receivers');
  },

  qReceiverClose() { this.qInsClose('receivers'); },

  // 领用人：点行开卡（不跳页），页签 = 基本信息 / 领用单据 / 物料构成
  async qReceiverDetail(name) {
    if (!name) return;
    const insp = document.getElementById('q_rcv_insp');
    if (!insp) return;
    if (this._qRcvCard && this._qRcvCard.key === name && !insp.hidden) return;
    const st = { key: name, tab: 'info', expanded: false, docNo: '', docExpanded: false };
    this._qRcvCardData = null;
    if (!this.qInsOpenDom('receivers', st)) return;
    this.qRcvCardRender();
    this._qRcvCardSeq = (this._qRcvCardSeq || 0) + 1;
    const seq = this._qRcvCardSeq;
    let d = null;
    try { d = await this.api('/api/query/receivers/' + encodeURIComponent(name)); } catch (_) { d = null; }
    if (seq !== this._qRcvCardSeq || !this._qRcvCard || this._qRcvCard.key !== name) return;
    this._qRcvCardData = d;
    this.qRcvCardRender();
  },

  qRcvCardRender() {
    const box = document.getElementById('q_rcv_insp');
    const st = this._qRcvCard;
    if (!box || !st) return;
    const d = this._qRcvCardData;
    const docs = (d && d.rows) || [];
    const mats = (d && d.materials) || [];
    const head = this.qInsShell('receivers', {
      title: this.docEsc(st.key),
      sub: this.t('q_rcv_docs_title'),
      tabs: [
        { k: 'info', label: this.t('q_tab_info') },
        { k: 'docs', label: this.t('q_rcv_docs_title'), n: docs.length },
        { k: 'mats', label: this.t('q_tab_materials'), n: mats.length },
      ],
      active: st.tab,
      expanded: st.expanded,
    });
    if (!d) {
      box.innerHTML = head + `<div class="pu-dpanel"><div class="empty-state"><p>${this.t('q_loading')}</p></div></div>`;
      return;
    }
    // 同上：展开态保留页签，只把当前页签切成完整表格（+分页），不纵向堆叠
    const limit = st.expanded ? 0 : 5;
    const body = st.tab === 'docs' ? this.qRcvDocsHtml(docs, limit)
      : (st.tab === 'mats' ? this.qRcvMatsHtml(mats, limit) : this.qRcvInfoHtml(d.summary || {}));
    box.innerHTML = head + `<div class="pu-dpanel">${body}</div>`;
  },

  qRcvInfoHtml(s) {
    // 无价格权限时 summary 里没有 amount
    const vp = 'amount' in s;
    const st = this._qRcvCard || {};
    const row = (this._qRcvData || []).find(x => x.receiver === st.key) || {};
    const esc = v => this.docEsc(v == null ? '' : v);
    const meta = [
      [this.t('out_receiver'), esc(st.key)],
      [this.t('q_rcv_docs'), s.doc_count || 0],
      [this.t('q_rcv_kinds'), row.material_kinds == null ? '–' : row.material_kinds],
      [this.t('q_rcv_out_qty'), s.qty || 0],
      ...(vp ? [[this.t('q_rcv_amount'), this.fmtMoney(s.amount || 0)]] : []),
      [this.t('q_rcv_last'), esc(row.last_date || '–')],
      [this.t('q_rcv_returned'), s.returned_qty || 0],
      [this.t('q_rcv_net'), `<strong>${s.net_qty || 0}</strong>`],
    ];
    return `<dl class="pu-insp-meta" style="margin:0 0 10px">${meta.map(x => `<div><dt>${x[0]}</dt><dd>${x[1]}</dd></div>`).join('')}</dl>
      <div style="font-size:12px;color:var(--text-muted)">${this.t('q_rcv_rule')}</div>`;
  },

  qRcvDocsHtml(rows, limit) {
    // 详情汇总里没有 amount 即无价格权限（rows 可能为空，统一看 summary）
    const vp = 'amount' in (((this._qRcvCardData || {}).summary) || {});
    const esc = v => this.docEsc(v == null ? '' : v);
    const tid = 'qrcv_docs';
    let shown = rows;
    let pager = '';
    if (limit) shown = rows.slice(0, limit);
    else {
      const ps = this.getTableState(tid);
      shown = this.paginate(rows, ps.page, ps.pageSize);
      if (rows.length > ps.pageSize) pager = `<div class="pu-pager" style="margin-top:8px">${this.puPagerHtml(tid, rows.length)}</div>`;
    }
    const body = shown.length ? shown.map(x => `<tr${x.status === 'voided' ? ' class="is-voided"' : ''}>
        <td><button class="pu-lk${x.status === 'voided' ? ' is-voided' : ''}" onclick="App.qCardDocOpen('${esc(x.doc_no)}',{source:'outbound'})">${esc(x.doc_no)}</button></td>
        <td>${esc(x.date)}</td>
        <td class="text-right">${x.qty}</td>
        ${vp ? `<td class="text-right">${this.fmtMoney(x.amount || 0)}</td>` : ''}
        <td>${this.qDocStatusBadge(x.status)}</td>
      </tr>`).join('') : `<tr><td colspan="${vp ? 5 : 4}" class="text-center">${this.t('q_no_data')}</td></tr>`;
    const more = limit && rows.length > limit
      ? `<button type="button" class="btn btn-outline btn-sm pu-more" onclick="App.qInsViewAll('receivers','docs')">${this.t('q_view_all')}</button>` : '';
    return `<div style="font-weight:600;margin-bottom:6px">${this.t('q_rcv_docs_title')}</div>
      <div class="table-wrap"><table class="q-flow"><thead><tr><th>${this.t('ledger_doc')}</th><th>${this.t('ledger_date')}</th><th class="text-right">${this.t('q_qty')}</th>${vp ? `<th class="text-right">${this.t('ledger_amount')}</th>` : ''}<th>${this.t('ledger_status')}</th></tr></thead><tbody>${body}</tbody></table></div>${more}${pager}`;
  },

  qRcvMatsHtml(mats, limit) {
    const vp = 'amount' in (((this._qRcvCardData || {}).summary) || {});
    const esc = v => this.docEsc(v == null ? '' : v);
    const tid = 'qrcv_mats';
    let shown = mats;
    let pager = '';
    if (limit) shown = mats.slice(0, limit);
    else {
      const ps = this.getTableState(tid);
      shown = this.paginate(mats, ps.page, ps.pageSize);
      if (mats.length > ps.pageSize) pager = `<div class="pu-pager" style="margin-top:8px">${this.puPagerHtml(tid, mats.length)}</div>`;
    }
    const body = shown.length ? shown.map(m => `<tr>
        <td>${esc(m.code)}</td>
        <td title="${esc(m.name)}"><span class="q-h-clip q-h-w-name">${esc(m.name)}</span></td>
        <td class="text-right">${m.qty}</td>
        ${vp ? `<td class="text-right">${this.fmtMoney(m.amount || 0)}</td>` : ''}
      </tr>`).join('') : `<tr><td colspan="${vp ? 4 : 3}" class="text-center">${this.t('q_no_data')}</td></tr>`;
    const more = limit && mats.length > limit
      ? `<button type="button" class="btn btn-outline btn-sm pu-more" onclick="App.qInsViewAll('receivers','mats')">${this.t('q_view_all')}</button>` : '';
    return `<div style="font-weight:600;margin-bottom:6px">${this.t('q_tab_materials')}</div>
      <div class="table-wrap"><table class="q-flow"><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th class="text-right">${this.t('q_qty')}</th>${vp ? `<th class="text-right">${this.t('ledger_amount')}</th>` : ''}</tr></thead><tbody>${body}</tbody></table></div>${more}${pager}`;
  },

  // ========== 板块 6：库存分析 ==========
  // 子页签：概览（原有低库存/类别/趋势）/ 呆滞 / ABC / 周转率；不新增顶级页签
  qAnTabs() {
    return [
      ['overview', 'q_an_tab_overview'],
      ['stagnant', 'q_an_tab_stagnant'],
      ['abc', 'q_an_tab_abc'],
      ['turnover', 'q_an_tab_turnover'],
    ];
  },

  async qBoardAnalysis(panel) {
    if (!this._qAnTab) this._qAnTab = 'overview';
    panel.innerHTML = `<div id="q-analysis">
      <nav class="pu-viewtabs q-an-subtabs" id="q_an_tabs" role="tablist">
        ${this.qAnTabs().map(([k, label]) => `<button type="button" class="pu-viewtab" role="tab" data-an="${k}" aria-selected="${this._qAnTab === k}" onclick="App.qAnSwitch('${k}')">${this.t(label)}</button>`).join('')}
      </nav>
      <div id="q_an_body"></div>
    </div>`;
    return this.qAnRenderBody();
  },

  qAnSwitch(key) {
    if (!this.qAnTabs().some(t => t[0] === key)) return;
    this._qAnTab = key;
    document.querySelectorAll('#q_an_tabs .pu-viewtab').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.an === key));
    });
    return this.qAnRenderBody();
  },

  qAnRenderBody() {
    const body = document.getElementById('q_an_body');
    if (!body) return;
    if (this._qAnTab === 'stagnant') return this.qAnStagnant(body);
    if (this._qAnTab === 'abc') return this.qAnAbc(body);
    if (this._qAnTab === 'turnover') return this.qAnTurnover(body);
    return this.qAnOverview(body);
  },

  // ---------- 概览 ----------
  async qAnOverview(panel) {
    panel.innerHTML = `<div id="q_an_overview">
      <div class="pu-kpis" id="q_an_kpis"></div>
      <div class="q-an-grid">
        <div class="q-an-card"><h3>${this.t('q_an_category')}</h3><div id="q_an_cat"></div></div>
        <div class="q-an-card"><h3>${this.t('q_an_trend')}</h3><div id="q_an_trend"></div></div>
      </div>
      <div class="q-an-card" style="margin-bottom:12px">
        <h3>${this.t('q_an_alerts')}</h3>
        <div id="q_an_alert_box"></div>
      </div>
    </div>`;
    const esc = v => this.docEsc(v == null ? '' : v);
    let dash = null; let stock = [];
    try {
      const out = await Promise.all([this.api('/api/dashboard'), this.api('/api/stock-summary').catch(() => [])]);
      dash = out[0]; stock = out[1] || [];
    } catch (e) {
      document.getElementById('q_an_kpis').innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`;
      return;
    }
    if (!document.getElementById('q_an_kpis')) return;
    // 无价格权限时 dashboard 不下发 total_value / category_values / 趋势金额
    const vp = 'total_value' in dash;
    const onHand = stock.reduce((s, m) => s + Number(m.on_hand || 0), 0);
    const lowList = stock.filter(m => m.stock_status && m.stock_status !== '正常');
    // 4 个指标卡：库存金额/总量、物料种类、低库存、本月出入库金额（无价格权限时改用笔数）
    const kpis = [];
    kpis.push(vp
      ? [this.t('stock_total_value'), this.fmtMoney(dash.total_value || 0)]
      : [this.t('stock_on_hand'), onHand]);
    kpis.push([this.t('stock_types'), dash.total_items || 0]);
    kpis.push([this.t('q_an_low'), lowList.length]);
    kpis.push(vp
      ? [this.t('q_an_month_io'), `${this.fmtMoney(dash.month_in_amount || 0)} / ${this.fmtMoney(dash.month_out_amount || 0)}`]
      : [this.t('dash_month_txn'), dash.month_txn_count || 0]);
    document.getElementById('q_an_kpis').innerHTML = kpis.map(k => `<div class="pu-kpi"><small>${k[0]}</small><strong>${k[1]}</strong></div>`).join('');

    // 类别分布 / 近 6 个月趋势均为金额口径：无价格权限时整块隐藏，不留空卡
    const grid = document.getElementById('q_an_cat')?.closest('.q-an-grid');
    if (!vp) {
      if (grid) grid.style.display = 'none';
    } else {
      const cats = dash.category_values || {};
      const list = Object.keys(cats).map(k => [k, Number(cats[k] || 0)]).sort((a, b) => b[1] - a[1]);
      const max = list.length ? list[0][1] : 0;
      document.getElementById('q_an_cat').innerHTML = list.length ? list.map(([n, v]) => `<div class="q-an-row">
        <span title="${esc(n)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n)}</span>
        <span class="q-an-bar"><i style="width:${max ? Math.max(2, v / max * 100) : 0}%;background:var(--primary)"></i></span>
        <span class="text-right">${this.fmtMoney(v)}</span></div>`).join('') : `<div class="empty-state"><p>${this.t('q_no_data')}</p></div>`;

      // 近 6 个月趋势：复用 months_trend
      const trend = dash.months_trend || [];
      const tmax = Math.max(1, ...trend.map(m => Math.max(Number(m.in_amount || 0), Number(m.out_amount || 0))));
      document.getElementById('q_an_trend').innerHTML = trend.length ? trend.map(m => `<div class="q-an-row">
        <span>${esc(m.label || '')}</span>
        <span style="display:flex;flex-direction:column;gap:3px">
          <span class="q-an-bar"><i style="width:${Number(m.in_amount || 0) / tmax * 100}%;background:var(--flow-in)"></i></span>
          <span class="q-an-bar"><i style="width:${Number(m.out_amount || 0) / tmax * 100}%;background:var(--flow-out)"></i></span>
        </span>
        <span class="text-right" style="font-size:11px">${this.fmtMoney(m.in_amount || 0) + ' / ' + this.fmtMoney(m.out_amount || 0)}</span>
      </div>`).join('') : `<div class="empty-state"><p>${this.t('q_no_data')}</p></div>`;
    }

    // 预警清单：低于安全库存（补货/缺货）
    const alertRows = lowList.slice().sort((a, b) => (a.on_hand - a.min_stock) - (b.on_hand - b.min_stock));
    document.getElementById('q_an_alert_box').innerHTML = alertRows.length
      ? `<div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th class="text-right">${this.t('q_qty')}</th><th class="text-right">${this.t('stock_min')}</th><th class="text-right">${this.t('q_an_gap')}</th><th>${this.t('stock_status')}</th></tr></thead><tbody>${alertRows.map(m => `<tr class="q-row" onclick="App.qAlertOpen('${esc(m.code)}')">
        <td>${esc(m.code)}</td>
        <td title="${esc(m.name + (m.spec ? ' · ' + m.spec : ''))}"><span class="q-h-clip q-h-w-name">${esc(m.name)}${m.spec ? ' · ' + esc(m.spec) : ''}</span></td>
        <td class="text-right">${m.on_hand}</td>
        <td class="text-right">${m.min_stock}</td>
        <td class="text-right${(m.on_hand - m.min_stock) < 0 ? ' num-neg' : ''}">${(m.on_hand - m.min_stock).toFixed(2)}</td>
        <td>${this.statusBadge(m.stock_status)}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty-state"><p>${this.t('q_an_no_alert')}</p></div>`;
  },


  // ---------- 呆滞分析 ----------
  qAnRangeOptions(cur) {
    return [['month', 'q_an_range_month'], ['3m', 'q_an_range_3m'], ['6m', 'q_an_range_6m'], ['12m', 'q_an_range_12m']]
      .map(([v, k]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${this.t(k)}</option>`).join('');
  },

  qAnDaysOptions(cur) {
    const fixed = [30, 60, 90, 180];
    const isFixed = fixed.includes(Number(cur));
    return fixed.map(n => `<option value="${n}"${isFixed && Number(cur) === n ? ' selected' : ''}>${n} ${this.t('q_an_days_unit')}</option>`).join('')
      + `<option value="custom"${isFixed ? '' : ' selected'}>${this.t('q_an_days_custom')}</option>`;
  },

  // 呆滞分段：阈值以上按 90/180/365 切档；阈值本身作为最低档下界
  qAnBucket(days, threshold) {
    if (days == null) return { label: this.t('q_an_never_out'), cls: 'badge-muted' };
    const cuts = [90, 180, 365].filter(n => n > threshold);
    let lo = threshold, hi = null;
    for (const c of cuts) { if (days < c) { hi = c; break; } lo = c; }
    const label = hi == null ? this.t('q_an_bucket_gt', { n: lo }) : this.t('q_an_bucket', { a: lo, b: hi });
    const cls = hi == null ? 'badge-danger' : (hi <= 180 ? 'badge-muted' : (hi <= 365 ? 'badge-warning' : 'badge-danger'));
    return { label, cls };
  },

  async qAnStagnant(body) {
    const st = this._qAnSt = this._qAnSt || { days: 90, data: null };
    const isFixed = [30, 60, 90, 180].includes(Number(st.days));
    body.innerHTML = `
      <div class="pu-toolbar"><div class="pu-filter-inner">
        <label for="q_an_days">${this.t('q_an_st_days')}</label>
        <select id="q_an_days" onchange="App.qAnStDays(this.value)">${this.qAnDaysOptions(st.days)}</select>
        <input id="q_an_days_custom" type="number" min="1" max="3650" value="${isFixed ? '' : Number(st.days)}" placeholder="${this.t('q_an_days')}" style="width:90px;${isFixed ? 'display:none' : ''}" onchange="App.qAnStCustom(this.value)">
        <span class="pu-sep"></span>
        <span class="q-an-note" style="margin:0">${this.t('q_an_rule_stagnant')}</span>
      </div></div>
      <div class="pu-kpis" id="q_an_st_kpis"></div>
      <div id="q_an_st_table"></div>`;
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['q_an_st'] = () => this.qAnStTable();
    await this.qAnLoadStagnant();
  },

  qAnStDays(v) {
    const inp = document.getElementById('q_an_days_custom');
    if (v === 'custom') {
      if (inp) { inp.style.display = ''; inp.focus(); }
      return;
    }
    this._qAnSt.days = Number(v);
    if (inp) inp.style.display = 'none';
    this.qAnLoadStagnant();
  },

  qAnStCustom(v) {
    const n = Math.max(1, Math.min(3650, parseInt(v, 10) || 90));
    this._qAnSt.days = n;
    this.qAnLoadStagnant();
  },

  async qAnLoadStagnant() {
    const st = this._qAnSt;
    const kpi = document.getElementById('q_an_st_kpis');
    const box = document.getElementById('q_an_st_table');
    if (!kpi || !box) return;
    this.getTableState('q_an_st').page = 1;
    kpi.innerHTML = `<div class="pu-kpi"><small>${this.t('q_an_loading')}</small><strong>…</strong></div>`;
    box.innerHTML = '';
    let data;
    try {
      data = await this.api('/api/analysis/stagnant?days=' + encodeURIComponent(st.days));
    } catch (e) {
      if (this._qAnTab === 'stagnant') box.innerHTML = `<div class="empty-state"><p>${this.docEsc(e.message)}</p></div>`;
      return;
    }
    if (this._qAnTab !== 'stagnant') return;
    st.data = data;
    this.qAnStKpis();
    this.qAnStTable();
  },

  qAnStKpis() {
    const d = this._qAnSt && this._qAnSt.data;
    const box = document.getElementById('q_an_st_kpis');
    if (!box || !d) return;
    // 无价格权限时 summary 只返回 count
    const vp = 'stock_value' in (d.summary || {});
    const kpis = [[this.t('q_an_st_count'), d.summary.count]];
    if (vp) {
      kpis.push([this.t('q_an_st_amount'), this.fmtMoney(d.summary.stock_value)]);
      kpis.push([this.t('q_an_st_share'), d.summary.share + '%']);
    } else {
      kpis.push([this.t('q_an_st_qty'), d.rows.reduce((s, r) => s + Number(r.on_hand || 0), 0)]);
    }
    kpis.push([this.t('q_an_asof'), d.as_of]);
    box.innerHTML = kpis.map(([k, v]) => `<div class="pu-kpi"><small>${k}</small><strong>${v}</strong></div>`).join('');
  },

  qAnStTable() {
    const st = this._qAnSt;
    const box = document.getElementById('q_an_st_table');
    if (!box || !st || !st.data) return;
    const tid = 'q_an_st';
    const ps = this.getTableState(tid);
    if (!ps.sortKey) { ps.sortKey = 'sort_days'; ps.sortDir = 'desc'; }
    const vp = 'stock_value' in (st.data.summary || {});
    const esc = v => this.docEsc(v == null ? '' : v);
    const rows = st.data.rows.map(r => ({ ...r, sort_days: r.days_idle == null ? 99999 : r.days_idle }));
    const sorted = this.sortData(rows, ps.sortKey, ps.sortDir);
    const shown = this.paginate(sorted, ps.page, ps.pageSize);
    const cols = vp ? 8 : 6;
    const body = shown.length ? shown.map(r => {
      const b = this.qAnBucket(r.days_idle, st.data.days);
      return `<tr class="q-row" onclick="App.qAlertOpen('${esc(r.code)}')">
        <td>${esc(r.code)}</td>
        <td title="${esc(r.name + (r.spec ? ' · ' + r.spec : ''))}"><span class="q-h-clip q-h-w-name">${esc(r.name)}${r.spec ? ' · ' + esc(r.spec) : ''}</span></td>
        <td class="text-right">${r.on_hand}</td>
        ${vp ? `<td class="text-right">${this.fmtMoney(r.stock_value)}</td><td class="text-right">${this.fmtMoney(r.avg_cost)}</td>` : ''}
        <td>${r.last_out_date ? esc(r.last_out_date) : `<span class="badge badge-muted">${this.t('q_an_never_out')}</span>`}</td>
        <td class="text-right">${r.days_idle == null ? '–' : r.days_idle}</td>
        <td><span class="badge ${b.cls}">${esc(b.label)}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="${cols}" class="text-center">${this.t('q_no_data')}</td></tr>`;
    box.innerHTML = `<div class="table-wrap"><table><thead><tr>
        ${this.sortTh(this.t('mat_code'), 'code', tid)}
        ${this.sortTh(this.t('mat_name_spec'), 'name', tid)}
        ${this.sortTh(this.t('q_an_stock_qty'), 'on_hand', tid, true)}
        ${vp ? this.sortTh(this.t('q_an_stock_amount'), 'stock_value', tid, true) + this.sortTh(this.t('q_an_avg_cost'), 'avg_cost', tid, true) : ''}
        ${this.sortTh(this.t('q_an_col_last_out'), 'last_out_date', tid)}
        ${this.sortTh(this.t('q_an_col_days'), 'sort_days', tid, true)}
        <th>${this.t('q_an_col_bucket')}</th>
      </tr></thead><tbody>${body}</tbody></table></div>
      ${rows.length ? `<div class="pu-pager" style="margin-top:8px">${this.puPagerHtml(tid, rows.length)}</div>` : ''}`;
  },

  // ---------- ABC 分类 ----------
  qAnClassBadge(k) {
    const map = { A: 'badge-success', B: 'badge-info', C: 'badge-warning', N: 'badge-muted' };
    return `<span class="badge ${map[k] || 'badge-muted'}">${k === 'N' ? this.t('q_an_no_out') : k}</span>`;
  },

  async qAnAbc(body) {
    const st = this._qAnAbc = this._qAnAbc || { range: '3m', cls: '', data: null };
    body.innerHTML = `
      <div class="pu-toolbar"><div class="pu-filter-inner">
        <label for="q_an_abc_range">${this.t('q_an_range')}</label>
        <select id="q_an_abc_range" onchange="App.qAnAbcRange(this.value)">${this.qAnRangeOptions(st.range)}</select>
        <label for="q_an_abc_cls">${this.t('q_an_class')}</label>
        <select id="q_an_abc_cls" onchange="App.qAnAbcClass(this.value)">
          <option value="">${this.t('q_an_class_all')}</option>
          ${['A', 'B', 'C', 'N'].map(c => `<option value="${c}"${st.cls === c ? ' selected' : ''}>${this.t('q_an_class_' + c.toLowerCase())}</option>`).join('')}
        </select>
        <span class="pu-sep"></span>
        <span class="q-an-note" style="margin:0">${this.t('q_an_rule_abc')}</span>
      </div></div>
      <div class="q-an-class" id="q_an_abc_cards"></div>
      <div id="q_an_abc_table"></div>`;
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['q_an_abc'] = () => this.qAnAbcTable();
    await this.qAnLoadAbc();
  },

  qAnAbcRange(v) {
    this._qAnAbc.range = v;
    this.qAnLoadAbc();
  },

  qAnAbcClass(v) {
    this._qAnAbc.cls = v || '';
    const sel = document.getElementById('q_an_abc_cls');
    if (sel) sel.value = this._qAnAbc.cls;
    this.getTableState('q_an_abc').page = 1;
    this.qAnAbcCards();
    this.qAnAbcTable();
  },

  async qAnLoadAbc() {
    const st = this._qAnAbc;
    const box = document.getElementById('q_an_abc_table');
    if (!box) return;
    this.getTableState('q_an_abc').page = 1;
    box.innerHTML = `<div class="empty-state"><p>${this.t('q_an_loading')}</p></div>`;
    let data;
    try {
      data = await this.api('/api/analysis/abc?range=' + encodeURIComponent(st.range));
    } catch (e) {
      if (this._qAnTab === 'abc') box.innerHTML = `<div class="empty-state"><p>${this.docEsc(e.message)}</p></div>`;
      return;
    }
    if (this._qAnTab !== 'abc') return;
    st.data = data;
    this.qAnAbcCards();
    this.qAnAbcTable();
  },

  qAnAbcCards() {
    const d = this._qAnAbc && this._qAnAbc.data;
    const box = document.getElementById('q_an_abc_cards');
    if (!box || !d) return;
    // 无价格权限时 rows/summary 不含金额与占比
    const vp = 'total_amount' in d;
    box.innerHTML = ['A', 'B', 'C', 'N'].map(k => {
      const s = d.summary[k];
      const amountRows = vp ? `
          <dt>${this.t('q_an_out_amount')}</dt><dd>${this.fmtMoney(s.out_amount)}</dd>
          <dt>${this.t('q_an_share')}</dt><dd>${(s.share || 0) + '%'}</dd>
          <dt>${this.t('q_an_stock_amount')}</dt><dd>${this.fmtMoney(s.stock_value)}</dd>` : '';
      return `<button type="button" aria-pressed="${this._qAnAbc.cls === k}" onclick="App.qAnAbcClass('${k}')">
        <h4>${this.qAnClassBadge(k)} ${this.t('q_an_class_' + k.toLowerCase())}</h4>
        <dl>
          <dt>${this.t('q_an_items')}</dt><dd>${s.count}</dd>${amountRows}
        </dl></button>`;
    }).join('');
  },

  qAnAbcTable() {
    const st = this._qAnAbc;
    const box = document.getElementById('q_an_abc_table');
    if (!box || !st || !st.data) return;
    const tid = 'q_an_abc';
    const ps = this.getTableState(tid);
    // 无价格权限时没有 out_amount / share / cum_share / stock_value
    const vp = 'total_amount' in st.data;
    const esc = v => this.docEsc(v == null ? '' : v);
    let rows = st.data.rows;
    if (st.cls) rows = rows.filter(r => r.abc === st.cls);
    const sorted = this.sortData(rows, ps.sortKey, ps.sortDir);
    const shown = this.paginate(sorted, ps.page, ps.pageSize);
    const cols = vp ? 7 : 4;
    const body = shown.length ? shown.map(r => `<tr class="q-row" onclick="App.qAlertOpen('${esc(r.code)}')">
        <td>${esc(r.code)}</td>
        <td title="${esc(r.name + (r.spec ? ' · ' + r.spec : ''))}"><span class="q-h-clip q-h-w-name">${esc(r.name)}${r.spec ? ' · ' + esc(r.spec) : ''}</span></td>
        ${vp ? `<td class="text-right">${this.fmtMoney(r.out_amount)}</td>` : ''}
        ${vp ? `<td class="text-right">${(r.share * 100).toFixed(2)}%</td>` : ''}
        ${vp ? `<td class="text-right">${(r.cum_share * 100).toFixed(2)}%</td>` : ''}
        <td>${this.qAnClassBadge(r.abc)}</td>
        <td class="text-right">${r.on_hand}</td>
        ${vp ? `<td class="text-right">${this.fmtMoney(r.stock_value)}</td>` : ''}
      </tr>`).join('') : `<tr><td colspan="${cols}" class="text-center">${this.t('q_no_data')}</td></tr>`;
    box.innerHTML = `<div class="table-wrap"><table><thead><tr>
        ${this.sortTh(this.t('mat_code'), 'code', tid)}
        ${this.sortTh(this.t('mat_name_spec'), 'name', tid)}
        ${vp ? this.sortTh(this.t('q_an_out_amount'), 'out_amount', tid, true) : ''}
        ${vp ? this.sortTh(this.t('q_an_share'), 'share', tid, true) : ''}
        ${vp ? this.sortTh(this.t('q_an_cum_share'), 'cum_share', tid, true) : ''}
        <th>${this.t('q_an_class')}</th>
        ${this.sortTh(this.t('q_an_stock_qty'), 'on_hand', tid, true)}
        ${vp ? this.sortTh(this.t('q_an_stock_amount'), 'stock_value', tid, true) : ''}
      </tr></thead><tbody>${body}</tbody></table></div>
      ${rows.length ? `<div class="pu-pager" style="margin-top:8px">${this.puPagerHtml(tid, rows.length)}</div>` : ''}`;
  },

  // ---------- 库存周转率 ----------
  async qAnTurnover(body) {
    const st = this._qAnTurn = this._qAnTurn || { range: '3m', data: null };
    body.innerHTML = `
      <div class="pu-toolbar"><div class="pu-filter-inner">
        <label for="q_an_turn_range">${this.t('q_an_range')}</label>
        <select id="q_an_turn_range" onchange="App.qAnTurnRange(this.value)">${this.qAnRangeOptions(st.range)}</select>
        <span class="pu-sep"></span>
        <span class="q-an-note" style="margin:0">${this.t('q_an_rule_turnover')}</span>
      </div></div>
      <div class="pu-kpis" id="q_an_turn_kpis"></div>
      <div id="q_an_turn_note"></div>
      <div class="q-an-grid">
        <div class="q-an-card"><h3>${this.t('q_an_by_category')}</h3><div id="q_an_turn_cat"></div></div>
        <div class="q-an-card"><h3>${this.t('q_an_slowest')}</h3><div id="q_an_turn_slow"></div></div>
      </div>`;
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['q_an_slow'] = () => this.qAnTurnSlowTable();
    await this.qAnLoadTurnover();
  },

  qAnTurnRange(v) {
    this._qAnTurn.range = v;
    this.qAnLoadTurnover();
  },

  async qAnLoadTurnover() {
    const st = this._qAnTurn;
    const kpi = document.getElementById('q_an_turn_kpis');
    const box = document.getElementById('q_an_turn_cat');
    if (!kpi || !box) return;
    kpi.innerHTML = `<div class="pu-kpi"><small>${this.t('q_an_loading')}</small><strong>…</strong></div>`;
    box.innerHTML = '';
    const slow = document.getElementById('q_an_turn_slow');
    if (slow) slow.innerHTML = '';
    let data;
    try {
      data = await this.api('/api/analysis/turnover?range=' + encodeURIComponent(st.range));
    } catch (e) {
      if (this._qAnTab === 'turnover') box.innerHTML = `<div class="empty-state"><p>${this.docEsc(e.message)}</p></div>`;
      return;
    }
    if (this._qAnTab !== 'turnover') return;
    st.data = data;
    this.qAnTurnKpis();
    this.qAnTurnCat();
    this.qAnTurnSlowTable();
  },

  qAnTurnKpis() {
    const d = this._qAnTurn && this._qAnTurn.data;
    const box = document.getElementById('q_an_turn_kpis');
    if (!box || !d) return;
    // 无价格权限时没有 out_cost / avg_stock（周转率、周转天数保留）
    const vp = 'out_cost' in d;
    const kpis = [
      [this.t('q_an_turns'), d.turns == null ? '–' : d.turns.toFixed(2)],
      [this.t('q_an_turn_days'), d.turn_days == null ? '–' : d.turn_days.toFixed(1)],
    ];
    if (vp) {
      kpis.push([this.t('q_an_out_cost'), this.fmtMoney(d.out_cost)]);
      kpis.push([this.t('q_an_avg_stock'), d.no_avg ? '–' : this.fmtMoney(d.avg_stock)]);
    }
    box.innerHTML = kpis.map(([k, v]) => `<div class="pu-kpi"><small>${k}</small><strong>${v}</strong></div>`).join('');
    const note = document.getElementById('q_an_turn_note');
    if (note) {
      note.innerHTML = d.no_avg
        ? `<div class="q-an-note">${this.t('q_an_denom_zero')}</div>`
        : `<div class="q-an-note">${this.t('q_an_window_note', { start: d.start_date, end: d.end_date, days: d.days })}</div>`;
    }
  },

  qAnTurnCat() {
    const d = this._qAnTurn && this._qAnTurn.data;
    const box = document.getElementById('q_an_turn_cat');
    if (!box || !d) return;
    const vp = 'out_cost' in d;
    const esc = v => this.docEsc(v == null ? '' : v);
    const rows = d.categories || [];
    const body = rows.length ? rows.map(c => `<tr>
        <td>${esc(c.category || this.t('q_an_uncategorized'))}</td>
        ${vp ? `<td class="text-right">${this.fmtMoney(c.out_cost)}</td><td class="text-right">${this.fmtMoney(c.avg_stock)}</td>` : ''}
        <td class="text-right">${c.turns == null ? '–' : c.turns.toFixed(2)}</td>
        <td class="text-right">${c.turn_days == null ? '–' : c.turn_days.toFixed(1)}</td>
      </tr>`).join('') : `<tr><td colspan="${vp ? 5 : 3}" class="text-center">${this.t('q_no_data')}</td></tr>`;
    box.innerHTML = `<div class="table-wrap q-an-scroll"><table><thead><tr>
        <th>${this.t('mat_category')}</th>
        ${vp ? `<th class="text-right">${this.t('q_an_out_cost')}</th><th class="text-right">${this.t('q_an_avg_stock')}</th>` : ''}
        <th class="text-right">${this.t('q_an_turns')}</th>
        <th class="text-right">${this.t('q_an_turn_days')}</th>
      </tr></thead><tbody>${body}</tbody></table></div>`;
  },

  qAnTurnSlowTable() {
    const d = this._qAnTurn && this._qAnTurn.data;
    const box = document.getElementById('q_an_turn_slow');
    if (!box || !d) return;
    const tid = 'q_an_slow';
    const ps = this.getTableState(tid);
    if (!ps.sortKey) { ps.sortKey = 'turns'; ps.sortDir = 'asc'; }
    const vp = 'out_cost' in d;
    const esc = v => this.docEsc(v == null ? '' : v);
    const rows = this.sortData(d.slowest || [], ps.sortKey, ps.sortDir);
    const cols = vp ? 6 : 4;
    const body = rows.length ? rows.map(r => `<tr class="q-row" onclick="App.qAlertOpen('${esc(r.code)}')">
        <td>${esc(r.code)}</td>
        <td title="${esc(r.name + (r.spec ? ' · ' + r.spec : ''))}"><span class="q-h-clip q-h-w-name">${esc(r.name)}${r.spec ? ' · ' + esc(r.spec) : ''}</span></td>
        <td class="text-right">${r.on_hand}</td>
        ${vp ? `<td class="text-right">${this.fmtMoney(r.avg_stock)}</td><td class="text-right">${this.fmtMoney(r.out_cost)}</td>` : ''}
        <td class="text-right">${r.turns == null ? '–' : r.turns.toFixed(2)}</td>
      </tr>`).join('') : `<tr><td colspan="${cols}" class="text-center">${this.t('q_no_data')}</td></tr>`;
    box.innerHTML = `<div class="table-wrap q-an-scroll"><table><thead><tr>
        ${this.sortTh(this.t('mat_code'), 'code', tid)}
        ${this.sortTh(this.t('mat_name_spec'), 'name', tid)}
        ${this.sortTh(this.t('q_an_stock_qty'), 'on_hand', tid, true)}
        ${vp ? this.sortTh(this.t('q_an_avg_stock'), 'avg_stock', tid, true) + this.sortTh(this.t('q_an_out_cost'), 'out_cost', tid, true) : ''}
        ${this.sortTh(this.t('q_an_turns'), 'turns', tid, true)}
      </tr></thead><tbody>${body}</tbody></table></div>`;
  },

  ledgerTypeBadge(r) {
    const bt = r.business_type || '';
    const map = {
      '采购入库': ['↑', 'in_purchase'],
      '零星入库': ['↑', 'in_other'],
      '采购退货': ['↓', 'in_return'],
      '正常出库': ['↓', 'out_normal'],
      '领料退库': ['↑', 'out_return'],
      '盘盈': ['+', 'ledger_adj_gain'],
      '盘亏': ['−', 'ledger_adj_loss'],
      '其它': ['', 'ledger_adj_other'],
      '期初结存': ['', 'ledger_opening_flow'],
    };
    const cfg = map[bt];
    // 空值与未知业务类型统一显示占位，不回退粗方向
    if (!cfg) return '<span class="badge badge-muted">-</span>';
    const arrow = cfg[0] ? `<span style="opacity:.7;margin-right:3px">${cfg[0]}</span>` : '';
    const noOrigin = (bt === '领料退库' && !Number(r.return_line_id || 0))
      ? ` <span class="badge badge-danger" style="font-size:10px">${this.t('ledger_no_origin')}</span>` : '';
    return `<span class="badge ${this.docTypeBadgeClass(bt)}">${arrow}${this.t(cfg[1])}</span>${noOrigin}`;
  },

  // 台账日期列：业务日期为主，过账时分作次行（同一天多笔可区分先后）
  ledgerDateCell(r) {
    if (!r.date) return '';
    const full = this.fmtDateTime(r.posting_time) || '';
    if (!full) return r.date;
    const [pdate, ptime] = full.split(' ');
    const hm = pdate === r.date ? ptime : `${pdate.slice(5)} ${ptime}`;
    return `${r.date}<div style="font-size:11px;color:var(--text-muted);font-weight:400">${hm}</div>`;
  },

});
