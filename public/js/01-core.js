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

  // 合法页面键：无法识别的 hash（含已下线旧地址）统一落到查询中心默认板块
  pageKeys: ['dashboard', 'materials', 'inbound', 'outbound', 'returns', 'query',
    'stocktake', 'purchase', 'suppliers', 'settings', 'users', 'audit'],

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

  // 角色标签：字典缺失时回落原始值，避免界面出现 role_xxx 这类原始 key
  roleLabel(role) {
    const k = 'role_' + String(role || '');
    const v = this.t(k);
    return v === k ? String(role || '') : v;
  },

  // 日志详情渲染：优先结构化 detail_json（{key, params}），解析失败/缺失回退纯文本 detail。
  // 找不到文案 key 时退化为 key 本身，不空白、不抛错。
  logDetailText(l) {
    const raw = l && l.detail_json;
    if (raw) {
      try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (o && typeof o.key === 'string' && o.key) {
          const sep = this.lang === 'zh' ? '、' : ', ';
          const params = {};
          Object.keys(o.params || {}).forEach(k => {
            const v = (o.params || {})[k];
            params[k] = Array.isArray(v)
              ? v.map(x => (x && typeof x.key === 'string') ? this.t(x.key, x.params || {}) : String(x)).join(sep)
              : v;
          });
          const out = this.t(o.key, params);
          return out === o.key ? o.key : out;
        }
      } catch (_) { /* 解析失败 → 回退纯文本 */ }
    }
    return String((l && l.detail) || '');
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
      // 已被其它终端挤下线：保留当前页面，由 handleKicked 弹出提示，不做静默跳转
      if (this.conn && this.conn.kicked) return;
      this.logout();
      return;
    }
    // 启动空闲超时（5分钟无操作自动退出）
    this.startIdleTimer();
    // 启动连接监视与登录会话心跳（14-connection.js）
    if (this.startConnectionWatch) this.startConnectionWatch();
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
    if (this.conn && this.conn.kicked) return; // 已被挤下线：由被挤提示接管，不再触发空闲退出
    this._idleTimer = setTimeout(() => {
      this.toast(this.t('session_timeout'), 'error');
      this.logout();
    }, this._idleTimeout);
  },

  logout() {
    // 通知服务端撤销本会话（失败不影响本地清理），避免令牌在服务端继续有效
    if (this.revokeSession) this.revokeSession();
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
  // 响应里是否带某个字段（无价格权限时服务端直接删键，前端据此决定列/块是否渲染）
  hasField(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  },
  // 列表场景：以首行是否带该字段为准（服务端对同一接口的字段集是一致的）
  priceVisible(rows, key) {
    return Array.isArray(rows) ? rows.length > 0 && this.hasField(rows[0], key) : this.hasField(rows, key);
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
      <button class="tool-btn tool-btn-sm" onclick="App.toggleLang()" title="${this.t('hdr_lang_tip')}">${this.lang === 'zh' ? 'EN' : '中文'}</button>
      <button class="tool-btn" onclick="App.toggleTheme()" title="${this.t('hdr_theme_tip')}">${this.theme === 'light' ? '🌙' : '☀'}</button>
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
    const raw = location.hash.slice(1) || 'dashboard';
    const qIdx = raw.indexOf('?');
    let hash = (qIdx >= 0 ? raw.slice(0, qIdx) : raw) || 'dashboard';
    // hash 只带单层页面键，?code= 作为物料流水深链参数，不参与权限判断
    const code = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '').get('code') || '';
    // 旧地址（#ledger / #stockSummary）及其它无法识别的页面键不再单独映射，
    // 统一落到查询中心默认板块，避免落到看板并弹「无权限」
    if (!this.pageKeys.includes(hash)) {
      hash = 'query';
      history.replaceState(null, '', '#query');
    }
    if (hash === 'query') { this.qPendingCode = code; this.qNav = true; }
    this.currentPage = hash;
    // 权限拦截：无 view 权限的页面不允许访问
    if (!this.can(hash, 'view') && hash !== 'dashboard') {
      this.currentPage = 'dashboard';
      this.toast(this.t('no_perm_msg'), 'error');
    }
    this.onPageEnter(this.currentPage);
    return this.render();
  },

  render() {
    document.title = this.t('doc_title');
    const pages = {
      dashboard: () => this.renderDashboard(), materials: () => this.renderMaterials(),
      inbound: () => this.renderInbound(), outbound: () => this.renderOutbound(), returns: () => this.renderReturns(),
      query: () => this.renderQuery(),
      stocktake: () => this.renderStocktake(),
      purchase: () => this.renderPurchase(), suppliers: () => this.renderSuppliers(),
      settings: () => this.renderSettings(),
      users: () => this.renderUsers(), audit: () => this.renderAuditLogs(),
    };
    return (pages[this.currentPage] || pages.dashboard).call(this);
  },

  // ========== 页面切换：统一的“进入即失效”与可重入导航 ==========
  // 页面进入钩子：重置分页，并只清掉该页的详情/汇总缓存；筛选、页签等用户状态保持不变。
  // 各模块不再各自实现一份，新增页面只需在 switch 中登记缓存键。
  onPageEnter(page) {
    const st = this.tableStates && this.tableStates[page];
    if (st) st.page = 1;
    switch (page) {
      case 'inbound': this._ibDetailCache = {}; break;
      case 'outbound': this._obDetailCache = {}; break;
      case 'purchase': this._puDetail = {}; break;
      case 'stocktake': this._stCache = {}; break;
      case 'returns': this._retData = null; break;
      case 'query':
        this._stockData = null;
        this._qCardData = null; this._qCardRows = [];
        this._qDocsCardData = null; this._qDocsCardRows = [];
        this._qRcvCardData = null;
        break;
    }
  },

  // 写操作成功后：按接口前缀精确失效受影响的缓存/页面，并把页面标脏，
  // 由详情栏关闭时按需补拉列表（不做全局轮询，也不整页刷新）。
  invalidateAfterWrite(url) {
    const path = String(url || '').split('?')[0];
    // 库存汇总是唯一跨页共享的汇总缓存，任何写操作后都失效
    this._stockData = null;
    this._stale = this._stale || {};
    const rules = [
      [/^\/api\/inbound-docs/, ['inbound', 'returns', 'query']],
      [/^\/api\/outbound-docs/, ['outbound', 'returns', 'query']],
      [/^\/api\/returns/, ['returns', 'query']],
      [/^\/api\/stocktakes/, ['stocktake', 'query']],
      [/^\/api\/purchase/, ['purchase', 'inbound', 'query']],
      [/^\/api\/materials/, ['materials', 'query']],
      [/^\/api\/suppliers/, ['suppliers', 'purchase']],
      [/^\/api\/params/, ['materials', 'query', 'purchase']],
      [/^\/api\/users/, ['users']],
    ];
    const pages = new Set();
    rules.forEach(([re, keys]) => { if (re.test(path)) keys.forEach(k => pages.add(k)); });
    pages.forEach(k => { this._stale[k] = true; });
    // 只清详情类快照；列表留在内存里供“关闭详情栏”时的过渡渲染，真正取数由标记驱动
    if (pages.has('inbound')) this._ibDetailCache = {};
    if (pages.has('outbound')) this._obDetailCache = {};
    if (pages.has('purchase')) this._puDetail = {};
    if (pages.has('stocktake')) this._stCache = {};
    if (pages.has('returns')) this._retData = null;
    if (path.indexOf('/api/params') === 0) this.loadParams();
  },

  // 列表重新取数后调用，清除该页的脏标记
  markFresh(page) {
    if (this._stale) this._stale[page] = false;
  },

  isStale(page) {
    return !!(this._stale && this._stale[page]);
  },

  // 统一页面跳转：同步 currentPage 与地址栏 hash 后渲染；
  // hash 未变化（点当前菜单）时也强制重渲染+重新取数，不再依赖浏览器派发 hashchange。
  async gotoPage(name, opts = {}) {
    const { replace = false, render = true } = opts;
    this.closeSidebar();
    const target = '#' + name;
    const hashChanged = location.hash !== target;
    if (hashChanged) {
      if (replace) history.replaceState(null, '', target);
      else history.pushState(null, '', target);
    }
    this.currentPage = name;
    if (!render) return;
    if (hashChanged) return this.router();
    return this.reloadPage();
  },

  // 当前页原地重进：走同一套页面进入钩子与渲染，等价于“重新点一次菜单”
  async reloadPage() {
    this.onPageEnter(this.currentPage);
    return this.render();
  },

  renderSidebar() {
    const nav = [
      { section: this.t('nav_sec_overview'), items: [{ key: 'dashboard', icon: '🏠', label: this.t('nav_home') }]},
      { section: this.t('nav_sec_business'), items: [
        { key: 'inbound', icon: '📥', label: this.t('nav_inbound') }, { key: 'outbound', icon: '📤', label: this.t('nav_outbound') },
        { key: 'purchase', icon: '🛒', label: this.t('nav_purchase') },
        { key: 'returns', icon: '↩️', label: this.t('nav_returns') },
        { key: 'stocktake', icon: '📋', label: this.t('nav_stocktake') },
      ]},
      { section: this.t('nav_sec_analytics'), items: [
        { key: 'query', icon: '🔍', label: this.t('nav_query') },
      ]},
      { section: this.t('nav_sec_master'), items: [
        { key: 'materials', icon: '🏷', label: this.t('nav_materials') },
        { key: 'suppliers', icon: '🚚', label: this.t('nav_suppliers') },
      ]},
      { section: this.t('nav_sec_system'), items: [
        { key: 'users', icon: '👤', label: this.t('nav_users') },
        { key: 'settings', icon: '⚙', label: this.t('nav_settings') },
        { key: 'audit', icon: '📜', label: this.t('nav_audit') },
      ]}
    ];
    let html = `<div class="sidebar"><div class="sidebar-header"><h1>📦 <span>${this.t('appName')}</span></h1><div class="subtitle">${this.t('appSub')}</div></div><div class="sidebar-nav">`;
    nav.forEach(s => {
      // 按权限过滤
      const visibleItems = s.items.filter(item => this.can(item.key, 'view'));
      if (visibleItems.length === 0) return;
      html += `<div class="nav-section-label">${s.section}</div>`;
      visibleItems.forEach(item => {
        html += `<div class="nav-item ${this.currentPage === item.key ? 'active' : ''}" onclick="App.gotoPage('${item.key}')"><span class="nav-icon">${item.icon}</span><span>${item.label}</span></div>`;
      });
    });
    html += '</div>';
    // 底部用户信息栏
    if (this.user) {
      const roleLabel = this.roleLabel(this.user.role);
      html += `<div class="sidebar-user">
        <div class="sidebar-user-info">
          <span class="sidebar-user-name">${this.user.name || this.user.username}</span>
          <span class="sidebar-user-role">${roleLabel}</span>
        </div>
        <button class="tool-btn tool-btn-sm" onclick="App.showChangePwdModal(false)" title="${this.t('change_password')}">🔑</button>
        <button class="tool-btn tool-btn-sm" onclick="App.logout()" title="${this.t('hdr_logout_tip')}">⏻</button>
      </div>`;
    }
    html += '</div>';
    return html;
  },

  // 窄屏抽屉侧边栏开合
  openSidebar() { document.body.classList.add('nav-open'); },
  closeSidebar() { document.body.classList.remove('nav-open'); },

  setMain(html) {
    // 页面整体重渲染时收起即时搜索浮层，避免固定定位面板残留到新页面
    if (this.msClose) this.msClose();
    document.getElementById('app').innerHTML = `<div class="layout">${this.renderSidebar()}<div class="sidebar-overlay" onclick="App.closeSidebar()"></div><div class="main">${html}</div></div>`;
  },

  pageWrap(title, desc, headerRight, bodyHtml) {
    const tools = this.renderToolbar();
    const right = (headerRight || '') + tools;
    return `<div class="page-header-row"><div class="page-heading"><button type="button" class="nav-toggle" onclick="App.openSidebar()" aria-label="${this.t('nav_menu')}" title="${this.t('nav_menu')}">☰</button><div class="page-heading-text"><div class="page-title">${title}</div>${desc ? `<div class="page-desc">${desc}</div>` : ''}</div></div><div>${right}</div></div><div class="page-body">${bodyHtml}</div>`;
  },

  async api(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body) opts.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      // 请求没有拿到任何响应：服务器不可达（进程停止 / 断网），交给连接监视器显示横幅
      if (this.connMarkOffline) this.connMarkOffline();
      throw new Error(this.t('net_offline_err'));
    }
    if (this.connMarkOnline) this.connMarkOnline();
    if (res.status === 401) return this.handleUnauthorized(res);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: this.t('requestFailed') }));
      // 英文界面优先展示服务端 error_en；没有时回落中文 error
      const msg = (this.lang === 'en' && err.error_en) ? err.error_en : (err.error || this.t('requestFailed'));
      const e = new Error(msg);
      e.code = err.code;          // 业务错误码，如 INSUFFICIENT_STOCK
      e.error_en = err.error_en;  // 英文文案，英文界面优先展示
      e.details = err.details;    // 结构化明细，供前端展示
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    if (String(method).toUpperCase() !== 'GET') this.invalidateAfterWrite(url);
    return data;
  },

  // 401 分流：被其它终端挤下线 → 明确提示；其余（过期/无效令牌）→ 回登录页
  async handleUnauthorized(res) {
    const d = await res.json().catch(() => ({}));
    const msg = (this.lang === 'en' && d.error_en) ? d.error_en : (d.error || this.t('session_expired'));
    if (d.code === 'SESSION_KICKED' && this.handleKicked) {
      this.handleKicked();
      const e = new Error(msg);
      e.code = 'SESSION_KICKED';
      e.status = 401;
      throw e;
    }
    this.logout();
    const err = new Error(msg);
    err.code = d.code;
    err.status = 401;
    throw err;
  },

  toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
  },

  confirmDialog(title, msg, onConfirm, onCancel, intent = 'danger') {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay'; overlay.id = 'confirm-overlay';
    const okCls = intent === 'primary' ? 'btn-primary' : 'btn-danger';
    overlay.innerHTML = `<div class="confirm-box"><div class="confirm-icon">${this.t('cf_warning')}</div><div class="confirm-title">${title}</div><div class="confirm-msg">${msg}</div><div class="confirm-actions"><button class="btn btn-outline" id="cf-cancel">${this.t('cancel')}</button><button class="btn ${okCls}" id="cf-ok">${this.t('confirm')}</button></div></div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); if (onCancel) onCancel(); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('cf-cancel').onclick = close;
    document.getElementById('cf-ok').onclick = () => { overlay.remove(); onConfirm(); };
  },

  // ===== 徽标单一事实源 =====
  // 单据状态 → 徽标类：草稿/作废/取消/关闭 一律灰；已过账 绿；更正/部分/调整 青；
  // 未到货/补货 橙；缺货 红。各模块只能从这里取类名，不得自建映射。
  docStatusMeta(status) {
    const map = {
      draft: 'badge-muted',
      voided: 'badge-muted',
      cancelled: 'badge-muted',
      closed: 'badge-muted',
      posted: 'badge-success',
      confirmed: 'badge-success',
      revised: 'badge-info',
      partial: 'badge-info',
      adjusted: 'badge-info',
      not_arrived: 'badge-warning',
      restock: 'badge-warning',
      out_of_stock: 'badge-danger',
    };
    return { cls: map[status] || 'badge-muted' };
  },

  // 业务类型 → 徽标类：同一业务类型在全项目必须同色
  docTypeBadgeClass(type) {
    const map = {
      '采购入库': 'badge-info',
      '零星入库': 'badge-info',
      '采购退货': 'badge-danger',
      '正常出库': 'badge-warning',
      '领料退库': 'badge-success',
      '盘点单': 'badge-muted',
      '盘盈': 'badge-success',
      '盘亏': 'badge-danger',
    };
    return map[type] || 'badge-muted';
  },

  statusBadge(status) {
    const map = { '正常': this.t('st_normal'), '补货': this.t('st_restock'), '缺货': this.t('st_out'), '停用': this.t('mat_stopped'), '已到货': this.t('st_arrived'), '未到货': this.t('st_not_arrived'), '部分到货': this.t('st_partial'), '无明细': this.t('st_no_detail'), '已关闭': this.t('po_status_closed'), '已取消': this.t('po_status_cancelled') };
    const clsMap = { '正常': 'success', '补货': 'warning', '缺货': 'danger', '停用': 'muted', '已到货': 'success', '未到货': 'warning', '部分到货': 'info', '无明细': 'muted', '已关闭': 'muted', '已取消': 'muted' };
    return `<span class="badge badge-${clsMap[status] || 'muted'}">${map[status] || status}</span>`;
  },

};

// 显式挂到 window，便于控制台调试与外部脚本访问
// （顶层 const 本身就在全局词法环境可见，onclick="App.xxx()" 无需此行）
window.App = App;

