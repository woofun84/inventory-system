/**
 * 通用 UI 组件 —— 表格排序、分页、表单校验、空状态、筛选、状态徽章、模态框
 */
Object.assign(App, {
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

  // 生成可排序的表头
  sortTh(label, key, tableId) {
    const st = this.getTableState(tableId);
    const active = st.sortKey === key;
    const arrow = active ? (st.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sort-th ${active ? 'active' : ''}" onclick="App.onSort('${tableId}','${key}')">${label}<span class="sort-arrow">${active ? (st.sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span></th>`;
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

  fmtMoney(v) { if (v == null || isNaN(v)) return '-'; return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  fmtDate(d) { if (!d) return ''; return String(d).slice(0, 10); },
  chartTextColor() { return this.theme === 'dark' ? '#94a3b8' : '#6b7280'; },
  chartGridColor() { return this.theme === 'dark' ? 'rgba(51,65,85,0.3)' : 'rgba(229,231,235,0.5)'; },

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
