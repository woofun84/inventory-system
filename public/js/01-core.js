/**
 * 应用主体 —— 状态、生命周期、主题语言、路由、API 封装、权限判定
 * 说明：App 是全局单例，各业务模块通过 Object.assign(App, {...}) 挂载方法，
 *      因此本文件必须最先加载。
 */

const App = {
  currentPage: 'dashboard',
  params: null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: localStorage.getItem('token') || '',
  lang: localStorage.getItem('lang') || 'zh',
  theme: localStorage.getItem('theme') || 'light',
  charts: [],

  // 取文案；可传 vars 做 {name} 占位符插值，如 t('st_line_count', {n: 5})
  t(key, vars) {
    let s = (I18N[this.lang] && I18N[this.lang][key]) || (I18N.zh[key]) || key;
    if (vars) {
      Object.keys(vars).forEach(k => {
        s = s.split('{' + k + '}').join(vars[k]);
      });
    }
    return s;
  },

  async init() {
    // 未登录 → 跳转登录页
    if (!this.token) { location.href = '/login.html'; return; }
    document.documentElement.setAttribute('data-theme', this.theme);
    try {
      // 校验 token 有效性
      const me = await this.api('/api/auth/me');
      this.user = me;
      localStorage.setItem('user', JSON.stringify(me));
    } catch (e) {
      this.logout();
      return;
    }
    // 启动空闲超时（5分钟无操作自动退出）
    this.startIdleTimer();
    // 强制改密：先加载 params 和渲染基础布局，再弹出改密弹窗
    if (this.user && this.user.must_change_pwd) {
      await this.loadParams();
      this.setMain(this.pageWrap('📦 ' + this.t('appName'), '', '', '<div id="force-pwd-hint" style="padding:40px;text-align:center;color:var(--text-muted)">' + this.t('change_password') + '</div>'));
      this.showChangePwdModal(true);
      return;
    }
    await this.loadParams();
    this.router();
    window.addEventListener('hashchange', () => this.router());
  },

  // 空闲超时：5分钟无操作自动退出
  _idleTimeout: 5 * 60 * 1000, // 5分钟
  _idleTimer: null,
  startIdleTimer() {
    this.resetIdleTimer();
    ['mousemove','keydown','click','scroll','touchstart'].forEach(evt => {
      document.addEventListener(evt, () => this.resetIdleTimer(), { passive: true });
    });
  },
  resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this.toast(this.t('session_timeout'), 'error');
      this.logout();
    }, this._idleTimeout);
  },

  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.href = '/login.html';
  },

  // 权限检查：can(模块, 操作)
  can(module, action) {
    if (!this.user || !this.user.grants) return false;
    const g = this.user.grants[module];
    return Array.isArray(g) && g.includes(action);
  },
  // 价格权限：只有 admin 和 manager 可以看到价格/金额
  canViewPrice() {
    return this.user && (this.user.role === 'admin' || this.user.role === 'manager');
  },

  showChangePwdModal(force) {
    const body = `<div class="form-grid" style="max-width:400px;margin:0 auto">
      <div class="form-group" style="grid-column:1/-1">
        <label>${this.t('old_password')} *</label>
        <input id="cp_old" type="password" oninput="App.clearFieldError('cp_old')">
        <div class="form-error" id="cp_old_error"></div>
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label>${this.t('new_password')} * <span style="font-size:11px;color:var(--text-muted)">(${this.t('pwd_min_len')})</span></label>
        <input id="cp_new" type="password" oninput="App.clearFieldError('cp_new')">
        <div class="form-error" id="cp_new_error"></div>
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label>${this.t('confirm_password')} *</label>
        <input id="cp_confirm" type="password" oninput="App.clearFieldError('cp_confirm')">
        <div class="form-error" id="cp_confirm_error"></div>
      </div>
    </div>`;
    this.showModal(`<h3>${this.t('change_password')}</h3>`, body, this.t('save'), async () => {
      if (!this.validateForm({
        cp_old: [{ rule: 'required' }],
        cp_new: [{ rule: 'required' }, { rule: 'minlen', param: 6 }],
        cp_confirm: [{ rule: 'required' }],
      })) return;
      const np = document.getElementById('cp_new').value;
      const cp = document.getElementById('cp_confirm').value;
      if (np !== cp) { this.setFieldError('cp_confirm', this.t('pwd_not_match')); return; }
      try {
        await this.api('/api/auth/change-password', 'POST', {
          oldPassword: document.getElementById('cp_old').value,
          newPassword: np,
        });
        this.closeModal();
        this.user.must_change_pwd = false;
        localStorage.setItem('user', JSON.stringify(this.user));
        this.toast(this.t('pwd_changed'));
        if (force) { await this.loadParams(); this.router(); window.addEventListener('hashchange', () => this.router()); }
      } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', this.theme);
    document.documentElement.setAttribute('data-theme', this.theme);
    this.destroyCharts();
    this.render();
  },

  toggleLang() {
    this.lang = this.lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('lang', this.lang);
    this.destroyCharts();
    this.render();
  },

  destroyCharts() {
    this.charts.forEach(c => { try { c.destroy(); } catch(e){} });
    this.charts = [];
  },

  renderToolbar() {
    return `<div class="toolbar">
      <button class="tool-btn tool-btn-sm" onclick="App.toggleLang()" title="Language">${this.lang === 'zh' ? 'EN' : '中文'}</button>
      <button class="tool-btn" onclick="App.toggleTheme()" title="Theme">${this.theme === 'light' ? '🌙' : '☀'}</button>
    </div>`;
  },

  async loadParams() {
    try {
      this.params = await this.api('/api/params');
    } catch (e) {
      console.error('Failed to load params', e);
      this.params = { categories: [], units: [], destinations: [] };
    }
  },

  router() {
    const hash = location.hash.slice(1) || 'dashboard';
    this.currentPage = hash;
    // 权限拦截：无 view 权限的页面不允许访问
    if (!this.can(hash, 'view') && hash !== 'dashboard') {
      this.currentPage = 'dashboard';
      this.toast(this.t('no_perm_msg'), 'error');
    }
    this.render();
  },

  render() {
    const pages = {
      dashboard: () => this.renderDashboard(), materials: () => this.renderMaterials(),
      inbound: () => this.renderInbound(), outbound: () => this.renderOutbound(), returns: () => this.renderReturns(),
      stockSummary: () => this.renderStockSummary(), query: () => this.renderQuery(),
      ledger: () => this.renderLedger(),
      stocktake: () => this.renderStocktake(),
      purchase: () => this.renderPurchase(), suppliers: () => this.renderSuppliers(),
      settings: () => this.renderSettings(),
      users: () => this.renderUsers(), audit: () => this.renderAuditLogs(),
    };
    (pages[this.currentPage] || pages.dashboard).call(this);
  },

  renderSidebar() {
    const nav = [
      { section: this.t('nav_home'), items: [{ key: 'dashboard', icon: '🏠', label: this.t('nav_home') }]},
      { section: this.lang === 'zh' ? '常用操作' : 'Operations', items: [
        { key: 'inbound', icon: '📥', label: this.t('nav_inbound') }, { key: 'outbound', icon: '📤', label: this.t('nav_outbound') },
        { key: 'returns', icon: '↩️', label: this.t('nav_returns') },
        { key: 'stocktake', icon: '📋', label: this.t('nav_stocktake') },
        { key: 'query', icon: '🔍', label: this.t('nav_query') }, { key: 'purchase', icon: '🛒', label: this.t('nav_purchase') },
      ]},
      { section: this.lang === 'zh' ? '统计与资料' : 'Analytics & Data', items: [
        { key: 'stockSummary', icon: '📦', label: this.t('nav_stock') }, { key: 'materials', icon: '🏷', label: this.t('nav_materials') },
        { key: 'suppliers', icon: '🚚', label: this.t('nav_suppliers') }, { key: 'ledger', icon: '📒', label: this.t('nav_ledger') },
        { key: 'settings', icon: '⚙', label: this.t('nav_settings') },
        { key: 'users', icon: '👤', label: this.t('nav_users') },
        { key: 'audit', icon: '📜', label: this.t('nav_audit') },
      ]}
    ];
    let html = `<div class="sidebar-header"><h1>📦 <span>${this.t('appName')}</span></h1><div class="subtitle">${this.t('appSub')}</div></div><div class="sidebar-nav">`;
    nav.forEach(s => {
      // 按权限过滤
      const visibleItems = s.items.filter(item => this.can(item.key, 'view'));
      if (visibleItems.length === 0) return;
      html += `<div class="nav-section-label">${s.section}</div>`;
      visibleItems.forEach(item => {
        html += `<div class="nav-item ${this.currentPage === item.key ? 'active' : ''}" onclick="location.hash='${item.key}'"><span class="nav-icon">${item.icon}</span><span>${item.label}</span></div>`;
      });
    });
    html += '</div>';
    // 底部用户信息栏
    if (this.user) {
      const roleLabel = this.t('role_' + this.user.role);
      html += `<div class="sidebar-user">
        <div class="sidebar-user-info">
          <span class="sidebar-user-name">${this.user.name || this.user.username}</span>
          <span class="sidebar-user-role">${roleLabel}</span>
        </div>
        <button class="tool-btn tool-btn-sm" onclick="App.showChangePwdModal(false)" title="${this.t('change_password')}">🔑</button>
        <button class="tool-btn tool-btn-sm" onclick="App.logout()" title="${this.lang === 'zh' ? '退出' : 'Logout'}">⏻</button>
      </div>`;
    }
    return html;
  },

  setMain(html) {
    document.getElementById('app').innerHTML = `<div class="layout">${this.renderSidebar()}<div class="main">${html}</div></div>`;
  },

  pageWrap(title, desc, headerRight, bodyHtml) {
    const tools = this.renderToolbar();
    const right = (headerRight || '') + tools;
    return `<div class="page-header-row"><div><div class="page-title">${title}</div>${desc ? `<div class="page-desc">${desc}</div>` : ''}</div><div>${right}</div></div><div class="page-body">${bodyHtml}</div>`;
  },

  async api(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) { this.logout(); throw new Error(this.t('session_expired')); }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: this.t('requestFailed') }));
      const e = new Error(err.error || this.t('requestFailed'));
      e.code = err.code;          // 业务错误码，如 INSUFFICIENT_STOCK
      e.details = err.details;    // 结构化明细，供前端展示
      e.status = res.status;
      throw e;
    }
    return res.json();
  },

  toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
  },

  confirmDialog(title, msg, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay'; overlay.id = 'confirm-overlay';
    overlay.innerHTML = `<div class="confirm-box"><div class="confirm-icon">${this.t('cf_warning')}</div><div class="confirm-title">${title}</div><div class="confirm-msg">${msg}</div><div class="confirm-actions"><button class="btn btn-outline" id="cf-cancel">${this.t('cancel')}</button><button class="btn btn-danger" id="cf-ok">${this.t('confirm')}</button></div></div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); if (onCancel) onCancel(); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('cf-cancel').onclick = close;
    document.getElementById('cf-ok').onclick = () => { overlay.remove(); onConfirm(); };
  },

  statusBadge(status) {
    const map = { '正常': this.t('st_normal'), '补货': this.t('st_restock'), '缺货': this.t('st_out'), '停用': this.t('mat_stopped'), '已到货': this.t('st_arrived'), '未到货': this.t('st_not_arrived'), '部分到货': this.t('st_partial'), '无明细': this.t('st_no_detail'), '已关闭': this.t('po_status_closed'), '已取消': this.t('po_status_cancelled') };
    const clsMap = { '正常': 'success', '补货': 'warning', '缺货': 'danger', '停用': 'muted', '已到货': 'success', '未到货': 'warning', '部分到货': 'info', '无明细': 'muted', '已关闭': 'muted', '已取消': 'danger' };
    return `<span class="badge badge-${clsMap[status] || 'muted'}">${map[status] || status}</span>`;
  },

};

// 显式挂到 window，便于控制台调试与外部脚本访问
// （顶层 const 本身就在全局词法环境可见，onclick="App.xxx()" 无需此行）
window.App = App;

