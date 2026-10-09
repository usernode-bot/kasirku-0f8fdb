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

// ── KasirKU data ──────────────────────────────────────────────────────────
// Money is whole rupiah (no cents) stored as integers. Tax is a single
// shop-wide rate in basis points (1100 = 11%); tax on a sale is
// Math.round(subtotal * rate / 10000). `sales` and `sale_items` are marked
// `staging:private` (financial data): the platform's staging copy of the
// real shop never carries them — the staging preview shows only the
// made-up demo shop seeded below.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id serial PRIMARY KEY,
      name text NOT NULL,
      price integer NOT NULL CHECK (price >= 0),
      stock integer NOT NULL CHECK (stock >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    );
    INSERT INTO settings (key, value) VALUES ('tax_rate_bp', '1100')
      ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS sales (
      id serial PRIMARY KEY,
      subtotal integer NOT NULL,
      tax_rate_bp integer NOT NULL,
      tax integer NOT NULL,
      total integer NOT NULL,
      item_count integer NOT NULL,
      cashier text NOT NULL,
      created_at timestamptz NOT NULL
    );
    COMMENT ON TABLE sales IS 'staging:private';
    CREATE TABLE IF NOT EXISTS sale_items (
      id serial PRIMARY KEY,
      sale_id integer NOT NULL REFERENCES sales(id),
      product_id integer REFERENCES products(id),
      name text NOT NULL,
      unit_price integer NOT NULL,
      qty integer NOT NULL CHECK (qty > 0),
      line_total integer NOT NULL
    );
    COMMENT ON TABLE sale_items IS 'staging:private';
    CREATE INDEX IF NOT EXISTS sales_created_at_idx ON sales (created_at DESC);
  `);
}

// Tax is rounded to the nearest rupiah; the total is subtotal plus tax.
function computeTax(subtotal, taxRateBp) {
  const tax = Math.round(subtotal * taxRateBp / 10000);
  return { tax, total: subtotal + tax };
}

// ── Demo shop (staging preview only) ─────────────────────────────────────
// Nothing here runs without `?demo=1` on a staging container, and the seed
// is memoised per process: the first `demo=1` request seeds, the rest reuse
// it. Generic goods, fixed ids so the demo is stable across restarts.
// Seeded sales do NOT reduce demo stock — the shop is shown as-is.
const DEMO_PRODUCTS = [
  [900001, 'Instant noodles, chicken', 3500, 42],
  [900002, 'Iced tea bottle', 5000, 18],
  [900003, 'Eggs, 10 pack', 28000, 3],
  [900004, 'Rice 1 kg', 15000, 25],
  [900005, 'Cooking oil 1 L', 19000, 0],
  [900006, 'Mineral water 600 ml', 4000, 60],
  [900007, 'Sugar 1 kg', 17500, 12],
  [900008, 'Coffee sachet', 2000, 80],
  [900009, 'Bread loaf', 14000, 2],
  [900010, 'Sweet soy sauce', 9500, 20],
  [900011, 'Chili sauce', 8000, 15],
  [900012, 'Bar soap', 4500, 30],
  [900013, 'Toothpaste', 12000, 10],
  [900014, 'Biscuits', 6500, 22],
];
// Each demo sale: [id, hoursAgo, lines[[productIndex(1-based), qty], …]].
// Spreads twelve sales over the past seven days from the seed moment.
const DEMO_SALES = [
  [900001, 162, [[1, 2], [6, 1]]],
  [900002, 148, [[4, 1]]],
  [900003, 130, [[1, 1], [8, 3], [14, 1]]],
  [900004, 112, [[2, 2], [10, 1]]],
  [900005, 96, [[6, 2], [12, 1], [13, 1]]],
  [900006, 79, [[4, 2], [7, 1]]],
  [900007, 61, [[8, 2], [11, 1], [14, 2]]],
  [900008, 44, [[1, 4], [6, 2]]],
  [900009, 31, [[9, 1], [2, 1]]],
  [900010, 22, [[10, 1], [12, 2]]],
  [900011, 9, [[1, 3], [3, 1]]],
  [900012, 2, [[6, 1], [8, 2], [14, 1]]],
];
const DEMO_CASHIER = 'staging-demo-cashier';

async function seedDemo(now) {
  for (const [id, name, price, stock] of DEMO_PRODUCTS) {
    await pool.query(
      `INSERT INTO products (id, name, price, stock, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING`,
      [id, name, price, stock, now]
    );
  }
  for (const [id, hoursAgo, lines] of DEMO_SALES) {
    const created = new Date(now.getTime() - hoursAgo * 3600_000);
    const items = lines.map(([idx, qty]) => {
      const [, name, price] = DEMO_PRODUCTS[idx - 1];
      return { productId: 900000 + idx, name, price, qty, lineTotal: price * qty };
    });
    const subtotal = items.reduce((s, it) => s + it.lineTotal, 0);
    const { tax, total } = computeTax(subtotal, 1100);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO sales (id, subtotal, tax_rate_bp, tax, total, item_count, cashier, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, subtotal, 1100, tax, total, items.reduce((s, it) => s + it.qty, 0), DEMO_CASHIER, created]
      );
      if (inserted.rows.length) {
        for (const it of items) {
          await client.query(
            `INSERT INTO sale_items (sale_id, product_id, name, unit_price, qty, line_total)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, it.productId, it.name, it.price, it.qty, it.lineTotal]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

