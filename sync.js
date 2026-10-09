/**
 * Daily LOTS Wholesale price sync -> Firebase.
 * Feeds TWO tools from one login/scrape:
 *
 *  1) Sasta Store Counter Billing (Firestore: shops/{SHOP_ID}/kv/*)
 *     - Only products already in your billing app's catalog (catalog-codes.json)
 *     - tier prices  = exactly what LOTS shows (no markup)
 *     - sale price   = last available tier price x 1.08 (your 8% margin)
 *     This matches the "Sync LOTS Prices" button in the app exactly.
 *
 *  2) AIKM Order Mapper / Admin Console (Firestore: aikm_admin/lotsCatalog)
 *     - ALL LOTS products (not just ones in the billing app)
 *     - raw LOTS cost, no markup — this tool uses it for order matching, not sale pricing
 *     - Only runs if AIKM_FIREBASE_SERVICE_ACCOUNT is set; skipped otherwise.
 *
 * Required environment variables (set as GitHub Actions secrets — see
 * SETUP.md):
 *   LOTS_USERNAME              e.g. 919999999999
 *   LOTS_PASSWORD              e.g. YourPassword123
 *   FIREBASE_SERVICE_ACCOUNT   full JSON of a Firebase service account key for Sasta Store POS (single line)
 *   FIREBASE_PROJECT_ID        e.g. sasta-store-xxxxx
 *   SHOP_ID                    the Shop ID shown in the app's Cloud Sync panel
 *   MARGIN                     optional, defaults to 1.08 (8%)
 *   AIKM_FIREBASE_SERVICE_ACCOUNT   optional — full JSON of a service account key
 *                                    for the AIKM- ORDER FILE project. If not set,
 *                                    the Order Mapper sync step is skipped entirely.
 *   GREENAPI_INSTANCE_ID        optional — from green-api.com, see SETUP.md
 *   GREENAPI_API_TOKEN          optional — from green-api.com, see SETUP.md
 *   GREENAPI_CHAT_ID            optional — your number as 919999999999@c.us
 *                                    If any of these three is missing, WhatsApp
 *                                    notification is skipped.
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

  // Open login modal — GitHub's runners can be slower than local testing, so this
  // waits generously for the link to actually be there before clicking, rather
  // than assuming the site changed just because one attempt was slow.
  await page.waitForSelector('a.Header__AuthButton-is5do3-6', { timeout: 20000 });
  await page.click('a.Header__AuthButton-is5do3-6', { timeout: 20000 });
  await page.waitForSelector('#inputPhoneLoginModal', { timeout: 15000 });

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
  await page.click('img[alt="Next"]', { timeout: 15000 });
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
  await page.click('#login-form button[type=submit]', { timeout: 15000 }).catch(()=>{});
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


function walkCategories(node, out, path){
  if(!node) return out;
  const isRoot = !path;
  path = path || [];
  const menus = node.childMenus || node.children || [];
  const nm = node.name || node.menuName || '';
  if((!menus || !menus.length) && node.id != null){
    // dept = top-level department, name = leaf category (both used by the picking list PDF)
    out.push({ id: node.id, name: nm, dept: path[0] || nm });
    return out;
  }
  // the very top node is the menu root itself, not a department
  const next = isRoot ? [] : (nm ? path.concat(nm) : path);
  menus.forEach(child => walkCategories(child, out, next));
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
        if(!data || !Array.isArray(data.content)) throw new Error('no content (HTTP ' + res.status + ')');
        break;
      }catch(e){
        data = null;
        attempt++;
        await sleep(1000 + attempt * 1500);
      }
    }
    if(!data || !data.content){ all.incomplete = true; break; }
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

  // Barcode / GST % / HSN come from LOTS's own "Item Extract" file (not the website),
  // converted into lots-item-master.json — keyed by the same SKU / product code.
  // To refresh: send Claude a new Item Extract file and it regenerates this JSON.
  let itemMaster = {};
  try{
    itemMaster = JSON.parse(fs.readFileSync(path.join(__dirname, 'lots-item-master.json'), 'utf8'));
    log(`Loaded ${Object.keys(itemMaster).length} barcode/GST/HSN records from lots-item-master.json.`);
  }catch(e){
    log('lots-item-master.json not found — barcode/GST/HSN will be skipped.');
  }
  let masterHits = 0;

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
    categories = Array.isArray(topMenu) ? topMenu.reduce((o, n) => walkCategories(n, o, []), []) : walkCategories(topMenu, []);
  }catch(e){
    console.error('Could not read category tree from homepage — LOTS may have changed their site layout.');
    process.exit(1);
  }
  log(`Found ${categories.length} leaf categories to scan.`);

  const priceOverrides = {};
  const slabOverrides = {};
  const lotsRawCost = {};
  const listedCodes = new Set();   // every code LOTS listed this run, even ones with no price right now
  let incompleteCats = 0;
  const aikmProducts = []; // full raw catalog for the Order Mapper tool — ALL LOTS products, not just ones in the billing app
  let matchedCount = 0;

  for(let i = 0; i < categories.length; i++){
    const cat = categories[i];
    let products = [];
    try{
      products = await fetchCategoryProducts(cookieHeader, cat.id);
      if(products.incomplete){ incompleteCats++; log(`  category ${cat.name} (${cat.id}) only partly loaded - LOTS did not answer every page.`); }
    }catch(e){
      incompleteCats++;
      log(`  category ${cat.name} (${cat.id}) failed, skipping:`, e.message);
      continue;
    }
    for(const p of products){
      const code = String(p.productCode || '').trim();
      if(!code) continue;
      listedCodes.add(code);
      const slabs = buildSlabsFromPricingRecords(p.pricingRecords);
      if(!slabs.length) continue;
      const rawCost = slabs[slabs.length - 1][1];

      // Order Mapper (AIKM Admin Console) wants ALL products, raw LOTS cost,
      // in its own {min,max,price} slab shape — not the billing app's format.
      const aikmSlabs = slabs.map(([label, price]) => {
        const m = label.match(/^(\d+)\+$/) || label.match(/^(\d+)-(\d+)$/) || label.match(/^(\d+)$/);
        let min, max;
        if(label.endsWith('+')){ min = parseInt(m[1],10); max = Infinity; }
        else if(m && m[2] !== undefined){ min = parseInt(m[1],10); max = parseInt(m[2],10); }
        else { min = parseInt(m[1],10); max = min; }
        return { min, max, price };
      });
      const aikmProduct = { code, name: p.productName || '' };
      // LOTS category (leaf) + department, for the picking list PDF
      if(cat.name) aikmProduct.cat = cat.name;
      if(cat.dept && cat.dept !== cat.name) aikmProduct.dept = cat.dept;
      // Now that the catalog is split into small chunks (see Step 6 below), the
      // per-document size ceiling that forced dropping these earlier no longer
      // applies — restored, since they genuinely help: brand strengthens the
      // matching engine's confidence scoring, and MRP feeds the "· MRP ₹X" hint
      // shown next to matches in the app.
      if(p.brand) aikmProduct.brand = p.brand;
      const mrp = p.pricingRecords && p.pricingRecords[0] ? p.pricingRecords[0].mrp : null;
      if(mrp != null) aikmProduct.mrp = mrp;
      if(aikmSlabs.length) aikmProduct.slabs = aikmSlabs;
      // Product image (LOTS sends either "image" or an "images" list)
      {
        let img = p.image || (Array.isArray(p.images) && p.images.length ? p.images[0] : null);
        if(img && typeof img === 'object') img = img.url || img.imageUrl || img.src || img.path || null;
        if(img && typeof img === 'string'){
          if(img.startsWith('//')) img = 'https:' + img;
          aikmProduct.img = img;
        }
      }
      // Available stock at LOTS (store 106) at the time of this sync
      if(p.stockAvailableToSell != null) aikmProduct.qty = Number(p.stockAvailableToSell);
      const im = itemMaster[code];
      if(im){
        if(im.b) aikmProduct.barcode = im.b;
        if(im.g != null) aikmProduct.gst = im.g;
        if(im.h) aikmProduct.hsn = im.h;
        if(!aikmProduct.brand && im.br) aikmProduct.brand = im.br;
        masterHits++;
      }
      aikmProducts.push(aikmProduct);

      // Billing app only wants products it already knows about, marked up.
      if(catalogCodes.has(code)){
        const salePrice = Math.round(rawCost * MARGIN * 100) / 100;
        slabOverrides[code] = slabs;               // exactly as LOTS lists them
        priceOverrides[code] = salePrice;           // last tier + margin
        lotsRawCost[code] = rawCost;
        matchedCount++;
      }
    }
    if(i % 20 === 0) log(`  scanned ${i}/${categories.length} categories, matched ${matchedCount} billing-app products, ${aikmProducts.length} total so far...`);
  }

  log(`Images captured for ${aikmProducts.filter(x => x.img).length} products.`);
  log(`Stock qty captured for ${aikmProducts.filter(x => x.qty != null).length} products.`);
  log(`Done scanning. Matched ${matchedCount} billing-app products; ${aikmProducts.length} total products for Order Mapper.`);
  log(`Barcode/GST/HSN attached to ${masterHits} of ${aikmProducts.length} LOTS products.`);
  if(matchedCount === 0){
    console.error('No products matched — aborting without writing to Firebase (safety check).');
    process.exit(1);
  }

  // ---------- Step 5: write to Firestore (Sasta Store Counter Billing) ----------
  // The service account JSON already embeds its own project_id — passing a
  // second, separate FIREBASE_PROJECT_ID here caused a mismatch (even a
  // stray space from copy-pasting breaks it) and Firestore silently targeted
  // a project that doesn't exist, surfacing as a confusing NOT_FOUND. The
  // credential alone is authoritative and sufficient.
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const billingApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  }, 'billing');
  log(`Writing to Firestore project: ${serviceAccount.project_id}`);
  const db = billingApp.firestore();
  const kvRef = db.collection('shops').doc(SHOP_ID).collection('kv');

  await kvRef.doc('price-overrides').set({ v: JSON.stringify(priceOverrides) });
  await kvRef.doc('slab-overrides').set({ v: JSON.stringify(slabOverrides) });
  await kvRef.doc('lots-raw-cost').set({ v: JSON.stringify(lotsRawCost) });

  log(`Wrote price-overrides, slab-overrides, lots-raw-cost for ${matchedCount} products to shops/${SHOP_ID}/kv.`);
  log('Every open device with Cloud Sync on will pick this up automatically.');

  // ---------- Step 6: write to Firestore (AIKM Order Mapper) ----------
  // Split across multiple small documents in a "chunks" subcollection instead of one
  // big document — this is the exact same pattern this app already uses successfully
  // for OMS orders (aikm_admin/omsOrders + its chunks subcollection). It permanently
  // removes Firestore's ~1MB single-document cap as a concern, no matter how large
  // LOTS's catalog grows in the future — no more guessing at a byte threshold.
  let aikmCount = 0;
  let aikmSkipped = true;
  if(process.env.AIKM_FIREBASE_SERVICE_ACCOUNT){
    aikmSkipped = false;
    const aikmServiceAccount = JSON.parse(process.env.AIKM_FIREBASE_SERVICE_ACCOUNT);
    const aikmApp = admin.initializeApp({
      credential: admin.credential.cert(aikmServiceAccount),
    }, 'aikm');
    log(`Writing to Firestore project: ${aikmServiceAccount.project_id}`);
    const aikmDb = aikmApp.firestore();
    const savedAt = new Date().toISOString();

    // Match the site's own chunking exactly — its manual-upload fallback path
    // (pushLotsCatalogToCloud in the theme JS) already writes chunks the same way,
    // under the same collection, with the same "chunk_N" ID scheme and the same
    // metadata field names. Staying identical means either write path — this daily
    // automation, or someone manually uploading a file as a one-off fallback —
    // produces data the site reads exactly the same way.
    // ---- Price-change tracking ----
    // Compare each product's best (lowest) slab price with the previous sync's
    // data already in Firestore. A change is stamped with prevPrice + priceChangedAt;
    // unchanged products carry their last change forward so history isn't lost.
    try{
      const prevSnap = await aikmDb.collection('aikm_admin').doc('lotsCatalog').collection('chunks').get();
      const prevByCode = {};
      prevSnap.forEach(d => (d.data().products || []).forEach(p => { prevByCode[p.code] = p; }));
      const bestOf = x => (x && x.slabs && x.slabs.length) ? Math.min(...x.slabs.map(s => Number(s.price))) : null;
      let up = 0, down = 0;
      for(const p of aikmProducts){
        const old = prevByCode[p.code];
        if(!old) continue;
        const now = bestOf(p), before = bestOf(old);
        if(now != null && before != null && Math.abs(now - before) >= 0.01){
          p.prevPrice = before;
          p.priceChangedAt = savedAt;
          now > before ? up++ : down++;
        }else if(old.priceChangedAt){
          p.prevPrice = old.prevPrice;
          p.priceChangedAt = old.priceChangedAt;
        }
      }
      log(`Price changes vs last sync: ${up} up, ${down} down.`);

      // ---- Stock alerts ----
      // went out of stock / back in stock / stock moved by 50+ units since the last sync.
      // The latest alert is carried forward so the page can show it for 24 hours.
      let sOos = 0, sBack = 0, sBig = 0;
      for(const p of aikmProducts){
        const old = prevByCode[p.code];
        if(!old) continue;
        const was = old.qty == null ? null : Number(old.qty), now = p.qty == null ? null : Number(p.qty);
        let ev = null;
        if(was != null && now != null){
          if(was > 0 && now <= 0){ ev = 'oos'; sOos++; }
          else if(was <= 0 && now > 0){ ev = 'back'; sBack++; }
          else if(Math.abs(now - was) >= 50){ ev = now > was ? 'up' : 'down'; sBig++; }
        }
        if(ev) p.stockEvent = { type: ev, from: was, to: now, at: savedAt };
        else if(old.stockEvent) p.stockEvent = old.stockEvent;
      }
      log(`Stock alerts vs last sync: ${sOos} went out of stock, ${sBack} back in stock, ${sBig} changed by 50+.`);

      // ---- New / removed products ----
      // "Seen" registry = every product code LOTS has ever listed (with first-seen date).
      // New     = not in the registry before this sync.
      // Removed = in the previous sync but missing now (kept for 7 days in lotsRemoved).
      const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
      const seenRef = aikmDb.collection('aikm_admin').doc('lotsSeen');
      const removedRef = aikmDb.collection('aikm_admin').doc('lotsRemoved');
      const seenSnap = await seenRef.get();
      let seen = seenSnap.exists ? (seenSnap.data().c || {}) : null;
      if(!seen){
        // first run: treat everything already in the catalog as known, so nothing is falsely "new"
        seen = {};
        Object.keys(prevByCode).forEach(c => { seen[c] = savedAt; });
        log(`Seen-registry created from previous catalog (${Object.keys(seen).length} codes).`);
      }
      const nowCodes = new Set(aikmProducts.map(x => x.code));
      let added = 0;
      for(const p of aikmProducts){
        const old = prevByCode[p.code];
        if(!seen[p.code]){
          seen[p.code] = savedAt;
          p.addedAt = savedAt;
          added++;
        }else if(old && old.addedAt){
          p.addedAt = old.addedAt;   // keep the "new" stamp for its 7-day window
        }
      }
      const removedSnap = await removedRef.get();
      let removed = removedSnap.exists ? (removedSnap.data().items || []) : [];
      let pending = removedSnap.exists ? (removedSnap.data().pending || {}) : {};
      const listedNow = c => nowCodes.has(c) || listedCodes.has(c);
      const gone = Object.keys(prevByCode).filter(c => !listedNow(c));
      const prevCount = Object.keys(prevByCode).length;
      let confirmed = [];
      if(incompleteCats > 0){
        log(`Removal check skipped: ${incompleteCats} categor${incompleteCats === 1 ? 'y' : 'ies'} did not load fully, so missing products can't be trusted.`);
      }else if(prevCount && gone.length > prevCount * 0.10){
        log(`WARNING: ${gone.length} products missing vs last sync (over 10%) - not marking them as removed.`);
      }else{
        // Two-strike rule: a product must be missing on two syncs at least 12 hours apart before it counts as removed.
        const TWELVE_H = 12 * 60 * 60 * 1000;
        gone.forEach(c => { if(!pending[c]) pending[c] = { since: savedAt, item: prevByCode[c] }; });
        Object.keys(pending).forEach(c => {
          if(listedNow(c)){ delete pending[c]; return; }
          if(Date.now() - new Date(pending[c].since).getTime() >= TWELVE_H){
            const o = Object.assign({}, pending[c].item);
            delete o.prevPrice; delete o.priceChangedAt; delete o.addedAt;
            o.removedAt = savedAt;
            removed.push(o); confirmed.push(o);
            delete pending[c];
          }
        });
      }
      // anything LOTS lists again is no longer "removed"
      Object.keys(pending).forEach(c => { if(listedNow(c)) delete pending[c]; });
      const cutoff = Date.now() - KEEP_MS;
      removed = removed.filter(r => !listedNow(r.code) && new Date(r.removedAt).getTime() >= cutoff).slice(-500);
      // keep pending small: drop entries whose product is still around in the removed list or older than 7 days
      Object.keys(pending).forEach(c => { if(Date.now() - new Date(pending[c].since).getTime() > KEEP_MS) delete pending[c]; });
      await seenRef.set({ c: seen, updatedAt: savedAt });
      await removedRef.set({ items: removed, pending, updatedAt: savedAt });
      if(gone.length) log('Missing this sync (waiting for 2nd check): ' + gone.map(c => c + ' ' + (prevByCode[c].name || '')).slice(0, 20).join(' | '));
      if(confirmed.length) log('Confirmed removed: ' + confirmed.map(o => o.code + ' ' + (o.name || '')).slice(0, 20).join(' | '));
      log(`New products this sync: ${added}. Missing this sync: ${gone.length}. Confirmed removed: ${confirmed.length}. Removed list (7 days): ${removed.length}. Waiting for 2nd check: ${Object.keys(pending).length}.`);
    }catch(e){
      log('Price/new/removed check skipped: ' + e.message);
    }

    const CHUNK_SIZE = 400;
    const chunks = [];
    for(let i = 0; i < aikmProducts.length; i += CHUNK_SIZE){
      chunks.push(aikmProducts.slice(i, i + CHUNK_SIZE));
    }

    const chunksRef = aikmDb.collection('aikm_admin').doc('lotsCatalog').collection('chunks');

    // Remove any leftover chunks from a previous run that had more chunks than this
    // one (e.g. catalog shrank) — otherwise stale product data would linger forever.
    const existing = await chunksRef.listDocuments();
    const keepIds = new Set(chunks.map((_, i) => `chunk_${i}`));
    await Promise.all(existing.filter(d => !keepIds.has(d.id)).map(d => d.delete()));

    // Firestore batches cap at 500 writes — chunk counts here are small (under 20 at
    // current catalog size) so one batch is always enough, but this stays correct
    // even if the catalog grows to hundreds of chunks.
    for(let i = 0; i < chunks.length; i += 500){
      const batch = aikmDb.batch();
      chunks.slice(i, i + 500).forEach((productsSlice, offset) => {
        const idx = i + offset;
        batch.set(chunksRef.doc(`chunk_${idx}`), { products: productsSlice });
      });
      await batch.commit();
    }

    // Parent doc holds only metadata — matches the field names the site's own
    // upload path already writes (fileLabel, savedAt, productCount, chunkCount).
    await aikmDb.collection('aikm_admin').doc('lotsCatalog').set({
      fileLabel: 'Daily auto-sync',
      savedAt,
      productCount: aikmProducts.length,
      chunkCount: chunks.length,
    });

    log(`Wrote ${aikmProducts.length} products across ${chunks.length} chunk(s) to aikm_admin/lotsCatalog.`);
    aikmCount = aikmProducts.length;
  } else {
    log('AIKM_FIREBASE_SERVICE_ACCOUNT not set — skipping Order Mapper sync.');
  }

  return { matchedCount, aikmCount, aikmSkipped };
}

// ---------- Notifications ----------
// Uses Green-API (green-api.com) — a hosted WhatsApp API with a genuinely
// usable free "Developer" tier. Unlike CallMeBot's shared bot number, this
// links YOUR OWN WhatsApp (via a one-time QR scan) as the sender, so it's
// not sharing a number with thousands of other users. Setup is in SETUP.md.
// Skipped entirely if the required env vars aren't set.
async function sendWhatsApp(message){
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const apiToken = process.env.GREENAPI_API_TOKEN;
  const chatId = process.env.GREENAPI_CHAT_ID; // e.g. 919999999999@c.us
  if(!instanceId || !apiToken || !chatId){
    log('WhatsApp notification skipped (GREENAPI_INSTANCE_ID/GREENAPI_API_TOKEN/GREENAPI_CHAT_ID not set).');
    return;
  }
  try{
    const url = `https://api.green-api.com/waInstance${instanceId}/sendMessage/${apiToken}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message }),
    });
    log(`WhatsApp notification sent (status ${res.status}).`);
  }catch(e){
    log(`WhatsApp notification failed to send: ${e.message}`);
  }
}

main()
  .then(async (summary) => {
    await sendWhatsApp(
      `✅ LOTS price sync completed.\n` +
      `Billing app: ${summary.matchedCount} products updated.\n` +
      `Order Mapper: ${summary.aikmSkipped ? 'skipped' : summary.aikmCount + ' products updated'}.`
    );
    // Firestore keeps background gRPC connections open, which stops Node from
    // exiting on its own — without this, the process just hangs after all
    // the real work is done, until GitHub's job timeout force-kills it.
    log('Done. Exiting.');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Sync failed:', err);
    await sendWhatsApp(`❌ LOTS price sync FAILED: ${err.message}`);
    process.exit(1);
  });
