/* KasirKU front end: Sell, Products and Sales, with receipts.
 *
 * One page, hash-routed (#/sell, #/products, #/sales, #/sales/:id). Class
 * names are written as whole literals so the precompiled Tailwind build
 * sees them. The bill you are building lives in memory only: it survives
 * tab switches but clears on reload.
 */
(function () {
  'use strict';

  var main = document.querySelector('[data-app]');
  var query = new URLSearchParams(location.search);
  var DEMO = query.get('demo') === '1';

  // ── Helpers ────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Money is whole rupiah, written "Rp 12.500".
  function rp(n) {
    return 'Rp ' + Number(n).toLocaleString('id-ID');
  }

  function fmtDate(iso) {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(iso));
  }

  function receiptNo(id) {
    return '#' + String(id).padStart(6, '0');
  }

  function taxPercent(bp) {
    var pct = bp / 100;
    return Number.isInteger(pct) ? String(pct) : String(Math.round(pct * 100) / 100);
  }

  // Same rounding as the server: tax = round(subtotal * bp / 10000).
  function computeTax(subtotal, bp) {
    var tax = Math.round(subtotal * bp / 10000);
    return { tax: tax, total: subtotal + tax };
  }

  // ── API client ─────────────────────────────────────────────────────────

  function api(path, opts) {
    opts = opts || {};
    var url = path + (path.indexOf('?') === -1 ? '?' : '&') + 'demo=1';
    var headers = { 'Content-Type': 'application/json' };
    if (query.get('token')) headers['x-usernode-token'] = query.get('token');
    if (window.usernode && typeof window.usernode.now === 'function') {
      try { headers['x-usernode-now'] = window.usernode.now(); } catch (e) { /* ignore */ }
    }
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body && body.error ? body.error : 'Request failed');
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  // ── State ──────────────────────────────────────────────────────────────

  var state = {
    products: null,        // array, or null while loading
    taxRateBp: null,
    load: 'loading',       // loading | ok | error — for the current view's data
    errorText: '',
    sales: null,
    sale: null,
    bill: new Map(),       // productId -> qty, kept across tab switches
    billNotice: '',        // e.g. "Only 3 left of Eggs, 10 pack"
    billError: '',         // a failed checkout: what failed, Retry keeps the bill
    saving: false,
    sheetOpen: false,      // phone: the bill bottom sheet
    form: null,            // open form: { kind: 'product', product } | { kind: 'tax' }
    formErrors: {},
  };

  // ── Rendering ──────────────────────────────────────────────────────────

  function activeTab() {
    if (state.route === 'receipt') return 'sales';
    return state.route;
  }

  function render() {
    var tab = activeTab();
    document.querySelectorAll('.tab').forEach(function (a) {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (state.route === 'sell') renderSell();
    else if (state.route === 'products') renderProducts();
    else if (state.route === 'sales') renderSales();
    else if (state.route === 'receipt') renderReceipt();
  }

  function demoBanner() {
    return DEMO
      ? '<p class="px-4 pt-3 text-small text-muted sm:px-6">Staging demo shop: made-up products and sales.</p>'
      : '';
  }

  function viewOpen(name) {
    return '<div data-view="' + name + '">';
  }

  function errorState(what, extra) {
    return '<div class="state-error">' +
      '<p class="font-medium">' + esc(what) + '</p>' +
      (extra ? '<p class="text-small text-muted">' + esc(extra) + '</p>' : '') +
      '<button class="btn-secondary mt-2" data-action="retry">Retry</button>' +
      '</div>';
  }

  function skeletonRows(n) {
    var out = '<ul class="list">';
    for (var i = 0; i < n; i++) {
      out += '<li class="list-row"><div class="skeleton h-5 w-40"></div>' +
        '<div class="skeleton ml-auto h-5 w-16"></div></li>';
    }
    return out + '</ul>';
  }

  function skeletonTiles(n) {
    var out = '<div class="grid grid-cols-2 gap-2.5 p-4 sm:p-0 lg:grid-cols-4">';
    for (var i = 0; i < n; i++) {
      out += '<div class="tile"><div class="skeleton h-5 w-24"></div>' +
        '<div class="skeleton h-4 w-16"></div></div>';
    }
    return out + '</div>';
  }

  // ── Sell ───────────────────────────────────────────────────────────────

  function stockLine(stock) {
    if (stock === 0) return '<span class="text-small text-warn">Sold out</span>';
    if (stock <= 5) return '<span class="text-small text-warn">' + stock + ' left</span>';
    return '<span class="text-small text-muted">' + stock + ' left</span>';
  }

  function sellTiles() {
    var out = '<div class="grid grid-cols-2 gap-2.5 p-4 sm:p-0 lg:grid-cols-4">';
    state.products.forEach(function (p) {
      var qty = state.bill.get(p.id) || 0;
      var soldOut = p.stock === 0;
      out += '<button class="tile' + (qty > 0 ? ' tile-on' : '') + '" data-product="' + p.id + '"' +
        (soldOut ? ' disabled' : '') + '>' +
        '<span class="text-body font-medium">' + esc(p.name) +
        (qty > 0 ? ' <span class="ml-1 inline-flex min-w-6 justify-center rounded-full bg-accent px-2 text-small font-medium text-on-accent">' + qty + '</span>' : '') +
        '</span>' +
        '<span><span class="block font-medium" style="font-variant-numeric:tabular-nums">' + rp(p.price) + '</span>' +
        stockLine(p.stock) + '</span>' +
        '</button>';
    });
    return out + '</div>';
  }

  function billLines() {
    var out = '';
    state.bill.forEach(function (qty, id) {
      var p = state.products.find(function (x) { return x.id === id; });
      if (!p) return;
      out += '<div class="flex items-center gap-2 py-1">' +
        '<button class="step-btn" data-dec="' + id + '" aria-label="Remove one ' + esc(p.name) + '">−</button>' +
        '<span class="w-6 text-center" style="font-variant-numeric:tabular-nums">' + qty + '</span>' +
        '<button class="step-btn" data-inc="' + id + '" aria-label="Add one ' + esc(p.name) + '"' +
        (qty >= p.stock ? ' disabled' : '') + '>+</button>' +
        '<span class="flex-1 break-words">' + esc(p.name) + '</span>' +
        '<span style="font-variant-numeric:tabular-nums">' + (p.price * qty).toLocaleString('id-ID') + '</span>' +
        '</div>';
    });
    return out;
  }

  function billTotals() {
    var subtotal = 0, count = 0;
    state.bill.forEach(function (qty, id) {
      var p = state.products.find(function (x) { return x.id === id; });
      if (p) { subtotal += p.price * qty; count += qty; }
    });
    var t = computeTax(subtotal, state.taxRateBp || 0);
    return { subtotal: subtotal, count: count, tax: t.tax, total: t.total };
  }

  function billPaper() {
    var t = billTotals();
    var empty = state.bill.size === 0;
    return '<div class="paper rounded-t-xl p-4">' +
      '<div class="flex justify-between font-medium"><span>Bill</span><span>' + t.count + (t.count === 1 ? ' item' : ' items') + '</span></div>' +
      '<div class="paper-rule my-2"></div>' +
      (empty ? '<p class="py-2 text-muted">Tap a product to add it.</p>' : billLines()) +
      '<div class="paper-rule my-2"></div>' +
      (state.billNotice ? '<p class="py-1 text-warn">' + esc(state.billNotice) + '</p>' : '') +
      (state.billError ? '<p class="py-1 text-danger">' + esc(state.billError) + '</p>' : '') +
      '<div class="flex justify-between py-0.5"><span>Subtotal</span><span>' + rp(t.subtotal) + '</span></div>' +
      '<div class="flex justify-between py-0.5"><span>Tax ' + taxPercent(state.taxRateBp || 0) + '%</span><span>' + rp(t.tax) + '</span></div>' +
      '<div class="paper-rule my-2"></div>' +
      '<div class="flex justify-between text-body font-bold"><span>Total</span><span>' + rp(t.total) + '</span></div>' +
      '<button class="btn-primary mt-3 w-full" data-action="complete"' +
      (empty || state.saving ? ' disabled' : '') + '>Complete sale</button>' +
      '</div><div class="paper-edge"></div>';
  }

  function renderSell() {
    var html = viewOpen('sell') + demoBanner();
    html += '<div class="flex items-center justify-between px-4 pt-3 sm:px-6 sm:pt-4">' +
      '<h1 class="text-heading">Sell</h1></div>';
    if (state.load === 'loading') {
      html += '<div class="sm:grid sm:grid-cols-3 sm:gap-6 sm:px-6 sm:py-4">' +
        '<div class="sm:col-span-2">' + skeletonTiles(8) + '</div></div>';
    } else if (state.load === 'error') {
      html += errorState(state.errorText, 'Your bill is kept.');
    } else if (state.products.length === 0) {
      html += '<div class="state-empty"><p class="font-medium">No products yet</p>' +
        '<p class="text-small text-muted">Add what your shop sells, then tap it here to ring it up.</p>' +
        '<a class="btn-primary mt-2" href="#/products">Add product</a></div>';
    } else {
      var billCol = '<div class="hidden sm:block">' + billPaper() + '</div>';
      html += '<div class="sm:grid sm:grid-cols-3 sm:gap-6 sm:px-6 sm:py-4">' +
        '<div class="sm:col-span-2">' + sellTiles() + '</div>' + billCol + '</div>';
      // Phone: a bar above the tab strip; View bill opens the sheet.
      var t = billTotals();
      html += '<div class="fixed inset-x-0 z-30 border-t border-dashed border-muted bg-paper px-4 py-3 sm:hidden"' +
        ' style="bottom: calc(2.75rem + env(safe-area-inset-bottom)); padding-bottom: calc(0.75rem + env(safe-area-inset-bottom))">' +
        '<div class="flex items-center justify-between">' +
        '<div class="font-mono text-small"><span class="block text-muted">Bill, ' + t.count + (t.count === 1 ? ' item' : ' items') + '</span>' +
        '<span class="text-body font-bold">' + rp(t.total) + '</span></div>' +
        '<button class="btn-primary" data-action="open-sheet">View bill</button>' +
        '</div></div>';
      if (state.sheetOpen) {
        html += '<div class="fixed inset-0 z-50 flex items-end sm:hidden">' +
          '<button class="absolute inset-0 bg-fg/40" data-action="close-sheet" aria-label="Close bill"></button>' +
          '<div class="sheet-in relative w-full px-2 pb-2">' + billPaper() + '</div>' +
          '</div>';
      }
    }
    main.innerHTML = html + '</div>';
  }

  // ── Products ───────────────────────────────────────────────────────────

  function stockCell(stock) {
    if (stock === 0) return '<span class="text-small font-medium text-warn">Sold out</span>';
    if (stock <= 5) return '<span class="text-small font-medium text-warn">Low stock, ' + stock + '</span>';
    return '<span class="text-small text-muted" style="font-variant-numeric:tabular-nums">' + stock + ' in stock</span>';
  }

  function renderProducts() {
    var html = viewOpen('products') + demoBanner();
    html += '<div class="flex items-center justify-between px-4 pt-3 sm:px-6 sm:pt-4">' +
      '<h1 class="text-heading">Products</h1>' +
      '<button class="btn-primary" data-action="add-product">Add product</button></div>';
    if (state.load === 'loading') {
      html += '<div class="p-4 sm:px-6">' + skeletonRows(6) + '</div>';
    } else if (state.load === 'error') {
      html += errorState(state.errorText, '');
    } else if (state.products.length === 0) {
      html += '<div class="state-empty"><p class="font-medium">No products yet</p>' +
        '<p class="text-small text-muted">Add what your shop sells with its price and stock.</p>' +
        '<button class="btn-primary mt-2" data-action="add-product">Add product</button></div>';
    } else {
      var rows = '';
      state.products.forEach(function (p) {
        rows += '<li><button class="list-row w-full text-left" data-edit="' + p.id + '">' +
          '<span class="flex-1"><span class="block font-medium">' + esc(p.name) + '</span>' +
          '<span class="text-small text-muted">' + rp(p.price) + '</span></span>' +
          stockCell(p.stock) + '</button></li>';
      });
      html += '<p class="section-label mt-2">' + state.products.length +
        (state.products.length === 1 ? ' product' : ' products') + '</p>' +
        '<div class="px-4 sm:px-6"><ul class="list">' + rows + '</ul></div>' +
        '<p class="section-label mt-6">Tax</p>' +
        '<div class="px-4 sm:px-6"><ul class="list">' +
        '<li class="list-row"><span class="flex-1"><span class="block font-medium">Tax rate</span>' +
        '<span class="text-small text-muted">Added to every new bill</span></span>' +
        '<button class="btn-secondary" data-action="edit-tax">' + taxPercent(state.taxRateBp || 0) + '%</button></li>' +
        '</ul></div>';
    }
    html += formHtml();
    main.innerHTML = html + '</div>';
  }

  function formHtml() {
    if (!state.form) return '';
    var f = state.form;
    var head = f.kind === 'product'
      ? (f.product ? 'Edit product' : 'Add product')
      : 'Tax rate';
    var body;
    if (f.kind === 'product') {
      var v = f.values || f.product || { name: '', price: '', stock: '' };
      body = '<label class="mb-1 block text-small font-medium">Name</label>' +
        '<input class="field" name="name" value="' + esc(v.name) + '" placeholder="e.g. Rice 1 kg" maxlength="80">' +
        fieldErr('name') +
        '<label class="mb-1 mt-4 block text-small font-medium">Price (Rp)</label>' +
        '<input class="field" name="price" inputmode="numeric" value="' + esc(v.price) + '" placeholder="e.g. 15000">' +
        fieldErr('price') +
        '<label class="mb-1 mt-4 block text-small font-medium">Stock</label>' +
        '<input class="field" name="stock" inputmode="numeric" value="' + esc(v.stock) + '" placeholder="e.g. 20">' +
        fieldErr('stock') +
        '<button class="btn-primary mt-6 w-full" data-action="save-product">Save product</button>';
    } else {
      body = '<label class="mb-1 block text-small font-medium">Tax rate (%)</label>' +
        '<input class="field" name="percent" inputmode="decimal" value="' +
        esc(f.percent !== undefined ? f.percent : taxPercent(state.taxRateBp || 0)) +
        '" placeholder="e.g. 11">' +
        fieldErr('taxRateBp') +
        '<button class="btn-primary mt-6 w-full" data-action="save-tax">Save tax rate</button>';
    }
    return '<div class="fixed inset-0 z-50 flex items-end justify-center sm:items-center">' +
      '<button class="absolute inset-0 bg-fg/40" data-action="close-form" aria-label="Close form"></button>' +
      '<div class="card sheet-in relative w-full rounded-b-none p-4 sm:max-w-sm sm:rounded-b-xl">' +
      '<h2 class="text-heading mb-4">' + head + '</h2>' + body + '</div></div>';
  }

  function fieldErr(field) {
    return state.formErrors[field]
      ? '<p class="mt-1 text-small text-danger">' + esc(state.formErrors[field]) + '</p>'
      : '';
  }

  // ── Sales ──────────────────────────────────────────────────────────────

  function renderSales() {
    var html = viewOpen('sales') + demoBanner();
    html += '<div class="px-4 pt-3 sm:px-6 sm:pt-4"><h1 class="text-heading">Sales</h1></div>';
    if (state.load === 'loading') {
      html += '<div class="p-4 sm:px-6">' + skeletonRows(6) + '</div>';
    } else if (state.load === 'error') {
      html += errorState(state.errorText, '');
    } else if (state.sales.length === 0) {
      html += '<div class="state-empty"><p class="font-medium">No sales yet</p>' +
        '<p class="text-small text-muted">Completed sales and their receipts show up here.</p>' +
        '<a class="btn-primary mt-2" href="#/sell">Start selling</a></div>';
    } else {
      var rows = '';
      state.sales.forEach(function (s) {
        rows += '<li><a class="list-row" href="#/sales/' + s.id + '">' +
          '<span class="flex-1"><span class="block font-medium">Receipt ' + esc(receiptNo(s.id)) + '</span>' +
          '<span class="text-small text-muted">' + esc(fmtDate(s.createdAt)) + '</span></span>' +
          '<span class="text-right"><span class="block font-medium" style="font-variant-numeric:tabular-nums">' + rp(s.total) + '</span>' +
          '<span class="text-small text-muted">' + s.itemCount + (s.itemCount === 1 ? ' item' : ' items') + '</span></span>' +
          '</a></li>';
      });
      html += '<div class="p-4 sm:px-6"><ul class="list">' + rows + '</ul></div>';
    }
    main.innerHTML = html + '</div>';
  }

  // ── Receipt ────────────────────────────────────────────────────────────

  function renderReceipt() {
    var html = viewOpen('receipt') + demoBanner();
    html += '<div class="flex items-center gap-3 px-4 pt-3 sm:px-6 sm:pt-4">' +
      '<a class="btn-secondary" href="#/sales">Sales</a>' +
      '<h1 class="text-heading">Receipt</h1></div>';
    if (state.load === 'loading') {
      html += '<div class="p-4"><div class="mx-auto max-w-sm space-y-2">' +
        '<div class="skeleton h-24 w-full"></div><div class="skeleton h-40 w-full"></div></div></div>';
    } else if (state.load === 'error') {
      html += state.errorText === 'notfound'
        ? '<div class="state-error"><p class="font-medium">This receipt doesn\'t exist</p>' +
          '<a class="btn-secondary mt-2" href="#/sales">Back to Sales</a></div>'
        : errorState(state.errorText, '');
    } else {
      var s = state.sale;
      var lines = s.items.map(function (it) {
        return '<div class="mt-1 break-words">' + esc(it.name) + '</div>' +
          '<div class="flex justify-between"><span>&nbsp;&nbsp;' + it.qty + ' x ' +
          it.unitPrice.toLocaleString('id-ID') + '</span>' +
          '<span style="font-variant-numeric:tabular-nums">' + it.lineTotal.toLocaleString('id-ID') + '</span></div>';
      }).join('');
      html += '<div class="p-4">' +
        '<div class="paper receipt mx-auto max-w-sm rounded-t-xl p-4">' +
        '<div class="text-center font-bold">KasirKU</div>' +
        '<div class="text-center">Receipt ' + esc(receiptNo(s.id)) + '</div>' +
        '<div class="text-center">' + esc(fmtDate(s.createdAt)) + '</div>' +
        '<div class="text-center break-words">Cashier: ' + esc(s.cashier) + '</div>' +
        '<div class="paper-rule my-2"></div>' + lines +
        '<div class="paper-rule my-2"></div>' +
        '<div class="flex justify-between"><span>Subtotal</span><span>' + rp(s.subtotal) + '</span></div>' +
        '<div class="flex justify-between"><span>Tax ' + taxPercent(s.taxRateBp) + '%</span><span>' + rp(s.tax) + '</span></div>' +
        '<div class="paper-rule my-2"></div>' +
        '<div class="flex justify-between text-body font-bold"><span>Total</span><span>' + rp(s.total) + '</span></div>' +
        '<div class="paper-rule my-2"></div>' +
        '<div class="text-center">Thank you</div>' +
        '</div><div class="paper-edge mx-auto max-w-sm"></div>' +
        '<div class="mx-auto flex max-w-sm gap-3 pt-4">' +
        '<button class="btn-primary flex-1" data-action="print">Print receipt</button>' +
        '<a class="btn-secondary flex-1" href="#/sell">New sale</a>' +
        '</div></div>';
    }
    main.innerHTML = html + '</div>';
  }

  // ── Data loading ───────────────────────────────────────────────────────

  function loadSell() {
    state.load = 'loading';
    render();
    Promise.all([api('/api/products'), api('/api/settings')]).then(function (r) {
      state.products = r[0];
      state.taxRateBp = r[1].taxRateBp;
      state.load = 'ok';
    }).catch(function (err) {
      state.load = 'error';
      state.errorText = 'Couldn\'t load the products. Everything else still works.';
    }).then(render);
  }

  function loadProducts() {
    state.load = 'loading';
    render();
    Promise.all([api('/api/products'), api('/api/settings')]).then(function (r) {
      state.products = r[0];
      state.taxRateBp = r[1].taxRateBp;
      state.load = 'ok';
    }).catch(function (err) {
      state.load = 'error';
      state.errorText = 'Couldn\'t load the products.';
    }).then(render);
  }

  function loadSales() {
    state.load = 'loading';
    render();
    api('/api/sales').then(function (rows) {
      state.sales = rows;
      state.load = 'ok';
    }).catch(function () {
      state.load = 'error';
      state.errorText = 'Couldn\'t load the sales.';
    }).then(render);
  }

  function loadReceipt(id) {
    state.load = 'loading';
    render();
    api('/api/sales/' + id).then(function (sale) {
      state.sale = sale;
      state.load = 'ok';
    }).catch(function (err) {
      state.load = 'error';
      state.errorText = err.status === 404 ? 'notfound' : 'Couldn\'t load this receipt.';
    }).then(render);
  }

  // ── Router ─────────────────────────────────────────────────────────────

  function navigate() {
    var hash = location.hash || '#/sell';
    state.form = null;
    state.formErrors = {};
    state.sheetOpen = false;
    if (hash.indexOf('#/products') === 0) {
      state.route = 'products';
      loadProducts();
    } else if (hash.indexOf('#/sales/') === 0) {
      state.route = 'receipt';
      loadReceipt(hash.slice('#/sales/'.length));
    } else if (hash.indexOf('#/sales') === 0) {
      state.route = 'sales';
      loadSales();
    } else {
      state.route = 'sell';
      loadSell();
    }
  }

  window.addEventListener('hashchange', navigate);

  // ── Actions ────────────────────────────────────────────────────────────

  function changeQty(id, delta) {
    var p = state.products.find(function (x) { return x.id === id; });
    if (!p) return;
    var qty = (state.bill.get(id) || 0) + delta;
    if (qty <= 0) state.bill.delete(id);
    else state.bill.set(id, Math.min(qty, p.stock));
    render();
  }

  function completeSale() {
    if (state.saving || state.bill.size === 0) return;
    state.saving = true;
    state.billError = '';
    state.billNotice = '';
    render();
    var items = [];
    state.bill.forEach(function (qty, productId) {
      items.push({ productId: productId, qty: qty });
    });
    api('/api/sales', { method: 'POST', body: { items: items } }).then(function (sale) {
      state.bill.clear();
      state.billNotice = '';
      state.billError = '';
      state.saving = false;
      // Stock changed under us: refresh what the tiles show.
      api('/api/products').then(function (rows) { state.products = rows; render(); });
      location.hash = '#/sales/' + sale.id;
    }).catch(function (err) {
      state.saving = false;
      if (err.status === 409 && err.body && Array.isArray(err.body.items)) {
        err.body.items.forEach(function (short) {
          var p = state.products.find(function (x) { return x.id === short.productId; });
          if (p) p.stock = short.stock;
          var qty = state.bill.get(short.productId) || 0;
          if (qty > short.stock) {
            if (short.stock === 0) state.bill.delete(short.productId);
            else state.bill.set(short.productId, short.stock);
          }
          state.billNotice = 'Only ' + short.stock + ' left of ' + short.name;
        });
      } else if (err.status === 401) {
        state.billError = 'Make an account to complete sales. Your bill is kept.';
      } else {
        state.billError = 'The sale didn\'t go through. Your bill is kept.';
      }
      render();
    });
  }

  function saveProduct(card) {
    var val = function (name) { return card.querySelector('input[name="' + name + '"]').value; };
    var body = {
      name: val('name').trim(),
      price: Number(val('price')),
      stock: Number(val('stock')),
    };
    var f = state.form;
    var req = f.product
      ? api('/api/products/' + f.product.id, { method: 'PUT', body: body })
      : api('/api/products', { method: 'POST', body: body });
    req.then(function () {
      state.form = null;
      state.formErrors = {};
      return api('/api/products').then(function (rows) {
        state.products = rows;
        state.load = 'ok';
        render();
      });
    }).catch(function (err) {
      if (err.status === 400 && err.body && err.body.field) {
        state.formErrors[err.body.field] = err.body.error;
      } else if (err.status === 401) {
        state.formErrors.name = 'Make an account to save products.';
      } else {
        state.formErrors.name = 'Saving failed. Try again.';
      }
      // Re-open the form with the values the person typed.
      openForm('product', f.product, {
        name: val('name'), price: val('price'), stock: val('stock'),
      });
    });
  }

  function saveTax(card) {
    var input = card.querySelector('input[name="percent"]');
    var pct = Number(input.value);
    var bp = Math.round(pct * 100);
    api('/api/settings', { method: 'PUT', body: { taxRateBp: bp } }).then(function (r) {
      state.taxRateBp = r.taxRateBp;
      state.form = null;
      state.formErrors = {};
      render();
    }).catch(function (err) {
      var msg = err.status === 400 && err.body ? err.body.error : 'Saving failed. Try again.';
      if (err.status === 401) msg = 'Make an account to change the tax rate.';
      state.formErrors.taxRateBp = msg;
      openForm('tax', null, { percent: input.value });
    });
  }

  function openForm(kind, product, values) {
    state.formErrors = {};
    state.form = { kind: kind, product: product };
    if (values) {
      if (kind === 'product') state.form.values = values;
      else state.form.percent = values.percent;
    }
    render();
  }

  main.addEventListener('click', function (e) {
    var t = e.target.closest('[data-product], [data-inc], [data-dec], [data-action], [data-edit]');
    if (!t) return;
    if (t.hasAttribute('disabled')) return;

    if (t.dataset.product) {
      changeQty(Number(t.dataset.product), 1);
    } else if (t.dataset.inc) {
      changeQty(Number(t.dataset.inc), 1);
    } else if (t.dataset.dec) {
      changeQty(Number(t.dataset.dec), -1);
    } else if (t.dataset.edit) {
      var p = state.products.find(function (x) { return x.id === Number(t.dataset.edit); });
      if (p) openForm('product', p);
    } else if (t.dataset.action === 'retry') {
      navigate();
    } else if (t.dataset.action === 'open-sheet') {
      state.sheetOpen = true;
      render();
    } else if (t.dataset.action === 'close-sheet') {
      state.sheetOpen = false;
      render();
    } else if (t.dataset.action === 'complete') {
      completeSale();
    } else if (t.dataset.action === 'add-product') {
      openForm('product', null);
    } else if (t.dataset.action === 'edit-tax') {
      openForm('tax', null);
    } else if (t.dataset.action === 'close-form') {
      state.form = null;
      state.formErrors = {};
      render();
    } else if (t.dataset.action === 'save-product') {
      saveProduct(t.closest('.card'));
    } else if (t.dataset.action === 'save-tax') {
      saveTax(t.closest('.card'));
    } else if (t.dataset.action === 'print') {
      window.print();
    }
  });

  navigate();
})();