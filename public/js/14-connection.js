/**
 * 连接状态监视 & 登录会话保活
 *
 * 只解决两件「前端如何感知」的问题，不参与任何业务判断、不改权限矩阵：
 *   1) 服务器断开：轮询免鉴权的 /api/health；请求失败即顶部横幅提示，恢复后横幅自动消失。
 *   2) 单终端登录：轮询 /api/auth/session；被后登录的终端挤下线时给出明确提示，而不是静默跳登录页。
 *
 * 依赖 01-core.js 的 App 单例，通过 Object.assign 挂载（与其它业务模块一致）。
 */
Object.assign(App, {
  conn: { online: true, kicked: false, timer: null, ticks: 0, el: null, probing: false, lastCheck: 0 },

  // ==================== 启动 ====================
  startConnectionWatch() {
    if (this.conn.timer) return;
    // 5 秒一轮：在线时每 3 轮（15 秒）校验一次会话；离线时每轮探测一次服务器
    this.conn.timer = setInterval(() => this.connTick(), 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.connTick(true); });
    window.addEventListener('focus', () => this.connTick(true));
    window.addEventListener('online', () => this.connTick(true));
    window.addEventListener('offline', () => this.connMarkOffline());
  },

  connTick(force) {
    if (this.conn.kicked || !this.token) return;
    if (document.hidden && !force) return;
    // 切回标签页/获得焦点时立即校验一次，但 3 秒内不重复请求
    if (force && Date.now() - this.conn.lastCheck < 3000) return;
    this.conn.lastCheck = Date.now();
    if (this.conn.online) {
      this.conn.ticks++;
      if (this.conn.ticks % 3 === 0) this.sessionPing();
    } else {
      this.probeHealth();
    }
  },

  // 带超时的 fetch：服务器进程挂起（不是崩溃）时也能判定为不可达
  async fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}, { signal: ctl.signal }));
    } finally {
      clearTimeout(to);
    }
  },

  // 会话心跳：401 + SESSION_KICKED 说明已被其它终端挤下线
  async sessionPing() {
    try {
      const res = await this.fetchWithTimeout('/api/auth/session', {
        headers: { Authorization: 'Bearer ' + this.token },
      }, 8000);
      if (res.status === 401) {
        const d = await res.json().catch(() => ({}));
        if (d.code === 'SESSION_KICKED') this.handleKicked();
        else this.logout();
        return;
      }
      this.connMarkOnline();
    } catch (e) {
      this.connMarkOffline();
    }
  },

  async probeHealth() {
    if (this.conn.probing) return;
    this.conn.probing = true;
    try {
      const res = await this.fetchWithTimeout('/api/health', null, 4000);
      if (res.ok) this.connMarkOnline();
    } catch (e) {
      // 仍然不可达，等下一轮
    } finally {
      this.conn.probing = false;
    }
  },

  // ==================== 在线 / 离线状态 ====================
  connMarkOffline() {
    if (this.conn.kicked) return;
    if (this.conn.online) this.conn.ticks = 0;
    this.conn.online = false;
    this.connShowBanner();
  },

  connMarkOnline() {
    if (this.conn.kicked || this.conn.online) return;
    this.conn.online = true;
    this.conn.ticks = 0;
    this.connHideBanner();
    // 让当前请求先处理完，再刷新页面，避免渲染重入
    setTimeout(() => {
      const synced = this.connSyncPage();
      this.toast(this.t(synced ? 'net_restored' : 'net_restored_unsaved'), synced ? 'success' : 'warning');
    }, 0);
  },

  // 恢复连接后刷新当前页数据：有弹窗或在输入框中时只提示不重渲染，避免冲掉未提交的内容
  connSyncPage() {
    if (this.user && this.user.must_change_pwd) return false; // 强制改密期间不打扰
    if (document.querySelector('.modal-overlay') || document.getElementById('confirm-overlay')) return false;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && String(ae.value || '').trim()) return false;
    try {
      this.destroyCharts();
      this.render();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  },

  connShowBanner() {
    if (!document.body) return;
    document.body.classList.add('conn-offline');
    if (this.conn.el) return;
    const el = document.createElement('div');
    el.className = 'conn-banner';
    el.id = 'conn-banner';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="conn-dot"></span>
      <span class="conn-title">${this.t('net_offline_title')}</span>
      <span class="conn-desc">${this.t('net_offline_desc')}</span>`;
    document.body.appendChild(el);
    this.conn.el = el;
  },

  connHideBanner() {
    if (this.conn.el) this.conn.el.remove();
    this.conn.el = null;
    document.body.classList.remove('conn-offline');
  },

  // ==================== 被挤下线 ====================
  handleKicked() {
    if (this.conn.kicked) return;
    this.conn.kicked = true;
    if (this.conn.timer) { clearInterval(this.conn.timer); this.conn.timer = null; }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this.connHideBanner();
    this.showKickedDialog();
  },

  // 收集当前页/弹窗里已填写的表单内容，供用户在重新登录前复制
  kickedDraftLines() {
    const scopes = [];
    const modal = document.getElementById('modal-overlay');
    if (modal) {
      scopes.push(modal);
    } else {
      const page = document.querySelector('.page-body .data-page') || document.querySelector('.page-body');
      if (page) scopes.push(page);
    }
    const lines = [];
    scopes.forEach(scope => {
      scope.querySelectorAll('.form-group input, .form-group select, .form-group textarea, td input, td select, td textarea')
        .forEach(f => {
          const type = String(f.type || '').toLowerCase();
          if (type === 'password' || type === 'hidden' || type === 'file' || type === 'checkbox' || type === 'radio') return;
          if (f.disabled) return;
          const v = String(f.value == null ? '' : f.value).trim().slice(0, 120);
          if (!v) return;
          const group = f.closest('.form-group');
          let label = group ? String((group.querySelector('label') || {}).textContent || '') : '';
          label = label.replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
          if (!label) label = String(f.getAttribute('placeholder') || f.getAttribute('aria-label') || '').trim();
          lines.push((label ? label + ': ' : '') + v);
        });
    });
    const uniq = Array.from(new Set(lines)).slice(0, 40);
    return uniq;
  },

  // 被挤下线提示：不清空页面、不自动跳转；填单内容以只读文本框列出，便于复制后再登录
  showKickedDialog() {
    if (document.getElementById('kicked-overlay')) return;
    const lines = this.kickedDraftLines();
    const draftHtml = lines.length
      ? `<p class="kicked-note">${this.t('kicked_form_note')}</p>
         <textarea class="kicked-draft" readonly rows="${Math.min(10, lines.length + 1)}"
           onfocus="this.select()">${this.docEsc(lines.join('\n'))}</textarea>`
      : '';
    const el = document.createElement('div');
    el.className = 'modal-overlay kicked-overlay';
    el.id = 'kicked-overlay';
    el.innerHTML = `<div class="modal kicked-modal">
      <div class="modal-header"><span>${this.t('kicked_title')}</span></div>
      <div class="modal-body">
        <p class="kicked-desc">${this.t('kicked_desc')}</p>${draftHtml}
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" id="kicked-view">${this.t('kicked_view_page')}</button>
        <button class="btn btn-primary" id="kicked-relogin">${this.t('kicked_relogin')}</button>
      </div>
    </div>`;
    document.body.appendChild(el);
    document.getElementById('kicked-relogin').onclick = () => this.gotoLogin('kicked');
    // 临时收起提示查看页面（复制/截图），60 秒后自动重新出现
    document.getElementById('kicked-view').onclick = () => {
      el.style.display = 'none';
      setTimeout(() => { if (this.conn.kicked) el.style.display = ''; }, 60000);
    };
  },

  // 主动退出时撤销服务端会话（浏览器正在跳转，用 keepalive 保证请求发得出去）
  revokeSession() {
    if (!this.token) return;
    try {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.token },
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* 忽略：本地状态照常清理 */ }
  },

  // 跳登录页：带上原因与当前页面 hash，登录后回到原页面
  gotoLogin(reason) {
    if (this.conn.timer) { clearInterval(this.conn.timer); this.conn.timer = null; }
    const hash = /^#[a-z]+/.test(location.hash) ? location.hash : '';
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.href = '/login.html?reason=' + encodeURIComponent(reason)
      + (hash ? '&next=' + encodeURIComponent(hash) : '');
  },
});
