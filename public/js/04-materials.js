/**
 * 物料档案 —— 列表、新增/编辑、类别联动
 */
Object.assign(App, {
  // ========== 物料档案 ==========
  async renderMaterials() {
    const addBtn = this.can('materials','create')
      ? `<button class="btn btn-primary" onclick="App.editMaterial()">+ ${this.t('mat_add')}</button>
         <button class="btn btn-outline" onclick="App.batchAddMaterials()">${this.t('mat_batch_add')}</button>
         <button class="btn btn-outline" onclick="App.openMaterialImport()">${this.t('mat_batch_import')}</button>`
      : '';
    const f = this._matFilters || (this._matFilters = { keyword: '', category: '', status: '', stock: '' });
    const catOpts = this.params.categories.map(c => `<option value="${this.matEsc(c.name)}"${c.name === f.category ? ' selected' : ''}>${this.matEsc(c.name)}</option>`).join('');
    // 筛选栏与查询中心同一套结构与口径（类别 / 状态 / 库存状态）
    const toolbar = `<div class="pu-toolbar">
      <div class="pu-filter-inner">
        <div class="pu-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><input id="mat_filter" value="${this.matEsc(f.keyword)}" placeholder="${this.t('quick_filter_ph')}" oninput="App.onMaterialsFilter()"></div>
        <div class="pu-daterange"><label>${this.t('mat_category')}</label><select id="mat_category_filter" onchange="App.onMaterialsFilter()"><option value="">${this.t('stock_all')}</option>${catOpts}</select></div>
        <div class="pu-daterange"><label>${this.t('mat_status')}</label><select id="mat_status_filter" onchange="App.onMaterialsFilter()"><option value="">${this.t('stock_all')}</option><option value="active"${f.status === 'active' ? ' selected' : ''}>${this.t('mat_in_use')}</option><option value="停用"${f.status === '停用' ? ' selected' : ''}>${this.t('mat_stopped')}</option></select></div>
        <div class="pu-daterange"><label>${this.t('stock_status')}</label><select id="mat_stock_filter" onchange="App.onMaterialsFilter()"><option value="">${this.t('stock_all')}</option><option value="正常"${f.stock === '正常' ? ' selected' : ''}>${this.t('st_normal')}</option><option value="补货"${f.stock === '补货' ? ' selected' : ''}>${this.t('st_restock')}</option><option value="缺货"${f.stock === '缺货' ? ' selected' : ''}>${this.t('st_out')}</option></select></div>
      </div>
      <div class="pu-head-actions">${addBtn}</div>
    </div>`;
    this.setMain(this.pageWrap('🏷 ' + this.t('mat_title'), this.t('mat_desc'), '', `<div id="materials-content" class="data-page">${toolbar}<div class="data-scroll" id="materials-scroll"></div><div class="data-pager" id="materials-pager"></div></div>`));
    try {
      this._materialsData = await this.api('/api/materials');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['materials'] = () => this.renderMaterialsTable();
      this.renderMaterialsTable();
    } catch (e) { document.getElementById('materials-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  // 库存状态口径与查询中心/库存汇总一致：停用优先，0 库存且无安全库存不预警
  matStockStatus(m) {
    if (m.status === '停用') return '停用';
    const onHand = Number(m.on_hand) || 0;
    if (onHand <= 0) return Number(m.min_stock) > 0 ? '缺货' : '正常';
    if (onHand <= Number(m.min_stock)) return '补货';
    return '正常';
  },

  renderMaterialsTable() {
    const data = this._materialsData;
    if (!data) return;
    const tid = 'materials';
    const st = this.getTableState(tid);
    const keywords = document.getElementById('mat_filter')?.value || '';
    const category = document.getElementById('mat_category_filter')?.value || '';
    const status = document.getElementById('mat_status_filter')?.value || '';
    const stock = document.getElementById('mat_stock_filter')?.value || '';
    // 价格列：以接口是否下发 opening_price 为准（空列表时退回角色判断，避免表头闪变）
    const vp = data.length > 0 ? this.hasField(data[0], 'opening_price') : this.canViewPrice();
    const filterFields = ['code','name','spec','category','unit','opening_qty',...vp ? ['opening_price'] : [],'min_stock','brand','status'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    if (category) filtered = filtered.filter(m => m.category === category);
    if (status === '停用') filtered = filtered.filter(m => m.status === '停用');
    else if (status === 'active') filtered = filtered.filter(m => m.status !== '停用');
    if (stock) filtered = filtered.filter(m => this.matStockStatus(m) === stock);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['code', this.t('mat_code')], ['name', this.t('mat_name')], ['spec', this.t('mat_spec')],
      ['category', this.t('mat_category')], ['unit', this.t('mat_unit')], ['opening_qty', this.t('mat_opening_qty')],
      ...vp ? [['opening_price', this.t('mat_opening_price')]] : [],
      ['min_stock', this.t('mat_min_stock')],
      ['brand', this.t('mat_brand')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th class="text-center">${this.t('mat_status')}</th><th class="text-center"></th>`;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(vp ? 11 : 10); }
    else { tbody = pageData.map(m => `<tr><td class="cell-code">${m.code}</td><td>${m.name}</td><td>${m.spec || ''}</td><td>${m.category}</td><td>${m.unit}</td><td class="text-right">${m.opening_qty}</td>${vp ? `<td class="text-right">${this.fmtMoney(m.opening_price)}</td>` : ''}<td class="text-right">${m.min_stock}</td><td>${m.brand || ''}</td><td class="text-center">${m.status === '停用' ? this.statusBadge('停用') : `<span class="badge badge-success">${this.t('mat_in_use')}</span>`}</td><td class="text-center">${this.rowActions('materials', `App.editMaterial('${m.code}')`, `App.deleteMaterial('${m.code}')`)}</td></tr>`).join(''); }
    document.getElementById('materials-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('materials-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  async editMaterial(code) {
    let m = { code: '', name: '', spec: '', category: '', unit: '', opening_qty: 0, opening_price: 0, min_stock: 0, brand: '', status: '' };
    if (code) { const data = await this.api('/api/materials'); m = data.find(d => d.code === code) || m; }
    this._editingCode = code || '';
    // 编辑：接口带 opening_price 才渲染该输入；新建：仅 admin/manager 可建，按角色决定
    const showPrice = code ? this.hasField(m, 'opening_price') : this.canViewPrice();
    // 已有期初以外的流水：期初数量/单价锁定，置灰并说明原因
    const openingLocked = !!(code && m.opening_locked);
    const openingTip = openingLocked ? `<div style="grid-column:1/-1;color:var(--text-muted);font-size:12px;line-height:1.5">${this.t('mat_opening_locked')}</div>` : '';
    const cats = this.params.categories.map(c => c.name), units = this.params.units.map(u => u.name);
    const sel = (arr, val) => arr.map(a => `<option value="${a}" ${a === val ? 'selected' : ''}>${a}</option>`).join('');
    // 参考图片：压缩后的 blob 暂存在内存，物料保存成功后再上传；删除同理
    this._matImage = {
      blob: null,
      removed: false,
      currentUrl: m.image_path ? this.materialImageUrl(m) : '',
      previewUrl: '',
    };
    this.showModal(`<h3>${code ? this.t('mat_edit') : this.t('mat_add')}</h3>`, `<div class="form-grid">
      <div class="form-group"><label>${this.t('mat_code')} ${code ? '' : '(' + this.t('mat_code_auto') + ')'}</label><input id="m_code" value="${m.code}" ${code ? '' : 'readonly placeholder="' + this.t('mat_code_hint') + '"'} oninput="App.onMaterialCodeInput(this.value)"><div class="form-error" id="m_code_error"></div></div>
      <div class="form-group"><label>${this.t('mat_name')} *</label><input id="m_name" value="${m.name}" oninput="App.clearFieldError('m_name')"><div class="form-error" id="m_name_error"></div></div>
      <div class="form-group"><label>${this.t('mat_spec')}</label><input id="m_spec" value="${m.spec || ''}"></div>
      <div class="form-group"><label>${this.t('mat_category')} *</label><select id="m_category" onchange="App.onMaterialCategoryChange()"><option value="">${this.t('please_select')}</option>${sel(cats, m.category)}</select><div class="form-error" id="m_category_error"></div></div>
      <div class="form-group"><label>${this.t('mat_unit')} *</label><select id="m_unit" onchange="App.clearFieldError('m_unit')"><option value="">${this.t('please_select')}</option>${sel(units, m.unit)}</select><div class="form-error" id="m_unit_error"></div></div>
      <div class="form-group"><label>${this.t('mat_opening_qty')}</label><input id="m_opening_qty" type="number" step="0.01" value="${m.opening_qty}" ${openingLocked ? 'disabled' : ''}></div>
      ${showPrice ? `<div class="form-group"><label>${this.t('mat_opening_price')}</label><input id="m_opening_price" type="number" step="0.01" value="${m.opening_price}" ${openingLocked ? 'disabled' : ''}></div>` : ''}
      ${openingTip}
      <div class="form-group"><label>${this.t('mat_min_stock')}</label><input id="m_min_stock" type="number" step="0.01" value="${m.min_stock}"></div>
      <div class="form-group"><label>${this.t('mat_brand')}</label><input id="m_brand" value="${m.brand || ''}"></div>
      <div class="form-group"><label>${this.t('mat_status')}</label><select id="m_status"><option value="">${this.t('mat_in_use')}</option><option value="停用" ${m.status === '停用' ? 'selected' : ''}>${this.t('mat_stopped')}</option></select></div>
      <div class="form-group mat-image-group"><label>${this.t('mat_image')}</label>
        <div class="mat-image-field">
          <div class="ref-image-frame ref-image-frame--md" id="m_image_frame"></div>
          <div class="mat-image-actions">
            <div>
              <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('m_image_file').click()">${this.t('mat_image_choose')}</button>
              <button type="button" class="btn btn-outline btn-sm" id="m_image_remove" onclick="App.removeMaterialImage()">${this.t('mat_image_remove')}</button>
            </div>
            <div class="mat-image-tip">${this.t('mat_image_tip')}</div>
            <div class="form-error" id="m_image_error"></div>
          </div>
        </div>
        <input type="file" id="m_image_file" accept="image/*" style="display:none" onchange="App.onMaterialImagePick(this)">
      </div>
      </div>`, code ? this.t('save') : this.t('add'), async () => {
      if (!this.validateForm({ m_name: [{rule:'required'}], m_category: [{rule:'required'}], m_unit: [{rule:'required'}] })) return;
      // 编码可改：归一后与现有物料比对（编辑时排除自身），冲突直接指出占用编码
      const nextCode = (document.getElementById('m_code').value || '').trim().toUpperCase();
      if (code && nextCode && nextCode !== code.toUpperCase()) {
        const hit = (this._materialsData || []).find(x => x.code && x.code.trim().toUpperCase() === nextCode && x.code !== code);
        if (hit) { this.toast(this.t('mat_code_dup', { code: hit.code }), 'error'); return; }
      }
      const body = { code: nextCode || (code || 'auto'), name: document.getElementById('m_name').value.trim(), spec: document.getElementById('m_spec').value.trim(), category: document.getElementById('m_category').value, unit: document.getElementById('m_unit').value, min_stock: parseFloat(document.getElementById('m_min_stock').value) || 0, brand: document.getElementById('m_brand').value.trim(), status: document.getElementById('m_status').value };
      // 期初锁定时不提交这两个键，服务端沿用原值；未锁定才按表单提交
      if (!openingLocked) body.opening_qty = parseFloat(document.getElementById('m_opening_qty').value) || 0;
      // showPrice 为假时输入框不渲染，也不提交该键；服务端会保留原期初单价（新建默认 0）
      if (showPrice && !openingLocked) body.opening_price = parseFloat(document.getElementById('m_opening_price').value) || 0;
      // 保存前前置校验：与本列表已有物料比对四字段（编辑时排除自身）
      const dup = this.findMaterialDuplicate(body, code || '');
      if (dup) { this.toast(this.materialDupMessage(body, dup.code), 'error'); return; }
      try {
        const saved = await this.api('/api/materials' + (code ? '/' + code : ''), code ? 'PUT' : 'POST', body);
        const savedCode = code || (saved && saved.code) || nextCode;
        // 物料档案已保存；图片单独走二进制接口，失败不回滚档案，但明确提示
        try {
          if (this._matImage && this._matImage.blob) {
            await this.uploadMaterialImage(savedCode, this._matImage.blob);
            this.toast(this.t('mat_image_saved'));
          } else if (code && this._matImage && this._matImage.removed) {
            await this.api('/api/materials/' + encodeURIComponent(code) + '/image', 'DELETE');
            this.toast(this.t('mat_image_removed'));
          }
        } catch (imgErr) {
          this.toast(this.t('mat_image_upload_failed', { msg: imgErr.message }), 'error');
        }
        this.closeModal(); this.toast(code ? this.t('updated') : this.t('added')); this.renderMaterials();
      }
      catch (e) { this.toast(this.lang === 'en' && e.error_en ? e.error_en : e.message, 'error'); }
    });
    this.renderMatImagePreview();
    // 新增模式下，初始如果有类别就触发
    if (!code && m.category) this.onMaterialCategoryChange();
  },

  // ========== 参考图片（选择 / 预览 / 压缩 / 上传） ==========
  renderMatImagePreview() {
    const box = document.getElementById('m_image_frame');
    const btn = document.getElementById('m_image_remove');
    if (!box || !this._matImage) return;
    const url = this._matImage.previewUrl || this._matImage.currentUrl;
    box.classList.toggle('is-empty', !url);
    box.innerHTML = url
      ? `<img src="${url}" alt=""><span class="ref-image-hint">${this.t('mat_image_hover')}</span>`
      : `<span>${this.t('mat_image_none')}</span>`;
    box.onclick = url ? () => this.openImageLightbox(url) : null;
    if (btn) btn.style.display = url ? '' : 'none';
  },

  async onMaterialImagePick(input) {
    const f = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!f) return;
    const errEl = document.getElementById('m_image_error');
    if (errEl) errEl.textContent = '';
    try {
      const blob = await this.compressMaterialImage(f);
      this._matImage.blob = blob;
      this._matImage.removed = false;
      this._matImage.previewUrl = URL.createObjectURL(blob);
      this.renderMatImagePreview();
    } catch (e) {
      if (errEl) errEl.textContent = e.message || this.t('mat_image_compress_failed');
    }
  },

  removeMaterialImage() {
    if (!this._matImage) return;
    this._matImage.blob = null;
    this._matImage.removed = true;
    this._matImage.currentUrl = '';
    this._matImage.previewUrl = '';
    this.renderMatImagePreview();
  },

  // 浏览器端压缩：长边 ≤800px、体积 ≤300KB（质量逐步下调，必要时再缩小尺寸）
  async compressMaterialImage(file) {
    if (!file || !/^image\//i.test(String(file.type || ''))) throw new Error(this.t('mat_image_invalid'));
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      const u = URL.createObjectURL(file);
      i.onload = () => { URL.revokeObjectURL(u); resolve(i); };
      i.onerror = () => { URL.revokeObjectURL(u); reject(new Error(this.t('mat_image_invalid'))); };
      i.src = u;
    });
    const MAX_EDGE = 800;
    const LIMIT = 300 * 1024;
    let scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    for (let round = 0; round < 5; round++) {
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      for (let q = 0.86; q >= 0.46; q -= 0.1) {
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= LIMIT) return blob;
      }
      scale *= 0.8;
    }
    throw new Error(this.t('mat_image_compress_failed'));
  },

  async uploadMaterialImage(code, blob) {
    const res = await fetch('/api/materials/' + encodeURIComponent(code) + '/image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (res.status === 401) { await this.handleUnauthorized(res); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((this.lang === 'en' && data.error_en) ? data.error_en : (data.error || this.t('requestFailed')));
    }
    return data;
  },

  // 编辑时编码输入即时校验：归一（trim + 大写）后与本列表其它物料比对，口径与保存一致
  onMaterialCodeInput(value) {
    const el = document.getElementById('m_code_error');
    if (!el) return;
    const next = String(value || '').trim().toUpperCase();
    const old = this._editingCode || '';
    if (!next || !old || next === old.toUpperCase()) { el.textContent = ''; return; }
    const hit = (this._materialsData || []).find(x => x.code && x.code.trim().toUpperCase() === next && x.code !== old);
    el.textContent = hit ? this.t('mat_code_dup', { code: hit.code }) : '';
  },

  // ========== 批量新增 ==========
  MAT_FIELD_KEYS: {
    code: 'mat_code', category: 'mat_category', name: 'mat_name', spec: 'mat_spec', brand: 'mat_brand',
    unit: 'mat_unit', opening_qty: 'mat_opening_qty', opening_price: 'mat_opening_price', min_stock: 'mat_min_stock',
  },

  matEsc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  newMatBatchRow() {
    return { code: '', category: '', name: '', spec: '', brand: '', unit: '', opening_qty: '', opening_price: '', min_stock: '' };
  },

  async batchAddMaterials() {
    if (!this.can('materials', 'create')) return;
    try { this._materialsData = await this.api('/api/materials'); }
    catch (e) { this.toast(e.message, 'error'); return; }
    this._matBatch = {
      rows: Array.from({ length: 5 }, () => this.newMatBatchRow()),
      submitting: false,
    };
    this._matBatchAnchor = { row: 0, field: 'code' };
    this.showModal(`<h3>${this.t('mat_batch_title')}</h3>`, this.matBatchBody(), this.t('save'),
      () => this.submitMaterialBatch(), null, true, { maximizable: true });
    // 粘贴挂在固定容器上：增删行/重新渲染只换 innerHTML，监听不会丢
    const wrap = document.getElementById('mat-batch-table-wrap');
    if (wrap) {
      wrap.addEventListener('focusin', e => {
        const cell = e.target && e.target.closest ? e.target.closest('[data-field]') : null;
        const tr = cell ? cell.closest('tr') : null;
        if (!cell || !tr) return;
        const rowIdx = Number(String(tr.id || '').replace('mat-batch-row-', ''));
        if (!Number.isNaN(rowIdx)) this._matBatchAnchor = { row: rowIdx, field: cell.getAttribute('data-field') };
      });
      wrap.addEventListener('paste', e => this.matBatchPaste(e));
    }
  },

  matBatchBody() {
    return `<div style="margin-bottom:10px;color:var(--text-muted);font-size:12px">${this.t('mat_batch_hint')}</div>
      <div id="mat-batch-summary" style="display:none;margin-bottom:10px;padding:8px 10px;border:1px solid var(--danger);border-radius:6px;background:rgba(220,53,69,.08);color:var(--danger);font-size:13px"></div>
      <div id="mat-batch-table-wrap">${this.matBatchTableHtml()}</div>
      <div style="margin-top:10px"><button type="button" class="btn btn-outline btn-sm" onclick="App.matBatchAddRow()">+ ${this.t('mat_batch_add_row')}</button></div>`;
  },

  matBatchTableHtml() {
    const st = this._matBatch;
    const cats = this.params.categories.map(c => c.name);
    const unitList = this.params.units.map(u => u.name);
    const vp = this.canViewPrice();
    // 粘贴进来的非法数字用 text 显示原值，交给提交时校验报错
    const numType = v => (String(v == null ? '' : v).trim() !== '' && isNaN(Number(v))) ? 'text' : 'number';
    const head = `<tr><th>${this.t('mat_code')}</th><th>${this.t('mat_category')} *</th><th>${this.t('mat_name')} *</th>
      <th>${this.t('mat_spec')}</th><th>${this.t('mat_brand')}</th><th>${this.t('mat_unit')} *</th>
      <th>${this.t('mat_opening_qty')}</th>${vp ? `<th>${this.t('mat_opening_price')}</th>` : ''}
      <th>${this.t('mat_min_stock')}</th><th></th><th></th></tr>`;
    const rows = st.rows.map((r, i) => `<tr id="mat-batch-row-${i}">
      <td style="min-width:96px"><input data-field="code" value="${this.matEsc(r.code)}" placeholder="${this.t('mat_code_auto')}" oninput="App.matBatchSet(${i},'code',this.value,this)"></td>
      <td style="min-width:110px">${this.matComboHtml(i, 'category', r.category, cats)}</td>
      <td style="min-width:130px"><input data-field="name" value="${this.matEsc(r.name)}" oninput="App.matBatchSet(${i},'name',this.value,this)"></td>
      <td style="min-width:110px"><input data-field="spec" value="${this.matEsc(r.spec)}" oninput="App.matBatchSet(${i},'spec',this.value,this)"></td>
      <td style="min-width:90px"><input data-field="brand" value="${this.matEsc(r.brand)}" oninput="App.matBatchSet(${i},'brand',this.value,this)"></td>
      <td style="min-width:90px">${this.matComboHtml(i, 'unit', r.unit, unitList)}</td>
      <td style="min-width:86px"><input data-field="opening_qty" type="${numType(r.opening_qty)}" step="0.01" value="${this.matEsc(r.opening_qty)}" oninput="App.matBatchSet(${i},'opening_qty',this.value,this)"></td>
      ${vp ? `<td style="min-width:86px"><input data-field="opening_price" type="${numType(r.opening_price)}" step="0.01" value="${this.matEsc(r.opening_price)}" oninput="App.matBatchSet(${i},'opening_price',this.value,this)"></td>` : ''}
      <td style="min-width:86px"><input data-field="min_stock" type="${numType(r.min_stock)}" step="0.01" value="${this.matEsc(r.min_stock)}" oninput="App.matBatchSet(${i},'min_stock',this.value,this)"></td>
      <td class="text-center"><button type="button" class="pu-edit-del" onclick="App.matBatchRemoveRow(${i})">${this.t('in_remove_row')}</button></td>
      <td id="mat-batch-err-${i}" style="font-size:12px;color:var(--danger);min-width:150px;max-width:260px"></td>
    </tr>`).join('');
    return `<div class="table-wrap"><table class="pu-edit-lines"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  },

  // 输入过程只更新状态：不做实时校验，只在提交时统一标错
  matBatchSet(i, field, value, el) {
    const st = this._matBatch;
    if (!st || !st.rows[i]) return;
    st.rows[i][field] = value;
    if (el) el.style.borderColor = '';
  },

  matBatchAddRow() {
    const st = this._matBatch;
    if (!st) return;
    st.rows.push(this.newMatBatchRow());
    this.matComboClose();
    document.getElementById('mat-batch-table-wrap').innerHTML = this.matBatchTableHtml();
    this.matBatchShowSummary('');
  },

  matBatchRemoveRow(i) {
    const st = this._matBatch;
    if (!st) return;
    if (st.rows.length <= 1) st.rows = [this.newMatBatchRow()];
    else st.rows.splice(i, 1);
    this.matComboClose();
    document.getElementById('mat-batch-table-wrap').innerHTML = this.matBatchTableHtml();
    this.matBatchShowSummary('');
  },

  matBatchShowSummary(msg) {
    const el = document.getElementById('mat-batch-summary');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? '' : 'none';
  },

  // 弹窗表格的字段顺序（与表头一致）；无价格权限时不显示期初单价列
  matBatchFields() {
    const f = ['code', 'category', 'name', 'spec', 'brand', 'unit', 'opening_qty'];
    if (this.canViewPrice()) f.push('opening_price');
    f.push('min_stock');
    return f;
  },

  // 下拉值归一：去首尾空白（含全角空格、不换行空格）与零宽等不可见字符，
  // 全角 ASCII 转半角，忽略大小写，用于 Excel 粘贴时匹配下拉选项
  matBatchNorm(v) {
    return String(v == null ? '' : v)
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .trim()
      .toLowerCase();
  },

  // 在下拉选项里做归一匹配：命中返回选项的标准写法，未命中原样返回（保留给提交校验报错）
  matBatchPickOption(list, v) {
    const key = this.matBatchNorm(v);
    if (!key) return v;
    const hit = (list || []).find(a => this.matBatchNorm(a) === key);
    return hit === undefined ? v : hit;
  },

  // ========== 批量新增：可输入过滤的类别/单位 combobox ==========
  matComboList(field) {
    return field === 'category' ? this.params.categories.map(c => c.name) : this.params.units.map(u => u.name);
  },

  matComboHtml(i, field, value, list) {
    const val = this.matEsc(value);
    return `<div class="mat-combo"><input data-field="${field}" class="mat-combo-input" value="${val}" placeholder="${this.t('mat_combo_ph')}" autocomplete="off" spellcheck="false"
      oninput="App.matComboInput(${i},'${field}',this)" onfocus="App.matComboOpen(${i},'${field}',this)" onkeydown="App.matComboKey(event,${i},'${field}',this)" onblur="App.matComboBlur()"></div>`;
  },

  matComboMenu() {
    let el = document.getElementById('mat-combo-menu');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mat-combo-menu';
      el.className = 'mat-combo-menu';
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  },

  matComboClose() {
    const el = document.getElementById('mat-combo-menu');
    if (el) el.hidden = true;
    this._matComboCtx = null;
  },

  matComboOpen(i, field, input) {
    const v = String(input.value || '').trim();
    const list = this.matComboList(field);
    // 已选中标准项时展示全量，便于改选；否则按输入内容过滤
    const exact = v && this.matBatchPickOption(list, v) === v;
    this.matComboRender(i, field, input, exact ? '' : v);
  },

  matComboInput(i, field, input) {
    this.matBatchSet(i, field, input.value, input);
    this.matComboRender(i, field, input, input.value);
  },

  matComboRender(i, field, input, filter) {
    const menu = this.matComboMenu();
    const rect = input.getBoundingClientRect();
    const list = this.matComboList(field);
    const key = this.matBatchNorm(filter);
    const opts = key ? list.filter(a => this.matBatchNorm(a).indexOf(key) >= 0) : list.slice();
    const prevRow = i > 0 ? this._matBatch.rows[i - 1] : null;
    const prev = prevRow ? String(prevRow[field] || '').trim() : '';
    let html = '';
    // 空输入时把「同上行」放首项：回车即可沿用，减少逐项键盘定位
    if (!key && prev) {
      html += `<div class="mat-combo-item mat-combo-same" data-val="${this.matEsc(prev)}" onmousedown="event.preventDefault()" onclick="App.matComboPick(this)">${this.t('mat_combo_same_above', { v: this.matEsc(prev) })}</div>`;
    }
    html += opts.length
      ? opts.map(a => `<div class="mat-combo-item" data-val="${this.matEsc(a)}" onmousedown="event.preventDefault()" onclick="App.matComboPick(this)">${this.matEsc(a)}</div>`).join('')
      : `<div class="mat-combo-empty">${this.t('mat_combo_no_match')}</div>`;
    menu.innerHTML = html;
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 2) + 'px';
    menu.style.width = Math.max(rect.width, 160) + 'px';
    menu.hidden = false;
    this._matComboCtx = { i: i, field: field, input: input };
  },

  matComboPick(itemEl) {
    const ctx = this._matComboCtx;
    if (!ctx || !itemEl) return;
    const v = itemEl.getAttribute('data-val') || '';
    ctx.input.value = v;
    this.matBatchSet(ctx.i, ctx.field, v, ctx.input);
    this.matComboClose();
  },

  matComboKey(e, i, field, input) {
    const menu = this.matComboMenu();
    const items = menu.hidden ? [] : Array.from(menu.querySelectorAll('.mat-combo-item'));
    const active = items.findIndex(x => x.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) { this.matComboOpen(i, field, input); return; }
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? (active + 1) % items.length
        : (active <= 0 ? items.length - 1 : active - 1);
      items.forEach((x, idx) => x.classList.toggle('active', idx === next));
      return;
    }
    if (e.key === 'Escape') { this.matComboClose(); return; }
    if (e.key === 'Enter') {
      if (items.length) { e.preventDefault(); this.matComboPick(items[active >= 0 ? active : 0]); return; }
      const prevRow = i > 0 ? this._matBatch.rows[i - 1] : null;
      const prev = prevRow ? String(prevRow[field] || '').trim() : '';
      // 空框直接回车 = 沿用上一行
      if (!String(input.value || '').trim() && prev) {
        e.preventDefault();
        input.value = prev;
        this.matBatchSet(i, field, prev, input);
        this.matComboClose();
      }
      return;
    }
    if (e.key === 'Tab') this.matComboCommit(i, field, input);
  },

  // 离开时把大小写/全半角/空白差异归一为选项标准写法，未命中则保留原值交给提交校验
  matComboCommit(i, field, input) {
    const v = String(input.value || '').trim();
    const picked = this.matBatchPickOption(this.matComboList(field), v);
    if (picked !== v) { input.value = picked; this.matBatchSet(i, field, picked, input); }
    this.matComboClose();
  },

  matComboBlur() {
    setTimeout(() => this.matComboClose(), 120);
  },

  // 解析 Excel 剪贴板：制表符分列、换行分行，支持双引号包裹的单元格；
  // 统一换行符，并丢弃完全空白的行（Excel 末尾常带空行）
  matBatchParseClipboard(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const out = [];
    let row = [], cell = '', inQuote = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inQuote) {
        if (ch === '"') {
          if (raw[i + 1] === '"') { cell += '"'; i++; } else inQuote = false;
        } else cell += ch;
        continue;
      }
      if (ch === '"') inQuote = true;
      else if (ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter(r => r.some(c => String(c).trim() !== ''));
  },

  // 从 Excel 粘贴：以当前单元格为起点向右下铺开，行不够自动补行；
  // 只覆盖有内容的单元格，超出表格的列忽略；不触发实时校验
  matBatchPaste(e) {
    const st = this._matBatch;
    if (!st) return;
    const text = e.clipboardData
      ? e.clipboardData.getData('text')
      : (window.clipboardData ? window.clipboardData.getData('Text') : '');
    if (e.clipboardData && text === '') return; // 非文本内容交给浏览器默认行为
    e.preventDefault();
    const grid = this.matBatchParseClipboard(text);
    if (!grid.length) { this.toast(this.t('mat_batch_pasted_none'), 'error'); return; }
    const fields = this.matBatchFields();
    const anchor = this._matBatchAnchor || { row: 0, field: 'code' };
    let col = fields.indexOf(anchor.field);
    if (col < 0) col = 0;
    const startRow = Math.max(0, Number(anchor.row) || 0);
    // 下拉列粘贴时按归一规则匹配选项，命中就用选项标准写法，保证回填后自动选中
    const optionLists = {
      category: this.params.categories.map(c => c.name),
      unit: this.params.units.map(u => u.name),
    };
    let appliedCols = 0;
    grid.forEach((cells, ri) => {
      const rowIdx = startRow + ri;
      while (st.rows.length <= rowIdx) st.rows.push(this.newMatBatchRow());
      cells.forEach((raw, ci) => {
        const field = fields[col + ci];
        if (!field) return;                 // 多余的列忽略
        let v = String(raw == null ? '' : raw).trim();
        if (v === '') return;               // 空单元格不覆盖已有值
        if (optionLists[field]) v = this.matBatchPickOption(optionLists[field], v);
        st.rows[rowIdx][field] = v;
        appliedCols = Math.max(appliedCols, ci + 1);
      });
    });
    const wrap = document.getElementById('mat-batch-table-wrap');
    if (wrap) {
      this.matComboClose();
      wrap.innerHTML = this.matBatchTableHtml();
      // 重绘后把焦点还给起点单元格，保持继续编辑/再粘贴的连贯性
      const back = wrap.querySelector(`#mat-batch-row-${startRow} [data-field="${fields[col]}"]`);
      if (back) back.focus();
    }
    this.matBatchShowSummary('');
    this.toast(this.t('mat_batch_pasted', { rows: grid.length, cols: appliedCols }), 'success');
  },

  // 批量弹窗与 CSV 预览共用：返回与 rows 等长的错误数组
  validateMaterialRows(rows, withPrice) {
    const vp = withPrice === undefined ? this.canViewPrice() : withPrice;
    const cats = new Set(this.params.categories.map(c => c.name));
    const unitSet = new Set(this.params.units.map(u => u.name));
    const existing = this._materialsData || [];
    const identityFirst = new Map();
    const codeFirst = new Map();
    const val = v => String(v == null ? '' : v).trim();

    return rows.map((r, i) => {
      const errs = [];
      ['category', 'name', 'unit'].forEach(f => {
        if (!val(r[f])) errs.push({ field: f, required: true, message: this.t('mat_batch_err_required', { field: this.t(this.MAT_FIELD_KEYS[f]) }) });
      });
      const cat = val(r.category);
      if (cat && !cats.has(cat)) errs.push({ field: 'category', message: this.t('mat_batch_err_category', { v: cat }) });
      const unit = val(r.unit);
      if (unit && !unitSet.has(unit)) errs.push({ field: 'unit', message: this.t('mat_batch_err_unit', { v: unit }) });
      ['opening_qty', 'opening_price', 'min_stock'].forEach(f => {
        if (f === 'opening_price' && !vp) return;
        const v = val(r[f]);
        if (v !== '' && isNaN(Number(v))) {
          errs.push({ field: f, message: this.t('mat_batch_err_number', { field: this.t(this.MAT_FIELD_KEYS[f]) }) });
        }
      });

      const code = val(r.code).toUpperCase();
      if (code) {
        if (codeFirst.has(code)) {
          errs.push({ field: 'code', message: this.t('mat_batch_err_code_batch', { code }) });
        } else if (existing.some(m => String(m.code || '').toUpperCase() === code)) {
          errs.push({ field: 'code', message: this.t('mat_batch_err_code_db', { code }) });
        }
        if (!codeFirst.has(code)) codeFirst.set(code, i);
      }

      if (val(r.name)) {
        const key = this.materialIdentityKey(r);
        if (identityFirst.has(key)) {
          errs.push({ field: 'name', message: this.t('mat_batch_err_dup_batch', { row: identityFirst.get(key) + 1 }) });
        } else {
          const dup = this.findMaterialDuplicate(r, '');
          if (dup) errs.push({ field: 'name', message: this.t('mat_batch_err_dup_db', { code: dup.code }) });
          else identityFirst.set(key, i);
        }
      }
      return errs;
    });
  },

  // 只在提交时渲染：漏填只给红框 + 汇总，不逐行铺「不能为空」；
  // 重复/格式错误仍按原方式写在行尾红字，并标出整行。
  // 非提交场景（如 CSV 预览）直接调用时返回结果、不碰弹窗 DOM。
  matBatchValidateAll(opts) {
    const st = this._matBatch;
    if (!st) return [];
    const submit = !!(opts && opts.submit);
    const all = this.validateMaterialRows(st.rows, this.canViewPrice());
    if (!submit) return all;
    all.forEach((errs, i) => {
      const cell = document.getElementById('mat-batch-err-' + i);
      const tr = document.getElementById('mat-batch-row-' + i);
      if (!cell || !tr) return;
      tr.querySelectorAll('input,select').forEach(el => { el.style.borderColor = ''; });
      const others = errs.filter(e => !e.required);
      errs.filter(e => e.required).forEach(e => {
        const el = tr.querySelector(`[data-field="${e.field}"]`);
        if (el) el.style.borderColor = 'var(--danger)';
      });
      cell.innerHTML = others.map(e => this.matEsc(e.message)).join('<br>');
      if (others.length) tr.querySelectorAll('input,select').forEach(el => { el.style.borderColor = 'var(--danger)'; });
    });
    return all;
  },

  matBatchItems(rows) {
    const vp = this.canViewPrice();
    return rows.map((r, i) => {
      const val = v => String(v == null ? '' : v).trim();
      const o = {
        line: i + 1, code: val(r.code), category: val(r.category), name: val(r.name), spec: val(r.spec),
        brand: val(r.brand), unit: val(r.unit), opening_qty: val(r.opening_qty), min_stock: val(r.min_stock),
      };
      // 无价格权限：不提交期初单价，服务端按 0 处理
      if (vp) o.opening_price = val(r.opening_price);
      return o;
    });
  },

  async submitMaterialBatch() {
    const st = this._matBatch;
    if (!st || st.submitting) return;
    const all = this.matBatchValidateAll({ submit: true });
    const bad = all.filter(a => a.length).length;
    if (bad) {
      const missingRows = new Set();
      let missingCells = 0;
      all.forEach((errs, i) => errs.forEach(e => { if (e.required) { missingRows.add(i); missingCells++; } }));
      if (missingCells) {
        // 漏填：只标红框 + 一条汇总，不逐行铺「不能为空」
        this.matBatchShowSummary(this.t('mat_batch_missing_summary', { rows: missingRows.size, cells: missingCells }));
      } else {
        // 重复/格式错误：保持原来的行尾红字 + toast
        this.matBatchShowSummary('');
        this.toast(this.t('mat_batch_invalid', { n: bad }), 'error');
      }
      return;
    }
    this.matBatchShowSummary('');
    st.submitting = true;
    this.matComboClose();
    try {
      const res = await this.api('/api/materials/batch', 'POST', { items: this.matBatchItems(st.rows) });
      this.closeModal();
      this.toast(this.t('mat_batch_saved', { n: res.count }));
      this.renderMaterials();
    } catch (e) {
      st.submitting = false;
      const rows = (e.details && e.details.rows) || [];
      rows.forEach(r => {
        const tr = document.getElementById('mat-batch-row-' + ((r.row || 1) - 1));
        const cell = document.getElementById('mat-batch-err-' + ((r.row || 1) - 1));
        const msg = (r.errors || []).map(x => this.matEsc(this.lang === 'en' && x.message_en ? x.message_en : x.message)).join('<br>');
        if (cell) cell.innerHTML = msg;
        if (tr) tr.querySelectorAll('input,select').forEach(el => { el.style.borderColor = 'var(--danger)'; });
      });
      this.toast(e.message, 'error');
    }
  },

  // ========== CSV 批量导入 ==========
  async openMaterialImport() {
    if (!this.can('materials', 'create')) return;
    try { this._materialsData = await this.api('/api/materials'); }
    catch (e) { this.toast(e.message, 'error'); return; }
    this._matImport = { rows: [], errors: [], fileName: '', submitting: false };
    const body = `<div style="margin-bottom:10px;color:var(--text-muted);font-size:12px">${this.t('mat_import_hint')}</div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <input type="file" id="mat-import-file" accept=".csv,.xlsx,.xls,text/csv" onchange="App.matImportFilePicked(this)">
        <button type="button" class="btn btn-outline btn-sm" onclick="App.downloadMaterialTemplate()">${this.t('mat_import_download_tpl')}</button>
      </div>
      <div id="mat-import-preview"></div>`;
    this.showModal(`<h3>${this.t('mat_import_title')}</h3>`, body, this.t('mat_import_confirm'),
      () => this.submitMaterialImport(), null, true);
    this.matImportRenderPreview();
  },

  async downloadMaterialTemplate() {
    try {
      const res = await fetch('/api/materials/import-template?lang=' + this.lang,
        { headers: { Authorization: 'Bearer ' + this.token } });
      if (!res.ok) throw new Error(this.t('requestFailed'));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'materials-import-template.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  matImportFilePicked(input) {
    const file = input.files && input.files[0];
    const st = this._matImport;
    if (!file || !st) return;
    st.fileName = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bytes = ArrayBuffer.isView(reader.result)
          ? new Uint8Array(reader.result.buffer, reader.result.byteOffset, reader.result.byteLength)
          : new Uint8Array(reader.result);
        // Excel 另存的 xlsx/xls 是二进制文件，直接提示另存为 CSV，避免被当成乱码表头
        if (this.isExcelBytes(bytes)) {
          st.rows = []; st.errors = [];
          this.matImportRenderPreview();
          this.toast(this.t('mat_import_xlsx'), 'error');
          return;
        }
        this.matImportParse(this.decodeMaterialCsv(bytes));
      } catch (e) {
        st.rows = []; st.errors = [];
        this.matImportRenderPreview();
        this.toast(this.t('mat_import_parse_failed', { msg: e.message }), 'error');
      }
    };
    reader.onerror = () => this.toast(this.t('mat_import_read_failed'), 'error');
    reader.readAsArrayBuffer(file);
  },

  // 二进制解码：UTF-8 BOM → UTF-8；无 BOM 先严格 UTF-8，失败再按 GBK 系回退（Excel 中文环境常见 ANSI）
  decodeMaterialCsv(input) {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    const body = hasBom ? bytes.subarray(3) : bytes;
    if (hasBom) return new TextDecoder('utf-8').decode(body);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (e) { /* 不是合法 UTF-8，继续按 GBK 系尝试 */ }
    const fallbacks = ['gbk', 'gb18030', 'gb2312'];
    for (let i = 0; i < fallbacks.length; i++) {
      try {
        return new TextDecoder(fallbacks[i]).decode(body);
      } catch (e) { /* 当前浏览器不支持该编码标签 */ }
    }
    return new TextDecoder('utf-8').decode(body);
  },

  isExcelBytes(input) {
    const b = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    // xlsx = zip(PK)，老版 xls = OLE(D0 CF 11 E0)
    return (b[0] === 0x50 && b[1] === 0x4B) || (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0);
  },

  matImportParse(text) {
    const st = this._matImport;
    const matrix = this.parseMaterialCsv(text);
    if (!matrix.length) {
      st.rows = []; st.errors = [];
      this.matImportRenderPreview();
      this.toast(this.t('mat_import_empty'), 'error');
      return;
    }
    const map = this.matImportHeaderMap(matrix[0].cells);
    if (!map) {
      const got = matrix[0].cells.map(c => String(c == null ? '' : c).trim()).filter(Boolean).join(' | ') || '-';
      throw new Error(this.t('mat_import_bad_header_detail', { got, want: this.matImportExpectedHeaders() }));
    }
    const rows = matrix.slice(1).map(r => {
      const val = k => {
        const idx = map[k];
        return idx === undefined ? '' : String(r.cells[idx] == null ? '' : r.cells[idx]).trim();
      };
      return {
        line: r.line, code: val('code'),
        // 与批量新增弹窗同一口径：类别/单位做归一匹配（全半角、空白、大小写）
        category: this.matBatchPickOption(this.params.categories.map(c => c.name), val('category')),
        name: val('name'), spec: val('spec'),
        brand: val('brand'),
        unit: this.matBatchPickOption(this.params.units.map(u => u.name), val('unit')),
        opening_qty: val('opening_qty'),
        opening_price: val('opening_price'), min_stock: val('min_stock'),
      };
    });
    if (!rows.length) {
      st.rows = []; st.errors = [];
      this.matImportRenderPreview();
      this.toast(this.t('mat_import_empty'), 'error');
      return;
    }
    st.rows = rows;
    st.errors = this.validateMaterialRows(rows, this.canViewPrice());
    this.matImportRenderPreview();
  },

  // 表头识别：忽略 BOM 残留、首尾/全角空格与大小写差异，中英文表头都能认
  matImportHeaderMap(header) {
    const norm = s => String(s == null ? '' : s).replace(/[\ufeff\u200b\u3000]/g, '').replace(/\s+/g, '').toLowerCase();
    const aliases = {
      code: ['编码', 'code'],
      category: ['类别', '分类', 'category'],
      name: ['名称', '物料名称', 'name'],
      spec: ['规格', '规格型号', 'spec', 'specification'],
      brand: ['品牌', 'brand'],
      unit: ['单位', 'unit'],
      opening_qty: ['期初数量', '期初库存', 'opening qty', 'opening_qty', 'opening stock'],
      opening_price: ['期初单价', 'opening price', 'opening_price'],
      min_stock: ['安全库存', 'min stock', 'min_stock', 'minimum stock'],
    };
    const lookup = {};
    Object.keys(aliases).forEach(k => aliases[k].forEach(a => { lookup[norm(a)] = k; }));
    const map = {};
    (header || []).forEach((h, idx) => {
      const k = lookup[norm(h)];
      if (k && map[k] === undefined) map[k] = idx;
    });
    return Object.keys(map).length ? map : null;
  },

  // 表头识别失败时给出期望列，便于用户对照文件定位问题
  matImportExpectedHeaders() {
    return ['mat_code', 'mat_category', 'mat_name', 'mat_spec', 'mat_brand', 'mat_unit',
      'mat_opening_qty', 'mat_opening_price', 'mat_min_stock'].map(k => this.t(k)).join(' / ');
  },

  // 分隔符自动探测：在第一行里比较逗号/分号/制表符的出现次数，取最多的一个
  detectCsvDelimiter(text) {
    const s = String(text == null ? '' : text).replace(/^\ufeff/, '');
    let first = '', line = '', quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { quoted = !quoted; line += c; continue; }
      if (!quoted && (c === '\n' || c === '\r')) {
        const t = line.trim();
        if (t && !t.startsWith('#')) { first = line; break; }
        line = '';
        continue;
      }
      line += c;
    }
    if (!first) first = line;
    const cands = [',', ';', '\t'];
    let best = ',', max = 0;
    cands.forEach(d => {
      let n = 0, q = false;
      for (let i = 0; i < first.length; i++) {
        const c = first[i];
        if (c === '"') q = !q;
        else if (!q && c === d) n++;
      }
      if (n > max) { max = n; best = d; }
    });
    return best;
  },

  // 纯前端 CSV 解析：自动探测分隔符；支持引号包裹、字段内换行、CRLF；跳过空行与 # 注释行
  parseMaterialCsv(text) {
    const s = String(text == null ? '' : text).replace(/^\ufeff/, '');
    const delimiter = this.detectCsvDelimiter(s);
    const rows = [];
    let cells = [], cur = '', quoted = false, line = 1, rowLine = 1;
    const endRow = () => {
      cells.push(cur); cur = '';
      const first = String(cells[0] == null ? '' : cells[0]).trim();
      const has = cells.some(c => String(c == null ? '' : c).trim() !== '');
      if (has && !first.startsWith('#')) rows.push({ line: rowLine, cells });
      cells = [];
      line++;
      rowLine = line;
    };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; }
          else quoted = false;
        } else {
          cur += c;
          if (c === '\n') line++;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === delimiter) {
        cells.push(cur); cur = '';
      } else if (c === '\r') {
        // CRLF 的 \r 丢弃，由 \n 收行
      } else if (c === '\n') {
        endRow();
      } else {
        cur += c;
      }
    }
    if (cur !== '' || cells.length) {
      cells.push(cur); cur = '';
      const first = String(cells[0] == null ? '' : cells[0]).trim();
      const has = cells.some(c => String(c == null ? '' : c).trim() !== '');
      if (has && !first.startsWith('#')) rows.push({ line: rowLine, cells });
    }
    return rows;
  },

  matImportRenderPreview() {
    const box = document.getElementById('mat-import-preview');
    const st = this._matImport;
    if (!box || !st) return;
    if (!st.rows.length) {
      box.innerHTML = `<div class="empty-state" style="padding:20px"><p>${st.fileName ? this.t('mat_import_empty') : this.t('mat_import_no_data')}</p></div>`;
      return;
    }
    const vp = this.canViewPrice();
    const bad = st.errors.filter(a => a.length).length;
    const ok = st.rows.length - bad;
    const head = `<tr><th>#</th><th>${this.t('mat_code')}</th><th>${this.t('mat_category')}</th><th>${this.t('mat_name')}</th>
      <th>${this.t('mat_spec')}</th><th>${this.t('mat_brand')}</th><th>${this.t('mat_unit')}</th>
      <th>${this.t('mat_opening_qty')}</th>${vp ? `<th>${this.t('mat_opening_price')}</th>` : ''}
      <th>${this.t('mat_min_stock')}</th><th>${this.t('mat_import_status')}</th></tr>`;
    const body = st.rows.map((r, i) => {
      const errs = st.errors[i] || [];
      const style = errs.length ? ' style="color:var(--danger)"' : '';
      return `<tr${style}><td>${r.line}</td><td>${this.matEsc(r.code)}</td><td>${this.matEsc(r.category)}</td>
        <td>${this.matEsc(r.name)}</td><td>${this.matEsc(r.spec)}</td><td>${this.matEsc(r.brand)}</td>
        <td>${this.matEsc(r.unit)}</td><td>${this.matEsc(r.opening_qty)}</td>
        ${vp ? `<td>${this.matEsc(r.opening_price)}</td>` : ''}<td>${this.matEsc(r.min_stock)}</td>
        <td>${errs.length ? errs.map(e => this.matEsc(e.message)).join('<br>') : this.t('mat_import_ok')}</td></tr>`;
    }).join('');
    box.innerHTML = `<div style="margin-bottom:8px;font-size:12px">
        <b>${this.t('mat_import_summary', { total: st.rows.length, ok, bad })}</b>
        ${st.fileName ? `<span style="color:var(--text-muted);margin-left:8px">${this.matEsc(st.fileName)}</span>` : ''}
      </div>
      <div class="table-wrap"><table class="pu-edit-lines"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  },

  async submitMaterialImport() {
    const st = this._matImport;
    if (!st || st.submitting) return;
    if (!st.rows.length) { this.toast(this.t('mat_import_no_file'), 'error'); return; }
    if (st.errors.some(a => a.length)) { this.toast(this.t('mat_import_has_errors'), 'error'); return; }
    st.submitting = true;
    try {
      const items = this.matBatchItems(st.rows).map((o, i) => ({ ...o, line: st.rows[i].line }));
      const res = await this.api('/api/materials/batch', 'POST', { items });
      this.closeModal();
      this.toast(this.t('mat_import_done', { n: res.count }));
      this.renderMaterials();
    } catch (e) {
      st.submitting = false;
      const rows = (e.details && e.details.rows) || [];
      rows.forEach(r => {
        let idx = st.rows.findIndex(x => x.line === r.line);
        if (idx < 0) idx = (r.row || 1) - 1;
        if (st.rows[idx]) {
          st.errors[idx] = (r.errors || []).map(x => ({
            field: x.field, message: this.lang === 'en' && x.message_en ? x.message_en : x.message,
          }));
        }
      });
      this.matImportRenderPreview();
      this.toast(e.message, 'error');
    }
  },

  // 与后端 uq_materials_identity 同口径：trim + 忽略 ASCII 大小写，空值按空串
  materialIdentityKey(m) {
    const norm = v => String(v === undefined || v === null ? '' : v).trim().replace(/[A-Z]/g, c => c.toLowerCase());
    return [norm(m.category), norm(m.name), norm(m.spec), norm(m.brand)].join('\u0001');
  },

  findMaterialDuplicate(m, selfCode) {
    const key = this.materialIdentityKey(m);
    return (this._materialsData || []).find(x => x.code !== selfCode && this.materialIdentityKey(x) === key) || null;
  },

  materialDupMessage(m, code) {
    const v = k => String(m[k] === undefined || m[k] === null ? '' : m[k]).trim() || this.t('mat_dup_empty');
    return this.t('mat_dup_identity', { category: v('category'), name: v('name'), spec: v('spec'), brand: v('brand'), code });
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

  async deleteMaterial(code) {
    this.confirmDialog(this.t('cf_delete_material') + ' ' + code, this.t('cf_delete_material_msg'), async () => {
      try {
        await this.api('/api/materials/' + encodeURIComponent(code), 'DELETE');
        this.toast(this.t('deleted'));
        this.renderMaterials();
      } catch (e) {
        if (e.code !== 'MATERIAL_IN_USE' || !e.details || !Array.isArray(e.details.blockers)) {
          this.toast(e.message, 'error');
          return;
        }
        // 不能删：用弹窗把「还剩什么」逐项列清楚，避免 toast 一闪而过
        const en = this.lang === 'en';
        const rows = e.details.blockers.map(b =>
          `<li>${this.matEsc(en ? (b.label_en || b.label) : b.label)}：${b.count}${b.samples && b.samples.length ? `（${b.samples.map(s => this.matEsc(s)).join('、')}）` : ''}</li>`).join('');
        this.showModal(`<h3>${this.t('mat_delete_blocked_title')}</h3>`,
          `<div style="line-height:1.7"><p>${this.matEsc(e.message)}</p><ul style="margin:8px 0 0 18px">${rows}</ul></div>`,
          this.t('confirm'), () => this.closeModal());
      }
    });
  },

  onMaterialsFilter() {
    this._matFilters = {
      keyword: document.getElementById('mat_filter')?.value || '',
      category: document.getElementById('mat_category_filter')?.value || '',
      status: document.getElementById('mat_status_filter')?.value || '',
      stock: document.getElementById('mat_stock_filter')?.value || '',
    };
    const st = this.getTableState('materials');
    st.page = 1;
    this.renderMaterialsTable();
  },

});

// 批量新增的 combobox 菜单挂在 body 上（避免被弹窗表格裁切）：点击别处或滚动时收起
document.addEventListener('click', e => {
  if (!e.target.closest || e.target.closest('#mat-combo-menu') || e.target.closest('.mat-combo')) return;
  App.matComboClose();
}, false);
document.addEventListener('scroll', e => {
  const menu = document.getElementById('mat-combo-menu');
  if (!menu || menu.hidden) return;
  if (e.target.closest && e.target.closest('#mat-combo-menu')) return;
  App.matComboClose();
}, true);

undefined
