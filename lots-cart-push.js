/**
 * LOTS Smart Cart robot.
 *
 * The Admin Console's Order Mapper ("Send to LOTS Cart" button) puts the LOTS order
 * into Firestore (AIKM project, collection `lotsCartQueue`, status "pending").
 * This robot picks it up, logs into lotswholesale.com, and uploads it to LOTS Smart
 * Cart in parts of 99 products (LOTS' limit per file) — exactly what the website's
 * "Upload File" button does. It only fills the CART. It never places an order.
 * The result (added / failed items) is written back for the console to show.
 *
 * Usage:
 *   node lots-cart-push.js check   -> prints pending=true/false (used by the workflow
 *                                     to skip the browser install when nothing waits)
 *   node lots-cart-push.js         -> process all pending requests
 *
 * Needs the same GitHub secrets the price sync already uses:
 *   LOTS_USERNAME, LOTS_PASSWORD, AIKM_FIREBASE_SERVICE_ACCOUNT
 */

const admin = require('firebase-admin');
const fs = require('fs');
const XLSX = require('xlsx');

const API = process.env.LOTS_API || 'https://api.lotswholesale.com';
const MAX_PER_FILE = 99;
const QUEUE = 'lotsCartQueue';

function log(...a) { console.log(new Date().toISOString(), ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let db = null;
function initDb() {
  if (db) return db;
  const app = admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.AIKM_FIREBASE_SERVICE_ACCOUNT)),
  });
  return (db = app.firestore());
}

async function pendingDocs() {
  const snap = await db.collection(QUEUE).where('status', '==', 'pending').get();
  return snap.docs.sort((a, b) => (a.data().createdAtMs || 0) - (b.data().createdAtMs || 0));
}

// ---------- LOTS login (same flow as the daily price sync) ----------
async function loginAndGetToken() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto('https://www.lotswholesale.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    let tries = 0;
    while (tries < 8) {
      const ok = await page.evaluate(() => [...document.querySelectorAll('.searchBoxInput')].some((el) => el.getBoundingClientRect().width > 0)).catch(() => false);
      if (ok) break;
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1500);
      tries++;
    }
    await page.waitForSelector('a.Header__AuthButton-is5do3-6', { timeout: 20000 });
    await page.click('a.Header__AuthButton-is5do3-6', { timeout: 20000 });
    await page.waitForSelector('#inputPhoneLoginModal', { timeout: 15000 });
    const setVal = (sel, val) => page.evaluate(([s, v]) => {
      const input = s.split(',').map((x) => document.querySelector(x.trim())).find(Boolean);
      if (!input) throw new Error('input not found: ' + s);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, [sel, val]);
    await setVal('#inputPhoneLoginModal', process.env.LOTS_USERNAME);
    await sleep(400);
    await page.click('img[alt="Next"]', { timeout: 15000 });
    await page.waitForSelector('#inputPassword, input[type=password]', { timeout: 15000 });
    await setVal('#inputPassword, input[type=password]', process.env.LOTS_PASSWORD);
    await sleep(400);
    await page.click('#login-form button[type=submit]', { timeout: 15000 }).catch(() => {});
    await sleep(4000);

    const cookies = await context.cookies();
    const c = cookies.find((x) => x.name === 'accessToken');
    let token = c ? decodeURIComponent(c.value) : null;
    if (!token) {
      // fallback: look for a token in the site's saved session
      token = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const v = localStorage.getItem(localStorage.key(i)) || '';
          const m = v.match(/"accessToken"\s*:\s*"([^"]+)"/);
          if (m) return m[1];
        }
        return null;
      }).catch(() => null);
    }
    const cookieHeader = cookies.map((x) => `${x.name}=${x.value}`).join('; ');
    return { token, cookieHeader };
  } finally {
    await browser.close();
  }
}

async function login() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const s = await loginAndGetToken();
      if (s.token) return s;
      log(`Login attempt ${attempt}: no session token, retrying...`);
    } catch (e) {
      log(`Login attempt ${attempt} failed: ${e.message}`);
    }
    await sleep(3000);
  }
  throw new Error('Could not log into LOTS after 3 attempts (password changed, or LOTS changed its login page).');
}

// ---------- Smart Cart upload (same call as the website's "Upload File") ----------
function buildFile(items) {
  // Exactly LOTS' own template: "Item Code " (with the trailing space) + "Quantity"
  const rows = [['Item Code ', 'Quantity'], ...items.map((it) => {
    const code = String(it.code).trim();
    return [/^\d+$/.test(code) ? Number(code) : code, Number(it.qty) || 0];
  })];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

const norm = (c) => String(c == null ? '' : c).trim().replace(/^0+(?=\d)/, '');

// Finds every cart line in any LOTS response shape (cart.cartChilds[].cartItems[], cartChilds, items...)
function collectCart(obj) {
  const out = {};
  (function walk(o, inItems) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, inItems));
    if (inItems && o.productCode != null && (o.quantity != null || o.qty != null)) {
      out[norm(o.productCode)] = Number(o.quantity != null ? o.quantity : o.qty) || 0;
    }
    Object.keys(o).forEach((k) => { if (k !== 'failedItems') walk(o[k], inItems || /cartItems|items|products|cartChilds/i.test(k)); });
  })(obj, false);
  return Object.keys(out).map((code) => ({ code, qty: out[code] }));
}
function collectFailed(obj) {
  let list = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    Object.keys(o).forEach((k) => { if (/failed/i.test(k) && Array.isArray(o[k])) list = list.concat(o[k]); else walk(o[k]); });
  })(obj);
  return list.map((f) => ({ code: norm(f.productCode || f.code || f.itemCode), reason: f.reason || f.message || f.failureReason || '' }));
}

