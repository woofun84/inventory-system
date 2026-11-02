/**
 * 前端验证脚本：登录后遍历所有页面，收集控制台错误与 JS 异常，
 * 验证拆分后的模块全部正确加载并挂载到 App 上。
 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:3000';
const PAGES = [
  'dashboard', 'materials', 'inbound', 'outbound', 'stockSummary',
  'query', 'ledger', 'locationStock', 'orders', 'suppliers',
  'settings', 'orderTracking', 'users'
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];

  page.on('console', m => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

  // 登录
  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin123');
  await page.click('button[type=submit], .login-btn, input[type=submit]');
  await page.waitForTimeout(2500);
  console.log('登录后 URL:', page.url());

  // 检查关键全局对象
  const globals = await page.evaluate(() => ({
    hasApp: typeof window.App === 'object' && window.App !== null,
    hasI18N: typeof window.I18N === 'object' && window.I18N !== null,
    methodCount: window.App ? Object.keys(window.App).filter(k => typeof window.App[k] === 'function').length : 0,
    i18nZh: window.I18N?.zh ? Object.keys(window.I18N.zh).length : 0,
    i18nEn: window.I18N?.en ? Object.keys(window.I18N.en).length : 0,
  }));
  console.log('全局对象检查:', JSON.stringify(globals));

  // 遍历所有页面
  for (const p of PAGES) {
    const before = errors.length;
    await page.evaluate(h => { location.hash = '#' + h; }, p);
    await page.waitForTimeout(1400);
    const title = await page.evaluate(() => document.querySelector('.page-title')?.textContent?.trim() || '(无标题)');
    const rows = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
    const newErr = errors.length - before;
    console.log(`  ${p.padEnd(14)} 标题="${title}"  行数=${String(rows).padStart(3)}  ${newErr ? '❌ ' + newErr + ' 个错误' : '✓'}`);
  }

  // 出库弹窗专项：检查「可用库存」列是否渲染
  await page.evaluate(() => { location.hash = '#outbound'; });
  await page.waitForTimeout(1200);
  const addBtn = await page.$('button:has-text("新增")');
  if (addBtn) {
    await addBtn.click();
    await page.waitForTimeout(2000);
    const modalInfo = await page.evaluate(() => {
      const modal = document.querySelector('#modal-overlay .modal');
      if (!modal) return { found: false };
      const headers = [...modal.querySelectorAll('thead th')].map(t => t.textContent.trim());
      const rows = [...modal.querySelectorAll('#ob_rows tr')];
      const availCells = rows.map(r => r.querySelector('.ob-available')?.textContent?.trim());
      return { found: true, headers, availCells };
    });
    console.log('出库弹窗:', JSON.stringify(modalInfo, null, 2));
  } else {
    console.log('出库弹窗: 未找到新增按钮');
  }

  console.log('\n=== 控制台错误汇总 ===');
  if (errors.length === 0) console.log('无错误 ✓');
  else errors.forEach(e => console.log('  ' + e));

  await browser.close();
})();
