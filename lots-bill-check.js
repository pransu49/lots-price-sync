/**
 * LOTS-GN bill check robot.
 *
 * Every 20 min, 10 AM – 3 PM IST:
 *   1. Looks for today's LOTS-GN tax invoice in LOTS' invoice storage — the same place the
 *      Purchase Bills page auto-fetches from (no login, no OTP).
 *   2. Finds the LOTS-GN order it belongs to in the Order Mapper (Firestore lotsCartQueue):
 *      all batches merged + your "Save my final cart" edits — the same cart as the Picking List PDF.
 *   3. Compares bill vs cart and sends Telegram: not billed, billed but not ordered, qty differences
 *      — with a PDF report.
 * Read-only on LOTS. It never changes the cart or the bill.
 *
 *   node lots-bill-check.js            normal run (only new bills are checked)
 *   node lots-bill-check.js 1061027IN/005527   re-check one bill now (sends Telegram again)
 *
 * Firebase use: 1 read per run when there is no new bill; ~30 reads + 1 write when a new bill arrives.
 * Secrets: AIKM_FIREBASE_SERVICE_ACCOUNT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (all already in this repo).
 */
const fs = require('fs');
const path = require('path');

const CARD = process.env.LOTS_INVOICE_CARD || '5687000000233754'; // same card as the Purchase Bills page
const GN_PREFIX = '106';                 // LOTS-GN bill numbers start with 106 (LOTS-62 = 102)
const STATE_DOC = ['aikm_admin', 'lotsBillCheck'];
const QUEUE = 'lotsCartQueue';
const LOOKBACK_H = 96;                   // an order is billed within 4 days

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(n * 100) / 100;
const keyOf = (c) => String(c == null ? '' : c).trim().replace(/^0+(?=\d)/, '');
function istNow() { const d = new Date(Date.now() + 5.5 * 3600e3); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), min: d.getUTCMinutes() }; }
const istDate = (iso) => new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const inr = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = (n) => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');

// ---------------- 1) LOTS invoice storage (same calls as the Purchase Bills page) ----------------
async function invoiceBase() {
  const r = await fetch('https://prd-wrapper-api.lotswholesale.com/inv/v1/card/' + encodeURIComponent(CARD));
  if (!r.ok) throw new Error(`LOTS invoice list did not answer (HTTP ${r.status})`);
  const a = await r.json();
  if (!a[0] || !a[0].url) throw new Error('LOTS invoice list is empty for this card');
  return a[0].url.split('/o/')[0] + '/o/';
}
async function listInvoices(base, prefix) {
  const out = []; let start = '';
  for (let p = 0; p < 40; p++) {
    const u = `${base}?prefix=${encodeURIComponent(`prod/${CARD}/${prefix}`)}&fields=name,size,timeCreated${start ? '&start=' + encodeURIComponent(start) : ''}`;
    const j = await (await fetch(u)).json();
    out.push(...(j.objects || []));
    if (!j.nextStartWith) break;
    start = j.nextStartWith;
  }
  return out.map((o) => {
    const file = o.name.split('/').pop().replace(/\.pdf$/i, '').replace(/^\d{8}-/, '');
    return { obj: o.name, file, no: file.replace('-', '/'), type: (file.match(/^\d+([A-Z]{2})-/) || [])[1] || '', at: o.timeCreated, url: base + o.name.split('/').map(encodeURIComponent).join('/') };
  });
}

