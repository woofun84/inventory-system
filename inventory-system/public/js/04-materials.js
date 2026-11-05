/**
 * 物料档案 —— 列表、新增/编辑、类别联动
 */
Object.assign(App, {
  // ========== 物料档案 ==========
  async renderMaterials() {
    const addBtn = this.can('materials','create') ? `<button class="btn btn-primary" onclick="App.editMaterial()">+ ${this.t('mat_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('mat_filter', 'App.onMaterialsFilter()', addBtn);
    this.setMain(this.pageWrap('🏷 ' + this.t('mat_title'), this.t('mat_desc'), '', `<div id="materials-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="materials-scroll"></div><div class="data-pager" id="materials-pager"></div></div>`));
    try {
      this._materialsData = await this.api('/api/materials');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['materials'] = () => this.renderMaterialsTable();
      this.renderMaterialsTable();
    } catch (e) { document.getElementById('materials-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderMaterialsTable() {
    const data = this._materialsData;
    if (!data) return;
    const tid = 'materials';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('mat_filter')?.value || '';
    const vp = this.canViewPrice();
    const filterFields = ['code','name','spec','category','unit','opening_qty','opening_price','min_stock','default_location','brand','status'];
    const filtered = this.filterByKeywords(data, keywords, filterFields);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
      ['category', this.t('mat_category')], ['unit', this.t('mat_unit')], ['opening_qty', this.t('mat_opening_qty')],
      ...vp ? [['opening_price', this.t('mat_opening_price')]] : [],
      ['min_stock', this.t('mat_min_stock')],
      ['default_location', this.t('mat_location')], ['brand', this.t('mat_brand')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('mat_status')}</th><th></th>`;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(vp ? 12 : 11); }
    else { tbody = pageData.map(m => `<tr><td><strong>${m.code}</strong></td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.category}</td><td>${m.unit}</td><td class="text-right">${m.opening_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(m.opening_price)}</td>` : ''}<td class="text-right">${m.min_stock}</td><td>${m.default_location || ''}</td><td>${m.brand || ''}</td><td>${m.status === '停用' ? this.statusBadge('停用') : `<span class="badge badge-success">${this.t('mat_in_use')}</span>`}</td><td>${this.rowActions('materials', `App.editMaterial('${m.code}')`, `App.deleteMaterial('${m.code}')`)}</td></tr>`).join(''); }
    document.getElementById('materials-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('materials-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  async editMaterial(code) {
    let m = { code: '', name: '', spec: '', category: '', unit: '', opening_qty: 0, opening_price: 0, min_stock: 0, default_location: '', brand: '', status: '' };
    if (code) { const data = await this.api('/api/materials'); m = data.find(d => d.code === code) || m; }
    const cats = this.params.categories.map(c => c.name), units = this.params.units.map(u => u.name), locs = this.params.locations.map(l => l.name);
    const sel = (arr, val) => arr.map(a => `<option value="${a}" ${a === val ? 'selected' : ''}>${a}</option>`).join('');
    this.showModal(`<h3>${code ? this.t('mat_edit') : this.t('mat_add')}</h3>`, `<div class="form-grid">
      <div class="form-group"><label>${this.t('mat_code')} ${code ? '' : '(' + this.t('mat_code_auto') + ')'}</label><input id="m_code" value="${m.code}" ${code ? 'readonly' : 'readonly placeholder="' + this.t('mat_code_hint') + '"'}><div class="form-error" id="m_code_error"></div></div>
      <div class="form-group"><label>${this.t('mat_name')} *</label><input id="m_name" value="${m.name}" oninput="App.clearFieldError('m_name')"><div class="form-error" id="m_name_error"></div></div>
      <div class="form-group"><label>${this.t('mat_spec')}</label><input id="m_spec" value="${m.spec || ''}"></div>
      <div class="form-group"><label>${this.t('mat_category')} *</label><select id="m_category" onchange="App.onMaterialCategoryChange()"><option value="">${this.t('please_select')}</option>${sel(cats, m.category)}</select><div class="form-error" id="m_category_error"></div></div>
      <div class="form-group"><label>${this.t('mat_unit')} *</label><select id="m_unit" onchange="App.clearFieldError('m_unit')"><option value="">${this.t('please_select')}</option>${sel(units, m.unit)}</select><div class="form-error" id="m_unit_error"></div></div>
      <div class="form-group"><label>${this.t('mat_opening_qty')}</label><input id="m_opening_qty" type="number" step="0.01" value="${m.opening_qty}"></div>
      ${this.canViewPrice() ? `<div class="form-group"><label>${this.t('mat_opening_price')}</label><input id="m_opening_price" type="number" step="0.01" value="${m.opening_price}"></div>` : '<input id="m_opening_price" type="hidden" value="0">'}
      <div class="form-group"><label>${this.t('mat_min_stock')}</label><input id="m_min_stock" type="number" step="0.01" value="${m.min_stock}"></div>
      <div class="form-group"><label>${this.t('mat_location')}</label><select id="m_default_location"><option value="">${this.t('none')}</option>${sel(locs, m.default_location)}</select></div>
      <div class="form-group"><label>${this.t('mat_brand')}</label><input id="m_brand" value="${m.brand || ''}"></div>
      <div class="form-group"><label>${this.t('mat_status')}</label><select id="m_status"><option value="">${this.t('mat_in_use')}</option><option value="停用" ${m.status === '停用' ? 'selected' : ''}>${this.t('mat_stopped')}</option></select></div>
      </div>`, code ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ m_name: [{rule:'required'}], m_category: [{rule:'required'}], m_unit: [{rule:'required'}] })) return;
      const body = { code: document.getElementById('m_code').value.trim() || 'auto', name: document.getElementById('m_name').value.trim(), spec: document.getElementById('m_spec').value.trim(), category: document.getElementById('m_category').value, unit: document.getElementById('m_unit').value, opening_qty: parseFloat(document.getElementById('m_opening_qty').value) || 0, opening_price: parseFloat(document.getElementById('m_opening_price').value) || 0, min_stock: parseFloat(document.getElementById('m_min_stock').value) || 0, default_location: document.getElementById('m_default_location').value, brand: document.getElementById('m_brand').value.trim(), status: document.getElementById('m_status').value };
      try { await this.api('/api/materials' + (code ? '/' + code : ''), code ? 'PUT' : 'POST', body); this.closeModal(); this.toast(code ? this.t('updated') : this.t('added')); this.renderMaterials(); } catch (e) { this.toast(e.message, 'error'); }
    });
    // 新增模式下，初始如果有类别就触发
    if (!code && m.category) this.onMaterialCategoryChange();
  },

  async onMaterialCategoryChange() {
    const cat = document.getElementById('m_category')?.value;
    const codeEl = document.getElementById('m_code');
    if (!codeEl || codeEl.readOnly === false) return;
    if (cat) {
      try {
        const res = await this.api(`/api/materials/next-code?category=${encodeURIComponent(cat)}`);
        codeEl.value = res.code;
      } catch(e) { codeEl.value = ''; }
    } else {
      codeEl.value = '';
    }
  },

  async deleteMaterial(code) { this.confirmDialog(this.t('cf_delete_material') + ' ' + code, this.t('cf_delete_material_msg'), async () => { try { await this.api('/api/materials/' + code, 'DELETE'); this.toast(this.t('deleted')); this.renderMaterials(); } catch (e) { this.toast(e.message, 'error'); } }); },

  onMaterialsFilter() {
    const st = this.getTableState('materials');
    st.page = 1;
    this.renderMaterialsTable();
  },

});

undefined
