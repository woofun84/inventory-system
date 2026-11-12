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
  // 页面样式：与入库 / 出库 / 采购保持同一套 pu-card 卡片规范
  // 设置页样式已收敛到 public/css/pages.css，不再运行时注入

  async renderSettings() {
    this.setMain(this.pageWrap('⚙ ' + this.t('set_title'), this.t('set_desc'), '', `<div id="settings-content" class="set-page"><p class="set-loading">${this.t('loading')}</p></div>`));
    try {
      const data = await this.api('/api/params');
      const sections = [
        { key: 'categories', title: this.t('set_categories'), fields: ['name', 'prefix'], headers: [this.t('set_cat_name'), this.t('set_cat_prefix')] },
        { key: 'units', title: this.t('set_units'), fields: ['name'], headers: [this.t('set_unit_name')] },
        { key: 'destinations', title: this.t('set_destinations'), fields: ['name'], headers: [this.t('set_dest_name')] }
      ];
      let html = '<div class="set-grid">';
      sections.forEach((s, i) => { html += this.renderParamCard(i + 1, s, data[s.key] || []); });
      html += '</div>';
      // 单据编号规则（前缀 + 序号位数，带实时预览）
      if (data.docNoRules) html += this.renderDocNoRules(data.docNoRules);
      if (this.user && this.user.role === 'admin') {
        html += this.renderBackupPanel();
        html += this.renderCostVariancePanel();
        html += this.renderDangerPanel();
      } else {
        html += `<div class="pu-card"><div class="pu-card-title"><span>!</span><div>${this.t('set_backup_title')}</div></div>
          <p class="set-note" style="margin:0">${this.t('set_admin_only')}</p></div>`;
      }
      document.getElementById('settings-content').innerHTML = html;
      if (data.docNoRules) this.previewDocNo();
    } catch (e) { document.getElementById('settings-content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  // 单个基础参数字典卡片
  renderParamCard(n, s, items) {
    const canCreate = this.can('settings', 'create'), canDelete = this.can('settings', 'delete');
    const thHtml = s.headers.map(h => '<th>' + h + '</th>').join('') + '<th></th>';
    const rowsHtml = items.length
      ? items.map(item => {
        const cells = s.fields.map(f => '<td>' + this.docEsc(item[f] || '') + '</td>').join('');
        const del = canDelete ? '<td><span class="action-link danger" onclick="App.deleteParam(\'' + s.key + '\',' + item.id + ')">' + this.t('delete') + '</span></td>' : '<td></td>';
        return '<tr>' + cells + del + '</tr>';
      }).join('')
      : `<tr><td colspan="${s.headers.length + 1}" class="set-empty">${this.t('noData')}</td></tr>`;
    let addRow = '';
    if (canCreate) {
      const inputs = s.fields.map((f, idx) =>
        '<div class="form-group"><label>' + s.headers[idx] + '</label><input id="add_' + s.key + '_' + f + '" placeholder="' + s.headers[idx] + '"></div>').join('');
      addRow = '<div class="set-add">' + inputs + '<button class="btn btn-primary btn-sm" onclick="App.addParam(\'' + s.key + '\')">+ ' + this.t('add') + '</button></div>';
    }
    return `<div class="pu-card">
      <div class="pu-card-title"><span>${String(n).padStart(2, '0')}</span><div>${s.title}<small>${items.length}</small></div></div>
      <div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>
      ${addRow}</div>`;
  },

  // 数据备份与恢复（仅管理员可见，后端仍强制校验）
  renderBackupPanel() {
    return `<div class="pu-card">
      <div class="pu-card-title"><span>05</span><div>${this.t('set_backup_title')}<small>${this.t('set_backup_desc')}</small></div></div>
      <div class="set-op">
        <div class="set-op-main"><b>${this.t('set_backup_download')}</b><p>${this.t('set_backup_download_desc')}</p></div>
        <button class="btn btn-primary" id="set_backup_btn" onclick="App.downloadBackup(this)">${this.t('set_backup_btn')}</button>
      </div>
      <div class="set-sep"></div>
      <div class="set-op">
        <div class="set-op-main"><b>${this.t('set_restore_title')}</b><p>${this.t('set_restore_desc')}</p></div>
        <div class="set-op-actions">
          <input type="file" id="set_restore_file" accept=".db" class="set-file">
          <button class="btn btn-danger-outline" onclick="App.confirmRestore()">${this.t('set_restore_btn')}</button>
        </div>
      </div>
    </div>`;
  },

  // 成本差异结转（仅管理员；只改差异状态，不动库存）
  renderCostVariancePanel() {
    return `<div class="pu-card">
      <div class="pu-card-title"><span>06</span><div>${this.t('set_cv_title')}<small>${this.t('set_cv_desc')}</small></div></div>
      <div class="set-op">
        <div class="set-op-main"><b>${this.t('set_cv_op')}</b><p>${this.t('set_cv_op_desc')}</p></div>
        <button class="btn btn-primary" onclick="App.confirmSettleVariance()">${this.t('set_cv_btn')}</button>
      </div>
    </div>`;
  },

  // 数据清理（危险区）
  renderDangerPanel() {
    return `<div class="pu-card set-danger-card">
      <div class="pu-card-title"><span>07</span><div>${this.t('set_clear_title')}<small>${this.t('set_clear_desc')}</small></div></div>
      <div class="set-op">
        <div class="set-op-main"><b>${this.t('set_clear_business')}</b><p>${this.t('set_clear_business_desc')}</p></div>
        <button class="btn btn-danger-outline" onclick="App.confirmClear('business')">${this.t('set_clear_business_btn')}</button>
      </div>
      <div class="set-sep"></div>
      <div class="set-op">
        <div class="set-op-main"><b>${this.t('set_reset_all')}</b><p>${this.t('set_reset_all_desc')}</p></div>
        <button class="btn btn-danger-outline" onclick="App.confirmClear('reset')">${this.t('set_reset_all_btn')}</button>
      </div>
    </div>`;
  },

  // 单据编号规则区块
  renderDocNoRules(rules) {
    const canEdit = this.can('settings', 'edit');
    const labels = {
      grn: this.t('in_purchase'), ret: this.t('in_return'),
      gin: this.t('out_normal'), git: this.t('out_return'),
      st: this.t('st_title'),
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
    return `<div class="pu-card">
      <div class="pu-card-title"><span>04</span><div>${this.t('set_docno_title')}</div></div>
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

  docNoTypeKeys() { return ['grn', 'ret', 'gin', 'git', 'st', 'po']; },

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
      return `<span style="padding:3px 8px;border-radius:4px;background:var(--bg-muted);font-family:monospace">${prefix}-${date}-${'1'.padStart(pad, '0')}</span>`;
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

  // ========== 备份 / 恢复 / 清库（管理员） ==========

  // 下载一致性快照（带鉴权头，用 fetch 取 blob 再触发下载）
  async downloadBackup(btn) {
    btn = btn || document.getElementById('set_backup_btn');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = this.t('loading'); }
    try {
      const res = await fetch('/api/settings/backup/download', { headers: { Authorization: 'Bearer ' + this.token } });
      if (res.status === 401) { this.logout(); return; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || this.t('requestFailed'));
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const name = m ? m[1] : 'inventory-backup.db';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.toast(this.t('set_backup_done', { name }));
    } catch (e) {
      this.toast(e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  },

  // 二次确认弹窗：必须手动输入固定短语，输错不执行
  phraseConfirm(opts) {
    const body = `<p class="set-note">${opts.msg}</p>
      <div class="form-group"><label>${this.t('set_phrase_hint', { phrase: opts.phrase })}</label>
        <input id="set_phrase_input" autocomplete="off" oninput="App.clearFieldError('set_phrase_input')">
        <div class="form-error" id="set_phrase_input_error"></div>
      </div>`;
    this.showModal(`<h3>${opts.title}</h3>`, body, opts.btn, () => {
      const el = document.getElementById('set_phrase_input');
      const v = String((el && el.value) || '').trim();
      if (v !== opts.phrase) { this.setFieldError('set_phrase_input', this.t('set_phrase_mismatch')); return; }
      this.closeModal();
      opts.onOk();
    });
  },

  confirmRestore() {
    const el = document.getElementById('set_restore_file');
    const file = el && el.files && el.files[0];
    if (!file) { this.toast(this.t('set_restore_no_file'), 'error'); return; }
    this.phraseConfirm({
      title: this.t('set_restore_confirm_title'),
      msg: this.t('set_restore_confirm_msg'),
      phrase: '恢复',
      btn: this.t('set_restore_btn'),
      onOk: () => this.doRestore(file),
    });
  },

  async doRestore(file) {
    try {
      const res = await fetch('/api/settings/backup/restore?confirm=' + encodeURIComponent('恢复'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (res.status === 401) { this.logout(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || this.t('requestFailed'));
      this.showModal(`<h3>${this.t('set_restore_ok_title')}</h3>`,
        `<p class="set-note" style="margin:0">${this.t('set_restore_ok', { name: data.backupFile || '' })}</p>`,
        this.t('close'), () => { this.closeModal(); location.reload(); });
    } catch (e) { this.toast(e.message, 'error'); }
  },

  confirmClear(mode) {
    const isReset = mode === 'reset';
    this.phraseConfirm({
      title: this.t(isReset ? 'set_reset_confirm_title' : 'set_clear_confirm_title'),
      msg: this.t(isReset ? 'set_reset_confirm_msg' : 'set_clear_confirm_msg'),
      phrase: isReset ? '全部清空' : '清空',
      btn: this.t(isReset ? 'set_reset_all_btn' : 'set_clear_business_btn'),
      onOk: () => this.doClear(mode),
    });
  },

  async doClear(mode) {
    const isReset = mode === 'reset';
    try {
      const data = await this.api('/api/settings/data/' + (isReset ? 'reset' : 'clear-business'), 'POST',
        { confirm: isReset ? '全部清空' : '清空' });
      if (isReset) {
        // 当前登录用户已不存在：登录页展示默认账号后强制登出
        localStorage.setItem('login_notice', JSON.stringify({ username: data.username, password: data.password }));
        this.showModal(`<h3>${this.t('set_reset_done_title')}</h3>`,
          `<p class="set-note">${this.t('set_reset_done_msg', { username: data.username, password: data.password })}</p>
           <p class="set-note" style="margin:0">${this.t('set_backup_file', { name: data.backupFile || '' })}</p>`,
          this.t('close'), () => { this.closeModal(); this.logout(); });
        this.toast(this.t('set_reset_ok'));
        setTimeout(() => this.logout(), 5000);
        return;
      }
      this.showModal(`<h3>${this.t('set_clear_ok')}</h3>`,
        `<p class="set-note" style="margin:0">${this.t('set_backup_file', { name: data.backupFile || '' })}</p>`,
        this.t('close'), () => { this.closeModal(); this.renderSettings(); });
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // 成本差异结转：先取未结转账面金额，二次确认后执行
  async confirmSettleVariance() {
    let s;
    try { s = await this.api('/api/cost-variance'); }
    catch (e) { this.toast(e.message, 'error'); return; }
    if (!s || !s.count) { this.toast(this.t('set_cv_nothing')); return; }
    this.confirmDialog(this.t('set_cv_confirm_title'),
      this.t('set_cv_confirm_msg', { n: s.count, amount: this.fmtMoney(s.total) }),
      () => this.doSettleVariance(), null, 'primary');
  },

  async doSettleVariance() {
    try {
      const r = await this.api('/api/settings/cost-variance/settle', 'POST', {});
      this.showModal(`<h3>${this.t('set_cv_done_title')}</h3>`,
        `<p class="set-note" style="margin:0">${this.t('set_cv_done_msg', {
          n: r.settled_count,
          amount: this.fmtMoney(r.settled_total),
          batch: r.batch_no || '-',
        })}</p>`,
        this.t('close'), () => { this.closeModal(); this.renderSettings(); });
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
