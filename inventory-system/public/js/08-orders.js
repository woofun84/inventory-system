/**
 * 采购 —— 采购订单、订单明细、订单明细跟踪
 */
Object.assign(App, {
  // ========== 采购订单 ==========
  async renderOrders() {
    const addBtn = this.can('orders','create') ? `<button class="btn btn-primary" onclick="App.editOrder()">+ ${this.t('po_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('ord_filter', 'App.onOrdersFilter()', addBtn);
    this.setMain(this.pageWrap('🛒 ' + this.t('po_title'), this.t('po_desc'), '', `<div id="orders-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="orders-scroll"></div><div class="data-pager" id="orders-pager"></div></div>`));
    try {
      this._ordersData = await this.api('/api/purchase-orders');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['orders'] = () => this.renderOrdersTable();
      this.renderOrdersTable();
    } catch (e) { document.getElementById('orders-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderOrdersTable() {
    const data = this._ordersData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'orders';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('ord_filter')?.value || '';
    const filterFields = ['po_no','date','supplier','contract_no','project','expected_date','line_count','order_amount','received_amount','delivery_status','overdue_days','manual_status'];
    const filtered = this.filterByKeywords(data, keywords, filterFields);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['po_no', this.t('po_no')], ['date', this.t('po_date')], ['supplier', this.t('po_supplier')],
      ['contract_no', this.t('po_contract')], ['project', this.t('po_project')], ['expected_date', this.t('po_expected')],
      ['line_count', this.t('po_lines')],
      ...vp ? [['order_amount', this.t('po_amount')], ['received_amount', this.t('po_received')]] : [],
      ['delivery_status', this.t('po_delivery')], ['overdue_days', this.t('po_overdue')], ['manual_status', this.t('po_manual')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th></th>`;
    const colCount = headers.length + 1;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(o => `<tr><td><strong>${o.po_no}</strong></td><td>${this.fmtDate(o.date)}</td><td>${o.supplier || ''}</td><td>${o.contract_no || ''}</td><td>${o.project || ''}</td><td>${this.fmtDate(o.expected_date)}</td><td class="text-center">${o.line_count}</td>${vp ? `<td class="text-right">${cur} ${this.fmtMoney(o.order_amount)}</td><td class="text-right">${cur} ${this.fmtMoney(o.received_amount)}</td>` : ''}<td>${this.statusBadge(o.delivery_status)}</td><td class="text-center">${o.overdue_days > 0 ? '<span class="badge badge-danger">' + o.overdue_days + '</span>' : '-'}</td><td>${o.manual_status || this.t('po_status_pending')}</td><td>${this.can('orders','edit') ? `<span class="action-link" onclick="App.editOrder('${o.po_no}')">${this.t('edit')}</span>` : ''}${this.can('orders','delete') ? `<span class="action-link danger" onclick="App.deleteOrder('${o.po_no}')">${this.t('delete')}</span>` : ''}</td></tr>`).join(''); }
    document.getElementById('orders-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('orders-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  async editOrder(poNo) {
    let o = { po_no: '', date: new Date().toISOString().slice(0, 10), supplier: '', contract_no: '', project: '', expected_date: '', remarks: '', manual_status: '' };
    if (poNo) { const data = await this.api('/api/purchase-orders'); o = data.find(d => d.po_no === poNo) || o; }
    const suppliers = await this.api('/api/suppliers'), dests = this.params.destinations.map(d => d.name);
    const supSel = suppliers.map(s => `<option value="${s.name}" ${s.name === o.supplier ? 'selected' : ''}>${s.name}</option>`).join('');
    const destSel = dests.map(d => `<option value="${d}" ${d === o.project ? 'selected' : ''}>${d}</option>`).join('');
    this.showModal(`<h3>${poNo ? this.t('po_edit') : this.t('po_add')}</h3>`, `<div class="form-grid"><div class="form-group"><label>${this.t('po_no')} *</label><input id="o_po_no" value="${o.po_no}" ${poNo ? 'readonly' : ''} oninput="App.clearFieldError('o_po_no')"><div class="form-error" id="o_po_no_error"></div></div><div class="form-group"><label>${this.t('po_date')} *</label><input id="o_date" type="date" value="${this.fmtDate(o.date)}" oninput="App.clearFieldError('o_date')"><div class="form-error" id="o_date_error"></div></div><div class="form-group"><label>${this.t('po_supplier')}</label><select id="o_supplier"><option value="">${this.t('none')}</option>${supSel}</select></div><div class="form-group"><label>${this.t('po_contract')}</label><input id="o_contract_no" value="${o.contract_no || ''}"></div><div class="form-group"><label>${this.t('po_project')}</label><select id="o_project"><option value="">${this.t('none')}</option>${destSel}</select></div><div class="form-group"><label>${this.t('po_expected')}</label><input id="o_expected_date" type="date" value="${this.fmtDate(o.expected_date)}"></div><div class="form-group"><label>${this.t('po_manual')}</label><select id="o_manual_status"><option value="">${this.t('po_status_pending')}</option><option value="已关闭" ${o.manual_status === '已关闭' ? 'selected' : ''}>${this.t('po_status_closed')}</option><option value="已取消" ${o.manual_status === '已取消' ? 'selected' : ''}>${this.t('po_status_cancelled')}</option></select></div><div class="form-group" style="grid-column:span 2"><label>${this.t('in_remarks')}</label><input id="o_remarks" value="${o.remarks || ''}"></div></div>`, poNo ? this.t('save') : this.t('create'), async () => {
      if (!this.validateForm({ o_po_no: [{rule:'required'}], o_date: [{rule:'required'}] })) return;
      const body = { po_no: document.getElementById('o_po_no').value.trim(), date: document.getElementById('o_date').value, supplier: document.getElementById('o_supplier').value, contract_no: document.getElementById('o_contract_no').value.trim(), project: document.getElementById('o_project').value, expected_date: document.getElementById('o_expected_date').value, remarks: document.getElementById('o_remarks').value.trim(), manual_status: document.getElementById('o_manual_status').value };
      try { await this.api('/api/purchase-orders' + (poNo ? '/' + poNo : ''), poNo ? 'PUT' : 'POST', body); this.closeModal(); this.toast(poNo ? this.t('updated') : this.t('created')); this.renderOrders(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  async deleteOrderLineById(id) {
    this.confirmDialog(this.t('cf_delete_line'), '', async () => {
      try { await this.api('/api/order-lines/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderOrderTracking(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  // 批量添加采购明细（对齐批量入库弹窗结构）
  async editOrderLineBatch() {
    const materials = await this.api('/api/materials');
    const orders = await this.api('/api/purchase-orders');
    this._materialsCache = materials;
    const vp = this.canViewPrice();
    this._otOrders = orders;
    const categories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    this._otMatCategories = categories;

    // 采购单号下拉（必选）
    const poOptions = orders.map(o => `<option value="${o.po_no}">${o.po_no}</option>`).join('');
    // 合同号下拉（可选，按行不同）
    const contractNos = [...new Set(orders.map(o => o.contract_no).filter(Boolean))].sort();
    const contractOptions = contractNos.length > 0
      ? contractNos.map(c => `<option value="${c}">${c}</option>`).join('')
      : `<option value="" disabled>${this.t('in_no_contracts')}</option>`;

    this.showModal(`<h3>${this.t('po_batch_title')}</h3>`, `<div style="margin-bottom:12px;font-size:12px;color:var(--text-muted)">${this.t('po_batch_desc')}</div>
      <div class="form-grid">
        <div class="form-group" style="grid-column:span 2">
          <label>${this.t('po_select_source')}</label>
          <div style="display:flex;gap:8px;align-items:center">
            <select id="ol_po_no" onchange="App.onBatchPoChange()" style="flex:1"><option value="">${this.t('in_select_order')}</option>${poOptions}</select>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:12px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${this.t('po_lines_title')}</strong>
          <button class="btn btn-outline btn-sm" onclick="App.addOrderLineRow()">+ ${this.t('in_add_row')}</button>
        </div>
        <div class="table-wrap"><table id="ol_table"><thead><tr>
          <th>${this.t('mat_level_category')}</th><th>${this.t('mat_level_name')}</th><th>${this.t('mat_level_spec')}</th><th>${this.t('po_order_qty')} *</th>${vp ? `<th>${this.t('po_order_price')}</th>` : ''}<th>${this.t('po_contract')}</th><th>${this.t('in_remarks')}</th><th></th>
        </tr></thead><tbody id="ol_rows"></tbody></table></div>
      </div>`, this.t('po_batch_submit'), async () => {
      const poNo = document.getElementById('ol_po_no').value;
      if (!poNo) { this.toast(this.t('in_select_order'), 'error'); return; }
      const rows = document.querySelectorAll('#ol_rows tr');
      const items = [];
      const seenCodes = new Set();
      rows.forEach(tr => {
        const code = tr.getAttribute('data-code') || '';
        const order_qty = parseFloat(tr.querySelector('.ol-qty').value) || 0;
        const order_price = parseFloat(tr.querySelector('.ol-price')?.value) || 0;
        const contract_no = tr.querySelector('.ol-contract')?.value || '';
        const remarks = tr.querySelector('.ol-remarks').value.trim();
        if (code && order_qty > 0) {
          // 同PO同物料重复检查
          const key = poNo + '|' + code;
          if (seenCodes.has(key)) {
            throw new Error(`${this.t('ot_code')} ${code} ${this.t('po_duplicate')}`);
          }
          seenCodes.add(key);
          items.push({ po_no: poNo, code, order_qty, order_price, remarks, contract_no });
        }
      });
      if (items.length === 0) { this.toast(this.t('fillRequired'), 'error'); return; }
      try {
        await this.api('/api/order-lines/batch', 'POST', { items });
        this.closeModal();
        this.toast(this.t('added') + ' (' + items.length + ')');
        this.renderOrderTracking();
      } catch (e) { this.toast(e.message, 'error'); }
    }, null, true); // large modal

    // 默认加3个空行
    this.addOrderLineRow();
    this.addOrderLineRow();
    this.addOrderLineRow();
  },

  // 批量添加时切换PO，自动填充默认合同号
  onBatchPoChange() {
    const poNo = document.getElementById('ol_po_no').value;
    if (!poNo) return;
    const orders = this._otOrders || [];
    const order = orders.find(o => o.po_no === poNo);
    if (order && order.contract_no) {
      // 给所有已有行的合同号下拉设置默认值
      document.querySelectorAll('#ol_rows .ol-contract').forEach(sel => {
        if (!sel.value) sel.value = order.contract_no;
      });
    }
  },

  // 采购明细行 — 三级联动物料选择（对齐入库行）
  addOrderLineRow() {
    const cats = this._otMatCategories || [];
    const materials = this._materialsCache || [];
    const tbody = document.getElementById('ol_rows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.setAttribute('data-code', '');
    const catOpts = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const vp = this.canViewPrice();
    // 合同号选项（从已加载的订单中提取）
    const contractNos = [...new Set((this._otOrders || []).map(o => o.contract_no).filter(Boolean))].sort();
    const contractOpts = contractNos.length > 0
      ? contractNos.map(c => `<option value="${c}">${c}</option>`).join('')
      : '';
    tr.innerHTML = `<td><select class="ol-cat" onchange="App.onOrderLineRowCatChange(this)" style="width:120px"><option value="">${this.t('please_select')}</option>${catOpts}</select></td>
      <td><select class="ol-name" onchange="App.onOrderLineRowNameChange(this)" style="width:140px" disabled><option value="">${this.t('please_select')}</option></select></td>
      <td><select class="ol-spec-sel" onchange="App.onOrderLineRowSpecChange(this)" style="width:200px" disabled><option value="">${this.t('please_select')}</option></select></td>
      <td><input class="ol-qty" type="number" step="0.01" value="" style="width:80px"></td>
      ${vp ? `<td><input class="ol-price" type="number" step="0.01" value="" style="width:90px"></td>` : '<td><input class="ol-price" type="hidden" value="0"></td>'}
      <td><select class="ol-contract" style="width:120px"><option value="">${this.t('none')}</option>${contractOpts}</select></td>
      <td><input class="ol-remarks" value="" style="width:120px"></td>
      <td><span class="action-link danger" onclick="this.parentElement.parentElement.remove()">${this.t('in_remove_row')}</span></td>`;
    tbody.appendChild(tr);
  },

  onOrderLineRowCatChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = selEl.value;
    const materials = this._materialsCache || [];
    const names = cat ? [...new Set(materials.filter(m => m.category === cat).map(m => m.name))] : [];
    const nameSel = tr.querySelector('.ol-name');
    nameSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + names.map(n => `<option value="${n}">${n}</option>`).join('');
    nameSel.disabled = !cat;
    const specSel = tr.querySelector('.ol-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>`;
    specSel.disabled = true;
    tr.setAttribute('data-code', '');
  },

  onOrderLineRowNameChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = tr.querySelector('.ol-cat').value;
    const name = selEl.value;
    const materials = this._materialsCache || [];
    const specs = (cat && name) ? materials.filter(m => m.category === cat && m.name === name) : [];
    const specSel = tr.querySelector('.ol-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}">${label}</option>`;
    }).join('');
    specSel.disabled = !name;
    tr.setAttribute('data-code', '');
  },

  onOrderLineRowSpecChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const code = selEl.value;
    const m = (this._materialsCache || []).find(x => x.code === code);
    if (m) {
      tr.setAttribute('data-code', code);
      const priceInput = tr.querySelector('.ol-price');
      if (!priceInput.value) priceInput.value = m.opening_price || '';
    } else {
      tr.setAttribute('data-code', '');
    }
  },

  async deleteOrder(poNo) { this.confirmDialog(this.t('cf_delete_order') + ' ' + poNo, this.t('cf_delete_order_msg'), async () => { try { await this.api('/api/purchase-orders/' + poNo, 'DELETE'); this.toast(this.t('deleted')); this.renderOrders(); } catch (e) { this.toast(e.message, 'error'); } }); },

  onOrdersFilter() {
    const st = this.getTableState('orders');
    st.page = 1;
    this.renderOrdersTable();
  },

  // ========== 供应商档案 ==========
  async renderSuppliers() {
    const addBtn = this.can('suppliers','create') ? `<button class="btn btn-primary" onclick="App.editSupplier()">+ ${this.t('sup_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('sup_filter', 'App.onSuppliersFilter()', addBtn);
    this.setMain(this.pageWrap('🚚 ' + this.t('sup_title'), this.t('sup_desc'), '', `<div id="suppliers-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="suppliers-scroll"></div><div class="data-pager" id="suppliers-pager"></div></div>`));
    try {
      this._suppliersData = await this.api('/api/suppliers');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['suppliers'] = () => this.renderSuppliersTable();
      this.renderSuppliersTable();
    } catch (e) { document.getElementById('suppliers-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderSuppliersTable() {
    const data = this._suppliersData;
    if (!data) return;
    const tid = 'suppliers';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('sup_filter')?.value || '';
    const filterFields = ['name','contact','phone','remarks'];
    const filtered = this.filterByKeywords(data, keywords, filterFields);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['name', this.t('sup_name')], ['contact', this.t('sup_contact')],
      ['phone', this.t('sup_phone')], ['remarks', this.t('sup_remarks')]
    ];
    let thHtml = `<th>${this.t('sup_seq')}</th>`;
    thHtml += headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th></th>`;
    const colCount = headers.length + 2;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else {
      const startIdx = (st.page - 1) * st.pageSize;
      tbody = pageData.map((s, i) => `<tr><td class="text-center">${startIdx + i + 1}</td><td><strong>${s.name}</strong></td><td>${s.contact || ''}</td><td>${s.phone || ''}</td><td>${s.remarks || ''}</td><td>${this.rowActions('suppliers', `App.editSupplier(${s.id})`, `App.deleteSupplier(${s.id})`)}</td></tr>`).join('');
    }
    document.getElementById('suppliers-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('suppliers-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  async editSupplier(id) {
    let s = { name: '', contact: '', phone: '', remarks: '' };
    if (id) { const data = await this.api('/api/suppliers'); s = data.find(d => d.id === id) || s; }
    this.showModal(`<h3>${id ? this.t('sup_edit') : this.t('sup_add')}</h3>`, `<div class="form-grid"><div class="form-group" style="grid-column:span 2"><label>${this.t('sup_name')} *</label><input id="s_name" value="${s.name}" oninput="App.clearFieldError('s_name')"><div class="form-error" id="s_name_error"></div></div><div class="form-group"><label>${this.t('sup_contact')}</label><input id="s_contact" value="${s.contact || ''}"></div><div class="form-group"><label>${this.t('sup_phone')}</label><input id="s_phone" value="${s.phone || ''}"></div><div class="form-group" style="grid-column:span 2"><label>${this.t('sup_remarks')}</label><input id="s_remarks" value="${s.remarks || ''}"></div></div>`, id ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ s_name: [{rule:'required'}] })) return;
      const body = { name: document.getElementById('s_name').value.trim(), contact: document.getElementById('s_contact').value.trim(), phone: document.getElementById('s_phone').value.trim(), remarks: document.getElementById('s_remarks').value.trim() };
      try { await this.api('/api/suppliers' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body); this.closeModal(); this.toast(id ? this.t('updated') : this.t('added')); this.renderSuppliers(); } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  async deleteSupplier(id) { this.confirmDialog(this.t('cf_delete_supplier'), '', async () => { try { await this.api('/api/suppliers/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderSuppliers(); } catch (e) { this.toast(e.message, 'error'); } }); },

  onSuppliersFilter() {
    const st = this.getTableState('suppliers');
    st.page = 1;
    this.renderSuppliersTable();
  },

  // ========== 参数设置 ==========
  async renderSettings() {
    this.setMain(this.pageWrap('⚙ ' + this.t('set_title'), this.t('set_desc'), '', `<div id="settings-content"><p style="text-align:center;padding:20px;color:var(--text-muted)">${this.t('loading')}</p></div>`));
    try {
      const data = await this.api('/api/params'); let html = '';
      const sections = [
        { key: 'categories', title: this.t('set_categories'), fields: ['name', 'prefix'], headers: [this.t('set_cat_name'), this.t('set_cat_prefix')] },
        { key: 'units', title: this.t('set_units'), fields: ['name'], headers: [this.t('set_unit_name')] },
        { key: 'destinations', title: this.t('set_destinations'), fields: ['name'], headers: [this.t('set_dest_name')] },
        { key: 'locations', title: this.t('set_locations'), fields: ['name'], headers: [this.t('set_loc_name')] }
      ];
      sections.forEach(s => {
        const items = data[s.key];
        const canCreate = this.can('settings','create'), canDelete = this.can('settings','delete');
        const thHtml = s.headers.map(h => '<th>' + h + '</th>').join('') + '<th></th>';
        const rowsHtml = items.map(item => {
          const cells = s.fields.map(f => '<td>' + (item[f] || '') + '</td>').join('');
          const del = canDelete ? '<td><span class="action-link danger" onclick="App.deleteParam(\'' + s.key + '\',' + item.id + ')">' + this.t('delete') + '</span></td>' : '<td></td>';
          return '<tr>' + cells + del + '</tr>';
        }).join('');
        let addRow = '';
        if (canCreate) {
          const inputs = s.fields.map(f => {
            const idx = s.fields.indexOf(f);
            return '<div class="form-group"><label>' + s.headers[idx] + '</label><input id="add_' + s.key + '_' + f + '" placeholder="' + s.headers[idx] + '"></div>';
          }).join('');
          addRow = '<div style="margin-top:8px;display:flex;gap:8px;align-items:flex-end">' + inputs + '<button class="btn btn-primary btn-sm" onclick="App.addParam(\'' + s.key + '\')">+ ' + this.t('add') + '</button></div>';
        }
        html += '<div class="card"><div class="card-title">' + s.title + '（' + items.length + '）</div><div class="table-wrap"><table><thead><tr>' + thHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' + addRow + '</div>';
      });
      document.getElementById('settings-content').innerHTML = html;
    } catch (e) { document.getElementById('settings-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  async addParam(type) {
    const fields = type === 'categories' ? ['name', 'prefix'] : ['name']; const body = {};
    fields.forEach(f => body[f] = document.getElementById(`add_${type}_${f}`).value.trim());
    if (!body.name) { this.toast(this.t('fillRequired'), 'error'); const el = document.getElementById(`add_${type}_name`); if (el) { el.classList.add('error'); el.focus(); } return; }
    try { await this.api(`/api/params/${type}`, 'POST', body); this.toast(this.t('added')); this.renderSettings(); } catch (e) { this.toast(e.message, 'error'); }
  },

  async deleteParam(type, id) { this.confirmDialog(this.t('cf_delete_param'), '', async () => { try { await this.api(`/api/params/${type}/${id}`, 'DELETE'); this.toast(this.t('deleted')); this.renderSettings(); } catch (e) { this.toast(e.message, 'error'); } }); },

  // ========== 订单明细跟踪 ==========
  async renderOrderTracking() {
    const addBtn = this.can('orders', 'create') ? `<button class="btn btn-primary" onclick="App.editOrderLineBatch()">+ ${this.t('po_batch_add')}</button>` : '';
    // 维度切换 + 状态筛选
    const toolbar = this.renderTableToolbar('ot_filter', 'App.onOrderTrackingFilter()', `
      <div style="display:flex;gap:8px;align-items:center">
        ${addBtn}
        <select id="ot_view_mode" onchange="App.onOrderTrackingFilter()" style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;background:var(--card-bg);color:var(--text)">
          <option value="po">${this.t('ot_view_po')}</option>
          <option value="contract">${this.t('ot_view_contract')}</option>
        </select>
        <select id="ot_status_filter" onchange="App.onOrderTrackingFilter()" style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;background:var(--card-bg);color:var(--text)">
          <option value="">${this.t('stock_all')}</option>
          <option value="未到货">${this.t('st_not_arrived')}</option>
          <option value="部分到货">${this.t('st_partial')}</option>
          <option value="已到货">${this.t('st_arrived')}</option>
        </select>
      </div>`);
    this.setMain(this.pageWrap('📋 ' + this.t('ot_title'), this.t('ot_desc'), '', `<div id="ot-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-summary" id="ot-summary"></div><div class="data-scroll" id="ot-scroll"></div><div class="data-pager" id="ot-pager"></div></div>`));
    try {
      const viewMode = this._otViewMode || 'po';
      const data = await this.api('/api/order-tracking?view=' + viewMode);
      this._otData = data;
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['orderTracking'] = () => this.renderOrderTrackingTable();
      this.renderOrderTrackingTable();
    } catch (e) { document.getElementById('ot-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderOrderTrackingTable() {
    const data = this._otData;
    if (!data) return;
    const viewMode = data.view || 'po';
    const rows = data.rows || [];
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'orderTracking';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('ot_filter')?.value || '';
    const statusFilter = document.getElementById('ot_status_filter')?.value || '';

    let filtered = rows;
    if (keywords.trim()) {
      const kw = keywords.toLowerCase();
      filtered = filtered.filter(r =>
        (r.po_no || '').toLowerCase().includes(kw) ||
        (r.contract_no || '').toLowerCase().includes(kw) ||
        (r.code || '').toLowerCase().includes(kw) ||
        (r.material_name || '').toLowerCase().includes(kw) ||
        (r.material_spec || '').toLowerCase().includes(kw) ||
        (r.material_brand || '').toLowerCase().includes(kw)
      );
    }
    if (statusFilter) filtered = filtered.filter(r => r.line_status === statusFilter);

    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const totalLines = sorted.length;
    const totalAmount = sorted.reduce((s, r) => s + (r.order_amount || 0), 0);
    const totalReceived = sorted.reduce((s, r) => s + (r.received_qty * r.order_price || 0), 0);
    const totalUnreceived = totalAmount - totalReceived;

    let thHtml, tbody;
    if (viewMode === 'contract') {
      // 按合同维度：合同号 + PO + 物料
      const headers = [
        ['contract_no', this.t('po_contract')], ['po_no', this.t('ot_po_no')], ['po_date', this.t('ot_po_date')], ['po_supplier', this.t('ot_supplier')],
        ['code', this.t('ot_code')], ['material_name', this.t('ot_material')], ['material_spec', this.t('ot_spec')],
        ['material_brand', this.t('ot_brand')], ['material_unit', this.t('ot_unit')],
        ['order_qty', this.t('ot_order_qty')],
        ...vp ? [['order_price', this.t('ot_order_price')], ['order_amount', this.t('ot_order_amount')]] : [],
        ['received_qty', this.t('ot_received_qty')],
        ['unreceived_qty', this.t('ot_unreceived')], ['expected_date', this.t('ot_expected')],
        ['line_status', this.t('ot_status')], ['overdue_days', this.t('ot_overdue')]
      ];
      thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      thHtml += `<th></th>`;
      const colCount = headers.length + 1;
      if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
      else {
        tbody = pageData.map(r => `<tr><td>${r.contract_no || '-'}</td><td><strong>${r.po_no}</strong></td><td>${this.fmtDate(r.po_date)}</td><td>${r.po_supplier || ''}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_spec || ''}</td><td>${r.material_brand || ''}</td><td>${r.material_unit || ''}</td><td class="text-right">${r.order_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.order_price)}</td><td class="text-right">${cur} ${this.fmtMoney(r.order_amount)}</td>` : ''}<td class="text-right">${r.received_qty}</td><td class="text-right"><strong>${r.unreceived_qty}</strong></td><td>${this.fmtDate(r.expected_date)}</td><td>${this.statusBadge(r.line_status)}</td><td class="text-center">${r.overdue_days > 0 ? '<span class="badge badge-danger">' + r.overdue_days + '</span>' : '-'}</td><td>${this.can('orders','delete') ? `<span class="action-link danger" onclick="App.deleteOrderLineById(${r.id})">${this.t('delete')}</span>` : ''}</td></tr>`).join('');
      }
    } else {
      // 按PO维度（与原来一致）
      const headers = [
        ['po_no', this.t('ot_po_no')], ['po_date', this.t('ot_po_date')], ['po_supplier', this.t('ot_supplier')],
        ['code', this.t('ot_code')], ['material_name', this.t('ot_material')], ['material_spec', this.t('ot_spec')],
        ['material_brand', this.t('ot_brand')], ['material_unit', this.t('ot_unit')],
        ['order_qty', this.t('ot_order_qty')],
        ...vp ? [['order_price', this.t('ot_order_price')], ['order_amount', this.t('ot_order_amount')]] : [],
        ['received_qty', this.t('ot_received_qty')],
        ['unreceived_qty', this.t('ot_unreceived')], ['expected_date', this.t('ot_expected')],
        ['line_status', this.t('ot_status')], ['overdue_days', this.t('ot_overdue')]
      ];
      thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
      thHtml += `<th></th>`;
      const colCount = headers.length + 1;
      if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
      else {
        tbody = pageData.map(r => `<tr><td><strong>${r.po_no}</strong></td><td>${this.fmtDate(r.po_date)}</td><td>${r.po_supplier || ''}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_spec || ''}</td><td>${r.material_brand || ''}</td><td>${r.material_unit || ''}</td><td class="text-right">${r.order_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.order_price)}</td><td class="text-right">${cur} ${this.fmtMoney(r.order_amount)}</td>` : ''}<td class="text-right">${r.received_qty}</td><td class="text-right"><strong>${r.unreceived_qty}</strong></td><td>${this.fmtDate(r.expected_date)}</td><td>${this.statusBadge(r.line_status)}</td><td class="text-center">${r.overdue_days > 0 ? '<span class="badge badge-danger">' + r.overdue_days + '</span>' : '-'}</td><td>${this.can('orders','delete') ? `<span class="action-link danger" onclick="App.deleteOrderLineById(${r.id})">${this.t('delete')}</span>` : ''}</td></tr>`).join('');
      }
    }

    document.getElementById('ot-summary').innerHTML = `${this.t('ot_total_lines')}: ${totalLines}${vp ? ` | ${this.t('ot_total_amount')}: ${cur} ${this.fmtMoney(totalAmount)} | ${this.t('ot_total_received')}: ${cur} ${this.fmtMoney(totalReceived)} | ${this.t('ot_total_unreceived')}: ${cur} ${this.fmtMoney(totalUnreceived)}` : ''}`;
    document.getElementById('ot-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('ot-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onOrderTrackingFilter() {
    const st = this.getTableState('orderTracking');
    st.page = 1;
    // 记录当前视图模式，重新加载数据
    const viewMode = document.getElementById('ot_view_mode')?.value || 'po';
    this._otViewMode = viewMode;
    // 如果切换了视图模式，需要重新请求数据
    this.api('/api/order-tracking?view=' + viewMode).then(data => {
      this._otData = data;
      this.renderOrderTrackingTable();
    }).catch(e => {
      this.toast(e.message, 'error');
    });
  },

});

undefined