// ---------------- 2) Read the LOTS PDF (port of the Purchase Bills page reader) ----------------
async function parseBill(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false }).promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const lines = [];
    for (const t of tc.items) {
      if (!t.str || !t.str.trim()) continue;
      const y = t.transform[5];
      let l = lines.find((x) => Math.abs(x.y - y) < 2.5);
      if (!l) lines.push(l = { y, it: [] });
      l.it.push({ x: t.transform[4], s: t.str.trim() });
    }
    lines.sort((a, b) => b.y - a.y).forEach((l) => rows.push(l.it.sort((a, b) => a.x - b.x).map((x) => x.s)));
  }
  const field = (re) => {
    for (const r of rows) for (let i = 0; i < r.length; i++) if (re.test(r[i])) { const m = r[i].match(/:\s*(.+)$/); return (m && m[1].trim()) || r[i + 1] || ''; }
    return '';
  };
  const billNo = field(/^(Tax Invoice No\.|Credit Note No\.):?/);
  const dateTxt = field(/^(Invoice Date|Credit Note Date):?/);
  const items = []; let totalRow = null, skipped = 0;
  for (const t of rows) {
    if (t[0] === 'Total:') { totalRow = t; break; }
    const a = /^[A-Z]$/.test(t[0]) ? t.slice(1) : /^[A-Z]\s+\d{6,14}$/.test(t[0]) ? [t[0].replace(/^[A-Z]\s+/, ''), ...t.slice(1)] : t;
    if (!/^\d{6,14}$/.test(a[0]) || a.length < 15) continue;
    const d = a.slice(-14), [q, , , amt, disc, taxable, cgst, , sgst] = d;
    const nameParts = a.slice(1, a.length - 14);
    const hsn = /^\d{4,8}$/.test(nameParts[nameParts.length - 1]) ? nameParts.pop() : '';
    if (!/^[\d.]+$/.test(q) || !hsn) { skipped++; continue; }
    items.push({ barcode: a[0], name: nameParts.join(' '), hsn, qty: num(q), amount: num(amt), disc: Math.abs(num(disc)), taxable: num(taxable), gst: r2(num(cgst) + num(sgst)), total: num(d[12]), rate: num(d[13]) });
  }
  const sum = items.reduce((s, x) => s + x.total, 0);
  let printed = 0;
  if (totalRow) { const n = totalRow.filter((x) => /^-?[\d,]+\.\d+$/.test(x)).map(num); printed = n[n.length - 1] || 0; }
  const [, dd, mm, yy] = dateTxt.match(/(\d{2})\/(\d{2})\/(\d{4})/) || [];
  return { billNo, billDate: yy ? `${yy}-${mm}-${dd}` : '', items, sum: r2(sum), total: Math.round(printed || sum), ok: !skipped && items.length > 0 && Math.abs(sum - printed) < 1 };
}

// ---------------- 3) The ordered cart (same merge as the Picking List PDF in the console) ----------------
function groupsFrom(docs) {
  // docs: [{id, d}] newest first. One group = one order (all its batches + "save my final cart" re-reads).
  const done = docs.filter((x) => x.d.status === 'done' && (x.d.store || 'lots') === 'lots');
  const groups = new Map();
  for (const x of done) {
    const d = x.d;
    if (d.type === 'readCart' && !d.refreshOf && !d.standalone) continue;       // plain cart peeks
    const root = d.standalone ? x.id : (d.batchOf || d.refreshOf || x.id);
    if (d.standalone && d.sideOf) { /* LOTS-GN side cart for a LOTS-62 order = its own order */ }
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(d);
  }
  return [...groups.entries()].map(([root, series]) => ({ root, ...mergeSeries(series.sort((a, b) => (a.batchNo || 1) - (b.batchNo || 1) || (a.createdAtMs || 0) - (b.createdAtMs || 0))) }));
}
function mergeSeries(series) {
  const byBatch = {}, nums = [];
  series.forEach((x) => {
    const bn = x.batchNo || 1;
    if (!byBatch[bn]) { byBatch[bn] = { push: null, refresh: null }; nums.push(bn); }
    if (x.type === 'readCart') { if (!byBatch[bn].refresh || (x.createdAtMs || 0) > (byBatch[bn].refresh.createdAtMs || 0)) byBatch[bn].refresh = x; }
    else byBatch[bn].push = x;
  });
  nums.sort((a, b) => a - b);
  const lines = {}, order = []; let failed = [], edited = 0;
  nums.forEach((bn) => {
    const g = byBatch[bn], use = g.refresh || g.push;
    if (g.refresh) edited++;
    (use.cartLines || []).forEach((l) => {
      const k = keyOf(l.code), q = Number(l.qty) || 0; if (q <= 0) return;
      if (!lines[k]) { lines[k] = { code: k, name: l.name || '', qty: 0, total: 0, price: l.price }; order.push(k); }
      const m = lines[k]; m.qty += q; m.total += l.total != null ? Number(l.total) : (l.price != null ? l.price * q : 0);
    });
    ((g.push || {}).failedItems || []).forEach((f) => failed.push(f));
  });
  failed = failed.filter((f) => !lines[keyOf(f.code)]);
  const times = series.map((s) => s.cartReadAtMs || s.createdAtMs || 0);
  return {
    createdAtMs: (series[0] || {}).createdAtMs || 0, lastAtMs: Math.max(...times), batches: nums.length, edited,
    lines: order.map((k) => ({ ...lines[k], total: r2(lines[k].total) })), failed,
  };
}

