/**
 * 出库记录 —— 列表、批量出库表单
 */
Object.assign(App, {
  // ========== 出库记录 ==========
  async renderOutbound() {
    const dateFilter = { fromId: 'out_date_from', toId: 'out_date_to', onChange: 'App.onOutboundFilter()' };
    const addBtn = this.can('outbound','create') ? `<button class="btn btn-primary" onclick="App.editOutboundBatch()">+ ${this.t('out_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('out_filter', 'App.onOutboundFilter()', addBtn, dateFilter);
    this.setMain(this.pageWrap('📤 ' + this.t('out_title'), this.t('out_desc'), '', `<div id="outbound-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-summary" id="outbound-summary"></div><div class="data-scroll" id="outbound-scroll"></div><div class="data-pager" id="outbound-pager"></div></div>`));
    try {
      this._outboundData = await this.api('/api/outbound');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['outbound'] = () => this.renderOutboundTable();
      this.renderOutboundTable();
    } catch (e) { document.getElementById('outbound-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderOutboundTable() {
    const data = this._outboundData;
    if (!data) return;
    const cur = this.params.currency;
    const vp = this.canViewPrice();
    const tid = 'outbound';
    const st = this.getTableState(tid);
    // 读取筛选值
    const keywords = document.getElementById('out_filter')?.value || '';
    const dateFrom = document.getElementById('out_date_from')?.value || '';
    const dateTo = document.getElementById('out_date_to')?.value || '';
    // 关键字 + 日期段筛选
    const filterFields = ['date','gin_no','code','material_name','material_spec','material_brand','material_unit','qty','destination','receiver','handler','location','cost_price','cost_amount','txn_type','remarks'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    filtered = this.filterByDateRange(filtered, 'date', dateFrom, dateTo);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    let totalQty = 0, totalAmount = 0; sorted.forEach(r => { totalQty += r.qty; totalAmount += r.cost_amount; });
    const headers = [
      ['date', this.t('out_date')], ['gin_no', this.t('out_gin')], ['txn_type', this.t('out_txn_type')],
      ['code', this.t('mat_code')], ['material_name', this.t('mat_name')], ['material_spec', this.t('mat_spec')], ['material_brand', this.t('mat_brand')],
      ['material_unit', this.t('mat_unit')], ['qty', this.t('out_qty')], ['destination', this.t('out_destination')],
      ['receiver', this.t('out_receiver')], ['handler', this.t('out_handler')], ['location', this.t('out_location')],
      ...vp ? [['cost_price', this.t('out_cost_price')], ['cost_amount', this.t('out_cost_amount')]] : []
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('out_remarks')}</th><th></th>`;
    const colCount = headers.length + 2;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(colCount); }
    else { tbody = pageData.map(r => { const txnBadge = r.txn_type === '退库出库' ? `<span class="badge badge-danger">${this.t('out_return')}</span>` : `<span class="badge badge-info">${this.t('out_normal')}</span>`; return `<tr><td>${this.fmtDate(r.date)}</td><td>${r.gin_no}</td><td>${txnBadge}</td><td>${r.code}</td><td>${r.material_name || ''}</td><td>${r.material_spec || ''}</td><td>${r.material_brand || ''}</td><td>${r.material_unit || ''}</td><td class="text-right">${r.qty}</td><td>${r.destination || ''}</td><td>${r.receiver || ''}</td><td>${r.handler || ''}</td><td>${r.location || ''}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.cost_price)}</td><td class="text-right">${this.fmtMoney(r.cost_amount)}</td>` : ''}<td>${r.remarks || ''}</td><td>${this.rowActions('outbound', `App.editOutbound(${r.id})`, `App.deleteOutbound(${r.id})`)}</td></tr>`; }).join(''); }
    const filterActive = (keywords.trim() || dateFrom || dateTo) ? ` | 🔍 ${sorted.length}/${data.length}` : '';
    document.getElementById('outbound-summary').innerHTML = `${sorted.length} ${this.t('out_total_records')} | ${this.t('out_total_qty')}: ${totalQty}${vp ? ` | ${this.t('out_total_amount')}: ${cur} ${this.fmtMoney(totalAmount)}` : ''}${filterActive}`;
    document.getElementById('outbound-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('outbound-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onOutboundFilter() {
    const st = this.getTableState('outbound');
    st.page = 1;
    this.renderOutboundTable();
  },

  // 批量新增出库
  async editOutboundBatch() {
    const materials = await this.api('/api/materials');
    // 加载库存汇总，用于显示可用库存并做前端预校验（后端仍会强校验）
    let stockMap = {};
    try {
      const stock = await this.api('/api/stock-summary');
      stockMap = Object.fromEntries(stock.map(s => [s.code, s.on_hand]));
    } catch (e) { /* 库存加载失败不阻断出库，后端会兜底校验 */ }
    this._outboundStockMap = stockMap;
    const dests = this.params.destinations.map(d => d.name);
    const locs = this.params.locations.map(l => l.name);
    const today = new Date().toISOString().slice(0, 10);

    const destOptions = dests.map(d => `<option value="${d}">${d}</option>`).join('');
    const locOptions = locs.map(l => `<option value="${l}">${l}</option>`).join('');

    // #4: 物料三级联动数据准备
    this._materialsCache = materials;
    this._outboundMatCategories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    const vp = this.canViewPrice();

    this.showModal(`<h3>${this.t('out_batch_title')}</h3>`, `<div style="margin-bottom:12px;font-size:12px;color:var(--text-muted)">${this.t('out_batch_desc')}</div>
      <div class="form-grid">
        <div class="form-group"><label>${this.t('out_date')} *</label><input id="ob_date" type="date" value="${today}"></div>
        <div class="form-group"><label>${this.t('out_txn_type')} *</label><select id="ob_txn_type" onchange="App.refreshOutboundStockHints()"><option value="正常出库">${this.t('out_normal')}</option><option value="退库出库">${this.t('out_return')}</option></select></div>
        <div class="form-group"><label>${this.t('out_destination')}</label><select id="ob_destination"><option value="">${this.t('none')}</option>${destOptions}</select></div>
        <div class="form-group"><label>${this.t('out_receiver')}</label><input id="ob_receiver" value=""></div>
        <div class="form-group"><label>${this.t('out_handler')}</label><input id="ob_handler" value=""></div>
        <div class="form-group"><label>${this.t('out_location')}</label><select id="ob_location"><option value="">${this.t('none')}</option>${locOptions}</select></div>
      </div>
      <div class="card" style="margin-top:12px;padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>${this.t('out_title')}</strong>
          <button class="btn btn-outline btn-sm" onclick="App.addOutboundRow()">+ ${this.t('out_add_row')}</button>
        </div>
        <div class="table-wrap"><table id="ob_table"><thead><tr>
          <th>${this.t('mat_level_category')}</th><th>${this.t('mat_level_name')}</th><th>${this.t('mat_level_spec')}</th><th>${this.t('mat_level_brand')}</th><th>${this.t('out_qty')} *</th><th>${this.t('out_available')}</th>${vp ? `<th>${this.t('out_cost_price')}</th>` : ''}<th>${this.t('out_remarks')}</th><th></th>
        </tr></thead><tbody id="ob_rows"></tbody></table></div>
      </div>
      <div style="margin-top:8px;padding:8px 12px;background:var(--primary-light);border-radius:6px;font-size:12px;color:var(--text-muted)">💡 ${this.t('out_cost_hint')}</div>`, this.t('out_batch_submit'), async () => {
      const date = document.getElementById('ob_date').value;
      const txnType = document.getElementById('ob_txn_type').value;
      const destination = document.getElementById('ob_destination').value;
      const receiver = document.getElementById('ob_receiver').value.trim();
      const handler = document.getElementById('ob_handler').value.trim();
      const location = document.getElementById('ob_location').value;
      if (!date) { this.toast(this.t('field_required'), 'error'); return; }
      const rows = document.querySelectorAll('#ob_rows tr');
      const items = [];
      rows.forEach(tr => {
        const code = tr.getAttribute('data-code') || '';
        const qty = parseFloat(tr.querySelector('.ob-qty').value) || 0;
        const remarks = tr.querySelector('.ob-remarks').value.trim();
        if (code && qty > 0) {
          const actualQty = txnType === '退库出库' ? -qty : qty;
          items.push({ date, code, qty: actualQty, destination, receiver, handler, location, remarks, txn_type: txnType });
        }
      });
      if (items.length === 0) { this.toast(this.t('fillRequired'), 'error'); return; }
      try {
        await this.api('/api/outbound', 'POST', { items });
        this.closeModal();
        this.toast(this.t('added') + ' (' + items.length + ')');
        this.renderOutbound();
      } catch (e) {
        if (e.code === 'INSUFFICIENT_STOCK') {
          this.handleOutboundStockError(e, { items });
        } else {
          this.toast(e.message, 'error');
        }
      }
    }, null, true); // large modal

    this.addOutboundRow();
    this.addOutboundRow();
    this.addOutboundRow();
  },

  // 库存不足时的处理：管理员/主管可选择强制放行，其余角色仅提示
  // payload 两种形态：
  //   1) 批量：{ items: [...] }
  //   2) 单条编辑：{ isEdit: true, id, body }
  handleOutboundStockError(err, payload) {
    const details = (err.details || []).map(d => `${d.code}：需 ${d.requested}，可用 ${d.available}`).join('\n');
    const canForce = ['admin', 'manager'].includes(this.user?.role);
    if (!canForce) {
      this.toast(`${this.t('out_stock_short')}：${details}`, 'error');
      return;
    }
    const self = this;
    this.confirmDialog(
      this.t('out_stock_short'),
      `${details}\n\n${this.t('out_force_allow')}`,
      async () => {
        try {
          if (payload.isEdit) {
            // 单条编辑强制放行
            await self.api('/api/outbound/' + payload.id, 'PUT', { ...payload.body, force_allow: true });
            self.closeModal();
            self.toast(self.t('updated'));
          } else {
            // 批量新增强制放行
            await self.api('/api/outbound', 'POST', { items: payload.items, force_allow: true });
            self.closeModal();
            self.toast(self.t('added'));
          }
          self.renderOutbound();
        } catch (e2) { self.toast(e2.message, 'error'); }
      }
    );
  },

  // #4: 批量出库行 — 三级联动物料选择（类别→名称→规格品牌）
  addOutboundRow(code = '', qty = '', remarks = '', spec = '', brand = '') {
    const cats = this._outboundMatCategories || [];
    const materials = this._materialsCache || [];
    const tbody = document.getElementById('ob_rows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.setAttribute('data-code', code);
    const mat = code ? materials.find(m => m.code === code) : null;
    const preCat = mat ? mat.category : '';
    const preName = mat ? mat.name : '';

    const catOpts = cats.map(c => `<option value="${c}" ${c === preCat ? 'selected' : ''}>${c}</option>`).join('');
    const names = preCat ? [...new Set(materials.filter(m => m.category === preCat).map(m => m.name))] : [];
    const nameOpts = names.map(n => `<option value="${n}" ${n === preName ? 'selected' : ''}>${n}</option>`).join('');
    const specs = (preCat && preName) ? materials.filter(m => m.category === preCat && m.name === preName) : [];
    const specOpts = specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}" ${m.code === code ? 'selected' : ''}>${label}</option>`;
    }).join('');

    const vp = this.canViewPrice();
    const available = code ? (this._outboundStockMap || {})[code] : null;
    const availText = available === undefined || available === null ? '-' : available;
    const availColor = available === undefined || available === null ? 'var(--text-muted)'
      : (available < 0 ? 'var(--danger)' : (available === 0 ? 'var(--warning)' : 'var(--success)'));
    tr.innerHTML = `<td><select class="ob-cat" onchange="App.onOutboundRowCatChange(this)" style="width:120px"><option value="">${this.t('please_select')}</option>${catOpts}</select></td>
      <td><select class="ob-name" onchange="App.onOutboundRowNameChange(this)" style="width:140px" ${!preCat ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${nameOpts}</select></td>
      <td><select class="ob-spec-sel" onchange="App.onOutboundRowSpecChange(this)" style="width:200px" ${!preName ? 'disabled' : ''}><option value="">${this.t('please_select')}</option>${specOpts}</select></td>
      <td class="ob-brand" style="font-size:12px;color:var(--text-muted)">${brand}</td>
      <td><input class="ob-qty" type="number" step="0.01" value="${qty}" style="width:80px" oninput="App.checkOutboundRowStock(this)"></td>
      <td class="ob-available" style="font-size:12px;color:${availColor}">${availText}</td>
      ${vp ? `<td class="ob-cost" style="font-size:12px;color:var(--text-muted)">-</td>` : ''}
      <td><input class="ob-remarks" value="${remarks}" style="width:120px"></td>
      <td><span class="action-link danger" onclick="this.parentElement.parentElement.remove()">${this.t('out_remove_row')}</span></td>`;
    tbody.appendChild(tr);
  },

  // 实时校验单行出库量是否超出可用库存（仅前端提示，后端为最终拦截）
  // 退库出库是增加库存，不校验不足
  checkOutboundRowStock(qtyInput) {
    const tr = qtyInput.closest('tr');
    if (!tr) return;
    const code = tr.getAttribute('data-code') || '';
    const cell = tr.querySelector('.ob-available');
    if (!cell) return;
    const map = this._outboundStockMap || {};
    if (!code || map[code] === undefined) { cell.textContent = '-'; cell.style.color = 'var(--text-muted)'; qtyInput.style.borderColor = ''; return; }
    const available = map[code];
    const qty = parseFloat(qtyInput.value) || 0;
    cell.textContent = available;

    // 当前批次交易类型：退库出库不占用库存
    const txnType = document.getElementById('ob_txn_type')?.value || '正常出库';
    const isReturn = txnType === '退库出库';

    if (available < 0) {
      // 历史负库存：后端已豁免拦截，此处仅提示现状，不标红输入框
      cell.style.color = 'var(--danger)';
      qtyInput.style.borderColor = '';
      return;
    }
    if (!isReturn && qty > available) {
      cell.style.color = 'var(--danger)';
      qtyInput.style.borderColor = 'var(--danger)';
    } else {
      cell.style.color = available === 0 ? 'var(--warning)' : 'var(--success)';
      qtyInput.style.borderColor = '';
    }
  },

  // 批量表单切换交易类型时重刷所有行的库存提示
  refreshOutboundStockHints() {
    document.querySelectorAll('#ob_rows .ob-qty').forEach(inp => this.checkOutboundRowStock(inp));
  },

  onOutboundRowCatChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = selEl.value;
    const materials = this._materialsCache || [];
    const names = cat ? [...new Set(materials.filter(m => m.category === cat).map(m => m.name))] : [];
    const nameSel = tr.querySelector('.ob-name');
    nameSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + names.map(n => `<option value="${n}">${n}</option>`).join('');
    nameSel.disabled = !cat;
    const specSel = tr.querySelector('.ob-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>`;
    specSel.disabled = true;
    tr.querySelector('.ob-brand').textContent = '';
    tr.setAttribute('data-code', '');
  },

  onOutboundRowNameChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const cat = tr.querySelector('.ob-cat').value;
    const name = selEl.value;
    const materials = this._materialsCache || [];
    const specs = (cat && name) ? materials.filter(m => m.category === cat && m.name === name) : [];
    const specSel = tr.querySelector('.ob-spec-sel');
    specSel.innerHTML = `<option value="">${this.t('please_select')}</option>` + specs.map(m => {
      const label = `${m.spec || '-'} / ${m.brand || '-'} (${m.code})`;
      return `<option value="${m.code}">${label}</option>`;
    }).join('');
    specSel.disabled = !name;
    tr.querySelector('.ob-brand').textContent = '';
    tr.setAttribute('data-code', '');
  },

  onOutboundRowSpecChange(selEl) {
    const tr = selEl.parentElement.parentElement;
    const code = selEl.value;
    const m = (this._materialsCache || []).find(x => x.code === code);
    if (m) {
      tr.querySelector('.ob-brand').textContent = m.brand || '';
      tr.setAttribute('data-code', code);
    } else {
      tr.querySelector('.ob-brand').textContent = '';
      tr.setAttribute('data-code', '');
    }
    // 选料后刷新可用库存显示
    const cell = tr.querySelector('.ob-available');
    const map = this._outboundStockMap || {};
    if (cell) {
      const available = map[code];
      if (!code || available === undefined) { cell.textContent = '-'; cell.style.color = 'var(--text-muted)'; }
      else {
        cell.textContent = available;
        cell.style.color = available < 0 ? 'var(--danger)' : (available === 0 ? 'var(--warning)' : 'var(--success)');
      }
    }
    const qtyInput = tr.querySelector('.ob-qty');
    if (qtyInput) { qtyInput.style.borderColor = ''; this.checkOutboundRowStock(qtyInput); }
  },

  // 编辑单行出库
  async editOutbound(id) {
    let r = { date: new Date().toISOString().slice(0, 10), gin_no: '', code: '', qty: '', destination: '', receiver: '', handler: '', location: '', remarks: '', txn_type: '正常出库' };
    if (id) { const data = await this.api('/api/outbound'); r = data.find(d => d.id === id) || r; }
    const materials = await this.api('/api/materials'), dests = this.params.destinations.map(d => d.name), locs = this.params.locations.map(l => l.name);
    const matSel = materials.map(m => `<option value="${m.code}" ${m.code === r.code ? 'selected' : ''}>${m.name} ${m.spec || ''} ${m.brand || ''} (${m.code})</option>`).join('');
    const destSel = dests.map(d => `<option value="${d}" ${d === r.destination ? 'selected' : ''}>${d}</option>`).join('');
    const locSel = locs.map(l => `<option value="${l}" ${l === r.location ? 'selected' : ''}>${l}</option>`).join('');
    // 界面始终显示正数（与 README 约定一致），提交时再按类型决定符号
    const displayQty = r.qty === '' || r.qty == null ? '' : Math.abs(Number(r.qty));
    this.showModal(`<h3>${id ? this.t('out_edit') : this.t('out_add')}</h3>`, `<div class="form-grid">
      <div class="form-group"><label>${this.t('out_date')} *</label><input id="o_date" type="date" value="${this.fmtDate(r.date)}" oninput="App.clearFieldError('o_date')"><div class="form-error" id="o_date_error"></div></div>
      <div class="form-group"><label>${this.t('out_txn_type')}</label><select id="o_txn_type"><option value="正常出库" ${r.txn_type === '正常出库' ? 'selected' : ''}>${this.t('out_normal')}</option><option value="退库出库" ${r.txn_type === '退库出库' ? 'selected' : ''}>${this.t('out_return')}</option></select></div>
      <div class="form-group"><label>${this.t('out_gin')} (${this.t('out_gin_auto')})</label><input id="o_gin_no" value="${r.gin_no}" placeholder="${this.t('in_grn_ph')}"></div>
      <div class="form-group"><label>${this.t('out_material')} *</label><select id="o_code" onchange="App.clearFieldError('o_code')"><option value="">${this.t('please_select')}</option>${matSel}</select><div class="form-error" id="o_code_error"></div></div>
      <div class="form-group"><label>${this.t('out_qty')} *</label><input id="o_qty" type="number" step="0.01" value="${displayQty}" oninput="App.clearFieldError('o_qty')"><div class="form-error" id="o_qty_error"></div></div>
      <div class="form-group"><label>${this.t('out_destination')}</label><select id="o_destination"><option value="">${this.t('none')}</option>${destSel}</select></div>
      <div class="form-group"><label>${this.t('out_receiver')}</label><input id="o_receiver" value="${r.receiver || ''}"></div>
      <div class="form-group"><label>${this.t('out_handler')}</label><input id="o_handler" value="${r.handler || ''}"></div>
      <div class="form-group"><label>${this.t('out_location')}</label><select id="o_location"><option value="">${this.t('none')}</option>${locSel}</select></div>
      <div class="form-group" style="grid-column:span 2"><label>${this.t('out_remarks')}</label><input id="o_remarks" value="${r.remarks || ''}"></div></div>
      <div style="margin-top:8px;padding:8px 12px;background:var(--primary-light);border-radius:6px;font-size:12px;color:var(--text-muted)">💡 ${this.t('out_cost_hint')}</div>`, id ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ o_date: [{rule:'required'}], o_code: [{rule:'required'}], o_qty: [{rule:'required'},{rule:'number'},{rule:'positive'}] })) return;
      const txnType = document.getElementById('o_txn_type').value;
      let qty = parseFloat(document.getElementById('o_qty').value) || 0;
      // 退库出库：qty 转负数
      if (txnType === '退库出库') qty = -Math.abs(qty);
      const body = {
        date: document.getElementById('o_date').value,
        gin_no: document.getElementById('o_gin_no').value.trim(),
        code: document.getElementById('o_code').value,
        qty,
        destination: document.getElementById('o_destination').value,
        receiver: document.getElementById('o_receiver').value.trim(),
        handler: document.getElementById('o_handler').value.trim(),
        location: document.getElementById('o_location').value,
        remarks: document.getElementById('o_remarks').value.trim(),
        txn_type: txnType
      };
      try {
        await this.api('/api/outbound' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body);
        this.closeModal();
        this.toast(id ? this.t('updated') : this.t('added'));
        this.renderOutbound();
      } catch (e) {
        if (e.code === 'INSUFFICIENT_STOCK') {
          // 单条编辑也支持强制放行
          this.handleOutboundStockError(e, {
            isEdit: true,
            id,
            body
          });
        } else {
          this.toast(e.message, 'error');
        }
      }
    });
  },

  async deleteOutbound(id) { this.confirmDialog(this.t('cf_delete_outbound'), '', async () => { try { await this.api('/api/outbound/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderOutbound(); } catch (e) { this.toast(e.message, 'error'); } }); },

});

undefined