async function lotsFetch(session, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${session.token}`, Cookie: session.cookieHeader, Origin: 'https://www.lotswholesale.com', Referer: 'https://www.lotswholesale.com/smartcart', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { res, text, json };
}

async function uploadPart(session, items, fileName) {
  const fd = new FormData();
  fd.append('file', new Blob([buildFile(items)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);
  fd.append('locale', 'en_US');
  const { res, text, json } = await lotsFetch(session, '/next-ocs-member/user/cart/uploadExcel', { method: 'POST', body: fd });
  log(`Upload response (HTTP ${res.status}): ${text.slice(0, 1500)}`);
  if (!res.ok || !json) throw new Error(`LOTS rejected the upload (HTTP ${res.status}): ${text.slice(0, 200)}`);
  return { failed: collectFailed(json), cart: collectCart(json), raw: text.slice(0, 1500) };
}

// Reads the real LOTS cart (same call the LOTS cart page uses)
async function readCart(session) {
  const { res, text, json } = await lotsFetch(session, '/next-ocs-member/user/cart/v2?locale=en_US');
  log(`Cart read (HTTP ${res.status}): ${text.slice(0, 600)}`);
  if (!res.ok || !json) return null;
  return collectCart(json);
}

async function processDoc(doc) {
  const ref = doc.ref;
  // claim it (so two runs never upload the same order twice)
  const claimed = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists || fresh.data().status !== 'pending') return false;
    tx.update(ref, { status: 'processing', startedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
  if (!claimed) return;

  const req = doc.data();
  const items = (req.items || []).filter((it) => it && it.code && Number(it.qty) > 0);
  const nameOf = {};
  items.forEach((it) => { nameOf[String(it.code).trim()] = it.name || ''; nameOf[norm(it.code)] = it.name || ''; });
  log(`Request ${doc.id}: ${items.length} products`);

  try {
    if (!items.length) throw new Error('No products with a LOTS item code and quantity.');
    const session = await login();
    log('Logged into LOTS.');
    const parts = [];
    for (let i = 0; i < items.length; i += MAX_PER_FILE) parts.push(items.slice(i, i + MAX_PER_FILE));

    const results = [];
    let lastCart = [];
    let firstRaw = '';
    for (let p = 0; p < parts.length; p++) {
      const label = `Part ${p + 1} of ${parts.length}`;
      await ref.update({ progress: `Uploading ${label}…` });
      const r = await uploadPart(session, parts[p], `smart_cart_part${p + 1}.xlsx`);
      lastCart = r.cart;
      if (p === 0) firstRaw = r.raw;
      results.push({ part: p + 1, sent: parts[p].length, failed: r.failed.length });
      r.failed.forEach((f) => { f.name = nameOf[f.code] || nameOf[norm(f.code)] || ''; f.part = p + 1; });
      results[p].failedItems = r.failed;
      log(`${label}: sent ${parts[p].length}, failed ${r.failed.length}, cart now ${r.cart.length} products`);
      if (p < parts.length - 1) await sleep(3000);
    }

    await sleep(3000);
    const realCart = await readCart(session).catch(() => null);
    if (realCart && realCart.length >= lastCart.length) lastCart = realCart;
    const failedItems = results.flatMap((r) => r.failedItems);
    const failedCodes = new Set(failedItems.map((f) => norm(f.code)));
    const inCart = new Set(lastCart.map((c) => norm(c.code)));
    // safety check: every product that didn't fail should now be in the cart
    const missing = items
      .filter((it) => !failedCodes.has(norm(it.code)) && !inCart.has(norm(it.code)))
      .map((it) => ({ code: String(it.code).trim(), name: it.name || '', reason: 'Not in LOTS cart after upload (check stock / store availability)' }));

    await ref.update({
      status: 'done',
      progress: null,
      parts: results.map(({ failedItems: _, ...r }) => r),
      sentCount: items.length,
      addedCount: items.length - failedItems.length - missing.length,
      failedItems: failedItems.concat(missing),
      cartProductCount: lastCart.length,
      lotsResponse: firstRaw,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    log(`Done: ${items.length - failedItems.length - missing.length} added, ${failedItems.length + missing.length} need attention, cart has ${lastCart.length} products.`);
  } catch (e) {
    log('FAILED:', e.message);
    await ref.update({ status: 'failed', progress: null, error: e.message || String(e), finishedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
}

module.exports = { buildFile, uploadPart, collectCart, collectFailed };
if (require.main === module) (async () => {
  initDb();
  const docs = await pendingDocs();
  if (process.argv[2] === 'check') {
    const line = `pending=${docs.length > 0}`;
    console.log(line, `(${docs.length} waiting)`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line + '\n');
    process.exit(0);
  }
  if (!docs.length) { log('Nothing waiting.'); process.exit(0); }
  for (const d of docs) await processDoc(d);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
