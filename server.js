const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── KasirKU data model ──────────────────────────────────────────────────────
// Money is whole rupiah (integer, never a float) and tax is a whole percent.
// A sale stores each item's name and price as they were at sale time, so a
// later product edit never rewrites an old receipt.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id         serial PRIMARY KEY,
      name       text NOT NULL,
      price      integer NOT NULL CHECK (price >= 0),
      stock      integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales (
      id               serial PRIMARY KEY,
      subtotal         integer NOT NULL,
      tax_rate         integer NOT NULL,
      tax_amount       integer NOT NULL,
      total            integer NOT NULL,
      cashier_username text,
      created_at       timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id           serial PRIMARY KEY,
      sale_id      integer NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id   integer REFERENCES products(id) ON DELETE SET NULL,
      product_name text NOT NULL,
      unit_price   integer NOT NULL,
      quantity     integer NOT NULL CHECK (quantity > 0)
    );
    CREATE TABLE IF NOT EXISTS shop_settings (
      key   text PRIMARY KEY,
      value text NOT NULL
    );
    INSERT INTO shop_settings (key, value) VALUES ('tax_rate', '11')
      ON CONFLICT (key) DO NOTHING;
  `);
  if (IS_STAGING) await seedStaging();
}

// Tax rounds once, on the server, to the nearest rupiah.
function taxFor(subtotal, rate) {
  return Math.round((subtotal * rate) / 100);
}

// Body numbers arrive as JSON numbers or strings; accept either, whole
// numbers only, never floats.
function asWholeNumber(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

app.get('/api/products', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, price, stock, created_at FROM products ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/products failed: ' + err.message);
    res.status(500).json({ error: 'Could not load products' });
  }
});

function validProduct(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const price = asWholeNumber(body.price);
  const stock = asWholeNumber(body.stock);
  if (!name || name.length > 100) return { error: 'Name must be 1 to 100 characters.' };
  if (price === null || price < 0) return { error: 'Price must be a whole number of rupiah, 0 or more.' };
  if (stock === null || stock < 0) return { error: 'Stock must be a whole number, 0 or more.' };
  return { name, price, stock };
}

app.post('/api/products', async (req, res) => {
  const v = validProduct(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const { rows } = await pool.query(
      'INSERT INTO products (name, price, stock, created_at) VALUES ($1, $2, $3, $4) RETURNING id, name, price, stock, created_at',
      [v.name, v.price, v.stock, req.now]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/products failed: ' + err.message);
    res.status(500).json({ error: 'Could not save the product' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const id = asWholeNumber(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Product not found' });
  const v = validProduct(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const { rows } = await pool.query(
      'UPDATE products SET name = $1, price = $2, stock = $3 WHERE id = $4 RETURNING id, name, price, stock, created_at',
      [v.name, v.price, v.stock, id]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/products failed: ' + err.message);
    res.status(500).json({ error: 'Could not save the product' });
  }
});

// Newest first, with how many units the sale rang up.
app.get('/api/sales', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.subtotal, s.tax_rate, s.tax_amount, s.total,
             s.cashier_username, s.created_at,
             COALESCE(SUM(si.quantity), 0)::int AS item_count
      FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 200`);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/sales failed: ' + err.message);
    res.status(500).json({ error: 'Could not load sales' });
  }
});

app.get('/api/sales/:id', async (req, res) => {
  const id = asWholeNumber(req.params.id);
  if (id === null) return res.status(404).json({ error: 'Sale not found' });
  try {
    const { rows } = await pool.query(
      'SELECT id, subtotal, tax_rate, tax_amount, total, cashier_username, created_at FROM sales WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Sale not found' });
    const items = await pool.query(
      'SELECT product_id, product_name, unit_price, quantity FROM sale_items WHERE sale_id = $1 ORDER BY id', [id]);
    res.json({ ...rows[0], items: items.rows });
  } catch (err) {
    console.error('GET /api/sales/:id failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the sale' });
  }
});

