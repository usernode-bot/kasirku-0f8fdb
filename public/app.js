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
  const METHODS = { cash: 'Tunai', qris: 'QRIS', debit: 'Debit', transfer: 'Transfer bank' };
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
    checkoutRef: null, payUncertain: false,
    movements: null, movementsState: 'loading', report: null, reportState: 'loading', reportDate: today(),
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
    if (!hasStore()) { S.store = null; renderBrand(); return; }
    try {
      S.store = await api('/api/store');
      S.taxPct = S.store ? S.store.taxPercent : 11;
      $('#tax-pct').value = String(S.taxPct);
      $('#staging-note').hidden = !(S.store && S.store.staging);
      renderBrand();
      renderCart();
    } catch (e) { S.store = S.store || { name: 'KasirKU', address: '', phone: '', logoUrl: '', taxPercent: 11 }; renderBrand(); }
  }
  async function loadProducts() {
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
    try { S.report = await api('/api/reports?date=' + encodeURIComponent(S.reportDate)); S.reportState = 'ok'; } catch (e) { S.reportState = 'error'; }
    renderReport();
  }

  // ── Shell: the no-store gate vs the tabs ──
  function renderShell() {
    const empty = !hasStore();
    $('#store-gate').hidden = !empty;
    $('#main-area').hidden = empty;
    $$('#main-tabs [role=tab]').forEach((b) => { b.disabled = empty; });
    renderBrand();
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
    return '';
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
        paymentMethod: S.method, paid: S.method === 'cash' ? S.paid : t.total, clientRef: S.checkoutRef,
      } });
      cartChanged();
      S.cart = []; S.paid = 0; $('#cash-paid').value = '';
      S.discType = 'none'; S.discValue = 0; $('#disc-type').value = 'none'; $('#disc-value').value = ''; $('#disc-value').disabled = true;
      S.paying = false;
      renderCart(); loadProducts(); loadMovements();
      if (S.report) loadReport();
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
    const box = $('#stock-list');
    const alertBox = $('#low-alert');
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
      S.store = await api('/api/store', { method: 'PUT', body: { name, address: $('#s-address').value.trim(), phone: $('#s-phone').value.trim(), logoUrl: logoDraft, taxPercent: dec($('#s-tax').value) } });
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
  $('#form-new-store').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#n-name').value.trim();
    if (!name) return setErr($('#dlg-new-store'), 'Nama toko wajib diisi.');
    try {
      const created = await api('/api/stores', { method: 'POST', body: { name, address: $('#n-address').value.trim(), phone: $('#n-phone').value.trim(), taxPercent: dec($('#n-tax').value) } });
      $('#dlg-new-store').close();
      S.stores.push(created);
      S.activeStoreId = created.id; saveStore(created.id);
      S.cart = []; S.cat = 'Semua'; S.q = ''; cartChanged();
      renderShell();
      toast('Toko ' + created.name + ' dibuat');
      await loadStore(); loadProducts(); loadMovements();
    } catch (err) { setErr($('#dlg-new-store'), err.message); }
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
      + (x.paymentMethod === 'cash' ? row('Tunai', rp(x.paid)) + row('Kembalian', rp(x.change)) : row('Dibayar', rp(x.paid))) + rule
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
        'TOTAL: ' + rp(x.total), 'Pembayaran: ' + METHODS[x.paymentMethod], x.paymentMethod === 'cash' ? 'Tunai: ' + rp(x.paid) + ', kembalian: ' + rp(x.change) : '', '', 'Terima kasih telah berbelanja'])
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
  function renderReport() {
    const box = $('#report-body');
    if (S.reportState === 'loading') { box.innerHTML = skeletonRows(4); return; }
    if (S.reportState === 'error') { box.innerHTML = errorBox('Laporan penjualan', 'report'); return; }
    if (!S.report) { box.innerHTML = ''; return; }
    const r = S.report; const m = r.summary;
    const stat = (label, value, note) => '<div class="flex flex-col gap-1 p-4"><dt class="text-small text-muted">' + label + '</dt><dd class="text-heading">' + value + '</dd>'
      + (note ? '<dd class="text-small text-muted">' + note + '</dd>' : '') + '</div>';
    const margin = m.revenue ? Math.round(m.grossProfit / m.revenue * 100) : 0;
    let html = '<dl class="grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface lg:grid-cols-4 lg:divide-y-0">'
      + stat('Omzet', rp(m.revenue), 'Penjualan setelah diskon, sebelum PPN')
      + stat('HPP (harga pokok penjualan)', rp(m.cogs), 'Total harga modal barang terjual')
      + stat('Estimasi laba kotor', rp(m.grossProfit), m.revenue ? 'Margin ' + margin + '%' : 'Omzet dikurangi HPP')
      + stat('Transaksi', String(m.count), 'PPN terkumpul ' + rp(m.tax)) + '</dl>';
    if (!m.count) {
      html += '<div class="state-empty rounded-xl border border-line bg-surface"><p class="text-heading">Belum ada transaksi pada tanggal ini</p>'
        + '<p class="text-body text-muted">Transaksi dari menu Kasir akan muncul di sini.</p><button type="button" class="btn-primary" data-goto="kasir">Buka kasir</button></div>';
      box.innerHTML = html; return;
    }
    html += '<div><h3 class="section-label">Per metode pembayaran</h3><ul class="list">' + r.byMethod.map((x) =>
      '<li class="list-row"><span class="grow text-body">' + METHODS[x.method] + '</span><span class="text-small text-muted">' + x.count + ' transaksi</span><span class="w-32 text-right text-body font-medium">' + rp(x.total) + '</span></li>').join('') + '</ul></div>';
    html += '<div><h3 class="section-label">Riwayat transaksi</h3><ul class="list">' + r.sales.map((x) =>
      '<li><button type="button" data-receipt="' + x.id + '" class="list-row w-full text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">'
      + '<div class="min-w-0 grow"><p class="text-body font-medium">' + esc(x.invoiceNo) + '</p><p class="text-small text-muted">' + fmtTime(x.createdAt) + ' · ' + METHODS[x.paymentMethod] + '</p></div>'
      + '<div class="text-right"><p class="text-body font-medium">' + rp(x.total) + '</p><p class="text-small text-muted">Laba ' + rp(x.subtotal - x.discountAmount - x.cogs) + '</p></div></button></li>').join('') + '</ul></div>';
    box.innerHTML = html;
  }

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
    else if (d.goto) goto(d.goto);
    else if (d.retry) ({ products: loadProducts, movements: loadMovements, report: loadReport, stores: loadStores })[d.retry]();
  });

  // ── Boot ──
  $('#report-date').value = S.reportDate;
  renderCart(); renderProducts(); renderShell();
  (async function boot() {
    const anyStore = await loadStores();
    if (!anyStore) { setTab('kasir'); renderBrand(); return; }
    setTab(location.hash.slice(1));
    await loadStore(); loadProducts(); loadMovements();
    if (S.tab === 'laporan') loadReport();
  })();
})();
