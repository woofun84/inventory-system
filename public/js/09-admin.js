/**
 * 管理页 —— 供应商档案、参数设置、用户管理
 */
Object.assign(App, {
  // ========== 用户管理 ==========
  async renderUsers() {
    const addBtn = this.can('users','create') ? `<button class="btn btn-primary" onclick="App.editUser()">+ ${this.t('user_add')}</button>` : '';
    const toolbar = this.renderTableToolbar('user_filter', 'App.onUsersFilter()', addBtn);
    this.setMain(this.pageWrap('👤 ' + this.t('user_title'), this.t('user_desc'), '', `<div id="users-content" class="data-page"><div class="data-toolbar">${toolbar}</div><div class="data-scroll" id="users-scroll"></div><div class="data-pager" id="users-pager"></div></div>`));
    try {
      this._usersData = await this.api('/api/users');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['users'] = () => this.renderUsersTable();
      this.getTableState('users');
      this.renderUsersTable();
    } catch (e) { document.getElementById('users-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
  },

  renderUsersTable() {
    const data = this._usersData || [];
    const tid = 'users';
    const st = this.getTableState(tid);
    const kw = (document.getElementById('user_filter') || {}).value || '';
    let filtered = data;
    if (kw.trim()) filtered = this.filterByKeywords(data, kw, ['username','name','role']);
    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const headers = [
      ['username', this.t('user_username')], ['name', this.t('user_name')], ['role', this.t('user_role')],
      ['status', this.t('user_status'), 'center'], ['last_login', this.t('user_last_login')], ['created_at', this.t('ledger_date')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid, h[2])).join('');
    thHtml += `<th class="text-center"></th>`;
    const roleLabel = r => this.roleLabel(r);
    const statusBadge = s => s === 'active' ? `<span class="badge badge-success">${this.t('status_active')}</span>` : `<span class="badge badge-muted">${this.t('status_disabled')}</span>`;
    let tbody = '';
    if (pageData.length === 0) { tbody = this.emptyRow(headers.length + 1); }
    else { tbody = pageData.map(u => `<tr><td class="cell-code">${u.username}${u.must_change_pwd ? ' <span class="badge badge-warning">⚠</span>' : ''}</td><td>${u.name || ''}</td><td>${roleLabel(u.role)}</td><td class="text-center">${statusBadge(u.status)}</td><td>${this.fmtDateTime(u.last_login) || '-'}</td><td>${this.fmtDateTime(u.created_at)}</td><td class="text-center">${this.rowActions('users', `App.editUser(${u.id})`, `App.deleteUser(${u.id})`)}</td></tr>`).join(''); }
    document.getElementById('users-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('users-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onUsersFilter() {
    const st = this.getTableState('users'); st.page = 1;
    this.renderUsersTable();
  },

  async editUser(id) {
    let u = { username: '', name: '', role: 'operator', status: 'active', grants: null };
    if (id) { u = this._usersData.find(d => d.id === id) || u; }
    let catalog;
    try { catalog = await this.loadPermCatalog(); } catch (e) { this.toast(e.message, 'error'); return; }
    const grants = u.grants || catalog.roles[u.role] || {};
    const roleOpts = ['admin','manager','operator','viewer'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${this.roleLabel(r)}</option>`).join('');
    const statusOpts = [['active', this.t('status_active')], ['disabled', this.t('status_disabled')]].map(s => `<option value="${s[0]}" ${s[0] === u.status ? 'selected' : ''}>${s[1]}</option>`).join('');
    this.showModal(`<h3>${id ? this.t('user_edit') : this.t('user_add')}</h3>`, `<div class="form-grid" style="max-width:560px">
      <div class="form-group"><label>${this.t('user_username')} *</label><input id="u_username" value="${u.username}" ${id ? 'readonly' : ''} oninput="App.clearFieldError('u_username')"><div class="form-error" id="u_username_error"></div></div>
      <div class="form-group"><label>${this.t('user_name')}</label><input id="u_name" value="${u.name || ''}"></div>
      <div class="form-group"><label>${this.t('user_role')} *</label><select id="u_role" onchange="App.onUserRoleChange(this.value)">${roleOpts}</select></div>
      <div class="form-group"><label>${this.t('user_status')}</label><select id="u_status">${statusOpts}</select></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('user_password')} ${id ? `<span style="font-size:11px;color:var(--text-muted)">(${this.t('user_password_hint')})</span>` : '*'}</label><input id="u_password" type="password" ${id ? 'placeholder="' + this.t('user_password_hint') + '"' : ''} oninput="App.clearFieldError('u_password')"><div class="form-error" id="u_password_error"></div></div>
      ${this.renderPermMatrix(catalog, grants, u.role === 'admin')}
    </div>`, this.t('save'), async () => {
      const body = {
        name: document.getElementById('u_name').value.trim(),
        role: document.getElementById('u_role').value,
        status: document.getElementById('u_status').value,
      };
      if (!id) body.permissions = this.collectUserPerms();
      else if (body.role !== 'admin') body.permissions = this.collectUserPerms();
      const pwd = document.getElementById('u_password').value;
      if (!id) {
        if (!document.getElementById('u_username').value.trim()) { this.setFieldError('u_username', this.t('field_required')); return; }
        body.username = document.getElementById('u_username').value.trim();
        if (!pwd) { this.setFieldError('u_password', this.t('field_required')); return; }
        body.password = pwd;
        if (!this.validateForm({ u_username: [{rule:'required'}], u_password: [{rule:'required'},{rule:'minlen',param:6}] })) return;
      } else {
        if (pwd) { body.password = pwd; if (pwd.length < 6) { this.setFieldError('u_password', this.t('pwd_min_len')); return; } }
      }
      try {
        await this.api('/api/users' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', body);
        this.closeModal();
        this.toast(id ? this.t('updated') : this.t('added'));
        this.renderUsers();
      } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  async loadPermCatalog() {
    if (!this._permCatalog) this._permCatalog = await this.api('/api/permissions/catalog');
    return this._permCatalog;
  },

  renderPermMatrix(catalog, grants, adminLocked) {
    const rows = catalog.modules.map(m => {
      const acts = grants[m.key] || [];
      const boxes = m.actions.map(a => `<label style="display:inline-flex;align-items:center;gap:3px;margin-right:12px;font-size:12px;white-space:nowrap"><input type="checkbox" data-perm="${m.key}" value="${a}" ${acts.includes(a) ? 'checked' : ''} ${adminLocked ? 'disabled' : ''}>${this.t('perm_' + a)}</label>`).join('');
      return `<div style="display:flex;align-items:flex-start;gap:6px;padding:5px 8px;border-bottom:1px solid var(--border)"><span style="min-width:84px;font-size:12px;color:var(--text-muted);padding-top:2px">${this.t('nav_' + (m.key === 'dashboard' ? 'home' : m.key))}</span><span style="flex:1;display:flex;flex-wrap:wrap;gap:4px 0">${boxes}</span></div>`;
    }).join('');
    return `<div class="form-group" style="grid-column:1/-1"><label>${this.t('perm_title')}</label><div id="u_perm_matrix" style="border:1px solid var(--border);border-radius:6px;max-height:250px;overflow:auto">${rows}</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px">${this.t(adminLocked ? 'perm_admin_hint' : 'perm_hint')}</div></div>`;
  },

  onUserRoleChange(role) {
    if (!this._permCatalog) return;
    const defaults = this._permCatalog.roles[role] || {};
    const locked = role === 'admin';
    document.querySelectorAll('#u_perm_matrix input[type=checkbox]').forEach(cb => {
      cb.checked = (defaults[cb.dataset.perm] || []).includes(cb.value);
      cb.disabled = locked;
    });
  },

  collectUserPerms() {
    const out = {};
    document.querySelectorAll('#u_perm_matrix input[type=checkbox]:checked').forEach(cb => {
      (out[cb.dataset.perm] = out[cb.dataset.perm] || []).push(cb.value);
    });
    return out;
  },

  deleteUser(id) {
    this.confirmDialog(this.t('cf_delete_user'), this.t('cf_delete_user_msg'), async () => {
      try { await this.api('/api/users/' + id, 'DELETE'); this.toast(this.t('deleted')); this.renderUsers(); }
      catch (e) { this.toast(e.message, 'error'); }
    });
  },

});

undefined
