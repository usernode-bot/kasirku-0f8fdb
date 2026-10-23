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
  const METHODS = { cash: 'Tunai', qris: 'QRIS', debit: 'Debit', transfer: 'Transfer bank', bri: 'Transfer BRI', credit: 'Bayar nanti' };
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
    if (S.activeStoreId) headers['x-usernode-store'] = String(S.activeStoreId);
    if (window.usernode && usernode.previewNow) headers['x-usernode-now'] = usernode.now().toISOString();
    let res;
    try {
      res = await fetch(path, { method: o.method || 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined });
    } catch (_) {
      const err = new Error('Koneksi terputus');
      err.status = 0;
      throw err;
    }
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
    customerName: '', customers: [],
    checkoutRef: null, payUncertain: false,
    movements: null, movementsState: 'loading', report: null, reportState: 'loading', reportDate: today(),
    today: null, todayState: 'loading',
    debts: null, debtsState: 'loading', debtRef: null, debtCustomerId: null,
    shifts: null, shiftsState: 'loading',
    insights: null, insightsState: 'loading',
    reportMode: 'daily', reportMonth: today().slice(0, 7),
    receipt: null,
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
      S.stores = (await api('/api/stores')).stores;
      S.storesState = 'ok';
    } catch (e) { S.storesState = 'error'; S.stores = []; }
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
      S.taxPct = S.store && S.store.taxEnabled ? S.store.taxPercent : 0;
      $('#tax-pct').value = String(S.taxPct);
      $('#staging-note').hidden = !(S.store && S.store.staging);
      renderBrand();
      renderPayMethods();
      renderCart();
      renderOnboarding();
    } catch (e) {
      S.store = S.store || { name: 'KasirKU', address: '', phone: '', logoUrl: '', qrisUrl: '',
        taxPercent: 11, taxEnabled: true, bankAccounts: [], paymentMethods: { cash: true, qris: true, debit: true, transfer: true } };
      renderBrand(); renderOnboarding();
    }
  }
  async function loadProducts() {
    loadInsights();
    if (!hasStore()) { S.products = []; S.productsState = 'ok'; renderProducts(); return; }
    S.productsState = 'loading'; renderProducts();
    try {
      S.products = (await api('/api/products')).products;
      S.productsState = 'ok';
      reconcileCart();
    } catch (e) { S.productsState = 'error'; }
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
  }
  // Names for the checkout datalist, so a returning customer stays one person.
  async function loadCustomers() {
    if (!hasStore()) { S.customers = []; fillCustomerList(); return; }
    try { S.customers = (await api('/api/customers')).customers; } catch (e) { S.customers = []; }
    fillCustomerList();
  }
  function fillCustomerList() {
    $('#customer-list').innerHTML = S.customers.map((c) => '<option value="' + esc(c.name) + '"></option>').join('');
  }
  // The Piutang pelanggan list: what each customer of the active store still
  // owes today. It does not follow the report date picker.
  async function loadDebts() {
    if (!hasStore()) { S.debts = null; S.debtsState = 'ok'; renderDebts(); return; }
    S.debtsState = 'loading'; renderDebts();
    try { S.debts = await api('/api/debts'); S.debtsState = 'ok'; } catch (e) { S.debtsState = 'error'; }
    renderDebts();
  }
  // The Tutup shift bar at the top of the Laporan tab: today's cash from Tunai
  // sales, today's closing if there is one, and the latest closings. Like the
  // Piutang list it is always "today", never the report's date picker.
  async function loadShifts() {
    if (!hasStore()) { S.shifts = null; S.shiftsState = 'ok'; renderShifts(); return; }
    S.shiftsState = 'loading'; renderShifts();
    try { S.shifts = await api('/api/shifts'); S.shiftsState = 'ok'; } catch (e) { S.shiftsState = 'error'; }
    renderShifts();
  }
  // The "Penjualan hari ini" bar at the top of the Kasir tab: the same today's
  // omzet the daily report shows, refreshed after each sale and tab visit.
  async function loadToday() {
    if (!hasStore()) { S.today = null; S.todayState = 'ok'; renderToday(); return; }
    S.todayState = 'loading'; renderToday();
    try { S.today = await api('/api/sales/today'); S.todayState = 'ok'; } catch (e) { S.todayState = 'error'; }
    renderToday();
  }
  // The 7-day insight figures behind the Stok tab's warning and shopping list
  // and the Laporan tab's weekly summary. Like the Piutang list, they do not
  // follow the report date picker: the window is always the last 7 days.
  async function loadInsights() {
    if (!hasStore()) { S.insights = null; S.insightsState = 'ok'; renderStockList(); renderWeekly(); return; }
    S.insightsState = 'loading'; renderStockList(); renderWeekly();
    try { S.insights = await api('/api/insights'); S.insightsState = 'ok'; } catch (e) { S.insightsState = 'error'; }
    renderStockList(); renderWeekly();
  }

  // ── Shell: the no-store gate vs the tabs ──
  function renderShell() {
    const empty = !hasStore();
    $('#store-gate').hidden = !empty;
    $('#main-area').hidden = empty;
    // Locked tabs explain themselves: a small lock after the name plus the
    // same words as each tab's tooltip, and one muted hint line under the tab
    // bar saying what unlocks them (screen readers hear it as the tab bar's
    // description). All three wait for the store list to answer, so none
    // claims "no store" while the list is still loading or failed to load.
    const lock = empty && S.storesState === 'ok';
    $$('#main-tabs [role=tab]').forEach((b) => {
      b.disabled = empty;
      if (lock) { b.title = 'Buat toko dulu.'; }
      else { b.removeAttribute('title'); }
      const icon = b.querySelector('[data-tab-lock]');
      if (lock && !icon) b.insertAdjacentHTML('beforeend', TAB_LOCK_SVG);
      if (!lock && icon) icon.remove();
    });
    $('#tabs-lock-hint').hidden = !lock;
    if (lock) { $('#main-tabs').setAttribute('aria-describedby', 'tabs-lock-hint'); }
    else { $('#main-tabs').removeAttribute('aria-describedby'); }
    renderGate();
    renderBrand();
    renderOnboarding();
  }

  // The gate itself has three looks: skeleton rows while the store list is
  // still in flight, the error box when that request failed, and the Buat
  // toko form with Langkah awal only after a successful answer that found
  // no stores. A failed list must never read as "you have no store".
  function renderGate() {
    const card = $('#gate-card');
    const status = $('#gate-status');
    const steps = $('#gate-steps');
    const pending = !hasStore() && S.storesState !== 'ok';
    if (pending) {
      card.hidden = true;
      steps.innerHTML = ''; steps.hidden = true;
      status.hidden = false;
      status.innerHTML = S.storesState === 'error'
        ? errorBox('Daftar toko', 'stores')
        : '<div class="skeleton h-72"></div><div class="mt-5">' + skeletonRows(3) + '</div>';
    } else {
      status.hidden = true; status.innerHTML = '';
      card.hidden = false;
      steps.hidden = false;
    }
  }

  // ── Shared state blocks ──
  const skeletonRows = (n) => '<div class="flex flex-col gap-2">' + Array.from({ length: n }, () => '<div class="skeleton h-14"></div>').join('') + '</div>';
  const errorBox = (what, retry) => '<div class="state-error rounded-xl border border-line bg-surface" role="alert"><p class="text-heading">' + esc(what) + ' gagal dimuat</p>'
    + '<p class="text-body text-muted">Data lain di layar ini tetap bisa dipakai. Periksa koneksi, lalu coba lagi.</p>'
    + '<button type="button" class="btn-secondary" data-retry="' + retry + '">Coba lagi</button></div>';

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
      // While the store list is in flight or failed, renderGate shows
      // skeletons or the error box instead of the starter steps.
      if (S.storesState !== 'ok') { gateBox.innerHTML = ''; kasirBox.hidden = true; return; }
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
    // A customer on a not-yet-recorded credit sale belongs to the old store too.
    S.customerName = ''; $('#credit-name').value = '';
    S.debts = null; S.insights = null;
    S.shifts = null;
    S.today = null;
    cartChanged();
    renderShell(); $('#dlg-stores').close();
    toast('Toko aktif: ' + ((S.stores.find((s) => s.id === id) || {}).name || ''));
    await loadStore(); loadProducts(); loadMovements(); loadCustomers();
    if (S.tab === 'laporan') { loadReport(); loadDebts(); loadShifts(); }
    if (S.tab === 'kasir') loadToday();
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
      if (p.stock < 1) return toast('Stok ' + p.name + ' habis');
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
    if (S.method === 'credit') {
      if (!S.customerName.trim()) return 'Isi nama pelanggan dulu.';
      if (t.total < 1) return 'Total harus lebih dari Rp 0 untuk bayar nanti.';
    }
    return '';
  }

  // ── Payment methods: only the ones the store turned on are offered ──
  function renderPayMethods() {
    const m = (S.store && S.store.paymentMethods) || { cash: true, qris: true, debit: true, transfer: true };
    $$('#pay-methods [data-method]').forEach((b) => {
      b.hidden = b.dataset.method !== 'credit' && !m[b.dataset.method];
    });
    // If the chosen method was turned off, move to the first one that is on.
    const on = $$('#pay-methods [data-method]').filter((b) => !b.hidden).map((b) => b.dataset.method);
    if (!on.includes(S.method)) {
      const next = ['cash', 'qris', 'debit', 'transfer', 'credit'].find((k) => on.includes(k));
      if (next) { S.method = next; cartChanged(); }
    }
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
    // PPN off in Profil toko: no field, no line, and the sale is recorded at 0%.
    $$('[data-tax-ui]').forEach((el) => { el.hidden = S.taxPct <= 0; });
    S.cart.forEach((l) => { const el = $('[data-line-total="' + l.id + '"]'); if (el) el.textContent = rp(l.qty * l.price); });
    const cash = S.method === 'cash';
    $('#cash-box').hidden = !cash;
    // 'bri' is the old label for a bank transfer: an old tab still on it shows
    // the same Transfer bank pane.
    const transferPane = S.method === 'transfer' || S.method === 'bri';
    $('#transfer-box').hidden = !transferPane;
    if (transferPane) renderTransfer(t);
    $('#qris-box').hidden = S.method !== 'qris';
    if (S.method === 'qris') renderQris(t);
    $('#credit-box').hidden = S.method !== 'credit';
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
    const payLabel = S.method === 'credit' ? 'Catat piutang' : 'Bayar';
    $('#pay-btn').textContent = S.paying ? 'Memproses…' : S.payUncertain ? 'Coba bayar lagi' : payLabel + (t.total ? ' ' + rp(t.total) : '');
  }

  // ── Transfer bank: the store's accounts, shown while that method is chosen ──
  const briParts = (no) => no.replace(/(\d{4})(?=\d)/g, '$1 ');
  function renderTransfer(t) {
    const s = S.store || {};
    const accs = Array.isArray(s.bankAccounts) ? s.bankAccounts : [];
    const box = $('#transfer-details');
    if (!accs.length) {
      box.innerHTML = '<div class="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line p-3">'
        + '<p class="text-body font-medium">Rekening bank belum diisi</p>'
        + '<p class="text-small text-muted">Isi rekening bank di Profil toko supaya pembeli tahu ke mana harus transfer.</p>'
        + '<button type="button" class="btn-secondary" data-bank-setup>Isi rekening bank</button></div>';
      return;
    }
    box.innerHTML = '<dl class="divide-y divide-line border-y border-line">'
      + accs.map((a, i) =>
        '<div class="flex min-h-11 items-center gap-3 py-2"><dt class="grow min-w-0">'
        + '<p class="text-body font-medium">' + esc(a.bank) + '</p>'
        + '<p class="text-small text-muted">a.n. ' + esc(a.accountName) + '</p></dt>'
        + '<dd class="flex shrink-0 items-center gap-2">'
        + '<span class="whitespace-nowrap font-mono text-body font-medium">' + esc(briParts(a.accountNo)) + '</span>'
        + '<button type="button" class="btn-secondary" data-copy-acc="' + i + '" aria-label="Salin nomor rekening ' + esc(a.bank) + '">Salin</button></dd></div>').join('')
      + '<div class="flex min-h-11 items-center gap-3 py-2"><dt class="grow text-small text-muted">Jumlah transfer</dt>'
      + '<dd class="text-heading">' + rp(t.total) + '</dd></div>'
      + '</dl>';
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Older WebViews: fall back to a selected textarea.
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-only';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_e) {}
      ta.remove();
      return ok;
    }
  }
  async function copyAccountNo(i) {
    const accs = (S.store && S.store.bankAccounts) || [];
    const a = accs[i];
    if (!a) return;
    const ok = await copyText(a.accountNo);
    toast(ok ? 'Nomor rekening ' + a.bank + ' disalin' : 'Nomor rekening tidak bisa disalin dari sini');
  }
  function renderQris(t) {
    const s = S.store || {};
    const box = $('#qris-details');
    if (!s.qrisUrl) {
      box.innerHTML = '<div class="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line p-3">'
        + '<p class="text-body font-medium">QRIS toko belum diunggah</p>'
        + '<p class="text-small text-muted">Unggah kode QRIS toko di Profil toko supaya pembeli bisa memindainya.</p>'
        + '<button type="button" class="btn-secondary" data-qris-setup>Unggah QRIS toko</button></div>';
      return;
    }
    box.innerHTML = '<div class="flex flex-col items-center gap-2 pb-2">'
      + '<img src="' + esc(s.qrisUrl) + '" alt="QRIS toko" class="max-w-full rounded-lg border border-line bg-surface object-contain" style="width:15rem;height:15rem">'
      + '</div>'
      + '<dl class="divide-y divide-line border-y border-line">'
      + '<div class="flex min-h-11 items-center gap-3 py-2"><dt class="grow text-small text-muted">Jumlah bayar</dt>'
      + '<dd class="text-heading">' + rp(t.total) + '</dd></div></dl>';
  }

  function newRef() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  async function checkout() {
    const t = calc();
    if (S.paying || cartProblem(t)) return;
    // Kept across a failed attempt whose outcome is unknown, so the retry is
    // recognised by the server and never records the sale twice.
    S.checkoutRef = S.checkoutRef || newRef();
    S.paying = true; updateTotals();
    try {
      const { sale } = await api('/api/sales', { method: 'POST', body: {
        items: S.cart.map((l) => ({ productId: l.id, qty: l.qty, price: l.price })),
        discountType: S.discType, discountValue: S.discValue, taxPercent: S.taxPct,
        paymentMethod: S.method,
        paid: S.method === 'cash' ? S.paid : S.method === 'credit' ? 0 : t.total,
        customerName: S.method === 'credit' ? S.customerName.trim() : undefined,
        clientRef: S.checkoutRef,
      } });
      cartChanged();
      S.cart = []; S.paid = 0; $('#cash-paid').value = '';
      S.customerName = ''; $('#credit-name').value = '';
      S.discType = 'none'; S.discValue = 0; $('#disc-type').value = 'none'; $('#disc-value').value = ''; $('#disc-value').disabled = true;
      S.paying = false;
      // The first sale completes the checklist: the next render sees hasSales
      // and hides "Langkah awal" for this store for good.
      if (S.store) S.store.hasSales = true;
      renderCart(); loadProducts(); loadMovements();
      loadCustomers(); loadToday();
      if (S.report) loadReport();
      if (S.debts) loadDebts();
      if (S.shifts) loadShifts();
      toast('Transaksi ' + sale.invoiceNo + ' berhasil');
      showReceipt(sale.id);
    } catch (e) {
      S.paying = false;
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
    renderShopping();
    const box = $('#stock-list');
    const alertBox = $('#low-alert');
    if (S.productsState === 'loading') { box.innerHTML = skeletonRows(5); alertBox.innerHTML = ''; return; }
    if (S.productsState === 'error') { box.innerHTML = errorBox('Daftar produk', 'products'); alertBox.innerHTML = ''; return; }
    // The 7-day selling rate, only when the insights have loaded: while they
    // load or failed, the strip shows exactly today's minimum-based text.
    const rate = (p) => (S.insightsState === 'ok' && S.insights
      ? S.insights.rates.find((r) => r.productId === p.id) : null);
    const low = S.products.filter((p) => {
      const r = rate(p);
      return p.low || p.out || (r && p.stock < r.sold);
    });
    alertBox.innerHTML = low.length
      ? '<div class="rounded-xl border border-line bg-surface p-4" role="status"><p class="text-body font-medium text-danger">' + low.length + ' produk perlu restock</p>'
        + '<p class="text-small text-muted">' + low.map((p) => {
          const r = rate(p);
          if (r && p.stock > 0) {
            const left = r.daysLeft === 0 ? 'habis hari ini' : 'habis ± ' + r.daysLeft + ' hari lagi';
            return esc(p.name) + ' (sisa ' + p.stock + ', ' + left + ')';
          }
          return esc(p.name) + ' (sisa ' + p.stock + ', minimum ' + p.minStock + ')';
        }).join(', ') + '</p></div>'
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

  // ── Daftar belanja & Ringkasan 7 hari (from /api/insights) ──
  const fmtDay = (ymd) => new Date(ymd + 'T00:00:00+07:00')
    .toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' });
  const insightRange = (ins) => fmtDay(ins.from) + ' – ' + fmtDay(ins.to) + ' ' + ins.to.slice(0, 4);

  function renderShopping() {
    const box = $('#shopping-list');
    if (S.productsState !== 'ok' || !S.products.length) { box.innerHTML = ''; return; }
    if (S.insightsState === 'loading') { box.innerHTML = skeletonRows(2); return; }
    if (S.insightsState === 'error') { box.innerHTML = errorBox('Daftar belanja', 'insights'); return; }
    const ins = S.insights;
    if (!ins || !ins.shopping.length) {
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Belum ada yang perlu dibeli</p>'
        + '<p class="text-body text-muted">Daftar ini disusun dari penjualan 7 hari terakhir: barang yang akan habis dalam 7 hari muncul di sini.</p></div>';
      return;
    }
    box.innerHTML = '<div><h3 class="section-label flex justify-between"><span>Daftar belanja</span><span>Dari penjualan ' + insightRange(ins) + '</span></h3><ul class="list">'
      + ins.shopping.map((x) =>
        '<li class="list-row flex-wrap"><div class="min-w-0 grow"><p class="text-body font-medium">' + esc(x.name) + '</p>'
        + '<p class="text-small text-muted">Terjual ' + x.sold + ' dalam 7 hari · sisa ' + x.stock + ' · '
        + (x.stock === 0 ? 'habis' : x.daysLeft === 0 ? 'habis hari ini' : 'habis ± ' + x.daysLeft + ' hari lagi') + '</p></div>'
        + '<p class="shrink-0 text-body font-medium">Beli ' + x.suggest + '</p>'
        + '<button type="button" class="btn-secondary w-full shrink-0 sm:w-auto" data-restock="' + x.productId
        + '" data-qty="' + x.suggest + '" aria-label="Catat barang masuk ' + esc(x.name) + '">Catat barang masuk</button></li>').join('')
      + '</ul></div>';
  }

  function renderWeekly() {
    const box = $('#weekly-body');
    if (S.insightsState === 'loading') { box.innerHTML = skeletonRows(3); return; }
    if (S.insightsState === 'error') { box.innerHTML = errorBox('Ringkasan 7 hari', 'insights'); return; }
    if (!hasStore() || !S.insights) { box.innerHTML = ''; return; }
    const ins = S.insights;
    if (!ins.best.length) {
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Belum ada penjualan dalam 7 hari terakhir</p>'
        + '<p class="text-body text-muted">Barang paling laku dan yang mengendap akan muncul di sini.</p></div>';
      return;
    }
    const best = ins.best.map((x) =>
      '<li class="list-row"><div class="min-w-0 grow"><p class="text-body font-medium">' + esc(x.name) + '</p>'
      + '<p class="text-small text-muted">sisa ' + x.stock + '</p></div>'
      + '<p class="shrink-0 text-body font-medium">Terjual ' + x.sold + '</p></li>').join('');
    let stag = ins.stagnant.map((x) =>
      '<li class="list-row"><div class="min-w-0 grow"><p class="text-body font-medium">' + esc(x.name) + '</p>'
      + '<p class="text-small text-muted">stok ' + x.stock + '</p></div>'
      + '<div class="text-right"><p class="text-body font-medium">' + rp(x.stockValue) + '</p>'
      + '<p class="text-small text-muted">modal tertahan</p></div></li>').join('');
    if (ins.stagnantCount > 5) {
      stag += '<li class="list-row text-small text-muted">dan ' + (ins.stagnantCount - 5) + ' produk lain</li>';
    } else if (!ins.stagnant.length) {
      stag += '<li class="list-row text-small text-muted">Semua barang yang ada stoknya terjual dalam 7 hari ini.</li>';
    }
    box.innerHTML = '<div><h3 class="section-label flex justify-between"><span>Ringkasan 7 hari terakhir</span><span>' + insightRange(ins) + '</span></h3>'
      + '<div class="grid gap-5 lg:grid-cols-2">'
      + '<div><h4 class="section-label">Paling laku</h4><ul class="list">' + best + '</ul></div>'
      + '<div><h4 class="section-label">Mengendap (tidak terjual 7 hari)</h4><ul class="list">' + stag + '</ul></div>'
      + '</div></div>';
  }

  function renderMovements() {
    const box = $('#movement-list');
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
  function openAdjust(id, qty) {
    const p = S.products.find((x) => x.id === id); if (!p) return;
    adjustId = id;
    $('#a-product').textContent = p.name + ' (' + p.sku + ')';
    // qty is the shopping list's suggested amount, prefilled into Barang masuk.
    $('#a-type').value = 'restock'; $('#a-qty').value = qty ? String(qty) : ''; $('#a-note').value = '';
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
  // ── Rekening bank: up to 3 accounts at any bank ──
  const BANKS = ['BCA', 'BRI', 'Mandiri', 'BNI', 'BSI', 'SeaBank', 'Jago'];
  const emptyBankRow = () => ({ bank: '', other: '', no: '', name: '' });
  // A stored bank outside the seven loads as "Lainnya" with its name filled in.
  const toBankDraft = (a) => (BANKS.includes(a.bank)
    ? { bank: a.bank, other: '', no: a.accountNo, name: a.accountName }
    : { bank: 'Lainnya', other: a.bank, no: a.accountNo, name: a.accountName });
  let bankDraft = [];
  function renderBankRows() {
    $('#s-banks').innerHTML = bankDraft.map((r, i) =>
      '<div class="flex flex-col gap-2 rounded-lg border border-line p-3">'
      + '<p class="text-small font-medium">Rekening ' + (i + 1) + '</p>'
      + '<div><label class="section-label mb-1 block" for="s-bank-' + i + '-bank">Bank</label>'
      + '<select id="s-bank-' + i + '-bank" class="field" data-bank-i="' + i + '" data-bank-k="bank">'
      + '<option value=""' + (r.bank ? '' : ' selected') + ' disabled>Pilih bank</option>'
      + BANKS.map((b) => '<option value="' + b + '"' + (r.bank === b ? ' selected' : '') + '>' + b + '</option>').join('')
      + '<option value="Lainnya"' + (r.bank === 'Lainnya' ? ' selected' : '') + '>Lainnya</option>'
      + '</select></div>'
      + '<div' + (r.bank === 'Lainnya' ? '' : ' hidden') + '><label class="section-label mb-1 block" for="s-bank-' + i + '-other">Nama bank</label>'
      + '<input id="s-bank-' + i + '-other" class="field" maxlength="40" autocomplete="off" data-bank-i="' + i + '" data-bank-k="other" placeholder="e.g. Bank Nagari" value="' + esc(r.other) + '"></div>'
      + '<div><label class="section-label mb-1 block" for="s-bank-' + i + '-no">Nomor rekening</label>'
      + '<input id="s-bank-' + i + '-no" class="field" maxlength="40" inputmode="numeric" autocomplete="off" data-bank-i="' + i + '" data-bank-k="no" placeholder="e.g. 1234 5678 90" value="' + esc(r.no) + '"></div>'
      + '<div><label class="section-label mb-1 block" for="s-bank-' + i + '-name">Nama pemilik rekening</label>'
      + '<input id="s-bank-' + i + '-name" class="field" maxlength="80" autocomplete="off" data-bank-i="' + i + '" data-bank-k="name" placeholder="e.g. Budi Santoso" value="' + esc(r.name) + '"></div>'
      + '<button type="button" class="btn-secondary self-start" data-bank-del="' + i + '">Hapus rekening</button>'
      + '</div>').join('');
    $('#s-bank-add').hidden = bankDraft.length >= 3;
  }
  // ── QRIS toko ──
  let qrisDraft = '';
  function renderQrisDraft() {
    $('#s-qris-preview').innerHTML = qrisDraft
      ? '<img src="' + esc(qrisDraft) + '" alt="QRIS toko" class="h-12 w-12 rounded-lg object-cover">'
      : '<span class="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-line text-small text-muted">QRIS</span>';
    $('#s-qris-remove').hidden = !qrisDraft;
  }
  function openStoreProfile() {
    const s = S.store || {};
    $('#s-name').value = s.name || ''; $('#s-address').value = s.address || ''; $('#s-phone').value = s.phone || '';
    logoDraft = s.logoUrl || '';
    $('#s-tax-on').checked = !!s.taxEnabled;
    $('#s-tax').value = s.taxPercent != null ? s.taxPercent : 11;
    $('#s-tax-wrap').hidden = !$('#s-tax-on').checked;
    const pm = s.paymentMethods || { cash: true, qris: true, debit: true, transfer: true };
    $$('[data-pay]').forEach((c) => { c.checked = pm[c.dataset.pay] !== false; });
    bankDraft = Array.isArray(s.bankAccounts) && s.bankAccounts.length
      ? s.bankAccounts.map(toBankDraft) : [emptyBankRow()];
    qrisDraft = s.qrisUrl || '';
    renderBankRows(); renderLogoDraft(); renderQrisDraft();
    openDlg($('#dlg-store'));
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
  $('#s-qris-remove').addEventListener('click', () => { qrisDraft = ''; renderQrisDraft(); });
  $('#s-qris-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (!window.usernode || !usernode.uploadFile) return setErr($('#dlg-store'), 'Unggah QRIS hanya tersedia di dalam Homeroom.');
    try {
      const stored = await usernode.uploadFile(file, { visibility: 'public' });
      qrisDraft = stored.url; renderQrisDraft(); setErr($('#dlg-store'), '');
    } catch (err) { setErr($('#dlg-store'), 'QRIS gagal diunggah: ' + ((err && err.message) || 'coba gambar PNG atau JPEG di bawah 5 MB') + '.'); }
  });
  $('#s-tax-on').addEventListener('change', () => { $('#s-tax-wrap').hidden = !$('#s-tax-on').checked; });
  $('#s-bank-add').addEventListener('click', () => {
    if (bankDraft.length >= 3) return;
    bankDraft.push(emptyBankRow());
    renderBankRows();
  });
  // Typing updates the draft without a re-render, so the field keeps focus;
  // picking a bank re-renders the row to show or hide "Nama bank".
  $('#s-banks').addEventListener('input', (e) => {
    const i = e.target.dataset.bankI; const k = e.target.dataset.bankK;
    if (i === undefined || !k) return;
    bankDraft[Number(i)][k] = e.target.value;
  });
  $('#s-banks').addEventListener('change', (e) => {
    if (e.target.dataset.bankK !== 'bank') return;
    bankDraft[Number(e.target.dataset.bankI)].bank = e.target.value;
    renderBankRows();
  });
  $('#form-store').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#s-name').value.trim();
    if (!name) return setErr($('#dlg-store'), 'Nama toko wajib diisi.');
    // Completely empty rows are dropped; a partly filled row is sent as-is so
    // the server answers with its "Rekening N: …" message.
    const accs = bankDraft
      .filter((r) => r.bank || r.other.trim() || r.no.trim() || r.name.trim())
      .map((r) => ({ bank: r.bank === 'Lainnya' ? r.other.trim() : r.bank, accountNo: r.no.trim(), accountName: r.name.trim() }));
    const taxEnabled = $('#s-tax-on').checked;
    try {
      const saved = await api('/api/store', { method: 'PUT', body: {
        name, address: $('#s-address').value.trim(), phone: $('#s-phone').value.trim(),
        logoUrl: logoDraft, qrisUrl: qrisDraft,
        taxEnabled, taxPercent: taxEnabled ? dec($('#s-tax').value) : null,
        paymentMethods: {
          cash: $('#s-pay-cash').checked, qris: $('#s-pay-qris').checked,
          debit: $('#s-pay-debit').checked, transfer: $('#s-pay-transfer').checked,
        },
        bankAccounts: accs,
      } });
      // The PUT response carries no hasSales; keep the loaded one so the
      // checklist state survives editing the profile.
      S.store = Object.assign({}, S.store, saved);
      S.taxPct = S.store.taxEnabled ? S.store.taxPercent : 0;
      $('#tax-pct').value = String(S.taxPct);
      renderPayMethods();
      const idx = S.stores.findIndex((s) => s.id === S.store.id);
      if (idx >= 0) S.stores[idx] = Object.assign({}, S.stores[idx], S.store);
      renderBrand(); updateTotals(); $('#dlg-store').close(); toast('Profil toko disimpan');
    } catch (err) { setErr($('#dlg-store'), err.message); }
  });

  // ── Tambah toko ──
  function openNewStore() {
    $('#n-name').value = ''; $('#n-address').value = ''; $('#n-phone').value = '';
    if ($('#dlg-stores').open) $('#dlg-stores').close();
    openDlg($('#dlg-new-store'));
  }
  // Shared by the "Tambah toko" dialog and the gate card's inline form:
  // everything that happens once POST /api/stores has answered.
  async function afterStoreCreated(created, msg) {
    S.stores.push(created);
    S.activeStoreId = created.id; saveStore(created.id);
    S.cart = []; S.cat = 'Semua'; S.q = ''; cartChanged();
    S.customerName = ''; $('#credit-name').value = '';
    S.debts = null; S.shifts = null;
    renderShell();
    toast(msg || ('Toko ' + created.name + ' dibuat'));
    await loadStore(); loadProducts(); loadMovements(); loadCustomers();
    if (S.tab === 'laporan') { loadReport(); loadDebts(); loadShifts(); }
    if (S.tab === 'kasir') loadToday();
  }
  $('#form-new-store').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#n-name').value.trim();
    if (!name) return setErr($('#dlg-new-store'), 'Nama toko wajib diisi.');
    try {
      const created = await api('/api/stores', { method: 'POST', body: { name, address: $('#n-address').value.trim(), phone: $('#n-phone').value.trim() } });
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
      const created = await api('/api/stores', { method: 'POST', body: { name, address: '', phone: '' } });
      $('#g-name').value = '';
      await afterStoreCreated(created);
    } catch (err) { setErr(form, err.message); }
    finally { btn.disabled = false; }
  });
  // "Coba dengan data contoh" under the gate form: opens a ready-made example
  // store so a brand-new owner can look around before naming their own.
  $('#gate-sample').addEventListener('click', async () => {
    const box = $('#gate-sample-box');
    const btn = $('#gate-sample');
    btn.disabled = true;
    setErr(box, '');
    try {
      const created = await api('/api/stores/sample', { method: 'POST', body: {} });
      await afterStoreCreated(created, 'Toko Contoh dibuat dengan data contoh');
    } catch (err) { setErr(box, err.message); }
    finally { btn.disabled = false; }
  });

  // ── Struk ──
  function receiptHtml(r) {
    const s = S.store || {}; const x = r.sale;
    const row = (a, b, strong) => '<div class="flex justify-between gap-3' + (strong ? ' font-bold' : '') + '"><span>' + a + '</span><span class="shrink-0">' + b + '</span></div>';
    const rule = '<div class="my-2 border-t border-dashed border-line"></div>';
    return '<div class="mx-auto w-full max-w-xs bg-surface font-mono text-small text-fg">'
      + '<div class="flex flex-col items-center gap-1 text-center">' + storeLogo('h-12 w-12')
      + '<p class="text-body font-bold">' + esc(s.name || 'KasirKU') + '</p>'
      + (s.address ? '<p>' + esc(s.address) + '</p>' : '') + (s.phone ? '<p>Telp. ' + esc(s.phone) + '</p>' : '') + '</div>' + rule
      + row('No. invoice', esc(x.invoiceNo)) + row('Tanggal', fmtDateTime(x.createdAt)) + (x.cashier ? row('Kasir', esc(x.cashier)) : '') + rule
      + r.items.map((i) => '<div class="mb-1"><p>' + esc(i.name) + '</p>'
        + row(i.qty + ' x ' + rp(i.price) + (i.price !== i.listPrice ? ' *' : ''), rp(i.qty * i.price))
        + '</div>').join('')
      + (r.items.some((i) => i.price !== i.listPrice) ? '<p class="text-muted">* harga disesuaikan</p>' : '') + rule
      + row('Subtotal', rp(x.subtotal))
      + (x.discountAmount ? row('Diskon' + (x.discountType === 'percent' ? ' (' + x.discountValue + '%)' : ''), '-' + rp(x.discountAmount)) : '')
      + row('PPN (' + x.taxPercent + '%)', rp(x.taxAmount)) + row('TOTAL', rp(x.total), true) + rule
      + row('Pembayaran', METHODS[x.paymentMethod])
      + (x.paymentMethod === 'credit'
        ? row('Pelanggan', esc(x.customerName || '')) + row('Belum dibayar', rp(x.total))
        : x.paymentMethod === 'cash' ? row('Tunai', rp(x.paid)) + row('Kembalian', rp(x.change)) : row('Dibayar', rp(x.paid))) + rule
      + '<p class="text-center">Terima kasih telah berbelanja</p><p class="text-center text-muted">Struk dibuat dengan KasirKU</p></div>';
  }
  async function showReceipt(id) {
    try {
      S.receipt = await api('/api/sales/' + id);
      $('#receipt-view').innerHTML = receiptHtml(S.receipt);
      $('#dlg-receipt').showModal();
    } catch (e) { toast('Struk gagal dimuat: ' + e.message); }
  }
  function receiptText(r) {
    const s = S.store || {}; const x = r.sale;
    return [s.name || 'KasirKU', s.address, s.phone, '', 'Invoice: ' + x.invoiceNo, 'Tanggal: ' + fmtDateTime(x.createdAt), '']
      .concat(r.items.map((i) => i.name + ' ' + i.qty + ' x ' + rp(i.price) + ' = ' + rp(i.qty * i.price)))
      .concat(['', 'Subtotal: ' + rp(x.subtotal), x.discountAmount ? 'Diskon: -' + rp(x.discountAmount) : '', 'PPN (' + x.taxPercent + '%): ' + rp(x.taxAmount),
        'TOTAL: ' + rp(x.total), 'Pembayaran: ' + METHODS[x.paymentMethod],
        x.paymentMethod === 'cash' ? 'Tunai: ' + rp(x.paid) + ', kembalian: ' + rp(x.change)
          : x.paymentMethod === 'credit' ? 'Pelanggan: ' + (x.customerName || '') : 'Dibayar: ' + rp(x.paid),
        x.paymentMethod === 'credit' ? 'Belum dibayar: ' + rp(x.total) : '',
        '', 'Terima kasih telah berbelanja'])
      .filter((l) => l !== undefined && l !== null && (l !== '' || true)).join('\n').replace(/\n{3,}/g, '\n\n');
  }
  $('#receipt-print').addEventListener('click', () => {
    if (!S.receipt) return;
    $('#print-area').innerHTML = receiptHtml(S.receipt);
    window.print();
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
    if (S.reportState === 'loading') { box.innerHTML = skeletonRows(4); return; }
    if (S.reportState === 'error') { box.innerHTML = errorBox('Laporan penjualan', 'report'); return; }
    if (!S.report) { box.innerHTML = ''; return; }
    const r = S.report; const m = r.summary;
    const monthly = r.mode === 'monthly';
    const rowTime = (x) => (monthly ? fmtDateTime(x.createdAt) : fmtTime(x.createdAt));
    const stat = (label, value, note) => '<div class="flex flex-col gap-1 p-4"><dt class="text-small text-muted">' + label + '</dt><dd class="text-heading">' + value + '</dd>'
      + (note ? '<dd class="text-small text-muted">' + note + '</dd>' : '') + '</div>';
    const margin = m.revenue ? Math.round(m.grossProfit / m.revenue * 100) : 0;
    let html = '<dl class="grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface lg:grid-cols-4 lg:divide-y-0">'
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
      + '<div class="min-w-0 grow"><p class="text-body font-medium">' + esc(x.invoiceNo) + '</p><p class="text-small text-muted">' + rowTime(x) + ' · ' + METHODS[x.paymentMethod] + (x.customerName ? ' · ' + esc(x.customerName) : '') + '</p></div>'
      + '<div class="text-right"><p class="text-body font-medium">' + rp(x.total) + '</p><p class="text-small text-muted">Laba ' + rp(x.subtotal - x.discountAmount - x.cogs) + '</p></div></button></li>').join('') + '</ul></div>';
    box.innerHTML = html;
  }

  // ── Penjualan hari ini ──
  // One row of the daily report's summary, at the top of the Kasir tab: how
  // much has been taken today and in how many sales, for the active store.
  function renderToday() {
    const box = $('#today-sales');
    const title = '<h3 id="today-title" class="text-body font-medium">Penjualan hari ini</h3>';
    if (S.todayState === 'loading') {
      box.innerHTML = '<div>' + title + '<p class="text-small text-muted">Omzet setelah diskon, sebelum PPN</p></div>'
        + '<dl class="flex gap-8"><div><dt class="text-small text-muted">Omzet</dt><dd class="skeleton h-7 w-28"></dd></div>'
        + '<div><dt class="text-small text-muted">Transaksi</dt><dd class="skeleton h-7 w-10"></dd></div></dl>';
      return;
    }
    if (S.todayState === 'error') {
      box.innerHTML = '<div role="alert"><h3 id="today-title" class="text-body font-medium">Penjualan hari ini gagal dimuat</h3>'
        + '<p class="text-small text-muted">Kasir tetap bisa dipakai.</p></div>'
        + '<button type="button" class="btn-secondary" data-retry="today">Coba lagi</button>';
      return;
    }
    const d = S.today || { count: 0, revenue: 0 };
    box.innerHTML = '<div>' + title + '<p class="text-small text-muted">'
      + (d.count ? 'Omzet setelah diskon, sebelum PPN' : 'Belum ada transaksi hari ini') + '</p></div>'
      + '<dl class="flex gap-8"><div><dt class="text-small text-muted">Omzet</dt><dd class="text-heading">' + rp(d.revenue) + '</dd></div>'
      + '<div><dt class="text-small text-muted">Transaksi</dt><dd class="text-heading">' + d.count + '</dd></div></dl>';
  }

  // ── Tutup shift ──
  // Selisih is counted minus expected: positive is more cash than the record
  // says (Lebih), negative is short (Kurang, in the danger colour), 0 is Pas.
  const selisih = (d) => (d > 0 ? 'Lebih ' + rp(d) : d < 0 ? 'Kurang ' + rp(-d) : 'Pas');
  const selisihCls = (d) => (d < 0 ? 'text-danger' : '');
  // A closing names a whole day, so it reads the weekday and the year too.
  const fmtShiftDay = (ymd) => new Date(ymd + 'T12:00:00+07:00')
    .toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

  function renderShifts() {
    const box = $('#shift-body');
    if (S.shiftsState === 'loading') {
      box.innerHTML = '<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3">'
        + '<div><div class="skeleton h-5 w-40"></div><div class="skeleton mt-2 h-4 w-56"></div></div>'
        + '<div class="skeleton h-7 w-28"></div></div>' + skeletonRows(2);
      return;
    }
    if (S.shiftsState === 'error') {
      box.innerHTML = '<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3" role="alert">'
        + '<div><h3 class="text-body font-medium">Tutup shift gagal dimuat</h3>'
        + '<p class="text-small text-muted">Laporan lainnya tetap bisa dipakai.</p></div>'
        + '<button type="button" class="btn-secondary" data-retry="shifts">Coba lagi</button></div>';
      return;
    }
    const d = S.shifts;
    if (!d) { box.innerHTML = ''; return; }
    const bar = d.today
      ? '<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3">'
        + '<div><h3 class="text-body font-medium">Tutup shift hari ini</h3>'
        + '<p class="text-small text-muted">Sudah ditutup pukul ' + fmtTime(d.today.createdAt) + '</p></div>'
        + '<dl class="flex flex-wrap gap-x-8 gap-y-2">'
        + '<div><dt class="text-small text-muted">Seharusnya</dt><dd class="text-heading">' + rp(d.today.expectedCash) + '</dd></div>'
        + '<div><dt class="text-small text-muted">Dihitung</dt><dd class="text-heading">' + rp(d.today.countedCash) + '</dd></div>'
        + '<div><dt class="text-small text-muted">Selisih</dt><dd class="text-heading ' + selisihCls(d.today.difference) + '">' + selisih(d.today.difference) + '</dd></div></dl></div>'
      : '<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3">'
        + '<div><h3 class="text-body font-medium">Tutup shift hari ini</h3>'
        + '<p class="text-small text-muted">' + (d.cashCount
          ? 'Belum ditutup. Uang tunai dari ' + d.cashCount + ' penjualan Tunai hari ini.'
          : 'Belum ada penjualan Tunai hari ini.') + '</p></div>'
        + '<dl><div><dt class="text-small text-muted">Uang tunai seharusnya</dt><dd class="text-heading">' + rp(d.expectedCash) + '</dd></div></dl>'
        + '<button type="button" class="btn-primary" data-shift-close>Tutup shift</button></div>';
    const rows = d.closings.length
      ? '<ul class="list">' + d.closings.map((x) =>
        '<li class="list-row"><div class="min-w-0 grow"><p class="text-body font-medium">' + esc(fmtShiftDay(x.date)) + '</p>'
        + '<p class="text-small text-muted">Seharusnya ' + rp(x.expectedCash) + ', dihitung ' + rp(x.countedCash) + '</p></div>'
        + '<p class="shrink-0 text-right text-body font-medium ' + selisihCls(x.difference) + '">' + selisih(x.difference) + '</p></li>').join('') + '</ul>'
      : '<p class="text-small text-muted">Belum ada riwayat tutup shift.</p>';
    box.innerHTML = bar + '<div><h3 class="section-label">Riwayat tutup shift</h3>' + rows + '</div>';
  }

  function openShiftClose() {
    const d = S.shifts;
    if (!d || d.today) return;
    $('#sh-info').textContent = fmtShiftDay(d.date) + '. Uang tunai seharusnya ' + rp(d.expectedCash) + '.';
    $('#sh-counted').value = '';
    shiftPreview();
    openDlg($('#dlg-shift'));
    $('#sh-counted').focus();
  }
  function shiftPreview() {
    const d = S.shifts;
    if (!d) return;
    const el = $('#sh-preview');
    const raw = $('#sh-counted').value.trim();
    if (raw === '') { el.textContent = ''; el.classList.remove('text-danger'); el.classList.add('text-muted'); return; }
    const diff = digits(raw) - d.expectedCash;
    el.textContent = diff === 0 ? 'Pas, uang tunai sesuai catatan.' : selisih(diff) + ' dari yang seharusnya.';
    el.classList.toggle('text-danger', diff < 0);
    el.classList.toggle('text-muted', diff >= 0);
  }

  // ── Piutang pelanggan ──
  function renderDebts() {
    const box = $('#debt-body');
    if (S.debtsState === 'loading') { box.innerHTML = skeletonRows(2); return; }
    if (S.debtsState === 'error') { box.innerHTML = errorBox('Daftar piutang', 'debts'); return; }
    if (!S.debts || !S.debts.debts.length) {
      box.innerHTML = '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Tidak ada piutang</p>'
        + '<p class="text-body text-muted">Penjualan Bayar nanti dari menu Kasir akan muncul di sini.</p></div>';
      return;
    }
    const d = S.debts;
    box.innerHTML = '<div><h3 class="section-label flex justify-between"><span>Piutang pelanggan</span>'
      + '<span>Total ' + rp(d.total) + ' dari ' + d.count + ' pelanggan</span></h3><ul class="list">'
      + d.debts.map((x) =>
        '<li class="list-row"><div class="min-w-0 grow"><p class="text-body font-medium">' + esc(x.name) + '</p>'
        + '<p class="text-small text-muted">Bon terakhir ' + fmtDateTime(x.lastSaleAt) + '</p></div>'
        + '<p class="shrink-0 text-body font-medium">' + rp(x.owed) + '</p>'
        + '<button type="button" class="btn-secondary shrink-0" data-pay-debt="' + x.customerId
        + '" aria-label="Catat bayar piutang ' + esc(x.name) + '">Catat bayar</button></li>').join('')
      + '</ul></div>';
  }

  function openDebtPay(customerId) {
    const d = S.debts && S.debts.debts.find((x) => x.customerId === customerId);
    if (!d) return;
    S.debtCustomerId = customerId;
    // A fresh reference per open: a retried submit reuses it, a reopened
    // window starts a new payment.
    S.debtRef = newRef();
    $('#dp-customer').textContent = d.name + ', sisa ' + rp(d.owed);
    $('#dp-amount').value = '';
    const full = $('#dp-full');
    full.textContent = 'Lunasi ' + rp(d.owed);
    full.dataset.owed = String(d.owed);
    debtPreview();
    openDlg($('#dlg-debt-pay'));
  }
  function debtPreview() {
    const d = S.debts && S.debts.debts.find((x) => x.customerId === S.debtCustomerId);
    if (!d) return;
    if ($('#dp-amount').value.trim() === '') { $('#dp-preview').textContent = 'Sisa piutang ' + rp(d.owed) + '.'; return; }
    const a = digits($('#dp-amount').value);
    $('#dp-preview').textContent = a > d.owed
      ? 'Melebihi sisa piutang ' + rp(d.owed) + '.'
      : 'Sisa piutang menjadi ' + rp(d.owed - a) + '.';
  }

  // ── Tabs ──
  function setTab(tab) {
    if (!['kasir', 'stok', 'laporan'].includes(tab)) tab = 'kasir';
    if (!hasStore()) tab = 'kasir';
    S.tab = tab;
    $$('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    ['kasir', 'stok', 'laporan'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
    if (tab === 'kasir' && hasStore()) loadToday();
    if (tab === 'stok' && S.movementsState !== 'ok') loadMovements();
    if (tab === 'laporan') { loadReport(); loadDebts(); loadInsights(); loadShifts(); }
  }
  const goto = (t) => { location.hash = t; };
  window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));
  $$('[role=tab]').forEach((b) => b.addEventListener('click', () => goto(b.dataset.tab)));

  // ── Events ──
  $('#pos-search').addEventListener('input', (e) => { S.q = e.target.value; renderPos(); });
  // A barcode scanner (USB or keyboard-wedge) types the code and presses Enter,
  // so a full SKU typed or scanned into the search box adds straight to the cart.
  function findBySku(code) {
    const c = code.trim();
    if (!c) return null;
    const exact = S.products.find((p) => p.sku === c);
    if (exact) return exact;
    const lc = c.toLowerCase();
    const loose = S.products.filter((p) => p.sku.toLowerCase() === lc);
    return loose.length === 1 ? loose[0] : null;
  }
  // Returns true when the code named a product (added or refused for stock),
  // false when nothing matched and the search filter stays as it is.
  function scanCode(code) {
    const p = findBySku(code);
    if (!p) return false;
    const before = (S.cart.find((l) => l.id === p.id) || {}).qty || 0;
    addToCart(p.id);
    const after = (S.cart.find((l) => l.id === p.id) || {}).qty || 0;
    if (after > before) toast(p.name + ' masuk keranjang');
    return true;
  }
  $('#pos-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || S.productsState !== 'ok') return;
    if (!scanCode(e.target.value)) return;
    e.preventDefault();
    e.target.value = '';
    S.q = '';
    renderPos();
  });
  // ── Camera scan (Pindai) ──
  // Only offered where the browser can read barcodes on its own; no library.
  const CAN_SCAN = 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  $('#scan-btn').hidden = !CAN_SCAN;
  let scanStream = null, scanTimer = 0, scanning = false;
  function stopScan() {
    scanning = false;
    clearTimeout(scanTimer);
    if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
    $('#scan-video').srcObject = null;
  }
  async function startScan() {
    const errEl = $('[data-err]', $('#dlg-scan'));
    errEl.textContent = '';
    $('#scan-retry').hidden = true;
    const video = $('#scan-video');
    try {
      if (window.usernode && usernode.requestPermission) {
        const r = await usernode.requestPermission('camera');
        if (r && r.state !== 'granted') {
          errEl.textContent = 'Izin kamera belum diberikan. Cari produk dengan mengetik atau pakai pemindai barcode.';
          $('#scan-retry').hidden = false;
          return;
        }
        if (r && !r.active) return; // the platform reloads the frame to grant it
      }
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = scanStream;
      await video.play();
      const detector = new BarcodeDetector();
      scanning = true;
      const tick = async () => {
        if (!scanning) return;
        let found = null;
        try { found = (await detector.detect(video)).find((c) => c.rawValue) || null; }
        catch (e) { /* a single failed read is skipped */ }
        if (found) {
          const code = found.rawValue;
          stopScan();
          $('#dlg-scan').close();
          if (!scanCode(code)) { $('#pos-search').value = code; S.q = code; renderPos(); }
          return;
        }
        scanTimer = setTimeout(tick, 200);
      };
      tick();
    } catch (err) {
      stopScan();
      errEl.textContent = 'Kamera tidak bisa dibuka. Cari produk dengan mengetik atau pakai pemindai barcode.';
      $('#scan-retry').hidden = false;
    }
  }
  $('#scan-btn').addEventListener('click', () => { openDlg($('#dlg-scan')); startScan(); });
  $('#scan-retry').addEventListener('click', () => { stopScan(); startScan(); });
  // Batal, Esc and a successful read all release the camera through this.
  $('#dlg-scan').addEventListener('close', stopScan);

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
  $('#credit-name').addEventListener('input', (e) => { S.customerName = e.target.value; cartChanged(); updateTotals(); });
  $('#dp-amount').addEventListener('input', debtPreview);
  $('#sh-counted').addEventListener('input', shiftPreview);
  $('#dp-full').addEventListener('click', () => {
    const d = S.debts && S.debts.debts.find((x) => x.customerId === S.debtCustomerId);
    if (!d) return;
    $('#dp-amount').value = String(d.owed);
    debtPreview();
  });
  $('#form-debt-pay').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = S.debts && S.debts.debts.find((x) => x.customerId === S.debtCustomerId);
    if (!d) return;
    if ($('#dp-amount').value.trim() === '') return setErr($('#dlg-debt-pay'), 'Isi jumlahnya dulu.');
    const amount = digits($('#dp-amount').value);
    if (amount < 1) return setErr($('#dlg-debt-pay'), 'Jumlah dibayar tidak valid.');
    const btn = $('#form-debt-pay button[type="submit"]');
    btn.disabled = true;
    try {
      const out = await api('/api/debts/' + S.debtCustomerId + '/payments', {
        method: 'POST', body: { amount, clientRef: S.debtRef } });
      $('#dlg-debt-pay').close();
      toast(out.owed === 0 ? 'Piutang ' + d.name + ' lunas' : 'Pembayaran dicatat');
      loadDebts();
    } catch (err) { setErr($('#dlg-debt-pay'), err.message); }
    finally { btn.disabled = false; }
  });

  $('#form-shift').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('#sh-counted').value.trim() === '') return setErr($('#dlg-shift'), 'Isi jumlahnya dulu.');
    const countedCash = digits($('#sh-counted').value);
    const btn = $('#form-shift button[type="submit"]');
    btn.disabled = true;
    try {
      const out = await api('/api/shifts/close', { method: 'POST', body: { countedCash } });
      $('#dlg-shift').close();
      toast('Shift ditutup, ' + selisih(out.closing.difference));
      loadShifts();
    } catch (err) {
      setErr($('#dlg-shift'), err.message);
      // Already closed (here or from another device): show the existing
      // closing instead of leaving the bar offering the button again.
      if (err.status === 409) loadShifts();
    }
    finally { btn.disabled = false; }
  });

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
    else if (d.restock) openAdjust(Number(d.restock), Number(d.qty));
    else if (d.edit) openProduct(Number(d.edit));
    else if (t.hasAttribute('data-new-store')) openNewStore();
    else if (t.hasAttribute('data-new-product')) openProduct(null);
    else if (d.receipt) showReceipt(Number(d.receipt));
    else if (d.payDebt) openDebtPay(Number(d.payDebt));
    else if (t.hasAttribute('data-shift-close')) openShiftClose();
    else if (d.goto) goto(d.goto);
    else if (d.copyAcc !== undefined) copyAccountNo(Number(d.copyAcc));
    else if (t.hasAttribute('data-bank-setup')) {
      openStoreProfile();
      if (!bankDraft.length) { bankDraft.push(emptyBankRow()); renderBankRows(); }
      const first = $('#s-banks select');
      if (first) first.focus();
    }
    else if (t.hasAttribute('data-qris-setup')) { openStoreProfile(); $('#s-qris-label').focus(); }
    else if (d.bankDel !== undefined) { bankDraft.splice(Number(d.bankDel), 1); renderBankRows(); }
    else if (d.retry) ({ products: loadProducts, movements: loadMovements, report: loadReport, stores: retryStores, debts: loadDebts, insights: loadInsights, today: loadToday, shifts: loadShifts })[d.retry]();
  });

  // ── Boot ──
  // Everything after the store list answers: the active store's profile,
  // then its products, movements, customers and, on Laporan, the reports.
  // Shared by boot and by the gate's Coba lagi, which may find stores.
  async function afterStores() {
    setTab(location.hash.slice(1));
    await loadStore(); loadProducts(); loadMovements(); loadCustomers();
    if (S.tab === 'laporan') { loadReport(); loadDebts(); loadShifts(); }
  }
  async function retryStores() {
    if (await loadStores()) await afterStores();
  }
  $('#report-date').value = S.reportDate;
  $('#report-month').value = S.reportMonth;
  renderReportPeriod();
  renderCart(); renderProducts(); renderShell(); renderToday();
  (async function boot() {
    if (!(await loadStores())) { setTab('kasir'); renderBrand(); return; }
    await afterStores();
  })();
})();
