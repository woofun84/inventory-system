/**
 * 库存盘点 —— 盘点单列表 / 建单 / 载入清单 / 实盘录入 / 确认 / 删除草稿
 *
 * 说明：
 *  - 盘点是「以实盘为准」的核对流程：先抓账面快照(book_qty)，再录实盘(count_qty)，
 *    差异(diff_qty = 实盘 - 账面) 在「确认」时批量生成库存调整流水。
 *  - 确认只会为「有差异」的行生成调整，账实相符与未盘的行不产生流水。
 *  - 权限动作粒度非通用 CRUD：view / create / confirm
 *    （create=建单+载入清单+录实盘+删除草稿；confirm=确认并生成调整流水）
 *  - 页面用两种视图：列表视图(stocktake list) 与 详情视图(stocktake detail)
 *    通过 this._stView 切换，详情视图里表格独立滚动，录入实盘不重建容器，
 *    避免打断中文输入法（IME）组合状态。
 */
Object.assign(App, {
  // ========== 盘点：列表视图 ==========

  async renderStocktake() {
    this._stView = 'list';
    this._stData = null;

    const addBtn = this.can('stocktake', 'create')
      ? `<button class="btn btn-primary" onclick="App.newStocktake()">+ ${this.t('st_add')}</button>` : '';
    const statusSel = `<select id="st_status_filter" onchange="App.onStocktakeFilter()" style="width:120px">
      <option value="">${this.t('st_all_status')}</option>
      <option value="draft">${this.t('st_status_draft')}</option>
      <option value="confirmed">${this.t('st_status_confirmed')}</option>
    </select>`;

    this.setMain(this.pageWrap('📋 ' + this.t('st_title'), this.t('st_desc'), '', `<div id="st-content" class="data-page">
      <div class="data-toolbar">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
          <div>${addBtn}</div>
          <div class="form-group" style="flex:1;max-width:340px;margin:0">
            <input id="st_filter" type="text" placeholder="${this.t('st_filter_hint')}" oninput="App.onStocktakeFilter()" style="width:100%">
          </div>
          ${statusSel}
          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <input id="st_date_from" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="App.onStocktakeFilter()">
            <span style="color:var(--text-muted);font-size:12px">~</span>
            <input id="st_date_to" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="App.onStocktakeFilter()">
          </div>
        </div>
      </div>
      <div class="data-summary" id="st-summary"></div>
      <div class="data-scroll" id="st-scroll"></div>
      <div class="data-pager" id="st-pager"></div>
    </div>`));

    this.injectStocktakeStyles();
    try {
      this._stData = await this.api('/api/stocktakes');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['stocktake'] = () => this.renderStocktakeTable();
      this.renderStocktakeTable();
    } catch (e) {
      document.getElementById('st-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`;
    }
  },

  renderStocktakeTable() {
    const data = this._stData;
    if (!data) return;
    const tid = 'stocktake';
    const st = this.getTableState(tid);

    const keywords = document.getElementById('st_filter')?.value || '';
    const status = document.getElementById('st_status_filter')?.value || '';
    const dateFrom = document.getElementById('st_date_from')?.value || '';
    const dateTo = document.getElementById('st_date_to')?.value || '';

    const filterFields = ['stocktake_no', 'handler', 'remarks', 'category_filter'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    if (status) filtered = filtered.filter(r => r.status === status);
    filtered = this.filterByDateRange(filtered, 'date', dateFrom, dateTo);

    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);

    let totalLines = 0;
    sorted.forEach(r => { totalLines += Number(r.line_count || 0); });

    const headers = [
      ['stocktake_no', this.t('st_no')],
      ['date', this.t('adj_date')],
      ['status', this.t('st_status')],
      ['load_scope', this.t('st_scope')],
      ['handler', this.t('st_handler')],
      ['line_count', this.t('st_lines')],
      ['counted_count', this.t('st_counted')],
      ['diff_count', this.t('st_diff')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('st_remark')}</th><th></th>`;
    const colCount = headers.length + 2;

    let tbody = '';
    if (pageData.length === 0) {
      tbody = this.emptyRow(colCount);
    } else {
      tbody = pageData.map(r => {
        const statusCell = this.stStatusBadge(r.status);
        // 差异行数 > 0 时用醒目色提示
        const diffCell = Number(r.diff_count) > 0
          ? `<span class="badge badge-warning">${r.diff_count}</span>` : `<span style="color:var(--text-muted)">0</span>`;
        const canDelete = this.can('stocktake', 'create') && r.status === 'draft';
        const noDisplay = `<span class="action-link ib-doc-no" onclick="App.openStocktake('${r.stocktake_no}')">${r.stocktake_no}</span>`;
        return `<tr>
          <td>${noDisplay}</td>
          <td>${this.fmtDate(r.date)}</td>
          <td>${statusCell}</td>
          <td>${this.stScopeLabel(r)}</td>
          <td>${r.handler || ''}</td>
          <td class="text-right">${r.line_count || 0}</td>
          <td class="text-right">${r.counted_count || 0}</td>
          <td class="text-right">${diffCell}</td>
          <td>${r.remarks || ''}</td>
          <td>
            <span class="action-link" onclick="App.openStocktake('${r.stocktake_no}')">${this.t('st_view_detail')}</span>
            ${canDelete ? `<span class="action-link danger" onclick="App.deleteStocktake('${r.stocktake_no}')">${this.t('delete')}</span>` : ''}
          </td>
        </tr>`;
      }).join('');
    }

    const filterActive = (keywords.trim() || status || dateFrom || dateTo) ? ` | 🔍 ${sorted.length}/${data.length}` : '';
    const countBy = key => data.filter(x => x.status === key).length;
    document.getElementById('st-summary').innerHTML = `
      <div class="ib-stat-grid">
        <div class="ib-stat"><small>${this.t('st_stat_total')}</small><strong>${data.length}</strong><em>${this.t('st_stat_unit')}</em></div>
        <div class="ib-stat"><small>${this.t('st_stat_draft')}</small><strong>${countBy('draft')}</strong><em>${this.t('st_stat_unit')}</em></div>
        <div class="ib-stat"><small>${this.t('st_stat_confirmed')}</small><strong>${countBy('confirmed')}</strong><em>${this.t('st_stat_unit')}</em></div>
        <div class="ib-stat"><small>${this.t('st_stat_filtered')}</small><strong>${sorted.length}</strong><em>${this.t('st_stat_unit')}</em></div>
      </div>
      <div class="data-summary">${this.t('st_total_lines', { n: totalLines })}${filterActive}</div>`;

    document.getElementById('st-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('st-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onStocktakeFilter() {
    const st = this.getTableState('stocktake');
    st.page = 1;
    this.renderStocktakeTable();
  },

  // 盘点页注入样式（对齐入库/出库页：统计卡片）
  injectStocktakeStyles() {
    if (document.getElementById('stocktake-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'stocktake-ui-styles';
    style.textContent = `
      .ib-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:12px;margin:4px 0 16px}
      .ib-stat{background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:13px 15px;min-width:0}
      .ib-stat small{display:block;color:var(--text-muted);font-size:12px;margin-bottom:7px}
      .ib-stat strong{font-size:22px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}
      .ib-stat em{font-style:normal;font-size:11px;color:var(--text-muted);margin-left:5px}
      .ib-doc-no{font-weight:650;font-variant-numeric:tabular-nums}
      .ib-form-section{background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:18px;margin:8px 0 16px}
      .ib-section-title{display:flex;align-items:center;gap:11px;margin-bottom:16px}
      .ib-section-title>span{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--primary-bg,rgba(59,130,246,.12));color:var(--primary);font-weight:700}
      .ib-section-title b,.ib-section-title small,.ib-next-step b,.ib-next-step small{display:block}
      .ib-section-title small,.ib-next-step small{font-size:12px;color:var(--text-muted);margin-top:3px}
      .ib-next-step{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--info-bg,rgba(14,165,233,.08));border:1px solid var(--border);border-radius:10px;padding:14px 16px}
      .ib-new-actions{display:flex;gap:8px;flex-wrap:wrap}
      /* 操作日志（对齐入库/出库详情页） */
      .ib-log-card{margin-top:16px;padding:16px;background:var(--card-bg);border:1px solid var(--border);border-radius:10px}
      .ib-log-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
      .ib-log-title{font-size:15px;font-weight:700;color:var(--text)}
      .ib-log-list{display:flex;flex-direction:column}
      .ib-log-item{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px;position:relative;padding-bottom:16px}
      .ib-log-item:last-child{padding-bottom:0}
      .ib-log-rail{display:flex;flex-direction:column;align-items:center;min-height:100%}
      .ib-log-dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--info-bg,rgba(59,130,246,.1));color:var(--primary);font-size:13px;z-index:1}
      .ib-log-line{width:2px;flex:1;min-height:14px;background:var(--border);margin-top:4px}
      .ib-log-item:last-child .ib-log-line{display:none}
      .ib-log-body{min-width:0;padding:2px 0 0}
      .ib-log-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .ib-log-action{font-weight:650;color:var(--text)}
      .ib-log-meta{font-size:12px;color:var(--text-muted);margin-top:4px}
      .ib-log-detail{font-size:13px;color:var(--text);margin-top:7px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
      .ib-log-empty{padding:22px 12px;text-align:center;color:var(--text-muted);font-size:13px;background:var(--surface,transparent);border:1px dashed var(--border);border-radius:8px}
      /* 载入清单窗口（三种方式） */
      .st-load-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:14px}
      .st-load-tab{padding:9px 16px;cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted);border-bottom:2px solid transparent;margin-bottom:-1px}
      .st-load-tab:hover{color:var(--text)}
      .st-load-tab.active{color:var(--primary);border-bottom-color:var(--primary)}
      .st-load-panel{min-height:210px}
      .st-load-hint{font-size:12px;color:var(--text-muted);line-height:1.6;background:var(--info-bg,rgba(14,165,233,.07));border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:12px}
      .st-load-search{width:100%;box-sizing:border-box;margin-bottom:10px}
      .st-load-cat-list{max-height:230px;overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:2px}
      .st-load-cat-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;cursor:pointer}
      .st-load-cat-item:hover{background:var(--surface,transparent)}
      .st-load-cat-item input{cursor:pointer}
      .st-pick-selected{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px;min-height:30px}
      .st-pick-selected-label{font-size:12px;color:var(--text-muted)}
      .st-pick-selected-empty{font-size:12px;color:var(--text-muted)}
      .st-pick-chip{display:inline-flex;align-items:center;gap:5px;background:var(--info-bg,rgba(59,130,246,.1));color:var(--primary);border-radius:14px;padding:3px 9px;font-size:12px;font-weight:600}
      .st-pick-chip-x{cursor:pointer;font-size:15px;line-height:1;opacity:.7}
      .st-pick-chip-x:hover{opacity:1}
      .st-pick-results{max-height:280px;overflow:auto}
      .st-load-stat{font-size:12px;color:var(--text-muted);margin-top:10px}
      @media(max-width:760px){.ib-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ib-next-step{align-items:flex-start;flex-direction:column}.ib-new-actions{width:100%}.ib-new-actions button{flex:1}.ib-log-card{padding:12px}.st-load-cat-list{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  },

  // 状态徽标
  stStatusBadge(status) {
    const map = {
      draft: [this.t('st_status_draft'), 'warning'],
      confirmed: [this.t('st_status_confirmed'), 'success']
    };
    const m = map[status] || [status, 'muted'];
    return `<span class="badge badge-${m[1]}">${m[0]}</span>`;
  },

  // 行状态徽标
  stLineStatusBadge(status) {
    const map = {
      pending: [this.t('st_line_pending'), 'muted'],
      matched: [this.t('st_line_matched'), 'success'],
      adjusted: [this.t('st_line_adjusted'), 'info']
    };
    const m = map[status] || [status, 'muted'];
    return `<span class="badge badge-${m[1]}">${m[0]}</span>`;
  },

  // 载入范围显示（真实反映载入方式，而非笼统的「全部类别」）
  //   all → 全盘；category → 按类别：xxx；specified → 指定物料
  //   兼容旧数据（无 load_scope）时按 category_filter 退化显示
  stScopeLabel(r) {
    const scope = (r && r.load_scope) || '';
    const cats = String((r && r.category_filter) || '').split(',').map(s => s.trim()).filter(Boolean);
    if (scope === 'specified') return this.t('st_scope_specified');
    if (scope === 'category') return this.t('st_scope_category', { c: cats.join('、') || '-' });
    if (scope === 'all') return this.t('st_scope_all');
    return cats.length ? this.t('st_scope_category', { c: cats.join('、') }) : this.t('st_scope_all');
  },

  // ========== 新建盘点单：独立页面（对齐入库/出库页） ==========

  async newStocktake() {
    const date = this.today();
    let no = '';
    try {
      const next = await this.api('/api/stocktakes/next-no?date=' + date);
      no = next.stocktake_no;
    } catch (e) { /* 单号预览失败不阻断 */ }

    this._stView = 'new';
    this.setMain(this.pageWrap('📋 ' + this.t('st_add'), this.t('st_create_hint'), '',
      `<div class="data-page" id="st-content">
        <div class="data-toolbar" style="padding:16px">
          <div class="st-toolbar-row" style="margin-bottom:14px">
            <div class="st-toolbar-left"><span class="action-link st-back-link" onclick="App.backToStocktakeList()">← ${this.t('st_nav_detail')}</span></div>
            <div class="st-toolbar-right"><span class="badge badge-warning">${this.t('st_status_draft')}</span></div>
          </div>
          <div class="ib-form-section">
            <div class="ib-section-title"><span>01</span><div><b>${this.t('st_sec_info')}</b><small>${this.t('st_sec_info_hint')}</small></div></div>
            <div class="form-grid" style="max-width:none">
              <div class="form-group"><label>${this.t('st_no')}</label><input id="st_f_no" value="${no}" readonly placeholder="保存后生成"></div>
              <div class="form-group"><label>${this.t('adj_date')} *</label><input id="st_f_date" type="date" value="${date}" oninput="App.clearFieldError('st_f_date')"><div class="form-error" id="st_f_date_error"></div></div>
              <div class="form-group"><label>${this.t('st_handler')}</label><input id="st_f_handler" value="${this.user?.name || this.user?.username || ''}"></div>
              <div class="form-group" style="grid-column:1/-1"><label>${this.t('st_remark')}</label><textarea id="st_f_remarks" rows="2" placeholder="${this.t('st_remark')}"></textarea></div>
            </div>
          </div>
          <div class="ib-next-step">
            <div><b>${this.t('st_next_title')}</b><small>${this.t('st_load_hint')}</small></div>
            <div class="ib-new-actions">
              <button class="btn btn-outline" onclick="App.backToStocktakeList()">${this.t('cancel')}</button>
              <button class="btn btn-primary" onclick="App.createStocktake()">${this.t('st_create_go')}</button>
            </div>
          </div>
        </div>
      </div>`));
    this.injectStocktakeStyles();
  },

  async createStocktake() {
    if (!this.validateForm({ st_f_date: [{ rule: 'required' }] })) return;
    const body = {
      date: document.getElementById('st_f_date').value,
      handler: document.getElementById('st_f_handler').value.trim(),
      remarks: document.getElementById('st_f_remarks').value.trim()
    };
    try {
      const r = await this.api('/api/stocktakes', 'POST', body);
      this.toast(this.t('st_created'));
      // 建单后进入详情并弹出「载入清单」窗口，由用户选择三种载入方式之一
      await this.openStocktake(r.stocktake_no);
      this.openStocktakeLoadModal();
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // ========== 详情视图 ==========

  async openStocktake(no) {
    this._stView = 'detail';
    if (this._stNo !== no) this._stLogsExpanded = false;
    this._stNo = no;
    this._stTab = 'lines';

    const detail = await this.api('/api/stocktakes/' + encodeURIComponent(no));
    this._stDetail = detail;

    // 页头保持纯净（与全站 15 页一致）：只放标题 + 全局工具（语言/主题）
    // 业务按钮全部下沉到 .data-toolbar，表格滚动时常驻可见
    this.setMain(this.pageWrap('📋 ' + detail.stocktake_no,
      `${this.t('st_title')} · ${detail.date} · ${this.stStatusBadge(detail.status)}`, '',
      `<div id="st-content" class="data-page">
        <div class="data-toolbar">
          <div class="st-detail-bar">
            <div id="st-detail-header" class="st-detail-info"></div>
            <div class="st-detail-actions" id="st-detail-actions"></div>
          </div>
          <div class="st-toolbar-row">
            <div class="st-toolbar-left">
              <span class="action-link st-back-link" onclick="App.backToStocktakeList()">← ${this.t('st_nav_detail')}</span>
              <span id="st-tabs" class="st-tabs"></span>
            </div>
            <div class="st-toolbar-right" id="st-toolbar-buttons"></div>
          </div>
        </div>
        <div class="data-summary" id="st-summary"></div>
        <div class="data-scroll" id="st-scroll"></div>
        <div class="data-pager" id="st-pager"></div>
      </div>`));

    this.injectStocktakeStyles();
    this.renderStocktakeDetail();
  },

  // 详情内子页签：盘点明细 / 关联调整流水 / 操作日志
  switchStocktakeTab(tab) {
    this._stTab = tab;
    this.renderStocktakeDetail();
  },

  renderStocktakeTabs() {
    const box = document.getElementById('st-tabs');
    if (!box) return;
    const d = this._stDetail || {};
    const adjCount = (d.adjustments || []).length;
    const logCount = (d.logs || []).length;
    const t = (key, active) => `<span class="st-tab${active ? ' active' : ''}" onclick="App.switchStocktakeTab('${key}')">`;
    box.innerHTML =
      `${t('lines', this._stTab === 'lines')}${this.t('st_tab_lines')}</span>` +
      `${t('adjs', this._stTab === 'adjs')}${this.t('st_adjustments')}${adjCount ? ` (${adjCount})` : ''}</span>` +
      `${t('logs', this._stTab === 'logs')}${this.t('st_logs')}${logCount ? ` (${logCount})` : ''}</span>`;
  },

  // 渲染详情页的按钮组（主操作组 + 独立分组的删除草稿按钮）
  renderStocktakeActions() {
    const d = this._stDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const canCreate = this.can('stocktake', 'create');
    const canConfirm = this.can('stocktake', 'confirm');

    // 主操作组：草稿态可载入清单 / 保存实盘；确认按 confirm 权限
    let main = '';
    if (isDraft && canCreate) {
      main += `<button class="btn btn-outline" onclick="App.openStocktakeLoadModal()">${this.t('st_load')}</button>`;
      main += `<button class="btn btn-outline" onclick="App.openStocktakeAddLinesModal()">${this.t('st_add_line')}</button>`;
      main += `<button class="btn btn-outline" onclick="App.saveStocktakeCounts()">${this.t('st_save_count')}</button>`;
    }
    if (isDraft && canConfirm) {
      main += `<button class="btn btn-primary" onclick="App.confirmStocktake()">${this.t('st_confirm')}</button>`;
    }

    // 危险操作组（仅草稿态）：删除草稿（彻底移除）
    let danger = '';
    if (isDraft && canCreate) {
      danger = `<span class="st-btn-divider"></span><button class="btn btn-danger" onclick="App.deleteStocktake()">${this.t('st_delete')}</button>`;
    }

    const box = document.getElementById('st-toolbar-buttons');
    if (box) box.innerHTML = main + danger;
  },

  renderStocktakeDetail() {
    const d = this._stDetail;
    if (!d) return;
    const tid = 'stocktake_lines';
    const st = this.getTableState(tid);

    const isDraft = d.status === 'draft';
    const canCreate = this.can('stocktake', 'create') && isDraft;

    // 单据信息条（工具栏第一行）
    const hdr = document.getElementById('st-detail-header');
    if (hdr) {
      hdr.innerHTML = [
        `${this.t('st_handler')}: <b style="color:var(--text)">${d.handler || '-'}</b>`,
        `${this.t('st_scope')}: <b style="color:var(--text)">${this.stScopeLabel(d)}</b>`,
        d.remarks ? `${this.t('st_remark')}: <b style="color:var(--text)">${d.remarks}</b>` : '',
        d.confirmed_at ? `${this.t('st_confirmed_at')}: <b style="color:var(--text)">${this.fmtDateTime(d.confirmed_at)}</b>` : ''
      ].filter(Boolean).map(x => `<span>${x}</span>`).join('');
    }

    this.renderStocktakeActions();
    this.renderStocktakeTabs();
    if (this._stTab === 'adjs') { this.renderStocktakeAdjTable(); return; }
    if (this._stTab === 'logs') { this.renderStocktakeLogs(); return; }

    const lines = d.lines || [];
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);

    const headers = [
      ['code', this.t('mat_code')], ['material_name', this.t('mat_name')], ['material_spec', this.t('mat_spec')],
      ['material_brand', this.t('mat_brand')], ['material_unit', this.t('mat_unit')],
      ['book_qty', this.t('st_book_qty')],
      ['count_qty', this.t('st_count_qty')], ['diff_qty', this.t('st_diff_qty')], ['status', this.t('st_status_label')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('st_remark')}</th>`;
    if (canCreate) thHtml += '<th></th>';
    const colCount = headers.length + 1 + (canCreate ? 1 : 0);

    let tbody = '';
    if (pageData.length === 0) {
      // 空状态分两种：未载入清单（提示先载入）／已载入但筛选后为空
      const notLoaded = (lines.length === 0);
      const canCreate = this.can('stocktake', 'create') && isDraft;
      tbody = `<tr><td colspan="${colCount}" style="text-align:center;padding:40px;color:var(--text-muted)">
        ${notLoaded ? this.t('st_empty_lines') : this.t('noData')}
        ${notLoaded && canCreate
          ? `<div style="margin-top:14px">
              <button class="btn btn-primary" onclick="App.openStocktakeLoadModal()">${this.t('st_load')}</button>
              <div style="margin-top:8px;font-size:12px">${this.t('st_load_hint')}</div>
            </div>` : ''}
      </td></tr>`;
    } else {
      tbody = pageData.map(l => {
        const book = Number(l.book_qty) || 0;
        const hasCount = l.count_qty !== null && l.count_qty !== undefined;
        const cnt = hasCount ? Number(l.count_qty) : null;
        const diff = hasCount ? Math.round((cnt - book) * 10000) / 10000 : null;

        // 实盘输入框：草稿态可编辑，其余只读
        const cntCell = canCreate
          ? `<input type="number" step="0.01" class="st-count-input" data-id="${l.id}" value="${hasCount ? l.count_qty : ''}" placeholder="${this.t('st_input_count')}">`
          : (hasCount ? this.fmtQty(cnt) : '-');

        // 差异列：正数盘盈(绿) / 负数盘亏(红)
        let diffCell = '-';
        if (diff !== null && diff !== undefined) {
          const color = diff > 0 ? 'var(--success)' : (diff < 0 ? 'var(--danger)' : 'inherit');
          const txt = diff > 0 ? '+' + diff : String(diff);
          diffCell = `<span style="color:${color};font-weight:500">${txt}</span>`;
        }

        return `<tr>
          <td>${l.code}</td>
          <td>${l.material_name || ''}</td>
          <td>${l.material_spec || ''}</td>
          <td>${l.material_brand || ''}</td>
          <td>${l.material_unit || ''}</td>
          <td class="text-right">${this.fmtQty(book)}</td>
          <td class="text-right">${cntCell}</td>
          <td class="text-right">${diffCell}</td>
          <td>${this.stLineStatusBadge(l.status)}</td>
          <td>${l.remarks || ''}</td>
          ${canCreate ? `<td><span class="action-link danger" onclick="App.removeStocktakeLine(${l.id}, '${String(l.code).replace(/'/g, "\\'")}')">${this.t('st_remove_line')}</span></td>` : ''}
        </tr>`;
      }).join('');
    }

    // 汇总
    const s = d.summary || {};
    const summary = document.getElementById('st-summary');
    if (summary) {
      summary.innerHTML = [
        `${this.t('st_line_count', { n: s.line_count || 0 })}`,
        `${this.t('st_counted')}: <b style="color:var(--text)">${s.counted_count || 0}</b>`,
        `${this.t('st_pending')}: <b style="color:var(--text)">${s.pending_count || 0}</b>`,
        `${this.t('st_matched')}: <span style="color:var(--success)">${s.matched_count || 0}</span>`,
        `${this.t('st_diff')}: <span style="color:var(--danger)">${s.diff_count || 0}</span>`,
        `${this.t('st_gain')}: <span style="color:var(--success)">+${s.gain_qty || 0}</span>`,
        `${this.t('st_loss')}: <span style="color:var(--danger)">${s.loss_qty || 0}</span>`
      ].join(' | ');
    }

    const scroll = document.getElementById('st-scroll');
    scroll.innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    const pager = document.getElementById('st-pager');
    if (pager) pager.innerHTML = this.renderPager(tid, sorted.length);
  },

  fmtQty(v) {
    if (v === null || v === undefined || v === '') return '-';
    const n = Number(v);
    if (isNaN(n)) return String(v);
    return String(Math.round(n * 10000) / 10000);
  },

  // 关联调整流水（只读）：盘点确认后自动生成的库存调整流水
  renderStocktakeAdjTable() {
    const d = this._stDetail;
    if (!d) return;
    const tid = 'stocktake_adjs';
    const st = this.getTableState(tid);
    const adjs = d.adjustments || [];

    const sorted = this.sortData(adjs, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);

    const headers = [
      ['code', this.t('mat_code')], ['material_name', this.t('mat_name')],
      ['material_spec', this.t('mat_spec')], ['material_unit', this.t('mat_unit')],
      ['qty', this.t('adj_qty')], ['adj_type', this.t('adj_type')],
      ['handler', this.t('adj_handler')], ['created_at', this.t('st_adj_time')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('st_remark')}</th>`;
    const colCount = headers.length + 1;

    let tbody = '';
    if (pageData.length === 0) {
      tbody = `<tr><td colspan="${colCount}" style="text-align:center;padding:40px;color:var(--text-muted)">${this.t('st_adj_empty')}</td></tr>`;
    } else {
      tbody = pageData.map(a => {
        const qty = Number(a.qty) || 0;
        const color = qty > 0 ? 'var(--success)' : (qty < 0 ? 'var(--danger)' : 'inherit');
        const qtyTxt = qty > 0 ? '+' + this.fmtQty(qty) : this.fmtQty(qty);
        return `<tr>
          <td>${a.code || ''}</td>
          <td>${a.material_name || ''}</td>
          <td>${a.material_spec || ''}</td>
          <td>${a.material_unit || ''}</td>
          <td class="text-right"><span style="color:${color};font-weight:500">${qtyTxt}</span></td>
          <td>${a.adj_type || ''}</td>
          <td>${a.handler || ''}</td>
          <td>${this.fmtDateTime(a.created_at)}</td>
          <td>${a.remarks || ''}</td>
        </tr>`;
      }).join('');
    }

    const summary = document.getElementById('st-summary');
    if (summary) {
      const gain = adjs.filter(a => Number(a.qty) > 0).reduce((s, a) => s + Number(a.qty), 0);
      const loss = adjs.filter(a => Number(a.qty) < 0).reduce((s, a) => s + Number(a.qty), 0);
      summary.innerHTML = `${this.t('st_adj_count')}: <b style="color:var(--text)">${adjs.length}</b> | ${this.t('st_gain')}: <span style="color:var(--success)">+${this.fmtQty(gain)}</span> | ${this.t('st_loss')}: <span style="color:var(--danger)">${this.fmtQty(loss)}</span>`;
    }

    const scroll = document.getElementById('st-scroll');
    scroll.innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    const pager = document.getElementById('st-pager');
    if (pager) pager.innerHTML = this.renderPager(tid, sorted.length);
  },

  // ========== 操作日志（对齐入库/出库详情页） ==========

  // 渲染操作日志：时间轴，默认显示最近 5 条，可展开全部记录。
  renderStocktakeLogs() {
    const d = this._stDetail;
    if (!d) return;
    const logs = Array.isArray(d.logs) ? d.logs.slice() : [];
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    const actionMap = {
      create: this.t('st_log_create'), load: this.t('st_log_load'),
      save: this.t('st_log_save'), confirm: this.t('st_log_confirm'),
      add: this.t('st_log_add'), remove: this.t('st_log_remove')
    };
    const iconMap = {
      create: '＋', load: '⇩', save: '▣', confirm: '✓',
      add: '＋', remove: '－'
    };

    const timeValue = l => l.created_at || '';
    const sorted = logs.sort((a, b) => {
      const ta = Date.parse(timeValue(a)) || 0;
      const tb = Date.parse(timeValue(b)) || 0;
      return tb - ta;
    });
    const expanded = !!this._stLogsExpanded;
    const visible = expanded ? sorted : sorted.slice(0, 5);

    const logsHtml = visible.map(l => {
      const action = String(l.action || '');
      const label = actionMap[action] || action || this.t('st_logs');
      const icon = iconMap[action] || '•';
      const detail = l.detail || '';
      const time = this.fmtDateTime(timeValue(l)) || '-';
      const operator = l.operator || '-';
      return `<div class="ib-log-item">
        <div class="ib-log-rail"><div class="ib-log-dot">${icon}</div><div class="ib-log-line"></div></div>
        <div class="ib-log-body">
          <div class="ib-log-top"><span class="ib-log-action">${esc(label)}</span><span class="ib-log-meta">${esc(time)}</span></div>
          <div class="ib-log-meta">${this.t('st_log_operator')}：${esc(operator)}</div>
          ${detail ? `<div class="ib-log-detail">${esc(detail)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    const toggle = sorted.length > 5
      ? `<button class="btn btn-outline btn-sm" onclick="App.toggleStocktakeLogs()">${expanded ? this.t('st_log_collapse') : this.t('st_log_all', { n: sorted.length })}</button>`
      : '';
    const content = sorted.length
      ? `<div class="ib-log-list">${logsHtml}</div>`
      : `<div class="ib-log-empty">${this.t('st_log_empty')}</div>`;

    const summary = document.getElementById('st-summary');
    if (summary) summary.innerHTML = `${this.t('st_logs')}: <b style="color:var(--text)">${this.t('st_log_count', { n: sorted.length })}</b>`;

    const scroll = document.getElementById('st-scroll');
    if (scroll) scroll.innerHTML = `<section class="ib-log-card" style="margin-top:0">
      <div class="ib-log-head"><div class="ib-log-title">📝 ${this.t('st_logs')}</div>${toggle}</div>
      ${content}
    </section>`;
    const pager = document.getElementById('st-pager');
    if (pager) pager.innerHTML = '';
  },

  toggleStocktakeLogs() {
    this._stLogsExpanded = !this._stLogsExpanded;
    this.renderStocktakeLogs();
  },

  // ========== 载入盘点清单 ==========
  // 三种方式：全盘 / 按物料类别 / 指定物料（见后端 /load）
  // 关键约束：账面数量在载入时固化为快照；同一物料仅出现一次。

  async openStocktakeLoadModal() {
    const no = this._stNo;
    if (!no) return;
    const cats = (this.params?.categories || []).map(c => c.name).filter(Boolean);

    this._stLoad = {
      mode: 'all',
      categories: [],
      codes: [],          // 已选物料编码（指定物料）
      catKeyword: '',
      pickKeyword: '',
      pickResults: []
    };
    this._stLoadCats = cats;

    this.showModal(
      `<h3>${this.t('st_load')}</h3>`,
      `<div class="st-load-tabs" id="st-load-tabs">
        <span class="st-load-tab active" data-mode="all" onclick="App.switchStocktakeLoadMode('all')">${this.t('st_load_mode_all')}</span>
        <span class="st-load-tab" data-mode="category" onclick="App.switchStocktakeLoadMode('category')">${this.t('st_load_mode_category')}</span>
        <span class="st-load-tab" data-mode="specified" onclick="App.switchStocktakeLoadMode('specified')">${this.t('st_load_mode_specified')}</span>
      </div>
      <div id="st-load-panel" class="st-load-panel"></div>`,
      this.t('st_load_action'), () => this.doStocktakeLoad(), null, true);

    this.renderStocktakeLoadPanel();
    this.refreshStocktakeLoadStats();
  },

  switchStocktakeLoadMode(mode) {
    if (!this._stLoad) return;
    this._stLoad.mode = mode;
    document.querySelectorAll('#st-load-tabs .st-load-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.mode === mode);
    });
    this.renderStocktakeLoadPanel();
    this.refreshStocktakeLoadStats();
  },

  renderStocktakeLoadPanel() {
    const box = document.getElementById('st-load-panel');
    const s = this._stLoad;
    if (!box || !s) return;

    if (s.mode === 'all') {
      box.innerHTML = `<div class="st-load-hint">${this.t('st_load_mode_all_hint')}</div>
        <div class="st-load-stat" id="st-load-stat"></div>`;
      return;
    }

    if (s.mode === 'category') {
      box.innerHTML = `<div class="st-load-hint">${this.t('st_load_mode_category_hint')}</div>
        <input id="st-load-cat-kw" type="text" placeholder="${this.t('st_load_cat_filter')}" value="${s.catKeyword || ''}"
          oninput="App._stLoad.catKeyword=this.value;App.renderStocktakeCatList()" class="st-load-search">
        <div class="st-load-cat-list" id="st-load-cat-list"></div>
        <div class="st-load-stat" id="st-load-stat"></div>`;
      this.renderStocktakeCatList();
      return;
    }

    // specified
    box.innerHTML = `<div class="st-load-hint">${this.t('st_load_mode_specified_hint')}</div>
      <input id="st-load-pick-kw" type="text" placeholder="${this.t('st_load_search_ph')}" value="${s.pickKeyword || ''}"
        oninput="App.onStocktakePickSearch(this.value)" class="st-load-search">
      <div class="st-pick-selected" id="st-pick-selected"></div>
      <div class="table-wrap st-pick-results"><table><thead><tr>
        <th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th>
        <th>${this.t('mat_unit')}</th><th class="text-right">${this.t('st_book_qty')}</th><th></th>
      </tr></thead><tbody id="st-pick-body"></tbody></table></div>
      <div class="st-load-stat" id="st-load-stat"></div>`;
    this.renderStocktakePickResults();
    this.renderStocktakeSelected();
  },

  renderStocktakeCatList() {
    const box = document.getElementById('st-load-cat-list');
    const s = this._stLoad;
    if (!box || !s) return;
    const kw = (s.catKeyword || '').trim().toLowerCase();
    const cats = (this._stLoadCats || []).filter(c => !kw || String(c).toLowerCase().includes(kw));
    if (cats.length === 0) {
      box.innerHTML = `<div class="ib-log-empty">${this.t('noData')}</div>`;
      return;
    }
    box.innerHTML = cats.map(c => {
      const checked = s.categories.includes(c) ? 'checked' : '';
      return `<label class="st-load-cat-item"><input type="checkbox" ${checked}
        onchange="App.toggleStocktakeLoadCat('${c.replace(/'/g, "\\'")}')"><span>${c}</span></label>`;
    }).join('');
  },

  toggleStocktakeLoadCat(cat) {
    const s = this._stLoad;
    if (!s) return;
    const i = s.categories.indexOf(cat);
    if (i >= 0) s.categories.splice(i, 1); else s.categories.push(cat);
    this.refreshStocktakeLoadStats();
  },

  onStocktakePickSearch(kw) {
    this._stLoad.pickKeyword = kw;
    this.searchStocktakeCandidates();
  },

  async searchStocktakeCandidates() {
    const s = this._stLoad;
    if (!s) return;
    const kw = (s.pickKeyword || '').trim();
    if (!kw) { s.pickResults = []; this.renderStocktakePickResults(); return; }
    try {
      const list = await this.api('/api/stocktakes/candidates?scope=specified&limit=100&keyword=' + encodeURIComponent(kw));
      s.pickResults = Array.isArray(list) ? list : [];
    } catch (e) {
      s.pickResults = [];
    }
    this.renderStocktakePickResults();
  },

  renderStocktakePickResults() {
    const tbody = document.getElementById('st-pick-body');
    const s = this._stLoad;
    if (!tbody || !s) return;
    const kw = (s.pickKeyword || '').trim();
    if (!kw) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_search_hint')}</td></tr>`;
      return;
    }
    const list = s.pickResults || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_empty')}</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(r => {
      const added = s.codes.includes(r.code);
      const newTag = r.is_new ? ` <span class="badge badge-warning">${this.t('st_pick_new')}</span>` : '';
      const btn = added
        ? `<button class="btn btn-outline btn-sm" disabled>${this.t('st_load_added')}</button>`
        : `<button class="btn btn-primary btn-sm" onclick="App.addStocktakePick('${r.code.replace(/'/g, "\\'")}')">${this.t('st_pick_add')}</button>`;
      return `<tr>
        <td>${r.code}</td>
        <td>${r.name || ''}${newTag}</td>
        <td>${r.spec || ''}</td>
        <td>${r.unit || ''}</td>
        <td class="text-right">${this.fmtQty(r.book_qty)}</td>
        <td>${btn}</td>
      </tr>`;
    }).join('');
  },

  addStocktakePick(code) {
    const s = this._stLoad;
    if (!s || s.codes.includes(code)) return;
    s.codes.push(code);
    this.renderStocktakePickResults();
    this.renderStocktakeSelected();
    this.refreshStocktakeLoadStats();
  },

  removeStocktakePick(code) {
    const s = this._stLoad;
    if (!s) return;
    const i = s.codes.indexOf(code);
    if (i >= 0) s.codes.splice(i, 1);
    this.renderStocktakePickResults();
    this.renderStocktakeSelected();
    this.refreshStocktakeLoadStats();
  },

  renderStocktakeSelected() {
    const box = document.getElementById('st-pick-selected');
    const s = this._stLoad;
    if (!box || !s) return;
    if (s.codes.length === 0) {
      box.innerHTML = `<span class="st-pick-selected-empty">${this.t('st_load_selected', { n: 0 })}</span>`;
      return;
    }
    const chips = s.codes.map(c =>
      `<span class="st-pick-chip">${c}<span class="st-pick-chip-x" onclick="App.removeStocktakePick('${c.replace(/'/g, "\\'")}')">&times;</span></span>`
    ).join('');
    box.innerHTML = `<span class="st-pick-selected-label">${this.t('st_load_selected', { n: s.codes.length })}</span>${chips}`;
  },

  // 实时刷新「符合条件项数」统计（全盘/按类别）
  async refreshStocktakeLoadStats() {
    const s = this._stLoad;
    if (!s) return;
    const box = document.getElementById('st-load-stat');
    if (!box) return;
    let url = '';
    if (s.mode === 'all') url = '/api/stocktakes/candidates?scope=all';
    else if (s.mode === 'category') {
      if (s.categories.length === 0) { box.textContent = ''; return; }
      url = '/api/stocktakes/candidates?scope=category&category=' + encodeURIComponent(s.categories.join(','));
    } else { return; }
    try {
      const list = await this.api(url);
      const n = Array.isArray(list) ? list.length : 0;
      const el = document.getElementById('st-load-stat');
      if (el) el.textContent = this.t('st_load_stat', { n });
    } catch (e) { /* 统计失败不阻断 */ }
  },

  async doStocktakeLoad(force = false) {
    const no = this._stNo;
    const s = this._stLoad;
    if (!no || !s) return;

    const body = { scope: s.mode };
    if (s.mode === 'category') {
      if (s.categories.length === 0) { this.toast(this.t('st_load_need_category'), 'error'); return; }
      body.categories = s.categories;
    }
    if (s.mode === 'specified') {
      if (s.codes.length === 0) { this.toast(this.t('st_load_need_material'), 'error'); return; }
      body.codes = s.codes;
    }
    if (force) body.force = true;

    try {
      const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/load', 'POST', body);
      this.closeModal();
      this.toast(this.t('st_load_ok', { n: r.loaded_count }));
      await this.openStocktake(no);
    } catch (e) {
      if (e.code === 'HAS_COUNT_DATA') {
        const n = (e.details && e.details.counted_count) || e.counted_count || 0;
        this.confirmDialog(this.t('st_load'),
          this.t('st_has_count', { n }) + '\n\n' + this.t('st_load_confirm'),
          () => this.doStocktakeLoad(true));
      } else {
        this.toast(e.message, 'error');
      }
    }
  },

  // ========== 保存实盘 ==========

  async saveStocktakeCounts() {
    const no = this._stNo;
    if (!no) return;
    const inputs = Array.from(document.querySelectorAll('.st-count-input'));
    if (inputs.length === 0) {
      this.toast(this.t('st_empty_lines'), 'error');
      return;
    }

    // 只提交「有值」的行；留空表示未盘（后端会清空该行实盘与差异）
    const lines = [];
    inputs.forEach(inp => {
      const raw = inp.value.trim();
      if (raw === '') return;
      const n = parseFloat(raw);
      if (isNaN(n)) return;
      lines.push({ id: Number(inp.dataset.id), count_qty: n });
    });

    if (lines.length === 0) {
      this.toast(this.t('st_input_count_hint'), 'error');
      return;
    }

    try {
      await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'PUT', { lines });
      this.toast(this.t('st_save_ok'));
      await this.openStocktake(no);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // ========== 草稿态：增删物料行 ==========
  // 仅在草稿状态可增删；增行采用「增量追加」，不清空已有行与已录实盘。
  // 账面数量取「加入时刻」的库存快照（与载入清单同口径）。

  // 打开「添加物料」弹窗（复用指定物料的多选交互）
  openStocktakeAddLinesModal() {
    const no = this._stNo;
    if (!no) return;
    const existing = new Set(((this._stDetail && this._stDetail.lines) || []).map(l => l.code));
    this._stAdd = { codes: [], keyword: '', results: [], existing };

    this.showModal(
      `<h3>${this.t('st_add_line')}</h3>`,
      `<div class="st-load-hint">${this.t('st_add_line_hint')}</div>
      <input id="st-add-kw" type="text" placeholder="${this.t('st_load_search_ph')}"
        oninput="App.onStocktakeAddSearch(this.value)" class="st-load-search">
      <div class="st-pick-selected" id="st-add-selected"></div>
      <div class="table-wrap st-pick-results"><table><thead><tr>
        <th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th>
        <th>${this.t('mat_unit')}</th><th class="text-right">${this.t('st_book_qty')}</th><th></th>
      </tr></thead><tbody id="st-add-body"></tbody></table></div>
      <div class="st-load-stat" id="st-add-stat"></div>`,
      this.t('st_add_line_action'), () => this.doStocktakeAddLines(), null, true);

    this.renderStocktakeAddResults();
    this.renderStocktakeAddSelected();
  },

  onStocktakeAddSearch(kw) {
    if (!this._stAdd) return;
    this._stAdd.keyword = kw;
    this.searchStocktakeAddCandidates();
  },

  async searchStocktakeAddCandidates() {
    const s = this._stAdd;
    if (!s) return;
    const kw = (s.keyword || '').trim();
    if (!kw) { s.results = []; this.renderStocktakeAddResults(); return; }
    try {
      const list = await this.api('/api/stocktakes/candidates?scope=specified&limit=100&keyword=' + encodeURIComponent(kw));
      s.results = Array.isArray(list) ? list : [];
    } catch (e) {
      s.results = [];
    }
    this.renderStocktakeAddResults();
  },

  renderStocktakeAddResults() {
    const tbody = document.getElementById('st-add-body');
    const s = this._stAdd;
    if (!tbody || !s) return;
    const kw = (s.keyword || '').trim();
    if (!kw) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_search_hint')}</td></tr>`;
      return;
    }
    const list = s.results || [];
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('st_pick_empty')}</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(r => {
      const inDoc = s.existing.has(r.code);
      const picked = s.codes.includes(r.code);
      let btn;
      if (inDoc) btn = `<button class="btn btn-outline btn-sm" disabled>${this.t('st_already_in_doc')}</button>`;
      else if (picked) btn = `<button class="btn btn-outline btn-sm" disabled>${this.t('st_load_added')}</button>`;
      else btn = `<button class="btn btn-primary btn-sm" onclick="App.addStocktakeAddPick('${r.code.replace(/'/g, "\\'")}')">${this.t('st_pick_add')}</button>`;
      return `<tr>
        <td>${r.code}</td>
        <td>${r.name || ''}</td>
        <td>${r.spec || ''}</td>
        <td>${r.unit || ''}</td>
        <td class="text-right">${this.fmtQty(r.book_qty)}</td>
        <td>${btn}</td>
      </tr>`;
    }).join('');
  },

  addStocktakeAddPick(code) {
    const s = this._stAdd;
    if (!s || s.codes.includes(code)) return;
    s.codes.push(code);
    this.renderStocktakeAddResults();
    this.renderStocktakeAddSelected();
  },

  removeStocktakeAddPick(code) {
    const s = this._stAdd;
    if (!s) return;
    const i = s.codes.indexOf(code);
    if (i >= 0) s.codes.splice(i, 1);
    this.renderStocktakeAddResults();
    this.renderStocktakeAddSelected();
  },

  renderStocktakeAddSelected() {
    const box = document.getElementById('st-add-selected');
    const s = this._stAdd;
    if (!box || !s) return;
    if (s.codes.length === 0) {
      box.innerHTML = `<span class="st-pick-selected-empty">${this.t('st_load_selected', { n: 0 })}</span>`;
    } else {
      const chips = s.codes.map(c =>
        `<span class="st-pick-chip">${c}<span class="st-pick-chip-x" onclick="App.removeStocktakeAddPick('${c.replace(/'/g, "\\'")}')">&times;</span></span>`
      ).join('');
      box.innerHTML = `<span class="st-pick-selected-label">${this.t('st_load_selected', { n: s.codes.length })}</span>${chips}`;
    }
    const stat = document.getElementById('st-add-stat');
    if (stat) stat.textContent = s.codes.length ? this.t('st_add_selected_stat', { n: s.codes.length }) : '';
  },

  async doStocktakeAddLines() {
    const no = this._stNo;
    const s = this._stAdd;
    if (!no || !s) return;
    if (s.codes.length === 0) { this.toast(this.t('st_load_need_material'), 'error'); return; }
    try {
      const r = await this.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines', 'POST', { codes: s.codes });
      this.closeModal();
      this.toast(this.t('st_add_line_ok', { n: r.added_count }));
      await this.openStocktake(no);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // 移除某一行物料（仅草稿态）
  removeStocktakeLine(id, code) {
    const no = this._stNo;
    if (!no) return;
    const self = this;
    this.confirmDialog(this.t('st_remove_line'),
      this.t('st_remove_line_hint', { code }),
      async () => {
        try {
          await self.api('/api/stocktakes/' + encodeURIComponent(no) + '/lines/' + id, 'DELETE');
          self.toast(self.t('st_remove_line_ok'));
          await self.openStocktake(no);
        } catch (e) {
          self.toast(e.message, 'error');
        }
      });
  },

  // ========== 确认盘点 ==========

  async confirmStocktake() {
    const no = this._stNo;
    if (!no) return;
    const d = this._stDetail;
    const s = d?.summary || {};

    const self = this;
    this.confirmDialog(this.t('st_confirm'),
      `${this.t('st_confirm_hint')}\n\n${this.t('st_counted')}: ${s.counted_count || 0} · ${this.t('st_diff')}: ${s.diff_count || 0}`,
      () => self.doConfirmStocktake(no, false));
  },

  // 真正调用确认接口；force=true 表示用户已知晓盘点期间库存变动并继续
  async doConfirmStocktake(no, force) {
    const self = this;
    try {
      const r = await self.api('/api/stocktakes/' + encodeURIComponent(no) + '/confirm', 'POST',
        force ? { force: true } : {});
      self.toast(self.t('st_confirm_ok', { n: r.adjusted_count }));
      await self.openStocktake(no);
    } catch (e) {
      if (e.code === 'STOCK_CHANGED') {
        // 盘点期间有出入库等其他单据改动了账面：列出受影响物料，二次确认后再以 force 重试
        const items = (e.details && e.details.items) || [];
        const n = (e.details && e.details.changed_count) || items.length;
        const rows = items.slice(0, 10).map(it =>
          `· ${it.code}${it.name ? ' ' + it.name : ''}：${self.t('st_book_qty')} ${self.fmtQty(it.snapshot_book)} → ${self.fmtQty(it.current_book)}`
        ).join('\n');
        const more = items.length > 10 ? `\n${self.t('st_changed_more', { n: items.length - 10 })}` : '';
        self.confirmDialog(self.t('st_confirm'),
          `${self.t('st_stock_changed', { n })}\n\n${rows}${more}\n\n${self.t('st_stock_changed_hint')}`,
          () => self.doConfirmStocktake(no, true));
      } else {
        self.toast(e.message, 'error');
      }
    }
  },

  // ========== 删除草稿盘点单 ==========

  async deleteStocktake(no) {
    no = no || this._stNo;
    if (!no) return;
    const self = this;
    this.confirmDialog(this.t('st_delete'), this.t('st_delete_hint'), async () => {
      try {
        await self.api('/api/stocktakes/' + encodeURIComponent(no), 'DELETE');
        self.toast(self.t('st_delete_ok'));
        self.backToStocktakeList();
      } catch (e) {
        self.toast(e.message, 'error');
      }
    });
  },

  // 返回列表
  backToStocktakeList() {
    this._stView = 'list';
    this.renderStocktake();
  },

});
