/**
 * 专项验证：出库弹窗中选中物料后，「可用库存」列应显示数值，
 * 且输入超量数量时应标红提示。
 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:3000';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin123');
  await page.click('#btn-login');
  await page.waitForTimeout(2500);

  await page.evaluate(() => { location.hash = '#outbound'; });
  await page.waitForTimeout(1500);

  // 打开新增弹窗
  await page.click('button:has-text("新增出库")');
  await page.waitForTimeout(2000);

  // 第一行：选类别 -> 名称 -> 规格（挑选有正库存的物料）
  const target = await page.evaluate(async () => {
    const res = await fetch('/api/stock-summary', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    const s = await res.json();
    const ok = s.filter(x => x.on_hand > 0).sort((a, b) => b.on_hand - a.on_hand);
    return ok[0] || null;
  });
  console.log('目标物料(有正库存):', target ? `${target.code} ${target.name} = ${target.on_hand}` : '无');

  const pickByCode = async (code) => {
    // 通过页面内的 App 方法直接驱动联动
    return await page.evaluate((c) => {
      const tr = document.querySelector('#ob_rows tr');
      const m = (App._materialsCache || []).find(x => x.code === c);
      if (!m) return 'material not in cache';
      const catSel = tr.querySelector('.ob-cat');
      catSel.value = m.category;
      App.onOutboundRowCatChange(catSel);
      const nameSel = tr.querySelector('.ob-name');
      nameSel.value = m.name;
      App.onOutboundRowNameChange(nameSel);
      const specSel = tr.querySelector('.ob-spec-sel');
      specSel.value = c;
      App.onOutboundRowSpecChange(specSel);
      return 'ok';
    }, code);
  };
  const pickRes = await pickByCode(target.code);
  console.log('选择结果:', pickRes);
  await page.waitForTimeout(800);

  // 读取可用库存显示
  const avail = await page.evaluate(() => {
    const cell = document.querySelector('#ob_rows tr .ob-available');
    return { text: cell?.textContent?.trim(), color: cell?.style.color };
  });
  console.log('可用库存单元格:', JSON.stringify(avail));

  // 查该物料真实库存做对比
  const realStock = await page.evaluate(async (code) => {
    const res = await fetch('/api/stock-summary', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    const s = await res.json();
    return s.find(x => x.code === code);
  }, target.code);
  console.log('后端真实库存:', realStock ? `${realStock.code} ${realStock.name} = ${realStock.on_hand}` : '未找到');

  // 输入超量数量，看是否标红
  const qtyInput = await page.$('#ob_rows tr .ob-qty');
  await qtyInput.fill('999999');
  await page.waitForTimeout(600);
  const afterOver = await page.evaluate(() => {
    const cell = document.querySelector('#ob_rows tr .ob-available');
    const input = document.querySelector('#ob_rows tr .ob-qty');
    return { cellColor: cell?.style.color, borderColor: input?.style.borderColor };
  });
  console.log('输入超量后:', JSON.stringify(afterOver));

  // 输入正常数量
  await qtyInput.fill('1');
  await page.waitForTimeout(600);
  const afterOk = await page.evaluate(() => {
    const cell = document.querySelector('#ob_rows tr .ob-available');
    const input = document.querySelector('#ob_rows tr .ob-qty');
    return { cellColor: cell?.style.color, borderColor: input?.style.borderColor };
  });
  console.log('输入正常量后:', JSON.stringify(afterOk));

  // 截图留证
  await page.screenshot({ path: 'verify-outbound.png' });
  console.log('\n错误数:', errors.length, errors.length ? errors.join(' | ') : '✓');

  await browser.close();
})();
