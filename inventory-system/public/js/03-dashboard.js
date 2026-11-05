/**
 * 仪表盘 —— 指标卡与 Chart.js 图表
 * 注意：主题切换时需 destroyCharts() 后重建，图表颜色动态取值
 */
Object.assign(App, {
  // ========== 仪表盘 ==========
  async renderDashboard() {
    this.setMain(this.pageWrap('🏠 ' + this.t('dash_title'), this.t('dash_desc'), '', `<div id="dashboard-content"><p style="text-align:center;padding:40px;color:var(--text-muted)">${this.t('loading')}</p></div>`));
    try {
      const data = await this.api('/api/dashboard'); const cur = data.currency; const vp = this.canViewPrice(); let html = '';
      html += `<div class="metric-grid">
        <div class="metric-card"><div class="metric-label">🔖 ${this.t('dash_total_items')}</div><div class="metric-value">${data.total_items}</div><div class="metric-sub">${this.t('dash_items_sub')}</div></div>
        ${vp ? `<div class="metric-card metric-success"><div class="metric-label">💰 ${this.t('dash_total_value')}</div><div class="metric-value">${cur} ${this.fmtMoney(data.total_value)}</div><div class="metric-sub">${this.t('dash_value_sub')}</div></div>
        <div class="metric-card metric-info"><div class="metric-label">📥 ${this.t('dash_month_in')}</div><div class="metric-value">${cur} ${this.fmtMoney(data.month_in_amount)}</div><div class="metric-sub">${this.t('dash_month_in_sub')}</div></div>
        <div class="metric-card metric-warning"><div class="metric-label">📤 ${this.t('dash_month_out')}</div><div class="metric-value">${cur} ${this.fmtMoney(data.month_out_amount)}</div><div class="metric-sub">${this.t('dash_month_out_sub')}</div></div>` : ''}
        <div class="metric-card"><div class="metric-label">🧾 ${this.t('dash_month_txn')}</div><div class="metric-value">${data.month_txn_count}</div><div class="metric-sub">${this.t('dash_txn_sub')}</div></div>
        <div class="metric-card metric-danger"><div class="metric-label">⚠ ${this.t('dash_alerts')}</div><div class="metric-value">${data.alert_count}</div><div class="metric-sub">${this.t('dash_alerts_sub')}</div></div></div>`;
      if (vp) html += `<div class="chart-grid"><div class="card"><div class="card-title">${this.t('dash_trend')}</div><div class="chart-container"><canvas id="trendChart"></canvas></div></div><div class="card"><div class="card-title">${this.t('dash_category')}</div><div class="chart-container"><canvas id="categoryChart"></canvas></div></div></div>`;
      if (vp) html += `<div class="card"><div class="card-title">${this.t('dash_top5')}</div><div class="chart-container"><canvas id="topChart"></canvas></div></div>`;
      if (data.alerts.length > 0) {
        html += `<div class="card"><div class="card-title">⚠ ${this.t('dash_alert_list')} — ${data.alert_count} ${this.t('stock_items')}</div><div class="table-wrap"><table><thead><tr><th>${this.t('mat_code')}</th><th>${this.t('mat_name')}</th><th>${this.t('mat_spec')}</th><th>${this.t('stock_on_hand')}</th><th>${this.t('stock_min')}</th><th>${this.t('mat_status')}</th></tr></thead><tbody>${data.alerts.map(a => `<tr><td>${a.code}</td><td>${a.name}</td><td>${a.spec || ''}</td><td class="text-right">${a.on_hand}</td><td class="text-right">${a.min_stock}</td><td>${this.statusBadge(a.stock_status)}</td></tr>`).join('')}</tbody></table></div></div>`;
      }
      if (data.overdue_orders.length > 0) {
        html += `<div class="card"><div class="card-title">🛒 ${this.t('dash_overdue')} (${data.overdue_orders.length})</div><div class="table-wrap"><table><thead><tr><th>${this.t('po_no')}</th><th>${this.t('po_supplier')}</th><th>${this.t('po_expected')}</th><th>${this.t('po_overdue')}</th><th>${this.t('po_delivery')}</th>${vp ? `<th>${this.t('po_amount')}</th>` : ''}</tr></thead><tbody>${data.overdue_orders.map(o => `<tr><td>${o.po_no}</td><td>${o.supplier}</td><td>${this.fmtDate(o.expected_date)}</td><td class="text-center"><span class="badge badge-danger">${o.overdue_days}</span></td><td>${this.statusBadge(o.delivery_status)}</td>${vp ? `<td class="text-right">${cur} ${this.fmtMoney(o.order_amount)}</td>` : ''}</tr>`).join('')}</tbody></table></div></div>`;
      }
      document.getElementById('dashboard-content').innerHTML = html;
      this.renderCharts(data, vp);
    } catch (e) {
      document.getElementById('dashboard-content').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><p>${e.message}</p></div>`;
    }
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
    this.charts.push(new Chart(ctx, { type: 'bar', data: { labels: data.map(d => d.label), datasets: [
      { label: this.t('dash_in_amount'), data: data.map(d => d.in_amount), backgroundColor: '#3b82f6', borderRadius: 4 },
      { label: this.t('dash_out_cost'), data: data.map(d => d.out_amount), backgroundColor: '#f59e0b', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, color: tc } } }, scales: { y: { beginAtZero: true, ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } }, x: { ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } } } } }));
  },

  renderCategoryChart(data) {
    const ctx = document.getElementById('categoryChart'); if (!ctx) return;
    const tc = this.chartTextColor();
    const labels = Object.keys(data), values = Object.values(data);
    const colors = ['#3b82f6','#f59e0b','#16a34a','#dc2626','#0891b2','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1'];
    this.charts.push(new Chart(ctx, { type: 'doughnut', data: { labels, datasets: [{ data: values, backgroundColor: colors }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 }, color: tc } } } } }));
  },

  renderTopChart(data) {
    const ctx = document.getElementById('topChart'); if (!ctx) return;
    const tc = this.chartTextColor(), gc = this.chartGridColor();
    this.charts.push(new Chart(ctx, { type: 'bar', data: { labels: data.map(d => d.name), datasets: [{ label: this.t('dash_stock_value'), data: data.map(d => d.value), backgroundColor: '#3b82f6', borderRadius: 4 }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { font: { size: 10 }, color: tc }, grid: { color: gc } }, y: { ticks: { font: { size: 11 }, color: tc }, grid: { color: gc } } } } }));
  },

});

undefined
