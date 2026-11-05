/**
 * 采购管理 —— 采购单 / 合同 / 采购明细
 *
 * 交互范式（参考采购管理模板，配色映射项目 CSS 变量）：
 *   - 单页三段式：页签（采购单 / 合同 / 采购明细）+ 条件区 + 列表
 *   - 列表右侧 sticky 详情栏（.pu-split.open），点行即在右侧展开，不跳页
 *   - 详情子页签带计数；明细以手风琴卡片呈现（行内进度条、展开出到货履历/编辑/删除）
 *   - KPI 状态胶囊（可点击筛选 + 计数）；底部合计 + 分页
 *   - 删除可撤销（toast 内「撤销」）；支持 / 搜索、↑↓ 选行、Enter 打开、Esc 关闭
 *
 * 信息架构：
 *   采购单  → 一张单一行，右侧详情（明细 / 入库 / 日志）
 *   合同    → 合同档案，右侧详情（明细 / 采购单 / 入库 / 日志）
 *   采购明细→ 行级综合查询，点行下钻到所属采购单详情
 *
 * 数据来源：/api/purchase/*（见 server/routes/purchase.js）
 * 到货口径：入库按 order_line_id 精确核销，回退「采购单 + 物料 + 有效合同号」
 * 采购单 ↔ 合同为多对多：明细行 order_lines.contract_no 才是真实归属，
 *   采购单头的 contract_no 仅作新建明细时带出的「默认合同」。
 */
