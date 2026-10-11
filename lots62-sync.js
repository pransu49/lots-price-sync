/**
 * LOTS 62 sync — the same daily price + stock pull as sync.js, but for the
 * second LOTS account (LOTS 62). Its prices/stock are saved separately so the
 * Admin Console can show them side by side with LOTS.
 *
 * Firestore (AIKM project): aikm_admin/lots62Catalog  (+ "chunks" subcollection,
 * same shape as aikm_admin/lotsCatalog)
 *
 * GitHub secrets used:
 *   LOTS62_USERNAME, LOTS62_PASSWORD   the LOTS 62 login
 *   AIKM_FIREBASE_SERVICE_ACCOUNT      same as the LOTS sync
 *   LOTS62_STORE_CODE (optional)       only if the store can't be read from the login
 */
const admin = require('firebase-admin');
const { loginAndGetSession, walkCategories, fetchCategoryProducts, buildSlabsFromPricingRecords, sendWhatsApp, log, sleep } = require('./sync.js');

const USER = process.env.LOTS62_USERNAME;
const PASS = process.env.LOTS62_PASSWORD;

// Find the store the LOTS 62 account shops from. The site keeps the logged-in
// user (with assortPriceStoreCode / makroMemberNo) in localStorage, sometimes as
// JSON nested inside JSON strings, so we search every value.
function findUser(authState){
  const found = {};
  const seen = new Set();
  function walk(v, depth){
    if(depth > 8 || v == null) return;
    if(typeof v === 'string'){
      const t = v.trim();
      if((t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) && t.length < 2e6){
        try{ walk(JSON.parse(t), depth + 1); }catch(e){}
      }
      return;
    }
    if(typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for(const [k, val] of Object.entries(v)){
      if(val != null && typeof val !== 'object'){
        const key = k.toLowerCase();
        if(key === 'assortpricestorecode' && !found.code) found.code = String(val);
        if(key === 'storecode' && !found.storeCode) found.storeCode = String(val);
        if((key === 'makromemberno' || key === 'makrono') && !found.makroNo) found.makroNo = String(val);
        if((key === 'pincode' || key === 'zipcode' || key === 'registerzipcode' || key === 'postalcode') && !found.pincode && /^\d{6}$/.test(String(val))) found.pincode = String(val);
        if(key === 'storename' && !found.storeName) found.storeName = String(val);
      }
      walk(val, depth + 1);
    }
  }
  walk(authState, 0);
  return found;
}

async function main(){
  if(!USER || !PASS){
    throw new Error('LOTS62_USERNAME / LOTS62_PASSWORD are not saved in GitHub secrets.');
  }
  if(!process.env.AIKM_FIREBASE_SERVICE_ACCOUNT){
    throw new Error('AIKM_FIREBASE_SERVICE_ACCOUNT is not set.');
  }

  log('Logging into LOTS 62...');
  let session;
  for(let attempt = 1; attempt <= 3; attempt++){
    try{
      session = await loginAndGetSession(USER, PASS);
      if(session.cookies.some(c => c.name === 'accessToken')) break;
      log(`  login attempt ${attempt} did not produce a session, retrying...`);
    }catch(e){
      log(`  login attempt ${attempt} failed: ${e.message}, retrying...`);
    }
    session = null;
    await sleep(3000);
  }
  if(!session) throw new Error('Could not log into LOTS 62 after 3 attempts — check the LOTS 62 username/password in GitHub secrets.');

  const cookieHeader = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  // the account's store comes from LOTS's own "current member" call (same one the website uses)
  let u = findUser(session.authState);
  if(!u.code && !u.storeCode){
    const tok = session.cookies.find(c => c.name === 'accessToken');
    const token = tok ? decodeURIComponent(tok.value) : '';
    for(const path of ['/next-ocs-member/user/profile/currentMember', '/next-ocs-member/user/cart/v2?locale=en_US']){
      try{
        const res = await fetch('https://api.lotswholesale.com' + path, {
          headers: { Authorization: `Bearer ${token}`, Cookie: cookieHeader, Origin: 'https://www.lotswholesale.com', Referer: 'https://www.lotswholesale.com/' },
        });
        const text = await res.text();
        let json = null; try{ json = JSON.parse(text); }catch(e){}
        const f = json ? findUser(json) : {};
        log(`  ${path.split('?')[0]} -> HTTP ${res.status}; fields: ${json && typeof json === 'object' ? Object.keys(json.data || json).slice(0, 40).join(', ') : text.slice(0, 120)}`);
        u = Object.assign({}, f, u);
        if(u.code || u.storeCode) break;
      }catch(e){ log(`  ${path} failed: ${e.message}`); }
    }
  }
  const store = {
    code: process.env.LOTS62_STORE_CODE || u.code || u.storeCode,
    makroNo: u.makroNo,
    pincode: u.pincode,
  };
  log(`LOTS 62 account: store code ${store.code || '?'}, pincode ${store.pincode || '?'}, member no. ${store.makroNo ? '…' + store.makroNo.slice(-4) : '?'}${u.storeName ? ', store ' + u.storeName : ''}`);
  if(!store.code){
    log('localStorage keys seen: ' + Object.keys(session.authState || {}).join(', '));
    throw new Error('Logged in, but could not read which LOTS store this account uses.');
  }

  let categories = [];
  const topMenu = session.nextData.props.pageProps.valueFromServer.topMenu;
  categories = Array.isArray(topMenu) ? topMenu.reduce((o, n) => walkCategories(n, o, []), []) : walkCategories(topMenu, []);
  log(`Found ${categories.length} leaf categories to scan.`);

  const byCode = new Map();
  let incomplete = 0;
  for(const cat of categories){
    let products = [];
    try{
      products = await fetchCategoryProducts(cookieHeader, cat.id, store);
      if(products.incomplete) incomplete++;
    }catch(e){ incomplete++; continue; }
    for(const p of products){
      const code = String(p.productCode || '').trim();
      if(!code || byCode.has(code)) continue;
      const slabs = buildSlabsFromPricingRecords(p.pricingRecords);
      if(!slabs.length) continue;
      const out = { code, name: p.productName || '' };
      out.slabs = slabs.map(([label, price]) => {
        let min, max;
        if(label.endsWith('+')){ min = parseInt(label, 10); max = null; }
        else if(label.includes('-')){ [min, max] = label.split('-').map(n => parseInt(n, 10)); }
        else { min = max = parseInt(label, 10); }
        return { min, max, price };
      });
      if(p.stockAvailableToSell != null) out.qty = Number(p.stockAvailableToSell);
      const mrp = p.pricingRecords && p.pricingRecords[0] ? p.pricingRecords[0].mrp : null;
      if(mrp != null) out.mrp = mrp;
      if(p.brand) out.brand = p.brand;
      if(cat.name) out.cat = cat.name;
      if(cat.dept && cat.dept !== cat.name) out.dept = cat.dept;
      let img = p.image || (Array.isArray(p.images) && p.images.length ? p.images[0] : null);
      if(img && typeof img === 'object') img = img.url || img.imageUrl || img.src || null;
      if(typeof img === 'string') out.img = img.startsWith('//') ? 'https:' + img : img;
      byCode.set(code, out);
    }
  }
  const products = [...byCode.values()];
  log(`LOTS 62: ${products.length} products with prices (${incomplete} categories only partly loaded).`);
  if(products.length < 500) throw new Error(`Only ${products.length} products came back — not saving, to avoid wiping good data.`);

  const sa = JSON.parse(process.env.AIKM_FIREBASE_SERVICE_ACCOUNT);
  const app = admin.initializeApp({ credential: admin.credential.cert(sa) }, 'aikm62');
  const db = app.firestore();
  const parent = db.collection('aikm_admin').doc('lots62Catalog');
  const chunksRef = parent.collection('chunks');
  const CHUNK = 400;
  const chunks = [];
  for(let i = 0; i < products.length; i += CHUNK) chunks.push(products.slice(i, i + CHUNK));
  const existing = await chunksRef.listDocuments();
  const keep = new Set(chunks.map((_, i) => `chunk_${i}`));
  await Promise.all(existing.filter(d => !keep.has(d.id)).map(d => d.delete()));
  const batch = db.batch();
  chunks.forEach((c, i) => batch.set(chunksRef.doc(`chunk_${i}`), { products: c }));
  await batch.commit();
  await parent.set({
    fileLabel: 'Daily auto-sync (LOTS 62)',
    savedAt: new Date().toISOString(),
    storeCode: store.code,
    productCount: products.length,
    chunkCount: chunks.length,
  });
  log(`Wrote ${products.length} LOTS 62 products to aikm_admin/lots62Catalog.`);
  return products.length;
}

main()
  .then(async n => {
    await sendWhatsApp(`✅ LOTS 62 sync completed: ${n} products updated.`);
    process.exit(0);
  })
  .catch(async err => {
    console.error('LOTS 62 sync failed:', err.message);
    await sendWhatsApp(`❌ LOTS 62 sync FAILED: ${err.message}`);
    process.exit(1);
  });
