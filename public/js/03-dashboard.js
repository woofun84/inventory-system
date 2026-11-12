/**
 * 仪表盘 —— 指标卡与 Chart.js 图表
 * 注意：主题切换时需 destroyCharts() 后重建，图表颜色动态取值
 */
Object.assign(App, {
  // ========== 仪表盘 ==========
  async renderDashboard() {
    this.setMain(this.pageWrap('🏠 ' + this.t('dash_title'), this.t('dash_desc'), '', `<div id="dashboard-content"><p style="text-align:center;padding:40px;color:var(--text-muted)">${this.t('loading')}</p></div>`));
    try {
      const data = await this.api('/api/dashboard');
      // 无价格权限时服务端不返回金额字段，据此决定金额卡片/图表/列是否渲染
      const vp = 'total_value' in data;
      let html = '';
      const cv = data.cost_variance || { total: 0, count: 0, ratio: 0.05, exceeded: false };
      const cvSub = cv.count
        ? this.t('dash_cost_variance_count', { n: cv.count })
        : this.t('dash_cost_variance_none');
      html += `<div class="metric-grid">
        <div class="metric-card"><div class="metric-label">🔖 ${this.t('dash_total_items')}</div><div class="metric-value">${data.total_items}</div><div class="metric-sub">${this.t('dash_items_sub')}</div></div>
        ${vp ? `<div class="metric-card metric-success"><div class="metric-label">💰 ${this.t('dash_total_value')}</div><div class="metric-value">${this.fmtMoney(data.total_value)}</div><div class="metric-sub">${this.t('dash_value_sub')}</div></div>
        <div class="metric-card ${cv.exceeded ? 'metric-diff-alert' : ''}" style="cursor:pointer" onclick="App.showCostVariance()" title="${this.t('dash_cost_variance_desc')}"><div class="metric-label">≠ ${this.t('dash_cost_variance')}</div><div class="metric-value">${this.fmtMoney(cv.total)}</div><div class="metric-sub">${cvSub}${cv.exceeded ? ' · ' + this.t('dash_cost_variance_alert', { pct: Math.round(cv.ratio * 1000) / 10 }) : ''}</div></div>
        <div class="metric-card metric-info"><div class="metric-label">📥 ${this.t('dash_month_in')}</div><div class="metric-value">${this.fmtMoney(data.month_in_amount)}</div><div class="metric-sub">${this.t('dash_month_in_sub')}</div></div>
        <div class="metric-card metric-warning"><div class="metric-label">📤 ${this.t('dash_month_out')}</div><div class="metric-value">${this.fmtMoney(data.month_out_amount)}</div><div class="metric-sub">${this.t('dash_month_out_sub')}</div></div>` : ''}
        <div class="metric-card"><div class="metric-label">🧾 ${this.t('dash_month_txn')}</div><div class="metric-value">${data.month_txn_count}</div><div class="metric-sub">${this.t('dash_txn_sub')}</div></div>
        <div class="metric-card metric-danger"><div class="metric-label">⚠ ${this.t('dash_alerts')}</div><div class="metric-value">${data.alert_count}</div><div class="metric-sub">${this.t('dash_alerts_sub')}</div></div></div>`;
      html += this.renderMonthBreakdown(data, vp);
      if (vp) html += `<div class="chart-grid"><div class="card"><div class="card-title">${this.t('dash_trend')}</div><div class="chart-container"><canvas id="trendChart"></canvas></div></div><div class="card"><div class="card-title">${this.t('dash_category')}</div><div class="chart-container"><canvas id="categoryChart"></canvas></div></div></div>`;
      if (vp) html += `<div class="card"><div class="card-title">${this.t('dash_top5')}</div><div class="chart-container"><canvas id="topChart"></canvas></div></div>`;
      if (data.alerts.length > 0) {
        html += `<div class="card"><div class="card-title">⚠ ${this.t('dash_alert_list')} — ${data.alert_count} ${this.t('stock_items')}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th><th>${this.t('stock_on_hand')}</th><th>${this.t('stock_min')}</th><th>${this.t('mat_status')}</th></tr></thead><tbody>${data.alerts.map(a => `<tr><td>${a.code}</td><td>${a.name}</td><td>${a.spec || ''}</td><td class="text-right">${a.on_hand}</td><td class="text-right">${a.min_stock}</td><td>${this.statusBadge(a.stock_status)}</td></tr>`).join('')}</tbody></table></div></div>`;
      }
      if (data.overdue_orders.length > 0) {
        html += `<div class="card"><div class="card-title">🛒 ${this.t('dash_overdue')} (${data.overdue_orders.length})</div><div class="table-wrap"><table><thead><tr><th>${this.t('po_no')}</th><th>${this.t('po_supplier')}</th><th>${this.t('po_expected')}</th><th>${this.t('po_overdue')}</th><th>${this.t('po_delivery')}</th>${vp ? `<th>${this.t('po_amount')}</th>` : ''}</tr></thead><tbody>${data.overdue_orders.map(o => `<tr><td>${o.po_no}</td><td>${o.supplier}</td><td>${this.fmtDate(o.expected_date)}</td><td class="text-center"><span class="badge badge-danger">${o.overdue_days}</span></td><td>${this.statusBadge(o.delivery_status)}</td>${vp ? `<td class="text-right">${this.fmtMoney(o.order_amount)}</td>` : ''}</tr>`).join('')}</tbody></table></div></div>`;
      }
      document.getElementById('dashboard-content').innerHTML = html;
      this.renderCharts(data, vp);
    } catch (e) {
      document.getElementById('dashboard-content').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><p>${e.message}</p></div>`;
    }
  },

  // 本月业务构成：样式与入库/出库/采购保持同一套 pu-card 卡片规范
  renderMonthBreakdown(data, vp) {
    const rows = data.month_breakdown || [];
    const total = data.month_breakdown_total || { doc_count: 0, qty: 0, amount: 0 };
    const dirs = {
      purchase_in: [this.docTypeBadgeClass('采购入库'), 'dash_dir_in'],
      misc_in: [this.docTypeBadgeClass('零星入库'), 'dash_dir_in'],
      purchase_return: [this.docTypeBadgeClass('采购退货'), 'dash_dir_return'],
      normal_out: [this.docTypeBadgeClass('正常出库'), 'dash_dir_out'],
      return_with: [this.docTypeBadgeClass('领料退库'), 'dash_dir_return_in'],
      return_without: [this.docTypeBadgeClass('领料退库'), 'dash_dir_return_in'],
    };
    let body;
    if (!total.doc_count) {
      body = `<div class="comp-empty">${this.t('dash_comp_empty')}</div>`;
    } else {
      const amountTh = vp ? `<th class="text-right">${this.t('dash_comp_amount')}</th>` : '';
      body = `<div class="table-wrap"><table><thead><tr>
        <th>${this.t('dash_comp_type')}</th><th class="text-right">${this.t('dash_comp_txns')}</th>
        <th class="text-right">${this.t('dash_comp_qty')}</th>${amountTh}
      </tr></thead><tbody>${rows.map(r => {
        const [cls, dirKey] = dirs[r.key] || ['badge-info', 'dash_dir_in'];
        return `<tr><td><span class="comp-type"><span class="badge ${cls}">${this.t(dirKey)}</span>${this.t('dash_comp_' + r.key)}</span></td>
          <td class="text-right">${r.doc_count}</td><td class="text-right">${this.fmtQty(r.qty)}</td>${vp ? `<td class="text-right">${this.fmtMoney(r.amount)}</td>` : ''}</tr>`;
      }).join('')}
        <tr class="comp-total-row"><td>${this.t('dash_comp_total')}</td><td class="text-right">${total.doc_count}</td>
          <td class="text-right">${this.fmtQty(total.qty)}</td>${vp ? `<td class="text-right">${this.fmtMoney(total.amount)}</td>` : ''}</tr>
      </tbody></table></div>`;
    }
    return `<div class="pu-card"><div class="pu-card-title"><span>📊</span>${this.t('dash_comp_title')}<small>${this.t('dash_comp_desc')}</small></div>${body}</div>`;
  },

  // 累计成本差异明细：点开看板卡片后弹出「构成」——每条都能追到来源单据与明细行
  async showCostVariance() {
    try {
      const d = await this.api('/api/cost-variance');
      let body;
      if (!d.rows.length) {
        body = `<div class="empty-state" style="padding:24px"><div class="empty-state-icon">✓</div><p>${this.t('cv_empty')}</p></div>`;
      } else {
        // 业务类型存的是中文，英文界面按现有字典翻译
        const BIZ_KEY = {
          '采购入库': 'dash_comp_purchase_in', '零星入库': 'dash_comp_misc_in',
          '采购退货': 'dash_comp_purchase_return', '正常出库': 'dash_comp_normal_out',
          '领料退库': 'dash_dir_return_in',
        };
        // 无价格权限时服务端已删掉 unit_cost/avg_cost/amount 与 total，按字段存在性决定是否渲染价格列
        const vp = this.priceVisible(d.rows, 'unit_cost');
        const rows = d.rows.map(r => `<tr>
          <td>${this.fmtDate(r.business_date)}</td>
          <td>${this.docEsc(r.source_doc_id || '-')}${r.source_line_id ? `<br><span style="font-size:11px;color:var(--text-muted)">${this.t('cv_line')} #${r.source_line_id}</span>` : ''}</td>
          <td>${BIZ_KEY[r.business_type] ? this.t(BIZ_KEY[r.business_type]) : this.docEsc(r.business_type || '-')}</td>
          <td>${r.code}${r.material_name ? `<br><span style="font-size:11px;color:var(--text-muted)">${this.docEsc(r.material_name)}</span>` : ''}</td>
          <td class="text-right">${this.fmtQty(r.qty)}</td>
          ${vp ? `<td class="text-right">${this.fmtQty(r.unit_cost)}</td>
          <td class="text-right">${this.fmtQty(r.avg_cost)}</td>
          <td class="text-right"><b>${this.fmtMoney(r.amount)}</b></td>` : ''}
          <td><span class="badge badge-warning">${this.t('cv_reason_' + r.reason)}</span></td>
        </tr>`).join('');
        body = `<p style="color:var(--text-muted);font-size:12px;margin:0 0 10px">${this.t('cv_notice')}</p>
          <div class="table-wrap"><table><thead><tr>
            <th>${this.t('cv_date')}</th><th>${this.t('cv_doc')}</th><th>${this.t('cv_biz')}</th><th>${this.t('cv_code')}</th>
            <th class="text-right">${this.t('cv_qty')}</th>${vp ? `<th class="text-right">${this.t('cv_unit_cost')}</th>
            <th class="text-right">${this.t('cv_avg_cost')}</th><th class="text-right">${this.t('cv_amount')}</th>` : ''}<th>${this.t('cv_reason')}</th>
          </tr></thead><tbody>${rows}</tbody>
          ${vp ? `<tfoot><tr><td colspan="7" class="text-right"><b>${this.t('cv_total')}</b></td>
            <td class="text-right"><b>${this.fmtMoney(d.total)}</b></td><td></td></tr></tfoot>` : ''}</table></div>`;
      }
      this.showModal(`<h3>≠ ${this.t('cv_title')}</h3>`, body, this.t('close'), () => this.closeModal(), null, true);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  renderCharts(data, vp) {
    if (vp) {
      this.renderTrendChart(data.months_trend);
      this.renderCategoryChart(data.category_values);
      this.renderTopChart(data.top_items);
    }
  },

  renderTrendChart(data) {
    const ctx = document.getElementById('trendChart'); if (!ctx) return;
    const tc = this.chartTextColor(), gc = this.chartGridColor();
    const inColor = this.cssVar('--flow-in', '#16a34a'), outColor = this.cssVar('--flow-out', '#f59e0b');
    this.charts.push(new Chart(ctx, { type: 'bar', data: { labels: data.map(d => d.label), datasets: [
      { label: this.t('dash_in_amount'), data: data.map(d => d.in_amount), backgroundColor: inColor, borderRadius: 4 },
      { label: this.t('dash_out_cost'), data: data.map(d => d.out_amount), backgroundColor: outColor, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, color: tc } } }, scales: { y: { beginAtZero: true, ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } }, x: { ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } } } } }));
  },

  renderCategoryChart(data) {
    const ctx = document.getElementById('categoryChart'); if (!ctx) return;
    const tc = this.chartTextColor();
    const labels = Object.keys(data), values = Object.values(data);
    const colors = Array.from({ length: 10 }, (_, i) => this.cssVar('--chart-' + (i + 1), '#3b82f6'));
    this.charts.push(new Chart(ctx, { type: 'doughnut', data: { labels, datasets: [{ data: values, backgroundColor: colors }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 }, color: tc } } } } }));
  },

  renderTopChart(data) {
    const ctx = document.getElementById('topChart'); if (!ctx) return;
    const tc = this.chartTextColor(), gc = this.chartGridColor();
    this.charts.push(new Chart(ctx, { type: 'bar', data: { labels: data.map(d => d.name), datasets: [{ label: this.t('dash_stock_value'), data: data.map(d => d.value), backgroundColor: this.cssVar('--chart-1', '#3b82f6'), borderRadius: 4 }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } }, y: { ticks: { font: { size: 11 }, color: tc }, grid: { color: gc } } } } }));
  },

});

undefined
