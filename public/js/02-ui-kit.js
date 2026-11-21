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

  // 数量 + 单位后缀：宽屏整表与窄栏统一走这里，保证单位只出现一次
  qtyWithUnit(v, unit) {
    const u = String(unit == null ? '' : unit).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    return `${this.fmtQty(v)}${u ? ' ' + u : ''}`;
  },

  // 纯文本数量 + 单位：打印 / CSV 用，不能带 HTML 徽标
  qtyUnitText(v, unit) {
    const u = unit == null ? '' : String(unit);
    return `${this.fmtQty(v)}${u ? ' ' + u : ''}`;
  },

  // 数量列名按单据类型取名：退货/退库不再借用入库、出库数量
  docQtyLabel(type) {
    const k = String(type || '');
    if (k === '采购退货' || k === '零星退货') return this.t('ret_qty_return');
    if (k === '领料退库') return this.t('ret_qty_stock');
    if (k === '采购入库' || k === '零星入库') return this.t('in_qty');
    if (k === '正常出库') return this.t('out_qty');
    return this.t('ret_qty');
  },

  // 成本依据徽标：当前均价 / 历史均价 / 无依据（空值不显示）
  costBasisBadge(v) {
    const key = String(v || '');
    if (!key) return '';
    if (key === 'CURRENT_AVG') return `<span class="badge badge-muted">${this.t('cost_basis_current')}</span>`;
    if (key === 'HISTORICAL_AVG') return `<span class="badge badge-warning">${this.t('cost_basis_historical')}</span>`;
    if (key === 'NO_BASIS') return `<span class="badge badge-no-basis" title="${this.t('cost_basis_none_tip')}">${this.t('cost_basis_none')}</span>`;
    return `<span class="badge badge-muted">${this.docEsc(key)}</span>`;
  },

  // ========== 表格排序 ==========
  // tableState 存储各页面的排序/分页状态: { key: { sortKey, sortDir, page, pageSize } }
  tableStates: {},

  getTableState(tableId) {
    if (!this.tableStates[tableId]) {
      this.tableStates[tableId] = { sortKey: '', sortDir: 'asc', page: 1, pageSize: 15 };
    }
    // 统一每页条数白名单：历史数据里若有旧的 10/50 以外的非法值，回落到 15
    if (![10, 15, 20, 50, 0].includes(this.tableStates[tableId].pageSize)) {
      this.tableStates[tableId].pageSize = 15;
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

  // 单据状态徽标：kind 决定「状态 → i18n 键」映射，各模块原有映射与兜底规则保持不变
  // kind: ibd 入库 / obd 出库 / pu_order 采购单 / pu_contract 合同 / st 盘点 / ret 退货
  docStatusBadge(kind, status) {
    if (kind === 'pu_contract') {
      const active = !status || status === 'active';
      return `<span class="badge badge-${active ? 'success' : 'muted'}"><span aria-hidden="true">${active ? '●' : '■'}</span>&nbsp;${active ? this.t('pu_status_active') : this.t('pu_status_closed_c')}</span>`;
    }
    const maps = {
      ibd: { draft: 'ibd_status_draft', posted: 'ibd_status_posted', voided: 'ibd_status_voided' },
      obd: { draft: 'obd_status_draft', posted: 'obd_status_posted', voided: 'ibd_status_voided' },
      pu_order: { draft: 'pu_status_draft', posted: 'pu_status_posted', cancelled: 'pu_status_cancelled' },
      st: { draft: 'st_status_draft', confirmed: 'st_status_confirmed' },
      ret: { draft: 'ibd_status_draft', posted: 'ibd_status_posted', voided: 'ibd_status_voided' },
    };
    const label = (maps[kind] || {})[status];
    const cls = this.docStatusMeta(status).cls;
    if (label) return `<span class="badge ${cls}">${this.t(label)}</span>`;
    // 未映射状态：采购单沿用「已确认」，其余按原文显示
    return `<span class="badge ${cls}">${kind === 'pu_order' ? this.t('pu_status_posted') : this.docEsc(status)}</span>`;
  },

  // 生成可排序的表头：align=true/'right' 数字列右对齐，'center' 状态/类型/操作列居中，
  // 其余（文本、日期时间）左对齐，与数据单元格保持同一套规则
  sortTh(label, key, tableId, align) {
    const st = this.getTableState(tableId);
    const active = st.sortKey === key;
    const cls = this.colAlignClass(align);
    const ariaSort = active ? (st.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="sort-th ${active ? 'active' : ''}${cls ? ' ' + cls : ''}" tabindex="0" aria-sort="${ariaSort}" onclick="App.onSort('${tableId}','${key}')" onkeydown="App.onSortKey(event,'${tableId}','${key}')">${label}<span class="sort-arrow">${active ? (st.sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span></th>`;
  },

  // 列对齐统一的唯一入口：数字→右，徽标/状态/操作→居中，文本与日期→左
  colAlignClass(align) {
    if (align === true || align === 'right') return 'text-right';
    if (align === 'center') return 'text-center';
    return '';
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

  onSortKey(e, tableId, key) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.onSort(tableId, key);
  },

  // ========== 分页 ==========
  paginate(data, page, pageSize) {
    if (pageSize <= 0) return data;
    const start = (page - 1) * pageSize;
    return data.slice(start, start + pageSize);
  },

  // 全站唯一分页条：普通列表、单据列表、查询中心共用同一套视觉与行为
  // renderPager 仅负责把「起止条数」格式化成 totText，实际标记全部由 puPagerHtml 产出
  renderPager(tableId, total) {
    const st = this.getTableState(tableId);
    const pages = st.pageSize === 0 ? 1 : Math.max(1, Math.ceil(total / st.pageSize));
    if (st.page > pages) st.page = pages;
    if (st.page < 1) st.page = 1;
    const start = total === 0 ? 0 : (st.page - 1) * st.pageSize + 1;
    const end = st.pageSize === 0 ? total : Math.min(st.page * st.pageSize, total);
    return this.puPagerHtml(tableId, total, `${start}-${end} / ${total} ${this.t('records')}`);
  },

  // opts.ns      模块事件委托前缀（如 'ib' → data-ib="pg" data-id="-1"，select id="ib-psz"）
  // opts.selId   仅为每页条数 select 指定 id（不接 onchange，由调用方自行绑定）
  // opts.pgClick 翻页走指定全局方法（如 'retPage' → onclick="App.retPage(-1)"）
  // opts.hideEmpty 总数为 0 时不输出分页条
  puPagerHtml(tableId, total, totText, opts) {
    const st = this.getTableState(tableId);
    const sizes = [10, 15, 20, 50, 0];
    const all = st.pageSize === 0;
    const tp = all ? 1 : Math.max(1, Math.ceil(total / st.pageSize));
    if (st.page > tp) st.page = tp;
    if (st.page < 1) st.page = 1;
    // 记录总数：翻页时据此夹住越界页码，避免连点/键盘触发到空页
    this._tableTotals = this._tableTotals || {};
    this._tableTotals[tableId] = total;
    if (opts && opts.hideEmpty && !total) return '';
    const page = st.page;
    const tot = totText != null ? totText : `${total} ${this.t('records')}`;
    const o = opts || {};
    const selId = o.selId || (o.ns ? `${o.ns}-psz` : '');
    const selAttr = selId ? ` id="${selId}"` : ` onchange="App.onPageSize('${tableId}',this.value)"`;
    // 事件层沿用各模块既有的 delta 语义；数字页码换算成相对当前页的 delta，
    // 因此无需改动任何模块的分页事件处理函数。
    const pgBtn = (target, label, active, disabled) => {
      const delta = target - page;
      const act = o.ns ? `data-${o.ns}="pg" data-id="${delta}"`
        : o.pgClick ? `onclick="App.${o.pgClick}(${delta})"`
        : `onclick="App.onPage('${tableId}',${target})"`;
      return `<button type="button" class="btn btn-outline btn-sm${active ? ' active' : ''}" ${act}${disabled ? ' disabled' : ''}>${label}</button>`;
    };
    let nums = '';
    // 可见数字页码控制在最多 5 个（首页 + 当前页±1 + 末页），避免页码条过长。
    // 当前页靠近两端时窗口向内收缩，始终保证 5 个以内且首尾可达。
    if (tp <= 5) {
      for (let i = 1; i <= tp; i++) nums += pgBtn(i, i, i === page, false);
    } else {
      let pStart = Math.max(2, page - 1), pEnd = Math.min(tp - 1, page + 1);
      // 窗口固定占 3 个中间位：靠左/靠右时平移窗口，保证中间始终 3 个
      if (page <= 2) { pStart = 2; pEnd = 4; }
      else if (page >= tp - 1) { pStart = tp - 3; pEnd = tp - 1; }
      // 首页
      nums += pgBtn(1, 1, false, false);
      if (pStart > 2) nums += `<span class="pu-pager-gap">…</span>`;
      for (let i = pStart; i <= pEnd; i++) nums += pgBtn(i, i, i === page, false);
      if (pEnd < tp - 1) nums += `<span class="pu-pager-gap">…</span>`;
      // 末页
      nums += pgBtn(tp, tp, false, false);
    }
    return `<span class="pu-tot">${tot}</span>
      <span>${page} / ${tp} ${this.t('page')}</span>
      <label>${this.t('pageSize')} <select${selAttr}>${sizes.map(n => `<option value="${n}"${n === st.pageSize ? ' selected' : ''}>${n === 0 ? this.t('all') : n + ' / ' + this.t('page')}</option>`).join('')}</select></label>
      ${pgBtn(page - 1, this.t('pu_prev'), false, all || page <= 1)}
      ${nums}
      ${pgBtn(page + 1, this.t('pu_next'), false, all || page >= tp)}`;
  },

  // 只有内容超出视口时才把分页条吸附到底部；内容不足一屏时随内容排在末尾
  pinPager(boxId) {
    const pb = document.querySelector('.page-body');
    const pager = document.getElementById(boxId);
    if (!pb || !pager) return;
    pager.classList.toggle('pin', pb.scrollHeight > pb.clientHeight + 2);
  },

  // 每页条数统一解析：0 表示「全部」，非法值回落 15
  normalizePageSize(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 && [10, 15, 20, 50, 0].includes(n) ? n : 15;
  },

  onPage(tableId, page) {
    const st = this.getTableState(tableId);
    if (st.pageSize === 0) { st.page = 1; }
    else {
      const total = this._tableTotals ? this._tableTotals[tableId] : null;
      const tp = total == null ? null : Math.max(1, Math.ceil(total / st.pageSize));
      st.page = tp == null ? Math.max(1, page) : Math.min(Math.max(1, page), tp);
    }
    if (this._tableRenderers && this._tableRenderers[tableId]) this._tableRenderers[tableId]();
  },

  onPageSize(tableId, size) {
    const st = this.getTableState(tableId);
    st.pageSize = this.normalizePageSize(size);
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

  // 校验失败定位：滚动到字段、高亮闪烁并弹 toast，避免"点了没反应"
  flagFieldError(fieldId, msg) {
    const el = document.getElementById(fieldId);
    const box = el ? (el.closest('.form-group') || el) : null;
    if (box) {
      box.classList.remove('field-flash');
      void box.offsetWidth; // 重置动画，连续点击也能再次闪烁
      box.classList.add('field-flash');
      if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (_) {} }
      if (this._fieldFlashTimer) clearTimeout(this._fieldFlashTimer);
      this._fieldFlashTimer = setTimeout(() => box.classList.remove('field-flash'), 1800);
    }
    if (msg) this.toast(msg, 'error');
  },

  // ========== 空状态 ==========
  // 表格内空行：colSpan 必填；text 默认「暂无数据」；opts.pad 指定内联留白（px），opts.cls 改用样式类
  emptyRow(colSpan, text, opts) {
    const o = opts || {};
    const body = text != null ? text : this.t('noData');
    const attr = o.cls ? ` class="${o.cls}"` : ` style="text-align:center;padding:${o.pad == null ? 40 : o.pad}px;color:var(--text-muted)"`;
    return `<tr><td colspan="${colSpan}"${attr}>${body}</td></tr>`;
  },

  // 区块空态：opts.icon 为图标字符（可选），opts.pad 为上下留白 px（可选，默认沿用样式表）
  emptyState(text, opts) {
    const o = opts || {};
    const pad = o.pad != null ? ` style="padding:${o.pad}px"` : '';
    const icon = o.icon ? `<div class="empty-state-icon">${o.icon}</div>` : '';
    return `<div class="empty-state"${pad}>${icon}<p>${text}</p></div>`;
  },

  // ========== 多关键字模糊筛选 ==========
  // 规则与后端 server/utils/search.js 一致：空格分词、词间 AND、不区分大小写
  matchKeywords(values, keywords) {
    if (!keywords || !String(keywords).trim()) return true;
    const kws = String(keywords).trim().toLowerCase().split(/\s+/);
    const haystack = values.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
    return kws.every(kw => haystack.includes(kw));
  },

  // 对数据数组做多关键字 AND 筛选（每条记录需同时包含所有关键字）
  filterByKeywords(data, keywords, fields) {
    if (!keywords || !keywords.trim()) return data;
    return data.filter(row => this.matchKeywords(fields.map(f => row[f]), keywords));
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
    const t = (k, vars) => this.t(k, vars);
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
        <span class="pu-msearch-name" title="${esc(name)}">${esc(name)}</span>
        <span class="pu-msearch-spec" title="${esc(specBrand)}">${esc(specBrand)}</span>
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
    const margin = 8;
    const maxW = Math.max(160, vw - margin * 2);
    // 面板按内容自适应：离屏克隆一份、改用 max-content 量自然宽度（.pu-msearch-probe
    // 里各段不参与弹性收缩），再夹到 [输入框宽, 视口宽-16]。至少与输入框同宽。
    const probe = panel.cloneNode(true);
    probe.style.cssText = '';
    probe.removeAttribute('hidden');
    probe.classList.add('pu-msearch-probe');
    document.body.appendChild(probe);
    // 真实面板预留了滚动条槽（scrollbar-gutter: stable），把多出的那部分补进自然宽度，避免出竖条时被挤压
    const chromeDelta = (panel.offsetWidth - panel.clientWidth) - (probe.offsetWidth - probe.clientWidth);
    const natural = Math.ceil(probe.getBoundingClientRect().width) + Math.max(0, chromeDelta);
    probe.remove();
    const width = Math.min(Math.max(natural, Math.ceil(r.width)), maxW);
    panel.style.width = width + 'px';
    panel.style.maxWidth = '';
    // 右侧放不下时向内收，始终保留 8px 边距
    const left = Math.min(Math.max(margin, r.left), vw - margin - width);
    panel.style.left = Math.round(left) + 'px';
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

  // 清除表格关键字筛选：清空后派发 input 事件，复用各页面已有的筛选处理逻辑
  clearTableFilter(filterId) {
    const el = document.getElementById(filterId);
    if (!el) return;
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
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
      <div class="form-group" style="flex:1;max-width:400px;margin:0;margin-right:auto">
        <input id="${filterId}" type="text" placeholder="${this.t('quick_filter_ph')}" oninput="${filterOnInput}" style="width:100%">
      </div>
      <button type="button" class="btn btn-outline btn-sm" onclick="App.clearTableFilter('${filterId}')" title="${this.t('pu_clear_filter')}">${this.icon('close', 'icon--tool')} ${this.t('pu_clear_filter')}</button>
      ${dateHtml}
    </div>`;
  },

  // 全站统一金额格式：人民币符号（¥）+ 千分位 + 固定 2 位小数
  // 负数写法统一为 -¥5.00（负号在货币符号之前）；中英文界面同一口径，不再区分 CNY/¥
  fmtMoney(v) {
    if (v == null || isNaN(v)) return '-';
    const n = Number(v);
    const s = Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-¥' : '¥') + s;
  },
  // 单价输入框显示：固定两位小数，规避浮点尾数（如 112.30000305175781）
  fmtPrice2(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    return isNaN(n) ? '' : n.toFixed(2);
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
  // 单据业务日期（显示到分钟）：date 列本身只有日历日粒度（YYYY-MM-DD），
  // 不伪造 00:00；有真实操作时刻时直接用该时刻——已过账/已确认优先 confirmed_at，
  // 否则用 created_at；两者都没有才回退到业务日期。中英文共用同一数字格式。
  fmtDocDate(date, createdAt, confirmedAt) {
    return this.fmtDateTime(confirmedAt) || this.fmtDateTime(createdAt) || this.fmtDate(date);
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
  //     signatures?,           // 签字栏标签数组，如 ['盘点人','复核人','日期']
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
      : this.emptyRow(cols.length || 1, esc(this.t('noData')), { cls: 'doc-empty' });
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
  .doc-sign{display:flex;flex-wrap:wrap;gap:20px 48px;margin-top:30px;font-size:12px;color:#334155}
  .doc-sign span{display:inline-flex;align-items:flex-end;gap:6px}
  .doc-sign i{display:inline-block;width:130px;height:16px;border-bottom:1px solid #94a3b8}
  @page{margin:14mm${doc.landscape ? ';size:A4 landscape' : ''}}
</style></head><body>
  <div class="doc-head">
    <div><div class="doc-title">${esc(doc.title || '')}</div>${doc.subtitle ? `<div class="doc-sub">${esc(doc.subtitle)}</div>` : ''}</div>
    <div class="doc-time">${esc(this.t('doc_print_time'))} ${esc(this.fmtDateTime(new Date().toISOString()))}</div>
  </div>
  ${metaHtml}
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  ${(doc.signatures && doc.signatures.length) ? `<div class="doc-sign">${doc.signatures.map(l => `<span>${esc(l)}：<i></i></span>`).join('')}</div>` : ''}
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
  // 同时防公式注入：Excel/WPS 把 = + - @ 及前导空白后的这些字符当公式。
  // 纯数值（含合法负数）保持原样以免影响金额/数量列，其余文本前置单引号按文本解析。
  csvCell(v) {
    const s = v == null ? '' : String(v);
    const isNum = s !== '' && Number.isFinite(Number(s));
    const safe = !isNum && /^[\s]*[=+\-@]/.test(s) ? "'" + s : s;
    return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
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

  // ========== 详情卡明细：小卡只展示前 N 行，「查看全部」进入大卡 ==========
  // 形态对齐查询中心详情卡「流水」的折叠态：只显示前 5 行 + 「查看全部（共 X 条）」。
  // 点击后不再原地撑长小卡，而是切到该模块的宽屏大卡（与 ⤢ 同一渲染路径）。
  DOC_LINES_LIMIT: 5,

  // 小卡固定只展示前 N 行
  docLinesShown(scope, total) {
    return Math.min(this.DOC_LINES_LIMIT, total);
  },

  // 折叠态按钮；行数不超过阈值时不渲染
  docLinesToggleHtml(scope, total) {
    if (!(total > this.DOC_LINES_LIMIT)) return '';
    return `<button type="button" class="btn btn-outline btn-sm pu-more" data-doc-lines="${scope}" onclick="App.docLinesViewAll('${scope}')">${this.t('q_view_all_count', { n: total })}</button>`;
  },

  // 进入该模块的宽屏大卡（各模块注册的回调里统一设置 wide + dt=lines 并重渲染）
  docLinesViewAll(scope) {
    const fn = this._docLinesViewAll && this._docLinesViewAll[scope];
    if (fn) fn();
  },

  // 各模块注册「进入大卡」动作，保证「查看全部」与 ⤢ 指向同一目标
  docLinesBind(scope, viewAll) {
    this._docLinesViewAll = this._docLinesViewAll || {};
    this._docLinesViewAll[scope] = viewAll;
  },

  // ========== 键盘与焦点 ==========
  focusableSelector: 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',

  // 弹层统一键盘处理：Esc 取消、Tab 在弹层内循环
  onDialogKeydown(e, container, allowEscape, onEscape) {
    if (e.key === 'Escape' && allowEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = Array.from(container.querySelectorAll(this.focusableSelector))
      .filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  },

  // ========== 未保存提醒：快照 / 脏检测 ==========
  // 编辑页根：只有这些长表单才做离开确认，列表筛选框不会被误判为“未保存”
  EDIT_PAGE_ROOTS: ['#ib-new-root', '#ib-edit-root', '#ob-edit-form', '#pu-edit-root', '#st-edit-root'],

  findEditRoot() {
    for (const sel of this.EDIT_PAGE_ROOTS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  },

  collectFormSnapshot(root) {
    if (!root) return null;
    const out = {};
    root.querySelectorAll('input, select, textarea').forEach((el, i) => {
      const type = String(el.type || '').toLowerCase();
      if (type === 'hidden' || type === 'password' || type === 'file' || el.disabled) return;
      const key = el.id || el.name || ('__i' + i);
      out[key] = (type === 'checkbox' || type === 'radio') ? { checked: !!el.checked } : { value: el.value };
    });
    return out;
  },

  isFormDirty(snapshot, root) {
    if (!snapshot || !root) return false;
    let dirty = false;
    root.querySelectorAll('input, select, textarea').forEach((el, i) => {
      if (dirty) return;
      const type = String(el.type || '').toLowerCase();
      if (type === 'hidden' || type === 'password' || type === 'file' || el.disabled) return;
      const key = el.id || el.name || ('__i' + i);
      const prev = snapshot[key];
      if (!prev) return;
      if (type === 'checkbox' || type === 'radio') dirty = !!el.checked !== !!prev.checked;
      else dirty = el.value !== prev.value;
    });
    return dirty;
  },

  hasUnsavedChanges() {
    if (this.isFormDirty(this._modalPristine, document.querySelector('.modal-body'))) return true;
    return this.isFormDirty(this._pagePristine, this.findEditRoot());
  },

  clearFormDirty() {
    this._pagePristine = null;
    this._modalPristine = null;
  },

  // 首次聚焦表单控件时记录快照：此时异步渲染的明细行已就位，且尚未发生用户修改
  initDirtyTracking() {
    if (this._dirtyTrackingReady) return;
    this._dirtyTrackingReady = true;
    document.addEventListener('focusin', e => {
      const el = e.target;
      if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      const modalBody = document.querySelector('.modal-body');
      const root = modalBody || this.findEditRoot();
      if (!root || !root.contains(el)) return;
      const slot = modalBody ? '_modalPristine' : '_pagePristine';
      if (!this[slot]) this[slot] = this.collectFormSnapshot(root);
      // 异步插入的字段（如明细行）首次聚焦时只补记自身基线，
      // 不重新采集整表，避免把已修改字段的当前值误当成基线
      const type = String(el.type || '').toLowerCase();
      if (type === 'hidden' || type === 'password' || type === 'file' || el.disabled) return;
      const key = el.id || el.name || '';
      if (key && !(key in this[slot])) {
        this[slot][key] = (type === 'checkbox' || type === 'radio')
          ? { checked: !!el.checked }
          : { value: el.value };
      }
    });
    window.addEventListener('beforeunload', e => {
      if (!this.hasUnsavedChanges()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  },

  // 返回 Promise<boolean>，供导航拦截等待用户决定
  confirmDiscardChanges() {
    // confirmDialog 是单例：已有确认框在处理时直接拒绝本次导航。
    // 否则新 Promise 的 resolve 不会被已存在的弹窗触发，导致导航流程永久挂起。
    if (document.getElementById('confirm-overlay')) return Promise.resolve(false);
    if (!this.hasUnsavedChanges()) return Promise.resolve(true);
    return new Promise(resolve => {
      this.confirmDialog(
        this.t('unsaved_title'),
        this.t('unsaved_msg'),
        () => { this.clearFormDirty(); resolve(true); },
        () => resolve(false),
        'danger',
      );
    });
  },

  // ========== 模态框 ==========
  // opts.maximizable：标题栏显示最大化/还原按钮（大面积表格类弹窗用）
  showModal(title, bodyHtml, btnText, onConfirm, onCancel, large, opts) {
    // 单例：已有弹窗时忽略重复打开（连点 / 回车二次触发），避免叠层后按钮全部点不动
    if (document.getElementById('modal-overlay')) return false;
    const opener = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'modal-overlay';
    const modalClass = large ? 'modal modal-lg' : 'modal';
    // opts.fit：弹窗宽度跟随内容（列宽固定的表格类弹窗），避免宽弹窗里表格靠左留大片空白
    const fit = !!(opts && opts.fit);
    const maximizable = !!(opts && opts.maximizable);
    // opts.force：不可取消的弹窗（如强制改密），隐藏关闭按钮与「取消」，且点遮罩不关闭
    const force = !!(opts && opts.force);
    overlay.innerHTML = `<div class="${modalClass}${fit ? ' modal-fit' : ''}" role="dialog" aria-modal="true"><div class="modal-header">${title}<div class="modal-header-actions">${maximizable ? `<button class="modal-max-btn" id="modal-max-btn" type="button" title="${this.t('modal_maximize')}" aria-label="${this.t('modal_maximize')}">${this.icon('maximize', 'icon--tool')}</button>` : ''}${force ? '' : `<button class="modal-close" id="modal-close-btn" title="${this.t('close')}" aria-label="${this.t('close')}">${this.icon('close', 'icon--tool')}</button>`}</div></div><div class="modal-body">${bodyHtml}</div><div class="modal-footer">${force ? '' : `<button class="btn btn-outline" id="modal-cancel-btn">${this.t('cancel')}</button>`}<button class="btn btn-primary" id="modal-confirm-btn">${btnText}</button></div></div>`;
    document.body.appendChild(overlay);
    if (maximizable) {
      const box = overlay.querySelector('.modal');
      const btn = document.getElementById('modal-max-btn');
      btn.onclick = () => {
        const on = box.classList.toggle('modal-maximized');
        btn.innerHTML = this.icon(on ? 'restore' : 'maximize', 'icon--tool');
        btn.title = this.t(on ? 'modal_restore' : 'modal_maximize');
        btn.setAttribute('aria-label', btn.title);
      };
    }
    // 弹窗插入后立即采集快照，不依赖首次 focusin：
    // 异步填充字段、或初始焦点落在确认按钮时也能正确判断是否有未保存修改
    this._modalPristine = this.collectFormSnapshot(overlay.querySelector('.modal-body'));
    this._modalReturnFocus = opener;
    const doCancel = () => this.requestCloseModal(() => { if (onCancel) onCancel(); });
    const closeBtn = document.getElementById('modal-close-btn');
    const cancelBtn = document.getElementById('modal-cancel-btn');
    if (closeBtn) closeBtn.onclick = doCancel;
    if (cancelBtn) cancelBtn.onclick = doCancel;
    if (!force) overlay.addEventListener('click', e => { if (e.target === overlay) doCancel(); });
    overlay.addEventListener('keydown', e => this.onDialogKeydown(e, overlay, !force, doCancel));
    const confirmBtn = document.getElementById('modal-confirm-btn');
    confirmBtn.onclick = () => {
      if (confirmBtn.dataset.busy === '1') return; // 防连点：一次提交流程未结束前不再触发
      confirmBtn.dataset.busy = '1';
      const reset = () => { if (document.body.contains(confirmBtn)) confirmBtn.dataset.busy = ''; };
      let r;
      try { r = onConfirm(); } catch (e) { reset(); throw e; }
      if (r && typeof r.then === 'function') r.then(reset, reset);
      else reset();
    };
    // 初始焦点优先落在第一个可编辑字段，其次落在确认按钮
    const firstField = overlay.querySelector('.modal-body input:not([type="hidden"]):not([disabled]):not([readonly]), .modal-body select:not([disabled]), .modal-body textarea:not([disabled])');
    (firstField || confirmBtn).focus();
  },

  // 取消路径统一走这里：有未保存修改时先二次确认；保存成功后的 closeModal() 不受影响
  requestCloseModal(afterClose) {
    const body = document.querySelector('.modal-body');
    if (this.isFormDirty(this._modalPristine, body)) {
      this.confirmDialog(
        this.t('unsaved_title'),
        this.t('unsaved_msg'),
        () => { this.closeModal(); if (afterClose) afterClose(); },
        null,
        'danger',
      );
      return;
    }
    this.closeModal();
    if (afterClose) afterClose();
  },

  closeModal() {
    this.msClose();
    const el = document.getElementById('modal-overlay');
    if (el) el.remove();
    this._modalPristine = null;
    const back = this._modalReturnFocus;
    this._modalReturnFocus = null;
    if (back && document.body.contains(back) && typeof back.focus === 'function') back.focus();
  }
});
