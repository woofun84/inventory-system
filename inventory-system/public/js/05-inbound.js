/**
 * 入库记录 —— 列表、批量入库表单、按订单号带出明细
 */
Object.assign(App, {
  // ========== 入库记录 ==========
  async renderInbound() {
    const dateFilter = { fromId: 'in_date_from', toId: 'in_date_to', onChange: 'App.onInboundFilter()' };
    const addBtn = this.can('inbound','create') ? `<button class="btn btn-primary" onclick="App.editInboundBatch()">+ ${this.t('in_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('in_filter', 'App.onInboundFilter()', addBtn, dateFilter);
    this.setMain(this.pageWrap('📥 ' + this.t('in_title'), this.t('in_desc'), '', `<div id="inbound-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-summary" id="inbound-summary"></div><div class="data-scroll" id="inbound-scroll"></div><div class="data-pager" id="inbound-pager"></div></div>`));
    try {
      this._inboundData = await this.api('/api/inbound');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['inbound'] = () => this.renderInboundTable();
      this.renderInboundTable();
    } catch (e) { document.getElementById('inbound-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderInboundTable() {
    const data = this._inboundData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'inbound';
    const st = this.getTableState(tid);
    // 读取筛选值
    const keywords = document.getElementById('in_filter')?.value || '';
    const dateFrom = document.getElementById('in_date_from')?.value || '';
    const dateTo = document.getElementById('in_date_to')?.value || '';
    // 关键字 + 日期段筛选
    const filterFields = ['date','grn_no','code','material_name','material_spec','material_brand','material_unit','qty','price','amount','supplier','handler','location','po_no','contract_no','txn_type','remarks'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    filtered = this.filterByDateRange(filtered, 'date', dateFrom, dateTo);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    let totalQty = 0, totalAmount = 0; sorted.forEach(r => { totalQty += r.qty; totalAmount += r.amount; });
    const headers = [
      ['date', this.t('in_date')], ['grn_no', this.t('in_grn')], ['txn_type', this.t('in_txn_type')],
      ['code', this.t('mat_code')], ['material_name', this.t('mat_name')], ['material_spec', this.t('mat_spec')], ['material_brand', this.t('mat_brand')],
      ['material_unit', this.t('mat_unit')], ['qty', this.t('in_qty')],
      ...vp ? [['price', this.t('in_price')], ['amount', this.t('in_total_amount')]] : [],
      ['supplier', this.t('in_supplier')], ['handler', this.t('in_handler')],
      ['location', this.t('in_location')], ['po_no', this.t('in_po_no')], ['contract_no', this.t('in_contract')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('in_remarks')}</th><th></th>`;
    const colCount = headers.length + 2;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(r => { const txnBadge = r.txn_type === '采购退货' ? `<span class="badge badge-danger">${this.t('in_return')}</span>` : `<span class="badge badge-info">${this.t('in_purchase')}</span>`; return `<tr><td>${this.fmtDate(r.date)}</td><td>${r.grn_no}</td><td>${txnBadge}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_spec || ''}</td><td>${r.material_brand || ''}</td><td>${r.material_unit || ''}</td><td class="text-right">${r.qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.price)}</td><td class="text-right">${this.fmtMoney(r.amount)}</td>` : ''}<td>${r.supplier || ''}</td><td>${r.handler || ''}</td><td>${r.location || ''}</td><td>${r.po_no || ''}</td><td>${r.contract_no || ''}</td><td>${r.remarks || ''}</td><td>${this.rowActions('inbound', `App.editInbound(${r.id})`, `App.deleteInbound(${r.id})`)}</td></tr>`; }).join(''); }
    const filterActive = (keywords.trim() || dateFrom || dateTo) ? ` | 🔍 ${sorted.length}/${data.length}` : '';
    document.getElementById('inbound-summary').innerHTML = `${sorted.length} ${this.t('in_total_records')} | ${this.t('in_total_qty')}: ${totalQty}${vp ? ` | ${this.t('in_total_amount')}: ${cur} ${this.fmtMoney(totalAmount)}` : ''}${filterActive}`;
    document.getElementById('inbound-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('inbound-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onInboundFilter() {
    const st = this.getTableState('inbound');
    st.page = 1;
    this.renderInboundTable();
  },

  // 批量新增入库
  async editInboundBatch() {
    const materials = await this.api('/api/materials');
    const suppliers = await this.api('/api/suppliers');
    const orders = await this.api('/api/purchase-orders');
    // 加载库存汇总，用于采购退货时显示可用库存并做前端预校验
    let stockMap = {};
    try {
      const stock = await this.api('/api/stock-summary');
      stockMap = Object.fromEntries(stock.map(s => [s.code, s.on_hand]));
    } catch (e) { /* 加载失败不阻断 */ }
    this._inboundStockMap = stockMap;
    const locs = this.params.locations.map(l => l.name);
    const today = new Date().toISOString().slice(0, 10);

    // #1: 只显示未到货和部分到货的订单
    const pendingOrders = orders.filter(o => o.delivery_status === '未到货' || o.delivery_status === '部分到货');
    // #1: 合同号下拉 — 从所有采购订单中提取去重的合同号
    const contractNos = [...new Set(orders.map(o => o.contract_no).filter(Boolean))].sort();
    const supOptions = suppliers.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    const poOptions = pendingOrders.length > 0
      ? pendingOrders.map(o => `<option value="${o.po_no}">${o.po_no} (${o.delivery_status})</option>`).join('')
      : `<option value="" disabled>${this.t('in_no_pending_orders')}</option>`;
    const contractOptions = contractNos.length > 0
      ? contractNos.map(c => `<option value="${c}">${c}</option>`).join('')
      : `<option value="" disabled>${this.t('in_no_contracts')}</option>`;
    const locOptions = locs.map(l => `<option value="${l}">${l}</option>`).join('');

    // #4: 物料三级联动数据准备
    this._materialsCache = materials;
    this._inboundOrders = orders;
    const vp = this.canViewPrice();
    const categories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();

    this.showModal(`<h3>${this.t('in_batch_title')}</h3>`, `<div style="margin-bottom:12px;font-size:12px;color:var(--text-muted)">${this.t('in_batch_desc')}</div>
      <div class="form-grid">
        <div class="form-group"><label>${this.t('in_date')} *</label><input id="ib_date" type="date" value="${today}"></div>
        <div class="form-group"><label>${this.t('in_txn_type')} *</label><select id="ib_txn_type" onchange="App.refreshInboundStockHints()"><option value="采购入库">${this.t('in_purchase')}</option><option value="采购退货">${this.t('in_return')}</option></select></div>
        <div class="form-group"><label>${this.t('in_supplier')}</label><select id="ib_supplier"><option value="">${this.t('none')}</option>${supOptions}</select></div>
        <div class="form-group"><label>${this.t('in_handler')}</label><input id="ib_handler" value=""></div>
        <div class="form-group"><label>${this.t('in_location')}</label><select id="ib_location"><option value="">${this.t('none')}</option>${locOptions}</select></div>
        <div class="form-group" style="grid-column:span 2">
          <label>${this.t('in_source_mode')}</label>
          <div style="display:flex;gap:8px;align-items:center">
            <select id="ib_source_mode" onchange="App.onInboundSourceModeChange()" style="width:140px">
              <option value="manual">${this.t('in_source_manual')}</option>
              <option value="po">${this.t('in_source_po')}</option>
              <option value="contract">${this.t('in_source_contract')}</option>
            </select>
            <div id="ib_po_wrap" style="display:none;flex:1">
              <select id="ib_po_no" onchange="App.loadOrderLinesForInbound()" style="width:100%"><option value="">${this.t('in_select_order')}</option>${poOptions}</select>
            </div>
            <div id="ib_contract_wrap" style="display:none;flex:1">
              <select id="ib_contract_no" onchange="App.loadOrderLinesForInboundByContract()" style="width:100%"><option value="">${this.t('in_select_contract')}</option>${contractOptions}</select>
            </div>
          </div>
        </div>
      </div>
      <div id="ib_order_lines" style="display:none;margin-bottom:12px"></div>
      <div class="card" style="margin-top:12px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${this.t('in_title')}</strong>
          <button class="btn btn-outline btn-sm" onclick="App.addInboundRow()">+ ${this.t('in_add_row')}</button>
        </div>
        <div class="table-wrap"><table id="ib_table"><thead><tr>
          <th>${this.t('mat_level_category')}</th><th>${this.t('mat_level_name')}</th><th>${this.t('mat_level_spec')}</th><th>${this.t('mat_level_brand')}</th><th>${this.t('in_qty')} *</th><th>${this.t('out_available')}</th>${vp ? `<th>${this.t('in_price')}</th>` : ''}<th>${this.t('in_remarks')}</th><th></th>
        </tr></thead><tbody id="ib_rows"></tbody></table></div>
      </div>`, this.t('in_batch_submit'), async () => {
      const date = document.getElementById('ib_date').value;
      const txnType = document.getElementById('ib_txn_type').value;
      const supplier = document.getElementById('ib_supplier').value;
      const handler = document.getElementById('ib_handler').value.trim();
      const location = document.getElementById('ib_location').value;
      const poNo = document.getElementById('ib_po_no').value;
      const contractNo = document.getElementById('ib_contract_no').value;
      if (!date) { this.toast(this.t('field_required'), 'error'); return; }
      // 收集行数据
      const rows = document.querySelectorAll('#ib_rows tr');
      const items = [];
      rows.forEach(tr => {
        const code = tr.getAttribute('data-code') || '';
        const qty = parseFloat(tr.querySelector('.ib-qty').value) || 0;
        const price = parseFloat(tr.querySelector('.ib-price').value) || 0;
        const remarks = tr.querySelector('.ib-remarks').value.trim();
        if (code && qty > 0) {
          const actualQty = txnType === '采购退货' ? -qty : qty;
          const actualPrice = txnType === '采购退货' ? -price : price;
          items.push({ date, code, qty: actualQty, price: actualPrice, supplier, handler, location, remarks, po_no: poNo, contract_no: contractNo, txn_type: txnType });
        }
      });
      if (items.length === 0) { this.toast(this.t('fillRequired'), 'error'); return; }
      try {
        await this.api('/api/inbound', 'POST', { items });
        this.closeModal();
        this.toast(this.t('added') + ' (' + items.length + ')');
        this.renderInbound();
      } catch (e) {
        if (e.code === 'INSUFFICIENT_STOCK') {
          this.handleInboundStockError(e, { items });
        } else {
          this.toast(e.message, 'error');
        }
      }
    }, null, true); // large modal

    // #4: 缓存物料数据供三级联动使用
    this._materialsCache = materials;
    this._inboundMatCategories = categories;
    // 默认加3个空行
    this.addInboundRow();
    this.addInboundRow();
    this.addInboundRow();
  },

  // 采购退货库存不足：admin/manager 可强制放行
  // payload: { items } 批量 或 { isEdit:true, id, body } 单条
  handleInboundStockError(err, payload) {
    const details = (err.details || []).map(d => `${d.code}：需 ${d.requested}，可用 ${d.available}`).join('\n');
    const canForce = ['admin', 'manager'].includes(this.user?.role);
    if (!canForce) {
      this.toast(`${this.t('out_stock_short')}：${details}`, 'error'); // 复用出库文案
      return;
    }
    const self = this;
    this.confirmDialog(
      this.t('out_stock_short'),
      `${details}\n\n${this.t('out_force_allow')}`,
      async () => {
        try {
          if (payload.isEdit) {
            await self.api('/api/inbound/' + payload.id, 'PUT', { ...payload.body, force_allow: true });
            self.closeModal();
            self.toast(self.t('updated'));
          } else {
            await self.api('/api/inbound', 'POST', { items: payload.items, force_allow: true });
            self.closeModal();
            self.toast(self.t('added') + ' (' + payload.items.length + ')');
          }
          self.renderInbound();
        } catch (e2) { self.toast(e2.message, 'error'); }
      }
    );
  },
  onInboundSourceModeChange() {
    const mode = document.getElementById('ib_source_mode').value;
    document.getElementById('ib_po_wrap').style.display = mode === 'po' ? 'flex' : 'none';
    document.getElementById('ib_contract_wrap').style.display = mode === 'contract' ? 'flex' : 'none';
    // 切换模式时清空订单明细区域
    const c = document.getElementById('ib_order_lines');
    if (c) { c.style.display = 'none'; c.innerHTML = ''; }
  },

  // #4: 批量入库行 — 三级联动物料选择（类别→名称→规格品牌）
  addInboundRow(code = '', qty = '', price = '', remarks = '', spec = '', brand = '') {
    const cats = this._inboundMatCategories || [];
    const materials = this._materialsCache || [];
    const tbody = document.getElementById('ib_rows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.setAttribute('data-code', code);
    // 查找预选物料的 category 和 name
    const mat = code ? materials.find(m => m.code === code) : null;
    const preCat = mat ? mat.category : '';
    const preName = mat ? mat.name : '';

    // 第一级：类别
    const catOpts = cats.map(c => `<option value="${c}" ${c === preCat ? 'selected' : ''}>${c}</option>`).join('');
    // 第二级：名称（基于选中的类别筛选）
    const names = preCat ? [...new Set(materials.filter(m => m.category === preCat).map(m => m.name))] : [];
    const nameOpts = names.map(n => `<option value="${n}" ${n === preName ? 'selected' : ''}>${n}</option>`).join('');
    // 第三级：规格品牌（基于选中的类别+名称筛选）
    const specs = (preCat && preName) ? materials.filter(m => m.category === preCat && m.name === preName) : [];
    const specOpts = specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}" ${m.code === code ? 'selected' : ''}>${label}</option>`;
    }).join('');

    const vp = this.canViewPrice();
    const available = code ? (this._inboundStockMap || {})[code] : null;
    const availText = available === undefined || available === null ? '-' : available;
    const availColor = available === undefined || available === null ? 'var(--text-muted)'
      : (available < 0 ? 'var(--danger)' : (available === 0 ? 'var(--warning)' : 'var(--success)'));

    tr.innerHTML = `<td><select class="ib-cat" onchange="App.onInboundRowCatChange(this)" style="width:120px"><option value="">${this.t('please_select')}</option>${catOpts}</select></td>
      <td><select class="ib-name" onchange="App.onInboundRowNameChange(this)" style="width:140px" ${!preCat ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${nameOpts}</select></td>
      <td><select class="ib-spec-sel" onchange="App.onInboundRowSpecChange(this)" style="width:200px" ${!preName ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${specOpts}</select></td>
      <td class="ib-brand" style="font-size:12px;color:var(--text-muted)">${brand}</td>
      <td><input class="ib-qty" type="number" step="0.01" value="${qty}" style="width:80px" oninput="App.checkInboundRowStock(this)"></td>
      <td class="ib-available" style="font-size:12px;color:${availColor}">${availText}</td>
      ${vp ? `<td><input class="ib-price" type="number" step="0.01" value="${price}" style="width:90px"></td>` : '<td class="ib-price" style="display:none"><input class="ib-price" type="hidden" value="0"></td>'}
      <td><input class="ib-remarks" value="${remarks}" style="width:120px"></td>
      <td><span class="action-link danger" onclick="this.parentElement.parentElement.remove()">${this.t('in_remove_row')}</span></td>`;
    tbody.appendChild(tr);
  },

  // 实时校验：仅「采购退货」时检查数量是否超过可用库存
  checkInboundRowStock(qtyInput) {
    const tr = qtyInput.closest('tr');
    if (!tr) return;
    const code = tr.getAttribute('data-code') || '';
    const cell = tr.querySelector('.ib-available');
    if (!cell) return;
    const map = this._inboundStockMap || {};
    if (!code || map[code] === undefined) {
      cell.textContent = '-';
      cell.style.color = 'var(--text-muted)';
      qtyInput.style.borderColor = '';
      return;
    }
    const available = map[code];
    const qty = parseFloat(qtyInput.value) || 0;
    cell.textContent = available;

    const txnType = document.getElementById('ib_txn_type')?.value || '采购入库';
    const isReturn = txnType === '采购退货';

    if (available < 0) {
      // 历史负库存：后端豁免，仅提示现状
      cell.style.color = 'var(--danger)';
      qtyInput.style.borderColor = '';
      return;
    }
    // 只有采购退货才占用库存
    if (isReturn && qty > available) {
      cell.style.color = 'var(--danger)';
      qtyInput.style.borderColor = 'var(--danger)';
    } else {
      cell.style.color = available === 0 ? 'var(--warning)' : 'var(--success)';
      qtyInput.style.borderColor = '';
    }
  },

  refreshInboundStockHints() {
    document.querySelectorAll('#ib_rows .ib-qty').forEach(inp => this.checkInboundRowStock(inp));
  },

  onInboundRowCatChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = selEl.value;
    const materials = this._materialsCache || [];
    const names = cat ? [...new Set(materials.filter(m => m.category === cat).map(m => m.name))] : [];
    const nameSel = tr.querySelector('.ib-name');
    nameSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + names.map(n => `<option value="${n}">${n}</option>`).join('');
    nameSel.disabled = !cat;
    // 重置第三级
    const specSel = tr.querySelector('.ib-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>`;
    specSel.disabled = true;
    tr.querySelector('.ib-brand').textContent = '';
    tr.setAttribute('data-code', '');
    // 清空可用库存显示
    const cell = tr.querySelector('.ib-available');
    if (cell) { cell.textContent = '-'; cell.style.color = 'var(--text-muted)'; }
    const qtyInput = tr.querySelector('.ib-qty');
    if (qtyInput) qtyInput.style.borderColor = '';
  },

  onInboundRowNameChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = tr.querySelector('.ib-cat').value;
    const name = selEl.value;
    const materials = this._materialsCache || [];
    const specs = (cat && name) ? materials.filter(m => m.category === cat && m.name === name) : [];
    const specSel = tr.querySelector('.ib-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}">${label}</option>`;
    }).join('');
    specSel.disabled = !name;
    tr.querySelector('.ib-brand').textContent = '';
    tr.setAttribute('data-code', '');
    // 清空可用库存显示
    const cell = tr.querySelector('.ib-available');
    if (cell) { cell.textContent = '-'; cell.style.color = 'var(--text-muted)'; }
    const qtyInput = tr.querySelector('.ib-qty');
    if (qtyInput) qtyInput.style.borderColor = '';
  },

  onInboundRowSpecChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const code = selEl.value;
    const m = (this._materialsCache || []).find(x => x.code === code);
    if (m) {
      tr.querySelector('.ib-brand').textContent = m.brand || '';
      tr.setAttribute('data-code', code);
      // 如果单价为空，带出期初单价作为默认
      const priceInput = tr.querySelector('.ib-price');
      if (priceInput && !priceInput.value) priceInput.value = m.opening_price || '';
    } else {
      tr.querySelector('.ib-brand').textContent = '';
      tr.setAttribute('data-code', '');
    }
    // 刷新可用库存显示
    const cell = tr.querySelector('.ib-available');
    const map = this._inboundStockMap || {};
    if (cell) {
      const available = map[code];
      if (!code || available === undefined) {
        cell.textContent = '-';
        cell.style.color = 'var(--text-muted)';
      } else {
        cell.textContent = available;
        cell.style.color = available < 0 ? 'var(--danger)' : (available === 0 ? 'var(--warning)' : 'var(--success)');
      }
    }
    const qtyInput = tr.querySelector('.ib-qty');
    if (qtyInput) {
      qtyInput.style.borderColor = '';
      this.checkInboundRowStock(qtyInput);
    }
  },

  async loadOrderLinesForInbound() {
    const poNo = document.getElementById('ib_po_no').value;
    const container = document.getElementById('ib_order_lines');
    if (!poNo) { container.style.display = 'none'; container.innerHTML = ''; return; }
    try {
      const lines = await this.api(`/api/order-lines/by-po/${encodeURIComponent(poNo)}`);
      // 选采购单号时自动关联合同号
      const orders = this._inboundOrders || [];
      const order = orders.find(o => o.po_no === poNo);
      if (order && order.contract_no) {
        const conSel = document.getElementById('ib_contract_no');
        if (conSel) conSel.value = order.contract_no;
      }
      if (lines.length === 0) { container.style.display = 'none'; return; }
      // 缓存行数据
      this._inboundOrderLines = lines;
      container.style.display = 'block';
      let rowsHtml = '';
      const vp = this.canViewPrice();
      lines.forEach((l, i) => {
        rowsHtml += `<tr><td>${l.code}</td><td>${l.material_name || ''} ${l.material_spec || ''}</td><td class="text-right">${l.order_qty}</td><td class="text-right">${l.received_qty}</td><td class="text-right">${l.unreceived_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(l.order_price)}</td>` : ''}<td><button class="btn btn-primary btn-sm" data-fill="${i}">${this.t('in_fill_qty')}</button></td></tr>`;
      });
      container.innerHTML = `<div class="card" style="padding:10px"><div style="font-weight:600;margin-bottom:6px">${this.t('in_order_lines')} — ${poNo}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('po_order_qty')}</th><th>${this.t('po_received_qty')}</th><th>${this.t('po_unreceived')}</th>${vp ? `<th>${this.t('po_order_price')}</th>` : ''}<th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div></div>`;
      // 绑定点击事件
      container.querySelectorAll('[data-fill]').forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.getAttribute('data-fill'));
          const l = this._inboundOrderLines[idx];
          if (l) this.addInboundRow(l.code, l.unreceived_qty, l.order_price, '', l.material_spec || '', l.material_brand || '');
        };
      });
    } catch(e) { container.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`; }
  },

  // #1: 按合同号带出未到货明细
  async loadOrderLinesForInboundByContract() {
    const contractNo = document.getElementById('ib_contract_no').value;
    const container = document.getElementById('ib_order_lines');
    if (!contractNo) { container.style.display = 'none'; container.innerHTML = ''; return; }
    try {
      const lines = await this.api(`/api/order-lines/by-contract/${encodeURIComponent(contractNo)}`);
      if (lines.length === 0) { container.style.display = 'none'; return; }
      this._inboundOrderLines = lines;
      container.style.display = 'block';
      let rowsHtml = '';
      const vp = this.canViewPrice();
      lines.forEach((l, i) => {
        rowsHtml += `<tr><td>${l.code}</td><td>${l.material_name || ''} ${l.material_spec || ''}</td><td>${l.po_no}</td><td class="text-right">${l.order_qty}</td><td class="text-right">${l.received_qty}</td><td class="text-right">${l.unreceived_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(l.order_price)}</td>` : ''}<td><button class="btn btn-primary btn-sm" data-fill="${i}">${this.t('in_fill_qty')}</button></td></tr>`;
      });
      container.innerHTML = `<div class="card" style="padding:10px"><div style="font-weight:600;margin-bottom:6px">${this.t('in_order_lines')} — ${this.t('in_contract')}: ${contractNo}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('in_po_no')}</th><th>${this.t('po_order_qty')}</th><th>${this.t('po_received_qty')}</th><th>${this.t('po_unreceived')}</th>${vp ? `<th>${this.t('po_order_price')}</th>` : ''}<th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div></div>`;
      // 绑定点击事件
      container.querySelectorAll('[data-fill]').forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.getAttribute('data-fill'));
          const l = this._inboundOrderLines[idx];
          if (l) {
            this.addInboundRow(l.code, l.unreceived_qty, l.order_price, '', l.material_spec || '', l.material_brand || '');
            // 点击填写时自动关联采购单号
            if (l.po_no) {
              const poSel = document.getElementById('ib_po_no');
              if (poSel) poSel.value = l.po_no;
            }
          }
        };
      });
    } catch(e) { container.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`; }
  },

  // 编辑单行入库（保留原有功能）
  async editInbound(id) {
    let r = { date: new Date().toISOString().slice(0, 10), grn_no: '', code: '', qty: '', price: '', supplier: '', handler: '', location: '', remarks: '', po_no: '', contract_no: '', txn_type: '采购入库' };
    if (id) { const data = await this.api('/api/inbound'); r = data.find(d => d.id === id) || r; }
    const materials = await this.api('/api/materials'), suppliers = await this.api('/api/suppliers'), orders = await this.api('/api/purchase-orders');
    const locs = this.params.locations.map(l => l.name);
    const matSel = materials.map(m => `<option value="${m.code}" ${m.code === r.code ? 'selected' : ''}>${m.name} ${m.spec || ''} ${m.brand || ''} (${m.code})</option>`).join('');
    const supSel = suppliers.map(s => `<option value="${s.name}" ${s.name === r.supplier ? 'selected' : ''}>${s.name}</option>`).join('');
    const poSel = orders.map(o => `<option value="${o.po_no}" ${o.po_no === r.po_no ? 'selected' : ''}>${o.po_no}</option>`).join('');
    const locSel = locs.map(l => `<option value="${l}" ${l === r.location ? 'selected' : ''}>${l}</option>`).join('');
    // 界面始终显示正数（与 README 约定一致）
    const displayQty = r.qty === '' || r.qty == null ? '' : Math.abs(Number(r.qty));
    const displayPrice = r.price === '' || r.price == null ? '' : Math.abs(Number(r.price));
    this.showModal(`<h3>${id ? this.t('in_edit') : this.t('in_add')}</h3>`, `<div class="form-grid">
      <div class="form-group"><label>${this.t('in_date')} *</label><input id="i_date" type="date" value="${this.fmtDate(r.date)}" oninput="App.clearFieldError('i_date')"><div class="form-error" id="i_date_error"></div></div>
      <div class="form-group"><label>${this.t('in_txn_type')}</label><select id="i_txn_type"><option value="采购入库" ${r.txn_type === '采购入库' ? 'selected' : ''}>${this.t('in_purchase')}</option><option value="采购退货" ${r.txn_type === '采购退货' ? 'selected' : ''}>${this.t('in_return')}</option></select></div>
      <div class="form-group"><label>${this.t('in_grn')} (${this.t('in_grn_auto')})</label><input id="i_grn_no" value="${r.grn_no}" placeholder="${this.t('in_grn_ph')}"></div>
      <div class="form-group"><label>${this.t('in_material')} *</label><select id="i_code" onchange="App.clearFieldError('i_code')"><option value="">${this.t('please_select')}</option>${matSel}</select><div class="form-error" id="i_code_error"></div></div>
      <div class="form-group"><label>${this.t('in_qty')} *</label><input id="i_qty" type="number" step="0.01" value="${displayQty}" oninput="App.clearFieldError('i_qty')"><div class="form-error" id="i_qty_error"></div></div>
      <div class="form-group">${this.canViewPrice() ? `<label>${this.t('in_price')}</label><input id="i_price" type="number" step="0.01" value="${displayPrice}" oninput="App.clearFieldError('i_price')"><div class="form-error" id="i_price_error"></div>` : `<input id="i_price" type="hidden" value="0">`}</div>
      <div class="form-group"><label>${this.t('in_supplier')}</label><select id="i_supplier"><option value="">${this.t('none')}</option>${supSel}</select></div>
      <div class="form-group"><label>${this.t('in_handler')}</label><input id="i_handler" value="${r.handler || ''}"></div>
      <div class="form-group"><label>${this.t('in_location')}</label><select id="i_location"><option value="">${this.t('none')}</option>${locSel}</select></div>
      <div class="form-group"><label>${this.t('in_po_no')}</label><select id="i_po_no"><option value="">${this.t('none')}</option>${poSel}</select></div>
      <div class="form-group"><label>${this.t('in_contract')}</label><input id="i_contract_no" value="${r.contract_no || ''}"></div>
      <div class="form-group" style="grid-column:span 2"><label>${this.t('in_remarks')}</label><input id="i_remarks" value="${r.remarks || ''}"></div></div>`, id ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({
        i_date: [{ rule: 'required' }],
        i_code: [{ rule: 'required' }],
        i_qty: [{ rule: 'required' }, { rule: 'number' }, { rule: 'positive' }]
      })) return;
      const txnType = document.getElementById('i_txn_type').value;
      let qty = parseFloat(document.getElementById('i_qty').value) || 0;
      let price = parseFloat(document.getElementById('i_price').value) || 0;
      // 采购退货：qty 和 price 转负数
      if (txnType === '采购退货') { qty = -Math.abs(qty); price = -Math.abs(price); }
      const body = {
        date: document.getElementById('i_date').value,
        grn_no: document.getElementById('i_grn_no').value.trim(),
        code: document.getElementById('i_code').value,
        qty, price,
        supplier: document.getElementById('i_supplier').value,
        handler: document.getElementById('i_handler').value.trim(),
        location: document.getElementById('i_location').value,
        po_no: document.getElementById('i_po_no').value,
        contract_no: document.getElementById('i_contract_no').value.trim(),
        remarks: document.getElementById('i_remarks').value.trim(),
        txn_type: txnType
      };
      try {
        await this.api('/api/inbound' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body);
        this.closeModal();
        this.toast(id ? this.t('updated') : this.t('added'));
        this.renderInbound();
      } catch (e) {
        if (e.code === 'INSUFFICIENT_STOCK') {
          this.handleInboundStockError(e, { isEdit: !!id, id, body });
        } else {
          this.toast(e.message, 'error');
        }
      }
    });
  },

  async deleteInbound(id) { this.confirmDialog(this.t('cf_delete_inbound'), '', async () => { try { await this.api('/api/inbound/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderInbound(); } catch (e) { this.toast(e.message, 'error'); } }); },

});

undefined
