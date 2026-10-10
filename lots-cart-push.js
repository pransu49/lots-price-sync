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

// ---------- Full cart lines for the picking-list PDF (qty, price, coupon/offer, image) ----------
const toNum = (v) => (v === '' || v == null || typeof v === 'boolean' || isNaN(Number(v)) ? null : Number(v));
// every simple value inside an object, keyed by its path ("pricing.0.salePrice")
function flatten(o, pre = '', out = {}, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return out;
  Object.keys(o).forEach((k) => {
    const v = o[k], p = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object') flatten(v, p, out, depth + 1);
    else if (v !== null && v !== undefined && v !== '') out[p] = v;
  });
  return out;
}
const leaf = (p) => p.split('.').filter((x) => !/^\d+$/.test(x)).pop() || '';
function pickNum(f, tests) {
  for (const re of tests) {
    const k = Object.keys(f).find((p) => re.test(leaf(p)) && toNum(f[p]) != null && toNum(f[p]) > 0);
    if (k) return toNum(f[k]);
  }
  return null;
}
function cartLinesRaw(obj) {
  const out = {};
  (function walk(o, inItems) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, inItems));
    if (inItems && o.productCode != null && (o.quantity != null || o.qty != null)) { out[norm(o.productCode)] = o; return; }
    Object.keys(o).forEach((k) => { if (k !== 'failedItems') walk(o[k], inItems || /cartItems|items|products|cartChilds/i.test(k)); });
  })(obj, false);
  return out;
}
function lineInfo(o) {
  const f = flatten(o);
  const qty = toNum(o.quantity != null ? o.quantity : o.qty) || 0;
  const price = pickNum(f, [/^(final|net|effective|discounted|offer|special)(unit)?price$/i, /^(selling|sale)(unit)?price$/i, /^unit(selling|sale)?price$/i, /^price$/i, /price$/i]);
  const total = pickNum(f, [/^(final|net|line|item)?total(amount|price|value)?$/i, /^(net|final|line)?amount$/i, /^subtotal$/i]);
  const mrp = pickNum(f, [/^mrp$/i, /maxretail/i, /mrp/i]);
  const couponOff = pickNum(f, [/^(coupon|offer|promo|scheme)(discount)?(amount|value)?$/i, /coupon.*(amount|value|discount)/i, /^(total)?discount(amount|value)?$/i, /^saving(s)?(amount)?$/i]);
  const texts = [];
  Object.keys(f).forEach((p) => {
    const v = f[p];
    if (typeof v === 'string' && /coupon|offer|promo|scheme|deal/i.test(p) && !/id$|url|image|type$/i.test(leaf(p)) && v.length < 120 && !texts.includes(v)) texts.push(v);
  });
  let img = null;
  Object.keys(f).some((p) => {
    const v = f[p];
    if (typeof v === 'string' && /image|img|thumb/i.test(p) && /\.(jpe?g|png|webp)|^https?:|^\/\//i.test(v)) { img = v.startsWith('//') ? 'https:' + v : v; return true; }
    return false;
  });
  return {
    code: String(o.productCode).trim(), name: o.productName || o.name || '', qty,
    price, total: total || (price ? Math.round(price * qty * 100) / 100 : null), mrp,
    coupon: texts.slice(0, 3).join(' · ') || null, couponOff, img,
  };
}
// cart-level totals / coupons (outside the item lines)
function cartSummary(obj) {
  const f = flatten(Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !/failedItems/i.test(k))));
  const out = {};
  Object.keys(f).forEach((p) => {
    if (/cartItems|cartChilds\.\d+\.(items|products)/i.test(p)) return;
    if (/total|discount|saving|coupon|payable|subtotal|grand|amount|offer/i.test(leaf(p)) && Object.keys(out).length < 30) out[p] = f[p];
  });
  return out;
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

// Empties the LOTS cart (same call as the cart page's "Clear cart")
async function clearCart(session) {
  const fd = new FormData();
  fd.append('locale', 'en_US');
  const { res, text } = await lotsFetch(session, '/next-ocs-member/user/cart/v2/clearCart', { method: 'POST', body: fd });
  log(`Clear cart (HTTP ${res.status}): ${text.slice(0, 300)}`);
  if (!res.ok) throw new Error(`LOTS did not clear the cart (HTTP ${res.status}).`);
}

