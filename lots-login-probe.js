// One-time check: what does the LOTS login look like now? (removed after use)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true }));
  const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto('https://www.lotswholesale.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  await page.screenshot({ path: 'probe-1.png' });
  const info = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a,button,[role=button],span,div,img').forEach((el) => {
      const t = (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || '').trim();
      if (/log ?in|sign ?in|account|login/i.test(t) && t.length < 40) {
        const r = el.getBoundingClientRect();
        out.push([el.tagName, el.className && String(el.className).slice(0, 120), el.id, t, Math.round(r.x), Math.round(r.y), Math.round(r.width), el.getAttribute('href')].join(' | '));
      }
    });
    return { title: document.title, url: location.href, auth: [...document.querySelectorAll('[class*="AuthButton"],[class*="Auth"],[class*="Login"],[class*="login"]')].map((e) => e.tagName + ' ' + String(e.className).slice(0, 120) + ' :: ' + (e.innerText || '').trim().slice(0, 40)).slice(0, 30), items: out.slice(0, 40), search: document.querySelectorAll('.searchBoxInput').length };
  });
  console.log(JSON.stringify(info, null, 1));
  // try clicking the first visible "Login" text and see if the phone box appears
  const cand = page.locator('text=/^\\s*(log ?in|sign ?in|login\\s*\\/\\s*sign ?up)/i').first();
  try { await cand.click({ timeout: 8000 }); await page.waitForTimeout(3000); } catch (e) { console.log('click failed', e.message.split('\n')[0]); }
  await page.screenshot({ path: 'probe-2.png' });
  console.log('phone box:', await page.locator('#inputPhoneLoginModal').count(), 'inputs:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => [i.id, i.name, i.type, i.placeholder].join('/')))));
  await b.close();
})();