let demoSeed = null;
function ensureDemo(now) {
  if (!demoSeed) {
    demoSeed = seedDemo(now).catch(err => {
      demoSeed = null; // allow a later request to try again
      throw err;
    });
  }
  return demoSeed;
}

// Demo seeding runs before any /api handler, only on staging, only when the
// preview was opened with ?demo=1.
app.use('/api', (req, res, next) => {
  if (IS_STAGING && req.query.demo === '1') {
    ensureDemo(req.now).then(() => next(), next);
  } else {
    next();
  }
});

// ── API ───────────────────────────────────────────────────────────────────
function productProblem(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 80) {
    return { error: 'Name must be 1 to 80 characters.', field: 'name' };
  }
  if (!Number.isInteger(body.price) || body.price < 0 || body.price > 1_000_000_000) {
    return { error: 'Price must be a whole number from 0 to 1,000,000,000.', field: 'price' };
  }
  if (!Number.isInteger(body.stock) || body.stock < 0 || body.stock > 1_000_000) {
    return { error: 'Stock must be a whole number from 0 to 1,000,000.', field: 'stock' };
  }
  return null;
}

app.get('/api/products', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, price, stock FROM products ORDER BY lower(name)'
  );
  res.json(rows);
});

app.post('/api/products', async (req, res) => {
  const problem = productProblem(req.body || {});
  if (problem) return res.status(400).json(problem);
  const { name, price, stock } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO products (name, price, stock, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4) RETURNING id, name, price, stock`,
    [name, price, stock, req.now]
  );
  res.status(201).json(rows[0]);
});

app.put('/api/products/:id', async (req, res) => {
  const problem = productProblem(req.body || {});
  if (problem) return res.status(400).json(problem);
  const { name, price, stock } = req.body;
  const { rows } = await pool.query(
    `UPDATE products SET name = $1, price = $2, stock = $3, updated_at = $4
     WHERE id = $5 RETURNING id, name, price, stock`,
    [name, price, stock, req.now, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
  res.json(rows[0]);
});

app.get('/api/settings', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key = 'tax_rate_bp'`
  );
  res.json({ taxRateBp: rows.length ? parseInt(rows[0].value, 10) : 1100 });
});

app.put('/api/settings', async (req, res) => {
  const bp = (req.body || {}).taxRateBp;
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) {
    return res.status(400).json({
      error: 'Tax rate must be between 0% and 100%.',
      field: 'taxRateBp',
    });
  }
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('tax_rate_bp', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(bp)]
  );
  res.json({ taxRateBp: bp });
});

