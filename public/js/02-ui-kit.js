/**
 * 通用 UI 组件 —— 表格排序、分页、表单校验、空状态、筛选、状态徽章、模态框
 */
Object.assign(App, {
  // ========== 数量输入：界面一律正数，符号由后端推导 ==========
  // 去掉各种减号/负号与非数字字符（覆盖手动输入和粘贴）
  qtySanitize(raw) {
    return String(raw == null ? '' : raw)
      .replace(/[−–—]/g, '-')
      .replace(/[^\d.\-]/g, '')
      .replace(/-/g, '');
  },

  qtyInput(el) {
    if (!el) return '';
    const clean = this.qtySanitize(el.value);
    if (clean !== el.value) el.value = clean;
    return clean;
  },

  // 粘贴时先清洗再写入，避免 type=number 直接吞掉带负号的文本
  qtyPaste(ev) {
    const data = ev.clipboardData || window.clipboardData;
    const txt = data ? data.getData('text') : '';
    ev.preventDefault();
    const el = ev.target;
    el.value = this.qtySanitize(txt);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },

  // 数量必须是纯正数：拒绝 0、负数、空值、多个小数点
  qtyIsValid(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return false;
    return Number(s) > 0;
  },

  // 单价允许 0，不能为负；空值由调用方按 0 处理
  priceIsValid(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return true;
    return /^\d+(\.\d+)?$/.test(s);
  },

  // ========== 数量展示：绝对值 + 方向徽标 ==========
  // 存库符号只用于口径计算，界面一律展示绝对值，方向用 +/− 徽标表示
  qtyAbs(v) {
    const n = Number(v == null ? 0 : v);
    return Number.isFinite(n) ? Math.abs(n) : 0;
  },

  qtyDir(v) {
    const n = Number(v == null ? 0 : v);
    if (!Number.isFinite(n) || n === 0) return '';
    return n > 0 ? '+' : '−';
  },

  qtyDirBadge(v) {
    const dir = this.qtyDir(v);
    if (!dir) return '';
    const cls = dir === '+' ? 'badge-success' : 'badge-danger';
    const title = dir === '+' ? this.t('qty_dir_plus') : this.t('qty_dir_minus');
    return `<span class="badge ${cls}" title="${title}">${dir}</span>`;
  },

  // 表格单元格：绝对值 + 方向徽标
  qtyCell(v) {
    const dir = this.qtyDirBadge(v);
    return `${this.fmtQty(this.qtyAbs(v))}${dir ? ' ' + dir : ''}`;
  },

  // 成本依据徽标：当前均价 / 历史均价 / 无依据（空值不显示）
  costBasisBadge(v) {
    const key = String(v || '');
    if (!key) return '';
    if (key === 'CURRENT_AVG') return `<span class="badge badge-muted">${this.t('cost_basis_current')}</span>`;
    if (key === 'HISTORICAL_AVG') return `<span class="badge badge-warning">${this.t('cost_basis_historical')}</span>`;
    if (key === 'NO_BASIS') return `<span class="badge badge-no-basis" title="${this.t('cost_basis_none_tip')}">${this.t('cost_basis_none')}</span>`;
    return `<span class="badge badge-muted">${key}</span>`;
  },

  // ========== 表格排序 ==========
  // tableState 存储各页面的排序/分页状态: { key: { sortKey, sortDir, page, pageSize } }
  tableStates: {},

  getTableState(tableId) {
    if (!this.tableStates[tableId]) {
      this.tableStates[tableId] = { sortKey: '', sortDir: 'asc', page: 1, pageSize: 15 };
    }
    return this.tableStates[tableId];
  },

  sortData(data, key, dir) {
    if (!key) return data;
    const sorted = [...data].sort((a, b) => {
      let va = a[key], vb = b[key];
      // 数字比较
      if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va;
      // 单号比较：带 -Rn 修订后缀时按数字段比较，保证 -R2 排在 -R10 之前
      if (typeof va === 'string' && typeof vb === 'string' && (/-R\d+$/.test(va) || /-R\d+$/.test(vb))) {
        const c = this.compareDocNoText(va, vb);
        return dir === 'asc' ? c : -c;
      }
      // 尝试数字字符串比较
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb) && String(va).match(/^[\d.]+$/) && String(vb).match(/^[\d.]+$/)) return dir === 'asc' ? na - nb : nb - na;
      // 日期比较
      if (typeof va === 'string' && typeof vb === 'string' && /^\d{4}-\d{2}-\d{2}/.test(va) && /^\d{4}-\d{2}-\d{2}/.test(vb)) return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      // 字符串比较
      va = (va == null ? '' : String(va)).toLowerCase();
      vb = (vb == null ? '' : String(vb)).toLowerCase();
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    return sorted;
  },

  // 单号比较：{主单号, -Rn 修订号}，无后缀的修订号按 0 处理
  compareDocNoText(a, b) {
    const split = v => {
      const s = String(v == null ? '' : v);
      const m = s.match(/^(.*)-R(\d+)$/);
      return m ? { base: m[1], rev: Number(m[2]) } : { base: s, rev: 0 };
    };
    const pa = split(a), pb = split(b);
    const c = pa.base.localeCompare(pb.base);
    return c !== 0 ? c : pa.rev - pb.rev;
  },

  // 修订徽标：单号带 -Rn 后缀时显示「修订 n / Revision n」
  docRevisionBadge(docNo) {
    const m = String(docNo == null ? '' : docNo).match(/-R(\d+)$/);
    if (!m) return '';
    return `<span class="badge badge-info">${this.t('doc_revision', { n: Number(m[1]) })}</span>`;
  },

  // 生成可排序的表头（right=true 时右对齐，与数字列的数据单元格保持一致）
  sortTh(label, key, tableId, right) {
    const st = this.getTableState(tableId);
    const active = st.sortKey === key;
    const arrow = active ? (st.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sort-th ${active ? 'active' : ''}${right ? ' text-right' : ''}" onclick="App.onSort('${tableId}','${key}')">${label}<span class="sort-arrow">${active ? (st.sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span></th>`;
  },

  onSort(tableId, key) {
    const st = this.getTableState(tableId);
    if (st.sortKey === key) {
      st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      st.sortKey = key;
      st.sortDir = 'asc';
    }
    st.page = 1;
    // 触发页面重渲染
    if (this._tableRenderers && this._tableRenderers[tableId]) this._tableRenderers[tableId]();
  },

  // ========== 分页 ==========
  paginate(data, page, pageSize) {
    if (pageSize <= 0) return data;
    const start = (page - 1) * pageSize;
    return data.slice(start, start + pageSize);
  },

  renderPager(tableId, total) {
    const st = this.getTableState(tableId);
    const pageSize = st.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    if (st.page > totalPages) st.page = 1;
    const page = st.page;
    const startIdx = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const endIdx = Math.min(page * pageSize, total);
    const sizes = [10, 15, 20, 50, 0];
    let html = `<div class="pager">
      <span class="pager-info">${startIdx}-${endIdx} / ${total} ${this.t('records')}</span>`;
    // 上一页
    html += `<button class="pager-btn" ${page <= 1 ? 'disabled' : ''} onclick="App.onPage('${tableId}',${page - 1})">‹</button>`;
    // 页码按钮
    let pStart = Math.max(1, page - 2), pEnd = Math.min(totalPages, page + 2);
    if (pStart > 1) { html += `<button class="pager-btn" onclick="App.onPage('${tableId}',1)">1</button>`; if (pStart > 2) html += `<span class="pager-info">...</span>`; }
    for (let i = pStart; i <= pEnd; i++) {
      html += `<button class="pager-btn ${i === page ? 'active' : ''}" onclick="App.onPage('${tableId}',${i})">${i}</button>`;
    }
    if (pEnd < totalPages) { if (pEnd < totalPages - 1) html += `<span class="pager-info">...</span>`; html += `<button class="pager-btn" onclick="App.onPage('${tableId}',${totalPages})">${totalPages}</button>`; }
    // 下一页
    html += `<button class="pager-btn" ${page >= totalPages ? 'disabled' : ''} onclick="App.onPage('${tableId}',${page + 1})">›</button>`;
    // 每页条数
    html += `<span class="pager-size"><select onchange="App.onPageSize('${tableId}',this.value)">`;
    sizes.forEach(s => { html += `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s === 0 ? this.t('all') : s + ' / ' + this.t('page')}</option>`; });
    html += `</select></span></div>`;
    return html;
  },

  // 公共分页条：与入库/出库/退货/盘点/采购同一套标记（.pu-pager），查询中心四个板块复用
  puPagerHtml(tableId, total, totText) {
    const st = this.getTableState(tableId);
    const sizes = [10, 15, 20, 50];
    if (!sizes.includes(st.pageSize)) st.pageSize = 10;
    const tp = Math.max(1, Math.ceil(total / st.pageSize));
    if (st.page > tp) st.page = tp;
    const page = st.page;
    const tot = totText != null ? totText : `${total} ${this.t('records')}`;
    return `<span class="pu-tot">${tot}</span>
      <span>${page} / ${tp} ${this.t('page')}</span>
      <label>${this.t('pageSize')} <select onchange="App.onPageSize('${tableId}',this.value)">${sizes.map(n => `<option value="${n}"${n === st.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.onPage('${tableId}',${page - 1})"${page <= 1 ? ' disabled' : ''}>${this.t('pu_prev')}</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.onPage('${tableId}',${page + 1})"${page >= tp ? ' disabled' : ''}>${this.t('pu_next')}</button>`;
  },

  onPage(tableId, page) {
    const st = this.getTableState(tableId);
    st.page = page;
    if (this._tableRenderers && this._tableRenderers[tableId]) this._tableRenderers[tableId]();
  },

  onPageSize(tableId, size) {
    const st = this.getTableState(tableId);
    st.pageSize = parseInt(size);
    st.page = 1;
    if (this._tableRenderers && this._tableRenderers[tableId]) this._tableRenderers[tableId]();
  },

  // ========== 表单校验 ==========
  // rules: { fieldId: [{ rule: 'required', msg?: '' }, { rule: 'number', msg?: '' }, { rule: 'positive', msg?: '' }] }
  validateForm(rules) {
    let valid = true;
    Object.keys(rules).forEach(fieldId => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      const val = el.value.trim();
      const errorEl = el.parentElement.querySelector('.form-error');
      let errorMsg = '';
      for (const r of rules[fieldId]) {
        if (r.rule === 'required' && !val) { errorMsg = r.msg || this.t('field_required'); break; }
        if (r.rule === 'number' && val && isNaN(parseFloat(val))) { errorMsg = r.msg || this.t('field_number'); break; }
        if (r.rule === 'positive' && val && parseFloat(val) < 0) { errorMsg = r.msg || this.t('field_positive'); break; }
        if (r.rule === 'minlen' && val && val.length < (r.param || 0)) { errorMsg = r.msg || this.t('pwd_min_len'); break; }
      }
      if (errorMsg) {
        el.classList.add('error');
        if (errorEl) { errorEl.textContent = errorMsg; errorEl.classList.add('show'); }
        valid = false;
      } else {
        el.classList.remove('error');
        if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
      }
    });
    return valid;
  },

  // 清除字段错误状态
  clearFieldError(fieldId) {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.classList.remove('error');
    const errorEl = el.parentElement.querySelector('.form-error');
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
  },

  // 设置字段错误状态
  setFieldError(fieldId, msg) {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.classList.add('error');
    const errorEl = el.parentElement.querySelector('.form-error');
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.add('show'); }
  },

  // 生成带 error div 的 form-group（辅助函数）
  formGroup(label, inputHtml, fieldId) {
    return `<div class="form-group"><label>${label}</label>${inputHtml}<div class="form-error" id="${fieldId}_error"></div></div>`;
  },

  // ========== 空状态 ==========
  emptyRow(colSpan) {
    return `<tr><td colspan="${colSpan}" style="text-align:center;padding:40px;color:var(--text-muted)">${this.t('noData')}</td></tr>`;
  },

  // ========== 多关键字模糊筛选 ==========
  // 对数据数组做多关键字 AND 筛选（空格分隔关键字，每条记录需同时包含所有关键字）
  filterByKeywords(data, keywords, fields) {
    if (!keywords || !keywords.trim()) return data;
    const kws = keywords.trim().toLowerCase().split(/\s+/);
    return data.filter(row => {
      const haystack = fields.map(f => String(row[f] == null ? '' : row[f]).toLowerCase()).join(' ');
      return kws.every(kw => haystack.includes(kw));
    });
  },

  // ========== 添加明细：物料即时搜索 ==========
  // 统一入口：候选的取数与过滤只在这里实现，出库/入库/采购单共用。
  // 物料与来源行在打开编辑页时已全量缓存，这里按关键字在本地过滤，按键不产生网络请求；
  // 200ms 防抖合并连续输入，最多渲染 20 条，避免大列表造成卡顿。
  msLimit() { return 20; },

  msDebounceMs() { return 200; },

  msOpen(input, opts) {
    if (!input) return;
    this.msClose();
    this._ms = {
      input, opts: opts || {}, rows: [], active: -1,
      timer: null, composing: false, truncated: false,
    };
    input.setAttribute('autocomplete', 'off');
    // 用 addEventListener 绑定组词事件（内联 oncompositionstart/end 在部分浏览器不生效）
    const st = this._ms;
    st.onCompStart = () => { if (this._ms === st) st.composing = true; };
    st.onCompEnd = () => {
      if (this._ms !== st) return;
      st.composing = false;
      this.msInput(input);
    };
    input.addEventListener('compositionstart', st.onCompStart);
    input.addEventListener('compositionend', st.onCompEnd);
    // 页面内滚动/窗口尺寸变化时收起，避免固定定位浮层脱离输入框
    this._msCloseOnMove = e => {
      if (this._msPanel && e.type === 'scroll' && e.target === this._msPanel) return;
      this.msClose();
    };
    window.addEventListener('scroll', this._msCloseOnMove, true);
    window.addEventListener('resize', this._msCloseOnMove);
    this.msInput(input);
  },

  msInput(input) {
    const st = this._ms;
    if (!st || !input || st.input !== input) return;
    // 中文输入法组词过程中不触发匹配
    if (input.isComposing || st.composing) return;
    clearTimeout(st.timer);
    st.active = -1;
    const kw = String(input.value || '').trim();
    if (!kw) { this.msRender({ hint: true }); return; }
    this.msRender({ loading: true });
    st.timer = setTimeout(() => this.msRender(), this.msDebounceMs());
  },

  msCompositionStart() {
    if (this._ms) this._ms.composing = true;
  },

  msCompositionEnd(input) {
    if (this._ms) this._ms.composing = false;
    this.msInput(input);
  },

  // 唯一过滤入口：materials=物料缓存；lines=采购入库来源采购行
  msCandidates(kw, opts) {
    opts = opts || {};
    const limit = this.msLimit();
    let rows;
    if (opts.mode === 'lines') {
      const src = opts.rows ? opts.rows() : [];
      rows = this.filterByKeywords(src, kw, ['code', 'material_name', 'material_spec', 'material_brand', 'po_no']);
    } else {
      let mats = opts.rows ? opts.rows() : (this._materialsCache || []);
      const cat = opts.category ? opts.category() : '';
      if (cat) mats = mats.filter(m => m.category === cat);
      rows = this.filterByKeywords(mats, kw, ['code', 'name', 'spec', 'brand']);
    }
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
  },

  msStockOf(row, opts) {
    let v;
    if (opts && opts.stockOf) v = opts.stockOf(row.code);
    if (v === undefined || v === null) v = row.on_hand;
    return v === undefined || v === null || v === '' ? null : Number(v);
  },

  msEnsurePanel() {
    if (this._msPanel && document.body.contains(this._msPanel)) return;
    const el = document.createElement('div');
    el.className = 'pu-msearch';
    el.id = 'pu-msearch-panel';
    el.hidden = true;
    document.body.appendChild(el);
    this._msPanel = el;
  },

  msRender(o) {
    o = o || {};
    const st = this._ms;
    if (!st) return;
    this.msEnsurePanel();
    const panel = this._msPanel;
    if (!panel) return;
    const esc = v => this.docEsc(v);
    const t = k => this.t(k);
    panel.hidden = false;

    if (o.hint) {
      panel.innerHTML = `<div class="pu-msearch-state">${t('pu_mat_filter_ph')}</div>`;
      this.msPosition();
      return;
    }
    if (o.loading) {
      panel.innerHTML = `<div class="pu-msearch-state">${t('ms_loading')}</div>`;
      this.msPosition();
      return;
    }
    if (st.opts.sourceReady && !st.opts.sourceReady()) {
      st.rows = [];
      panel.innerHTML = `<div class="pu-msearch-state">${t('ms_source_first')}</div>`;
      this.msPosition();
      return;
    }

    const kw = String((st.input && st.input.value) || '').trim();
    const res = this.msCandidates(kw, st.opts);
    st.rows = res.rows;
    st.truncated = res.truncated;
    if (!st.rows.length) {
      panel.innerHTML = `<div class="pu-msearch-state">${t('ms_none')}</div>`;
      this.msPosition();
      return;
    }

    const isLines = st.opts.mode === 'lines';
    const items = st.rows.map((r, i) => {
      const name = isLines ? (r.material_name || r.name || '') : (r.name || '');
      const spec = isLines ? (r.material_spec || r.spec || '') : (r.spec || '');
      const brand = isLines ? (r.material_brand || '') : (r.brand || '');
      const unit = isLines ? (r.material_unit || r.unit || '') : (r.unit || '');
      // 规格与品牌拼接展示；品牌为空时不产生多余分隔符
      const specBrand = [spec, brand].filter(Boolean).join(' · ');
      const stock = this.msStockOf(r, st.opts);
      const stockColor = stock === null ? 'var(--text-muted)'
        : (stock < 0 ? 'var(--num-neg)' : (stock === 0 ? 'var(--num-zero)' : 'var(--num-pos)'));
      const added = !!(st.opts.isAdded && st.opts.isAdded(r));
      const unrec = isLines && r.unreceived_qty !== undefined && r.unreceived_qty !== null
        ? `<span class="pu-msearch-unrec">${t('ibd_unreceived')} ${this.fmtQty(r.unreceived_qty)}</span>` : '';
      return `<div class="pu-msearch-item${i === st.active ? ' active' : ''}${added ? ' is-added' : ''}" data-idx="${i}"
        onmousedown="event.preventDefault();App.msPickIdx(${i})">
        <span class="pu-msearch-code">${esc(r.code)}</span>
        <span class="pu-msearch-name">${esc(name)}</span>
        <span class="pu-msearch-spec">${esc(specBrand)}</span>
        <span class="pu-msearch-unit">${esc(unit)}</span>
        <span class="pu-msearch-stock" style="color:${stockColor}">${stock === null ? '-' : this.fmtQty(stock)}${unit ? ' ' + esc(unit) : ''}</span>
        ${unrec}
        ${added ? `<span class="pu-msearch-added">${t('ms_added')}</span>` : ''}
      </div>`;
    }).join('');
    const trunc = st.truncated
      ? `<div class="pu-msearch-trunc">${t('ms_truncated', { n: this.msLimit() })}</div>` : '';
    panel.innerHTML = items + trunc;
    this.msPosition();
  },

  // 固定定位：不随 .page-body 的 overflow 被裁切；下方空间不足时向上翻
  msPosition() {
    const st = this._ms, panel = this._msPanel;
    if (!st || !panel || panel.hidden) return;
    const r = st.input.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 380), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    panel.style.width = width + 'px';
    panel.style.left = left + 'px';
    panel.style.maxHeight = '320px';
    const h = panel.offsetHeight || 0;
    const below = vh - r.bottom - 8;
    let top = r.bottom + 4;
    if (h > below && r.top - 8 > below) top = Math.max(8, r.top - 4 - h);
    panel.style.top = top + 'px';
    panel.style.maxHeight = Math.min(320, Math.max(120, vh - top - 8)) + 'px';
  },

  msHighlight() {
    const st = this._ms, panel = this._msPanel;
    if (!st || !panel) return;
    panel.querySelectorAll('.pu-msearch-item').forEach((el, i) => {
      el.classList.toggle('active', i === st.active);
    });
    const cur = panel.querySelector('.pu-msearch-item.active');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  },

  msKey(e) {
    const st = this._ms;
    if (!st || st.input !== e.target) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // 避免冒泡触发页面/弹层的全局 Esc 关闭
      this.msClose();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!st.rows.length) return;
      e.preventDefault();
      const n = st.rows.length;
      st.active = e.key === 'ArrowDown' ? (st.active + 1) % n : (st.active - 1 + n) % n;
      this.msHighlight();
      return;
    }
    if (e.key === 'Enter') {
      if (e.isComposing || st.composing) return;
      if (st.active < 0 || !st.rows[st.active]) return;
      e.preventDefault();
      this.msPick(st.rows[st.active]);
    }
  },

  msPickIdx(idx) {
    const st = this._ms;
    if (!st) return;
    const row = st.rows[idx];
    if (row) this.msPick(row);
  },

  msPick(row) {
    const st = this._ms;
    if (!st || !row) return;
    const opts = st.opts;
    // 先收起并清空，再让调用方重渲染，避免新输入框回填旧关键字
    this.msClose();
    if (st.input) st.input.value = '';
    this._msSuppressFocus = true;
    setTimeout(() => { this._msSuppressFocus = false; }, 300);
    if (opts.onPick) opts.onPick(row);
  },

  msBlur() {
    const st = this._ms;
    if (!st) return;
    clearTimeout(st.blurTimer);
    st.blurTimer = setTimeout(() => { if (this._ms === st) this.msClose(); }, 150);
  },

  msClose() {
    const st = this._ms;
    if (st) {
      clearTimeout(st.timer);
      clearTimeout(st.blurTimer);
      if (st.input && st.onCompStart) {
        st.input.removeEventListener('compositionstart', st.onCompStart);
        st.input.removeEventListener('compositionend', st.onCompEnd);
      }
    }
    if (this._msCloseOnMove) {
      window.removeEventListener('scroll', this._msCloseOnMove, true);
      window.removeEventListener('resize', this._msCloseOnMove);
      this._msCloseOnMove = null;
    }
    if (this._msPanel) {
      this._msPanel.remove();
      this._msPanel = null;
    }
    this._ms = null;
  },

  // ========== 日期段筛选 ==========
  // 对数据按日期字段做范围筛选（from/to 均为可选，格式 YYYY-MM-DD）
  filterByDateRange(data, dateField, from, to) {
    if (!from && !to) return data;
    return data.filter(row => {
      const d = String(row[dateField] || '').slice(0, 10);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  },

  // 生成表格行操作列（编辑/删除链接，按权限显隐）
  rowActions(module, editCall, deleteCall) {
    let html = '';
    if (this.can(module, 'edit')) html += `<span class="action-link" onclick="${editCall}">${this.t('edit')}</span>`;
    if (this.can(module, 'delete')) html += `<span class="action-link danger" onclick="${deleteCall}">${this.t('delete')}</span>`;
    return html;
  },

  // 生成表格上方工具栏（新增按钮 + 关键字筛选框 + 可选日期段筛选）
  renderTableToolbar(filterId, filterOnInput, addBtnHtml, dateFilter) {
    let dateHtml = '';
    if (dateFilter) {
      dateHtml = `<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <input id="${dateFilter.fromId}" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="${dateFilter.onChange}" value="${dateFilter.fromVal || ''}">
        <span style="color:var(--text-muted);font-size:12px">~</span>
        <input id="${dateFilter.toId}" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="${dateFilter.onChange}" value="${dateFilter.toVal || ''}">
      </div>`;
    }
    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div>${addBtnHtml || ''}</div>
      <div class="form-group" style="flex:1;max-width:400px;margin:0;margin-rigth:auto">
        <input id="${filterId}" type="text" placeholder="${this.t('quick_filter_ph')}" oninput="${filterOnInput}" style="width:100%">
      </div>
      ${dateHtml}
    </div>`;
  },

  // 恢复筛选框的值和焦点（innerHTML 重设后调用）
  restoreFilter(filterId, value) {
    const el = document.getElementById(filterId);
    if (el) {
      el.value = value;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    }
  },

  // 全站统一金额格式：人民币符号（¥）+ 千分位 + 固定 2 位小数
  // 负数写法统一为 -¥5.00（负号在货币符号之前）；中英文界面同一口径，不再区分 CNY/¥
  fmtMoney(v) {
    if (v == null || isNaN(v)) return '-';
    const n = Number(v);
    const s = Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-¥' : '¥') + s;
  },
  // 业务日期（date 列，日历日，不做时区换算）
  fmtDate(d) { if (!d) return ''; return String(d).slice(0, 10); },
  // 本机日历日期 YYYY-MM-DD（业务日期默认值；不要用 toISOString，那是 UTC 日期）
  today() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
  // 解析数据库里的 UTC 时刻（"YYYY-MM-DD HH:MM:SS"，无时区标记）为 Date
  parseUtc(s) {
    if (!s) return null;
    const t = String(s).trim();
    if (!t) return null;
    const iso = /[TZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  },
  // 时刻显示：库里存 UTC → 按浏览器本地时区渲染（不同时区的人看到各自本地时间）
  fmtDateTime(s, withSeconds) {
    const d = this.parseUtc(s);
    if (!d) return '';
    const p = n => String(n).padStart(2, '0');
    let out = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    if (withSeconds) out += ':' + p(d.getSeconds());
    return out;
  },
  // 读取 CSS 变量：图表等 Canvas 场景无法直接用 var()
  cssVar(name, fallback = '') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  },
  chartTextColor() { return this.cssVar('--chart-text') || (this.theme === 'dark' ? '#94a3b8' : '#6b7280'); },
  chartGridColor() { return this.cssVar('--chart-grid') || (this.theme === 'dark' ? 'rgba(51,65,85,0.3)' : 'rgba(229,231,235,0.5)'); },

  // ========== 单据打印 / 导出（通用） ==========
  // 各业务模块只需把单据数据组装成 doc，无需关心打印/导出细节：
  //   doc = {
  //     title,                 // 单据号（打印标题）
  //     subtitle,              // 单据类型文案
  //     meta: [[label, value]],// 单据头字段
  //     columns: [{ label, key?, value?(row), align?: 'right' }],
  //     rows: [],              // 明细行（原始数据，由 columns 决定展示哪些字段）
  //     filename?,             // 导出文件名，默认取 title
  //   }

  docEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // 取单元格文本：优先 value(row) 函数，其次 row[key]
  docCell(row, col) {
    const v = typeof col.value === 'function' ? col.value(row) : row[col.key];
    return v == null ? '' : String(v);
  },

  // 打印专用 HTML（单据头 + 明细表，表头跨页重复、明细行不跨页断裂）
  buildDocPrintHtml(doc) {
    const esc = v => this.docEsc(v);
    const cols = doc.columns || [];
    const rows = doc.rows || [];
    const head = cols.map(c => `<th${c.align === 'right' ? ' class="text-right"' : ''}>${esc(c.label)}</th>`).join('');
    const body = rows.length
      ? rows.map(r => `<tr>${cols.map(c => `<td${c.align === 'right' ? ' class="text-right"' : ''}>${esc(this.docCell(r, c))}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length || 1}" class="doc-empty">${esc(this.t('noData'))}</td></tr>`;
    const meta = (doc.meta || []).filter(m => m && m[0] != null);
    const metaHtml = meta.length
      ? `<dl class="doc-meta">${meta.map(m => `<div><dt>${esc(m[0])}</dt><dd>${esc(m[1])}</dd></div>`).join('')}</dl>` : '';
    return `<!DOCTYPE html><html lang="${this.lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<title>${esc(doc.title || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",Arial,sans-serif;color:#1e293b;font-size:12px;margin:0}
  .doc-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;border-bottom:2px solid #1e3a8a;padding-bottom:8px;margin-bottom:14px}
  .doc-title{font-size:20px;font-weight:700;line-height:1.3}
  .doc-sub{color:#64748b;font-size:12px;margin-top:2px}
  .doc-time{color:#64748b;font-size:11px;white-space:nowrap}
  .doc-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 18px;margin:0 0 16px;padding:0}
  .doc-meta>div{display:flex;gap:6px;min-width:0}
  .doc-meta dt{color:#64748b;margin:0;white-space:nowrap}
  .doc-meta dd{margin:0;font-weight:600;overflow-wrap:anywhere}
  table{width:100%;border-collapse:collapse}
  thead{display:table-header-group}
  tr{page-break-inside:avoid}
  th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}
  th{background:#f1f5f9;font-weight:700}
  tbody tr:nth-child(even) td{background:#fafbfd}
  .text-right{text-align:right;font-variant-numeric:tabular-nums}
  .doc-empty{text-align:center;color:#94a3b8;padding:24px}
  @page{margin:14mm${doc.landscape ? ';size:A4 landscape' : ''}}
</style></head><body>
  <div class="doc-head">
    <div><div class="doc-title">${esc(doc.title || '')}</div>${doc.subtitle ? `<div class="doc-sub">${esc(doc.subtitle)}</div>` : ''}</div>
    <div class="doc-time">${esc(this.t('doc_print_time'))} ${esc(this.fmtDateTime(new Date().toISOString()))}</div>
  </div>
  ${metaHtml}
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
  },

  // 打印单据：用隐藏 iframe 打印，避免 window.open 被浏览器拦截
  printDoc(doc) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    const fdoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
    if (!fdoc) { frame.remove(); return false; }
    fdoc.open(); fdoc.write(this.buildDocPrintHtml(doc)); fdoc.close();
    const cleanup = () => { try { frame.remove(); } catch (_) {} };
    setTimeout(() => {
      try {
        const w = frame.contentWindow;
        if (w.addEventListener) w.addEventListener('afterprint', cleanup);
        w.focus(); w.print();
      } catch (_) {}
      setTimeout(cleanup, 30000); // 兜底：个别浏览器不触发 afterprint
    }, 200);                      // 等排版完成
    return true;
  },

  // CSV 单元格转义（含逗号/引号/换行时加引号）
  csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  },

  // 导出 CSV：单据头信息 + 明细行，UTF-8 BOM 保证 Excel 中文不乱码
  exportDocCsv(doc) {
    const cols = doc.columns || [];
    const rows = doc.rows || [];
    const out = [];
    (doc.meta || []).forEach(m => { if (m && m[0] != null) out.push(this.csvCell(m[0]) + ',' + this.csvCell(m[1])); });
    out.push('');
    out.push(cols.map(c => this.csvCell(c.label)).join(','));
    rows.forEach(r => out.push(cols.map(c => this.csvCell(this.docCell(r, c))).join(',')));
    const blob = new Blob(['\ufeff' + out.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.filename || ((doc.title || 'export') + '.csv');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  },

  // ========== 模态框 ==========
  showModal(title, bodyHtml, btnText, onConfirm, onCancel, large) {
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'modal-overlay';
    const modalClass = large ? 'modal modal-lg' : 'modal';
    overlay.innerHTML = `<div class="${modalClass}"><div class="modal-header">${title}<button class="modal-close" id="modal-close-btn">&times;</button></div><div class="modal-body">${bodyHtml}</div><div class="modal-footer"><button class="btn btn-outline" id="modal-cancel-btn">${this.t('cancel')}</button><button class="btn btn-primary" id="modal-confirm-btn">${btnText}</button></div></div>`;
    document.body.appendChild(overlay);
    const doCancel = () => { this.closeModal(); if (onCancel) onCancel(); };
    document.getElementById('modal-close-btn').onclick = doCancel;
    document.getElementById('modal-cancel-btn').onclick = doCancel;
    overlay.addEventListener('click', e => { if (e.target === overlay) doCancel(); });
    document.getElementById('modal-confirm-btn').onclick = onConfirm;
  },

  closeModal() { const el = document.getElementById('modal-overlay'); if (el) el.remove(); }
});

undefined
