/**
 * 库存视图 —— 库存汇总、物料台账、位置库存
 */
Object.assign(App, {
  // ========== 库存汇总 ==========
  async renderStockSummary() {
    this.setMain(this.pageWrap('📦 ' + this.t('stock_title'), this.t('stock_desc'), '', `<div class="data-page"><div class="data-toolbar"><div class="filter-bar" style="margin:0;padding:0;background:none;box-shadow:none"><div class="form-group"><label>${this.t('stock_keyword')}</label><input id="s_keyword" placeholder="${this.t('quick_filter_ph')}" oninput="App.renderStockTable()"></div><div class="form-group"><label>${this.t('stock_category')}</label><select id="s_category" onchange="App.renderStockTable()"><option value="">${this.t('stock_all')}</option>${this.params.categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('')}</select></div><div class="form-group"><label>${this.t('stock_status')}</label><select id="s_status" onchange="App.renderStockTable()"><option value="">${this.t('stock_all')}</option><option value="正常">${this.t('st_normal')}</option><option value="补货">${this.t('st_restock')}</option><option value="缺货">${this.t('st_out')}</option></select></div></div></div><div class="data-summary" id="stock-summary"></div><div class="data-scroll" id="stock-scroll"></div><div class="data-pager" id="stock-pager"></div></div>`));
    try {
      this._stockData = await this.api('/api/stock-summary');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['stock'] = () => this.renderStockTable();
      this.renderStockTable();
    } catch (e) { document.getElementById('stock-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderStockTable() {
    const data = this._stockData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'stock';
    const st = this.getTableState(tid);
    // 多关键字 + 类别 + 状态筛选（前端）
    const keywords = document.getElementById('s_keyword')?.value || '';
    const category = document.getElementById('s_category')?.value || '';
    const status = document.getElementById('s_status')?.value || '';
    const filterFields = ['code','name','spec','category','unit','brand','stock_status','on_hand','min_stock','opening_qty','total_in','total_out'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    if (category) filtered = filtered.filter(m => m.category === category);
    if (status) filtered = filtered.filter(m => m.stock_status === status);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const totalValue = sorted.reduce((s, m) => s + m.stock_value, 0);
    const alerts = sorted.filter(m => m.stock_status === '补货' || m.stock_status === '缺货').length;
    const headers = [
      ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
      ['category', this.t('mat_category')], ['unit', this.t('mat_unit')], ['opening_qty', this.t('stock_opening')],
      ['total_in', this.t('stock_total_in')], ['total_out', this.t('stock_total_out')], ['on_hand', this.t('stock_on_hand')],
      ['min_stock', this.t('stock_min')], ['stock_status', this.t('mat_status')],
      ...vp ? [['avg_price', this.t('stock_avg_price')], ['stock_value', this.t('stock_value')]] : [],
      ['brand', this.t('mat_brand')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    const colCount = headers.length;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.category}</td><td>${m.unit}</td><td class="text-right">${m.opening_qty}</td><td class="text-right">${m.total_in}</td><td class="text-right">${m.total_out}</td><td class="text-right"><strong>${m.on_hand}</strong></td><td class="text-right">${m.min_stock}</td><td>${this.statusBadge(m.stock_status)}</td>${vp ? `<td class="text-right">${this.fmtMoney(m.avg_price)}</td><td class="text-right">${cur} ${this.fmtMoney(m.stock_value)}</td>` : ''}<td>${m.brand || ''}</td></tr>`).join(''); }
    document.getElementById('stock-summary').innerHTML = `${this.t('stock_types')}: ${sorted.length}${vp ? ` | ${this.t('stock_total_value')}: ${cur} ${this.fmtMoney(totalValue)}` : ''} | ${this.t('stock_alerts')}: ${alerts} ${this.t('stock_items')}`;
    document.getElementById('stock-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('stock-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  // ========== 查询中心 ==========
  async renderQuery() {
    this.setMain(this.pageWrap('🔍 ' + this.t('q_title'), this.t('q_desc'), '', `<div class="data-page">
      <div class="data-toolbar">
        <div class="filter-bar" style="margin:0;padding:10px;background:none;box-shadow:none">
          <div class="form-group"><label>${this.t('q_keyword')}</label><input id="q_keyword" placeholder="${this.t('quick_filter_ph')}"></div>
          <div class="form-group"><label>${this.t('q_start')}</label><input id="q_start" type="date"></div>
          <div class="form-group"><label>${this.t('q_end')}</label><input id="q_end" type="date"></div>
          <div class="form-group"><label>${this.t('q_supplier')}</label><input id="q_supplier"></div>
          <div class="form-group"><label>${this.t('q_handler')}</label><input id="q_handler"></div>
          <div class="form-group"><label>${this.t('q_destination')}</label><select id="q_destination"><option value="">${this.t('q_no_limit')}</option>${this.params.destinations.map(d => `<option value="${d.name}">${d.name}</option>`).join('')}</select></div>
          <div class="form-group"><label>${this.t('q_po_no')}</label><input id="q_po_no"></div>
          <div class="form-group"><label>${this.t('q_contract')}</label><input id="q_contract_no"></div>
        </div>
        <div class="query-btn-row" style="display:flex;gap:10px;padding:0 10px 10px">
          <button class="btn btn-primary" onclick="App.runQuery()">${this.t('search')}</button>
          <button class="btn btn-outline" onclick="App.clearQuery()">${this.t('clear')}</button>
        </div>
      </div>
      <div class="data-summary" id="query-tabs" style="display:none">
        <button class="btn btn-primary btn-sm" onclick="App.showQueryResult('stock')">${this.t('q_result_stock')}</button>
        <button class="btn btn-outline btn-sm" onclick="App.showQueryResult('inbound')">${this.t('q_result_in')}</button>
        <button class="btn btn-outline btn-sm" onclick="App.showQueryResult('outbound')">${this.t('q_result_out')}</button>
      </div>
      <div class="data-scroll" id="query-content"><div class="empty-state"><div class="empty-state-icon">🔍</div><p>${this.t('q_empty')}</p></div></div>
      <div class="data-pager" id="query-pager"></div>
    </div>`));
    this.queryResults = null;
    this._queryTab = 'stock';
  },

  async runQuery() {
    const keyword = document.getElementById('q_keyword').value.trim(), startDate = document.getElementById('q_start').value, endDate = document.getElementById('q_end').value, supplier = document.getElementById('q_supplier').value.trim(), handler = document.getElementById('q_handler').value.trim(), destination = document.getElementById('q_destination').value, poNo = document.getElementById('q_po_no').value.trim(), contractNo = document.getElementById('q_contract_no').value.trim();
    // keyword 不传后端，前端 filterByKeywords 多关键字模糊匹配
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate); if (endDate) params.set('endDate', endDate);
    if (supplier) params.set('supplier', supplier); if (handler) params.set('handler', handler); if (poNo) params.set('poNo', poNo); if (contractNo) params.set('contractNo', contractNo);
    try {
      const stock = await this.api('/api/stock-summary');
      const inbound = await this.api('/api/inbound?' + params.toString());
      const outParams = new URLSearchParams();
      if (startDate) outParams.set('startDate', startDate); if (endDate) outParams.set('endDate', endDate); if (handler) outParams.set('handler', handler); if (destination) outParams.set('destination', destination);
      const outbound = await this.api('/api/outbound?' + outParams.toString());
      // 前端多关键字筛选
      this._queryKeyword = keyword;
      this.queryResults = { stock, inbound, outbound };
      document.getElementById('query-tabs').style.display = 'block';
      // 重置三个 tab 的表格状态
      ['queryStock','queryInbound','queryOutbound'].forEach(tid => { this.tableStates[tid] = { sortKey: '', sortDir: 'asc', page: 1, pageSize: 15 }; });
      this.showQueryResult('stock');
    } catch (e) { this.toast(e.message, 'error'); }
  },

  clearQuery() {
    ['q_keyword','q_start','q_end','q_supplier','q_handler','q_po_no','q_contract_no'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('q_destination').value = '';
    document.getElementById('query-tabs').style.display = 'none';
    document.getElementById('query-content').innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>${this.t('q_empty')}</p></div>`;
    document.getElementById('query-pager').innerHTML = '';
    this.queryResults = null;
  },

  showQueryResult(tab) {
    const tabs = document.querySelectorAll('#query-tabs button'); const tabMap = { stock: 0, inbound: 1, outbound: 2 };
    tabs.forEach((b, i) => { b.className = i === tabMap[tab] ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'; });
    this._queryTab = tab;
    if (!this.queryResults) return;
    const cur = this.params.currency; const vp = this.canViewPrice();
    const tid = 'query' + tab.charAt(0).toUpperCase() + tab.slice(1);
    // 注册重渲染回调（排序/翻页时调用）
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers[tid] = () => this.showQueryResult(tab);
    const st = this.getTableState(tid);

    if (tab === 'stock') {
      const kw = this._queryKeyword || '';
      const filterFields = ['code','name','spec','brand','category','unit','stock_status'];
      let data = this.filterByKeywords(this.queryResults.stock, kw, filterFields);
      const sorted = this.sortData(data, st.sortKey, st.sortDir);
      const pageData = this.paginate(sorted, st.page, st.pageSize);
      const headers = [
        ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
        ['brand', this.t('mat_brand')], ['category', this.t('mat_category')], ['unit', this.t('mat_unit')],
        ['opening_qty', this.t('stock_opening')], ['total_in', this.t('stock_total_in')], ['total_out', this.t('stock_total_out')],
        ['on_hand', this.t('stock_on_hand')], ['min_stock', this.t('stock_min')],
      ];
      let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      thHtml += `<th>${this.t('mat_status')}</th>`;
      if (vp) thHtml += this.sortTh(this.t('stock_value'), 'stock_value', tid);
      let tbody = '';
      if (pageData.length === 0) { tbody = this.emptyRow(headers.length + 2 + (vp ? 1 : 0)); }
      else { tbody = pageData.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.brand || ''}</td><td>${m.category}</td><td>${m.unit}</td><td class="text-right">${m.opening_qty}</td><td class="text-right">${m.total_in}</td><td class="text-right">${m.total_out}</td><td class="text-right"><strong>${m.on_hand}</strong></td><td class="text-right">${m.min_stock}</td><td>${this.statusBadge(m.stock_status)}</td>${vp ? `<td class="text-right">${cur} ${this.fmtMoney(m.stock_value)}</td>` : ''}</tr>`).join(''); }
      const html = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">${this.t('q_stock_match')}: ${data.length} ${this.t('q_types')}</div><div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      document.getElementById('query-content').innerHTML = html;
      document.getElementById('query-pager').innerHTML = this.renderPager(tid, sorted.length);

    } else if (tab === 'inbound') {
      const kw = this._queryKeyword || '';
      const filterFields = ['date','grn_no','code','material_name','material_spec','material_brand','supplier','handler','location','po_no','contract_no','txn_type','remarks'];
      let data = this.filterByKeywords(this.queryResults.inbound, kw, filterFields);
      const sorted = this.sortData(data, st.sortKey, st.sortDir);
      const pageData = this.paginate(sorted, st.page, st.pageSize);
      const headers = [
        ['date', this.t('in_date')], ['grn_no', this.t('in_grn')], ['code', this.t('mat_code')],
        ['material_name', this.t('mat_name')], ['material_brand', this.t('mat_brand')], ['qty', this.t('in_qty')],
        ...vp ? [['price', this.t('in_price')], ['amount', this.t('in_total_amount')]] : [],
        ['supplier', this.t('in_supplier')], ['handler', this.t('in_handler')], ['location', this.t('in_location')], ['po_no', this.t('in_po_no')],
      ];
      let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      let tbody = '';
      if (pageData.length === 0) { tbody = this.emptyRow(headers.length); }
      else { tbody = pageData.map(r => `<tr><td>${this.fmtDate(r.date)}</td><td>${r.grn_no}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_brand || ''}</td><td class="text-right">${r.qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.price)}</td><td class="text-right">${this.fmtMoney(r.amount)}</td>` : ''}<td>${r.supplier || ''}</td><td>${r.handler || ''}</td><td>${r.location || ''}</td><td>${r.po_no || ''}</td></tr>`).join(''); }
      const html = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">${this.t('q_in_match')}: ${data.length} ${this.t('q_records')}</div><div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      document.getElementById('query-content').innerHTML = html;
      document.getElementById('query-pager').innerHTML = this.renderPager(tid, sorted.length);

    } else {
      const kw = this._queryKeyword || '';
      const filterFields = ['date','gin_no','code','material_name','material_spec','material_brand','destination','receiver','handler','txn_type','remarks'];
      let data = this.filterByKeywords(this.queryResults.outbound, kw, filterFields);
      const sorted = this.sortData(data, st.sortKey, st.sortDir);
      const pageData = this.paginate(sorted, st.page, st.pageSize);
      const headers = [
        ['date', this.t('out_date')], ['gin_no', this.t('out_gin')], ['code', this.t('mat_code')],
        ['material_name', this.t('mat_name')], ['material_brand', this.t('mat_brand')], ['qty', this.t('out_qty')],
        ['destination', this.t('out_destination')], ['receiver', this.t('out_receiver')], ['handler', this.t('out_handler')],
        ...vp ? [['cost_price', this.t('out_cost_price')], ['cost_amount', this.t('out_cost_amount')]] : [],
      ];
      let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      let tbody = '';
      if (pageData.length === 0) { tbody = this.emptyRow(headers.length); }
      else { tbody = pageData.map(r => `<tr><td>${this.fmtDate(r.date)}</td><td>${r.gin_no}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_brand || ''}</td><td class="text-right">${r.qty}</td><td>${r.destination || ''}</td><td>${r.receiver || ''}</td><td>${r.handler || ''}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.cost_price)}</td><td class="text-right">${this.fmtMoney(r.cost_amount)}</td>` : ''}</tr>`).join(''); }
      const html = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">${this.t('q_out_match')}: ${data.length} ${this.t('q_records')}</div><div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      document.getElementById('query-content').innerHTML = html;
      document.getElementById('query-pager').innerHTML = this.renderPager(tid, sorted.length);
    }
  },

  // ========== 物料台账 ==========
  async renderLedger() {
    const materials = await this.api('/api/materials');
    const matSel = materials.map(m => `<option value="${m.code}">${m.name} ${m.spec || ''} (${m.code})</option>`).join('');
    this.setMain(this.pageWrap('📒 ' + this.t('ledger_title'), this.t('ledger_desc'), '', `<div class="data-page"><div class="data-toolbar"><div class="filter-bar" style="margin:0;padding:10px;background:none;box-shadow:none"><div class="form-group"><label>${this.t('ledger_select')} *</label><select id="l_code"><option value="">${this.t('please_select')}</option>${matSel}</select></div><div class="form-group"><label>${this.t('ledger_start')}</label><input id="l_start" type="date"></div><div class="form-group"><label>${this.t('ledger_end')}</label><input id="l_end" type="date"></div><div class="form-group"><button class="btn btn-primary" onclick="App.runLedger()">${this.t('generate')}</button></div></div></div><div class="data-scroll" id="ledger-content"><div class="empty-state"><div class="empty-state-icon">📒</div><p>${this.t('ledger_empty')}</p></div></div><div class="data-pager" id="ledger-pager"></div></div>`));
  },

  async runLedger() {
    const code = document.getElementById('l_code').value; if (!code) return this.toast(this.t('selectMaterial'), 'error');
    const startDate = document.getElementById('l_start').value, endDate = document.getElementById('l_end').value; const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate); if (endDate) params.set('endDate', endDate);
    try {
      const data = await this.api(`/api/ledger/${code}?${params.toString()}`); const cur = this.params.currency; const vp = this.canViewPrice();
      let html = `<div class="metric-grid"><div class="metric-card"><div class="metric-label">${this.t('ledger_code')}</div><div class="metric-value" style="font-size:18px">${data.material.code}</div></div><div class="metric-card"><div class="metric-label">${this.t('ledger_name')}</div><div class="metric-value" style="font-size:18px">${data.material.name}</div></div><div class="metric-card metric-info"><div class="metric-label">${this.t('ledger_opening')}</div><div class="metric-value">${data.opening_qty}</div></div><div class="metric-card metric-success"><div class="metric-label">${this.t('ledger_total_in')}</div><div class="metric-value">${data.total_in}</div></div><div class="metric-card metric-warning"><div class="metric-label">${this.t('ledger_total_out')}</div><div class="metric-value">${data.total_out}</div></div><div class="metric-card metric-danger"><div class="metric-label">${this.t('ledger_closing')}</div><div class="metric-value">${data.closing_qty}</div></div></div>`;
      html += `<div class="card"><div class="card-title">${this.t('ledger_flow')}</div><div class="table-wrap"><table><thead><tr><th>${this.t('ledger_seq')}</th><th>${this.t('ledger_date')}</th><th>${this.t('ledger_doc')}</th><th>${this.t('ledger_type')}</th><th>${this.t('ledger_in_qty')}</th><th>${this.t('ledger_out_qty')}</th><th>${this.t('ledger_balance')}</th>${vp ? `<th>${this.t('ledger_price')}</th><th>${this.t('ledger_amount')}</th>` : ''}<th>${this.t('ledger_party')}</th><th>${this.t('ledger_location')}</th><th>${this.t('in_handler')}</th><th>${this.t('in_remarks')}</th></tr></thead><tbody>${data.rows.map(r => { const tb = r.type === '入库' ? `<span class="badge badge-info">${this.t('nav_inbound')}</span>` : r.type === '出库' ? `<span class="badge badge-warning">${this.t('nav_outbound')}</span>` : `<span class="badge badge-muted">${this.t('stock_opening')}</span>`; return `<tr><td class="text-center">${r.seq}</td><td>${r.date || ''}</td><td>${r.doc_no || ''}</td><td>${tb}</td><td class="text-right">${r.in_qty || ''}</td><td class="text-right">${r.out_qty || ''}</td><td class="text-right"><strong>${r.balance}</strong></td>${vp ? `<td class="text-right">${r.price ? this.fmtMoney(r.price) : ''}</td><td class="text-right">${r.amount ? cur + ' ' + this.fmtMoney(r.amount) : ''}</td>` : ''}<td>${r.party || ''}</td><td>${r.location || ''}</td><td>${r.handler || ''}</td><td>${r.remarks || ''}</td></tr>`; }).join('')}</tbody></table></div></div>`;
      document.getElementById('ledger-content').innerHTML = html;
    } catch (e) { document.getElementById('ledger-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  // ========== 位置库存 ==========
  async renderLocationStock() {
    const materials = await this.api('/api/materials');
    const matSel = materials.map(m => `<option value="${m.code}">${m.name} ${m.spec || ''} (${m.code})</option>`).join('');
    const locSel = this.params.locations.map(l => `<option value="${l.name}">${l.name}</option>`).join('');
    this.setMain(this.pageWrap('📍 ' + this.t('loc_title'), this.t('loc_desc'), '', `<div class="data-page"><div class="data-toolbar"><div class="filter-bar" style="margin:0;padding:10px;background:none;box-shadow:none"><div class="form-group"><label>${this.t('loc_by_material')}</label><select id="loc_code"><option value="">${this.t('loc_select_material')}</option>${matSel}</select></div><div class="form-group"><button class="btn btn-primary" onclick="App.queryLocByMaterial()">${this.t('search')}</button></div><div style="width:20px"></div><div class="form-group"><label>${this.t('loc_by_location')}</label><select id="loc_name"><option value="">${this.t('loc_select_location')}</option>${locSel}</select></div><div class="form-group"><button class="btn btn-primary" onclick="App.queryLocByLocation()">${this.t('search')}</button></div></div></div><div class="data-scroll" id="loc-content"><div class="empty-state"><div class="empty-state-icon">📍</div><p>${this.t('loc_empty')}</p></div></div><div class="data-pager" id="loc-pager"></div></div>`));
  },

  async queryLocByMaterial() {
    const code = document.getElementById('loc_code').value; if (!code) return this.toast(this.t('selectMaterial'), 'error');
    try { const data = await this.api(`/api/location-stock?code=${code}`); document.getElementById('loc-content').innerHTML = `<div class="card"><div class="card-title">${data.material.code} - ${data.material.name}</div><div class="table-wrap"><table><thead><tr><th>${this.t('in_location')}</th><th>${this.t('loc_opening')}</th><th>${this.t('loc_total_in')}</th><th>${this.t('loc_total_out')}</th><th>${this.t('loc_stock')}</th></tr></thead><tbody>${data.locations.map(l => `<tr><td>${l.location}</td><td class="text-right">${l.opening}</td><td class="text-right">${l.total_in}</td><td class="text-right">${l.total_out}</td><td class="text-right"><strong>${l.stock}</strong></td></tr>`).join('')}</tbody></table></div></div>`; } catch (e) { document.getElementById('loc-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  async queryLocByLocation() {
    const location = document.getElementById('loc_name').value; if (!location) return this.toast(this.t('selectLocation'), 'error');
    try { const data = await this.api(`/api/location-stock?location=${encodeURIComponent(location)}`); document.getElementById('loc-content').innerHTML = `<div class="card"><div class="card-title">${location}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th><th>${this.t('mat_brand')}</th><th>${this.t('mat_unit')}</th><th>${this.t('loc_stock')}</th></tr></thead><tbody>${data.items.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.brand || ''}</td><td>${m.unit}</td><td class="text-right"><strong>${m.location_stock}</strong></td></tr>`).join('')}</tbody></table></div></div>`; } catch (e) { document.getElementById('loc-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

});

undefined