// Reads the real LOTS cart (same call the LOTS cart page uses)
let lastCartJson = null;
async function readCart(session) {
  const { res, text, json } = await lotsFetch(session, '/next-ocs-member/user/cart/v2?locale=en_US');
  log(`Cart read (HTTP ${res.status}): ${text.slice(0, 600)}`);
  if (!res.ok || !json) return null;
  lastCartJson = json;
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

  // "LOTS Cart PDF" button: only READ the cart (items you added yourself) — nothing is changed
  if (req.type === 'readCart') {
    try {
      const session = await login();
      log('Logged into LOTS (read-only cart request).');
      await ref.update({ progress: 'Reading your LOTS cart…' });
      lastCartJson = null;
      const cart = await readCart(session);
      if (cart === null || !lastCartJson) throw new Error('Could not read your LOTS cart. Please try again.');
      const raw = cartLinesRaw(lastCartJson);
      const cartLines = Object.values(raw).map(lineInfo).filter((l) => l.qty > 0);
      const first = Object.values(raw)[0];
      const cartSample = first ? JSON.stringify(first).slice(0, 3000) : null;
      const cartTotals = cartSummary(lastCartJson);
      log(`Read ${cartLines.length} cart lines. Sample line: ${cartSample ? cartSample.slice(0, 800) : '-'}`);
      await ref.update({
        status: 'done', progress: null, cartLines, cartSample, cartTotals,
        cartProductCount: cart.length, cartReadAtMs: Date.now(),
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      log('FAILED:', e.message);
      await ref.update({ status: 'failed', progress: null, error: e.message || String(e), finishedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    return;
  }

  // merge duplicate item codes (LOTS keeps one line per code): quantities are added together
  const merged = new Map();
  let duplicatesMerged = 0;
  (req.items || []).filter((it) => it && it.code && Number(it.qty) > 0).forEach((it) => {
    const k = norm(it.code);
    if (merged.has(k)) { merged.get(k).qty += Number(it.qty); duplicatesMerged++; }
    else merged.set(k, { code: String(it.code).trim(), name: it.name || '', qty: Number(it.qty) });
  });
  const items = Array.from(merged.values());
  const nameOf = {}, qtyOf = {};
  items.forEach((it) => { nameOf[norm(it.code)] = it.name; qtyOf[norm(it.code)] = it.qty; });
  log(`Request ${doc.id}: ${items.length} products (${duplicatesMerged} duplicate lines merged)`);

  try {
    if (!items.length) throw new Error('No products with a LOTS item code and quantity.');
    const session = await login();
    log('Logged into LOTS.');

    // Step 1: start from an empty cart (skipped when it's already empty)
    await ref.update({ progress: 'Checking your LOTS cart…' });
    const before = await readCart(session);
    let clearedCount = 0;
    if (before === null) {
      throw new Error('Could not read your LOTS cart, so nothing was uploaded. Please try again.');
    } else if (before.length) {
      await ref.update({ progress: `Clearing ${before.length} old products from your LOTS cart…` });
      await clearCart(session);
      await sleep(2000);
      const after = await readCart(session);
      if (after === null || after.length) {
        throw new Error(`Could not empty your LOTS cart (${after ? after.length : '?'} products still there), so nothing was uploaded. Clear it on LOTS and try again.`);
      }
      clearedCount = before.length;
      log(`Cleared ${clearedCount} old products from the LOTS cart.`);
    } else {
      log('LOTS cart already empty — nothing to clear.');
    }
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
      r.failed.forEach((f) => { f.name = nameOf[norm(f.code)] || ''; f.qty = qtyOf[norm(f.code)] || 0; f.part = p + 1; });
      results[p].failedItems = r.failed;
      log(`${label}: sent ${parts[p].length}, failed ${r.failed.length}, cart now ${r.cart.length} products`);
      if (p < parts.length - 1) await sleep(3000);
    }

    await sleep(3000);
    lastCartJson = null;
    const realCart = await readCart(session).catch(() => null);
    if (realCart) lastCart = realCart;
    // full cart lines (qty, price, coupon/offer, image) for the picking-list PDF
    let cartLines = [], cartSample = null, cartTotals = {};
    if (realCart && lastCartJson) {
      const raw = cartLinesRaw(lastCartJson);
      cartLines = Object.values(raw).map(lineInfo).filter((l) => l.qty > 0);
      const first = Object.values(raw)[0];
      cartSample = first ? JSON.stringify(first).slice(0, 3000) : null;
      cartTotals = cartSummary(lastCartJson);
      log(`Captured ${cartLines.length} cart lines for the picking list. Sample line: ${cartSample ? cartSample.slice(0, 800) : '-'}`);
      log(`Cart totals: ${JSON.stringify(cartTotals).slice(0, 800)}`);
    }
    const cartQty = {};
    lastCart.forEach((c) => { cartQty[norm(c.code)] = c.qty; });
    const failedItems = results.flatMap((r) => r.failedItems);
    failedItems.forEach((f) => { f.cartQty = cartQty[norm(f.code)] || 0; });
    const failedCodes = new Set(failedItems.map((f) => norm(f.code)));
    // safety check: every product that didn't fail should be in the cart with the full quantity
    const extra = [];
    items.forEach((it) => {
      const k = norm(it.code);
      if (failedCodes.has(k)) return;
      const have = cartQty[k];
      if (have === undefined) extra.push({ code: it.code, name: it.name, qty: it.qty, cartQty: 0, reason: 'Not in LOTS cart after upload (check stock / store availability)' });
      else if (have < it.qty) extra.push({ code: it.code, name: it.name, qty: it.qty, cartQty: have, reason: `Only ${have} of ${it.qty} in cart (LOTS limited the quantity)` });
    });
    const attention = failedItems.concat(extra);
    const attentionCodes = new Set(attention.map((f) => norm(f.code)));
    const addedCount = items.length - attentionCodes.size;

    await ref.update({
      status: 'done',
      progress: null,
      parts: results.map(({ failedItems: _, ...r }) => r),
      sentCount: items.length,
      addedCount,
      duplicatesMerged,
      failedItems: attention,
      cartProductCount: lastCart.length,
      cartLines,
      cartSample,
      cartTotals,
      cartReadAtMs: Date.now(),
      clearedCount,
      lotsResponse: firstRaw,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    log(`Done: ${addedCount} added, ${attentionCodes.size} need attention, cart has ${lastCart.length} products.`);
  } catch (e) {
    log('FAILED:', e.message);
    await ref.update({ status: 'failed', progress: null, error: e.message || String(e), finishedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
}

module.exports = { buildFile, uploadPart, collectCart, collectFailed, cartLinesRaw, lineInfo, cartSummary };
const isQuota = (e) => e && (e.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(String(e.message || e)));
if (require.main === module) (async () => {
  initDb();
  let docs;
  try {
    docs = await pendingDocs();
  } catch (e) {
    // Firebase free daily limit used up: skip quietly, try again on the next run (limit resets 12:30 PM IST)
    if (!isQuota(e)) throw e;
    console.log('Firebase daily read limit reached - skipping this run. It resets at 12:30 PM IST.');
    if (process.argv[2] === 'check' && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'pending=false\n');
    process.exit(0);
  }
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
