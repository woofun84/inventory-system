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

    // ---------- 日志详情解析与渲染 ----------
    // 写入方有两种格式：detail_json={key,params}（结构化文案），detail=JSON 对象或纯文本。
    // 统一解析成 { kind: 'empty'|'obj'|'text'|'text-key' }，解析失败一律降级为原始文本。
    auditDetailModel(r) {
      const rawJson = String((r && r.detail_json) || '').trim();
      if (rawJson) {
        try {
          const o = JSON.parse(rawJson);
          if (o && typeof o === 'object' && typeof o.key === 'string' && o.key) {
            return { kind: 'text-key', key: o.key, params: o.params || {} };
          }
          if (o && typeof o === 'object' && !Array.isArray(o)) return { kind: 'obj', obj: o };
        } catch (_) { /* 继续按 detail 纯文本解析 */ }
      }
      const raw = String((r && r.detail) || '').trim();
      if (!raw) {
        // detail 为空但 detail_json 是坏数据：原样展示，避免整行为空
        return rawJson ? { kind: 'text', text: rawJson, invalid: true } : { kind: 'empty' };
      }
      if (raw[0] === '{' || raw[0] === '[') {
        try {
          const o = JSON.parse(raw);
          if (o && typeof o === 'object' && !Array.isArray(o)) return { kind: 'obj', obj: o };
          // 合法 JSON 但不是对象（如 []）→ 按原始文本展示
          return { kind: 'text', text: raw, loose: true };
        } catch (_) {
          return { kind: 'text', text: raw, invalid: true };
        }
      }
      // 裸 JSON 标量（历史数据出现过 0 / null / true）
      if (/^(0|null|true|false|-?\d+(?:\.\d+)?)$/i.test(raw)) return { kind: 'text', text: raw, loose: true };
      return { kind: 'text', text: raw };
    },

    _auditScalar(v) {
      if (v == null || typeof v === 'object') return '';
      return String(v);
    },

    // 历史 payload 里 lines 是"[n 项]"摘要字符串，也可能是数组
    auditLineCount(v) {
      if (typeof v === 'number' && isFinite(v)) return v;
      if (Array.isArray(v)) return v.length;
      if (typeof v === 'string') {
        const m = v.match(/^\[(\d+)/);
        if (m) return Number(m[1]);
      }
      return null;
    },

    auditDocLabel(m) {
      const k = 'audit_doc_' + m, v = this.t(k);
      return v === k ? '' : v;
    },
    auditFieldLabel(k) {
      const key = 'audit_fld_' + k, v = this.t(key);
      return v === key ? k : v;
    },
    // 部分枚举以中文原值入库（单据类型、存货状态等），英文界面需翻译；
    // 只在精确匹配时替换，用户自由文本（备注、供应商名）不受影响。
    auditEnumAlias: {
      '采购入库': 'purchase_in', '零星入库': 'misc_in', '采购退货': 'purchase_return',
      '正常出库': 'normal_out', '领料退库': 'return_in', '盘点单': 'stocktake',
      '盘盈': 'gain', '盘亏': 'loss', '其它': 'other', '期初结存': 'opening',
      '正常': 'normal', '补货': 'restock', '缺货': 'out_of_stock', '停用': 'disabled',
      '已到货': 'arrived', '未到货': 'not_arrived', '部分到货': 'partial',
      '无明细': 'no_detail', '已关闭': 'closed', '已取消': 'cancelled',
    },
    auditEnumLabel(v) {
      const raw = String(v);
      const code = this.auditEnumAlias[raw] || raw.replace(/-/g, '_');
      const k = 'audit_val_' + code, label = this.t(k);
      return label === k ? null : label;
    },

    auditPlainValue(v) {
      if (v == null) return '';
      if (typeof v === 'boolean') return this.t(v ? 'audit_val_yes' : 'audit_val_no');
      if (Array.isArray(v)) return v.map(x => this.auditPlainValue(x)).join('、');
      if (typeof v === 'object') {
        return Object.keys(v).map(k => this.auditFieldLabel(k) + ' ' + this.auditPlainValue(v[k])).join('、');
      }
      const mapped = this.auditEnumLabel(v);
      return mapped == null ? String(v) : mapped;
    },

    // 无 payload 时按模块 + 动作拼摘要（覆盖历史上 detail 为空的记录）
    auditActionSummary(r) {
      const t = (k, v) => this.t(k, v);
      if (r.module === 'auth') return t(r.action === 'change-password' ? 'audit_sum_change_pwd' : 'audit_sum_login');
      if (r.module === 'settings') {
        if (r.action === 'backup') return t('audit_sum_backup');
        if (r.action === 'restore') return t('audit_sum_restore');
        if (r.action === 'reset') return t('audit_sum_reset');
        if (r.action === 'create' || r.action === 'update') return t('audit_sum_settings');
      }
      const label = this.auditDocLabel(r.module) || this.auditModuleLabel(r.module);
      const docPart = r.target ? ' ' + r.target : '';
      const key = {
        create: 'audit_sum_create', update: 'audit_sum_update', delete: 'audit_sum_delete',
        confirm: 'audit_sum_confirm', void: 'audit_sum_void', load: 'audit_sum_load',
      }[r.action];
      if (key) return t(key, { label, docPart, doc: r.target || '', orig: r.target || '', new: '' });
      return [this.auditActionLabel(r.action), label, r.target].filter(Boolean).join(' ');
    },

    // 有 payload 时按动作类型挑选真实字段拼摘要
    auditObjectSummary(r, o) {
      const t = (k, v) => this.t(k, v);
      const m = r.module, a = r.action;
      const keys = Object.keys(o || {});
      if (!keys.length) return this.auditActionSummary(r);
      const seg = this.lang === 'zh' ? '，' : ', ';
      const label = this.auditDocLabel(m) || this.auditModuleLabel(m);
      const extras = [];
      const date = this._auditScalar(o.date);
      if (date) extras.push(t('audit_sum_biz_date', { date }));
      const n = this.auditLineCount(o.lines);
      if (n != null) extras.push(t('audit_sum_lines', { n }));
      const withExtras = s => s + (extras.length ? seg + extras.join(seg) : '');
      const actKey = {
        create: 'audit_sum_create', update: 'audit_sum_update',
        delete: 'audit_sum_delete', confirm: 'audit_sum_confirm',
      }[a] || 'audit_sum_update';
      const withDoc = doc => t(actKey, { label, docPart: doc ? ' ' + doc : '' });

      if (m === 'materials') {
        const code = this._auditScalar(o.code) || r.target || '';
        const name = this._auditScalar(o.name);
        return withDoc(code + (code && name ? ' · ' + name : ''));
      }
      if (m === 'users') return withDoc(this._auditScalar(o.username) || r.target || '');
      if (m === 'auth') return this.auditActionSummary(r);
      if (m === 'settings') return this.auditActionSummary(r);
      if (m === 'stocktake') {
        const doc = r.target || '';
        if (a === 'load') {
          const scope = this._auditScalar(o.scope);
          const k = scope === 'all' ? 'audit_sum_load_all'
            : scope === 'category' ? 'audit_sum_load_category'
              : scope === 'specified' ? 'audit_sum_load_specified' : 'audit_sum_load';
          return t(k, { label, doc });
        }
        if (a === 'create') return withExtras(withDoc(''));
        if (a === 'update') return withExtras(withDoc(doc));
        return withDoc(doc);
      }
      if (m === 'inbound' || m === 'outbound' || m === 'returns' || m === 'purchase') {
        if (a === 'void') {
          const orig = this._auditScalar(o.original_doc_no) || r.target || '';
          const nd = this._auditScalar(o.new_doc_no);
          const s = (o.action === 'void-reopen' || nd)
            ? t('audit_sum_void_reopen', { label, orig, new: nd || '—' })
            : t('audit_sum_void_only', { label, doc: orig });
          const rr = Number(o.retargeted_returns);
          if (rr > 0) extras.push(t('audit_sum_retarget', { n: rr }));
          return withExtras(s);
        }
        const doc = this._auditScalar(o.doc_no) || this._auditScalar(o.po_no) || r.target || '';
        return withExtras(withDoc(doc));
      }
      // 未知模块：按字段拼可读文本，避免回落到原始 JSON
      const pairs = keys.filter(k => {
        const v = o[k];
        if (v === '' || v == null) return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'object') return Object.keys(v).length > 0;
        return true;
      }).map(k => this.auditFieldLabel(k) + ': ' + this.auditPlainValue(o[k]));
      return pairs.length ? pairs.join(seg) : this.auditActionSummary(r);
    },

    auditSummary(r) {
      const m = this.auditDetailModel(r);
      if (m.kind === 'text-key') return this.logDetailText(r) || this.auditActionSummary(r);
      if (m.kind === 'obj') return this.auditObjectSummary(r, m.obj);
      if (m.kind === 'text') return (m.invalid || m.loose) ? this.auditActionSummary(r) : m.text;
      return this.auditActionSummary(r);
    },

    // 详情里的值：空值/布尔/数字/数组/嵌套对象都有明确呈现
    auditValueHtml(v) {
      const nil = '<span class="audit-nil">—</span>';
      if (v == null || v === '') return nil;
      if (typeof v === 'boolean') return escHtml(this.t(v ? 'audit_val_yes' : 'audit_val_no'));
      if (typeof v === 'number') return escHtml(String(v));
      if (typeof v === 'string') {
        const mapped = this.auditEnumLabel(v);
        return `<span class="audit-val">${escHtml(mapped == null ? v : mapped)}</span>`;
      }
      if (Array.isArray(v)) {
        if (!v.length) return nil;
        if (v.every(x => x == null || typeof x !== 'object')) {
          return escHtml(v.map(x => this.auditPlainValue(x)).join('、'));
        }
        return v.map((x, i) => `<div class="audit-sub"><div class="audit-sub-h">#${i + 1}</div>${this.auditFieldsHtml(x)}</div>`).join('');
      }
      if (typeof v === 'object') {
        const ks = Object.keys(v);
        if (!ks.length) return nil;
        const allObj = ks.every(k => v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]));
        if (allObj) {
          return ks.map(k => `<div class="audit-sub"><div class="audit-sub-h">${escHtml(k)}</div>${this.auditFieldsHtml(v[k])}</div>`).join('');
        }
        const allScalar = ks.every(k => v[k] == null || typeof v[k] !== 'object');
        if (allScalar) {
          return escHtml(ks.map(k => `${k} ${this.auditPlainValue(v[k])}`).join('、'));
        }
        return this.auditFieldsHtml(v);
      }
      return escHtml(String(v));
    },

    auditFieldsHtml(obj) {
      const ks = Object.keys(obj || {});
      if (!ks.length) return '<span class="audit-nil">—</span>';
      return `<dl class="audit-kv">${ks.map(k =>
        `<dt>${escHtml(this.auditFieldLabel(k))}</dt><dd>${this.auditValueHtml(obj[k])}</dd>`).join('')}</dl>`;
    },

    showAuditDetail(id) {
      const rows = (this._auditData && this._auditData.rows) || [];
      const r = rows.find(x => String(x.id) === String(id));
      if (!r) return;
      const m = this.auditDetailModel(r);
      const ok = Number(r.status) < 400;
      const who = [r.username, r.name].filter(Boolean).join(' · ') || '—';
      const meta = [
        [this.t('audit_col_time'), this.fmtDateTime(r.created_at, true) || '—'],
        [this.t('audit_col_user'), who],
        [this.t('audit_col_module'), this.auditModuleLabel(r.module)],
        [this.t('audit_col_action'), this.auditActionLabel(r.action)],
        [this.t('audit_col_target'), r.target || '—'],
        [this.t('audit_col_result'), ok ? this.t('audit_ok') : this.t('audit_fail') + ' ' + (r.status || '')],
        [this.t('audit_col_ip'), r.ip || '—'],
      ];
      const metaHtml = `<dl class="audit-kv">${meta.map(([k, v]) =>
        `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl>`;
      let content;
      if (m.kind === 'obj') content = this.auditFieldsHtml(m.obj);
      else if (m.kind === 'text-key') content = `<div class="audit-val">${escHtml(this.logDetailText(r) || '—')}</div>`;
      else if (m.kind === 'text') {
        content = `${(m.invalid || m.loose) ? `<p class="audit-note">${escHtml(this.t('audit_detail_invalid'))}</p>` : ''}<pre class="audit-raw">${escHtml(m.text)}</pre>`;
      } else content = '<span class="audit-nil">—</span>';
      const body = `<h4 class="audit-sec-title">${escHtml(this.t('audit_detail_meta'))}</h4>${metaHtml}
        <h4 class="audit-sec-title">${escHtml(this.t('audit_detail_content'))}</h4>${content}`;
      this.showModal(`<h3>${escHtml(this.t('audit_detail_title'))}</h3>`, body, this.t('close'), () => this.closeModal());
      const cancelBtn = document.getElementById('modal-cancel-btn');
      if (cancelBtn) cancelBtn.style.display = 'none';
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
        ${this.user && this.user.role === 'admin'
          ? `<button class="btn btn-danger-outline btn-sm" onclick="App.confirmClearAuditLogs()">${this.t('audit_clear_btn')}</button>`
          : ''}
      </div>`;
    },

    // 清空全部日志：破坏性二次确认（危险 intent），后端同样只允许管理员
    confirmClearAuditLogs() {
      this.confirmDialog(
        this.t('audit_clear_confirm_title'),
        this.t('audit_clear_confirm_msg'),
        () => this.doClearAuditLogs(),
        null,
        'danger',
      );
    },

    async doClearAuditLogs() {
      try {
        const data = await this.api('/api/audit-logs', 'DELETE');
        // 日志已清空：重置筛选并回到第一页，避免停在已无数据的页码/筛选条件上
        this._auditFilter = { module: '', action: '', keyword: '', from: '', to: '' };
        this.getTableState('audit').page = 1;
        this.toast(this.t('audit_clear_done', { n: data.deleted || 0 }));
        await this.renderAuditLogs();
      } catch (e) {
        this.toast(e.message, 'error');
      }
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
      const thHtml = headers.map(k => `<th${k === 'audit_col_result' ? ' class="text-center"' : ''}>${this.t(k)}</th>`).join('');
      let tbody;
      if (!rows.length) {
        tbody = this.emptyRow(headers.length);
      } else {
        tbody = rows.map(r => {
          const summary = String(this.auditSummary(r) || '');
          const detailCell = summary
            ? `<div class="audit-detail-cell" title="${escHtml(summary)}" onclick="App.showAuditDetail(${Number(r.id)})">${escHtml(summary)}</div>`
            : '<span class="audit-nil">—</span>';
          const ok = Number(r.status) < 400;
          const resultCell = ok
            ? `<span class="badge badge-success">${this.t('audit_ok')}</span>`
            : `<span class="badge badge-danger">${this.t('audit_fail')} ${escHtml(r.status)}</span>`;
          const roleCell = r.role ? this.roleLabel(r.role) : '';
          return `<tr>
            <td style="white-space:nowrap">${this.fmtDateTime(r.created_at, true)}</td>
            <td><strong>${escHtml(r.username || '-')}</strong>${r.name ? `<div style="color:var(--text-muted);font-size:12px">${escHtml(r.name)} · ${escHtml(roleCell)}</div>` : ''}</td>
            <td>${escHtml(this.auditModuleLabel(r.module))}</td>
            <td>${escHtml(this.auditActionLabel(r.action))}</td>
            <td>${escHtml(r.target || '')}</td>
            <td>${detailCell}</td>
            <td class="text-center">${resultCell}</td>
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
