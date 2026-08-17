/**
 * Daily LOTS Wholesale price sync -> Firebase (Sasta Store Counter Billing).
 *
 * What it does, every time it runs:
 *  1. Logs into lotswholesale.com (Playwright, headless).
 *  2. Walks the full category tree and pulls every product's slab pricing.
 *  3. Keeps only products that are already in your billing app's catalog
 *     (catalog-codes.json — the same list your app already knows about).
 *  4. Computes:
 *       - tier prices  = exactly what LOTS shows (no markup)
 *       - sale price   = last available tier price x 1.08 (your 8% margin)
 *     This matches the "Sync LOTS Prices" button in the app exactly.
 *  5. Writes the results straight into Firestore, at the same path your
 *     app's Cloud Sync already reads from: shops/{SHOP_ID}/kv/{key}
 *     keys written: price-overrides, slab-overrides, lots-raw-cost
 *
 * Required environment variables (set as GitHub Actions secrets — see
 * SETUP.md):
 *   LOTS_USERNAME              e.g. 7409111555
 *   LOTS_PASSWORD              e.g. Sasta@1008
 *   FIREBASE_SERVICE_ACCOUNT   full JSON of a Firebase service account key (single line)
 *   FIREBASE_PROJECT_ID        e.g. sasta-store-xxxxx
 *   SHOP_ID                    the Shop ID shown in the app's Cloud Sync panel
 *   MARGIN                     optional, defaults to 1.08 (8%)
 */

const { chromium } = require('playwright');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const MARGIN = parseFloat(process.env.MARGIN || '1.08');
const LOTS_USERNAME = process.env.LOTS_USERNAME;
const LOTS_PASSWORD = process.env.LOTS_PASSWORD;
const SHOP_ID = process.env.SHOP_ID;

function log(...args){ console.log(new Date().toISOString(), ...args); }

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ---------- Step 1: log in and capture an authenticated API context ----------
async function loginAndGetSession(){
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  log('Opening lotswholesale.com...');
  await page.goto('https://www.lotswholesale.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  async function pageHealthy(){
    try{
      return await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.searchBoxInput'));
        return els.some(el => el.getBoundingClientRect().width > 0);
      });
    }catch(e){ return false; }
  }
  let tries = 0;
  while(!(await pageHealthy()) && tries < 8){
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
    await sleep(1500);
    tries++;
  }

  // Open login modal
  await page.click('a.Header__AuthButton-is5do3-6', { timeout: 8000 });
  await page.waitForSelector('#inputPhoneLoginModal', { timeout: 10000 });

  // Fill mobile number via React-safe setter + dispatch events
  await page.evaluate((mobile) => {
    const input = document.querySelector('#inputPhoneLoginModal');
    if(!input) throw new Error('mobile input not found');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, mobile);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, LOTS_USERNAME);
  await sleep(400);
  // The "continue" control is a plain <img alt="Next"> — a stable selector,
  // not screen coordinates (which shift between environments/viewports).
  await page.click('img[alt="Next"]', { timeout: 8000 });
  // Wait for the password field to actually render rather than a fixed delay —
  // this step is the one most sensitive to slow network/render timing.
  await page.waitForSelector('#inputPassword, input[type=password]', { timeout: 15000 });

  await page.evaluate((pwd) => {
    const input = document.querySelector('#inputPassword') || document.querySelector('input[type=password]');
    if(!input) throw new Error('password input not found');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, pwd);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, LOTS_PASSWORD);
  await sleep(400);
  // The password step submits via a real <button type="submit"> inside the login form.
  await page.click('#login-form button[type=submit]', { timeout: 8000 }).catch(()=>{});
  await sleep(3000);

  // Pull tokens from localStorage (same session shape used by the site itself)
  const authState = await page.evaluate(() => {
    const out = {};
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return out;
  }).catch(() => ({}));
  const cookies = await context.cookies();

  // Also grab the homepage's category tree (window.__NEXT_DATA__) — reload the
  // homepage fresh so we're reading it post-login, from a settled page.
  await page.goto('https://www.lotswholesale.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  await sleep(1500);
  const nextData = await page.evaluate(() => window.__NEXT_DATA__ || null);

  await browser.close();
  return { authState, cookies, nextData };
}


function walkCategories(node, out){
  if(!node) return out;
  const menus = node.childMenus || node.children || [];
  if((!menus || !menus.length) && node.id != null){
    out.push({ id: node.id, name: node.name || node.menuName || '' });
    return out;
  }
  menus.forEach(child => walkCategories(child, out));
  return out;
}