// Checkout: stock, the sale and its items commit together or not at all.
// The conditional UPDATE keeps two cashiers from overselling the last unit:
// the loser's whole transaction rolls back and it answers 409 with the
// product's name.
app.post('/api/sales', async (req, res) => {
  const raw = Array.isArray((req.body || {}).items) ? req.body.items : [];
  const wanted = new Map(); // product_id -> quantity, duplicates merged
  for (const it of raw) {
    const pid = asWholeNumber(it && it.product_id);
    const qty = asWholeNumber(it && it.quantity);
    if (pid === null || qty === null || qty < 1) {
      return res.status(400).json({ error: 'Each line needs a product and a whole quantity of 1 or more.' });
    }
    wanted.set(pid, (wanted.get(pid) || 0) + qty);
  }
  if (!wanted.size) return res.status(400).json({ error: 'The cart is empty.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const settings = await client.query("SELECT value FROM shop_settings WHERE key = 'tax_rate'");
    const taxRate = parseInt(settings.rows[0].value, 10) || 0;

    const lines = []; // { product_id, product_name, unit_price, quantity }
    let subtotal = 0;
    for (const [pid, qty] of wanted) {
      const up = await client.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING name, price',
        [qty, pid]);
      if (!up.rows.length) {
        const known = await client.query('SELECT name FROM products WHERE id = $1', [pid]);
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'out_of_stock',
          product: known.rows.length ? known.rows[0].name : 'A product in the cart',
          message: (known.rows.length ? known.rows[0].name : 'A product in the cart') + ' does not have that much stock left.',
        });
      }
      const { name, price } = up.rows[0];
      lines.push({ product_id: pid, product_name: name, unit_price: price, quantity: qty });
      subtotal += price * qty;
    }
    const taxAmount = taxFor(subtotal, taxRate);
    const sale = await client.query(
      'INSERT INTO sales (subtotal, tax_rate, tax_amount, total, cashier_username, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [subtotal, taxRate, taxAmount, subtotal + taxAmount, req.user ? req.user.username : null, req.now]);
    const saleId = sale.rows[0].id;
    for (const l of lines) {
      await client.query(
        'INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, quantity) VALUES ($1, $2, $3, $4, $5)',
        [saleId, l.product_id, l.product_name, l.unit_price, l.quantity]);
    }
    await client.query('COMMIT');

    const done = await pool.query(
      'SELECT id, subtotal, tax_rate, tax_amount, total, created_at FROM sales WHERE id = $1', [saleId]);
    const items = await pool.query(
      'SELECT product_id, product_name, unit_price, quantity FROM sale_items WHERE sale_id = $1 ORDER BY id', [saleId]);
    res.status(201).json({ ...done.rows[0], items: items.rows });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/sales failed: ' + err.message);
    res.status(500).json({ error: 'Could not complete the sale' });
  } finally {
    client.release();
  }
});

app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM shop_settings WHERE key = 'tax_rate'");
    res.json({ tax_rate: parseInt(rows[0].value, 10) || 0, staging: IS_STAGING });
  } catch (err) {
    console.error('GET /api/settings failed: ' + err.message);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

app.put('/api/settings', async (req, res) => {
  const rate = asWholeNumber((req.body || {}).tax_rate);
  if (rate === null || rate < 0 || rate > 100) {
    return res.status(400).json({ error: 'Tax rate must be a whole percent between 0 and 100.' });
  }
  try {
    await pool.query(
      "INSERT INTO shop_settings (key, value) VALUES ('tax_rate', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [String(rate)]);
    res.json({ tax_rate: rate, staging: IS_STAGING });
  } catch (err) {
    console.error('PUT /api/settings failed: ' + err.message);
    res.status(500).json({ error: 'Could not save the tax rate' });
  }
});

// Staging preview only: a lived-in fake shop so the populated screens can be
// seen. Idempotent, fixed ids, obviously fake, and never run in production.
// Seed sales are dated relative to the moment the container boots; request
// time (`req.now`) still governs everything the running app displays.
async function seedStaging() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM products');
  if (rows[0].n > 0) return;
  const products = [
    [1, 'Indomie Goreng', 3500, 48],
    [2, 'Teh Botol 450ml', 5000, 24],
    [3, 'Aqua 600ml', 4000, 36],
    [4, 'Kopi Kapal Api 165g', 12000, 10],
    [5, 'Beras Pandan Wangi 5kg', 72000, 6],
    [6, 'Minyak Goreng 1L', 18000, 14],
    [7, 'Gula Pasir 1kg', 15500, 20],
    [8, 'Sabun Mandi Batang', 4500, 3],
  ];
  for (const [id, name, price, stock] of products) {
    await pool.query(
      'INSERT INTO products (id, name, price, stock, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
      [id, name, price, stock, new Date()]);
  }
  const settings = await pool.query("SELECT value FROM shop_settings WHERE key = 'tax_rate'");
  const rate = parseInt(settings.rows[0].value, 10) || 0;
  const boot = new Date();
  const hoursAgo = h => new Date(boot.getTime() - h * 3600_000);
  // [id, hours ago, [[product_id, quantity], ...]]
  const sales = [
    [1, 5, [[1, 2], [4, 1], [5, 1]]],
    [2, 28, [[7, 1]]],
    [3, 52, [[2, 1], [8, 1]]],
    [4, 70, [[3, 1], [6, 1], [1, 1]]],
  ];
  for (const [id, h, items] of sales) {
    const at = hoursAgo(h);
    let subtotal = 0;
    const lines = [];
    for (const [pid, qty] of items) {
      const p = products.find(x => x[0] === pid);
      subtotal += p[2] * qty;
      lines.push([pid, p[1], p[2], qty]);
    }
    const tax = taxFor(subtotal, rate);
    await pool.query(
      'INSERT INTO sales (id, subtotal, tax_rate, tax_amount, total, cashier_username, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
      [id, subtotal, rate, tax, subtotal + tax, 'staging-demo-user', at]);
    for (const [pid, name, price, qty] of lines) {
      await pool.query(
        'INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, quantity) VALUES ($1, $2, $3, $4, $5)',
        [id, pid, name, price, qty]);
    }
  }
  await pool.query("SELECT setval('products_id_seq', (SELECT MAX(id) FROM products))");
  await pool.query("SELECT setval('sales_id_seq', (SELECT MAX(id) FROM sales))");
  await pool.query("SELECT setval('sale_items_id_seq', (SELECT MAX(id) FROM sale_items))");
}

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/kasirku-0f8fdb/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/kasirku-0f8fdb/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
