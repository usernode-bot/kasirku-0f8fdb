// KasirKU front end: Kasir (POS), Stok Gudang and Laporan, vanilla JS.
// Class names are written as whole literals so Tailwind can find them.
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rp = (n) => (n < 0 ? '-Rp ' : 'Rp ') + Math.abs(Math.round(n)).toLocaleString('id-ID');
  const digits = (v) => parseInt(String(v).replace(/\D/g, ''), 10) || 0;
  const dec = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const METHODS = { cash: 'Tunai', qris: 'QRIS', debit: 'Debit', transfer: 'Transfer bank', debt: 'Utang' };
  const MOVES = { restock: 'Barang masuk', return: 'Retur', opname: 'Stok opname', sale: 'Penjualan' };

  const now = () => (window.usernode && usernode.now ? usernode.now() : new Date());
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(now());
  const fmtDateTime = (iso) => new Date(iso).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

  // ── Active store (per browser) ──
  // The chosen store lives in localStorage and rides on every API call as
  // `x-usernode-store`. The server re-validates ownership on every request.
  function readSavedStore() {
    try { const v = Number(localStorage.getItem('kasirku-store')); return Number.isInteger(v) && v > 0 ? v : null; } catch (_) { return null; }
  }
  function saveStore(id) {
    try { if (id) localStorage.setItem('kasirku-store', String(id)); else localStorage.removeItem('kasirku-store'); } catch (_) {}
  }
  // Onboarding is per store: the "Langkah awal" checklist hides for good for a
  // store once all three of its steps are done (flag "1" in localStorage).
  function onboardedKey(id) {
    try { return localStorage.getItem('kasirku-onboarded-' + id) === '1'; } catch (_) { return false; }
  }
  function markOnboarded(id) {
    try { localStorage.setItem('kasirku-onboarded-' + id, '1'); } catch (_) {}
  }

  // ── Offline (per account, on this device) ──
  // An offline load carries no token, so the page remembers who it was for
  // (`kasirku-user`, from /api/stores) and keeps everything per account:
  // the last catalog it saw (`kasirku:u<id>:cache`) and the sales rung up
  // while offline that still have to be sent (`kasirku:u<id>:outbox`).
  // Nothing here is ever deleted just because a load has no token.
  function readJson(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
  }
  // Writes and reads back, so a device that refuses storage is found out
  // instead of trusted.
  function writeJson(key, value) {
    try {
      const v = JSON.stringify(value);
      localStorage.setItem(key, v);
      return localStorage.getItem(key) === v;
    } catch (_) { return false; }
  }
  const storageOk = (function () {
    try { localStorage.setItem('kasirku-probe', '1'); const ok = localStorage.getItem('kasirku-probe') === '1'; localStorage.removeItem('kasirku-probe'); return ok; } catch (_) { return false; }
  })();
  let me = readJson('kasirku-user');
  const userKey = (part) => (me && me.id != null ? 'kasirku:u' + me.id + ':' + part : null);
  function readCache() {
    const c = userKey('cache') && readJson(userKey('cache'));
    return c && typeof c === 'object' ? c : { stores: null, storeById: {}, productsByStore: {}, savedAt: null };
  }
  function updateCache(fn) {
    if (!userKey('cache')) return;
    const c = readCache(); fn(c); c.savedAt = new Date().toISOString();
    writeJson(userKey('cache'), c);
  }
  function readOutbox() {
    const list = userKey('outbox') && readJson(userKey('outbox'));
    return Array.isArray(list) ? list : [];
  }
  const writeOutbox = (list) => !!userKey('outbox') && writeJson(userKey('outbox'), list);
  const canQueue = () => storageOk && !!userKey('outbox');
  // The short reference printed on a receipt made offline ("OFF-7F3A2C"); the
  // server prints the same one once the sale has arrived.
  const offRef = (ref) => 'OFF-' + String(ref || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();

  // ── API ──
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) { try { sessionStorage.setItem('kasirku-token', urlToken); } catch (_) {} }
  function token() {
    if (urlToken) return urlToken;
    try { return sessionStorage.getItem('kasirku-token') || ''; } catch (_) { return ''; }
  }
  async function api(path, opts) {
    const o = opts || {};
    const headers = { 'content-type': 'application/json' };
    if (token()) headers['x-usernode-token'] = token();
    const storeId = o.store || S.activeStoreId;
    if (storeId) headers['x-usernode-store'] = String(storeId);
    if (window.usernode && usernode.previewNow) headers['x-usernode-now'] = usernode.now().toISOString();
    let res;
    try {
      res = await fetch(path, { method: o.method || 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined });
    } catch (_) {
      setOffline(true);
      const err = new Error('Koneksi terputus');
      err.status = 0;
      throw err;
    }
    setOffline(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error === 'account_required' ? 'Masuk ke akun Homeroom untuk mengubah data' : (data.error || 'Permintaan gagal'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ── State ──
  const S = {
    tab: 'kasir', stores: [], storesState: 'loading', activeStoreId: readSavedStore(),
    store: null, products: [], productsState: 'loading', q: '', cat: 'Semua', stockQ: '',
    cart: [], discType: 'none', discValue: 0, taxPct: 11, method: 'cash', paid: 0, paying: false,
    checkoutRef: null, payUncertain: false,
    movements: null, movementsState: 'loading', report: null, reportState: 'loading', reportDate: today(),
    reportMode: 'daily', reportMonth: today().slice(0, 7),
    receipt: null, customerName: '', customerPhone: '',
    offline: false, sendingRef: null, debts: null, debtsState: 'loading', settleId: null, settleMethod: 'cash',
  };
  const hasStore = () => !!S.activeStoreId;

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ── Logo: a cash register with a box beside it ──
  function logoSvg(cls) {
    return '<svg viewBox="0 0 40 40" class="' + cls + '" role="img" aria-label="Logo KasirKU">'
      + '<rect width="40" height="40" rx="10" class="fill-accent"/>'
      + '<rect x="10" y="9" width="9" height="7" rx="1.5" class="fill-on-accent"/>'
      + '<path d="M7 19h15l1.5 12h-18z" class="fill-on-accent"/>'
      + '<rect x="9.5" y="23" width="3" height="2.5" rx="0.6" class="fill-accent"/>'
      + '<rect x="14" y="23" width="3" height="2.5" rx="0.6" class="fill-accent"/>'
      + '<rect x="18.500" y="23" width="3" height="2.5" rx="0.6" class="fill-accent"/>'
      + '<path d="M31 11l6 3.500v7L31 25l-6-3.500v-7z" class="fill-on-accent stroke-accent" stroke-width="1" stroke-linejoin="round"/>'
      + '<path d="M25 14.500l6 3.500 6-3.500M31 18v7" class="stroke-accent" fill="none" stroke-width="1.500" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>';
  }
  const storeLogo = (cls) => (S.store && S.store.logoUrl
    ? '<img src="' + esc(S.store.logoUrl) + '" alt="Logo toko" class="' + cls + ' rounded-lg object-cover">'
    : logoSvg(cls));

  // ── Cart maths (mirrors the server, which recomputes everything) ──
  function calc() {
    const subtotal = S.cart.reduce((a, l) => a + l.qty * l.price, 0);
    const discount = S.discType === 'percent' ? Math.round(subtotal * Math.min(S.discValue, 100) / 100)
      : S.discType === 'fixed' ? Math.min(Math.round(S.discValue), subtotal) : 0;
    const tax = Math.round((subtotal - discount) * S.taxPct / 100);
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }

  // ── Loading ──
  async function loadStores() {
    try {
      const data = await api('/api/stores');
      S.stores = data.stores;
      S.storesState = 'ok';
      if (data.me && data.me.id != null) {
        me = { id: data.me.id, username: data.me.username || '' };
        writeJson('kasirku-user', me);
      }
      updateCache((c) => { c.stores = S.stores; });
    } catch (e) {
      // Offline: the stores this account had on the last online visit.
      const cached = !e.status && readCache().stores;
      if (cached) { S.stores = cached; S.storesState = 'ok'; } else { S.storesState = 'error'; S.stores = []; }
    }
    const ids = S.stores.map((s) => s.id);
    if (S.activeStoreId && !ids.includes(S.activeStoreId)) S.activeStoreId = null;
    if (!S.activeStoreId && ids.length) S.activeStoreId = ids[0];
    saveStore(S.activeStoreId);
    renderShell();
    return ids.length > 0;
  }
  async function loadStore() {
    if (!hasStore()) { S.store = null; renderBrand(); renderOnboarding(); return; }
    try {
      S.store = await api('/api/store');
      if (S.store) updateCache((c) => { c.storeById = c.storeById || {}; c.storeById[S.store.id] = S.store; });
      S.taxPct = S.store ? S.store.taxPercent : 11;
      $('#tax-pct').value = String(S.taxPct);
      $('#staging-note').hidden = !(S.store && S.store.staging);
      renderBrand();
      renderCart();
      renderOnboarding();
    } catch (e) {
      const cached = !e.status && ((readCache().storeById || {})[S.activeStoreId] || S.stores.find((x) => x.id === S.activeStoreId));
      if (cached) {
        S.store = cached; S.taxPct = cached.taxPercent; $('#tax-pct').value = String(S.taxPct);
        $('#staging-note').hidden = !cached.staging;
        renderCart();
      } else S.store = S.store || { name: 'KasirKU', address: '', phone: '', logoUrl: '', taxPercent: 11 };
      renderBrand(); renderOnboarding();
    }
  }
  // The catalog as the server last answered, minus the sales still waiting
  // in this device's queue (they are not on the server yet).
  let baseProducts = [];
  function withPending(list) {
    const sold = {};
    readOutbox().filter((x) => x.state !== 'failed' && x.storeId === S.activeStoreId)
      .forEach((x) => (x.body.items || []).forEach((i) => { sold[i.productId] = (sold[i.productId] || 0) + i.qty; }));
    return list.map((p) => {
      if (!sold[p.id]) return p;
      const stock = p.stock - sold[p.id];
      return Object.assign({}, p, { stock, low: stock < p.minStock, out: stock <= 0 });
    });
  }
  function applyPending() { S.products = withPending(baseProducts); }
  async function loadProducts() {
    if (!hasStore()) { S.products = []; S.productsState = 'ok'; renderProducts(); return; }
    S.productsState = 'loading'; renderProducts();
    const storeId = S.activeStoreId;
    try {
      baseProducts = (await api('/api/products')).products;
      updateCache((c) => { c.productsByStore = c.productsByStore || {}; c.productsByStore[storeId] = baseProducts; });
      applyPending();
      S.productsState = 'ok';
      reconcileCart();
    } catch (e) {
      const cached = !e.status && (readCache().productsByStore || {})[storeId];
      if (cached) { baseProducts = cached; applyPending(); S.productsState = 'ok'; reconcileCart(); } else S.productsState = 'error';
    }
    renderProducts();
  }
  async function loadMovements() {
    if (!hasStore()) { S.movements = []; S.movementsState = 'ok'; renderMovements(); return; }
    S.movementsState = 'loading'; renderMovements();
    try { S.movements = (await api('/api/movements')).movements; S.movementsState = 'ok'; } catch (e) { S.movementsState = 'error'; }
    renderMovements();
  }
  async function loadReport() {
    if (!hasStore()) { S.report = null; S.reportState = 'loading'; renderReport(); return; }
    S.reportState = 'loading'; renderReport();
    const url = S.reportMode === 'monthly'
      ? '/api/reports?mode=monthly&month=' + encodeURIComponent(S.reportMonth)
      : '/api/reports?date=' + encodeURIComponent(S.reportDate);
    try { S.report = await api(url); S.reportState = 'ok'; } catch (e) { S.reportState = 'error'; }
    renderReport();
    loadDebts();
  }
  async function loadDebts() {
    if (!hasStore()) { S.debts = null; renderDebts(); return; }
    S.debtsState = 'loading'; renderDebts();
    try { S.debts = await api('/api/debts'); S.debtsState = 'ok'; } catch (e) { S.debtsState = 'error'; }
    renderDebts();
  }

  // ── Shell: the no-store gate vs the tabs ──
  function renderShell() {
    const empty = !hasStore();
    $('#store-gate').hidden = !empty;
    $('#main-area').hidden = empty;
    // Locked tabs explain themselves: a small lock after the name plus the
    // same words as each tab's tooltip. The lock waits for the store list to
    // answer, so it never claims "no store" while the list is still loading
    // or failed to load.
    const lock = empty && S.storesState === 'ok';
    $$('#main-tabs [role=tab]').forEach((b) => {
      b.disabled = empty;
      if (lock) { b.title = 'Buat toko dulu.'; }
      else { b.removeAttribute('title'); }
      const icon = b.querySelector('[data-tab-lock]');
      if (lock && !icon) b.insertAdjacentHTML('beforeend', TAB_LOCK_SVG);
      if (!lock && icon) icon.remove();
    });
    renderBrand();
    renderOnboarding();
    renderOffline();
  }

  // ── Shared state blocks ──
  const skeletonRows = (n) => '<div class="flex flex-col gap-2">' + Array.from({ length: n }, () => '<div class="skeleton h-14"></div>').join('') + '</div>';
  const errorBox = (what, retry) => '<div class="state-error rounded-xl border border-line bg-surface" role="alert"><p class="text-heading">' + esc(what) + ' gagal dimuat</p>'
    + '<p class="text-body text-muted">Data lain di layar ini tetap bisa dipakai. Periksa koneksi, lalu coba lagi.</p>'
    + '<button type="button" class="btn-secondary" data-retry="' + retry + '">Coba lagi</button></div>';

  // While offline, screens that need the server say so (with Retry) instead
  // of a generic load failure.
  const offlineBox = (what) => '<div class="state-error rounded-xl border border-line bg-surface" role="status"><p class="text-heading">' + esc(what) + ' butuh koneksi internet</p>'
    + '<p class="text-body text-muted">Kasir tetap bisa dipakai. Penjualan disimpan di perangkat ini dan dikirim otomatis saat online.</p>'
    + '<button type="button" class="btn-secondary" data-retry="online">Coba lagi</button></div>';

  // ── Offline band and sync ──
  // S.offline flips on any request that cannot reach the server (and the
  // browser's own offline event) and back on the next one that does.
  function setOffline(v) {
    if (v === S.offline) return;
    S.offline = v;
    renderOffline();
    if (!v) setTimeout(onReconnect, 0);
  }
  async function onReconnect() {
    await sync();
    if (!hasStore()) return;
    loadStore(); loadProducts();
    if (S.tab === 'stok') loadMovements();
    if (S.tab === 'laporan') loadReport();
  }
  function renderOffline() {
    const list = readOutbox();
    const waiting = list.filter((x) => x.state !== 'failed').length;
    const failed = list.length - waiting;
    let msg = '';
    if (S.offline && !canQueue()) msg = 'Perangkat ini tidak bisa menyimpan transaksi offline. Tunggu sampai online untuk membayar.';
    else if (S.offline) {
      const saved = readCache().savedAt;
      msg = 'Offline. Transaksi disimpan di perangkat ini dan dikirim otomatis saat online.'
        + (waiting ? ' <strong>' + waiting + ' menunggu dikirim.</strong>' : '')
        + (saved ? ' Data produk per jam ' + fmtTime(saved) + '.' : '');
    } else if (S.sendingRef) msg = 'Mengirim ' + waiting + ' transaksi…';
    else if (waiting) msg = waiting + ' transaksi offline menunggu dikirim.';
    if (failed) msg += (msg ? ' ' : '') + '<strong>' + failed + ' perlu dicek.</strong>';
    $('#offline-band').hidden = !msg;
    $('#offline-text').innerHTML = msg;
    $('#offline-view').hidden = !list.length;
    // Writes other than a sale wait for the connection.
    ['#add-product', '#open-store', '#store-switch-btn'].forEach((sel) => {
      const b = $(sel);
      b.disabled = S.offline;
      if (S.offline) b.title = 'Butuh koneksi'; else b.removeAttribute('title');
    });
    if ($('#dlg-outbox').open) renderOutbox();
    updateTotals();
    if (S.tab === 'stok') { renderStockList(); renderMovements(); }
    if (S.tab === 'laporan') { renderReport(); renderDebts(); }
  }

  // Sends the queued sales one at a time, oldest first, each to the store it
  // was rung up in. The same clientRef means a sale that did reach the server
  // before the connection dropped is answered, not recorded twice.
  let syncing = false;
  async function sync() {
    if (syncing || !canQueue()) return;
    const queue = readOutbox().filter((x) => x.state !== 'failed');
    if (!queue.length) return;
    syncing = true;
    let sent = 0;
    try {
      for (const item of queue) {
        S.sendingRef = item.clientRef; renderOffline();
        try {
          await api('/api/sales', { method: 'POST', body: item.body, store: item.storeId });
          writeOutbox(readOutbox().filter((x) => x.clientRef !== item.clientRef));
          sent += 1;
        } catch (e) {
          // No connection, signed out, or the server is busy: try again later.
          if (!e.status || e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500) break;
          // Refused for good: keep it, flagged, until the owner removes it.
          writeOutbox(readOutbox().map((x) => (x.clientRef === item.clientRef ? Object.assign({}, x, { state: 'failed', error: e.message }) : x)));
        }
      }
    } finally {
      syncing = false; S.sendingRef = null;
    }
    renderOffline();
    if (sent) {
      toast(sent + ' transaksi offline sudah tersinkron');
      if (S.store) S.store.hasSales = true;
      if (hasStore()) { loadProducts(); loadMovements(); if (S.tab === 'laporan') loadReport(); }
    }
  }

  // ── Transaksi offline (the queue) ──
  function renderOutbox() {
    const list = readOutbox();
    const box = $('#outbox-list');
    $('#outbox-note').textContent = S.offline
      ? 'Dikirim otomatis saat perangkat ini online lagi.' : 'Transaksi yang dicatat saat offline di perangkat ini.';
    if (!list.length) {
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-body text-muted">Semua transaksi offline sudah tersinkron.</p></div>';
      return;
    }
    const many = S.stores.length > 1;
    box.innerHTML = '<ul class="list">' + list.map((x) => {
      const sale = x.local.sale;
      const status = x.state === 'failed' ? '<span class="badge text-danger shrink-0">Perlu dicek</span>'
        : x.clientRef === S.sendingRef ? '<span class="badge text-accent shrink-0">Sedang dikirim</span>'
          : '<span class="badge text-muted shrink-0">Menunggu dikirim</span>';
      const storeName = many ? ((S.stores.find((st) => st.id === x.storeId) || {}).name || '') : '';
      return '<li class="flex flex-col gap-2 px-4 py-3"><div class="flex items-center gap-3">'
        + '<button type="button" data-outbox-receipt="' + esc(x.clientRef) + '" class="min-w-0 grow rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">'
        + '<p class="text-body font-medium">' + rp(sale.total) + ' · ' + esc(METHODS[sale.paymentMethod] || '') + '</p>'
        + '<p class="text-small text-muted">' + esc(sale.invoiceNo) + ' · ' + fmtDateTime(sale.createdAt) + (storeName ? ' · ' + esc(storeName) : '') + '</p></button>'
        + status + '</div>'
        + (x.state === 'failed'
          ? '<p class="text-small text-danger">' + esc(x.error || 'Ditolak server') + '</p>'
            + '<div class="flex justify-end"><button type="button" class="btn-secondary" data-outbox-drop="' + esc(x.clientRef) + '">Hapus dari antrean</button></div>'
          : '')
        + '</li>';
    }).join('') + '</ul>';
  }
  function openOutbox() { renderOutbox(); $('#dlg-outbox').showModal(); }
  function showLocalReceipt(ref) {
    const item = readOutbox().find((x) => x.clientRef === ref);
    if (!item) return;
    if ($('#dlg-outbox').open) $('#dlg-outbox').close();
    openReceipt(item.local);
  }

  // ── Brand ──
  function renderBrand() {
    $('#brand-logo').innerHTML = logoSvg('h-10 w-10');
    const name = S.store ? S.store.name : '';
    // The active store now lives on the switcher button itself, so the old
    // muted subtitle stays empty (and hidden) to avoid printing the name twice.
    const sub = $('#brand-store');
    sub.textContent = '';
    sub.hidden = true;
    $('#store-switch-btn').textContent = (name || 'Pilih toko') + ' ▾';
    // Until the caller owns a store, the one thing to do is "Buat toko" in the
    // gate below: keep the switcher and "Profil toko" out of the header.
    // Also hidden while the store list is loading or failed to load (S.stores
    // is [] for both), so they never flash in and then vanish.
    const none = !S.stores.length;
    $('#store-switch-btn').hidden = none;
    $('#open-store').hidden = none;
  }

  // ── Langkah awal: a three-step starter checklist ──
  // One render function computes the three steps from the store's real data
  // (a store exists, a product exists, a sale exists) and writes the list
  // into whichever container is visible: below the "Belum ada toko" card
  // before the first store, and at the top of the Kasir tab afterwards.
  // Hidden while data is loading or failed, so no step ever shows a wrong
  // tick, and gone for good once all three are done.
  const STEP_DONE_SVG = '<svg viewBox="0 0 20 20" class="h-4 w-4 stroke-on-accent" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>';
  // Padlock shown inside a locked main tab (no store yet): line-drawn in
  // currentColor, so it follows the tab's own muted text colour in both looks.
  const TAB_LOCK_SVG = '<svg data-tab-lock viewBox="0 0 20 20" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 9h10v8H5z M7 9V6a3 3 0 0 1 6 0v3"/></svg>';
  function stepMarker(state, num) {
    if (state === 'done') return '<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">' + STEP_DONE_SVG + '</span>';
    const cls = state === 'next' ? 'border-2 border-accent text-accent' : 'border-2 border-line text-muted';
    return '<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-small font-semibold ' + cls + '">' + num + '</span>';
  }
  function onboardingHtml(steps) {
    const done = steps.filter((s) => s.done).length;
    const next = steps.findIndex((s) => !s.done);
    const rows = steps.map((s, i) => {
      const state = s.done ? 'done' : i === next ? 'next' : 'later';
      const titleCls = state === 'done' ? 'text-body font-medium text-muted line-through' : 'text-body font-medium';
      return '<li class="list-row">' + stepMarker(state, i + 1)
        + '<div class="min-w-0 grow"><p class="' + titleCls + '">' + esc(s.title) + '</p>'
        + (state !== 'done' && s.hint ? '<p class="text-small text-muted">' + esc(s.hint) + '</p>' : '')
        + '</div>'
        + (state === 'done' ? '<span class="shrink-0 text-small text-muted">Selesai</span>' : (s.btn || ''))
        + '</li>';
    }).join('');
    return '<div class="section-label flex justify-between"><span>Langkah awal</span><span>' + done + ' dari 3 selesai</span></div>'
      + '<ol class="list" aria-label="Langkah awal">' + rows + '</ol>';
  }
  function renderOnboarding() {
    const gateBox = $('#gate-steps');
    const kasirBox = $('#kasir-steps');
    if (!hasStore()) {
      gateBox.innerHTML = onboardingHtml([
        { done: false, title: 'Buat toko', hint: 'Isi nama toko di atas, lalu tekan Buat toko.' },
        { done: false, title: 'Tambah produk', hint: 'Bisa setelah toko dibuat.' },
        { done: false, title: 'Catat penjualan pertama', hint: 'Bisa setelah toko dibuat.' },
      ]);
      kasirBox.hidden = true;
      return;
    }
    gateBox.innerHTML = '';
    // No guessed ticks: wait until products and the sale flag have really loaded.
    if (S.productsState !== 'ok' || typeof (S.store && S.store.hasSales) !== 'boolean') { kasirBox.hidden = true; return; }
    if (onboardedKey(S.activeStoreId)) { kasirBox.hidden = true; return; }
    const prodDone = S.products.length > 0;
    const saleDone = !!S.store.hasSales;
    if (prodDone && saleDone) { markOnboarded(S.activeStoreId); kasirBox.hidden = true; return; }
    const steps = [{ done: true, title: 'Buat toko' }];
    steps.push(prodDone
      ? { done: true, title: 'Tambah produk' }
      : {
        done: false, title: 'Tambah produk', hint: 'Masukkan harga modal, harga jual dan stok awal.',
        btn: '<button type="button" class="btn-secondary shrink-0" data-new-product>Tambah produk</button>',
      });
    steps.push({
      done: saleDone, title: 'Catat penjualan pertama',
      hint: prodDone ? 'Pilih produk di bawah, lalu tekan Bayar.' : 'Bisa setelah ada produk.',
    });
    kasirBox.innerHTML = onboardingHtml(steps);
    kasirBox.hidden = false;
  }

  // ── Store switcher ──
  function renderStoresDialog() {
    $('#open-store-profile').hidden = !hasStore();
    const box = $('#stores-list');
    if (S.storesState === 'error') { box.innerHTML = errorBox('Daftar toko', 'stores'); return; }
    if (!S.stores.length) {
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-body text-muted">Belum ada toko. Tambahkan toko pertama Anda.</p></div>';
      return;
    }
    box.innerHTML = '<ul class="list">' + S.stores.map((s) =>
      '<li class="list-row"><div class="min-w-0 grow"><p class="text-body font-medium">' + esc(s.name) + '</p>'
      + (s.address ? '<p class="text-small text-muted truncate">' + esc(s.address) + '</p>' : '') + '</div>'
      + (s.id === S.activeStoreId
        ? '<span class="badge text-accent shrink-0">Toko aktif</span>'
        : '<button type="button" class="btn-secondary shrink-0" data-switch="' + s.id + '">Pilih</button>') + '</li>').join('') + '</ul>';
  }
  function openStores() { renderStoresDialog(); openDlg($('#dlg-stores')); }

  async function setActiveStore(id) {
    if (!S.stores.some((s) => s.id === id)) return;
    if (id === S.activeStoreId) { $('#dlg-stores').close(); return; }
    if (S.paying) return toast('Tunggu transaksi selesai');
    S.activeStoreId = id; saveStore(id);
    // A cart belongs to one store: never shop two stores in one transaction.
    S.cart = []; S.paid = 0; S.cat = 'Semua'; S.q = ''; $('#cash-paid').value = ''; $('#pos-search').value = '';
    cartChanged();
    renderShell(); $('#dlg-stores').close();
    toast('Toko aktif: ' + ((S.stores.find((s) => s.id === id) || {}).name || ''));
    await loadStore(); loadProducts(); loadMovements(); if (S.tab === 'laporan') loadReport();
  }

  // ── Kasir ──
  const categories = () => Array.from(new Set(S.products.map((p) => p.category))).sort();
  function renderProducts() {
    renderPos();
    renderStockList();
    $('#cat-list').innerHTML = categories().map((c) => '<option value="' + esc(c) + '"></option>').join('');
    renderOnboarding();
  }
  function renderPos() {
    const box = $('#pos-products');
    const cats = $('#pos-cats');
    if (S.productsState === 'loading') {
      cats.innerHTML = '';
      box.innerHTML = '<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">' + Array.from({ length: 8 }, () => '<div class="skeleton h-24"></div>').join('') + '</div>';
      return;
    }
    if (S.productsState === 'error') { cats.innerHTML = ''; box.innerHTML = errorBox('Katalog produk', 'products'); return; }
    if (!S.products.length) {
      cats.innerHTML = '';
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Belum ada produk</p>'
        + '<p class="text-body text-muted">Tambahkan produk di Manajemen Stok Gudang agar bisa dijual.</p>'
        + '<button type="button" class="btn-primary" data-goto="stok">Buka stok gudang</button></div>';
      return;
    }
    if (S.cat !== 'Semua' && !categories().includes(S.cat)) S.cat = 'Semua';
    cats.innerHTML = ['Semua'].concat(categories()).map((c) =>
      '<button type="button" class="seg shrink-0" data-cat="' + esc(c) + '" aria-pressed="' + (c === S.cat) + '">' + esc(c) + '</button>').join('');
    const q = S.q.trim().toLowerCase();
    const list = S.products.filter((p) => (S.cat === 'Semua' || p.category === S.cat)
      && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)));
    if (!list.length) {
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Produk tidak ditemukan</p><p class="text-body text-muted">Coba kata kunci atau kategori lain.</p></div>';
      return;
    }
    box.innerHTML = '<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">' + list.map((p) => {
      const inCart = (S.cart.find((l) => l.id === p.id) || {}).qty || 0;
      const sold = p.out || inCart >= p.stock;
      return '<button type="button" data-add="' + p.id + '" ' + (sold ? 'disabled' : '')
        + ' class="flex min-h-24 flex-col items-start gap-1 rounded-xl border border-line bg-surface p-3 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50">'
        + '<span class="text-body font-medium leading-tight">' + esc(p.name) + '</span>'
        + '<span class="text-body">' + rp(p.sellPrice) + '</span>'
        + '<span class="text-small ' + (p.out || p.low ? 'text-danger' : 'text-muted') + '">' + (p.out ? 'Stok habis' : 'Stok ' + p.stock + (inCart ? ' (' + inCart + ' di keranjang)' : '')) + '</span></button>';
    }).join('') + '</div>';
  }

  function addToCart(id) {
    const p = S.products.find((x) => x.id === id);
    if (!p) return;
    const line = S.cart.find((l) => l.id === id);
    if (line) {
      if (line.qty >= p.stock) return toast('Stok ' + p.name + ' hanya ' + p.stock);
      line.qty += 1;
    } else {
      if (p.stock < 1) return;
      S.cart.push({ id: p.id, name: p.name, sku: p.sku, stock: p.stock, listPrice: p.sellPrice, price: p.sellPrice, qty: 1 });
    }
    cartChanged(); renderCart(); renderPos();
  }

  // A changed cart, discount, tax, method or amount is a new transaction: the
  // next Bayar gets a fresh reference instead of retrying the last one.
  function cartChanged() { S.checkoutRef = null; S.payUncertain = false; }

  // After every catalogue refresh: compare each line with the latest stock.
  // Quantities are never lowered silently; the line is flagged instead.
  function reconcileCart() {
    S.cart.forEach((l) => {
      const p = S.products.find((x) => x.id === l.id);
      l.gone = !p;
      if (p) l.stock = p.stock;
    });
    renderCart();
  }

  // What a line needs fixing before it can be paid, or ''.
  function lineProblem(l) {
    if (l.gone) return 'Produk sudah dihapus dari katalog, hapus dari keranjang';
    if (l.qty > l.stock) return 'Stok tinggal ' + l.stock + ', kurangi jumlahnya';
    if (l.price < 1) return 'Harga satuan belum diisi';
    return '';
  }

  // The first thing that blocks payment, in the order a cashier fixes them.
  function cartProblem(t) {
    if (!S.cart.length) return 'Tambahkan produk ke keranjang dulu.';
    const gone = S.cart.find((l) => l.gone);
    if (gone) return gone.name + ' sudah dihapus dari katalog, hapus dari keranjang.';
    const short = S.cart.find((l) => l.qty > l.stock);
    if (short) return 'Stok ' + short.name + ' tinggal ' + short.stock + ', kurangi jumlahnya.';
    const free = S.cart.find((l) => l.price < 1);
    if (free) return 'Isi harga satuan ' + free.name + '.';
    if (t.total > 2000000000) return 'Total transaksi terlalu besar.';
    if (S.method === 'cash' && S.paid < t.total) return 'Uang diterima masih kurang ' + rp(t.total - S.paid) + '.';
    if (S.method === 'debt' && !S.customerName.trim()) return 'Isi nama pelanggan untuk utang.';
    if (S.method === 'debt' && S.customerPhone.trim() && waNumber(S.customerPhone) === null) return 'Nomor WhatsApp pelanggan tidak valid.';
    if (S.offline && !canQueue()) return 'Perangkat ini tidak bisa menyimpan transaksi offline. Tunggu sampai online untuk membayar.';
    return '';
  }

  // A WhatsApp number in international form ("0812-3456 7890" → 6281234567890),
  // '' when nothing was typed, null when it cannot be a phone number.
  function waNumber(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (!/^[0-9 +().-]+$/.test(s)) return null;
    let d = s.replace(/\D/g, '');
    if (d[0] === '0') d = '62' + d.slice(1);
    else if (d[0] === '8') d = '62' + d;
    return d.length >= 9 && d.length <= 15 ? d : null;
  }

  function renderCart() {
    const box = $('#cart-lines');
    $('#cart-clear').hidden = !S.cart.length;
    if (!S.cart.length) {
      box.innerHTML = '<div class="state-empty rounded-lg border border-dashed border-line"><p class="text-body font-medium">Keranjang masih kosong</p><p class="text-small text-muted">Ketuk produk di sebelah kiri untuk menambahkannya.</p></div>';
    } else {
      box.innerHTML = '<ul class="divide-y divide-line">' + S.cart.map((l) =>
        '<li class="flex flex-col gap-2 py-3" data-line="' + l.id + '">'
        + '<div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="text-body font-medium leading-tight">' + esc(l.name) + '</p>'
        + '<p class="text-small text-muted">' + esc(l.sku) + (l.price !== l.listPrice ? ' · harga normal ' + rp(l.listPrice) : '') + '</p>'
        + (lineProblem(l) ? '<p class="text-small text-danger" data-line-problem="' + l.id + '">' + lineProblem(l) + '</p>' : '') + '</div>'
        + '<button type="button" class="btn-secondary shrink-0" data-remove="' + l.id + '" aria-label="Hapus ' + esc(l.name) + ' dari keranjang">Hapus</button></div>'
        + '<div class="flex items-end gap-2">'
        + '<div class="flex items-center gap-1"><button type="button" class="btn-secondary px-0" data-dec="' + l.id + '" aria-label="Kurangi jumlah">−</button>'
        + '<input class="field w-14 px-1 text-center" data-qty="' + l.id + '" inputmode="numeric" value="' + l.qty + '" aria-label="Jumlah ' + esc(l.name) + '">'
        + '<button type="button" class="btn-secondary px-0" data-inc="' + l.id + '" aria-label="Tambah jumlah">+</button></div>'
        + '<div class="min-w-0 grow"><label class="block text-small text-muted" for="price-' + l.id + '">Harga satuan</label>'
        + '<input id="price-' + l.id + '" class="field px-2" data-price="' + l.id + '" inputmode="numeric" value="' + l.price + '"></div>'
        + '<p class="shrink-0 pb-2 text-body font-medium" data-line-total="' + l.id + '">' + rp(l.qty * l.price) + '</p></div></li>').join('') + '</ul>';
    }
    updateTotals();
  }

  function updateTotals() {
    const t = calc();
    $('#t-sub').textContent = rp(t.subtotal);
    $('#t-disc').textContent = t.discount ? '-' + rp(t.discount) : rp(0);
    $('#t-tax').textContent = rp(t.tax);
    $('#t-total').textContent = rp(t.total);
    S.cart.forEach((l) => { const el = $('[data-line-total="' + l.id + '"]'); if (el) el.textContent = rp(l.qty * l.price); });
    const cash = S.method === 'cash';
    $('#cash-box').hidden = !cash;
    $('#debt-box').hidden = S.method !== 'debt';
    const change = S.paid - t.total;
    $('#t-change').textContent = rp(cash && change > 0 ? change : 0);
    const quick = [t.total, Math.ceil(t.total / 10000) * 10000, Math.ceil(t.total / 50000) * 50000, Math.ceil(t.total / 100000) * 100000];
    $('#cash-quick').innerHTML = t.total > 0 ? Array.from(new Set(quick)).map((v, i) =>
      '<button type="button" class="btn-secondary" data-quick="' + v + '">' + (i === 0 ? 'Uang pas' : rp(v)) + '</button>').join('') : '';
    $$('#pay-methods [data-method]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.method === S.method)));
    const problem = cartProblem(t);
    const hint = $('#pay-hint');
    hint.textContent = problem || (S.payUncertain
      ? 'Koneksi terputus saat membayar, jadi status transaksi belum pasti. Ketuk Coba bayar lagi. Transaksi tidak akan tercatat dua kali.' : '');
    // Red only when something blocks payment; the empty cart is just a prompt.
    const blocking = (problem && S.cart.length) || (!problem && S.payUncertain);
    hint.classList.toggle('text-danger', !!blocking);
    hint.classList.toggle('text-muted', !blocking);
    $('#pay-btn').disabled = S.paying || !!problem;
    $('#pay-btn').textContent = S.paying ? 'Memproses…' : S.payUncertain ? 'Coba bayar lagi' : 'Bayar' + (t.total ? ' ' + rp(t.total) : '');
  }

  function newRef() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // After a sale is recorded (on the server or on this device): a fresh cart.
  function resetCheckout() {
    cartChanged();
    S.cart = []; S.paid = 0; $('#cash-paid').value = '';
    S.discType = 'none'; S.discValue = 0; $('#disc-type').value = 'none'; $('#disc-value').value = ''; $('#disc-value').disabled = true;
    S.customerName = ''; S.customerPhone = ''; $('#debt-name').value = ''; $('#debt-phone').value = '';
  }

  // Offline: the sale goes into this device's queue, under the same
  // reference an interrupted attempt already used, and its receipt is shown
  // at once. Nothing is shown as saved unless the queue really holds it.
  function saveOffline(body, t) {
    const ref = body.clientRef;
    const occurredAt = now().toISOString();
    const st = S.store || {};
    const item = {
      clientRef: ref, storeId: S.activeStoreId, occurredAt, state: 'pending', error: '',
      body: Object.assign({}, body, { offline: true, occurredAt }),
      local: {
        pending: true,
        store: { name: st.name, address: st.address, phone: st.phone, logoUrl: st.logoUrl },
        sale: {
          id: null, invoiceNo: offRef(ref), createdAt: occurredAt, cashier: (me && me.username) || '',
          subtotal: t.subtotal, discountType: S.discType, discountValue: S.discValue, discountAmount: t.discount,
          taxPercent: S.taxPct, taxAmount: t.tax, total: t.total, paymentMethod: S.method,
          paid: body.paid, change: S.method === 'cash' ? body.paid - t.total : 0,
          customerName: body.customerName, customerPhone: body.customerPhone, debtPaidAt: null,
        },
        items: S.cart.map((l) => ({ name: l.name, sku: l.sku, qty: l.qty, listPrice: l.listPrice, price: l.price })),
      },
    };
    const list = readOutbox();
    if (!list.some((x) => x.clientRef === ref)) list.push(item);
    if (!writeOutbox(list)) {
      toast('Transaksi gagal disimpan di perangkat ini. Tunggu sampai online untuk membayar.');
      updateTotals();
      return;
    }
    resetCheckout();
    applyPending(); reconcileCart();
    renderCart(); renderPos(); renderOffline();
    toast('Tersimpan offline. Akan dikirim otomatis saat online.');
    openReceipt(item.local);
  }

  async function checkout() {
    const t = calc();
    if (S.paying || cartProblem(t)) return;
    // Kept across a failed attempt whose outcome is unknown, so the retry is
    // recognised by the server and never records the sale twice.
    S.checkoutRef = S.checkoutRef || newRef();
    const debt = S.method === 'debt';
    const body = {
      items: S.cart.map((l) => ({ productId: l.id, qty: l.qty, price: l.price })),
      discountType: S.discType, discountValue: S.discValue, taxPercent: S.taxPct,
      paymentMethod: S.method, paid: S.method === 'cash' ? S.paid : debt ? 0 : t.total, clientRef: S.checkoutRef,
      customerName: debt ? S.customerName.trim() : '', customerPhone: debt ? S.customerPhone.trim() : '',
    };
    if (S.offline && canQueue()) { saveOffline(body, t); return; }
    S.paying = true; updateTotals();
    try {
      const { sale } = await api('/api/sales', { method: 'POST', body });
      resetCheckout();
      S.paying = false;
      // The first sale completes the checklist: the next render sees hasSales
      // and hides "Langkah awal" for this store for good.
      if (S.store) S.store.hasSales = true;
      renderCart(); loadProducts(); loadMovements();
      if (S.report) loadReport();
      toast('Transaksi ' + sale.invoiceNo + ' berhasil');
      showReceipt(sale.id);
    } catch (e) {
      S.paying = false;
      // The connection dropped: queue it offline under the same reference, so
      // if it did reach the server the sync is answered with that sale.
      if (!e.status && canQueue()) { saveOffline(body, t); return; }
      if (!e.status || e.status >= 500) {
        // The sale may or may not have been recorded: keep the reference.
        S.payUncertain = true; updateTotals();
        toast('Status transaksi belum pasti');
        return;
      }
      cartChanged(); updateTotals();
      toast(e.message);
      if (e.status === 409 || e.status === 404) loadProducts();
    }
  }

  // ── Stok gudang ──
  function stockBadge(p) {
    if (p.out) return '<span class="badge text-danger">Habis</span>';
    if (p.low) return '<span class="badge text-danger">Stok menipis</span>';
    return '<span class="badge text-muted">Aman</span>';
  }
  function renderStockList() {
    const box = $('#stock-list');
    const alertBox = $('#low-alert');
    if (S.offline) { box.innerHTML = offlineBox('Manajemen stok gudang'); alertBox.innerHTML = ''; return; }
    if (S.productsState === 'loading') { box.innerHTML = skeletonRows(5); alertBox.innerHTML = ''; return; }
    if (S.productsState === 'error') { box.innerHTML = errorBox('Daftar produk', 'products'); alertBox.innerHTML = ''; return; }
    const low = S.products.filter((p) => p.low || p.out);
    alertBox.innerHTML = low.length
      ? '<div class="rounded-xl border border-line bg-surface p-4" role="status"><p class="text-body font-medium text-danger">' + low.length + ' produk perlu restock</p>'
        + '<p class="text-small text-muted">' + low.map((p) => esc(p.name) + ' (sisa ' + p.stock + ', minimum ' + p.minStock + ')').join(', ') + '</p></div>'
      : '';
    if (!S.products.length) {
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Belum ada produk di gudang</p><p class="text-body text-muted">Tambahkan produk pertama Anda dengan harga modal, harga jual dan stok awal.</p>'
        + '<button type="button" class="btn-primary" data-new-product>Tambah produk</button></div>';
      return;
    }
    const q = S.stockQ.trim().toLowerCase();
    const list = S.products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
    if (!list.length) { box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Produk tidak ditemukan</p><p class="text-body text-muted">Coba kata kunci lain.</p></div>'; return; }
    box.innerHTML = '<div class="overflow-x-auto rounded-xl border border-line bg-surface"><table class="w-full min-w-[44rem]">'
      + '<thead class="border-b border-line"><tr><th class="th">Produk</th><th class="th">Kategori</th><th class="th text-right">Harga modal</th><th class="th text-right">Harga jual</th><th class="th text-right">Stok</th><th class="th"><span class="sr-only">Aksi</span></th></tr></thead>'
      + '<tbody class="divide-y divide-line">' + list.map((p) =>
        '<tr><td class="td"><p class="font-medium">' + esc(p.name) + '</p><p class="text-small text-muted">' + esc(p.sku) + '</p></td>'
        + '<td class="td text-muted">' + esc(p.category) + '</td>'
        + '<td class="td text-right">' + rp(p.costPrice) + '</td><td class="td text-right">' + rp(p.sellPrice) + '</td>'
        + '<td class="td text-right"><p class="font-medium">' + p.stock + '</p>' + stockBadge(p) + '</td>'
        + '<td class="td"><div class="flex justify-end gap-2"><button type="button" class="btn-secondary" data-adjust="' + p.id + '" aria-label="Sesuaikan stok ' + esc(p.name) + '">Sesuaikan stok</button>'
        + '<button type="button" class="btn-secondary" data-edit="' + p.id + '" aria-label="Ubah ' + esc(p.name) + '">Ubah</button></div></td></tr>').join('')
      + '</tbody></table></div>';
  }
  function renderMovements() {
    const box = $('#movement-list');
    if (S.offline) { box.innerHTML = ''; return; }
    if (S.movementsState === 'loading') { box.innerHTML = skeletonRows(3); return; }
    if (S.movementsState === 'error') { box.innerHTML = errorBox('Riwayat stok', 'movements'); return; }
    if (!S.movements.length) { box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-body text-muted">Belum ada pergerakan stok. Restock atau penjualan akan tercatat di sini.</p></div>'; return; }
    box.innerHTML = '<ul class="list">' + S.movements.map((m) =>
      '<li class="list-row"><div class="min-w-0 grow"><p class="text-body font-medium">' + esc(m.product) + '</p>'
      + '<p class="text-small text-muted">' + MOVES[m.type] + (m.ref ? ' · ' + esc(m.ref) : '') + (m.note ? ' · ' + esc(m.note) : '') + ' · ' + fmtDateTime(m.createdAt) + '</p></div>'
      + '<div class="text-right"><p class="text-body font-medium">' + (m.qtyChange > 0 ? '+' : '') + m.qtyChange + '</p><p class="text-small text-muted">stok ' + m.stockAfter + '</p></div></li>').join('') + '</ul>';
  }

  // Dialog helpers
  function openDlg(el) { $('[data-err]', el) && ($('[data-err]', el).textContent = ''); el.showModal(); }
  function setErr(el, msg) { $('[data-err]', el).textContent = msg; }
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  let editingId = null;
  function openProduct(id) {
    const p = id ? S.products.find((x) => x.id === id) : null;
    editingId = p ? p.id : null;
    $('#product-title').textContent = p ? 'Ubah produk' : 'Tambah produk';
    $('#p-name').value = p ? p.name : ''; $('#p-sku').value = p ? p.sku : ''; $('#p-cat').value = p ? p.category : '';
    $('#p-cost').value = p ? p.costPrice : ''; $('#p-sell').value = p ? p.sellPrice : '';
    $('#p-min').value = p ? p.minStock : 5; $('#p-stock').value = '0';
    $('#p-stock-wrap').hidden = !!p;
    const del = $('#p-delete'); del.hidden = !p; del.textContent = 'Hapus produk';
    openDlg($('#dlg-product'));
  }
  $('#form-product').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#p-name').value.trim(); const sku = $('#p-sku').value.trim();
    if (!name || !sku) return setErr($('#dlg-product'), 'Nama produk dan SKU / barcode wajib diisi.');
    const body = { name, sku, category: $('#p-cat').value.trim(), costPrice: digits($('#p-cost').value), sellPrice: digits($('#p-sell').value), minStock: digits($('#p-min').value), stock: digits($('#p-stock').value) };
    try {
      await api(editingId ? '/api/products/' + editingId : '/api/products', { method: editingId ? 'PUT' : 'POST', body });
      $('#dlg-product').close();
      toast(editingId ? 'Produk diperbarui' : 'Produk ditambahkan');
      loadProducts(); loadMovements();
    } catch (err) { setErr($('#dlg-product'), err.message); }
  });
  $('#p-delete').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (b.textContent !== 'Yakin hapus?') { b.textContent = 'Yakin hapus?'; return; }
    try {
      await api('/api/products/' + editingId, { method: 'DELETE' });
      S.cart = S.cart.filter((l) => l.id !== editingId); cartChanged();
      $('#dlg-product').close(); toast('Produk dihapus'); renderCart(); loadProducts();
    } catch (err) { setErr($('#dlg-product'), err.message); }
  });

  let adjustId = null;
  function adjustPreview() {
    const p = S.products.find((x) => x.id === adjustId); if (!p) return;
    const type = $('#a-type').value; const raw = $('#a-qty').value;
    $('#a-qty-label').textContent = type === 'opname' ? 'Jumlah stok fisik hasil hitung' : type === 'return' ? 'Jumlah yang diretur' : 'Jumlah barang masuk';
    if (raw.trim() === '') { $('#a-preview').textContent = 'Stok saat ini ' + p.stock + '.'; return; }
    const q = digits(raw);
    const after = type === 'restock' ? p.stock + q : type === 'return' ? p.stock - q : q;
    $('#a-preview').textContent = 'Stok saat ini ' + p.stock + ', menjadi ' + after + '.';
  }
  function openAdjust(id) {
    const p = S.products.find((x) => x.id === id); if (!p) return;
    adjustId = id;
    $('#a-product').textContent = p.name + ' (' + p.sku + ')';
    $('#a-type').value = 'restock'; $('#a-qty').value = ''; $('#a-note').value = '';
    adjustPreview(); openDlg($('#dlg-adjust'));
  }
  $('#a-type').addEventListener('change', adjustPreview);
  $('#a-qty').addEventListener('input', adjustPreview);
  $('#form-adjust').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = $('#a-type').value;
    if ($('#a-qty').value.trim() === '') return setErr($('#dlg-adjust'), 'Isi jumlahnya dulu.');
    try {
      await api('/api/products/' + adjustId + '/adjust', { method: 'POST', body: { type, qty: digits($('#a-qty').value), note: $('#a-note').value.trim() } });
      $('#dlg-adjust').close(); toast('Stok diperbarui'); loadProducts(); loadMovements();
    } catch (err) { setErr($('#dlg-adjust'), err.message); }
  });

  // ── Profil toko (active store) ──
  let logoDraft = '';
  function renderLogoDraft() {
    $('#s-logo-preview').innerHTML = logoDraft
      ? '<img src="' + esc(logoDraft) + '" alt="Logo toko" class="h-12 w-12 rounded-lg object-cover">' : logoSvg('h-12 w-12');
    $('#s-logo-remove').hidden = !logoDraft;
  }
  function openStoreProfile() {
    const s = S.store || {};
    $('#s-name').value = s.name || ''; $('#s-address').value = s.address || ''; $('#s-phone').value = s.phone || '';
    $('#s-tax').value = s.taxPercent != null ? s.taxPercent : 11; logoDraft = s.logoUrl || '';
    renderLogoDraft(); openDlg($('#dlg-store'));
  }
  $('#open-store').addEventListener('click', openStoreProfile);
  $('#open-store-profile').addEventListener('click', () => { if ($('#dlg-stores').open) $('#dlg-stores').close(); openStoreProfile(); });
  $('#s-logo-remove').addEventListener('click', () => { logoDraft = ''; renderLogoDraft(); });
  $('#s-logo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!window.usernode || !usernode.uploadFile) return setErr($('#dlg-store'), 'Unggah logo hanya tersedia di dalam Homeroom.');
    try {
      const stored = await usernode.uploadFile(file, { visibility: 'public' });
      logoDraft = stored.url; renderLogoDraft(); setErr($('#dlg-store'), '');
    } catch (err) { setErr($('#dlg-store'), 'Logo gagal diunggah: ' + ((err && err.message) || 'coba gambar PNG atau JPEG di bawah 5 MB') + '.'); }
  });
  $('#form-store').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#s-name').value.trim();
    if (!name) return setErr($('#dlg-store'), 'Nama toko wajib diisi.');
    try {
      const saved = await api('/api/store', { method: 'PUT', body: { name, address: $('#s-address').value.trim(), phone: $('#s-phone').value.trim(), logoUrl: logoDraft, taxPercent: dec($('#s-tax').value) } });
      // The PUT response carries no hasSales; keep the loaded one so the
      // checklist state survives editing the profile.
      S.store = Object.assign({}, S.store, saved);
      S.taxPct = S.store.taxPercent; $('#tax-pct').value = String(S.taxPct);
      const idx = S.stores.findIndex((s) => s.id === S.store.id);
      if (idx >= 0) S.stores[idx] = Object.assign({}, S.stores[idx], S.store);
      renderBrand(); updateTotals(); $('#dlg-store').close(); toast('Profil toko disimpan');
    } catch (err) { setErr($('#dlg-store'), err.message); }
  });

  // ── Tambah toko ──
  function openNewStore() {
    $('#n-name').value = ''; $('#n-address').value = ''; $('#n-phone').value = ''; $('#n-tax').value = 11;
    if ($('#dlg-stores').open) $('#dlg-stores').close();
    openDlg($('#dlg-new-store'));
  }
  // Shared by the "Tambah toko" dialog and the gate card's inline form:
  // everything that happens once POST /api/stores has answered.
  async function afterStoreCreated(created) {
    S.stores.push(created);
    S.activeStoreId = created.id; saveStore(created.id);
    S.cart = []; S.cat = 'Semua'; S.q = ''; cartChanged();
    renderShell();
    toast('Toko ' + created.name + ' dibuat');
    await loadStore(); loadProducts(); loadMovements();
  }
  $('#form-new-store').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#n-name').value.trim();
    if (!name) return setErr($('#dlg-new-store'), 'Nama toko wajib diisi.');
    try {
      const created = await api('/api/stores', { method: 'POST', body: { name, address: $('#n-address').value.trim(), phone: $('#n-phone').value.trim(), taxPercent: dec($('#n-tax').value) } });
      $('#dlg-new-store').close();
      await afterStoreCreated(created);
    } catch (err) { setErr($('#dlg-new-store'), err.message); }
  });
  // The gate card's inline "first store" form: name only, the rest filled
  // later in "Profil toko" (PPN starts at the default 11).
  $('#form-gate-store').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = $('#g-name').value.trim();
    if (!name) return setErr(form, 'Nama toko wajib diisi.');
    setErr(form, '');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const created = await api('/api/stores', { method: 'POST', body: { name, address: '', phone: '', taxPercent: 11 } });
      $('#g-name').value = '';
      await afterStoreCreated(created);
    } catch (err) { setErr(form, err.message); }
    finally { btn.disabled = false; }
  });

  // ── Struk ──
  function receiptHtml(r) {
    const s = r.store || S.store || {}; const x = r.sale;
    const row = (a, b, strong) => '<div class="flex justify-between gap-3' + (strong ? ' font-bold' : '') + '"><span>' + a + '</span><span class="shrink-0">' + b + '</span></div>';
    const rule = '<div class="my-2 border-t border-dashed border-line"></div>';
    return '<div class="mx-auto w-full max-w-xs bg-surface font-mono text-small text-fg">'
      + '<div class="flex flex-col items-center gap-1 text-center">' + storeLogo('h-12 w-12')
      + '<p class="text-body font-bold">' + esc(s.name || 'KasirKU') + '</p>'
      + (s.address ? '<p>' + esc(s.address) + '</p>' : '') + (s.phone ? '<p>Telp. ' + esc(s.phone) + '</p>' : '')
      + (r.pending ? '<p><span class="badge">Belum tersinkron</span></p>' : '') + '</div>' + rule
      + (r.pending ? row('No. sementara', esc(x.invoiceNo)) : row('No. invoice', esc(x.invoiceNo)))
      + (x.recordedOffline && x.clientRef ? row('Dicatat offline', esc(offRef(x.clientRef))) : '')
      + row('Tanggal', fmtDateTime(x.createdAt)) + (x.cashier ? row('Kasir', esc(x.cashier)) : '') + rule
      + r.items.map((i) => '<div class="mb-1"><p>' + esc(i.name) + '</p>'
        + row(i.qty + ' x ' + rp(i.price) + (i.price !== i.listPrice ? ' *' : ''), rp(i.qty * i.price))
        + '</div>').join('')
      + (r.items.some((i) => i.price !== i.listPrice) ? '<p class="text-muted">* harga disesuaikan</p>' : '') + rule
      + row('Subtotal', rp(x.subtotal))
      + (x.discountAmount ? row('Diskon' + (x.discountType === 'percent' ? ' (' + x.discountValue + '%)' : ''), '-' + rp(x.discountAmount)) : '')
      + row('PPN (' + x.taxPercent + '%)', rp(x.taxAmount)) + row('TOTAL', rp(x.total), true) + rule
      + row('Pembayaran', METHODS[x.paymentMethod])
      + (x.paymentMethod === 'cash' ? row('Tunai', rp(x.paid)) + row('Kembalian', rp(x.change))
        : x.paymentMethod === 'debt' ? row('Pelanggan', esc(x.customerName)) + row('Sisa utang', rp(x.debtPaidAt ? 0 : x.total))
          + (x.debtPaidAt ? row('Lunas', fmtDateTime(x.debtPaidAt) + ' · ' + (METHODS[x.debtPaidMethod] || '')) : '')
        : row('Dibayar', rp(x.paid))) + rule
      + '<p class="text-center">Terima kasih telah berbelanja</p><p class="text-center text-muted">Struk dibuat dengan KasirKU</p></div>';
  }
  function openReceipt(r) {
    S.receipt = r;
    $('#receipt-view').innerHTML = receiptHtml(r);
    $('#receipt-wa').value = r.sale.customerPhone || '';
    $('#receipt-wa-err').textContent = '';
    if (!$('#dlg-receipt').open) $('#dlg-receipt').showModal();
  }
  async function showReceipt(id) {
    try {
      openReceipt(await api('/api/sales/' + id));
    } catch (e) { toast('Struk gagal dimuat: ' + e.message); }
  }
  // The receipt as a chat message: WhatsApp shows *…* in bold. Lines that do
  // not apply are null and dropped; '' is a blank line between sections.
  function receiptText(r) {
    const s = r.store || S.store || {}; const x = r.sale;
    const name = s.name || 'KasirKU';
    const lines = [
      '*' + name + '*', s.address || null, '',
      (r.pending ? 'No. sementara: ' : 'Invoice: ') + x.invoiceNo,
      x.recordedOffline && x.clientRef ? 'Dicatat offline: ' + offRef(x.clientRef) : null,
      'Tanggal: ' + fmtDateTime(x.createdAt), '',
    ].concat(r.items.map((i) => i.name + ' ' + i.qty + ' x ' + rp(i.price) + ' = ' + rp(i.qty * i.price)))
      .concat([
        '', 'Subtotal: ' + rp(x.subtotal),
        x.discountAmount ? 'Diskon: -' + rp(x.discountAmount) : null,
        'PPN (' + x.taxPercent + '%): ' + rp(x.taxAmount),
        '*TOTAL: ' + rp(x.total) + '*',
        'Pembayaran: ' + METHODS[x.paymentMethod],
        x.paymentMethod === 'cash' ? 'Tunai: ' + rp(x.paid) + ', kembalian: ' + rp(x.change) : null,
        x.paymentMethod === 'debt' ? 'Pelanggan: ' + x.customerName : null,
        x.paymentMethod === 'debt' ? 'Sisa utang: ' + rp(x.debtPaidAt ? 0 : x.total) : null,
        '', 'Terima kasih telah berbelanja di ' + name,
        s.phone ? 'Telp. ' + s.phone : null,
      ]);
    return lines.filter((l) => l != null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  $('#receipt-print').addEventListener('click', () => {
    if (!S.receipt) return;
    $('#print-area').innerHTML = receiptHtml(S.receipt);
    window.print();
  });
  // Opens WhatsApp with the receipt typed in, to the customer when a number
  // is given. Runs inside the tap, so the new window is allowed; if the frame
  // still refuses it, the text is copied for pasting instead.
  $('#receipt-wa-send').addEventListener('click', async () => {
    if (!S.receipt) return;
    const num = waNumber($('#receipt-wa').value);
    if (num === null) { $('#receipt-wa-err').textContent = 'Nomor WhatsApp tidak valid'; return; }
    $('#receipt-wa-err').textContent = '';
    const text = receiptText(S.receipt);
    const url = 'https://wa.me/' + num + '?text=' + encodeURIComponent(text);
    let opened = null;
    try { opened = window.open(url, '_blank'); } catch (_) { opened = null; }
    if (opened) { try { opened.opener = null; } catch (_) { /* cross-origin already */ } }
    else {
      try { await navigator.clipboard.writeText(text); toast('Teks struk disalin, tempel di WhatsApp'); } catch (_) { toast('WhatsApp tidak bisa dibuka dari sini'); }
    }
  });
  $('#receipt-share').addEventListener('click', async () => {
    if (!S.receipt) return;
    const text = receiptText(S.receipt);
    try {
      if (navigator.share) { await navigator.share({ title: 'Struk ' + S.receipt.sale.invoiceNo, text }); return; }
      await navigator.clipboard.writeText(text); toast('Teks struk disalin');
    } catch (e) { if (e && e.name !== 'AbortError') toast('Struk tidak bisa dibagikan dari sini'); }
  });

  // ── Laporan ──
  function renderReportPeriod() {
    $$('#report-mode [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === S.reportMode)));
    $('#report-date-wrap').hidden = S.reportMode !== 'daily';
    $('#report-month-wrap').hidden = S.reportMode !== 'monthly';
  }
  function renderReport() {
    const box = $('#report-body');
    if (S.offline) { box.innerHTML = offlineBox('Laporan penjualan'); return; }
    if (S.reportState === 'loading') { box.innerHTML = skeletonRows(4); return; }
    if (S.reportState === 'error') { box.innerHTML = errorBox('Laporan penjualan', 'report'); return; }
    if (!S.report) { box.innerHTML = ''; return; }
    const r = S.report; const m = r.summary;
    const monthly = r.mode === 'monthly';
    // Sales still in this device's queue are not on the server yet.
    const queued = readOutbox().filter((x) => x.storeId === S.activeStoreId).length;
    const queuedNote = queued ? '<p class="rounded-xl border border-line bg-surface px-4 py-3 text-body" role="status">'
      + queued + ' transaksi offline belum masuk laporan</p>' : '';
    const rowTime = (x) => (monthly ? fmtDateTime(x.createdAt) : fmtTime(x.createdAt));
    const stat = (label, value, note) => '<div class="flex flex-col gap-1 p-4"><dt class="text-small text-muted">' + label + '</dt><dd class="text-heading">' + value + '</dd>'
      + (note ? '<dd class="text-small text-muted">' + note + '</dd>' : '') + '</div>';
    const margin = m.revenue ? Math.round(m.grossProfit / m.revenue * 100) : 0;
    let html = queuedNote + '<dl class="grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface lg:grid-cols-4 lg:divide-y-0">'
      + stat('Omzet', rp(m.revenue), 'Penjualan setelah diskon, sebelum PPN')
      + stat('HPP (harga pokok penjualan)', rp(m.cogs), 'Total harga modal barang terjual')
      + stat('Estimasi laba kotor', rp(m.grossProfit), m.revenue ? 'Margin ' + margin + '%' : 'Omzet dikurangi HPP')
      + stat('Transaksi', String(m.count), 'PPN terkumpul ' + rp(m.tax)) + '</dl>';
    if (!m.count) {
      html += '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">'
        + (monthly ? 'Belum ada transaksi pada bulan ini' : 'Belum ada transaksi pada tanggal ini') + '</p>'
        + '<p class="text-body text-muted">Transaksi dari menu Kasir akan muncul di sini.</p><button type="button" class="btn-primary" data-goto="kasir">Buka kasir</button></div>';
      box.innerHTML = html; return;
    }
    html += '<div><h3 class="section-label">Per metode pembayaran</h3><ul class="list">' + r.byMethod.map((x) =>
      '<li class="list-row"><span class="grow text-body">' + METHODS[x.method] + '</span><span class="text-small text-muted">' + x.count + ' transaksi</span><span class="w-32 text-right text-body font-medium">' + rp(x.total) + '</span></li>').join('') + '</ul></div>';
    html += '<div><h3 class="section-label">Riwayat transaksi</h3><ul class="list">' + r.sales.map((x) =>
      '<li><button type="button" data-receipt="' + x.id + '" class="list-row w-full text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">'
      + '<div class="min-w-0 grow"><p class="text-body font-medium">' + esc(x.invoiceNo) + '</p><p class="text-small text-muted">' + rowTime(x) + ' · ' + METHODS[x.paymentMethod]
      + (x.paymentMethod === 'debt' && x.customerName ? ' · ' + esc(x.customerName) : '')
      + (x.recordedOffline ? ' · Dicatat offline' : '') + '</p></div>'
      + '<div class="text-right"><p class="text-body font-medium">' + rp(x.total) + '</p><p class="text-small text-muted">Laba ' + rp(x.subtotal - x.discountAmount - x.cogs) + '</p></div></button></li>').join('') + '</ul></div>';
    box.innerHTML = html;
  }

  // ── Utang belum lunas ──
  function renderDebts() {
    const box = $('#debts-body');
    if (!hasStore() || S.offline) { box.innerHTML = ''; return; }
    const head = (right) => '<h3 class="section-label flex justify-between gap-3"><span>Utang belum lunas</span>' + (right ? '<span>' + right + '</span>' : '') + '</h3>';
    if (S.debtsState === 'loading') { box.innerHTML = head('') + skeletonRows(2); return; }
    if (S.debtsState === 'error') { box.innerHTML = head('') + errorBox('Daftar utang', 'debts'); return; }
    const d = S.debts || { debts: [], total: 0, count: 0 };
    if (!d.debts.length) {
      box.innerHTML = head('') + '<ul class="list"><li class="list-row text-body text-muted">Tidak ada utang yang belum lunas.</li></ul>';
      return;
    }
    box.innerHTML = head('Total ' + rp(d.total)) + '<ul class="list">' + d.debts.map((x) =>
      '<li class="list-row"><button type="button" data-receipt="' + x.id + '" class="min-w-0 grow rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">'
      + '<p class="text-body font-medium">' + esc(x.customerName) + '</p>'
      + '<p class="text-small text-muted">' + esc(x.invoiceNo) + ' · ' + fmtDateTime(x.createdAt) + '</p></button>'
      + '<span class="shrink-0 text-body font-medium">' + rp(x.total) + '</span>'
      + '<button type="button" class="btn-secondary shrink-0" data-settle="' + x.id + '">Tandai lunas</button></li>').join('') + '</ul>';
  }
  function renderSettleMethods() {
    $$('#settle-methods [data-settle-method]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.settleMethod === S.settleMethod)));
  }
  function openSettle(id) {
    const x = ((S.debts && S.debts.debts) || []).find((d) => d.id === id);
    if (!x) return;
    S.settleId = id; S.settleMethod = 'cash'; renderSettleMethods();
    $('#settle-who').textContent = x.customerName + ' · ' + x.invoiceNo + ' · ' + rp(x.total);
    openDlg($('#dlg-settle'));
  }
  $('#form-settle').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/api/sales/' + S.settleId + '/settle', { method: 'POST', body: { method: S.settleMethod } });
      $('#dlg-settle').close(); toast('Utang ditandai lunas'); loadDebts();
    } catch (err) { setErr($('#dlg-settle'), err.message); }
    finally { btn.disabled = false; }
  });

  // ── Tabs ──
  function setTab(tab) {
    if (!['kasir', 'stok', 'laporan'].includes(tab)) tab = 'kasir';
    if (!hasStore()) tab = 'kasir';
    S.tab = tab;
    $$('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    ['kasir', 'stok', 'laporan'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
    if (tab === 'stok' && S.movementsState !== 'ok') loadMovements();
    if (tab === 'laporan') loadReport();
  }
  const goto = (t) => { location.hash = t; };
  window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));
  $$('[role=tab]').forEach((b) => b.addEventListener('click', () => goto(b.dataset.tab)));

  // ── Events ──
  $('#pos-search').addEventListener('input', (e) => { S.q = e.target.value; renderPos(); });
  $('#stock-search').addEventListener('input', (e) => { S.stockQ = e.target.value; renderStockList(); });
  $('#add-product').addEventListener('click', () => openProduct(null));
  $('#report-date').addEventListener('change', (e) => { if (e.target.value) { S.reportDate = e.target.value; loadReport(); } });
  $$('#report-mode [data-mode]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === S.reportMode) return;
    S.reportMode = b.dataset.mode; renderReportPeriod(); loadReport();
  }));
  $('#report-month').addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}$/.test(e.target.value) && e.target.value !== S.reportMonth) { S.reportMonth = e.target.value; loadReport(); }
  });
  $('#cart-clear').addEventListener('click', () => { S.cart = []; cartChanged(); renderCart(); renderPos(); });
  $('#pay-btn').addEventListener('click', checkout);
  $('#store-switch-btn').addEventListener('click', openStores);

  $('#disc-type').addEventListener('change', (e) => {
    S.discType = e.target.value; S.discValue = 0; cartChanged();
    const v = $('#disc-value'); v.value = ''; v.disabled = S.discType === 'none';
    v.placeholder = S.discType === 'percent' ? 'e.g. 10' : 'e.g. 5000';
    updateTotals();
  });
  $('#disc-value').addEventListener('input', (e) => { S.discValue = Math.max(0, dec(e.target.value)); cartChanged(); updateTotals(); });
  $('#tax-pct').addEventListener('input', (e) => { S.taxPct = Math.min(100, Math.max(0, dec(e.target.value))); cartChanged(); updateTotals(); });
  $('#cash-paid').addEventListener('input', (e) => { S.paid = digits(e.target.value); cartChanged(); updateTotals(); });
  $('#debt-name').addEventListener('input', (e) => { S.customerName = e.target.value; cartChanged(); updateTotals(); });
  $('#debt-phone').addEventListener('input', (e) => { S.customerPhone = e.target.value; cartChanged(); updateTotals(); });
  $('#offline-view').addEventListener('click', openOutbox);

  // Typing in a cart line only updates numbers, so the field keeps focus.
  $('#cart-lines').addEventListener('input', (e) => {
    const qtyId = e.target.dataset.qty; const priceId = e.target.dataset.price;
    const line = S.cart.find((l) => l.id === Number(qtyId || priceId));
    if (!line) return;
    if (qtyId) line.qty = Math.max(Math.min(digits(e.target.value), line.stock), 1);
    else line.price = digits(e.target.value);
    cartChanged(); updateTotals();
  });
  // Re-render on commit so a line's warning follows its new quantity or price.
  $('#cart-lines').addEventListener('change', () => { renderCart(); renderPos(); });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.add) addToCart(Number(d.add));
    else if (d.cat) { S.cat = d.cat; renderPos(); }
    else if (d.switch) setActiveStore(Number(d.switch));
    else if (d.remove) { S.cart = S.cart.filter((l) => l.id !== Number(d.remove)); cartChanged(); renderCart(); renderPos(); }
    else if (d.inc || d.dec) {
      const line = S.cart.find((l) => l.id === Number(d.inc || d.dec));
      if (!line) return;
      if (d.inc && line.qty >= line.stock) return toast('Stok ' + line.name + ' hanya ' + line.stock);
      line.qty = Math.max(1, line.qty + (d.inc ? 1 : -1)); cartChanged(); renderCart(); renderPos();
    }
    else if (d.method) { if (d.method !== S.method) cartChanged(); S.method = d.method; updateTotals(); }
    else if (d.quick) { S.paid = Number(d.quick); $('#cash-paid').value = String(S.paid); cartChanged(); updateTotals(); }
    else if (d.adjust) openAdjust(Number(d.adjust));
    else if (d.edit) openProduct(Number(d.edit));
    else if (t.hasAttribute('data-new-store')) openNewStore();
    else if (t.hasAttribute('data-new-product')) openProduct(null);
    else if (d.receipt) showReceipt(Number(d.receipt));
    else if (d.outboxReceipt) showLocalReceipt(d.outboxReceipt);
    else if (d.outboxDrop) {
      if (t.textContent !== 'Yakin hapus?') { t.textContent = 'Yakin hapus?'; return; }
      writeOutbox(readOutbox().filter((x) => x.clientRef !== d.outboxDrop));
      applyPending(); renderProducts(); renderOffline();
    }
    else if (d.settle) openSettle(Number(d.settle));
    else if (d.settleMethod) { S.settleMethod = d.settleMethod; renderSettleMethods(); }
    else if (d.goto) goto(d.goto);
    else if (d.retry) ({ products: loadProducts, movements: loadMovements, report: loadReport, stores: loadStores, debts: loadDebts, online: retryOnline })[d.retry]();
  });

  // ── Boot ──
  $('#report-date').value = S.reportDate;
  $('#report-month').value = S.reportMonth;
  renderReportPeriod();
  renderCart(); renderProducts(); renderShell();
  // "Coba lagi" while offline: one request decides; if it reaches the server
  // the reconnect reloads everything.
  async function retryOnline() {
    try { await api('/api/stores'); } catch (_) { toast('Masih offline'); }
  }
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => { retryOnline(); });
  window.addEventListener('usernode:visibility-changed', (e) => { if (e.detail && !e.detail.hidden) sync(); });
  // While anything waits to be sent, or the app thinks it is offline, check
  // again every 30 seconds (the browser's online event is not always sent).
  setInterval(() => {
    if (readOutbox().some((x) => x.state !== 'failed')) sync();
    else if (S.offline) api('/api/stores').catch(() => {});
  }, 30000);

  (async function boot() {
    const anyStore = await loadStores();
    registerWorker();
    if (!anyStore) { setTab('kasir'); renderBrand(); return; }
    setTab(location.hash.slice(1));
    await loadStore(); loadProducts(); loadMovements();
    if (S.tab === 'laporan') loadReport();
    sync();
  })();

  // The worker lets the app open with no connection. A frame that refuses
  // it (some WebViews) simply cannot open offline; nothing to work around.
  function registerWorker() {
    try {
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
      if (navigator.storage && navigator.storage.persist && !localStorage.getItem('kasirku-persist-asked')) {
        localStorage.setItem('kasirku-persist-asked', '1');
        navigator.storage.persist().catch(() => {});
      }
    } catch (_) { /* no worker: the platform shows its "needs a connection" note */ }
  }
})();