// ---------------- 4) Compare ----------------
// Ratcliff/Obershelp similarity (same as Python difflib ratio) on cleaned names
function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  const m = (s1, e1, s2, e2) => {
    let best = 0, bi = 0, bj = 0;
    for (let i = s1; i < e1; i++) for (let j = s2; j < e2; j++) {
      let k = 0; while (i + k < e1 && j + k < e2 && a[i + k] === b[j + k]) k++;
      if (k > best) { best = k; bi = i; bj = j; }
    }
    if (!best) return 0;
    return best + m(s1, bi, s2, bj) + m(bi + best, e1, bj + best, e2);
  };
  return (2 * m(0, a.length, 0, b.length)) / (a.length + b.length);
}
const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
function nameScore(cartName, billName) {
  const c = clean(cartName), b = clean(billName);
  // LOTS cuts bill names at 40 characters: compare against the same length too
  return Math.max(ratio(c, b), b.length >= 30 && c.length > b.length ? ratio(c.slice(0, b.length), b) : 0);
}
function compare(cart, bill, master) {
  const billBy = new Map(); bill.items.forEach((b) => {
    const x = billBy.get(b.barcode);
    if (x) { x.qty += b.qty; x.total += b.total; } else billBy.set(b.barcode, { ...b });
  });
  const billList = [...billBy.values()], used = new Set();
  const pairs = [], open = [];
  for (const c of cart.lines) {
    const bc = master[c.code] && master[c.code].b;
    const hit = bc && billBy.get(bc);
    if (hit && !used.has(hit.barcode)) { used.add(hit.barcode); pairs.push([c, hit]); } else open.push(c);
  }
  // name match for the rest (bill often uses a newer barcode than the LOTS catalogue)
  const cand = [];
  for (const c of open) for (const b of billList) if (!used.has(b.barcode)) { const s = nameScore(c.name, b.name); if (s >= 0.84) cand.push([s, c, b]); }
  cand.sort((x, y) => y[0] - x[0]);
  const matched = new Set();
  for (const [, c, b] of cand) { if (matched.has(c.code) || used.has(b.barcode)) continue; matched.add(c.code); used.add(b.barcode); pairs.push([c, b]); }
  // same qty + similar name = LOTS billed a different variant (e.g. Closeup -> Colgate, Natural Care -> Carton)
  const swaps = [], sc = [];
  for (const c of open) if (!matched.has(c.code)) for (const b of billList) if (!used.has(b.barcode) && Math.abs(b.qty - c.qty) < 0.001) { const s = nameScore(c.name, b.name); if (s >= 0.7) sc.push([s, c, b]); }
  sc.sort((x, y) => y[0] - x[0]);
  for (const [, c, b] of sc) { if (matched.has(c.code) || used.has(b.barcode)) continue; matched.add(c.code); used.add(b.barcode); swaps.push({ name: c.name, billName: b.name, qty: c.qty, cartTotal: c.total, billTotal: b.total }); }
  const notBilled = open.filter((c) => !matched.has(c.code)).sort((a, b) => b.total - a.total);
  const extra = billList.filter((b) => !used.has(b.barcode)).sort((a, b) => b.total - a.total);
  const qtyDiff = pairs.filter(([c, b]) => Math.abs(b.qty - c.qty) > 0.001)
    .map(([c, b]) => ({ name: c.name || b.name, billName: b.name, cartQty: c.qty, billQty: b.qty, rate: b.rate, value: r2((b.qty - c.qty) * b.rate) }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const cartTotal = r2(cart.lines.reduce((s, x) => s + x.total, 0));
  return {
    notBilled, extra, qtyDiff, swaps, matchedOk: pairs.length - qtyDiff.length, cartTotal, cartLines: cart.lines.length,
    cartUnits: cart.lines.reduce((s, x) => s + x.qty, 0),
    notBilledValue: r2(notBilled.reduce((s, x) => s + x.total, 0)), extraValue: r2(extra.reduce((s, x) => s + x.total, 0)),
    qtyValue: r2(qtyDiff.reduce((s, x) => s + x.value, 0)),
  };
}
function overlap(cart, bill, master) {
  const bcs = new Set(bill.items.map((b) => b.barcode)), names = bill.items.map((b) => clean(b.name));
  let hit = 0;
  for (const c of cart.lines) {
    const bc = master[c.code] && master[c.code].b;
    if (bc && bcs.has(bc)) { hit++; continue; }
    const cn = clean(c.name); if (names.some((n) => n && (cn.startsWith(n.slice(0, 25)) || n.startsWith(cn.slice(0, 25))))) hit++;
  }
  return cart.lines.length ? hit / Math.max(cart.lines.length, bill.items.length) : 0;
}

// ---------------- 5) PDF report (navy / gold / cream) ----------------
async function reportPdf(bill, res, order) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const NAVY = rgb(0.078, 0.129, 0.239), GOLD = rgb(0.831, 0.647, 0.216), CREAM = rgb(0.957, 0.933, 0.875), ZEBRA = rgb(0.984, 0.973, 0.945);
  const LINE = rgb(0.886, 0.851, 0.761), INK = rgb(0.1, 0.12, 0.17), MUTED = rgb(0.36, 0.38, 0.44), RED = rgb(0.706, 0.137, 0.094), GREEN = rgb(0.118, 0.482, 0.29), WHITE = rgb(1, 1, 1);
  const safe = (s) => String(s == null ? '' : s).replace(/₹/g, 'Rs ').replace(/[×]/g, 'x').replace(/[–—−]/g, '-').replace(/·/g, '-').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 34, CW = W - 2 * M;
  let page, y, pageNo = 0;
  const text = (t, x, yy, o = {}) => page.drawText(safe(t), { x, y: yy, size: o.size || 8.5, font: o.bold ? bold : reg, color: o.color || INK });
  const fit = (t, w, f, s) => { t = safe(t); while (t.length > 1 && f.widthOfTextAtSize(t, s) > w) t = t.slice(0, -2); return t; };
  const footer = () => { text('AIKM PHARMA PRIVATE LIMITED - LOTS-GN bill vs cart check', M, 18, { size: 7, color: MUTED }); const p = `Page ${pageNo}`; text(p, W - M - reg.widthOfTextAtSize(p, 7), 18, { size: 7, color: MUTED }); };
  const newPage = (first) => {
    if (page) footer();
    page = pdf.addPage([W, H]); pageNo++;
    const bh = first ? 70 : 34;
    page.drawRectangle({ x: 0, y: H - bh, width: W, height: bh, color: NAVY });
    page.drawRectangle({ x: 0, y: H - bh - 3, width: W, height: 3, color: GOLD });
    if (first) {
      text('LOTS-GN Bill vs Cart - Reconciliation', M, H - 34, { size: 16, bold: true, color: GOLD });
      text(`Invoice ${bill.billNo} dated ${bill.billDate.split('-').reverse().join('/')}  -  Order Mapper cart of ${new Date(order.createdAtMs + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} IST${order.batches > 1 ? ` (${order.batches} batches)` : ''}${order.edited ? ' incl. your edits' : ''}`, M, H - 54, { size: 8.5, color: rgb(0.9, 0.88, 0.8) });
    } else text('LOTS-GN Bill vs Cart - ' + bill.billNo, M, H - 22, { size: 10, bold: true, color: GOLD });
    y = H - bh - 3 - 18;
  };
  const ensure = (h) => { if (y - h < 34) newPage(false); };
  newPage(true);
  // KPI strip
  const k = [['CART VALUE', inr(res.cartTotal)], ['BILLED', inr(bill.total)], [res.cartTotal >= bill.total ? 'CART - BILL' : 'BILL OVER CART', inr(Math.abs(res.cartTotal - bill.total))],
    ['NOT BILLED', `${res.notBilled.length} items - ${inr(res.notBilledValue)}`], ['EXTRA BILLED', res.extra.length ? `${res.extra.length} items - ${inr(res.extraValue)}` : 'None']];
  const kw = CW / 5;
  page.drawRectangle({ x: M, y: y - 34, width: CW, height: 40, color: CREAM, borderColor: GOLD, borderWidth: 0.6 });
  k.forEach(([a, b], i) => { text(a, M + 8 + i * kw, y - 8, { size: 6.5, color: MUTED }); text(fit(b, kw - 12, bold, 8.5), M + 8 + i * kw, y - 24, { size: 8.5, bold: true, color: i >= 2 && !(i === 4 && !res.extra.length) ? RED : i === 4 ? GREEN : INK }); });
  y -= 52;
  const table = (title, head, widths, rows, total, colorCol) => {
    ensure(60);
    text(title, M, y, { size: 11, bold: true, color: NAVY }); y -= 10;
    const xs = []; let acc = M; widths.forEach((w) => { xs.push(acc); acc += w * CW; });
    const hdr = () => { page.drawRectangle({ x: M, y: y - 14, width: CW, height: 16, color: NAVY }); head.forEach((h, i) => text(h, xs[i] + 4, y - 9, { size: 7.5, bold: true, color: GOLD })); y -= 16; };
    hdr();
    rows.concat(total ? [total] : []).forEach((r, ri) => {
      const isTot = total && ri === rows.length;
      if (y - 15 < 34) { newPage(false); hdr(); }
      page.drawRectangle({ x: M, y: y - 14, width: CW, height: 15, color: isTot ? CREAM : ri % 2 ? ZEBRA : WHITE, borderColor: LINE, borderWidth: 0.3 });
      r.forEach((c, i) => text(fit(c, widths[i] * CW - 8, isTot ? bold : reg, 7.8), xs[i] + 4, y - 10, { size: 7.8, bold: isTot, color: colorCol && colorCol(ri, i, isTot) || INK }));
      y -= 15;
    });
    y -= 14;
  };
  let sec = 0;
  if (res.notBilled.length) table(`${++sec}. In cart but NOT billed (${res.notBilled.length} items)`, ['#', 'Product', 'LOTS code', 'Qty', 'Price', 'Amount'], [0.05, 0.47, 0.14, 0.08, 0.12, 0.14],
    res.notBilled.map((c, i) => [i + 1, c.name, c.code, c.qty, c.price != null ? inr(c.price) : '-', inr(c.total)]),
    ['', 'Total not billed', '', res.notBilled.reduce((s, x) => s + x.qty, 0), '', inr(res.notBilledValue)]);
  if (res.extra.length) table(`${++sec}. Billed but NOT in cart (${res.extra.length} items)`, ['#', 'Product (as billed)', 'Barcode', 'Qty', 'Rate', 'Amount'], [0.05, 0.45, 0.17, 0.07, 0.12, 0.14],
    res.extra.map((b, i) => [i + 1, b.name, b.barcode, b.qty, inr(b.rate), inr(b.total)]), ['', 'Total extra billed', '', '', '', inr(res.extraValue)], (ri, i) => (i === 5 ? RED : null));
  if (res.qtyDiff.length) table(`${++sec}. Billed with different quantity (${res.qtyDiff.length} items)`, ['#', 'Product', 'Cart qty', 'Billed', 'Diff', 'Value impact'], [0.05, 0.47, 0.1, 0.1, 0.08, 0.2],
    res.qtyDiff.map((q, i) => { const d = q.billQty - q.cartQty; return [i + 1, q.name, q.cartQty, q.billQty, (d > 0 ? '+' : '') + d, (q.value > 0 ? '+' : '-') + inr(Math.abs(q.value)) + (q.value > 0 ? ' extra billed' : ' short billed')]; }),
    ['', 'Net qty impact', '', '', '', (res.qtyValue > 0 ? '+' : '-') + inr(Math.abs(res.qtyValue))],
    (ri, i, tot) => (i >= 4 ? ((tot ? res.qtyValue : res.qtyDiff[ri].value) > 0 ? RED : GREEN) : null));
  if (res.swaps.length) table(`${++sec}. Different variant billed (${res.swaps.length} items)`, ['#', 'In cart', 'Billed as', 'Qty', 'Cart', 'Bill'], [0.05, 0.33, 0.33, 0.07, 0.11, 0.11],
    res.swaps.map((w, i) => [i + 1, w.name, w.billName, w.qty, inr(w.cartTotal), inr(w.billTotal)]));
  if (!res.notBilled.length && !res.extra.length && !res.qtyDiff.length && !res.swaps.length) { text('All good - every cart item is billed with the same quantity.', M, y, { size: 11, bold: true, color: GREEN }); y -= 20; }
  ensure(30);
  text(`${res.matchedOk} cart items match the bill exactly. Red = you pay more than ordered. Green = billed less. Items LOTS could not add to the cart (out of stock) are not counted.`, M, y, { size: 7.5, color: MUTED });
  footer();
  return Buffer.from(await pdf.save());
}

// ---------------- 6) Telegram ----------------
async function tg(method, body, isForm) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('Telegram not sent: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing'); return false; }
  try {
    let res;
    if (isForm) { body.append('chat_id', chat); res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body }); }
    else res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, disable_web_page_preview: true, ...body }) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) log('Telegram error:', j.description || res.status);
    return !!j.ok;
  } catch (e) { log('Telegram error:', e.message); return false; }
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function message(bill, res, order) {
  const ok = !res.notBilled.length && !res.extra.length && !res.qtyDiff.length && !res.swaps.length;
  const L = [];
  L.push(`${ok ? '✅' : '🧾'} <b>LOTS-GN bill check</b> — ${esc(bill.billNo)}`);
  L.push(`Cart ${inr0(res.cartTotal)} (${res.cartLines} items) · Bill ${inr0(bill.total)} (${bill.items.length} lines)`);
  if (ok) { L.push('', 'Every cart item is billed with the same quantity.'); return L.join('\n'); }
  const list = (arr, fmt, max = 8) => arr.slice(0, max).map(fmt).concat(arr.length > max ? [`  …and ${arr.length - max} more (see PDF)`] : []);
  if (res.notBilled.length) { L.push('', `❌ <b>Not billed: ${res.notBilled.length} items · ${inr0(res.notBilledValue)}</b>`); L.push(...list(res.notBilled, (c) => `• ${esc(c.name)} ×${c.qty} — ${inr0(c.total)}`)); }
  if (res.extra.length) { L.push('', `⚠️ <b>Billed but NOT ordered: ${res.extra.length} items · ${inr0(res.extraValue)}</b>`); L.push(...list(res.extra, (b) => `• ${esc(b.name)} ×${b.qty} — ${inr0(b.total)}`)); }
  if (res.qtyDiff.length) { L.push('', `↕️ <b>Qty different: ${res.qtyDiff.length} items</b>`); L.push(...list(res.qtyDiff, (q) => `• ${esc(q.name)}: cart ${q.cartQty} → bill ${q.billQty} (${q.value > 0 ? '+' : '−'}${inr0(Math.abs(q.value))})`)); }
  if (res.swaps.length) { L.push('', `🔁 <b>Different variant billed: ${res.swaps.length}</b>`); L.push(...list(res.swaps, (w) => `• ${esc(w.name)} → billed as ${esc(w.billName)} ×${w.qty}`)); }
  L.push('', `✔ ${res.matchedOk} items match.${res.extra.length || res.qtyDiff.some((q) => q.value > 0) ? ' Count the extra stock before paying.' : ' Check the delivery and claim the short items.'}`);
  return L.join('\n');
}

