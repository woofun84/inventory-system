/**
 * 出库管理 —— 单据列表 / 详情 / 独立编辑页面
 *
 * 设计说明（对齐入库页 2026-11-03）：
 *  - 列表展示出库单据（单号/日期/类型/去向/行数/数量/状态），点击进入详情页
 *  - 详情页参考入库详情页设计：单据基本信息 + 全部物料明细 + 创建/审核信息 + 操作日志
 *  - 新建/编辑用独立编辑页面（非模态窗口），支持存草稿、草稿继续编辑
 *  - 确认出库（过账）后生成库存流水，已过账单据不可直接修改
 *  - 草稿可作废/删除；同一张单据可添加多条不同物料；删明细只删当前行
 *  - 选择物料弹出物料选择窗口
 *  - 五种视图通过 this._obView 切换：list / detail / new / edit / reversal
 */
Object.assign(App, {

  // ========== 出库单据列表 ==========
  async renderOutbound() {
    this._obView = 'list';

    const addBtn = this.can('outbound', 'create')
      ? `<button class="btn btn-primary" onclick="App.newOutboundDoc()">+ ${this.t('obd_add')}</button>` : '';
    const statusSel = `<select id="ob_status_filter" onchange="App.onOutboundFilter()" style="width:120px">
      <option value="">${this.t('obd_all_status')}</option>
      <option value="draft">${this.t('obd_status_draft')}</option>
      <option value="posted">${this.t('obd_status_posted')}</option>
      <option value="partially_reversed">${this.t('obd_status_partial_rev')}</option>
      <option value="reversed">${this.t('obd_status_reversed')}</option>
      <option value="cancelled">${this.t('obd_status_cancelled')}</option>
    </select>`;

    this.setMain(this.pageWrap('📤 ' + this.t('obd_title'), this.t('obd_desc'), '',
      `<div id="outbound-content" class="data-page">
        <div class="data-toolbar">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
            <div>${addBtn}</div>
            <div class="form-group" style="flex:1;max-width:340px;margin:0">
              <input id="ob_filter" type="text" placeholder="${this.t('obd_filter_hint')}" oninput="App.onOutboundFilter()" style="width:100%">
            </div>
            ${statusSel}
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              <input id="out_date_from" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="App.onOutboundFilter()">
              <span style="color:var(--text-muted);font-size:12px">~</span>
              <input id="out_date_to" type="date" style="width:130px;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--card-bg);color:var(--text)" onchange="App.onOutboundFilter()">
            </div>
          </div>
        </div>
        <div class="data-summary" id="outbound-summary"></div>
        <div class="data-scroll" id="outbound-scroll"></div>
        <div class="data-pager" id="outbound-pager"></div>
      </div>`));

    this.injectOutboundStyles();
    try {
      this._outboundDocs = await this.api('/api/outbound-docs');
      this._tableRenderers = this._tableRenderers || {};
      this._tableRenderers['outbound'] = () => this.renderOutboundTable();
      this.renderOutboundTable();
    } catch (e) {
      document.getElementById('outbound-scroll').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`;
    }
  },

  renderOutboundTable() {
    const data = this._outboundDocs;
    if (!data) return;
    const cur = this.params?.currency || '¥';
    const vp = this.canViewPrice();
    const tid = 'outbound';
    const st = this.getTableState(tid);

    const keywords = document.getElementById('ob_filter')?.value || '';
    const status = document.getElementById('ob_status_filter')?.value || '';
    const dateFrom = document.getElementById('out_date_from')?.value || '';
    const dateTo = document.getElementById('out_date_to')?.value || '';

    const filterFields = ['doc_no', 'date', 'txn_type', 'destination', 'receiver', 'handler', 'remarks'];
    let filtered = this.filterByKeywords(data, keywords, filterFields);
    if (status) filtered = filtered.filter(r => r.status === status);
    filtered = this.filterByDateRange(filtered, 'date', dateFrom, dateTo);

    const sorted = this.sortData(filtered, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);

    let totalQty = 0, totalAmount = 0;
    sorted.forEach(r => { totalQty += Number(r.total_qty || 0); totalAmount += Number(r.total_amount || 0); });

    const headers = [
      ['doc_no', this.t('obd_no')],
      ['date', this.t('obd_date')],
      ['txn_type', this.t('obd_type')],
      ['destination', this.t('obd_destination')],
      ['line_count', this.t('obd_lines')],
      ['total_qty', this.t('obd_qty')],
      ...vp ? [['total_amount', this.t('obd_amount')]] : [],
      ['handler', this.t('obd_handler')],
      ['status', this.t('obd_status')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    thHtml += `<th>${this.t('obd_remarks')}</th><th></th>`;
    const colCount = headers.length + 2;

    let tbody = '';
    if (pageData.length === 0) {
      tbody = this.emptyRow(colCount);
    } else {
      tbody = pageData.map(r => {
        const statusBadge = this.obdStatusBadge(r.status);
        const isReversal = r.txn_type === '出库冲销';
        const txnBadge = isReversal
          ? `<span class="badge badge-danger">${this.t('obd_rev_type')}</span>`
          : r.txn_type === '退库出库'
          ? `<span class="badge badge-danger">${this.t('out_return')}</span>`
          : `<span class="badge badge-info">${this.t('out_normal')}</span>`;
        const canDelete = this.can('outbound', 'delete') && r.status === 'draft';
        const docNoDisplay = isReversal
          ? `<span class="action-link ib-doc-no" onclick="App.openOutboundDoc('${r.doc_no}')">${r.doc_no}</span><br><small style="color:var(--text-muted)">← ${r.reversal_of || ''}</small>`
          : `<span class="action-link ib-doc-no" onclick="App.openOutboundDoc('${r.doc_no}')">${r.doc_no}</span>`;
        return `<tr>
          <td>${docNoDisplay}</td>
          <td>${this.fmtDate(r.date)}</td>
          <td>${txnBadge}</td>
          <td>${r.destination || ''}</td>
          <td class="text-right">${r.line_count || 0}</td>
          <td class="text-right">${this.qtyCell(r.total_qty)}</td>
          ${vp ? `<td class="text-right">${this.fmtMoney(r.total_amount)}</td>` : ''}
          <td>${r.handler || ''}</td>
          <td>${statusBadge}</td>
          <td>${r.remarks || ''}</td>
          <td>
            <span class="action-link" onclick="App.openOutboundDoc('${r.doc_no}')">${this.t('obd_view_detail')}</span>
            ${canDelete ? `<span class="action-link danger" onclick="App.deleteOutboundDoc('${r.doc_no}')">${this.t('delete')}</span>` : ''}
          </td>
        </tr>`;
      }).join('');
    }

    const filterActive = (keywords.trim() || status || dateFrom || dateTo) ? ` | 🔍 ${sorted.length}/${data.length}` : '';
    const countBy = key => data.filter(x => x.status === key).length;
    document.getElementById('outbound-summary').innerHTML = `
      <div class="ib-stat-grid">
        <div class="ib-stat"><small>全部出库单</small><strong>${data.length}</strong><em>张</em></div>
        <div class="ib-stat"><small>草稿待处理</small><strong>${countBy('draft')}</strong><em>张</em></div>
        <div class="ib-stat"><small>已确认出库</small><strong>${countBy('posted')}</strong><em>张</em></div>
        <div class="ib-stat"><small>当前筛选数量</small><strong>${sorted.length}</strong><em>张</em></div>
      </div>
      <div class="data-summary">${this.t('out_total_qty')}: <b>${totalQty}</b>${vp ? ` | ${this.t('out_total_amount')}: <b>${cur} ${this.fmtMoney(totalAmount)}</b>` : ''}${filterActive}</div>`;
    document.getElementById('outbound-scroll').innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    document.getElementById('outbound-pager').innerHTML = this.renderPager(tid, sorted.length);
  },

  onOutboundFilter() {
    const st = this.getTableState('outbound');
    st.page = 1;
    this.renderOutboundTable();
  },

  // 状态徽标
  obdStatusBadge(status) {
    const map = {
      draft: [this.t('obd_status_draft'), 'warning'],
      posted: [this.t('obd_status_posted'), 'success'],
      cancelled: [this.t('obd_status_cancelled'), 'muted'],
      partially_reversed: [this.t('obd_status_partial_rev'), 'warning'],
      reversed: [this.t('obd_status_reversed'), 'muted']
    };
    const m = map[status] || [status, 'muted'];
    return `<span class="badge badge-${m[1]}">${m[0]}</span>`;
  },

  // ========== 新建出库单据：独立页面 ==========
  async newOutboundDoc() {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    let docNo = '';
    try {
      const next = await this.api('/api/outbound-docs/next-no?date=' + date + '&txnType=正常出库');
      docNo = next.doc_no || '';
    } catch (e) { /* 单号预览失败不阻断创建 */ }

    const dests = (this.params?.destinations || []).map(d => d.name);
    const destOptions = dests.map(d => `<option value="${d}">${d}</option>`).join('');

    this._obView = 'new';
    this.setMain(this.pageWrap('📤 ' + this.t('obd_add'), this.t('obd_create_hint'), '',
      `<div class="data-page" id="outbound-content">
        <div class="data-toolbar" style="padding:16px">
          <div class="st-toolbar-row" style="margin-bottom:14px">
            <div class="st-toolbar-left"><span class="action-link st-back-link" onclick="App.backToOutboundList()">← ${this.t('obd_back_list')}</span></div>
            <div class="st-toolbar-right"><span class="badge badge-warning">${this.t('obd_status_draft')}</span></div>
          </div>
          <div class="ib-form-section">
            <div class="ib-section-title"><span>01</span><div><b>单据信息</b><small>先填写领用去向和经办信息，明细可在下一步添加</small></div></div>
            <div class="form-grid" style="max-width:none">
              <div class="form-group"><label>${this.t('obd_no')}</label><input id="ob_f_no" value="${docNo}" readonly placeholder="保存后生成"></div>
              <div class="form-group"><label>${this.t('obd_date')} *</label><input id="ob_f_date" type="date" value="${date}"></div>
              <div class="form-group"><label>${this.t('obd_type')} *</label><select id="ob_f_txn_type"><option value="正常出库">${this.t('out_normal')}</option><option value="退库出库">${this.t('out_return')}</option></select></div>
              <div class="form-group"><label>${this.t('obd_destination')}</label><select id="ob_f_destination"><option value="">${this.t('none')}</option>${destOptions}</select></div>
              <div class="form-group"><label>${this.t('obd_receiver')}</label><input id="ob_f_receiver" value=""></div>
              <div class="form-group"><label>${this.t('obd_handler')}</label><input id="ob_f_handler" value="${this.user?.name || this.user?.username || ''}"></div>
              <div class="form-group" style="grid-column:1/-1"><label>${this.t('obd_remarks')}</label><textarea id="ob_f_remarks" rows="2" placeholder="可填写领用事由、工单号或其他说明"></textarea></div>
            </div>
          </div>
          <div class="ib-next-step">
            <div><b>下一步：添加物料明细</b><small>创建单据后进入明细编辑页；此时不会扣减库存。</small></div>
            <div class="ib-new-actions"><button class="btn btn-outline" onclick="App.backToOutboundList()">${this.t('cancel')}</button><button class="btn btn-primary" onclick="App.createOutboundDoc()">创建单据并添加明细 →</button></div>
          </div>
        </div>
      </div>`));
    this.injectOutboundStyles();
  },

  async createOutboundDoc() {
    if (!this.validateForm({ ob_f_date: [{ rule: 'required' }] })) return;
    const body = {
      doc_no: document.getElementById('ob_f_no')?.value || '',
      date: document.getElementById('ob_f_date')?.value,
      txn_type: document.getElementById('ob_f_txn_type')?.value,
      destination: document.getElementById('ob_f_destination')?.value,
      receiver: document.getElementById('ob_f_receiver')?.value.trim(),
      handler: document.getElementById('ob_f_handler')?.value.trim(),
      remarks: document.getElementById('ob_f_remarks')?.value.trim()
    };
    try {
      const r = await this.api('/api/outbound-docs', 'POST', body);
      this.toast(this.t('obd_created'));
      await this.editOutboundDoc(r.doc_no);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  injectOutboundStyles() {
    if (document.getElementById('outbound-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'outbound-ui-styles';
    style.textContent = `
      .ib-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:12px;margin:4px 0 16px}
      .ib-stat{background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:13px 15px;min-width:0}
      .ib-stat small{display:block;color:var(--text-muted);font-size:12px;margin-bottom:7px}
      .ib-stat strong{font-size:22px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}
      .ib-stat em{font-style:normal;font-size:11px;color:var(--text-muted);margin-left:5px}
      .ib-form-section{background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:18px;margin:8px 0 16px}
      .ib-section-title{display:flex;align-items:center;gap:11px;margin-bottom:16px}
      .ib-section-title>span{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--primary-bg,rgba(59,130,246,.12));color:var(--primary);font-weight:700}
      .ib-section-title b,.ib-section-title small,.ib-next-step b,.ib-next-step small{display:block}
      .ib-section-title small,.ib-next-step small{font-size:12px;color:var(--text-muted);margin-top:3px}
      .ib-next-step{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--info-bg,rgba(14,165,233,.08));border:1px solid var(--border);border-radius:10px;padding:14px 16px}
      .ib-new-actions{display:flex;gap:8px;flex-wrap:wrap}
      .ib-doc-no{font-weight:650;font-variant-numeric:tabular-nums}
      .ib-empty-draft{padding:22px;text-align:center;background:var(--info-bg,rgba(14,165,233,.07));border:1px dashed var(--border);border-radius:9px;margin:12px 0}
      .ib-line-amount{font-variant-numeric:tabular-nums;font-weight:600}
      #ob-edit-scroll input{max-width:100%;box-sizing:border-box}
      #ob-edit-scroll table td{vertical-align:middle}
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
      .ib-log-change{margin-top:8px;border:1px solid var(--border);border-radius:7px;padding:8px 10px;background:var(--surface,transparent)}
      .ib-log-change summary{cursor:pointer;color:var(--primary);font-size:12px;font-weight:600}
      .ib-log-change-content{padding-top:8px;font-size:12px;color:var(--text-muted);white-space:pre-wrap;overflow-wrap:anywhere}
      .ib-log-empty{padding:22px 12px;text-align:center;color:var(--text-muted);font-size:13px;background:var(--surface,transparent);border:1px dashed var(--border);border-radius:8px}
      @media(max-width:760px){.ib-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ib-next-step{align-items:flex-start;flex-direction:column}.ib-new-actions{width:100%}.ib-new-actions button{flex:1}.ib-log-card{padding:12px}.ib-log-top{align-items:flex-start;flex-direction:column;gap:3px}}
    `;
    document.head.appendChild(style);
  },

  // ========== 出库单据详情页 ==========
  async openOutboundDoc(docNo) {
    this._obView = 'detail';
    if (this._obDocNo !== docNo) this._obLogsExpanded = false;
    this._obDocNo = docNo;

    const detail = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo));
    this._obDetail = detail;
    this._obLogsExpanded = false;

    const title = '📤 ' + detail.doc_no;
    const desc = `${this.t('obd_title')} · ${this.fmtDate(detail.date)} · ${this.obdStatusBadge(detail.status)}`;

    this.setMain(this.pageWrap(title, desc, '',
      `<div id="outbound-content" class="data-page">
        <div class="data-toolbar">
          <div class="st-detail-bar">
            <div id="ob-detail-header" class="st-detail-info"></div>
            <div class="st-detail-actions" id="ob-detail-actions"></div>
          </div>
          <div class="st-toolbar-row">
            <div class="st-toolbar-left">
              <span class="action-link st-back-link" onclick="App.backToOutboundList()">← ${this.t('obd_back_list')}</span>
            </div>
            <div class="st-toolbar-right" id="ob-toolbar-buttons"></div>
          </div>
        </div>
        <div class="data-summary" id="ob-summary"></div>
        <div class="data-scroll" id="ob-scroll"></div>
        <div class="data-pager" id="ob-pager"></div>
      </div>`));

    this.injectOutboundStyles();
    this.renderOutboundDetail();
    // 异步加载冲销信息（原单已过账/部分冲销/已冲销时）
    this.loadOutboundReversalInfo(docNo);
  },

  // 渲染详情页按钮组
  renderOutboundDocActions() {
    const d = this._obDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const canEdit = this.can('outbound', 'edit');
    const canDelete = this.can('outbound', 'delete');
    const isReversalDoc = !!d.reversal_of; // 这是一张冲销单

    let main = '';
    if (isDraft && canEdit) {
      if (isReversalDoc) {
        main += `<button class="btn btn-primary" onclick="App.confirmOutboundReversalDoc()">${this.t('obd_rev_confirm')}</button>`;
      } else {
        const hasLines = (d.lines || []).length > 0;
        main += `<button class="btn btn-outline" onclick="App.editOutboundDoc('${d.doc_no}')">${hasLines ? this.t('obd_edit') : this.t('obd_add_line')}</button>`;
        if (hasLines) main += `<button class="btn btn-primary" onclick="App.confirmOutboundDoc()">${this.t('obd_confirm')}</button>`;
      }
    }

    let danger = '';
    if (isDraft && canDelete) {
      const lineCount = (d.lines || []).length;
      const deleteLabel = lineCount ? this.t('obd_delete_draft') : this.t('obd_delete_empty');
      danger = `<span class="st-btn-divider"></span><button class="btn btn-danger" onclick="App.deleteOutboundDoc('${d.doc_no}')">${deleteLabel}</button>`;
    }

    // 冲销按钮（仅原单已过账/部分冲销时显示）
    let reversal = '';
    if (!isReversalDoc && (d.status === 'posted' || d.status === 'partially_reversed') && canEdit) {
      reversal = `<span class="st-btn-divider"></span><button class="btn btn-outline" style="border-color:var(--danger);color:var(--danger)" onclick="App.showOutboundReversalPage('${d.doc_no}')">${this.t('obd_rev_create')}</button>`;
    }

    const box = document.getElementById('ob-toolbar-buttons');
    if (box) box.innerHTML = main + danger + reversal;
  },

  renderOutboundDetail() {
    const d = this._obDetail;
    if (!d) return;
    const vp = this.canViewPrice();
    const cur = this.params?.currency || '¥';
    const tid = 'outbound_lines';
    const st = this.getTableState(tid);

    // 单据信息条
    const hdr = document.getElementById('ob-detail-header');
    if (hdr) {
      const typeLabel = d.txn_type === '出库冲销' ? this.t('obd_rev_type')
        : d.txn_type === '退库出库' ? this.t('out_return')
        : this.t('out_normal');
      const items = [
        `${this.t('obd_type')}: <b style="color:var(--text)">${typeLabel}</b>`,
        `${this.t('obd_destination')}: <b style="color:var(--text)">${d.destination || '-'}</b>`,
        `${this.t('obd_receiver')}: <b style="color:var(--text)">${d.receiver || '-'}</b>`,
        `${this.t('obd_handler')}: <b style="color:var(--text)">${d.handler || '-'}</b>`,
        `${this.t('obd_created_by')}: <b style="color:var(--text)">${d.created_by || '-'}</b>`,
        `${this.t('obd_created_at')}: <b style="color:var(--text)">${this.fmtDateTime(d.created_at) || '-'}</b>`,
        d.confirmed_by ? `${this.t('obd_confirmed_by')}: <b style="color:var(--text)">${d.confirmed_by}</b>` : '',
        d.confirmed_at ? `${this.t('obd_confirmed_at')}: <b style="color:var(--text)">${this.fmtDateTime(d.confirmed_at)}</b>` : '',
        d.cancelled_by ? `${this.t('obd_cancelled_by')}: <b style="color:var(--text)">${d.cancelled_by}</b>` : '',
        d.cancelled_at ? `${this.t('obd_cancelled_at')}: <b style="color:var(--text)">${this.fmtDateTime(d.cancelled_at)}</b>` : ''
      ].filter(Boolean);

      // 冲销关联信息
      const revs = d.reversals || [];
      if (revs.length > 0) {
        const revLinks = revs.map(r => {
          if (r.type === 'original') {
            return `<span class="action-link" onclick="App.openOutboundDoc('${r.doc_no}')">← ${this.t('obd_rev_original')}: ${r.doc_no}</span>`;
          } else {
            const revStatus = this.obdStatusBadge(r.status);
            return `<span class="action-link" onclick="App.openOutboundDoc('${r.doc_no}')">${this.t('obd_rev_doc')}: ${r.doc_no}</span> <small>(${r.line_count||0}行 / ${this.qtyCell(r.total_qty)}) ${revStatus}</small>`;
          }
        }).join('<br>');
        items.push(`<span style="grid-column:1/-1">${revLinks}</span>`);
      }

      hdr.innerHTML = items.map(x => `<span>${x}</span>`).join('');
    }

    this.renderOutboundDocActions();

    // 明细行
    const lines = d.lines || [];
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);

    // 原单（非冲销单）在已过账/部分冲销/已冲销时，显示已冲销/剩余列
    const showRevCols = !d.reversal_of && (d.status === 'posted' || d.status === 'partially_reversed' || d.status === 'reversed');

    const headers = [
      ['code', this.t('mat_code')],
      ['material_name', this.t('mat_name')],
      ['material_spec', this.t('mat_spec')],
      ['material_brand', this.t('mat_brand')],
      ['material_unit', this.t('mat_unit')],
      ['qty', this.t('out_qty')],
      ...showRevCols ? [['reversed_qty', this.t('obd_rev_reversed')]] : [],
      ...showRevCols ? [['remaining', this.t('obd_rev_remaining')]] : [],
      ...vp ? [['cost_price', this.t('out_cost_price')]] : [],
      ...vp ? [['cost_amount', this.t('out_cost_amount')]] : [],
      ['receiver', this.t('out_receiver')],
      ['remarks', this.t('out_remarks')]
    ];
    let thHtml = headers.map(h => this.sortTh(h[1], h[0], tid)).join('');
    const colCount = headers.length;

    let tbody = '';
    if (pageData.length === 0) {
      tbody = this.emptyRow(colCount);
    } else {
      tbody = pageData.map(l => {
        const qty = Number(l.qty) || 0;
        let revCell = '<td></td>', remCell = '<td></td>';
        if (showRevCols && l.reversal_of === '' && qty !== 0) {
          const revQty = this._calcOutboundLineReversedQty(l.id);
          const remaining = Math.abs(qty) - revQty;
          revCell = `<td class="text-right" style="color:${revQty > 0 ? 'var(--danger)' : 'var(--text-muted)'}">${revQty > 0 ? '-' + revQty : 0}</td>`;
          remCell = `<td class="text-right" style="color:${remaining <= 0 ? 'var(--text-muted)' : 'var(--success)'}">${remaining}</td>`;
        }
        return `<tr>
          <td>${l.code}</td>
          <td>${l.material_name || ''}</td>
          <td>${l.material_spec || ''}</td>
          <td>${l.material_brand || ''}</td>
          <td>${l.material_unit || ''}</td>
          <td class="text-right">${this.qtyCell(qty)}</td>
          ${showRevCols ? revCell : ''}
          ${showRevCols ? remCell : ''}
          ${vp ? `<td class="text-right">${this.fmtMoney(l.cost_price)}</td>` : ''}
          ${vp ? `<td class="text-right">${this.fmtMoney(l.cost_amount)}</td>` : ''}
          <td>${l.receiver || ''}</td>
          <td>${l.remarks || ''}</td>
        </tr>`;
      }).join('');
    }

    // 汇总
    const s = d.summary || {};
    const summary = document.getElementById('ob-summary');
    if (summary) {
      const parts = [
        `${this.t('obd_line_count', { n: s.line_count || 0 })}`,
        `${this.t('out_total_qty')}: <b style="color:var(--text)">${this.qtyCell(s.total_qty)}</b>`,
      ];
      if (vp) parts.push(`${this.t('out_total_amount')}: <b style="color:var(--text)">${cur} ${this.fmtMoney(s.total_amount)}</b>`);
      if (d.remarks) parts.push(`${this.t('obd_remarks')}: <b style="color:var(--text)">${d.remarks}</b>`);
      summary.innerHTML = parts.join(' | ');
    }

    const scroll = document.getElementById('ob-scroll');
    const emptyDraftHint = d.status === 'draft' && lines.length === 0
      ? `<div class="ib-empty-draft"><b>这是一张空草稿</b><div style="font-size:12px;color:var(--text-muted);margin:6px 0 12px">尚未添加物料明细，不会影响库存。可以继续编辑，或删除这张草稿。</div>${this.can('outbound', 'edit') ? `<button class="btn btn-primary btn-sm" onclick="App.editOutboundDoc('${d.doc_no}')">添加物料明细</button>` : ''}</div>` : '';
    scroll.innerHTML = `${emptyDraftHint}<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    const pager = document.getElementById('ob-pager');
    if (pager) pager.innerHTML = this.renderPager(tid, sorted.length);

    this.renderOutboundDocLogs();
  },

  // 渲染操作日志：时间轴，默认显示最近 5 条，可展开全部记录。
  renderOutboundDocLogs() {
    const d = this._obDetail;
    const scroll = document.getElementById('ob-scroll');
    if (!d || !scroll) return;

    const logs = Array.isArray(d.logs) ? d.logs.slice() : [];
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    const actionMap = {
      create: '创建单据', edit: '修改单据', confirm: '确认出库', post: '确认出库',
      cancel: '作废草稿', void: '作废单据', delete: '删除单据', reversal: '冲销出库',
      reverse: '冲销出库', add_line: '新增物料明细', update_line: '修改物料明细',
      delete_line: '删除物料明细', save: '保存草稿'
    };
    const iconMap = {
      create: '＋', edit: '✎', confirm: '✓', post: '✓', cancel: '×', void: '×',
      delete: '−', reversal: '↶', reverse: '↶', add_line: '＋', update_line: '✎',
      delete_line: '−', save: '▣'
    };

    const timeValue = l => l.created_at || l.timestamp || l.time || '';
    const sorted = logs.sort((a, b) => {
      const ta = Date.parse(timeValue(a)) || 0;
      const tb = Date.parse(timeValue(b)) || 0;
      return tb - ta;
    });
    const expanded = !!this._obLogsExpanded;
    const visible = expanded ? sorted : sorted.slice(0, 5);

    const logsHtml = visible.map(l => {
      const action = String(l.action || '');
      const label = actionMap[action] || action || '操作记录';
      const icon = iconMap[action] || '•';
      const detail = l.detail || l.description || '';
      const time = this.fmtDateTime(timeValue(l)) || '-';
      const operator = l.operator || l.user_name || l.created_by || '-';
      return `<div class="ib-log-item">
        <div class="ib-log-rail"><div class="ib-log-dot">${icon}</div><div class="ib-log-line"></div></div>
        <div class="ib-log-body">
          <div class="ib-log-top"><span class="ib-log-action">${esc(label)}</span><span class="ib-log-meta">${esc(time)}</span></div>
          <div class="ib-log-meta">操作人：${esc(operator)}</div>
          ${detail ? `<div class="ib-log-detail">${esc(detail)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    const toggle = sorted.length > 5
      ? `<button class="btn btn-outline btn-sm" onclick="App.toggleOutboundLogs()">${expanded ? '收起记录' : `查看全部 ${sorted.length} 条记录`}</button>`
      : '';
    const content = sorted.length
      ? `<div class="ib-log-list">${logsHtml}</div>`
      : `<div class="ib-log-empty">暂无操作记录</div>`;

    const old = scroll.querySelector('.ib-log-card');
    if (old) old.remove();
    scroll.insertAdjacentHTML('beforeend', `<section class="ib-log-card">
      <div class="ib-log-head"><div class="ib-log-title">📝 操作日志 <span class="badge badge-info">${sorted.length} 条</span></div>${toggle}</div>
      ${content}
    </section>`);
  },

  toggleOutboundLogs() {
    this._obLogsExpanded = !this._obLogsExpanded;
    this.renderOutboundDocLogs();
  },

  // ========== 冲销功能 ==========

  // 计算原明细行的累计已冲销数量
  _calcOutboundLineReversedQty(lineId) {
    if (!this._obRevInfo || !this._obRevInfo.all_lines) return 0;
    const line = this._obRevInfo.all_lines.find(l => l.id === lineId);
    return line ? line.reversed_qty : 0;
  },

  // 加载冲销信息（原单详情打开时异步调用）
  async loadOutboundReversalInfo(docNo) {
    const d = this._obDetail;
    if (!d) return;
    if (d.reversal_of) return;
    if (d.status !== 'posted' && d.status !== 'partially_reversed' && d.status !== 'reversed') return;
    try {
      this._obRevInfo = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/reversal-info');
      this.renderOutboundDetail();
    } catch (e) { /* 静默失败，不影响详情页浏览 */ }
  },

  // 打开冲销创建页面
  async showOutboundReversalPage(docNo) {
    this._obView = 'reversal';
    this._obDocNo = docNo;

    let revInfo;
    try {
      revInfo = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/reversal-info');
    } catch (e) {
      this.setMain(this.pageWrap('⚠️ ' + this.t('obd_rev_create'), '', '',
        `<div style="padding:20px;text-align:center"><p style="color:var(--danger)">${e.message}</p>
        <button class="btn btn-outline" onclick="App.openOutboundDoc('${docNo}')">${this.t('obd_back_detail')}</button></div>`));
      return;
    }
    this._obRevInfo = revInfo;

    const lines = revInfo.lines || [];
    if (lines.length === 0) {
      this.setMain(this.pageWrap('⚠️ ' + this.t('obd_rev_create'), '', '',
        `<div style="padding:20px;text-align:center">
          <p style="color:var(--text-muted)">${this.t('obd_rev_no_remaining')}</p>
          <div style="margin-top:12px">
            <button class="btn btn-outline" onclick="App.openOutboundDoc('${docNo}')">${this.t('obd_back_detail')}</button>
          </div>
        </div>`));
      return;
    }

    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const vp = this.canViewPrice();

    // 冲销明细行表格
    const rowsHtml = lines.map((l, i) => {
      const maxQty = l.remaining;
      const qtyInput = `<input type="number" step="0.01" min="0.01" max="${maxQty}" value="${maxQty}" 
        style="width:80px" data-idx="${i}" class="ob-rev-qty"
        oninput="App.onOutRevQtyInput(${i}, this)" onpaste="App.qtyPaste(event)">`;
      const avail = this._outboundStockMap?.[l.code];
      const availText = avail === undefined || avail === null ? '-' : avail;
      const availColor = avail === undefined || avail === null ? 'var(--text-muted)'
        : (avail < 0 ? 'var(--danger)' : (avail === 0 ? 'var(--warning)' : 'var(--success)'));
      return `<tr>
        <td style="text-align:center"><input type="checkbox" class="ob-rev-check" data-idx="${i}" checked onchange="App.onOutRevCheckChange(${i})"></td>
        <td>${l.code}</td>
        <td>${l.material_name || ''}</td>
        <td>${l.material_spec || ''}</td>
        <td>${l.material_brand || ''}</td>
        <td>${l.material_unit || ''}</td>
        <td class="text-right">${this.qtyCell(l.qty)}</td>
        <td class="text-right" style="color:var(--danger)">${l.reversed_qty > 0 ? '-' + l.reversed_qty : 0}</td>
        <td class="text-right" style="color:var(--success);font-weight:600">${l.remaining}</td>
        ${vp ? `<td class="text-right">${this.fmtMoney(l.cost_price)}</td>` : ''}
        <td>${qtyInput}</td>
      </tr>`;
    }).join('');

    // 已有冲销单列表
    const existingRevs = revInfo.reversals || [];
    const revListHtml = existingRevs.length > 0
      ? `<div class="ib-log-card" style="margin-top:16px">
          <div class="ib-log-head"><div class="ib-log-title">${this.t('obd_rev_history')}</div></div>
          <div class="table-wrap"><table><thead><tr>
            <th>${this.t('obd_no')}</th><th>${this.t('obd_date')}</th><th>${this.t('obd_status')}</th>
            <th>${this.t('obd_lines')}</th><th>${this.t('obd_qty')}</th><th>${this.t('obd_confirmed_by')}</th><th></th>
          </tr></thead><tbody>
          ${existingRevs.map(r => `<tr>
            <td><span class="action-link" onclick="App.openOutboundDoc('${r.doc_no}')">${r.doc_no}</span></td>
            <td>${this.fmtDate(r.date)}</td>
            <td>${this.obdStatusBadge(r.status)}</td>
            <td class="text-right">${r.line_count || 0}</td>
            <td class="text-right">${this.qtyCell(r.total_qty)}</td>
            <td>${r.confirmed_by || '-'}</td>
            <td><span class="action-link" onclick="App.openOutboundDoc('${r.doc_no}')">${this.t('obd_view_detail')}</span></td>
          </tr>`).join('')}
          </tbody></table></div>
        </div>`
      : '';

    this.setMain(this.pageWrap('↶ ' + this.t('obd_rev_create'),
      `${this.t('obd_rev_original')}: ${docNo} | ${this.t('obd_status')}: ${this.obdStatusBadge(revInfo.status)}`, '',
      `<div id="outbound-content" class="data-page">
        <div class="data-toolbar">
          <div class="st-detail-bar">
            <div id="ob-rev-header" class="st-detail-info">
              <span>${this.t('obd_rev_create_hint')}</span>
            </div>
          </div>
          <div class="st-toolbar-row">
            <div class="st-toolbar-left">
              <span class="action-link st-back-link" onclick="App.openOutboundDoc('${docNo}')">← ${this.t('obd_back_detail')}</span>
            </div>
            <div class="st-toolbar-right">
              <button class="btn btn-primary" onclick="App.createOutboundReversalDoc('${docNo}')">${this.t('obd_rev_create_btn')}</button>
            </div>
          </div>
          <div class="ib-form-section" style="margin-top:12px">
            <div class="form-grid" style="max-width:none">
              <div class="form-group"><label>${this.t('obd_date')}</label><input id="ob_rev_date" type="date" value="${date}"></div>
              <div class="form-group" style="grid-column:span 3"><label>${this.t('obd_rev_reason')}</label><input id="ob_rev_reason" placeholder="${this.t('obd_rev_reason_ph')}"></div>
            </div>
          </div>
        </div>
        <div class="data-summary" id="ob-rev-summary"></div>
        <div class="data-scroll" id="ob-rev-scroll">
          <div class="table-wrap"><table><thead><tr>
            <th style="width:30px"></th>
            <th>${this.t('mat_code')}</th>
            <th>${this.t('mat_name')}</th>
            <th>${this.t('mat_spec')}</th>
            <th>${this.t('mat_brand')}</th>
            <th>${this.t('mat_unit')}</th>
            <th>${this.t('obd_rev_orig_qty')}</th>
            <th>${this.t('obd_rev_reversed')}</th>
            <th>${this.t('obd_rev_remaining')}</th>
            ${vp ? `<th>${this.t('out_cost_price')}</th>` : ''}
            <th>${this.t('obd_rev_this_qty')}</th>
          </tr></thead><tbody>${rowsHtml}</tbody></table></div>
          ${revListHtml}
        </div>
        <div class="data-pager"></div>
      </div>`));
    this.injectOutboundStyles();
    this.refreshOutRevSummary();
  },

  // 冲销数量输入：先去负号（含粘贴），再按上限收敛
  onOutRevQtyInput(idx, el) {
    const clean = this.qtyInput(el);
    this.onOutRevQtyChange(idx, clean);
  },

  onOutRevQtyChange(idx, val) {
    const lines = this._obRevInfo?.lines || [];
    if (lines[idx]) {
      const max = lines[idx].remaining;
      let v = parseFloat(val) || 0;
      if (v > max) v = max;
      if (v < 0) v = 0;
      this._obRevInfo.lines[idx]._revQty = v;
    }
    this.refreshOutRevSummary();
  },

  onOutRevCheckChange() {
    this.refreshOutRevSummary();
  },

  refreshOutRevSummary() {
    const lines = this._obRevInfo?.lines || [];
    let totalRevQty = 0, checkedCount = 0;
    lines.forEach((l, i) => {
      const checkbox = document.querySelector(`.ob-rev-check[data-idx="${i}"]`);
      if (checkbox && checkbox.checked) {
        checkedCount++;
        const qty = l._revQty !== undefined ? l._revQty : l.remaining;
        totalRevQty += qty;
      }
    });
    const summary = document.getElementById('ob-rev-summary');
    if (summary) {
      summary.innerHTML = `${this.t('obd_rev_selected', { n: checkedCount })} | ${this.t('obd_rev_total_qty')}: <b style="color:var(--danger)">${totalRevQty}</b>`;
    }
  },

  // 创建冲销单
  async createOutboundReversalDoc(originalDocNo) {
    const lines = this._obRevInfo?.lines || [];
    const revLines = [];
    let hasInvalidQty = false;
    lines.forEach((l, i) => {
      const checkbox = document.querySelector(`.ob-rev-check[data-idx="${i}"]`);
      if (checkbox && checkbox.checked) {
        const qty = l._revQty !== undefined ? l._revQty : l.remaining;
        if (this.qtyIsValid(qty)) revLines.push({ line_id: l.id, qty: qty });
        else hasInvalidQty = true;
      }
    });

    if (hasInvalidQty) {
      this.toast(this.t('rev_qty_required'), 'error');
      return;
    }
    if (revLines.length === 0) {
      this.toast(this.t('obd_rev_no_selection'), 'error');
      return;
    }

    const date = document.getElementById('ob_rev_date')?.value || this.today();
    const reason = document.getElementById('ob_rev_reason')?.value || '';

    this.confirmDialog(this.t('obd_rev_create'),
      `${this.t('obd_rev_confirm_hint')}\n\n${this.t('obd_rev_selected', { n: revLines.length })} | ${this.t('obd_rev_total_qty')}: ${revLines.reduce((s, l) => s + l.qty, 0)}`,
      async () => {
        try {
          const r = await this.api('/api/outbound-docs/' + encodeURIComponent(originalDocNo) + '/reversal', 'POST', {
            date, reason, lines: revLines
          });
          this.toast(this.t('obd_rev_created', { no: r.doc_no }));
          await this.openOutboundDoc(r.doc_no);
        } catch (e) {
          this.toast(e.message, 'error');
        }
      });
  },

  // 确认冲销（冲销单草稿 → posted）
  confirmOutboundReversalDoc() {
    const docNo = this._obDocNo;
    const d = this._obDetail;
    const lines = d?.lines || [];

    this.confirmDialog(this.t('obd_rev_confirm'),
      `${this.t('obd_rev_confirm_hint2')}\n\n${this.t('obd_line_count', { n: lines.length })} | ${this.t('out_total_qty')}: ${lines.reduce((s, l) => s + Math.abs(Number(l.qty || 0)), 0)}`,
      async () => {
        try {
          const r = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/reversal-confirm', 'POST', {});
          this.toast(this.t('obd_rev_confirmed', { n: r.line_count }));
          await this.openOutboundDoc(docNo);
        } catch (e) {
          this.toast(e.message, 'error');
        }
      });
  },

  // ========== 出库单据编辑页面（独立页面，非模态窗口） ==========

  async editOutboundDoc(docNo) {
    this._obView = 'edit';
    this._obDocNo = docNo;

    const detail = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo));
    this._obDetail = detail;
    this._obEditLines = (detail.lines || []).map(l => ({
      id: l.id,
      code: l.code,
      material_name: l.material_name,
      material_spec: l.material_spec,
      material_brand: l.material_brand,
      material_unit: l.material_unit,
      qty: Math.abs(Number(l.qty)),
      cost_price: Number(l.cost_price) || 0,
      remarks: l.remarks || ''
    }));

    // 加载物料和库存数据
    const materials = await this.api('/api/materials');
    this._materialsCache = materials;
    let stockMap = {};
    try {
      const stock = await this.api('/api/stock-summary');
      stockMap = Object.fromEntries(stock.map(s => [s.code, s.on_hand]));
    } catch (e) {}
    this._outboundStockMap = stockMap;

    this.setMain(this.pageWrap('✏️ ' + detail.doc_no,
      `${this.t('obd_edit_title')} · ${this.obdStatusBadge(detail.status)}`, '',
      `<div id="outbound-content" class="data-page">
        <div class="data-toolbar">
          <div class="st-detail-bar">
            <div id="ob-edit-header" class="st-detail-info"></div>
            <div class="st-detail-actions" id="ob-edit-actions"></div>
          </div>
          <div class="st-toolbar-row">
            <div class="st-toolbar-left">
              <span class="action-link st-back-link" onclick="App.backToOutboundDetail('${docNo}')">← ${this.t('obd_back_detail')}</span>
            </div>
            <div class="st-toolbar-right" id="ob-edit-buttons"></div>
          </div>
          <div id="ob-edit-form" style="margin-top:12px"></div>
        </div>
        <div class="data-summary" id="ob-edit-summary"></div>
        <div class="data-scroll" id="ob-edit-scroll"></div>
        <div class="data-pager" id="ob-edit-pager"></div>
      </div>`));

    this.injectOutboundStyles();
    this.renderOutboundEdit();
  },

  renderOutboundEdit() {
    const d = this._obDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const vp = this.canViewPrice();
    const dests = (this.params?.destinations || []).map(x => x.name);

    // 单据信息条
    const hdr = document.getElementById('ob-edit-header');
    if (hdr) {
      hdr.innerHTML = `
        <span>${this.t('obd_type')}: <b style="color:var(--text)">${d.txn_type === '退库出库' ? this.t('out_return') : this.t('out_normal')}</b></span>
        <span>${this.t('obd_status')}: ${this.obdStatusBadge(d.status)}</span>
      `;
    }

    // 表单字段（草稿态可编辑）
    const formEl = document.getElementById('ob-edit-form');
    if (formEl) {
      if (isDraft) {
        const destOptions = dests.map(x => `<option value="${x}" ${x === d.destination ? 'selected' : ''}>${x}</option>`).join('');
        formEl.innerHTML = `<div class="form-grid" style="max-width:none">
          <div class="form-group"><label>${this.t('obd_date')}</label><input id="ob_e_date" type="date" value="${this.fmtDate(d.date)}"></div>
          <div class="form-group"><label>${this.t('obd_destination')}</label><select id="ob_e_destination"><option value="">${this.t('none')}</option>${destOptions}</select></div>
          <div class="form-group"><label>${this.t('obd_receiver')}</label><input id="ob_e_receiver" value="${d.receiver || ''}"></div>
          <div class="form-group"><label>${this.t('obd_handler')}</label><input id="ob_e_handler" value="${d.handler || ''}"></div>
          <div class="form-group" style="grid-column:span 4"><label>${this.t('obd_remarks')}</label><input id="ob_e_remarks" value="${d.remarks || ''}"></div>
        </div>`;
      } else {
        formEl.innerHTML = `<div style="padding:10px;background:var(--info-bg,rgba(14,165,233,.1));border-radius:6px;font-size:12px">${this.t('obd_posted_hint')}</div>`;
      }
    }

    // 按钮组
    const btnBox = document.getElementById('ob-edit-buttons');
    if (btnBox) {
      let btns = '';
      if (isDraft) {
        btns += `<button class="btn btn-outline" onclick="App.addOutboundEditRow()">+ ${this.t('obd_add_line')}</button>`;
        btns += `<button class="btn btn-outline" onclick="App.saveOutboundDraft()">${this.t('obd_save_draft')}</button>`;
        btns += `<button class="btn btn-primary" onclick="App.confirmOutboundDocFromEdit()">${this.t('obd_confirm')}</button>`;
      }
      btnBox.innerHTML = btns;
    }

    this.renderOutboundEditTable();
  },

  // 只重渲染表格部分（避免重建工具栏打断 IME）
  renderOutboundEditTable() {
    const d = this._obDetail;
    if (!d) return;
    const isDraft = d.status === 'draft';
    const vp = this.canViewPrice();
    const lines = this._obEditLines || [];

    const headers = [
      this.t('mat_code'), this.t('mat_name'), this.t('mat_spec'),
      this.t('mat_brand'), this.t('mat_unit'),
      this.t('out_qty'), this.t('out_available'),
      ...(vp ? [this.t('out_cost_price'), '行成本'] : []),
      this.t('out_remarks'), ''
    ];
    let thHtml = headers.map(h => `<th>${h}</th>`).join('');

    let tbody = '';
    if (lines.length === 0) {
      tbody = `<tr><td colspan="${headers.length}" style="text-align:center;padding:30px;color:var(--text-muted)">
        ${this.t('obd_no_lines')}
        <div style="margin-top:10px">${isDraft ? `<button class="btn btn-primary btn-sm" onclick="App.addOutboundEditRow()">+ ${this.t('obd_add_line')}</button>` : ''}</div>
      </td></tr>`;
    } else {
      tbody = lines.map((l, i) => {
        const available = this._outboundStockMap ? this._outboundStockMap[l.code] : undefined;
        const availText = available === undefined || available === null ? '-' : available;
        const availColor = available === undefined || available === null ? 'var(--text-muted)'
          : (available < 0 ? 'var(--danger)' : (available === 0 ? 'var(--warning)' : 'var(--success)'));
        const costText = l.cost_price ? this.fmtMoney(l.cost_price) : '-';
        const amountText = l.cost_price ? this.fmtMoney((Number(l.qty) || 0) * (Number(l.cost_price) || 0)) : '-';

        if (isDraft) {
          const codeCell = `<span class="action-link" onclick="App.showOutboundMaterialPicker(${i})">${l.code || this.t('please_select')}</span>`;
          const qtyInput = `<input type="number" step="0.01" min="0.01" class="ob-edit-qty" data-idx="${i}" value="${l.qty || ''}" style="width:80px" oninput="App.onOutEditQtyInput(${i}, this)" onpaste="App.qtyPaste(event)">`;
          const remarksInput = `<input class="ob-edit-remarks" data-idx="${i}" value="${l.remarks || ''}" style="width:120px" oninput="App._obEditLines[${i}].remarks=this.value">`;
          const delBtn = `<span class="action-link danger" onclick="App.removeOutboundEditRow(${i})">${this.t('in_remove_row')}</span>`;
          return `<tr>
            <td>${codeCell}</td>
            <td>${l.material_name || ''}</td>
            <td>${l.material_spec || ''}</td>
            <td>${l.material_brand || ''}</td>
            <td>${l.material_unit || ''}</td>
            <td>${qtyInput}</td>
            <td class="ib-edit-available" style="font-size:12px;color:${availColor}">${availText}</td>
            ${vp ? `<td class="text-right" style="color:var(--text-muted)">${costText}</td><td class="text-right ib-line-amount" data-line-amount="${i}" style="color:var(--text-muted)">${amountText}</td>` : ''}
            <td>${remarksInput}</td>
            <td>${delBtn}</td>
          </tr>`;
        } else {
          const qty = l.qty || 0;
          const qtyColor = qty < 0 ? 'var(--danger)' : 'var(--text)';
          return `<tr>
            <td>${l.code}</td>
            <td>${l.material_name || ''}</td>
            <td>${l.material_spec || ''}</td>
            <td>${l.material_brand || ''}</td>
            <td>${l.material_unit || ''}</td>
            <td class="text-right" style="color:${qtyColor}">${qty}</td>
            <td class="text-right" style="font-size:12px;color:${availColor}">${availText}</td>
            ${vp ? `<td class="text-right">${costText}</td><td class="text-right">${amountText}</td>` : ''}
            <td>${l.remarks || ''}</td>
            <td></td>
          </tr>`;
        }
      }).join('');
    }

    // 汇总
    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const totalAmount = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost_price) || 0), 0);
    const summary = document.getElementById('ob-edit-summary');
    if (summary) {
      let parts = [`${this.t('obd_line_count', { n: lines.length })}`, `${this.t('out_total_qty')}: <b style="color:var(--text)">${totalQty}</b>`];
      if (vp) parts.push(`${this.t('out_total_amount')}: <b style="color:var(--text)">${this.fmtMoney(totalAmount)}</b>`);
      summary.innerHTML = parts.join(' | ');
    }

    const scroll = document.getElementById('ob-edit-scroll');
    if (scroll) scroll.innerHTML = `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${tbody}</tbody></table></div>`;
  },

  // 添加空行
  addOutboundEditRow() {
    if (!this._obEditLines) this._obEditLines = [];
    this._obEditLines.push({ code: '', qty: '', cost_price: 0, remarks: '' });
    this.renderOutboundEditTable();
  },

  // 数量输入：去掉负号（含粘贴）后写回缓存
  onOutEditQtyInput(idx, el) {
    const clean = this.qtyInput(el);
    this.onOutEditQtyChange(idx, clean);
  },

  // 数量变化时更新缓存（出库成本由后端过账时计算，前端不录入）
  onOutEditQtyChange(idx, val) {
    if (this._obEditLines && this._obEditLines[idx]) {
      this._obEditLines[idx].qty = parseFloat(val) || 0;
      this.refreshOutboundEditTotals();
    }
  },

  refreshOutboundEditTotals() {
    const lines = this._obEditLines || [];
    const totalQty = lines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    const totalAmount = lines.reduce((sum, line) => sum + (Number(line.qty) || 0) * (Number(line.cost_price) || 0), 0);
    const summary = document.getElementById('ob-edit-summary');
    if (summary) {
      const parts = [`${this.t('obd_line_count', { n: lines.length })}`, `${this.t('out_total_qty')}: <b style="color:var(--text)">${totalQty}</b>`];
      if (this.canViewPrice()) parts.push(`${this.t('out_total_amount')}: <b style="color:var(--text)">${this.fmtMoney(totalAmount)}</b>`);
      summary.innerHTML = parts.join(' | ');
    }
  },

  // 删除明细行（只删当前行，不影响其他物料）
  removeOutboundEditRow(idx) {
    if (!this._obEditLines) return;
    this._obEditLines.splice(idx, 1);
    this.renderOutboundEditTable();
  },

  // ========== 物料选择窗口（出库专用，避免与入库页方法名冲突） ==========
  showOutboundMaterialPicker(idx) {
    this._obMaterialPickerIdx = idx;
    const materials = this._materialsCache || [];
    if (materials.length === 0) {
      this.toast(this.t('selectMaterial'), 'error');
      return;
    }

    const categories = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    const catOpts = categories.map(c => `<option value="${c}">${c}</option>`).join('');

    this.showModal(`<h3>${this.t('obd_select_material')}</h3>`,
      `<div style="margin-bottom:12px">
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <select id="obmp_cat" onchange="App.filterOutboundMaterialPicker()" style="width:140px">
            <option value="">${this.t('mat_category')}</option>${catOpts}
          </select>
          <input id="obmp_keyword" type="text" placeholder="${this.t('quick_filter_ph')}" oninput="App.filterOutboundMaterialPicker()" style="flex:1">
        </div>
      </div>
      <div class="table-wrap" style="max-height:400px;overflow:auto"><table id="obmp_table"><thead><tr>
        <th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th>
        <th>${this.t('mat_brand')}</th><th>${this.t('mat_unit')}</th><th></th>
      </tr></thead><tbody id="obmp_body"></tbody></table></div>`,
      this.t('close'), () => { this.closeModal(); }, null, true);

    this._obMpMaterials = materials;
    this.renderOutboundMaterialPickerBody(materials);
  },

  renderOutboundMaterialPickerBody(materials) {
    const tbody = document.getElementById('obmp_body');
    if (!tbody) return;
    if (materials.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">${this.t('noData')}</td></tr>`;
      return;
    }
    tbody.innerHTML = materials.map((m, i) => `<tr>
      <td>${m.code}</td>
      <td>${m.name || ''}</td>
      <td>${m.spec || ''}</td>
      <td>${m.brand || ''}</td>
      <td>${m.unit || ''}</td>
      <td><button class="btn btn-primary btn-sm" onclick="App.pickOutboundMaterial(${i})">${this.t('add')}</button></td>
    </tr>`).join('');
  },

  filterOutboundMaterialPicker() {
    const cat = document.getElementById('obmp_cat')?.value || '';
    const kw = document.getElementById('obmp_keyword')?.value || '';
    let filtered = this._obMpMaterials || [];
    if (cat) filtered = filtered.filter(m => m.category === cat);
    if (kw.trim()) {
      const kws = kw.trim().toLowerCase().split(/\s+/);
      filtered = filtered.filter(m => {
        const haystack = [m.code, m.name, m.spec, m.brand, m.category].map(x => String(x || '').toLowerCase()).join(' ');
        return kws.every(k => haystack.includes(k));
      });
    }
    this.renderOutboundMaterialPickerBody(filtered);
  },

  pickOutboundMaterial(i) {
    const idx = this._obMaterialPickerIdx;
    if (idx === undefined || !this._obEditLines) { this.closeModal(); return; }
    const materials = this._obMpMaterials || [];
    const m = materials[i];
    if (!m) { this.closeModal(); return; }

    this._obEditLines[idx] = {
      code: m.code,
      material_name: m.name,
      material_spec: m.spec,
      material_brand: m.brand,
      material_unit: m.unit,
      qty: this._obEditLines[idx]?.qty || '',
      cost_price: 0,
      remarks: this._obEditLines[idx]?.remarks || ''
    };

    this.closeModal();
    this.renderOutboundEditTable();
  },

  // 明细行校验：数量必须为正数；0/非法值显式报错，不再静默丢行
  obValidateEditLines() {
    const lines = this._obEditLines || [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.code && !l.qty && !l.remarks) continue;
      if (!l.code) return { ok: false, message: this.t('line_material_required', { n: i + 1 }) };
      if (!this.qtyIsValid(l.qty)) return { ok: false, message: this.t('qty_line_invalid', { n: i + 1 }) };
    }
    return { ok: true };
  },

  // ========== 保存草稿 ==========
  async saveOutboundDraft() {
    const docNo = this._obDocNo;

    const check = this.obValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = (this._obEditLines || []).filter(l => l.code);

    const body = {
      lines: lines.map(l => ({
        code: l.code,
        qty: parseFloat(l.qty) || 0,
        remarks: l.remarks || ''
      })),
      date: document.getElementById('ob_e_date')?.value,
      destination: document.getElementById('ob_e_destination')?.value,
      receiver: document.getElementById('ob_e_receiver')?.value,
      handler: document.getElementById('ob_e_handler')?.value,
      remarks: document.getElementById('ob_e_remarks')?.value
    };

    try {
      await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
      this.toast(this.t('obd_draft_saved'));
      await this.editOutboundDoc(docNo);
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  // ========== 确认出库（从编辑页面） ==========
  confirmOutboundDocFromEdit() {
    const docNo = this._obDocNo;

    const check = this.obValidateEditLines();
    if (!check.ok) {
      this.toast(check.message, 'error');
      return;
    }
    const lines = (this._obEditLines || []).filter(l => l.code);

    if (lines.length === 0) {
      this.toast(this.t('obd_no_lines'), 'error');
      return;
    }

    this.confirmDialog(this.t('obd_confirm'),
      `${this.t('obd_confirm_hint')}\n\n${this.t('obd_line_count', { n: lines.length })} | ${this.t('out_total_qty')}: ${lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)}`,
      async () => {
        const body = {
          lines: lines.map(l => ({
            code: l.code,
            qty: parseFloat(l.qty) || 0,
            remarks: l.remarks || ''
          })),
          date: document.getElementById('ob_e_date')?.value,
          destination: document.getElementById('ob_e_destination')?.value,
          receiver: document.getElementById('ob_e_receiver')?.value,
          handler: document.getElementById('ob_e_handler')?.value,
          remarks: document.getElementById('ob_e_remarks')?.value
        };
        try {
          await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/lines', 'PUT', body);
          try {
            const r = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', {});
            this.toast(this.t('obd_confirm_ok', { n: r.line_count }));
            await this.openOutboundDoc(docNo);
          } catch (e) {
            if (e.code === 'INSUFFICIENT_STOCK') {
              this.handleOutboundDocStockError(e, docNo);
            } else {
              this.toast(e.message, 'error');
            }
          }
        } catch (e) {
          this.toast(e.message, 'error');
        }
      });
  },

  // 确认出库（从详情页面，草稿已有明细行）
  confirmOutboundDoc() {
    const docNo = this._obDocNo;
    const d = this._obDetail;
    const lines = d?.lines || [];

    if (lines.length === 0) {
      this.toast(this.t('obd_no_lines'), 'error');
      return;
    }

    this.confirmDialog(this.t('obd_confirm'),
      `${this.t('obd_confirm_hint')}\n\n${this.t('obd_line_count', { n: lines.length })} | ${this.t('out_total_qty')}: ${lines.reduce((s, l) => s + Number(l.qty || 0), 0)}`,
      async () => {
        try {
          const r = await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', {});
          this.toast(this.t('obd_confirm_ok', { n: r.line_count }));
          await this.openOutboundDoc(docNo);
        } catch (e) {
          if (e.code === 'INSUFFICIENT_STOCK') {
            this.handleOutboundDocStockError(e, docNo);
          } else {
            this.toast(e.message, 'error');
          }
        }
      });
  },

  // 出库库存不足：admin/manager 可强制放行
  handleOutboundDocStockError(err, docNo) {
    const details = (err.details || []).map(d => `${d.code}：需 ${d.requested}，可用 ${d.available}`).join('\n');
    const canForce = ['admin', 'manager'].includes(this.user?.role);
    if (!canForce) {
      this.toast(`${this.t('out_stock_short')}：${details}`, 'error');
      return;
    }
    const self = this;
    this.confirmDialog(
      this.t('out_stock_short'),
      `${details}\n\n${this.t('out_force_allow')}`,
      async () => {
        try {
          const r = await self.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/confirm', 'POST', { force_allow: true });
          self.toast(self.t('obd_confirm_ok', { n: r.line_count }));
          await self.openOutboundDoc(docNo);
        } catch (e2) { self.toast(e2.message, 'error'); }
      }
    );
  },

  // ========== 作废出库单据 ==========
  cancelOutboundDoc() {
    const docNo = this._obDocNo;
    this.confirmDialog(this.t('obd_cancel'), this.t('obd_cancel_hint'), async () => {
      try {
        await this.api('/api/outbound-docs/' + encodeURIComponent(docNo) + '/cancel', 'POST', {});
        this.toast(this.t('obd_cancel_ok'));
        await this.openOutboundDoc(docNo);
      } catch (e) {
        this.toast(e.message, 'error');
      }
    });
  },

  // ========== 删除出库单据 ==========
  deleteOutboundDoc(docNo) {
    const d = this._obDetail && this._obDetail.doc_no === docNo ? this._obDetail : null;
    const lineCount = d ? (d.lines || []).length : null;
    const detailText = lineCount === null ? this.t('obd_delete_confirm')
      : `确定删除草稿 ${docNo}？\n当前明细：${lineCount} 行。\n删除只适用于未过账草稿，不会产生库存流水；已过账单据不能删除。`;
    this.confirmDialog(this.t('delete'), detailText, async () => {
      try {
        await this.api('/api/outbound-docs/' + encodeURIComponent(docNo), 'DELETE');
        this.toast(this.t('deleted'));
        this.renderOutbound();
      } catch (e) { this.toast(e.message, 'error'); }
    });
  },

  // ========== 导航 ==========
  backToOutboundList() {
    this._obView = 'list';
    this.renderOutbound();
  },

  backToOutboundDetail(docNo) {
    this.openOutboundDoc(docNo);
  },

});
