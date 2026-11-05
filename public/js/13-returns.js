/**
 * 退货与退库模块
 *
 * 只做聚合展示：采购退货（入库账本）与领用退库（出库账本）。
 * 写入复用现有 inbound/outbound 接口与页面，不复制业务逻辑。
 */
Object.assign(App, {
  _retState: null,
  _retData: null,

  retEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  retState() {
    if (!this._retState) {
      this._retState = { tab: '', status: '', kw: '', from: '', to: '', page: 1, pageSize: 20 };
    }
    return this._retState;
  },

  async renderReturns() {
    this.retState().page = 1;
    this._retData = null;
    this.setMain(this.pageWrap('↩ ' + this.t('ret_title'), this.t('ret_desc'), '',
      `<div class="data-page" id="ret-root">
        <div class="data-toolbar" style="padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
            <div id="ret-tabs" style="display:flex;gap:6px;flex-wrap:wrap"></div>
            <div>
              ${this.can('returns', 'create') ? `<button class="btn btn-primary" onclick="App.newInboundDoc('采购退货')">+ ${this.t('ret_new_purchase')}</button>
              <button class="btn btn-outline" onclick="App.newOutboundDoc('退库出库')">+ ${this.t('ret_new_stock')}</button>` : ''}
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input id="ret-kw" placeholder="${this.t('ret_filter_ph')}" style="width:240px" onkeydown="if(event.key==='Enter')App.retApplyFilter()">
              <select id="ret-status" style="width:130px">
                <option value="">${this.t('ret_status_all')}</option>
                <option value="draft">${this.t('ibd_status_draft')}</option>
                <option value="posted">${this.t('ibd_status_posted')}</option>
                <option value="partially_reversed">${this.t('ibd_status_partial_rev')}</option>
                <option value="reversed">${this.t('ibd_status_reversed')}</option>
                <option value="cancelled">${this.t('ibd_status_cancelled')}</option>
              </select>
              <input id="ret-from" type="date" style="width:140px">
              <span style="color:var(--text-muted)">~</span>
              <input id="ret-to" type="date" style="width:140px">
              <button class="btn btn-outline" onclick="App.retApplyFilter()">${this.t('search')}</button>
              <button class="btn btn-outline" onclick="App.retClearFilter()">${this.t('clear')}</button>
            </div>
            <div><span id="ret-total" style="color:var(--text-muted);font-size:12px"></span></div>
          </div>
        </div>
        <div id="ret-body" style="padding:0 16px 16px"></div>
      </div>`));
    this.retRenderTabs();
    this.injectPurchaseStyles();
    await this.retLoadList();
    if (this._retPendingDoc) {
      const no = this._retPendingDoc;
      this._retPendingDoc = null;
      await this.retOpenDoc(no);
    }
  },

  retRenderTabs() {
    const box = document.getElementById('ret-tabs');
    if (!box) return;
    const s = this.retState();
    const tabs = [['', this.t('ret_tab_all')], ['采购退货', this.t('ret_tab_purchase')], ['领用退库', this.t('ret_tab_stock')]];
    box.innerHTML = tabs.map(([k, label]) =>
      `<button class="btn ${s.tab === k ? 'btn-primary' : 'btn-outline'}" onclick="App.retSwitchTab('${k}')">${label}</button>`
    ).join('');
  },

  retSyncFilterInputs() {
    const s = this.retState();
    const kw = document.getElementById('ret-kw');
    const st = document.getElementById('ret-status');
    const from = document.getElementById('ret-from');
    const to = document.getElementById('ret-to');
    if (kw) kw.value = s.kw;
    if (st) st.value = s.status;
    if (from) from.value = s.from;
    if (to) to.value = s.to;
  },

  retSwitchTab(tab) {
    const s = this.retState();
    s.tab = tab;
    s.page = 1;
    this.retRenderTabs();
    this.retLoadList();
  },

  retApplyFilter() {
    const s = this.retState();
    s.kw = document.getElementById('ret-kw')?.value.trim() || '';
    s.status = document.getElementById('ret-status')?.value || '';
    s.from = document.getElementById('ret-from')?.value || '';
    s.to = document.getElementById('ret-to')?.value || '';
    s.page = 1;
    this.retLoadList();
  },

  retClearFilter() {
    this._retState = { tab: this.retState().tab, status: '', kw: '', from: '', to: '', page: 1, pageSize: 20 };
    this.retSyncFilterInputs();
    this.retLoadList();
  },

  async retLoadList() {
    const s = this.retState();
    const q = new URLSearchParams({ page: String(s.page), pageSize: String(s.pageSize) });
    if (s.tab) q.set('type', s.tab);
    if (s.status) q.set('status', s.status);
    if (s.kw) q.set('keyword', s.kw);
    if (s.from) q.set('dateFrom', s.from);
    if (s.to) q.set('dateTo', s.to);
    try {
      this._retData = await this.api('/api/returns/docs?' + q.toString());
    } catch (e) {
      this._retData = { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 };
      this.toast(e.message || this.t('ret_load_failed'), 'error');
    }
    this.retSyncFilterInputs();
    this.retRenderList();
  },

  retStatusBadge(status) {
    const map = {
      draft: ['warning', 'ibd_status_draft'],
      posted: ['success', 'ibd_status_posted'],
      partially_reversed: ['warning', 'ibd_status_partial_rev'],
      reversed: ['danger', 'ibd_status_reversed'],
      cancelled: ['danger', 'ibd_status_cancelled'],
    };
    const hit = map[status];
    if (!hit) return `<span class="badge">${this.retEsc(status || '-')}</span>`;
    return `<span class="badge badge-${hit[0]}">${this.t(hit[1])}</span>`;
  },

  retRenderList() {
    const body = document.getElementById('ret-body');
    if (!body) return;
    const d = this._retData || { items: [], total: 0, page: 1, totalPages: 1 };
    const showPrice = this.canViewPrice();
    const totalEl = document.getElementById('ret-total');
    if (totalEl) totalEl.textContent = this.t('ret_total', { n: d.total });

    if (!d.items.length) {
      body.innerHTML = `<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-muted)">${this.t('ret_empty')}</div>`;
      return;
    }

    const rows = d.items.map(r => `<tr>
      <td><span class="action-link" onclick="App.retOpenDoc('${this.retEsc(r.doc_no)}')">${this.retEsc(r.doc_no)}</span></td>
      <td>${this.fmtDate(r.date)}</td>
      <td>${this.retEsc(r.sub_type)}</td>
      <td>${this.retEsc(r.party || '-')}</td>
      <td>${this.retEsc(r.ref_no || '-')}</td>
      <td class="text-right">${r.line_count || 0}</td>
      <td class="text-right">${this.qtyCell(r.direction === 'in' ? r.total_qty : -r.total_qty)}</td>
      ${showPrice ? `<td class="text-right">${this.fmtMoney(r.total_amount)}</td>` : ''}
      <td>${this.retStatusBadge(r.status)}</td>
      <td class="text-right">${this.qtyCell(r.direction === 'in' ? r.reversed_qty : -r.reversed_qty)}</td>
      <td class="text-right">${this.qtyCell(r.direction === 'in' ? r.remaining_qty : -r.remaining_qty)}</td>
      <td><span class="action-link" onclick="App.retOpenDoc('${this.retEsc(r.doc_no)}')">${this.t('ret_view')}</span></td>
    </tr>`).join('');

    const pager = `<div class="pu-pager" style="display:flex;justify-content:flex-end;align-items:center;gap:10px;padding:12px 0">
      <span style="font-size:12px;color:var(--text-muted)">${this.t('ret_page_info', { page: d.page, pages: d.totalPages, n: d.total })}</span>
      <button class="btn btn-outline" ${d.page <= 1 ? 'disabled' : ''} onclick="App.retPage(${d.page - 1})">${this.t('pu_prev')}</button>
      <button class="btn btn-outline" ${d.page >= d.totalPages ? 'disabled' : ''} onclick="App.retPage(${d.page + 1})">${this.t('pu_next')}</button>
    </div>`;

    body.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>${this.t('ret_no')}</th><th>${this.t('ret_date')}</th><th>${this.t('ret_subtype')}</th>
      <th>${this.t('ret_party')}</th><th>${this.t('ret_ref')}</th><th class="text-right">${this.t('ret_lines')}</th>
      <th class="text-right">${this.t('ret_qty')}</th>${showPrice ? `<th class="text-right">${this.t('ret_amount')}</th>` : ''}
      <th>${this.t('ret_status')}</th><th class="text-right">${this.t('ret_reversed')}</th>
      <th class="text-right">${this.t('ret_remaining')}</th><th>${this.t('ret_actions')}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>${pager}`;
  },

  retPage(page) {
    const s = this.retState();
    s.page = Math.max(1, Number(page) || 1);
    this.retLoadList();
  },

  // 从采购单详情等外部入口直接打开退货单详情
  openReturnDoc(docNo) {
    if (!this.can('returns', 'view')) {
      this.toast(this.t('no_perm_msg'), 'error');
      return;
    }
    this._retPendingDoc = docNo;
    this.currentPage = 'returns';
    return this.renderReturns();
  },

  async retOpenDoc(docNo) {
    try {
      const doc = await this.api('/api/returns/docs/' + encodeURIComponent(docNo));
      const body = document.getElementById('ret-body');
      if (!body) return;
      body.innerHTML = this.retDetailHtml(doc);
    } catch (e) {
      this.toast(e.message || this.t('ret_load_failed'), 'error');
    }
  },

  retDetailHtml(doc) {
    const showPrice = this.canViewPrice();
    const s = doc.summary || {};
    const d = doc.direction === 'in' ? 1 : -1;
    const canEdit = this.can(doc.ledger, 'edit');
    const canDelete = this.can(doc.ledger, 'delete');
    const canReverse = doc.can_reverse && canEdit;

    const actionBtns = [
      doc.can_edit && canEdit ? `<button class="btn btn-outline" onclick="App.${doc.ledger === 'inbound' ? 'editInboundDoc' : 'editOutboundDoc'}('${this.retEsc(doc.doc_no)}')">${this.t('ret_edit')}</button>` : '',
      doc.can_confirm && canEdit ? `<button class="btn btn-primary" onclick="App.retConfirm('${this.retEsc(doc.doc_no)}','${doc.ledger}')">${this.t('ret_confirm')}</button>` : '',
      canReverse ? `<button class="btn btn-outline" onclick="App.retReverse('${this.retEsc(doc.doc_no)}','${doc.ledger}')">${this.t('ret_reverse')}</button>` : '',
      doc.status === 'draft' && canDelete ? `<button class="btn btn-outline" onclick="App.retDelete('${this.retEsc(doc.doc_no)}','${doc.ledger}')">${this.t('ret_delete')}</button>` : '',
    ].filter(Boolean).join(' ');

    const lineRows = (doc.lines || []).map(l => {
      const qty = l.qty;
      const reversed = Math.abs(Number(l.reversed_qty || 0));
      const remain = Math.max(0, Math.abs(Number(qty || 0)) - reversed);
      return `<tr>
        <td>${this.retEsc(l.code || '-')}</td>
        <td>${this.retEsc(l.material_name || '-')}</td>
        <td>${this.retEsc(l.material_spec || '-')}</td>
        <td>${this.retEsc(l.material_unit || '')}</td>
        <td class="text-right">${this.qtyCell(d * Math.abs(Number(qty || 0)))}</td>
        ${showPrice ? `<td class="text-right">${this.fmtMoney(doc.ledger === 'inbound' ? l.price : l.cost_price)}</td>
        <td class="text-right">${this.fmtMoney(doc.ledger === 'inbound' ? l.amount : l.cost_amount)}</td>` : ''}
        <td class="text-right">${this.qtyCell(d * reversed)}</td>
        <td class="text-right">${this.qtyCell(d * remain)}</td>
      </tr>`;
    }).join('');

    const revRows = (doc.reversals || []).map(r => `<tr>
      <td><span class="action-link" onclick="App.${doc.ledger === 'inbound' ? 'openInboundDoc' : 'openOutboundDoc'}('${this.retEsc(r.doc_no)}')">${this.retEsc(r.doc_no)}</span></td>
      <td>${this.fmtDate(r.date)}</td>
      <td>${this.retStatusBadge(r.status)}</td>
    </tr>`).join('');

    return `<div class="pu-edit-bar">
        <span class="action-link" onclick="App.retBackToList()">← ${this.t('ret_back')}</span>
        <span>${this.retEsc(doc.doc_no)} ${this.retStatusBadge(doc.status)}</span>
      </div>
      <div class="pu-card">
        <div class="pu-card-title"><span>01</span><div>${this.t('ret_detail')}</div></div>
        <div class="form-grid" style="max-width:none">
          <div class="form-group"><label>${this.t('ret_no')}</label><div>${this.retEsc(doc.doc_no)}</div></div>
          <div class="form-group"><label>${this.t('ret_date')}</label><div>${this.fmtDate(doc.date)}</div></div>
          <div class="form-group"><label>${this.t('ret_subtype')}</label><div>${this.retEsc(doc.sub_type)}</div></div>
          <div class="form-group"><label>${this.t('ret_party')}</label><div>${this.retEsc(doc.party || '-')}</div></div>
          <div class="form-group"><label>${this.t('ret_ref')}</label><div>${this.retEsc(doc.ref_no || '-')}</div></div>
          <div class="form-group"><label>${this.t('ret_handler')}</label><div>${this.retEsc(doc.handler || '-')}</div></div>
          <div class="form-group"><label>${this.t('ret_qty')}</label><div>${this.qtyCell(d * s.total_qty)}</div></div>
          ${showPrice ? `<div class="form-group"><label>${this.t('ret_amount')}</label><div>${this.fmtMoney(s.total_amount)}</div></div>` : ''}
          <div class="form-group"><label>${this.t('ret_reversed')}</label><div>${this.qtyCell(d * s.reversed_qty)}</div></div>
          <div class="form-group"><label>${this.t('ret_remaining')}</label><div>${this.qtyCell(d * s.remaining_qty)}</div></div>
          <div class="form-group" style="grid-column:1/-1"><label>${this.t('ibd_remarks')}</label><div>${this.retEsc(doc.remarks || '-')}</div></div>
        </div>
        <div style="padding:12px 0 0;color:var(--text-muted);font-size:12px">
          ${s.remaining_qty <= 0 ? this.t('ret_reversed_full') : (s.reversed_qty > 0 ? this.t('ret_reversed_partial') : this.t('ret_no_reversal'))}
          ${doc.ledger === 'outbound' ? ' · ' + this.t('ret_origin_hint') : ''}
        </div>
      </div>
      ${actionBtns ? `<div class="pu-edit-actions">${actionBtns}</div>` : ''}
      <div class="pu-card">
        <div class="pu-card-title"><span>02</span><div>${this.t('ret_lines')}</div></div>
        <div class="table-wrap"><table><thead><tr>
          <th>${this.t('po_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th><th>${this.t('mat_unit')}</th>
          <th class="text-right">${this.t('ret_qty')}</th>
          ${showPrice ? `<th class="text-right">${this.t('ledger_price')}</th><th class="text-right">${this.t('ledger_amount')}</th>` : ''}
          <th class="text-right">${this.t('ret_reversed')}</th><th class="text-right">${this.t('ret_remaining')}</th>
        </tr></thead><tbody>${lineRows || `<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">${this.t('ret_empty')}</td></tr>`}</tbody></table></div>
      </div>
      <div class="pu-card">
        <div class="pu-card-title"><span>03</span><div>${this.t('ret_reversal_docs')}</div></div>
        <div class="table-wrap"><table><thead><tr>
          <th>${this.t('ret_no')}</th><th>${this.t('ret_date')}</th><th>${this.t('ret_status')}</th>
        </tr></thead><tbody>${revRows || `<tr><td colspan="3" style="text-align:center;color:var(--text-muted)">${this.t('ret_no_reversal')}</td></tr>`}</tbody></table></div>
      </div>`;
  },

  retBackToList() {
    this.retLoadList();
  },

  async retConfirm(docNo, ledger) {
    if (!confirm(this.t('ret_confirm_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo) + '/confirm', { method: 'POST' });
      this.toast(this.t('ret_confirmed'));
      await this.retOpenDoc(docNo);
    } catch (e) {
      this.toast(e.message || this.t('ret_confirm_failed'), 'error');
    }
  },

  async retDelete(docNo, ledger) {
    if (!confirm(this.t('ret_delete_ask'))) return;
    const url = ledger === 'inbound' ? '/api/inbound-docs/' : '/api/outbound-docs/';
    try {
      await this.api(url + encodeURIComponent(docNo), { method: 'DELETE' });
      this.toast(this.t('deleted'));
      this.retLoadList();
    } catch (e) {
      this.toast(e.message || this.t('requestFailed'), 'error');
    }
  },

  retReverse(docNo, ledger) {
    return ledger === 'inbound' ? this.showReversalPage(docNo) : this.showOutboundReversalPage(docNo);
  },
});