// ---------------- main ----------------
let db = null;
function initDb() {
  if (db) return db;
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.AIKM_FIREBASE_SERVICE_ACCOUNT)) });
  return (db = admin.firestore());
}
function loadMaster() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'lots-item-master.json'), 'utf8')); } catch (e) { log('lots-item-master.json not found — matching by name only'); return {}; }
}

async function checkBill(inv, master, state, force) {
  log(`Checking ${inv.no} (uploaded ${inv.at})`);
  const buf = Buffer.from(await (await fetch(inv.url)).arrayBuffer());
  const bill = await parseBill(buf);
  if (!bill.items.length) throw new Error(`Could not read the items of LOTS bill ${inv.no}`);
  log(`Bill ${bill.billNo}: ${bill.items.length} lines, total ${bill.total}, lines add up: ${bill.ok}`);
  const billAtMs = new Date(inv.at).getTime();
  const snap = await initDb().collection(QUEUE).where('createdAtMs', '>=', billAtMs - LOOKBACK_H * 3600e3).orderBy('createdAtMs', 'desc').limit(40).get();
  const groups = groupsFrom(snap.docs.map((x) => ({ id: x.id, d: x.data() })))
    .filter((g) => g.lines.length && g.createdAtMs < billAtMs);
  const usedRoots = new Set(Object.values(state.done || {}).filter((x) => x.no !== inv.no).map((x) => x.root));
  const scored = groups.map((g) => ({ g, s: overlap(g, bill, master) - (usedRoots.has(g.root) ? 0.25 : 0) })).sort((a, b) => b.s - a.s);
  log('Candidate orders:', scored.map((x) => `${x.g.root.slice(0, 6)} ${x.g.lines.length} items ${new Date(x.g.createdAtMs).toISOString().slice(0, 16)} score ${x.s.toFixed(2)}`).join(' | ') || 'none');
  const best = scored[0];
  if (!best || best.s < 0.2) {
    await tg('sendMessage', { text: `🧾 LOTS-GN bill ${inv.no} (${inr0(bill.total)}, ${bill.items.length} lines) arrived, but no matching LOTS-GN order was found in the Order Mapper for the last 4 days. Was it ordered by hand? Use "Read hand-filled LOTS cart" before ordering next time.` });
    return { no: inv.no, at: inv.at, root: null, billTotal: bill.total, note: 'no matching order' };
  }
  const order = best.g;
  const res = compare(order, bill, master);
  log(`Not billed ${res.notBilled.length} (${res.notBilledValue}) · extra ${res.extra.length} (${res.extraValue}) · qty diff ${res.qtyDiff.length} · ok ${res.matchedOk}`);
  const pdfBuf = await reportPdf(bill, res, order);
  const fileName = `LOTS-GN_Bill_Check_${bill.billNo.replace(/\//g, '-')}.pdf`;
  if (process.env.OUT_DIR) fs.writeFileSync(path.join(process.env.OUT_DIR, fileName), pdfBuf);
  const text = message(bill, res, order);
  if (process.env.OUT_DIR) fs.writeFileSync(path.join(process.env.OUT_DIR, fileName.replace('.pdf', '.txt')), text);
  const sent = await tg('sendMessage', { text, parse_mode: 'HTML' });
  if (!sent) await tg('sendMessage', { text: text.replace(/<[^>]+>/g, '') });
  const fd = new FormData();
  fd.append('document', new Blob([pdfBuf], { type: 'application/pdf' }), fileName);
  fd.append('caption', `LOTS-GN ${bill.billNo} vs cart`);
  await tg('sendDocument', fd, true);
  return {
    no: inv.no, at: inv.at, root: order.root, billTotal: bill.total, cartTotal: res.cartTotal, checkedAt: new Date().toISOString(),
    notBilled: res.notBilled.map((c) => ({ code: c.code, name: c.name, qty: c.qty, total: c.total })),
    extra: res.extra.map((b) => ({ barcode: b.barcode, name: b.name, qty: b.qty, total: b.total })),
    qtyDiff: res.qtyDiff.map((q) => ({ name: q.name, cartQty: q.cartQty, billQty: q.billQty, value: q.value })), swaps: res.swaps, matchedOk: res.matchedOk,
  };
}

