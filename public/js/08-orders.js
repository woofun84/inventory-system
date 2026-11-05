/**
 * 基础资料 —— 供应商档案、参数设置
 * 说明：原「采购订单 / 订单明细」已整合为「采购管理」模块（见 10-purchase.js），
 *       本文件仅保留供应商档案与参数设置两块基础资料功能。
 */
Object.assign(App, {
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
        { key: 'destinations', title: this.t('set_destinations'), fields: ['name'], headers: [this.t('set_dest_name')] }
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
      // 单据编号规则（前缀 + 序号位数，带实时预览）
      if (data.docNoRules) { html += this.renderDocNoRules(data.docNoRules); }
      document.getElementById('settings-content').innerHTML = html;
      if (data.docNoRules) this.previewDocNo();
    } catch (e) { document.getElementById('settings-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  // 单据编号规则区块
  renderDocNoRules(rules) {
    const canEdit = this.can('settings', 'edit');
    const labels = {
      grn: this.t('in_purchase'), ret: this.t('in_return'),
      gin: this.t('out_normal'), git: this.t('out_return'),
      rv: this.t('set_docno_rv'), st: this.t('st_title'),
      po: this.t('pu_tab_orders')
    };
    const dis = canEdit ? '' : 'disabled';
    const inputs = this.docNoTypeKeys().map(k => {
      const v = (rules.prefixes && rules.prefixes[k]) || '';
      return `<div class="form-group" style="min-width:150px"><label>${labels[k] || k}</label>` +
        `<input id="docno_${k}" value="${v}" maxlength="8" ${dis} oninput="App.previewDocNo()"></div>`;
    }).join('');
    const actions = canEdit
      ? `<button class="btn btn-primary btn-sm" onclick="App.saveDocNoRules()">${this.t('set_docno_save')}</button>`
      : '';
    const today = this.today();
    return `<div class="card">
      <div class="card-title">${this.t('set_docno_title')}</div>
      <p style="color:var(--text-muted);margin-bottom:10px">${this.t('set_docno_desc')}</p>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">${inputs}
        <div class="form-group" style="min-width:110px"><label>${this.t('set_docno_pad')}</label>
          <input id="docno_pad" type="number" min="1" max="8" value="${rules.pad}" ${dis} oninput="App.previewDocNo()"></div>
      </div>
      <p style="color:var(--text-muted);margin:10px 0 6px">${this.t('set_docno_hint')}</p>
      <div style="color:var(--text-muted);margin-bottom:6px">${this.t('set_docno_preview')}</div>
      <div id="docno_preview" data-date="${today}" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      <div style="margin-top:12px">${actions}</div>
    </div>`;
  },

  docNoTypeKeys() { return ['grn', 'ret', 'gin', 'git', 'rv', 'st', 'po']; },

  // 实时预览（纯前端拼接，不查库）
  previewDocNo() {
    const box = document.getElementById('docno_preview');
    if (!box) return;
    const date = String(box.dataset.date || '').replace(/-/g, '');
    const padEl = document.getElementById('docno_pad');
    let pad = parseInt(padEl && padEl.value, 10);
    if (!pad || pad < 1) pad = 1; if (pad > 8) pad = 8;
    box.innerHTML = this.docNoTypeKeys().map(k => {
      const el = document.getElementById('docno_' + k);
      const prefix = String((el && el.value) || '').trim().toUpperCase() || '?';
      return `<span style="padding:3px 8px;border-radius:4px;background:var(--bg-muted,#f2f4f7);font-family:monospace">${prefix}-${date}-${'1'.padStart(pad, '0')}</span>`;
    }).join('');
  },

  async saveDocNoRules() {
    const prefixes = {};
    this.docNoTypeKeys().forEach(k => {
      const el = document.getElementById('docno_' + k);
      prefixes[k] = String((el && el.value) || '').trim().toUpperCase();
    });
    const pad = parseInt(document.getElementById('docno_pad')?.value, 10);
    try {
      await this.api('/api/params/doc-no-rules', 'PUT', { prefixes, pad });
      this.toast(this.t('set_docno_saved'));
      this.renderSettings();
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async addParam(type) {
    const fields = type === 'categories' ? ['name', 'prefix'] : ['name']; const body = {};
    fields.forEach(f => body[f] = document.getElementById(`add_${type}_${f}`).value.trim());
    if (!body.name) { this.toast(this.t('fillRequired'), 'error'); const el = document.getElementById(`add_${type}_name`); if (el) { el.classList.add('error'); el.focus(); } return; }
    try { await this.api(`/api/params/${type}`, 'POST', body); this.toast(this.t('added')); this.renderSettings(); } catch (e) { this.toast(e.message, 'error'); }
  },

  async deleteParam(type, id) { this.confirmDialog(this.t('cf_delete_param'), '', async () => { try { await this.api(`/api/params/${type}/${id}`, 'DELETE'); this.toast(this.t('deleted')); this.renderSettings(); } catch (e) { this.toast(e.message, 'error'); } }); },

});
