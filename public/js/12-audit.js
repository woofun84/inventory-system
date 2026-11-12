/**
 * 系统日志（审计）页面
 *
 * 记录"谁在什么时间做了什么"：登录、新增、修改、删除、确认、作废、更正。
 * 库里时间存 UTC，展示时按浏览器本地时区换算。
 */
(function () {
  const escHtml = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

  // 可审计模块（与后端 middleware/audit.js 的 PATH_MODULE 取值一致）
  const AUDIT_MODULES = ['auth', 'users', 'materials', 'suppliers', 'inbound', 'outbound', 'returns', 'purchase', 'stocktake', 'settings'];
  // 动作码（与后端 middleware/audit.js 产生/记录的动作一致）
  const AUDIT_ACTIONS = ['login', 'create', 'update', 'delete', 'confirm', 'void', 'load', 'change-password'];

  Object.assign(App, {
    // 把本地 Date 转成 UTC 字符串（用于给后端传时间边界）
    _auditUtcString(d) {
      const p = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    },
    // 用户本地日历日的起止时刻 → UTC 边界（跨时区查询也准确）
    auditDayStartUtc(day) { const [y, m, d] = day.split('-').map(Number); return this._auditUtcString(new Date(y, m - 1, d, 0, 0, 0)); },
    auditDayEndUtc(day) { const [y, m, d] = day.split('-').map(Number); return this._auditUtcString(new Date(y, m - 1, d, 23, 59, 59)); },

    auditModuleLabel(m) {
      const k = 'audit_mod_' + m, v = this.t(k);
      if (v !== k) return v;
      const n = 'nav_' + m;
      return this.t(n) !== n ? this.t(n) : m;
    },
    auditActionLabel(a) {
      const k = 'audit_act_' + String(a || '').replace(/-/g, '_'), v = this.t(k);
      return v !== k ? v : (a || '-');
    },

    async renderAuditLogs() {
      const st = this.getTableState('audit');
      if (!this._auditInit) { st.page = 1; st.pageSize = 50; this._auditInit = true; }
      this._auditFilter = this._auditFilter || { module: '', action: '', keyword: '', from: '', to: '' };
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['audit'] = () => this.loadAuditLogs();

      this.setMain(this.pageWrap('📜 ' + this.t('nav_audit'), this.t('audit_desc'), '', `
        <div class="data-page">
          <div class="data-toolbar">${this.renderAuditToolbar()}</div>
          <div class="data-scroll" id="audit-scroll"></div>
          <div class="data-pager" id="audit-pager"></div>
        </div>`));
      await this.loadAuditLogs();
    },

    renderAuditToolbar() {
      const f = this._auditFilter;
      const sel = 'padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)';
      const modOpts = [''].concat(AUDIT_MODULES)
        .map(m => `<option value="${m}" ${m === f.module ? 'selected' : ''}>${m ? escHtml(this.auditModuleLabel(m)) : this.t('audit_all_modules')}</option>`).join('');
      const actOpts = [''].concat(AUDIT_ACTIONS)
        .map(a => `<option value="${a}" ${a === f.action ? 'selected' : ''}>${a ? escHtml(this.auditActionLabel(a)) : this.t('audit_all_actions')}</option>`).join('');
      return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;width:100%">
        <select id="audit_filter_module" style="${sel}" onchange="App.onAuditFilter()">${modOpts}</select>
        <select id="audit_filter_action" style="${sel}" onchange="App.onAuditFilter()">${actOpts}</select>
        <input id="audit_filter_kw" placeholder="${this.t('audit_filter_ph')}" value="${escHtml(f.keyword)}" style="${sel};flex:1;min-width:180px;max-width:320px" oninput="App.onAuditFilter()">
        <input id="audit_filter_from" type="date" value="${f.from}" style="${sel}" onchange="App.onAuditFilter()">
        <span style="color:var(--text-muted);font-size:12px">~</span>
        <input id="audit_filter_to" type="date" value="${f.to}" style="${sel}" onchange="App.onAuditFilter()">
        <button class="btn btn-outline btn-sm" onclick="App.resetAuditFilter()">${this.t('audit_reset')}</button>
      </div>`;
    },

    onAuditFilter() {
      const f = this._auditFilter;
      f.module = (document.getElementById('audit_filter_module') || {}).value || '';
      f.action = (document.getElementById('audit_filter_action') || {}).value || '';
      f.keyword = (document.getElementById('audit_filter_kw') || {}).value || '';
      f.from = (document.getElementById('audit_filter_from') || {}).value || '';
      f.to = (document.getElementById('audit_filter_to') || {}).value || '';
      this.getTableState('audit').page = 1;
      clearTimeout(this._auditTimer);
      this._auditTimer = setTimeout(() => this.loadAuditLogs(), 300);
    },

    resetAuditFilter() {
      this._auditFilter = { module: '', action: '', keyword: '', from: '', to: '' };
      this.getTableState('audit').page = 1;
      this.renderAuditLogs();
    },

    async loadAuditLogs() {
      const st = this.getTableState('audit');
      const f = this._auditFilter;
      const q = new URLSearchParams();
      q.set('page', st.page);
      q.set('pageSize', st.pageSize > 0 ? st.pageSize : 200);
      if (f.module) q.set('module', f.module);
      if (f.action) q.set('action', f.action);
      if (f.keyword) q.set('keyword', f.keyword);
      if (f.from) q.set('fromUtc', this.auditDayStartUtc(f.from));
      if (f.to) q.set('toUtc', this.auditDayEndUtc(f.to));
      try {
        this._auditData = await this.api('/api/audit-logs?' + q.toString());
        this.renderAuditTable();
      } catch (e) {
        const el = document.getElementById('audit-scroll');
        if (el) el.innerHTML = `<div class="empty-state"><p>${escHtml(e.message)}</p></div>`;
      }
    },

    renderAuditTable() {
      const data = this._auditData || { rows: [], total: 0 };
      const rows = data.rows || [];
      const headers = ['audit_col_time', 'audit_col_user', 'audit_col_module', 'audit_col_action',
        'audit_col_target', 'audit_col_detail', 'audit_col_result', 'audit_col_ip'];
      const thHtml = headers.map(k => `<th>${this.t(k)}</th>`).join('');
      let tbody;
      if (!rows.length) {
        tbody = this.emptyRow(headers.length);
      } else {
        tbody = rows.map(r => {
          const detail = String(this.logDetailText(r) || '');
          const detailCell = detail
            ? `<div style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);font-size:12px" title="${escHtml(detail)}">${escHtml(detail)}</div>`
            : '';
          const ok = Number(r.status) < 400;
          const resultCell = ok
            ? `<span class="badge badge-success">${this.t('audit_ok')}</span>`
            : `<span class="badge badge-danger">${this.t('audit_fail')} ${escHtml(r.status)}</span>`;
          const roleCell = r.role ? this.t('role_' + r.role) : '';
          return `<tr>
            <td style="white-space:nowrap">${this.fmtDateTime(r.created_at, true)}</td>
            <td><strong>${escHtml(r.username || '-')}</strong>${r.name ? `<div style="color:var(--text-muted);font-size:12px">${escHtml(r.name)} · ${escHtml(roleCell)}</div>` : ''}</td>
            <td>${escHtml(this.auditModuleLabel(r.module))}</td>
            <td>${escHtml(this.auditActionLabel(r.action))}</td>
            <td>${escHtml(r.target || '')}</td>
            <td>${detailCell}</td>
            <td>${resultCell}</td>
            <td style="white-space:nowrap;color:var(--text-muted);font-size:12px">${escHtml(r.ip || '')}</td>
          </tr>`;
        }).join('');
      }
      const scroll = document.getElementById('audit-scroll');
      if (scroll) scroll.innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
      const pager = document.getElementById('audit-pager');
      if (pager) pager.innerHTML = this.renderPager('audit', data.total || 0);
    },
  });
})();