Object.assign(App, {
  // ========== 页面样式（配色统一映射到项目 CSS 变量） ==========
  injectPurchaseStyles() {
    if (document.getElementById('purchase-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'purchase-ui-styles';
    style.textContent = `
      /* --- 页头：视图页签（下划线风格，横向铺满） --- */
      .pu-viewtabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--border)}
      .pu-viewtab{border:0;background:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:10px 14px;color:var(--text-muted);font-size:13px;cursor:pointer;white-space:nowrap;font-family:inherit}
      .pu-viewtab:hover{color:var(--text)}
      .pu-viewtab[aria-selected=true]{color:var(--primary);font-weight:600;border-bottom-color:var(--primary)}

      /* --- 条件区 + 主操作：一行铺满 --- */
      .pu-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 0}
      .pu-filter-inner{display:contents}
      .pu-head-actions{margin-left:auto;display:flex;gap:8px}
      .pu-search{position:relative;flex:1 1 280px;min-width:200px}
      .pu-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--text-muted);pointer-events:none}
      .pu-search input{width:100%;height:34px;padding:0 12px 0 34px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card-bg);color:var(--text);font-size:13px;font-family:inherit}
      .pu-daterange{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 8px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius-sm)}
      .pu-daterange label{color:var(--text-muted);font-size:12px;white-space:nowrap}
      .pu-daterange input[type=date]{width:118px;background:transparent;border:0;color:var(--text);font-size:13px;font-family:inherit}
      .pu-toolbar input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
      .pu-sep{color:var(--text-muted);font-size:12px}

      /* --- 状态统计条（栅格卡片，左标签右计数） --- */
      .pu-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:0 0 12px}
      .pu-kpi{display:flex;align-items:center;justify-content:space-between;gap:10px;height:44px;padding:0 14px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-muted);font-size:13px;font-family:inherit;text-align:left}
      button.pu-kpi{cursor:pointer}
      .pu-kpi small{color:var(--text-muted);font-size:13px}
      .pu-kpi strong{color:var(--text);font-size:16px;font-variant-numeric:tabular-nums}
      .pu-kpi.warn strong{color:var(--warning)}
      .pu-kpi[aria-pressed=true]{border-color:var(--primary);background:var(--primary-light);color:var(--text)}

      /* --- 列表 + 右侧详情栏 --- */
      /* 页面整体滚动（.page-body 为滚动容器），表头 sticky 在滚动到页面顶端时吸顶；
         不能在 .data-scroll 上再做内部滚动，否则移动端工具栏会占满屏幕、数据无空间 */
      /* 去掉滚动容器顶部内边距，让吸顶表头与页面主标题严丝合缝（原 20px 会变成缝隙）；
         该内边距下沉到 #pu-root，未吸顶时的视觉与原布局一致 */
      .page-body.pu-page-body{padding-top:0;padding-bottom:0}
      #pu-root{padding-top:20px}
      .pu-split{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
      .pu-split.open{grid-template-columns:minmax(0,1fr) 480px}
      .pu-split .data-scroll{overflow:visible}
      .pu-insp{position:sticky;top:0;max-height:calc(100vh - 140px);overflow:hidden;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);display:flex;flex-direction:column}
      .pu-insp[hidden]{display:none}
      /* 展开（wide）时隐藏列表，并让详情栏独占整行 —— 避免右侧残留空白 */
      .pu-split.wide{grid-template-columns:minmax(0,1fr)}
      .pu-split.wide .pu-list{display:none}
      .pu-split.wide .pu-insp{position:static;max-height:none}
      .pu-split.wide .pu-insp-meta{grid-template-columns:repeat(4,minmax(0,1fr))}
      .pu-lk{background:none;border:0;padding:0;color:var(--primary);font-weight:600;cursor:pointer;font-size:13px;font-family:inherit;text-align:left}
      .pu-lk:hover{text-decoration:underline}
      .pu-lk.danger{color:var(--danger)}
      .pu-lk.plain{color:var(--text-muted);font-weight:500}
      .pu-row{cursor:pointer}
      .pu-row.sel>td{background:var(--primary-light)}
      .pu-row.sel>td:first-child{box-shadow:inset 3px 0 0 var(--primary)}

      /* --- 徽章 / 进度 --- */
      .pu-badge{display:inline-flex;gap:5px;align-items:center}
      .pu-rate{display:inline-flex;gap:8px;align-items:center;font-size:12px;font-variant-numeric:tabular-nums}
      .pu-bar{display:inline-block;width:64px;height:8px;border-radius:4px;background:var(--bg);overflow:hidden}
      .pu-bar i{display:block;height:100%;background:var(--primary)}
      .pu-mu{color:var(--text-muted)}

      /* --- 详情栏内部 --- */
      .pu-insp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:12px 10px 8px 16px}
      .pu-insp-head h2{font-size:18px;font-weight:700;margin:0 0 2px;font-family:inherit}
      .pu-insp-head small{color:var(--text-muted);font-size:12px}
      .pu-insp-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin:0 16px 12px}
      .pu-insp-meta div{display:flex;flex-direction:column;min-width:0}
      .pu-insp-meta dt{color:var(--text-muted);font-size:12px}
      .pu-insp-meta dd{margin:0;font-weight:600;font-size:13px;overflow-wrap:anywhere}
      .pu-prog-wrap{padding:0 16px 12px}
      .pu-rate-row{display:flex;justify-content:space-between;gap:8px;font-size:13px}
      .pu-prog{height:10px;border-radius:5px;background:var(--bg);overflow:hidden;margin-top:6px}
      .pu-prog i{display:block;height:100%;background:var(--success)}
      .pu-dtabs{display:flex;gap:4px;margin:0 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
      .pu-dtab{padding:7px 12px;border:0;background:none;border-bottom:3px solid transparent;color:var(--text-muted);font-size:13px;cursor:pointer;margin-bottom:-1px;white-space:nowrap;font-family:inherit}
      .pu-dtab:hover{color:var(--primary)}
      .pu-dtab[aria-selected=true]{color:var(--primary);border-bottom-color:var(--primary);font-weight:700}
      /* 详情主体自行滚动：头部/页签/底部按钮固定，明细行在中间滚动 —— 避免按钮被顶到列表中间 */
      .pu-dpanel{padding:12px 16px;flex:1 1 auto;min-height:0;overflow:auto}
      .pu-insp-foot{flex:0 0 auto;background:var(--card-bg);border-top:1px solid var(--border);padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap}
      .pu-mback{display:none;margin:12px 16px 0;align-self:flex-start}

      /* --- 明细手风琴 --- */
      .pu-lqtoolbar{position:sticky;top:0;background:var(--card-bg);z-index:2;padding:4px 0 8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .pu-lqtoolbar input{flex:1;min-width:140px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card-bg);color:var(--text);font-size:13px;font-family:inherit}
      .pu-chips{display:flex;gap:6px}
      .pu-chip{border:1px solid var(--border);background:var(--card-bg);border-radius:99px;padding:3px 12px;font-size:12px;cursor:pointer;color:var(--text-muted);font-family:inherit}
      .pu-chip[aria-pressed=true]{background:var(--primary);color:#fff;border-color:var(--primary)}
      .pu-lines{list-style:none;margin:0;padding:0}
      .pu-line{border-bottom:1px solid var(--border)}
      .pu-line:last-child{border-bottom:0}
      .pu-line-h{display:flex;width:100%;align-items:center;gap:8px;border:0;background:none;padding:6px 2px;text-align:left;min-height:40px;cursor:pointer;color:var(--text);font-family:inherit;font-size:13px}
      .pu-line-h:hover{background:var(--primary-light)}
      .pu-line-h::before{content:"▸";color:var(--text-muted);width:1em;flex-shrink:0}
      .pu-line-h[aria-expanded=true]::before{content:"▾"}
      .pu-line-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pu-line-q{font-variant-numeric:tabular-nums;color:var(--text-muted);font-size:12px}
      .pu-line-bar{height:3px;background:var(--bg);margin:0 0 6px 1.4em}
      .pu-line-bar i{display:block;height:100%;background:var(--primary)}
      .pu-line-d{padding:2px 4px 10px 1.4em;display:flex;flex-direction:column;gap:4px;font-size:12px}
      .pu-line-acts{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
      .pu-odm{color:var(--danger);font-weight:700}
      .pu-more{width:100%;margin-top:10px}
      .pu-cnt{margin:2px 0 4px;font-size:12px;color:var(--text-muted)}

      /* --- 列表条目（入库 / 采购单）与日志 --- */
      .pu-items{list-style:none;margin:0;padding:0}
      .pu-item{border-bottom:1px solid var(--border);padding:10px 0;display:flex;flex-direction:column;gap:4px}
      .pu-item:last-child{border-bottom:0}
      .pu-item-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
      .pu-log{list-style:none;margin:0;padding:0}
      .pu-log li{display:grid;grid-template-columns:12px minmax(0,1fr);gap:12px;padding-bottom:14px}
      .pu-log li::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--primary);margin-top:6px}
      .pu-log-meta{font-size:12px;color:var(--text-muted)}
      .pu-empty{padding:28px;text-align:center;border:1px dashed var(--border);border-radius:8px;color:var(--text-muted);font-size:13px}

      /* --- 分页：内容超出视口时吸附到底部（贴底不留间隙），未超出时随内容排在末尾 --- */
      .pu-pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap;margin-top:8px;padding:5px 0;font-size:12px;line-height:1.2;color:var(--text-muted);background:var(--card-bg);border-top:1px solid var(--border)}
      .pu-pager.pin{position:sticky;bottom:0;z-index:5}
      .pu-pager:empty{display:none;border-top:0}
      .pu-pager .btn{height:26px;padding:0 10px;font-size:12px;line-height:1}
      .pu-pager select{height:26px;padding:2px 6px;border:1px solid var(--border);border-radius:4px;background:var(--card-bg);color:var(--text);font-size:12px}
      .pu-pager label{display:inline-flex;align-items:center;gap:4px}
      .pu-pager .pu-tot{margin-right:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      /* --- 紧凑行距 --- */
      #pu-root.pu-dense .table-wrap tbody td{padding:4px 10px;height:auto}
      #pu-root.pu-dense .table-wrap thead th{padding:6px 10px;height:auto}

      /* --- 右侧抽屉（到货履历） --- */
      .pu-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:1100;display:flex;justify-content:flex-end}
      .pu-drawer{background:var(--card-bg);width:min(560px,100%);height:100%;display:flex;flex-direction:column;border-left:1px solid var(--border);animation:puSlide .18s ease-out}
      @keyframes puSlide{from{transform:translateX(24px);opacity:.6}to{transform:none;opacity:1}}
      .pu-drawer-h{display:flex;justify-content:space-between;align-items:center;padding:12px 12px 12px 20px;border-bottom:1px solid var(--border)}
      .pu-drawer-h h3{margin:0;font-size:16px;font-family:inherit}
      .pu-drawer-b{padding:16px 20px;overflow:auto;flex:1}

      /* --- 可撤销删除的 toast --- */
      .pu-toast-undo{display:flex;align-items:center;gap:14px}
      .pu-toast-undo button{background:none;border:0;color:inherit;text-decoration:underline;font-weight:700;cursor:pointer;font-family:inherit;font-size:14px}

      /* --- 采购单编辑页（新建 / 整单编辑） --- */
      .pu-edit-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
      .pu-card{background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:14px}
      .pu-card-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;margin-bottom:14px}
      .pu-card-title span{display:grid;place-items:center;width:26px;height:26px;border-radius:7px;background:var(--primary-light);color:var(--primary);font-size:12px;font-weight:700}
      .pu-card-title small{font-weight:400;color:var(--text-muted);font-size:12px}
      .pu-edit-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .pu-edit-sum{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--text-muted);margin-top:12px}
      .pu-edit-lines input,.pu-edit-lines select{width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card-bg);color:var(--text);font-size:13px;font-family:inherit}
      .pu-edit-lines input:focus,.pu-edit-lines select:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
      .pu-edit-lines td{vertical-align:middle}
      .pu-edit-amt{font-variant-numeric:tabular-nums;text-align:right;color:var(--text-muted);white-space:nowrap}
      .pu-edit-del{background:none;border:0;color:var(--danger);cursor:pointer;font-size:13px;font-family:inherit;padding:0}
      .pu-edit-del:hover{text-decoration:underline}
      /* 明细物料筛选条：类别下拉 + 编码/名称/规格/品牌 模糊筛选 */
      .pu-matfilter{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
      .pu-matfilter label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)}
      .pu-matfilter select,.pu-matfilter input{padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card-bg);color:var(--text);font-size:13px;font-family:inherit}
      .pu-matfilter input{flex:1;min-width:180px}
      .pu-matfilter select:focus,.pu-matfilter input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-light)}
      .pu-matfilter .pu-mu{font-size:12px;font-variant-numeric:tabular-nums}

      /* --- 响应式 --- */
      @media(max-width:1400px){.pu-split.open{grid-template-columns:minmax(0,1fr) 420px}}
      @media(max-width:1000px){
        .pu-split.open{grid-template-columns:minmax(0,1fr)}
        .pu-split.open .pu-list{display:none}
        .pu-insp{position:static;max-height:none}
        .pu-mback{display:inline-flex}
      }
    `;
    document.head.appendChild(style);
  },

  // ========== 小工具 ==========
  puEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  },

  puActionLabel(a) {
    const m = {
      create: this.t('audit_act_create'), update: this.t('audit_act_update'), delete: this.t('audit_act_delete'),
      confirm: this.t('audit_act_confirm'), cancel: this.t('audit_act_cancel'), reverse: this.t('audit_act_reverse'),
      load: this.t('audit_act_load'),
    };
    return m[a] || a;
  },

  puContractStatusBadge(s) {
    const active = !s || s === 'active';
    return `<span class="badge badge-${active ? 'success' : 'muted'}"><span aria-hidden="true">${active ? '●' : '■'}</span>&nbsp;${active ? this.t('pu_status_active') : this.t('pu_status_closed_c')}</span>`;
  },

  // 到货状态徽章（带图形符号，参考模板）
  puDeliveryBadge(s) {
    const m = {
      '未到货': ['○', 'warning', 'st_not_arrived'],
      '部分到货': ['◐', 'info', 'st_partial'],
      '已到货': ['●', 'success', 'st_arrived'],
      '无明细': ['–', 'muted', 'st_no_detail'],
      '已关闭': ['■', 'muted', 'po_status_closed'],
      '已取消': ['✕', 'danger', 'po_status_cancelled'],
    };
    const it = m[s] || m['未到货'];
    return `<span class="badge badge-${it[1]}"><span aria-hidden="true">${it[0]}</span>&nbsp;${this.t(it[2])}</span>`;
  },

  // 采购单状态徽章（草稿 / 已确认）
  puOrderStatusBadge(s) {
    const m = {
      draft: ['warning', 'pu_status_draft'],
      posted: ['success', 'pu_status_posted'],
      cancelled: ['muted', 'pu_status_cancelled'],
    };
    const it = m[s] || m.posted;
    return `<span class="badge badge-${it[0]}">${this.t(it[1])}</span>`;
  },

  // 到货进度条（已到 / 订购）
  puRateBar(recv, qty) {
    const r = Number(recv || 0), q = Number(qty || 0);
    const p = q ? Math.min(100, Math.round(r / q * 100)) : 0;
    return `<span class="pu-rate"><span class="pu-bar" aria-hidden="true"><i style="width:${p}%"></i></span>${this.fmtQty(r)} / ${this.fmtQty(q)}</span>`;
  },

  // 供应商 / 合同 / 物料 下拉与提示数据
  async puLookups() {
    const [suppliers, contracts, materials] = await Promise.all([
      this.api('/api/suppliers').catch(() => []),
      this.api('/api/purchase/contracts').catch(() => []),
      this.api('/api/materials').catch(() => []),
    ]);
    return { suppliers, contracts, materials };
  },

  // ========== 状态 ==========
  puState() {
    if (!this._pu) this._pu = {};
    const s = this._pu;
    if (!s.tab) s.tab = 'orders';
    if (s.view === undefined) s.view = 'list';          // 'list' | 'edit'
    if (s.sel === undefined) s.sel = null;              // { t:'orders'|'contracts', id }
    if (!s.dt) s.dt = 'lines';                          // 详情子页签
    if (s.wide === undefined) s.wide = false;
    if (s.dense === undefined) s.dense = false;
    if (s.kpi === undefined) s.kpi = '';
    if (s.lq === undefined) s.lq = '';
    if (s.lf === undefined) s.lf = '';
    if (s.lim === undefined) s.lim = 15;
    if (!s.ex) s.ex = new Set();
    if (!s.f) s.f = { kw: '', from: '', to: '' };
    if (!this._puDetail) this._puDetail = {};
    if (!this._puList) this._puList = [];
    return s;
  },

  puDetail() {
    const s = this.puState();
    return s.sel ? (this._puDetail[s.sel.t + ':' + s.sel.id] || null) : null;
  },

  // ========== 页面骨架 ==========
  async renderPurchase() {
    const s = this.puState();
    s.view = 'list';
    this.setMain(this.pageWrap('🛒 ' + this.t('pu_title'), this.t('pu_desc'), '', this.puSkeleton()));
    const pb = document.querySelector('.page-body');
    if (pb) pb.classList.add('pu-page-body');
    this.injectPurchaseStyles();
    this.puBindEvents();
    this.puRenderTabs();
    this.puRenderToolbar();
    this.puRenderFilters();
    document.getElementById('pu-root').classList.toggle('pu-dense', !!s.dense);
    await this.loadPurchaseList();
    this.puRenderInspector();
  },

  puSkeleton() {
    return `<div id="pu-root" class="data-page">
      <div class="data-toolbar">
        <nav id="pu-tabs" class="pu-viewtabs" role="tablist" aria-label="${this.t('pu_title')}"></nav>
        <div class="pu-toolbar">
          <div id="pu-filters" class="pu-filter-inner"></div>
          <div id="pu-head-actions" class="pu-head-actions"></div>
        </div>
      </div>
      <div id="pu-kpis" class="pu-kpis" role="group" aria-label="${this.t('pu_delivery')}"></div>
      <div class="pu-split" id="pu-split">
        <section class="pu-list">
          <div class="data-scroll" id="pu-scroll"></div>
          <div class="pu-pager" id="pu-pager"></div>
        </section>
        <aside class="pu-insp" id="pu-insp" hidden aria-label="${this.t('pu_view')}"></aside>
      </div>
    </div>`;
  },

  puRenderTabs() {
    const box = document.getElementById('pu-tabs');
    if (!box) return;
    const s = this.puState();
    const map = [['orders', this.t('pu_tab_orders')], ['contracts', this.t('pu_tab_contracts')], ['lines', this.t('pu_tab_lines')]];
    box.innerHTML = map.map(([k, label]) =>
      `<button type="button" class="pu-viewtab" role="tab" id="pu-tab-${k}" aria-selected="${s.tab === k}" data-pu="tab" data-id="${k}">${label}</button>`
    ).join('');
  },

  puRenderToolbar() {
    const box = document.getElementById('pu-head-actions');
    if (!box) return;
    const s = this.puState();
    let html = '';
    if (s.tab === 'orders' && this.can('purchase', 'create'))
      html = `<button class="btn btn-primary" data-pu="n-order">+ ${this.t('pu_new_order')}</button>`;
    else if (s.tab === 'contracts' && this.can('purchase', 'create'))
      html = `<button class="btn btn-primary" data-pu="n-contract">+ ${this.t('pu_new_contract')}</button>`;
    box.innerHTML = html;
  },

  puRenderFilters() {
    const box = document.getElementById('pu-filters');
    if (!box) return;
    const s = this.puState();
    const ph = s.tab === 'lines' ? this.t('pu_lines_filter_ph')
      : s.tab === 'contracts' ? this.t('pu_contract_filter_ph') : this.t('pu_filter_ph');
    let html = `<div class="pu-search" role="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="pu_f_kw" type="search" value="${this.puEsc(s.f.kw)}" placeholder="${ph}" aria-label="${ph}">
      </div>`;
    if (s.tab !== 'contracts') {
      html += `<div class="pu-daterange" role="group" aria-label="${this.t('pu_date')}">
        <label for="pu_f_from">${this.t('pu_date')}</label>
        <input id="pu_f_from" type="date" value="${this.puEsc(s.f.from)}" aria-label="${this.t('pu_date')}">
        <span class="pu-sep" aria-hidden="true">~</span>
        <input id="pu_f_to" type="date" value="${this.puEsc(s.f.to)}" aria-label="${this.t('pu_date')}">
      </div>`;
    }
    html += `<button type="button" class="btn btn-outline btn-sm" data-pu="clr">${this.t('pu_clear_filter')}</button>
      <button type="button" class="btn btn-outline btn-sm" id="pu-dense-btn" aria-pressed="${!!s.dense}" data-pu="dense">${this.t('pu_dense')}</button>`;
    box.innerHTML = html;
  },

  switchPurchaseTab(tab) {
    const s = this.puState();
    if (s.tab === tab) return;
    s.tab = tab; s.kpi = ''; s.sel = null; s.wide = false;
    const st = this.getTableState('purchase'); st.page = 1; st.sortKey = '';
    this.puRenderTabs();
    this.puRenderToolbar();
    this.puRenderFilters();
    this.loadPurchaseList();
    this.puRenderInspector();
  },

  // ========== 列表 ==========
  async loadPurchaseList() {
    const s = this.puState();
    const p = new URLSearchParams();
    const kw = s.f.kw.trim(), from = s.f.from, to = s.f.to;
    let path = '/api/purchase/';
    if (s.tab === 'orders') {
      path += 'orders';
      if (kw) p.set('keyword', kw);
      if (from) p.set('dateFrom', from); if (to) p.set('dateTo', to);
    } else if (s.tab === 'contracts') {
      path += 'contracts';
      if (kw) p.set('keyword', kw);
    } else {
      path += 'lines';
      if (kw) p.set('keyword', kw);
      if (from) p.set('dateFrom', from); if (to) p.set('dateTo', to);
    }
    const qs = p.toString();
    try {
      this._puList = await this.api(path + (qs ? '?' + qs : ''));
    } catch (e) {
      this._puList = [];
      const scroll = document.getElementById('pu-scroll');
      if (scroll) scroll.innerHTML = `<div class="pu-empty">${this.puEsc(e.message)}</div>`;
      const pg = document.getElementById('pu-pager'); if (pg) pg.innerHTML = '';
      const kp = document.getElementById('pu-kpis'); if (kp) kp.innerHTML = '';
      return;
    }
    this._tableRenderers = this._tableRenderers || {};
    this._tableRenderers['purchase'] = () => this.puRenderList();
    this.puRenderList();
  },

  // KPI 状态定义：[key, label, 计数判定]
  puKpiDefs() {
    const s = this.puState();
    if (s.tab === 'contracts') {
      return [
        ['', this.t('all'), r => true],
        ['active', this.t('pu_status_active'), r => !r.status || r.status === 'active'],
        ['closed', this.t('pu_status_closed_c'), r => r.status === 'closed'],
      ];
    }
    return [
      ['', this.t('all'), r => true],
      ['未到货', this.t('st_not_arrived'), r => this.puRowStatus(r) === '未到货'],
      ['部分到货', this.t('st_partial'), r => this.puRowStatus(r) === '部分到货'],
      ['已到货', this.t('st_arrived'), r => this.puRowStatus(r) === '已到货'],
      ['od', this.t('pu_overdue_only'), r => Number(r.overdue_days || 0) > 0],
    ];
  },

  puRowStatus(r) { return r.delivery_status || r.line_status || ''; },

  puVisibleRows() {
    const s = this.puState();
    const def = this.puKpiDefs().find(d => d[0] === s.kpi);
    return def ? this._puList.filter(def[2]) : this._puList;
  },

  puRenderList() {
    const s = this.puState();
    const kp = document.getElementById('pu-kpis');
    if (kp) {
      kp.innerHTML = this.puKpiDefs().map(([k, label, fn]) =>
        `<button type="button" class="pu-kpi${k === 'od' ? ' warn' : ''}" aria-pressed="${s.kpi === k}" data-pu="kpi" data-id="${k}"><small>${label}</small><strong>${this._puList.filter(fn).length}</strong></button>`
      ).join('');
    }
    const rows = this.puVisibleRows();
    const st = this.getTableState('purchase');
    const sorted = this.sortData(rows, st.sortKey, st.sortDir);
    const pageData = this.paginate(sorted, st.page, st.pageSize);
    const scroll = document.getElementById('pu-scroll');
    if (scroll) {
      scroll.innerHTML = sorted.length
        ? this.puListTable(pageData)
        : `<div class="pu-empty">${this.t('pu_no_result')}<br><span class="pu-mu">${this.puHasFilter() ? this.t('pu_no_result_hint') : this.t('pu_empty_hint')}</span></div>`;
    }
    this.puRenderPager(sorted);
    this.puUpdatePagerSticky();
  },

  puHasFilter() { const s = this.puState(); return !!(s.f.kw || s.f.from || s.f.to || s.kpi); },

  puListTable(pageData) {
    const s = this.puState();
    const vp = this.canViewPrice();
    const tid = 'purchase';
    let cols;
    if (s.tab === 'orders') {
      cols = [
        ['po_no', this.t('pu_po_no_filter'), r => `<button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.puEsc(r.po_no)}">${this.puEsc(r.po_no)}</button>`],
        ['status', this.t('pu_order_status'), r => this.puOrderStatusBadge(r.status)],
        ['date', this.t('pu_date'), r => this.fmtDate(r.date)],
        ['supplier', this.t('pu_supplier'), r => this.puEsc(r.supplier || '')],
        ['contract_display', this.t('pu_contract_filter'), r => this.puContractLinks(r.contract_nos)],
        ['line_count', this.t('pu_line_count'), r => r.line_count, true],
        ['received_qty', this.t('pu_progress'), r => this.puRateBar(r.received_qty, r.order_qty)],
        ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
        ['delivery_status', this.t('pu_delivery'), r => this.puDeliveryBadge(r.delivery_status)],
        ['overdue_days', this.t('pu_overdue'), r => r.overdue_days || '', true],
        ['expected_date', this.t('pu_expected'), r => this.fmtDate(r.expected_date)],
      ];
    } else if (s.tab === 'contracts') {
      cols = [
        ['contract_no', this.t('pu_contract_no'), r => `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.puEsc(r.contract_no)}">${this.puEsc(r.contract_no)}</button>`],
        ['name', this.t('pu_contract_name'), r => this.puEsc(r.name || '')],
        ['supplier', this.t('pu_supplier'), r => this.puEsc(r.supplier || '')],
        ['sign_date', this.t('pu_sign_date'), r => this.fmtDate(r.sign_date)],
        ['amount', this.t('pu_contract_amount'), r => this.fmtMoney(r.amount), true, vp],
        ['po_count', this.t('pu_po_count'), r => r.po_count, true],
        ['line_count', this.t('pu_line_count'), r => r.line_count, true],
        ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
        ['receive_rate', this.t('pu_receive_rate'), r => r.receive_rate + '%', true],
        ['status', this.t('pu_status'), r => this.puContractStatusBadge(r.status)],
      ];
    } else {
      cols = [
        ['po_no', this.t('pu_po_no_filter'), r => `<button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.puEsc(r.po_no)}">${this.puEsc(r.po_no)}</button>`],
        ['code', this.t('pu_material'), r => `${this.puEsc(r.code)} ${this.puEsc(r.material_name || '')}<br><span class="pu-mu">${this.puEsc(r.material_spec || '')}</span>`],
        ['contract_no_eff', this.t('pu_contract_filter'), r => r.contract_no_eff ? `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.puEsc(r.contract_no_eff)}">${this.puEsc(r.contract_no_eff)}</button>` : '<span class="pu-mu">–</span>'],
        ['received_qty', this.t('pu_progress'), r => this.puRateBar(r.received_qty, r.order_qty)],
        ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
        ['line_status', this.t('pu_line_status'), r => this.puDeliveryBadge(r.line_status)],
        ['overdue_days', this.t('pu_overdue'), r => r.overdue_days || '', true],
      ];
    }
    const shown = cols.filter(c => c[4] !== false);
    const th = shown.map(c => this.sortTh(c[1], c[0], tid, c[3])).join('');
    const sid = this.puRowIdKey();
    const body = pageData.map(r => {
      const on = this.puIsSelected(r);
      return `<tr class="pu-row${on ? ' sel' : ''}" data-ra="${s.tab === 'lines' ? 'orders' : s.tab}" data-id="${this.puEsc(r[sid])}">` +
        shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2] ? c[2](r) : this.puEsc(r[c[0]] == null ? '' : r[c[0]])}</td>`).join('') +
        '</tr>';
    }).join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  // 行主键 + 是否选中
  puRowIdKey() {
    const s = this.puState();
    return s.tab === 'contracts' ? 'contract_no' : s.tab === 'lines' ? 'po_no' : 'po_no';
  },

  puIsSelected(r) {
    const s = this.puState();
    if (!s.sel) return false;
    const t = s.tab === 'lines' ? 'orders' : s.tab;
    if (s.sel.t !== t) return false;
    return s.sel.id === (t === 'contracts' ? r.contract_no : r.po_no);
  },

  puContractLinks(list) {
    if (!list || !list.length) return '<span class="pu-mu">–</span>';
    return list.map(c => `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.puEsc(c)}">${this.puEsc(c)}</button>`).join('、');
  },

  puRenderPager(rows) {
    const box = document.getElementById('pu-pager');
    if (!box) return;
    const s = this.puState();
    const st = this.getTableState('purchase');
    const tp = Math.max(1, Math.ceil(rows.length / st.pageSize));
    if (st.page > tp) st.page = tp;
    const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    // 明细单位不统一，数量求和没有意义 → 底部只统计单据/行数等「计数」，金额仅在有权查看时汇总
    let tot;
    if (s.tab === 'orders')
      tot = this.t('pu_sum_orders', { n: rows.length })
        + (this.canViewPrice() ? ` · ${this.t('pu_order_amount')} ${this.fmtMoney(sum('order_amount'))}` : '');
    else if (s.tab === 'contracts')
      tot = `${this.t('pu_sum_contracts', { n: rows.length })} · ${this.t('pu_po_count')} ${sum('po_count')} · ${this.t('pu_line_count')} ${sum('line_count')}`
        + (this.canViewPrice() ? ` · ${this.t('pu_order_amount')} ${this.fmtMoney(sum('order_amount'))}` : '');
    else
      tot = `${this.t('pu_sum_lines', { n: rows.length })} · ${this.t('pu_sum_pending', { n: rows.filter(r => this.puRowStatus(r) !== '已到货').length })}`;
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<span class="pu-tot">${tot}</span>
      <span>${st.page} / ${tp} ${this.t('page')}</span>
      <label>${this.t('pageSize')} <select id="pu-psz">${[10, 15, 20, 50].map(n => `<option value="${n}"${n === st.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-outline btn-sm" data-pu="pg" data-id="-1"${st.page <= 1 ? ' disabled' : ''}>${this.t('pu_prev')}</button>
      <button type="button" class="btn btn-outline btn-sm" data-pu="pg" data-id="1"${st.page >= tp ? ' disabled' : ''}>${this.t('pu_next')}</button>`;
  },

  // 只有内容超出视口时才把分页条吸附到底部；内容不足一屏时随内容排在末尾
  puUpdatePagerSticky() {
    const pb = document.querySelector('.page-body');
    const pager = document.getElementById('pu-pager');
    if (!pb || !pager) return;
    pager.classList.toggle('pin', pb.scrollHeight > pb.clientHeight + 2);
  },

  // ========== 详情栏 ==========
  async puOpen(t, id) {
    const s = this.puState();
    s.sel = { t, id };
    s.dt = 'lines'; s.lq = ''; s.lf = ''; s.lim = 15; s.ex = new Set();
    this.puRenderList();
    this.puRenderInspector();
    const key = t + ':' + id;
    try {
      const base = t === 'contracts' ? '/api/purchase/contracts/' : '/api/purchase/orders/';
      const [d, ib] = await Promise.all([
        this.api(base + encodeURIComponent(id)),
        this.api(base + encodeURIComponent(id) + '/inbound-lines').catch(() => []),
      ]);
      this._puDetail[key] = { d, ib: ib || [], loading: false };
    } catch (e) {
      this._puDetail[key] = { error: e.message };
    }
    if (this.puState().sel && this.puState().sel.t === t && this.puState().sel.id === id) this.puRenderInspector();
  },

  puCloseInspector() {
    const s = this.puState();
    const prev = s.sel;
    s.sel = null; s.wide = false;
    this.puRenderInspector();
    this.puRenderList();
    if (prev) {
      const el = document.querySelector(`#pu-scroll [data-pu="open"][data-id="${CSS.escape(String(prev.id))}"]`);
      if (el) el.focus();
    }
  },

  puToggleWide() {
    const s = this.puState();
    s.wide = !s.wide;
    this.puRenderInspector();
  },

  puRenderInspector() {
    const s = this.puState();
    const box = document.getElementById('pu-insp');
    const split = document.getElementById('pu-split');
    if (!box || !split) return;
    if (!s.sel) {
      box.hidden = true; box.innerHTML = '';
      split.classList.remove('open', 'wide');
      return;
    }
    box.hidden = false;
    split.classList.add('open');
    split.classList.toggle('wide', s.wide);
    const rec = this.puDetail();
    if (!rec || rec.loading) { box.innerHTML = `<div class="pu-empty">${this.t('loading')}</div>`; return; }
    if (rec.error) { box.innerHTML = `<div class="pu-empty">${this.puEsc(rec.error)}</div>`; return; }
    const d = rec.d;
    const isPo = s.sel.t === 'orders';
    const id = isPo ? d.po_no : d.contract_no;
    const lines = d.lines || [];
    const ors = d.orders || [];
    const ibs = this.puGroupInboundDocs(rec.ib);
    const logs = d.logs || [];
    if (!['lines', 'orders', 'inbound', 'logs'].includes(s.dt)) s.dt = 'lines';
    if (!isPo && s.dt === 'orders' && !ors.length) s.dt = 'lines';
    if (isPo && s.dt === 'orders') s.dt = 'lines';

    const sum = (k) => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
    const q = sum('order_qty'), r = sum('received_qty');
    const p = q ? Math.min(100, Math.round(r / q * 100)) : 0;
    const amt = lines.reduce((a, l) => a + Number(l.order_amount || 0), 0);

    const meta = isPo
      ? [[this.t('pu_supplier'), d.supplier || '–'], [this.t('pu_date'), this.fmtDate(d.date) || '–'],
         [this.t('pu_project'), d.project || '–'], [this.t('pu_expected'), this.fmtDate(d.expected_date) || '–'],
         [this.t('pu_contract_default'), d.contract_no || '–'], [this.t('pu_manual_status'), d.manual_status || '–']]
      : [[this.t('pu_contract_name'), d.name || '–'], [this.t('pu_supplier'), d.supplier || '–'],
         [this.t('pu_sign_date'), this.fmtDate(d.sign_date) || '–'],
         [this.t('pu_contract_amount'), this.canViewPrice() ? this.fmtMoney(d.amount) : '–']];

    const tabs = isPo
      ? [['lines', this.t('pu_tab_detail_lines'), lines.length], ['inbound', this.t('pu_tab_inbound'), ibs.length], ['logs', this.t('pu_tab_logs'), logs.length]]
      : [['lines', this.t('pu_tab_detail_lines'), lines.length], ['orders', this.t('pu_detail_orders'), ors.length],
         ['inbound', this.t('pu_tab_inbound'), ibs.length], ['logs', this.t('pu_tab_logs'), logs.length]];

    let foot = '';
    if (isPo && this.can('purchase', 'create')) foot += `<button class="btn btn-primary" data-pu="n-line">+ ${this.t('pu_add_line')}</button>`;
    // 收货：直接建一张采购入库单并带出未到货明细（数量留空待填写）
    if (this.can('inbound', 'create') && lines.some(l => Number(l.unreceived_qty) > 0)) {
      foot += `<button class="btn btn-primary" data-pu="receive">📥 ${this.t('pu_receive')}</button>`;
    }
    // 只读输出（打印/导出）排在写操作之前；删除作为高危操作固定在最右
    foot += `<button class="btn btn-outline" data-pu="print">🖨 ${this.t('doc_print')}</button>`;
    foot += `<button class="btn btn-outline" data-pu="export">⬇ ${this.t('doc_export')}</button>`;
    if (this.can('purchase', 'edit')) foot += `<button class="btn btn-outline" data-pu="e-entity">${this.t('edit')}</button>`;
    if (this.can('purchase', 'delete')) foot += `<button class="btn btn-danger" data-pu="d-entity">${this.t('delete')}</button>`;

    box.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm pu-mback" data-pu="icl">← ${this.t('pu_back_list')}</button>
      <div class="pu-insp-head">
        <div>
          <small>${isPo ? this.t('pu_tab_orders') : this.t('pu_tab_contracts')}</small>
          <h2>${this.puEsc(id)}</h2>
          ${isPo ? `<span class="pu-badge">${this.puOrderStatusBadge(d.status)}${this.puDeliveryBadge((d.summary || {}).delivery_status)}</span>` : this.puContractStatusBadge(d.status)}
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" data-pu="wide" aria-pressed="${s.wide}" title="${s.wide ? this.t('pu_collapse') : this.t('pu_expand')}">${s.wide ? '⤡' : '⤢'}</button>
          <button type="button" class="btn btn-outline btn-sm" data-pu="icl" title="${this.t('pu_close_detail')}">✕</button>
        </div>
      </div>
      <dl class="pu-insp-meta">${meta.map(m => `<div><dt>${m[0]}</dt><dd>${this.puEsc(m[1])}</dd></div>`).join('')}</dl>
      <div class="pu-prog-wrap">
        <div class="pu-rate-row"><strong>${this.t('pu_progress')} ${p}%</strong><span class="pu-mu">${this.fmtQty(r)} / ${this.fmtQty(q)}${this.canViewPrice() ? ' · ' + this.fmtMoney(amt) : ''}</span></div>
        <div class="pu-prog" role="progressbar" aria-label="${this.t('pu_progress')}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>
      </div>
      <div class="pu-dtabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" class="pu-dtab" role="tab" aria-selected="${s.dt === k}" data-pu="dt" data-id="${k}">${label} ${n}</button>`).join('')}</div>
      <div class="pu-dpanel" id="pu-dpanel"></div>
      <div class="pu-insp-foot">${foot}</div>`;
    this.puRenderDetailPanel();
    this.puUpdatePagerSticky();
  },

  puRenderDetailPanel() {
    const box = document.getElementById('pu-dpanel');
    if (!box) return;
    const s = this.puState();
    const rec = this.puDetail();
    if (!rec || !rec.d) { box.innerHTML = ''; return; }
    const d = rec.d;
    if (s.dt === 'lines') return this.puRenderLinesBody();
    if (s.dt === 'orders') { box.innerHTML = this.puOrdersPanel(d.orders || []); return; }
    if (s.dt === 'inbound') {
      box.innerHTML = this.puItemsPanel(this.puGroupInboundDocs(rec.ib).map(g => ({
        title: g.doc_no || '-', docNo: g.doc_no || '',
        sub: [this.fmtDate(g.date), g.handler, `${this.t('pu_line_count')} ${g.n}`].filter(Boolean).join(' · '),
        qty: g.qty,
      })), this.t('pu_no_inbound'));
      return;
    }
    box.innerHTML = this.puLogsPanel(d.logs || []);
  },

  // --- 明细：手风琴（宽屏时切换为全表） ---
  puRenderLinesBody() {
    const s = this.puState();
    const rec = this.puDetail();
    const body = document.getElementById('pu-dpanel');
    if (!body || !rec || !rec.d) return;
    if (s.dt !== 'lines') return;
    const isPo = s.sel.t === 'orders';
    const lines = rec.d.lines || [];
    if (s.wide) {
      this._tableRenderers['purchase_detail_lines'] = () => this.puRenderLinesBody();
      body.innerHTML = `<div id="pu-lines-body">${this.puDetailLinesTable(lines)}</div>`;
      return;
    }
    const f = lines.filter(l => this.puKwMatch([l.code, l.material_name, l.material_spec, l.remarks, l.po_no, l.contract_no_eff].join(' '), s.lq)
      && (!s.lf || (s.lf === 'od' ? Number(l.overdue_days || 0) > 0 : l.line_status !== '已到货')));
    const nOpen = lines.filter(l => l.line_status !== '已到货').length;
    const nOd = lines.filter(l => Number(l.overdue_days || 0) > 0).length;
    const shown = Math.min(s.lim, f.length);
    let html = `<div class="pu-lqtoolbar">
      <input id="pu_lqi" type="search" value="${this.puEsc(s.lq)}" placeholder="${this.t('pu_inline_search_ph')}" aria-label="${this.t('pu_inline_search_ph')}">
      <div class="pu-chips" role="group">${[['', this.t('all'), lines.length], ['open', this.t('pu_unfinished'), nOpen], ['od', this.t('pu_overdue_only'), nOd]]
        .map(([k, label, n]) => `<button type="button" class="pu-chip" aria-pressed="${s.lf === k}" data-pu="lf" data-id="${k}">${label} ${n}</button>`).join('')}</div>
    </div>`;
    if (!lines.length) {
      html += `<div class="pu-empty">${isPo ? this.t('pu_add_first_line') : this.t('pu_no_lines')}</div>`;
      body.innerHTML = html; return;
    }
    html += `<p class="pu-cnt">${this.t('pu_shown_count', { shown, total: f.length })}</p>`;
    if (!f.length) {
      html += `<div class="pu-empty">${this.t('pu_no_lines')}</div>`;
      body.innerHTML = html; return;
    }
    html += `<ul class="pu-lines">` + f.slice(0, shown).map(l => {
      const ex = s.ex.has(String(l.id));
      const p = Number(l.order_qty) ? Math.min(100, Math.round(Number(l.received_qty) / Number(l.order_qty) * 100)) : 0;
      const od = Number(l.overdue_days || 0);
      return `<li class="pu-line">
        <button type="button" class="pu-line-h" data-pu="ex" data-id="${l.id}" aria-expanded="${ex}">
          ${od ? `<span class="pu-odm" title="${this.t('pu_overdue')} ${od}"><span aria-hidden="true">⚠</span><span class="sr-only">${this.t('pu_overdue')} ${od}</span></span>` : ''}
          <span class="pu-line-n"><strong>${this.puEsc(l.code)}</strong> ${this.puEsc(l.material_name || '')} <span class="pu-mu">${this.puEsc(l.material_spec || '')}</span></span>
          <span class="pu-line-q">${this.fmtQty(l.received_qty)}/${this.fmtQty(l.order_qty)}</span>
          ${this.puDeliveryBadge(l.line_status)}
        </button>
        <div class="pu-line-bar" aria-hidden="true"><i style="width:${p}%"></i></div>
        ${ex ? `<div class="pu-line-d">
          <div class="pu-mu">${this.t('pu_order_price')} ${this.fmtMoney(l.order_price)}/${this.puEsc(l.material_unit || '')} · ${this.t('pu_order_amount')} ${this.fmtMoney(l.order_amount)}
            · ${isPo ? (l.contract_no_eff ? `<button type="button" class="pu-lk" data-pu="open" data-t="contracts" data-id="${this.puEsc(l.contract_no_eff)}">${this.puEsc(l.contract_no_eff)}</button>` : this.t('pu_no_contract')) : `<button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.puEsc(l.po_no)}">${this.puEsc(l.po_no)}</button>`}${od ? ` · ${this.t('pu_overdue')} ${od}` : ''}</div>
          ${l.remarks ? `<div>${this.t('pu_remarks')}：${this.puEsc(l.remarks)}</div>` : ''}
          <div class="pu-line-acts">
            <button type="button" class="pu-lk" data-pu="hist" data-id="${l.id}">${this.t('pu_history')}</button>
            ${this.can('purchase', 'edit') ? `<button type="button" class="pu-lk" data-pu="e-line" data-id="${l.id}">${this.t('edit')}</button>` : ''}
            ${this.can('purchase', 'delete') ? `<button type="button" class="pu-lk danger" data-pu="d-line" data-id="${l.id}">${this.t('delete')}</button>` : ''}
          </div>
        </div>` : ''}
      </li>`;
    }).join('') + '</ul>';
    if (f.length > s.lim) html += `<button type="button" class="btn btn-outline btn-sm pu-more" data-pu="more">${this.t('pu_more', { n: f.length - s.lim })}</button>`;
    body.innerHTML = html;
  },

  puDetailLinesTable(lines) {
    const s = this.puState();
    const vp = this.canViewPrice();
    const isPo = s.sel.t === 'orders';
    const cols = [
      ['code', this.t('pu_code'), r => this.puEsc(r.code)],
      ['material_name', this.t('pu_material'), r => this.puEsc(r.material_name || '')],
      ['material_spec', this.t('pu_spec'), r => this.puEsc(r.material_spec || '')],
      ['material_unit', this.t('pu_unit'), r => this.puEsc(r.material_unit || '')],
      ['order_qty', this.t('pu_order_qty'), r => this.fmtQty(r.order_qty), true],
      ['order_price', this.t('pu_order_price'), r => this.fmtMoney(r.order_price), true, vp],
      ['order_amount', this.t('pu_order_amount'), r => this.fmtMoney(r.order_amount), true, vp],
      ['received_qty', this.t('pu_progress'), r => this.puRateBar(r.received_qty, r.order_qty)],
      ['unreceived_qty', this.t('pu_unreceived_qty'), r => this.fmtQty(r.unreceived_qty), true],
      ['line_status', this.t('pu_line_status'), r => this.puDeliveryBadge(r.line_status)],
      [isPo ? 'contract_no_eff' : 'po_no', isPo ? this.t('pu_contract_filter') : this.t('pu_po_no_filter'),
        r => this.puEsc((isPo ? r.contract_no_eff : r.po_no) || '')],
      ['remarks', this.t('pu_remarks'), r => this.puEsc(r.remarks || '')],
    ];
    const shown = cols.filter(c => c[4] !== false);
    const st = this.getTableState('purchase_detail_lines');
    const sorted = this.sortData(lines, st.sortKey, st.sortDir);
    const th = shown.map(c => this.sortTh(c[1], c[0], 'purchase_detail_lines', c[3])).join('');
    const body = sorted.map(r => `<tr>` + shown.map(c => `<td${c[3] ? ' class="text-right"' : ''}>${c[2](r)}</td>`).join('') + '</tr>').join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${shown.length}" style="text-align:center;padding:24px;color:var(--text-muted)">${this.t('noData')}</td></tr>`}</tbody></table></div>`;
  },

  // --- 采购单清单（合同详情） ---
  puOrdersPanel(orders) {
    if (!orders.length) return `<div class="pu-empty">${this.t('pu_no_orders_in_contract')}</div>`;
    return `<ul class="pu-items">` + orders.map(o => `<li class="pu-item">
      <div class="pu-item-top">
        <div>
          <button type="button" class="pu-lk" data-pu="open" data-t="orders" data-id="${this.puEsc(o.po_no)}">${this.puEsc(o.po_no)}</button>
          <div class="pu-log-meta">${this.fmtDate(o.date)} · ${this.puEsc(o.supplier || '')}${o.project ? ' · ' + this.puEsc(o.project) : ''}</div>
        </div>
      </div>
    </li>`).join('') + '</ul>';
  },

  // 把入库明细行按「入库单号」聚合成一张单一行（数量累计、统计行数）
  puGroupInboundDocs(rows) {
    const map = new Map();
    (rows || []).forEach(r => {
      const no = r.doc_no || '-';
      let g = map.get(no);
      if (!g) { g = { doc_no: r.doc_no || '', date: r.date, handler: r.handler, qty: 0, n: 0 }; map.set(no, g); }
      g.qty += Number(r.qty || 0);
      g.n += 1;
      if (!g.date && r.date) g.date = r.date;
    });
    return [...map.values()];
  },

  // --- 入库 / 采购单通用条目列表 ---
  puItemsPanel(items, emptyText) {
    if (!items.length) return `<div class="pu-empty">${emptyText}</div>`;
    return `<ul class="pu-items">` + items.map(x => `<li class="pu-item">
      <div class="pu-item-top">
        <div>${x.docNo
          ? `<button type="button" class="pu-lk" data-pu="open-ib" data-id="${this.puEsc(x.docNo)}">${this.puEsc(x.title)}</button>`
          : `<strong>${this.puEsc(x.title)}</strong>`}<div class="pu-log-meta">${this.puEsc(x.sub)}</div></div>
        <strong>${this.fmtQty(x.qty)}</strong>
      </div>
    </li>`).join('') + '</ul>';
  },

  puLogsPanel(logs) {
    if (!logs.length) return `<div class="pu-empty">${this.t('pu_log_empty')}</div>`;
    return `<ol class="pu-log">` + logs.map(l => `<li>
      <div>
        <strong>${this.puActionLabel(l.action)}</strong>
        <span class="pu-log-meta">· ${this.puEsc(l.name || l.username || '')} · ${this.fmtDateTime(l.created_at)}</span>
        ${l.detail ? `<div style="font-size:12px;margin-top:4px;overflow-wrap:anywhere">${this.puEsc(l.detail)}</div>` : ''}
      </div>
    </li>`).join('') + '</ol>';
  },

  // ========== 事件委托 ==========
  puBindEvents() {
    if (this._puBound) return;
    this._puBound = true;

    document.addEventListener('click', e => {
      if (this.currentPage !== 'purchase') return;
      const el = e.target.closest('[data-pu]');
      if (el) { e.preventDefault(); this.puAction(el.dataset.pu, el.dataset.id, el.dataset.t, el); return; }
      const row = e.target.closest('#pu-root tr[data-ra]');
      if (row && !String(window.getSelection())) this.puAction('open', row.dataset.id, row.dataset.ra, row);
    });

    // 点击详情卡片以外的区域（含左侧菜单栏）→ 自动收起详情栏，返回明细列表
    document.addEventListener('click', e => {
      const s = this.puState();
      if (!s.sel || s.view === 'edit') return;
      const insp = document.getElementById('pu-insp');
      if (!insp || insp.hidden) return;
      if (e.target.closest('#pu-insp, #pu-root tr[data-ra], [data-pu], #modal-overlay, .pu-ov, .toast')) return;
      this.puCloseInspector();
    }, true);

    document.addEventListener('input', e => {
      if (this.currentPage !== 'purchase') return;
      const s = this.puState();
      if (e.target.id === 'pu_f_kw') { s.f.kw = e.target.value; clearTimeout(this._puFilterTimer); this._puFilterTimer = setTimeout(() => this.loadPurchaseList(), 250); }
      else if (e.target.id === 'pu_lqi') {
        s.lq = e.target.value;
        // 组词过程中不重绘：重绘会重建输入框，导致中文输入法组词被打断
        if (e.isComposing || this._puLqComposing) return;
        this.puRenderLinesBody(); this.puFocusEnd('pu_lqi');
      }
      else if (e.target.id === 'pu_mat_kw') { this._puMatKw = e.target.value; this.puRefreshMatOptions(); }
      else if (e.target.id === 'pu_lm_kw') { this._puLmKw = e.target.value; this.puRefreshLmOptions(); }
    });

    // 中文输入法：组词结束后再过滤
    document.addEventListener('compositionstart', e => {
      if (e.target.id === 'pu_lqi') this._puLqComposing = true;
    });
    document.addEventListener('compositionend', e => {
      if (e.target.id !== 'pu_lqi') return;
      this._puLqComposing = false;
      if (this.currentPage !== 'purchase') return;
      this.puState().lq = e.target.value;
      this.puRenderLinesBody(); this.puFocusEnd('pu_lqi');
    });

    document.addEventListener('change', e => {
      if (this.currentPage !== 'purchase') return;
      const s = this.puState();
      if (e.target.id === 'pu_f_from') { s.f.from = e.target.value; this.getTableState('purchase').page = 1; this.loadPurchaseList(); }
      else if (e.target.id === 'pu_f_to') { s.f.to = e.target.value; this.getTableState('purchase').page = 1; this.loadPurchaseList(); }
      else if (e.target.id === 'pu-psz') { const st = this.getTableState('purchase'); st.pageSize = parseInt(e.target.value, 10) || 15; st.page = 1; this.puRenderList(); }
      else if (e.target.id === 'pu_mat_cat') { this._puMatCat = e.target.value; this.puRefreshMatOptions(); }
      else if (e.target.id === 'pu_lm_cat') { this._puLmCat = e.target.value; this.puRefreshLmOptions(); }
    });

    document.addEventListener('keydown', e => {
      if (this.currentPage !== 'purchase') return;
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === '/' && !inField && document.getElementById('pu_f_kw')) { e.preventDefault(); document.getElementById('pu_f_kw').focus(); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest && e.target.matches('#pu-scroll .pu-lk')) {
        const links = [...document.querySelectorAll('#pu-scroll .pu-lk')];
        const i = links.indexOf(e.target);
        const n = links[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (n) { e.preventDefault(); n.focus(); }
        return;
      }
      if (e.key === 'Escape') {
        if (document.getElementById('modal-overlay')) { this.closeModal(); return; }
        const ov = document.querySelector('.pu-ov');
        if (ov) { ov.remove(); return; }
        if (this.puState().sel) this.puCloseInspector();
      }
    });

    // 视口尺寸变化时重算分页条是否需要吸附
    window.addEventListener('resize', () => {
      if (this.currentPage === 'purchase') this.puUpdatePagerSticky();
    });
  },

  puFocusEnd(id) {
    const el = document.getElementById(id);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch (_) {} }
  },

  puAction(name, id, t, el) {
    const s = this.puState();
    switch (name) {
      case 'tab': return this.switchPurchaseTab(id);
      case 'open': return this.puOpen(t || 'orders', id);
      case 'icl': return this.puCloseInspector();
      case 'wide': return this.puToggleWide();
      case 'dt': s.dt = id; s.lim = 15; this.puRenderInspector(); return;
      case 'kpi': s.kpi = s.kpi === id ? '' : id; this.getTableState('purchase').page = 1; this.puRenderList(); return;
      case 'clr': s.f = { kw: '', from: '', to: '' }; s.kpi = ''; this.getTableState('purchase').page = 1; this.puRenderFilters(); this.loadPurchaseList(); return;
      case 'dense': s.dense = !s.dense; document.getElementById('pu-root').classList.toggle('pu-dense', s.dense); if (el) el.setAttribute('aria-pressed', String(s.dense)); return;
      case 'pg': this.getTableState('purchase').page += Number(id); this.puRenderList(); return;
      case 'lf': s.lf = s.lf === id ? '' : id; s.lim = 15; this.puRenderLinesBody(); return;
      case 'ex': { const k = String(id); if (s.ex.has(k)) s.ex.delete(k); else s.ex.add(k); this.puRenderLinesBody(); return; }
      case 'more': s.lim += 15; if (s.dt === 'lines') this.puRenderLinesBody(); else this.puRenderDetailPanel(); return;
      case 'hist': return this.showLineInbound(Number(id));
      case 'n-order': return this.puNewOrderPage();
      case 'n-contract': return this.editContract();
      case 'n-line': return this.addPurchaseLine(s.sel.id);
      case 'receive': return this.puReceive();
      case 'open-ib': return this.puOpenInbound(id);
      case 'e-entity': return s.sel.t === 'contracts' ? this.editContract(s.sel.id) : this.puEditOrderPage(s.sel.id);
      case 'd-entity': return s.sel.t === 'contracts' ? this.deleteContract(s.sel.id) : this.deletePurchaseOrder(s.sel.id);
      case 'e-line': return this.editPurchaseLine(Number(id));
      case 'd-line': return this.deletePurchaseLine(Number(id));
      case 'print': return this.puPrintDoc();
      case 'export': return this.puExportDoc();
    }
  },

  // ========== 单据打印 / 导出（组装通用 doc，细节由 02-ui-kit 统一处理） ==========
  puDocModel() {
    const rec = this.puDetail();
    const s = this.puState();
    if (!rec || !rec.d || !s.sel) return null;
    const d = rec.d;
    const isPo = s.sel.t === 'orders';
    const lines = d.lines || [];
    const vp = this.canViewPrice();
    const cols = [
      { label: this.t('pu_code'), key: 'code' },
      { label: this.t('pu_material'), key: 'material_name' },
      { label: this.t('pu_spec'), key: 'material_spec' },
      { label: this.t('pu_unit'), key: 'material_unit' },
      { label: this.t('pu_order_qty'), align: 'right', value: r => this.fmtQty(r.order_qty) },
      { label: this.t('pu_received_qty'), align: 'right', value: r => this.fmtQty(r.received_qty) },
    ];
    if (vp) {
      cols.push({ label: this.t('pu_order_price'), align: 'right', value: r => this.fmtMoney(r.order_price) });
      cols.push({ label: this.t('pu_order_amount'), align: 'right', value: r => this.fmtMoney(r.order_amount) });
    }
    cols.push({ label: this.t('pu_contract_filter'), value: r => r.contract_no_eff || '' });
    cols.push({ label: this.t('pu_remarks'), value: r => r.remarks || '' });
    cols.push({ label: this.t('pu_status'), value: r => r.line_status || '' });

    const sum = k => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
    const meta = isPo
      ? [[this.t('pu_supplier'), d.supplier || ''], [this.t('pu_date'), this.fmtDate(d.date)],
         [this.t('pu_project'), d.project || ''], [this.t('pu_expected'), this.fmtDate(d.expected_date)],
         [this.t('pu_contract_default'), d.contract_no || ''], [this.t('pu_manual_status'), d.manual_status || ''],
         [this.t('pu_line_count'), String(lines.length)],
         [this.t('pu_progress'), `${this.fmtQty(sum('received_qty'))} / ${this.fmtQty(sum('order_qty'))}`]]
      : [[this.t('pu_contract_name'), d.name || ''], [this.t('pu_supplier'), d.supplier || ''],
         [this.t('pu_sign_date'), this.fmtDate(d.sign_date)],
         [this.t('pu_contract_amount'), vp ? this.fmtMoney(d.amount) : ''],
         [this.t('pu_line_count'), String(lines.length)]];

    const id = isPo ? d.po_no : d.contract_no;
    return {
      title: id,
      subtitle: isPo ? this.t('pu_tab_orders') : this.t('pu_tab_contracts'),
      meta, columns: cols, rows: lines,
      filename: `${id}_${this.today().replace(/-/g, '')}.csv`,
    };
  },

  puPrintDoc() {
    const doc = this.puDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.printDoc(doc);
  },

  puExportDoc() {
    const doc = this.puDocModel();
    if (!doc) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.exportDocCsv(doc);
    this.toast(this.t('doc_export_done', { name: doc.filename }));
  },

  // 从采购/合同详情的「入库」页签跳到对应入库单
  puOpenInbound(docNo) {
    if (!docNo) return;
    if (!this.can('inbound', 'view')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    this.currentPage = 'inbound';
    return this.openInboundDoc(docNo);
  },

  // ========== 收货：从采购单/合同详情一键生成采购入库单 ==========
  // 自动创建草稿入库单并带出该单据全部「未到货」明细，数量留空，
  // 由用户填写后自行选择「保存草稿」或「确认入库」；数量为空/0 的行不会生成流水。
  async puReceive() {
    const s = this.puState();
    if (!s.sel) return;
    if (!this.can('inbound', 'create')) { this.toast(this.t('no_perm_msg'), 'error'); return; }
    const rec = this.puDetail();
    const d = (rec && rec.d) || {};
    const isPo = s.sel.t === 'orders';
    const id = s.sel.id;

    let lines = [];
    try {
      lines = await this.api((isPo ? '/api/purchase/lines/by-po/' : '/api/purchase/lines/by-contract/') + encodeURIComponent(id));
    } catch (e) { this.toast(e.message, 'error'); return; }
    const pending = (lines || []).filter(l => Number(l.unreceived_qty) > 0);
    if (!pending.length) { this.toast(this.t('pu_no_pending_lines'), 'error'); return; }

    const preload = pending.map(l => ({
      code: l.code,
      contract_no: l.contract_no_eff || '',
      po_no: l.po_no || (isPo ? id : ''),
      material_name: l.material_name || '',
      material_spec: l.material_spec || '',
      material_brand: l.material_brand || '',
      material_unit: l.material_unit || '',
      qty: '',
      price: Number(l.order_price) || 0,
      remarks: ''
    }));

    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    try {
      const r = await this.api('/api/inbound-docs', 'POST', {
        date,
        txn_type: '采购入库',
        supplier: d.supplier || '',
        handler: this.user?.name || this.user?.username || '',
        po_no: isPo ? id : '',
        contract_no: isPo ? '' : id,
        remarks: ''
      });
      this.toast(this.t('ibd_created'));
      // 切到「入库」模块视角，进入明细编辑页
      this.currentPage = 'inbound';
      await this.editInboundDoc(r.doc_no, preload);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // ========== 到货履历（右侧抽屉） ==========
  async showLineInbound(lineId) {
    let d;
    try { d = await this.api('/api/purchase/lines/' + lineId + '/inbound'); }
    catch (e) { this.toast(e.message, 'error'); return; }
    const vp = this.canViewPrice();
    const l = d.line || {}, sm = d.summary || {};
    const head = `<div class="pu-stat-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px">
      <div class="pu-kpi"><small>${this.t('pu_order_qty')}</small><strong>${this.fmtQty(sm.order_qty)}</strong></div>
      <div class="pu-kpi"><small>${this.t('pu_received_qty')}</small><strong>${this.fmtQty(sm.received_qty)}</strong></div>
      <div class="pu-kpi"><small>${this.t('pu_unreceived_qty')}</small><strong>${this.fmtQty(sm.unreceived_qty)}</strong></div>
    </div>
    <div class="pu-log-meta" style="margin-bottom:12px">${this.puEsc(l.po_no || '')} · ${this.puEsc(l.code || '')} ${this.puEsc(l.material_name || '')} ${this.puEsc(l.material_spec || '')}${l.contract_no_eff ? ' · ' + this.t('pu_contract_filter') + ': ' + this.puEsc(l.contract_no_eff) : ''}</div>`;
    let table;
    if (!(d.history || []).length) {
      table = `<div class="pu-empty">${this.t('pu_hist_empty')}</div>`;
    } else {
      table = `<div class="table-wrap"><table><thead><tr>
        <th>${this.t('pu_hist_inbound_no')}</th><th>${this.t('pu_hist_date')}</th><th class="text-right">${this.t('pu_hist_qty')}</th>
        ${vp ? `<th class="text-right">${this.t('pu_hist_price')}</th><th class="text-right">${this.t('pu_hist_amount')}</th>` : ''}
        <th class="text-right">${this.t('pu_hist_cum')}</th><th>${this.t('pu_hist_supplier')}</th><th>${this.t('pu_hist_handler')}</th>
      </tr></thead><tbody>` +
        d.history.map(r => `<tr>
          <td>${this.puEsc(r.doc_no || r.grn_no || '-')}</td><td>${this.fmtDate(r.date)}</td>
          <td class="text-right">${this.fmtQty(r.qty)}</td>
          ${vp ? `<td class="text-right">${this.fmtMoney(r.price)}</td><td class="text-right">${this.fmtMoney(r.amount)}</td>` : ''}
          <td class="text-right"><b>${this.fmtQty(r.cum_qty)}</b></td>
          <td>${this.puEsc(r.supplier || '')}</td><td>${this.puEsc(r.handler || '')}</td>
        </tr>`).join('') +
        `</tbody></table></div>`;
    }
    this.puDrawer(this.t('pu_hist_title'), head + table);
  },

  puDrawer(title, bodyHtml) {
    const ov = document.createElement('div');
    ov.className = 'pu-ov';
    ov.innerHTML = `<div class="pu-drawer" role="dialog" aria-modal="true" aria-label="${this.puEsc(title)}">
      <div class="pu-drawer-h"><h3>${this.puEsc(title)}</h3><button type="button" class="btn btn-outline btn-sm" data-pu="drawer-close" aria-label="${this.t('close')}">✕</button></div>
      <div class="pu-drawer-b">${bodyHtml}</div>
    </div>`;
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    ov.querySelector('[data-pu="drawer-close"]').addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
  },

  // ========== 可撤销删除 ==========
  puToastUndo(msg, undo) {
    const el = document.createElement('div');
    el.className = 'toast toast-success pu-toast-undo';
    el.innerHTML = `<span>${this.puEsc(msg)}</span><button type="button">${this.t('pu_undo')}</button>`;
    document.body.appendChild(el);
    const timer = setTimeout(() => el.remove(), 7000);
    el.querySelector('button').onclick = async () => {
      clearTimeout(timer); el.remove();
      try { await undo(); this.toast(this.t('pu_restored')); }
      catch (e) { this.toast(e.message, 'error'); }
    };
  },

  async puConfirmDelete(title, msg, doDelete, doneMsg) {
    this.showModal(`<h3>${this.puEsc(title)}</h3>`, `<p style="margin:0">${msg}</p><p class="pu-mu" style="margin:8px 0 0;font-size:12px">${this.t('pu_delete_hint')}</p>`, this.t('delete'), async () => {
      let undo;
      try { undo = await doDelete(); } catch (e) { this.toast(e.message, 'error'); return; }
      this.closeModal();
      this.puToastUndo(doneMsg || title, undo);
    });
  },

  // ========== 采购单增删改（独立编辑页：新建 → 保存草稿 → 确认） ==========

  // 兼容入口：有单号进整单编辑页，无单号进新建页
  async editPurchaseOrder(poNo) {
    return poNo ? this.puEditOrderPage(poNo) : this.puNewOrderPage();
  },

  // 新建采购单：先填表头 → 创建草稿 → 进入明细编辑页（对齐出库 / 入库交互）
  async puNewOrderPage() {
    this.puState().view = 'edit';
    this._puEditPo = null;
    this._puEditLines = [];
    this._puEditLookups = await this.puLookups();
    let no = '';
    try { no = (await this.api('/api/purchase/orders/next-no?date=' + this.today())).po_no || ''; } catch (_) {}
    this._puEditDraft = {
      po_no: no, date: this.today(), supplier: '', contract_no: '',
      project: '', expected_date: '', manual_status: '', remarks: '',
    };
    this.puRenderEditPage(true);
  },

  // 整单编辑：加载详情 → 表头 + 明细一起修改 → 保存草稿 / 确认
  async puEditOrderPage(poNo) {
    this.puState().view = 'edit';
    if (this._puEditFilterPo !== poNo) { this._puMatCat = ''; this._puMatKw = ''; this._puEditFilterPo = poNo; }
    let d;
    try { d = await this.api('/api/purchase/orders/' + encodeURIComponent(poNo)); }
    catch (e) { this.toast(e.message, 'error'); return this.puBackToList(); }
    this._puEditLookups = await this.puLookups();
    this._puEditPo = d;
    this._puEditDraft = {
      po_no: d.po_no, date: d.date || '', supplier: d.supplier || '', contract_no: d.contract_no || '',
      project: d.project || '', expected_date: d.expected_date || '', manual_status: d.manual_status || '', remarks: d.remarks || '',
    };
    this._puEditLines = (d.lines || []).map(l => ({
      id: l.id, code: l.code,
      order_qty: Number(l.order_qty || 0), order_price: Number(l.order_price || 0),
      contract_no: l.contract_no_eff || l.contract_no || '', remarks: l.remarks || '',
      received_qty: Number(l.received_qty || 0),
    }));
    this.puRenderEditPage(false);
  },

  puRenderEditPage(isNew) {
    const po = this._puEditDraft || {};
    const status = isNew ? 'draft' : (this._puEditPo?.status || 'posted');
    const badge = `<span class="badge badge-${status === 'draft' ? 'warning' : 'success'}">${this.t(status === 'draft' ? 'pu_status_draft' : 'pu_status_posted')}</span>`;
    const actions = isNew
      ? `<div class="pu-edit-actions">
           <button class="btn btn-outline" onclick="App.puBackToList()">${this.t('cancel')}</button>
           <button class="btn btn-primary" onclick="App.puCreateOrder()">${this.t('pu_create_and_add')}</button>
         </div>`
      : `<div class="pu-edit-actions">
           <button class="btn btn-outline" onclick="App.puEditAddRow()">+ ${this.t('pu_add_line')}</button>
           <button class="btn btn-outline" onclick="App.puSaveOrderDraft()">${this.t(status === 'draft' ? 'pu_save_draft' : 'save')}</button>
           ${status === 'draft' ? `<button class="btn btn-primary" onclick="App.puConfirmOrder()">${this.t('pu_confirm_order')}</button>` : ''}
         </div>`;
    const title = isNew ? this.t('pu_new_order') : this.t('pu_edit_order') + ' · ' + this.puEsc(po.po_no);
    const desc = isNew ? this.t('pu_create_hint') : (status === 'posted' ? this.t('pu_edit_posted_hint') : this.t('pu_edit_hint'));
    this.setMain(this.pageWrap((isNew ? '🆕 ' : '✏️ ') + title, desc, '', `
      <div class="data-page" id="pu-edit-root">
        <div class="pu-edit-bar">
          <span class="action-link" onclick="App.puBackToList()">← ${this.t('pu_back_list')}</span>
          ${badge}
        </div>
        <div class="pu-card">
          <div class="pu-card-title"><span>01</span><div>${this.t('pu_section_header')}<small>${isNew ? this.t('pu_next_add_lines_hint') : ''}</small></div></div>
          <div id="pu-edit-form"></div>
        </div>
        ${isNew ? '' : `<div class="pu-card">
          <div class="pu-card-title"><span>02</span><div>${this.t('pu_section_lines')}<small id="pu-edit-line-count"></small></div></div>
          <div id="pu-edit-lines"></div>
        </div>`}
        ${actions}
      </div>`));
    this.injectPurchaseStyles();
    this.puRenderEditForm();
    if (!isNew) this.puRenderEditLines();
  },

  // 表头表单（新建与整单编辑共用）
  puRenderEditForm() {
    const box = document.getElementById('pu-edit-form');
    if (!box) return;
    const po = this._puEditDraft || {};
    const isNew = !this._puEditPo;
    const lk = this._puEditLookups || { suppliers: [], contracts: [] };
    const supList = (lk.suppliers || []).map(x => `<option value="${this.puEsc(x.name)}"></option>`).join('');
    const cList = (lk.contracts || []).map(x => `<option value="${this.puEsc(x.contract_no)}"></option>`).join('');
    const msOpts = ['', '已关闭', '已取消'].map(v => `<option value="${v}" ${po.manual_status === v ? 'selected' : ''}>${v || this.t('pu_manual_none')}</option>`).join('');
    box.innerHTML = `<div class="form-grid" style="max-width:none">
      <div class="form-group"><label>${this.t('pu_po_no_filter')}</label><input id="pu_e_no" value="${this.puEsc(po.po_no || '')}" ${isNew ? `placeholder="${this.t('pu_po_no_manual_ph')}"` : 'readonly'}></div>
      <div class="form-group"><label>${this.t('pu_date')} *</label><input id="pu_e_date" type="date" value="${this.fmtDate(po.date)}"></div>
      <div class="form-group"><label>${this.t('pu_supplier')}</label><input id="pu_e_supplier" list="pu_e_sup" value="${this.puEsc(po.supplier || '')}"><datalist id="pu_e_sup">${supList}</datalist></div>
      <div class="form-group"><label>${this.t('pu_contract_default')}</label><input id="pu_e_contract" list="pu_e_c" value="${this.puEsc(po.contract_no || '')}"><datalist id="pu_e_c">${cList}</datalist></div>
      <div class="form-group"><label>${this.t('pu_project')}</label><input id="pu_e_project" value="${this.puEsc(po.project || '')}"></div>
      <div class="form-group"><label>${this.t('pu_expected')}</label><input id="pu_e_expected" type="date" value="${this.fmtDate(po.expected_date)}"></div>
      <div class="form-group"><label>${this.t('pu_manual_status')}</label><select id="pu_e_manual">${msOpts}</select></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_remarks')}</label><textarea id="pu_e_remarks" rows="2">${this.puEsc(po.remarks || '')}</textarea></div>
    </div>`;
  },

  puReadEditForm() {
    const val = id => document.getElementById(id)?.value.trim() || '';
    return {
      po_no: val('pu_e_no'),
      date: document.getElementById('pu_e_date')?.value || '',
      supplier: val('pu_e_supplier'),
      contract_no: val('pu_e_contract'),
      project: val('pu_e_project'),
      expected_date: document.getElementById('pu_e_expected')?.value || '',
      manual_status: document.getElementById('pu_e_manual')?.value || '',
      remarks: val('pu_e_remarks'),
    };
  },

  // 明细编辑表格（行内增删改；表头与明细一起保存）
  puRenderEditLines() {
    const box = document.getElementById('pu-edit-lines');
    if (!box) return;
    const vp = this.canViewPrice();
    const lines = this._puEditLines || [];
    const lk = this._puEditLookups || {};
    const mats = lk.materials || [];
    const cList = (lk.contracts || []).map(c => `<option value="${this.puEsc(c.contract_no)}"></option>`).join('');
    const matOpts = sel => {
      const list = this.puMatFiltered();
      if (sel && !list.some(m => m.code === sel)) {
        const cm = mats.find(m => m.code === sel);
        if (cm) list.unshift(cm);
      }
      return `<option value="">${this.t('please_select')}</option>` + list.map(m =>
        `<option value="${this.puEsc(m.code)}" ${m.code === sel ? 'selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
    };
    const cats = [...new Set(mats.map(m => m.category).filter(Boolean))].sort();
    const catOpts = `<option value="">${this.t('all')}</option>` + cats.map(c =>
      `<option value="${this.puEsc(c)}"${this._puMatCat === c ? ' selected' : ''}>${this.puEsc(c)}</option>`).join('');

    const colCount = vp ? 8 : 6;
    let tbody;
    if (!lines.length) {
      tbody = `<tr><td colspan="${colCount}" style="text-align:center;padding:26px;color:var(--text-muted)">
        ${this.t('pu_no_lines')}
        <div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="App.puEditAddRow()">+ ${this.t('pu_add_line')}</button></div>
      </td></tr>`;
    } else {
      tbody = lines.map((l, i) => {
        const recv = Number(l.received_qty || 0);
        const amt = (Number(l.order_qty) || 0) * (Number(l.order_price) || 0);
        return `<tr>
          <td style="min-width:220px"><select class="pu-line-mat" data-idx="${i}" onchange="App.puEditSet(${i},'code',this.value)">${matOpts(l.code)}</select></td>
          <td style="min-width:110px"><input type="number" step="0.0001" min="0" value="${l.order_qty || ''}" oninput="App.puEditSet(${i},'order_qty',this.value)"></td>
          ${vp ? `<td style="min-width:110px"><input type="number" step="0.01" min="0" value="${l.order_price || ''}" oninput="App.puEditSet(${i},'order_price',this.value)"></td>
          <td class="pu-edit-amt" data-amt="${i}">${this.fmtMoney(amt)}</td>` : ''}
          <td style="min-width:130px"><input list="pu_e_clist" value="${this.puEsc(l.contract_no || '')}" oninput="App.puEditSet(${i},'contract_no',this.value)"></td>
          <td style="min-width:140px"><input value="${this.puEsc(l.remarks || '')}" oninput="App.puEditSet(${i},'remarks',this.value)"></td>
          <td class="pu-edit-amt">${recv > 0 ? this.fmtQty(recv) : '—'}</td>
          <td><button type="button" class="pu-edit-del" onclick="App.puEditRemoveRow(${i})">${this.t('in_remove_row')}</button></td>
        </tr>`;
      }).join('');
    }
    box.innerHTML = `<datalist id="pu_e_clist">${cList}</datalist>
      <div class="pu-matfilter">
        <label>${this.t('mat_category')}<select id="pu_mat_cat">${catOpts}</select></label>
        <input id="pu_mat_kw" type="search" value="${this.puEsc(this._puMatKw || '')}" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}">
        <span class="pu-mu" id="pu_mat_cnt">${this.puMatFiltered().length} / ${mats.length}</span>
      </div>
      <div class="table-wrap"><table class="pu-edit-lines"><thead><tr>
        <th>${this.t('pu_material')}</th><th>${this.t('pu_order_qty')}</th>
        ${vp ? `<th>${this.t('pu_order_price')}</th><th class="text-right">${this.t('pu_line_amount')}</th>` : ''}
        <th>${this.t('pu_contract_filter')}</th><th>${this.t('pu_remarks')}</th>
        <th class="text-right">${this.t('pu_received_qty')}</th><th></th>
      </tr></thead><tbody>${tbody}</tbody></table></div>
      <div class="pu-edit-sum">
        <span>${this.t('pu_line_count')}: <b id="pu_es_lines">${lines.length}</b></span>
        <span>${this.t('pu_order_qty')}: <b id="pu_es_qty">${this.fmtQty(this.puEditTotalQty())}</b></span>
        ${vp ? `<span>${this.t('pu_order_amount')}: <b id="pu_es_amt">${this.fmtMoney(this.puEditTotalAmount())}</b></span>` : ''}
      </div>`;
    const cnt = document.getElementById('pu-edit-line-count');
    if (cnt) cnt.textContent = lines.length ? ' · ' + lines.length : '';
  },

  // 多关键字模糊匹配：空格分词，全部命中（AND）才算匹配
  puKwMatch(hay, kw) {
    const toks = String(kw || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return true;
    const s = String(hay || '').toLowerCase();
    return toks.every(t => s.includes(t));
  },

  // 物料下拉文案：编码 · 名称 规格 · 品牌
  puMatLabel(m) {
    const base = `${this.puEsc(m.code)} · ${this.puEsc(m.name || '')} ${this.puEsc(m.spec || '')}`.trim();
    return m.brand ? `${base} · ${this.puEsc(m.brand)}` : base;
  },

  // 物料筛选：类别（精确）+ 编码/名称/规格/品牌（多关键字模糊）
  puMatFiltered() {
    const mats = (this._puEditLookups || {}).materials || [];
    const cat = this._puMatCat || '';
    return mats.filter(m => {
      if (cat && m.category !== cat) return false;
      if (!this.puKwMatch([m.code, m.name, m.spec, m.brand].join(' '), this._puMatKw)) return false;
      return true;
    });
  },

  // 筛选变化时就地刷新各行的物料下拉，保留已选值（不重建整张表，避免输入焦点丢失）
  puRefreshMatOptions() {
    const mats = (this._puEditLookups || {}).materials || [];
    const list = this.puMatFiltered();
    const cnt = document.getElementById('pu_mat_cnt');
    if (cnt) cnt.textContent = `${list.length} / ${mats.length}`;
    document.querySelectorAll('#pu-edit-lines select.pu-line-mat').forEach(sel => {
      const cur = sel.value;
      const opts = list.slice();
      if (cur && !opts.some(m => m.code === cur)) {
        const cm = mats.find(m => m.code === cur);
        if (cm) opts.unshift(cm);
      }
      sel.innerHTML = `<option value="">${this.t('please_select')}</option>` + opts.map(m =>
        `<option value="${this.puEsc(m.code)}"${m.code === cur ? ' selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
    });
  },

  puEditTotalQty() { return (this._puEditLines || []).reduce((s, l) => s + (Number(l.order_qty) || 0), 0); },
  puEditTotalAmount() { return (this._puEditLines || []).reduce((s, l) => s + (Number(l.order_qty) || 0) * (Number(l.order_price) || 0), 0); },

  puEditRefreshSummary() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('pu_es_lines', String((this._puEditLines || []).length));
    set('pu_es_qty', this.fmtQty(this.puEditTotalQty()));
    if (this.canViewPrice()) set('pu_es_amt', this.fmtMoney(this.puEditTotalAmount()));
  },

  puEditSet(idx, field, val) {
    const l = (this._puEditLines || [])[idx];
    if (!l) return;
    if (field === 'order_qty' || field === 'order_price') l[field] = parseFloat(val) || 0;
    else l[field] = String(val == null ? '' : val);
    if (field === 'order_qty' || field === 'order_price') {
      if (this.canViewPrice()) {
        const cell = document.querySelector(`#pu-edit-lines [data-amt="${idx}"]`);
        if (cell) cell.textContent = this.fmtMoney((Number(l.order_qty) || 0) * (Number(l.order_price) || 0));
      }
      this.puEditRefreshSummary();
    }
  },

  puEditAddRow() {
    if (!this._puEditLines) this._puEditLines = [];
    const defContract = document.getElementById('pu_e_contract')?.value.trim() || '';
    this._puEditLines.push({ code: '', order_qty: '', order_price: '', contract_no: defContract, remarks: '' });
    this.puRenderEditLines();
  },

  puEditRemoveRow(idx) {
    const l = (this._puEditLines || [])[idx];
    if (!l) return;
    if (Number(l.received_qty || 0) > 0) { this.toast(this.t('pu_line_has_received'), 'error'); return; }
    this._puEditLines.splice(idx, 1);
    this.puRenderEditLines();
  },

  puCollectEditLines() {
    return (this._puEditLines || []).filter(l => l && l.code).map(l => ({
      id: l.id || undefined,
      code: l.code,
      order_qty: Number(l.order_qty) || 0,
      order_price: Number(l.order_price) || 0,
      contract_no: l.contract_no || '',
      remarks: l.remarks || '',
    }));
  },

  // 新建：POST 草稿单 → 进入明细编辑页
  async puCreateOrder() {
    if (!this.validateForm({ pu_e_date: [{ rule: 'required' }] })) return;
    const body = Object.assign(this.puReadEditForm(), { status: 'draft' });
    try {
      const r = await this.api('/api/purchase/orders', 'POST', body);
      this.toast(this.t('pu_order_created'));
      await this.puEditOrderPage(r.po_no);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // 保存草稿：表头 + 明细整单提交
  async puSaveOrderDraft() {
    const head = this.puReadEditForm();
    try {
      await this.api('/api/purchase/orders/' + encodeURIComponent(head.po_no), 'PUT', Object.assign({}, head, { lines: this.puCollectEditLines() }));
      this.toast(this.t('pu_draft_saved'));
      delete this._puDetail['orders:' + head.po_no];
      await this.puEditOrderPage(head.po_no);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // 确认采购单：先整单保存，再置为已确认
  puConfirmOrder() {
    const head = this.puReadEditForm();
    const lines = this.puCollectEditLines();
    if (!lines.length) { this.toast(this.t('pu_no_valid_line'), 'error'); return; }
    this.confirmDialog(this.t('pu_confirm_order'),
      `${this.t('pu_edit_hint')}\n\n${this.t('pu_line_count')}: ${lines.length}`,
      async () => {
        try {
          await this.api('/api/purchase/orders/' + encodeURIComponent(head.po_no), 'PUT', Object.assign({}, head, { lines }));
          const r = await this.api('/api/purchase/orders/' + encodeURIComponent(head.po_no) + '/confirm', 'POST', {});
          this.toast(this.t('pu_order_confirmed', { n: r.line_count }));
          delete this._puDetail['orders:' + head.po_no];
          await this.puBackToList(head.po_no);
        } catch (e) { this.toast(e.message, 'error'); }
      });
  },

  async puBackToList(openPo) {
    this.puState().view = 'list';
    this._puEditPo = null;
    this._puEditLines = [];
    await this.renderPurchase();
    if (openPo) this.puOpen('orders', openPo);
  },

  deletePurchaseOrder(poNo) {
    this.puConfirmDelete(this.t('pu_delete_order'), `${this.puEsc(poNo)} — ${this.t('pu_delete_order_msg')}`, async () => {
      let snap = this._puDetail['orders:' + poNo];
      snap = snap && snap.d ? snap.d : null;
      if (!snap) { try { snap = await this.api('/api/purchase/orders/' + encodeURIComponent(poNo)); } catch (_) { snap = null; } }
      await this.api('/api/purchase/orders/' + encodeURIComponent(poNo), 'DELETE');
      delete this._puDetail['orders:' + poNo];
      if (this.puState().sel && this.puState().sel.t === 'orders' && this.puState().sel.id === poNo) this.puCloseInspector();
      await this.loadPurchaseList();
      return async () => {
        if (snap) {
          await this.api('/api/purchase/orders', 'POST', {
            po_no: snap.po_no, date: snap.date, supplier: snap.supplier, contract_no: snap.contract_no,
            project: snap.project, expected_date: snap.expected_date, remarks: snap.remarks, manual_status: snap.manual_status,
            status: snap.status,
            lines: (snap.lines || []).map(l => ({ po_no: l.po_no, code: l.code, order_qty: l.order_qty, order_price: l.order_price, contract_no: l.contract_no || '', remarks: l.remarks || '' })),
          });
        }
        await this.loadPurchaseList();
      };
    }, this.t('pu_order_deleted'));
  },

  // ========== 采购明细增删改 ==========
  puFindLine(id) {
    const rec = this.puDetail();
    const lines = rec && rec.d ? (rec.d.lines || []) : (this._puList || []);
    return lines.find(l => Number(l.id) === Number(id)) || null;
  },

  // 单行弹窗的物料筛选：类别（精确）+ 编码/名称/规格/品牌（多关键字模糊）
  puLmFiltered() {
    const mats = this._puLmMats || [];
    const cat = this._puLmCat || '';
    return mats.filter(m => {
      if (cat && m.category !== cat) return false;
      if (!this.puKwMatch([m.code, m.name, m.spec, m.brand].join(' '), this._puLmKw)) return false;
      return true;
    });
  },

  // 弹窗内筛选变化时就地刷新物料下拉（保留已选值，不重建输入框，避免焦点/中文输入被打断）
  puRefreshLmOptions() {
    const mats = this._puLmMats || [];
    const list = this.puLmFiltered();
    const cnt = document.getElementById('pu_lm_cnt');
    if (cnt) cnt.textContent = `${list.length} / ${mats.length}`;
    const sel = document.getElementById('pu_l_code');
    if (!sel) return;
    const cur = sel.value;
    const opts = list.slice();
    if (cur && !opts.some(m => m.code === cur)) {
      const cm = mats.find(m => m.code === cur);
      if (cm) opts.unshift(cm);
    }
    sel.innerHTML = opts.map(m =>
      `<option value="${this.puEsc(m.code)}"${m.code === cur ? ' selected' : ''}>${this.puMatLabel(m)}</option>`).join('');
  },

  async puLineModal(line, poNo) {
    const { contracts, materials } = await this.puLookups();
    const isEdit = !!(line && line.id);
    const l = line || { code: '', order_qty: '', order_price: '', contract_no: '', remarks: '' };
    this._puLmMats = materials;
    this._puLmCat = '';
    this._puLmKw = '';
    const list = isEdit ? materials : this.puLmFiltered();
    const matOpts = list.map(m =>
      `<option value="${this.puEsc(m.code)}" ${m.code === l.code ? 'selected' : ''}>${this.puMatLabel(m)}</option>`
    ).join('');
    const cList = contracts.map(c => `<option value="${c.contract_no}"></option>`).join('');
    const cats = [...new Set(materials.map(m => m.category).filter(Boolean))].sort();
    const catOpts = `<option value="">${this.t('all')}</option>` + cats.map(c =>
      `<option value="${this.puEsc(c)}">${this.puEsc(c)}</option>`).join('');
    // 仅新增时可筛选物料（编辑时物料锁定不可改）
    const matFilter = isEdit ? '' : `<div class="pu-matfilter">
        <label>${this.t('mat_category')}<select id="pu_lm_cat">${catOpts}</select></label>
        <input id="pu_lm_kw" type="search" value="" placeholder="${this.t('pu_mat_filter_ph')}" aria-label="${this.t('pu_mat_filter_ph')}">
        <span class="pu-mu" id="pu_lm_cnt">${list.length} / ${materials.length}</span>
      </div>`;
    const body = `<div class="form-grid" style="max-width:none">
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_material')} *</label>
        ${matFilter}
        <select id="pu_l_code" ${isEdit ? 'disabled' : ''}>${matOpts}</select>
        <div class="form-error" id="pu_l_code_error"></div></div>
      <div class="form-group"><label>${this.t('pu_order_qty')} *</label><input id="pu_l_qty" type="number" step="0.0001" min="0" value="${l.order_qty}" oninput="App.clearFieldError('pu_l_qty')"><div class="form-error" id="pu_l_qty_error"></div></div>
      <div class="form-group"><label>${this.t('pu_order_price')}</label><input id="pu_l_price" type="number" step="0.01" min="0" value="${l.order_price}"></div>
      <div class="form-group"><label>${this.t('pu_contract_filter')}</label><input id="pu_l_contract" list="pu_l_c_list" value="${this.puEsc(l.contract_no || '')}"><datalist id="pu_l_c_list">${cList}</datalist></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_remarks')}</label><textarea id="pu_l_remarks" rows="2">${this.puEsc(l.remarks || '')}</textarea></div>
    </div>`;
    this.showModal(`<h3>${isEdit ? this.t('pu_edit_line') : this.t('pu_add_line')}</h3>`, body,
      isEdit ? this.t('save') : this.t('add'), async () => {
        if (!this.validateForm({ pu_l_qty: [{ rule: 'required' }, { rule: 'number' }, { rule: 'positive' }] })) return;
        const payload = {
          po_no: poNo,
          code: document.getElementById('pu_l_code').value,
          order_qty: Number(document.getElementById('pu_l_qty').value || 0),
          order_price: Number(document.getElementById('pu_l_price').value || 0),
          contract_no: document.getElementById('pu_l_contract').value.trim(),
          remarks: document.getElementById('pu_l_remarks').value.trim(),
        };
        if (!payload.code) { this.setFieldError('pu_l_code', this.t('pu_need_material')); return; }
        try {
          await this.api('/api/purchase/lines' + (isEdit ? '/' + l.id : ''), isEdit ? 'PUT' : 'POST', payload);
          this.closeModal();
          this.toast(isEdit ? this.t('pu_line_updated') : this.t('pu_line_added'));
          this.puRefreshCurrent();
        } catch (e) { this.toast(e.message, 'error'); }
      }, null, true);
  },

  addPurchaseLine(poNo) { this.puLineModal(null, poNo); },

  editPurchaseLine(id) {
    const line = this.puFindLine(id);
    if (!line) { this.toast(this.t('requestFailed'), 'error'); return; }
    this.puLineModal(line, line.po_no);
  },

  deletePurchaseLine(id) {
    const line = this.puFindLine(id);
    if (!line) { this.toast(this.t('requestFailed'), 'error'); return; }
    const label = `${line.code} ${line.material_name || ''}`;
    this.puConfirmDelete(this.t('pu_delete_line'), label, async () => {
      await this.api('/api/purchase/lines/' + id, 'DELETE');
      this.puRefreshCurrent();
      return async () => {
        await this.api('/api/purchase/lines', 'POST', {
          po_no: line.po_no, code: line.code, order_qty: line.order_qty, order_price: line.order_price,
          contract_no: line.contract_no || '', remarks: line.remarks || '',
        });
        this.puRefreshCurrent();
      };
    }, this.t('pu_line_deleted'));
  },

  puRefreshCurrent() {
    const s = this.puState();
    if (s.sel) { delete this._puDetail[s.sel.t + ':' + s.sel.id]; this.puOpen(s.sel.t, s.sel.id); }
    else this.loadPurchaseList();
  },

  // ========== 合同增删改 ==========
  async editContract(contractNo) {
    const isEdit = !!contractNo;
    let c = { contract_no: '', name: '', supplier: '', sign_date: '', amount: '', status: 'active', remarks: '' };
    if (isEdit) {
      const rec = this._puDetail['contracts:' + contractNo];
      if (rec && rec.d) c = rec.d;
      else {
        try { c = await this.api('/api/purchase/contracts/' + encodeURIComponent(contractNo)); }
        catch (e) { this.toast(e.message, 'error'); return; }
      }
    }
    const { suppliers } = await this.puLookups();
    const supList = suppliers.map(x => `<option value="${x.name}"></option>`).join('');
    const stOpts = [['active', this.t('pu_status_active')], ['closed', this.t('pu_status_closed_c')]]
      .map(([v, label]) => `<option value="${v}" ${(c.status || 'active') === v ? 'selected' : ''}>${label}</option>`).join('');
    const body = `<div class="form-grid" style="max-width:none">
      <div class="form-group"><label>${this.t('pu_contract_no')} *</label><input id="pu_c_no" value="${this.puEsc(c.contract_no)}" ${isEdit ? 'readonly' : ''} oninput="App.clearFieldError('pu_c_no')"><div class="form-error" id="pu_c_no_error"></div></div>
      <div class="form-group"><label>${this.t('pu_contract_name')}</label><input id="pu_c_name" value="${this.puEsc(c.name || '')}"></div>
      <div class="form-group"><label>${this.t('pu_supplier')}</label><input id="pu_c_supplier" list="pu_c_sup_list" value="${this.puEsc(c.supplier || '')}"><datalist id="pu_c_sup_list">${supList}</datalist></div>
      <div class="form-group"><label>${this.t('pu_sign_date')}</label><input id="pu_c_sign" type="date" value="${this.fmtDate(c.sign_date)}"></div>
      <div class="form-group"><label>${this.t('pu_contract_amount')}</label><input id="pu_c_amount" type="number" step="0.01" min="0" value="${c.amount || ''}"></div>
      <div class="form-group"><label>${this.t('pu_status')}</label><select id="pu_c_status">${stOpts}</select></div>
      <div class="form-group" style="grid-column:1/-1"><label>${this.t('pu_remarks')}</label><textarea id="pu_c_remarks" rows="2">${this.puEsc(c.remarks || '')}</textarea></div>
    </div>`;
    this.showModal(`<h3>${isEdit ? this.t('pu_edit_contract') : this.t('pu_new_contract')}</h3>`, body,
      isEdit ? this.t('save') : this.t('create'), async () => {
        if (!this.validateForm({ pu_c_no: [{ rule: 'required' }] })) return;
        const payload = {
          contract_no: document.getElementById('pu_c_no').value.trim(),
          name: document.getElementById('pu_c_name').value.trim(),
          supplier: document.getElementById('pu_c_supplier').value.trim(),
          sign_date: document.getElementById('pu_c_sign').value,
          amount: Number(document.getElementById('pu_c_amount').value || 0),
          status: document.getElementById('pu_c_status').value,
          remarks: document.getElementById('pu_c_remarks').value.trim(),
        };
        try {
          await this.api('/api/purchase/contracts' + (isEdit ? '/' + encodeURIComponent(contractNo) : ''), isEdit ? 'PUT' : 'POST', payload);
          this.closeModal();
          this.toast(isEdit ? this.t('pu_contract_updated') : this.t('pu_contract_created'));
          if (isEdit) { delete this._puDetail['contracts:' + contractNo]; if (this.puState().sel && this.puState().sel.id === contractNo) this.puOpen('contracts', contractNo); else this.loadPurchaseList(); }
          else await this.loadPurchaseList();
        } catch (e) { this.toast(e.message, 'error'); }
      }, null, true);
  },

  deleteContract(contractNo) {
    this.puConfirmDelete(this.t('pu_delete_contract'), `${this.puEsc(contractNo)} — ${this.t('pu_delete_contract_msg')}`, async () => {
      let snap = this._puDetail['contracts:' + contractNo];
      snap = snap && snap.d ? snap.d : null;
      if (!snap) { try { snap = await this.api('/api/purchase/contracts/' + encodeURIComponent(contractNo)); } catch (_) { snap = null; } }
      await this.api('/api/purchase/contracts/' + encodeURIComponent(contractNo), 'DELETE');
      delete this._puDetail['contracts:' + contractNo];
      if (this.puState().sel && this.puState().sel.t === 'contracts' && this.puState().sel.id === contractNo) this.puCloseInspector();
      await this.loadPurchaseList();
      return async () => {
        if (snap) {
          await this.api('/api/purchase/contracts', 'POST', {
            contract_no: snap.contract_no, name: snap.name, supplier: snap.supplier,
            sign_date: snap.sign_date, amount: snap.amount, status: snap.status, remarks: snap.remarks,
          });
        }
        await this.loadPurchaseList();
      };
    }, this.t('pu_contract_deleted'));
  },
});