// ---------- Step 2: pull every product's slab pricing ----------
// Confirmed by testing directly against the API: only the session cookies are
// needed here. Sending an Authorization header actually causes a 401 — the
// site's own frontend doesn't send one for this endpoint either.
async function fetchCategoryProducts(cookieHeader, menuId){
  const body = {
    menuId,
    locale: 'en_US',
    assortPriceStoreCode: '106',
    assortOrderStoreCode: '106',
    nonAssortPriceStoreCode: '106',
    nonAssortOrderStoreCode: '106',
    pincode: '201310',
    makroNo: '5687000000337166',
    reloadPrice: true,
    loadHierarchy: true,
    countryOfOrigin: null,
    page: 1,
    pageSize: 100,
    sorting: 'SORTING_MENU_INDEX',
  };
  const all = [];
  let page = 1;
  let totalPages = 1;
  while(page <= totalPages){
    body.page = page;
    let res, data, attempt = 0;
    while(attempt < 4){
      try{
        res = await fetch('https://api.lotswholesale.com/next-product/public/api/product/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': cookieHeader,
          },
          body: JSON.stringify(body),
        });
        data = await res.json();
        break;
      }catch(e){
        attempt++;
        await sleep(1000 + attempt * 500);
      }
    }
    if(!data || !data.content) break;
    all.push(...data.content);
    totalPages = data.totalPages || 1;
    page++;
  }
  return all;
}

// ---------- Step 3 & 4: keep only known products, compute margin pricing ----------
function buildSlabsFromPricingRecords(records){
  if(!records || !records.length) return [];
  return records.map(r => {
    const label = (r.toQuantity == null || r.toQuantity >= 9999)
      ? `${r.fromQuantity}+`
      : `${r.fromQuantity}-${r.toQuantity}`;
    return [label, Math.round(r.sellingPrice * 100) / 100];
  });
}

async function main(){
  if(!LOTS_USERNAME || !LOTS_PASSWORD || !SHOP_ID){
    console.error('Missing required env vars: LOTS_USERNAME, LOTS_PASSWORD, SHOP_ID');
    process.exit(1);
  }
  if(!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.FIREBASE_PROJECT_ID){
    console.error('Missing required env vars: FIREBASE_SERVICE_ACCOUNT, FIREBASE_PROJECT_ID');
    process.exit(1);
  }

  const catalogCodes = new Set(
    JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-codes.json'), 'utf8'))
  );
  log(`Loaded ${catalogCodes.size} known product codes from your billing app.`);

  log('Logging into LOTS Wholesale...');
  let cookies, nextData;
  for(let attempt = 1; attempt <= 3; attempt++){
    try{
      ({ cookies, nextData } = await loginAndGetSession());
      if(cookies.some(c => c.name === 'accessToken')) break;
      log(`  login attempt ${attempt} did not produce a session, retrying...`);
    }catch(e){
      log(`  login attempt ${attempt} failed: ${e.message}, retrying...`);
    }
    await sleep(3000);
  }
  if(!cookies || !cookies.some(c => c.name === 'accessToken')){
    console.error('Could not log into LOTS after 3 attempts — the site may have changed its login flow, or the credentials were rejected.');
    process.exit(1);
  }
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  let categories = [];
  try{
    const topMenu = nextData.props.pageProps.valueFromServer.topMenu;
    categories = walkCategories(topMenu, []);
  }catch(e){
    console.error('Could not read category tree from homepage — LOTS may have changed their site layout.');
    process.exit(1);
  }
  log(`Found ${categories.length} leaf categories to scan.`);

  const priceOverrides = {};
  const slabOverrides = {};
  const lotsRawCost = {};
  let matchedCount = 0;

  for(let i = 0; i < categories.length; i++){
    const cat = categories[i];
    let products = [];
    try{
      products = await fetchCategoryProducts(cookieHeader, cat.id);
    }catch(e){
      log(`  category ${cat.name} (${cat.id}) failed, skipping:`, e.message);
      continue;
    }
    for(const p of products){
      const code = String(p.productCode || '').trim();
      if(!code || !catalogCodes.has(code)) continue; // only sync products already in the billing app
      const slabs = buildSlabsFromPricingRecords(p.pricingRecords);
      if(!slabs.length) continue;
      const rawCost = slabs[slabs.length - 1][1];
      const salePrice = Math.round(rawCost * MARGIN * 100) / 100;
      slabOverrides[code] = slabs;               // exactly as LOTS lists them
      priceOverrides[code] = salePrice;           // last tier + margin
      lotsRawCost[code] = rawCost;
      matchedCount++;
    }
    if(i % 20 === 0) log(`  scanned ${i}/${categories.length} categories, matched ${matchedCount} products so far...`);
  }

  log(`Done scanning. Matched ${matchedCount} products with pricing.`);
  if(matchedCount === 0){
    console.error('No products matched — aborting without writing to Firebase (safety check).');
    process.exit(1);
  }

  // ---------- Step 5: write to Firestore ----------
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  const db = admin.firestore();
  const kvRef = db.collection('shops').doc(SHOP_ID).collection('kv');

  await kvRef.doc('price-overrides').set({ v: JSON.stringify(priceOverrides) });
  await kvRef.doc('slab-overrides').set({ v: JSON.stringify(slabOverrides) });
  await kvRef.doc('lots-raw-cost').set({ v: JSON.stringify(lotsRawCost) });

  log(`Wrote price-overrides, slab-overrides, lots-raw-cost for ${matchedCount} products to shops/${SHOP_ID}/kv.`);
  log('Every open device with Cloud Sync on will pick this up automatically.');
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