async function main() {
  const only = process.argv[2] && process.argv[2] !== 'local' ? process.argv[2].replace('/', '-') : null;
  const now = istNow();
  const master = loadMaster();
  const base = await invoiceBase();
  const all = await listInvoices(base, only || `${GN_PREFIX}`);
  const today = all.filter((x) => x.type === 'IN' && x.file.startsWith(GN_PREFIX) && (only ? x.file === only : istDate(x.at) === now.date));
  log(`LOTS-GN bills ${only ? 'asked for' : 'uploaded today'}: ${today.map((x) => x.no).join(', ') || 'none'}`);

  const ref = initDb().collection(STATE_DOC[0]).doc(STATE_DOC[1]);
  const state = (await ref.get()).data() || { done: {} };
  state.done = state.done || {};
  const todo = today.filter((x) => only || !state.done[x.file]);
  let changed = false;
  for (const inv of todo) {
    try { state.done[inv.file] = await checkBill(inv, master, state, !!only); changed = true; }
    catch (e) { log('FAILED', inv.no, e.message); await tg('sendMessage', { text: `🔴 LOTS-GN bill check failed for ${inv.no}: ${e.message}` }); }
  }
  // 3 PM: an order was placed but no LOTS-GN bill came today -> one reminder
  if (!only && !today.length && now.hour >= 15 && state.noBillAlert !== now.date) {
    const since = Date.now() - 30 * 3600e3;
    const snap = await initDb().collection(QUEUE).where('createdAtMs', '>=', since).orderBy('createdAtMs', 'desc').limit(30).get();
    const groups = groupsFrom(snap.docs.map((x) => ({ id: x.id, d: x.data() }))).filter((g) => g.lines.length);
    const billedRoots = new Set(Object.values(state.done).map((x) => x.root));
    const waiting = groups.filter((g) => !billedRoots.has(g.root));
    if (waiting.length) {
      const g = waiting[0];
      await tg('sendMessage', { text: `⏳ No LOTS-GN bill uploaded yet today. Pending order: ${g.lines.length} items (${inr0(g.lines.reduce((s, x) => s + x.total, 0))}). The robot keeps checking — ask LOTS to upload the bill.` });
    }
    state.noBillAlert = now.date; changed = true;
  }
  if (changed) {
    const keys = Object.keys(state.done).sort((a, b) => (state.done[b].at || '').localeCompare(state.done[a].at || '')).slice(0, 60);
    state.done = Object.fromEntries(keys.map((k) => [k, state.done[k]]));
    state.updatedAt = new Date().toISOString();
    await ref.set(state);
  }
  log('Done.');
}

module.exports = { parseBill, mergeSeries, groupsFrom, compare, overlap, reportPdf, message, nameScore, listInvoices, invoiceBase };
if (require.main === module) main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  const isQuota = /RESOURCE_EXHAUSTED|Quota exceeded/i.test(String(e && e.message));
  if (isQuota) { console.log('Firebase daily limit reached — will try on the next run.'); process.exit(0); }
  process.exit(1);
});