// Completing a sale: quantities and prices are read from the database under
// row locks, never trusted from the page. Two cashiers racing for the last
// unit: the first wins, the second gets 409 with what is actually left and
// nothing is written.
app.post('/api/sales', async (req, res) => {
  const raw = Array.isArray((req.body || {}).items) ? req.body.items : [];
  if (raw.length < 1 || raw.length > 100) {
    return res.status(400).json({ error: 'A sale needs 1 to 100 lines.' });
  }
  const merged = new Map();
  for (const it of raw) {
    const productId = (it || {}).productId;
    const qty = (it || {}).qty;
    if (!Number.isInteger(productId) || productId < 1) {
      return res.status(400).json({ error: 'Each line needs a product.' });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) {
      return res.status(400).json({ error: 'Each quantity must be 1 to 10000.' });
    }
    merged.set(productId, (merged.get(productId) || 0) + qty);
  }
  const ids = [...merged.keys()];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: products } = await client.query(
      `SELECT id, name, price, stock FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
      [ids]
    );
    const byId = new Map(products.map(p => [p.id, p]));
    const unknown = ids.find(id => !byId.has(id));
    if (unknown !== undefined) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A product on the bill no longer exists.' });
    }
    const short = products
      .filter(p => merged.get(p.id) > p.stock)
      .map(p => ({ productId: p.id, name: p.name, stock: p.stock }));
    if (short.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'insufficient_stock', items: short });
    }
    const { rows: settingRows } = await client.query(
      `SELECT value FROM settings WHERE key = 'tax_rate_bp'`
    );
    const taxRateBp = settingRows.length ? parseInt(settingRows[0].value, 10) : 1100;
    const items = products.map(p => {
      const qty = merged.get(p.id);
      return { productId: p.id, name: p.name, unitPrice: p.price, qty, lineTotal: p.price * qty };
    });
    const subtotal = items.reduce((s, it) => s + it.lineTotal, 0);
    const { tax, total } = computeTax(subtotal, taxRateBp);
    const sale = (
      await client.query(
        `INSERT INTO sales (subtotal, tax_rate_bp, tax, total, item_count, cashier, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [subtotal, taxRateBp, tax, total, items.reduce((s, it) => s + it.qty, 0),
         req.user.username, req.now]
      )
    ).rows[0];
    for (const it of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, name, unit_price, qty, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sale.id, it.productId, it.name, it.unitPrice, it.qty, it.lineTotal]
      );
      await client.query(
        `UPDATE products SET stock = stock - $1 WHERE id = $2`,
        [it.qty, it.productId]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({
      id: sale.id,
      subtotal, taxRateBp, tax, total,
      itemCount: items.reduce((s, it) => s + it.qty, 0),
      cashier: req.user.username,
      createdAt: req.now,
      items: items.map(it => ({
        productId: it.productId, name: it.name, unitPrice: it.unitPrice,
        qty: it.qty, lineTotal: it.lineTotal,
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

app.get('/api/sales', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, created_at, item_count, total FROM sales
     ORDER BY created_at DESC, id DESC LIMIT 100`
  );
  res.json(rows.map(r => ({
    id: r.id, createdAt: r.created_at, itemCount: r.item_count, total: r.total,
  })));
});

app.get('/api/sales/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, subtotal, tax_rate_bp, tax, total, item_count, cashier, created_at
     FROM sales WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Sale not found.' });
  const sale = rows[0];
  const items = (
    await pool.query(
      `SELECT product_id, name, unit_price, qty, line_total FROM sale_items
       WHERE sale_id = $1 ORDER BY id`,
      [sale.id]
    )
  ).rows.map(r => ({
    productId: r.product_id, name: r.name, unitPrice: r.unit_price,
    qty: r.qty, lineTotal: r.line_total,
  }));
  res.json({
    id: sale.id, subtotal: sale.subtotal, taxRateBp: sale.tax_rate_bp,
    tax: sale.tax, total: sale.total, itemCount: sale.item_count,
    cashier: sale.cashier, createdAt: sale.created_at, items,
  });
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

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

// Set when a shutdown signal arrived: /health answers 503 so the platform
// stops sending traffic while the in-flight requests drain.
let shuttingDown = false;

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down: draining connections');
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    const force = setTimeout(() => process.exit(0), 3000);
    server.close(() => {
      clearTimeout(force);
      pool.end().then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });