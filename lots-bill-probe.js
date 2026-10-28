// One-time READ-ONLY probe: logs into LOTS-GN and records which LOTS pages/API calls list orders + invoices.
// Never changes the cart and never places an order. Used to build the bill-check robot.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const seen = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (!/api\.lotswholesale\.com|apex/.test(u) || /\.(js|css|png|jpe?g|svg|webp|woff2?|ico)(\?|$)/i.test(u)) return;
    if (/cart|catalog|search|banner|category|menu|cms|config|translation/i.test(u) && !/order|invoice|bill/i.test(u)) return;
    let body = ''; try { body = (await res.text()).slice(0, 5000); } catch (e) {}
    seen.push(u); console.log(`\n### ${res.request().method()} ${res.status()} ${u}\n${body}`);
  });
  await page.goto('https://www.lotswholesale.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let t = 0; t < 8; t++) { const ok = await page.evaluate(() => [...document.querySelectorAll('.searchBoxInput')].some((el) => el.getBoundingClientRect().width > 0)).catch(() => false); if (ok) break; await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(1500); }
  await page.click('a.Header__AuthButton-is5do3-6', { timeout: 20000 });
  await page.waitForSelector('#inputPhoneLoginModal', { timeout: 15000 });
  const setVal = (sel, val) => page.evaluate(([s, v]) => { const i = s.split(',').map((x) => document.querySelector(x.trim())).find(Boolean); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, val]);
  await setVal('#inputPhoneLoginModal', process.env.LOTS_USERNAME); await sleep(400);
  await page.click('img[alt="Next"]', { timeout: 15000 });
  await page.waitForSelector('#inputPassword, input[type=password]', { timeout: 15000 });
  await setVal('#inputPassword, input[type=password]', process.env.LOTS_PASSWORD); await sleep(400);
  await page.click('#login-form button[type=submit]', { timeout: 15000 }).catch(() => {});
  await sleep(6000);
  console.log('\n=== LOGGED IN. Links mentioning order/invoice/bill/account:');
  const links = await page.evaluate(() => [...document.querySelectorAll('a')].map((a) => `${(a.innerText || '').trim().slice(0, 40)} -> ${a.href}`).filter((s) => /order|invoice|bill|account|profile|purchase/i.test(s)));
  console.log(links.join('\n'));
  await page.goto('https://www.lotswholesale.com/profile', { waitUntil: 'domcontentloaded', timeout: 45000 }); await sleep(5000);
  const clickText = async (re) => page.evaluate((src) => { const r = new RegExp(src, 'i'); const el = [...document.querySelectorAll('a,button,li,div,span')].filter((e) => r.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 40 && e.getBoundingClientRect().width > 0).pop(); if (el) { el.click(); return el.outerHTML.slice(0, 200); } return null; }, re.source);
  console.log('\n=== CLICK Order History:', await clickText(/^Order History$/)); await sleep(7000);
  console.log('URL:', page.url(), '\nTEXT:', (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 3000));
  const btns = await page.evaluate(() => [...document.querySelectorAll('a,button')].map((a) => `${(a.innerText || '').trim().slice(0, 40)} -> ${a.href || ''}`).filter((s) => /order|invoice|bill|download|detail|view|pdf/i.test(s)).slice(0, 40));
  console.log('BUTTONS:', btns.join(' || '));
  console.log('\n=== CLICK first details/view:', await clickText(/^(view|details|view details|order details|invoice|download invoice)$/)); await sleep(7000);
  console.log('URL:', page.url(), '\nTEXT:', (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 3000));
  console.log('BUTTONS2:', (await page.evaluate(() => [...document.querySelectorAll('a,button')].map((a) => `${(a.innerText || '').trim().slice(0, 40)} -> ${a.href || ''}`).filter((s) => /invoice|bill|download|pdf/i.test(s)).slice(0, 40))).join(' || '));
  await page.goto('https://www.lotswholesale.com/profile', { waitUntil: 'domcontentloaded', timeout: 45000 }); await sleep(5000);
  console.log('\n=== CLICK Tax Invoice Information:', await clickText(/^Tax Invoice Information$/)); await sleep(6000);
  console.log('TEXT:', (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 1500));
  console.log('\n=== API URLS SEEN:\n' + [...new Set(seen)].join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
