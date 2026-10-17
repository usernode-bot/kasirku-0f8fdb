// KasirKU API: stores (owned per Homeroom account), product catalog, stock
// adjustments, sales and reports. Every business row belongs to one store and
// every read/write is scoped to the caller's active store. All money is stored
// as whole rupiah (integers). The server always recomputes totals, stock and
// cost of goods from its own data.
const TZ = 'Asia/Jakarta';
const PAYMENT_METHODS = ['cash', 'qris', 'debit', 'transfer', 'bri', 'credit'];
const rp = (n) => 'Rp ' + Math.max(0, Math.round(n)).toLocaleString('id-ID');
const MOVEMENT_TYPES = ['restock', 'return', 'opname'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function int(v, label, { min = 0, max = 2000000000 } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} tidak valid`);
  return n;
}
function text(v, label, { max = 200, required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw bad(`${label} wajib diisi`);
  if (s.length > max) throw bad(`${label} terlalu panjang`);
  return s;
}
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ── Schema ──
// `stores` is the tenant: one row per store, owned by the Homeroom account
// that created it (`owner_id` = req.user.id). Every business table carries a
// `store_id` and every query filters on it. All of these tables are marked
// staging:private (inventory, contact details and financial records), so
// staging copies their schema only and the IS_STAGING seed below fills them.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  owner_id INT,
  name TEXT NOT NULL DEFAULT 'KasirKU',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 11,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS stores_owner_idx ON stores (owner_id);
COMMENT ON TABLE stores IS 'staging:private';

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  name TEXT NOT NULL,
  sku TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Umum',
  cost_price INT NOT NULL DEFAULT 0,
  sell_price INT NOT NULL DEFAULT 0,
  stock INT NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 5,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE products IS 'staging:private';

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  product_id INT NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,
  qty_change INT NOT NULL,
  stock_after INT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE stock_movements IS 'staging:private';

CREATE SEQUENCE IF NOT EXISTS invoice_seq;
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  invoice_no TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cashier TEXT NOT NULL DEFAULT '',
  subtotal INT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'none',
  discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount INT NOT NULL DEFAULT 0,
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_amount INT NOT NULL DEFAULT 0,
  total INT NOT NULL,
  cogs INT NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  paid INT NOT NULL,
  change_amount INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  qty INT NOT NULL,
  list_price INT NOT NULL,
  price INT NOT NULL,
  cost_price INT NOT NULL DEFAULT 0
);
-- Sales and their stores are financial records: staging gets the structure
-- without the rows.
COMMENT ON TABLE sales IS 'staging:private';
COMMENT ON TABLE sale_items IS 'staging:private';

-- Additive migration for databases created before the multi-store change.
ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id);
-- The checkout's own reference for one attempt to pay a cart: a retry with
-- the same reference returns the sale already recorded instead of a second one.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sales_store_client_ref ON sales (store_id, client_ref) WHERE client_ref IS NOT NULL;
-- The store's BRI account, shown at checkout for "Transfer BRI". Empty until
-- the owner fills it in under Profil toko.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS bri_account_no TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS bri_account_name TEXT NOT NULL DEFAULT '';

-- Bayar nanti (credit) sales: who took the goods, and the payments that
-- settle the debt. The outstanding amount is never stored as a balance: it
-- is computed as the customer's credit sales minus their append-only
-- payments, so no row is ever updated and nothing can drift.
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE customers IS 'staging:private';
CREATE UNIQUE INDEX IF NOT EXISTS customers_store_name_uniq ON customers (store_id, lower(name));
-- Set only when payment_method = 'credit'; older sales keep it NULL.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INT REFERENCES customers(id);
CREATE TABLE IF NOT EXISTS debt_payments (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id),
  customer_id INT NOT NULL REFERENCES customers(id),
  amount INT NOT NULL CHECK (amount > 0),
  actor TEXT NOT NULL DEFAULT '',
  client_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE debt_payments IS 'staging:private';
CREATE UNIQUE INDEX IF NOT EXISTS debt_payments_store_client_ref ON debt_payments (store_id, client_ref) WHERE client_ref IS NOT NULL;
`;

// One-time legacy migration: the old single-shop `store_profile` row (id = 1)
// becomes a store, and every existing business row is attached to it. The
// migrated store keeps owner_id NULL (it belongs to nobody) so no account can
// see the pre-existing shared rows; the rows are preserved, never deleted.
async function migrateLegacyStore(pool) {
  const { rows } = await pool.query(
    `SELECT to_regclass('public.store_profile') IS NOT NULL AS present`);
  if (!rows[0].present) return;
  await pool.query(
    `INSERT INTO stores (id, owner_id, name, address, phone, logo_url, tax_percent)
     SELECT 1, NULL, name, address, phone, logo_url, tax_percent FROM store_profile WHERE id = 1
     ON CONFLICT (id) DO NOTHING`);
  for (const t of ['products', 'stock_movements', 'sales', 'sale_items']) {
    await pool.query(`UPDATE ${t} SET store_id = 1 WHERE store_id IS NULL`);
  }
  await pool.query('DROP TABLE store_profile');
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('stores','id'), GREATEST((SELECT MAX(id) FROM stores), 1))`);
}

// SKU is unique per store, not per app. Drop the old global unique constraint
// (which came with the CREATE TABLE) and replace it with a per-store index.
// Runs only when the legacy constraint is still present.
async function migrateSkuUnique(pool) {
  const { rows } = await pool.query(
    `SELECT con.conname, array_agg(att.attname) AS cols
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE rel.relname = 'products' AND con.contype = 'u'
        AND array_length(con.conkey, 1) = 1
        AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) = 'sku'
      GROUP BY con.conname`);
  for (const r of rows) {
    await pool.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS "${r.conname}"`);
  }
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS products_store_sku_uniq ON products (store_id, sku)`);
}

// Obviously fake demo shop for staging previews. Idempotent. Rows belong to a
// fixed fake owner, never the visitor, so the signed-in reviewer still sees the
// honest "Belum ada toko" screen and can create their own stores. The id must
// stay clear of the sign-in fixture account the local launch uses (900001,
// staging-demo-viewer): if the signed-in account owned these rows, the
// first-store screen and the dapp.json checks that pin it could never be seen.
const DEMO_OWNER_ID = 900100;
const DEMO_STORE_1 = 900100;
const DEMO_STORE_2 = 900101;
const DEMO_PRODUCTS = [
  ['DEMO-001', 'Beras Premium 5 kg', 'Sembako', 58000, 68000, 24, 6],
  ['DEMO-002', 'Minyak Goreng 2 L', 'Sembako', 32000, 37500, 18, 6],
  ['DEMO-003', 'Gula Pasir 1 kg', 'Sembako', 14500, 17000, 30, 8],
  ['DEMO-004', 'Telur Ayam 1 kg', 'Sembako', 26000, 30000, 4, 6],
  ['DEMO-005', 'Kopi Sachet Isi 10', 'Minuman', 9500, 12500, 40, 10],
  ['DEMO-006', 'Teh Botol 450 ml', 'Minuman', 4200, 6000, 48, 12],
  ['DEMO-007', 'Air Mineral 600 ml', 'Minuman', 2300, 3500, 72, 24],
  ['DEMO-008', 'Susu UHT Cokelat 200 ml', 'Minuman', 4800, 6500, 3, 10],
  ['DEMO-009', 'Mi Instan Goreng', 'Makanan', 2900, 3800, 100, 30],
  ['DEMO-010', 'Biskuit Kelapa', 'Makanan', 7500, 10000, 22, 8],
  ['DEMO-011', 'Keripik Singkong 150 g', 'Makanan', 8200, 11000, 15, 6],
  ['DEMO-012', 'Sabun Mandi Batang', 'Rumah Tangga', 3000, 4500, 36, 12],
  ['DEMO-013', 'Deterjen Bubuk 800 g', 'Rumah Tangga', 17500, 21500, 0, 5],
  ['DEMO-014', 'Tisu Gulung Isi 4', 'Rumah Tangga', 11000, 14500, 12, 5],
];

async function seedDemo(pool) {
  await pool.query(
    `INSERT INTO stores (id, owner_id, name, address, phone, tax_percent)
     VALUES ($1, $2, 'Staging demo Toko Contoh Sejahtera', 'Jl. Contoh No. 12, Jakarta', '021-5550123', 11)
     ON CONFLICT (id) DO NOTHING`, [DEMO_STORE_1, DEMO_OWNER_ID]);
  await pool.query(
    `INSERT INTO stores (id, owner_id, name, address, phone, tax_percent)
     VALUES ($1, $2, 'Staging demo Cabang Melati', 'Jl. Melati No. 5, Bandung', '022-7770456', 11)
     ON CONFLICT (id) DO NOTHING`, [DEMO_STORE_2, DEMO_OWNER_ID]);
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('stores','id'), GREATEST((SELECT MAX(id) FROM stores), 1))`);
  // Demo store 1 gets an obviously fake BRI account so the filled-in
  // transfer instruction can be seen; store 2 stays without one on purpose.
  await pool.query(
    `UPDATE stores SET bri_account_no = '0000010000000000', bri_account_name = 'Staging Demo Toko'
     WHERE id = $1 AND bri_account_no = ''`,
    [DEMO_STORE_1]);
  for (const [sku, name, category, cost, sell, stock, min] of DEMO_PRODUCTS) {
    await pool.query(
      `INSERT INTO products (store_id, sku, name, category, cost_price, sell_price, stock, min_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (store_id, sku) DO NOTHING`,
      [DEMO_STORE_1, sku, name, category, cost, sell, stock, min]);
  }
  // Two obviously fake customers with unpaid debts for the Piutang list.
  await pool.query(
    `INSERT INTO customers (store_id, name)
     VALUES ($1, 'Staging demo Pak Budi'), ($1, 'Staging demo Bu Sari')
     ON CONFLICT DO NOTHING`, [DEMO_STORE_1]);
  const demoSales = [
    ['DEMO-INV-001', 'cash', 100000, [['DEMO-001', 1], ['DEMO-005', 2]], '30 minutes', null],
    ['DEMO-INV-002', 'qris', 0, [['DEMO-006', 3], ['DEMO-009', 5]], '20 minutes', null],
    ['DEMO-INV-003', 'debit', 0, [['DEMO-002', 1], ['DEMO-003', 2], ['DEMO-010', 1]], '10 minutes', null],
    ['DEMO-INV-004', 'credit', 0, [['DEMO-001', 1], ['DEMO-009', 5]], '5 minutes', 'Staging demo Pak Budi'],
    ['DEMO-INV-005', 'credit', 0, [['DEMO-003', 2]], '2 minutes', 'Staging demo Bu Sari'],
  ];
  for (const [inv, method, cash, lines, ago, customer] of demoSales) {
    const { rows } = await pool.query(
      `SELECT sku, name, sell_price, cost_price, id FROM products WHERE store_id = $1 AND sku = ANY($2)`,
      [DEMO_STORE_1, lines.map((l) => l[0])]);
    const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
    if (lines.some((l) => !by[l[0]])) continue;
    let subtotal = 0; let cogs = 0;
    for (const [sku, qty] of lines) { subtotal += by[sku].sell_price * qty; cogs += by[sku].cost_price * qty; }
    const tax = Math.round(subtotal * 0.11);
    const total = subtotal + tax;
    let customerId = null;
    if (customer) {
      const cr = await pool.query(
        'SELECT id FROM customers WHERE store_id = $1 AND lower(name) = lower($2)', [DEMO_STORE_1, customer]);
      customerId = cr.rows.length ? cr.rows[0].id : null;
    }
    const ins = await pool.query(
      `INSERT INTO sales (store_id, invoice_no, created_at, cashier, subtotal, tax_percent, tax_amount, total, cogs,
         payment_method, paid, change_amount, customer_id)
       VALUES ($1, $2, NOW() - $3::interval, 'staging-demo-kasir', $4, 11, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (invoice_no) DO NOTHING RETURNING id`,
      [DEMO_STORE_1, inv, ago, subtotal, tax, total, cogs, method,
        method === 'credit' ? 0 : method === 'cash' ? Math.max(cash, total) : total,
        method === 'credit' ? 0 : method === 'cash' ? Math.max(cash, total) - total : 0,
        customerId]);
    if (!ins.rows.length) continue;
    for (const [sku, qty] of lines) {
      const p = by[sku];
      await pool.query(
        `INSERT INTO sale_items (store_id, sale_id, product_id, name, sku, qty, list_price, price, cost_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
        [DEMO_STORE_1, ins.rows[0].id, p.id, p.name, p.sku, qty, p.sell_price, p.cost_price]);
    }
  }
  // One partial payment from Pak Budi, so the Piutang list shows a partially
  // paid debt (Rp 56.570 left) and an untouched one. Only when his credit
  // sale was actually seeded, so the payment never exceeds a missing debt.
  await pool.query(
    `INSERT INTO debt_payments (store_id, customer_id, amount, actor, client_ref)
     SELECT $1, c.id, 40000, 'staging-demo-kasir', 'DEMO-PAY-001' FROM customers c
     WHERE c.store_id = $1 AND c.name = 'Staging demo Pak Budi'
       AND EXISTS (SELECT 1 FROM sales s WHERE s.store_id = $1 AND s.invoice_no = 'DEMO-INV-004')
     ON CONFLICT (store_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING`, [DEMO_STORE_1]);
}

function mountApi({ app, pool, IS_STAGING }) {
  const jakartaDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

  async function migrate() {
    await pool.query(SCHEMA);
    await migrateLegacyStore(pool);
    await migrateSkuUnique(pool);
    if (IS_STAGING) await seedDemo(pool);
  }

  const actor = (req) => (req.user && req.user.username) || '';
  const productRow = (r) => ({
    id: r.id, name: r.name, sku: r.sku, category: r.category, costPrice: r.cost_price,
    sellPrice: r.sell_price, stock: r.stock, minStock: r.min_stock,
    low: r.stock < r.min_stock, out: r.stock <= 0,
  });
  const storeRow = (r) => ({
    id: r.id, name: r.name, address: r.address, phone: r.phone, logoUrl: r.logo_url,
    taxPercent: Number(r.tax_percent), briAccountNo: r.bri_account_no || '', briAccountName: r.bri_account_name || '',
    staging: IS_STAGING,
  });
  const saleRow = (r) => ({
    id: r.id, invoiceNo: r.invoice_no, createdAt: r.created_at, cashier: r.cashier, subtotal: r.subtotal,
    discountType: r.discount_type, discountValue: Number(r.discount_value), discountAmount: r.discount_amount,
    taxPercent: Number(r.tax_percent), taxAmount: r.tax_amount, total: r.total, cogs: r.cogs,
    paymentMethod: r.payment_method, paid: r.paid, change: r.change_amount,
    customerName: r.customer_name || null,
  });

  // ── Active store ──
  // Resolves the store this request works in. The caller names it with the
  // `x-usernode-store` header (or `?store=` on a GET); a named store is only
  // accepted when the caller owns it. Otherwise the caller's oldest store is
  // used, and a caller who owns none (or a guest) gets null, so store-scoped
  // routes answer honestly (an empty list) instead of erroring.
  function requestedStoreId(req) {
    const raw = req.headers['x-usernode-store'] || (req.method === 'GET' ? req.query.store : null);
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n > 0 && n <= 2000000000 ? n : null;
  }
  async function resolveActiveStore(req) {
    const wanted = requestedStoreId(req);
    const owner = req.user && req.user.id != null ? req.user.id : null;
    if (owner == null) return null;
    if (wanted != null) {
      const { rows } = await pool.query('SELECT * FROM stores WHERE id = $1 AND owner_id = $2', [wanted, owner]);
      if (rows.length) return rows[0];
    }
    const { rows } = await pool.query('SELECT * FROM stores WHERE owner_id = $1 ORDER BY id LIMIT 1', [owner]);
    return rows[0] || null;
  }

  // Resolve the active store once per request, before any route handler. A
  // route that needs it reads `req.store`; when it is null the route answers
  // its honest empty result.
  app.use('/api', h(async (req, _res, next) => {
    req.store = await resolveActiveStore(req);
    next();
  }));

  // ── Stores ──
  app.get('/api/stores', h(async (req, res) => {
    const owner = req.user && req.user.id != null ? req.user.id : null;
    if (owner == null) return res.json({ stores: [], activeId: null });
    const { rows } = await pool.query('SELECT * FROM stores WHERE owner_id = $1 ORDER BY id', [owner]);
    const active = req.store;
    res.json({ stores: rows.map(storeRow), activeId: active ? active.id : null });
  }));

  function readStore(b) {
    const name = text(b.name, 'Nama toko', { max: 80, required: true });
    const address = text(b.address, 'Alamat', { max: 200 });
    const phone = text(b.phone, 'Telepon', { max: 40 });
    const logoUrl = text(b.logoUrl, 'Logo', { max: 500 });
    if (logoUrl && !/^(https?:\/\/|\/)/.test(logoUrl)) throw bad('Logo tidak valid');
    const tax = Number(b.taxPercent);
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) throw bad('PPN harus antara 0 dan 100');
    // Account number is kept as digits only; spaces and dashes are accepted on input.
    const briNo = text(b.briAccountNo, 'Nomor rekening BRI', { max: 40 }).replace(/[\s.-]/g, '');
    if (briNo && !/^\d{10,20}$/.test(briNo)) throw bad('Nomor rekening BRI harus 10 sampai 20 angka');
    const briName = text(b.briAccountName, 'Nama pemilik rekening', { max: 80 });
    if (!briNo !== !briName) throw bad('Isi nomor rekening BRI dan nama pemilik rekening, atau kosongkan keduanya');
    return { name, address, phone, logoUrl, tax, briNo, briName };
  }

  app.post('/api/stores', h(async (req, res) => {
    const s = readStore(req.body || {});
    const owner = req.user && req.user.id != null ? req.user.id : null;
    if (owner == null) throw new HttpError(401, 'account_required');
    const { rows } = await pool.query(
      `INSERT INTO stores (owner_id, name, address, phone, logo_url, tax_percent, bri_account_no, bri_account_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [owner, s.name, s.address, s.phone, s.logoUrl, s.tax, s.briNo, s.briName]);
    res.status(201).json(storeRow(rows[0]));
  }));

  // ── Store profile (the active store) ──
  app.get('/api/store', h(async (req, res) => {
    if (!req.store) return res.json(null);
    // Whether this store has ever recorded a sale. The onboarding checklist
    // reads it; `/api/movements` (capped at 30 rows) cannot answer "any sale
    // at all", so a single EXISTS on the store's own sales is added here.
    const has = await pool.query(
      'SELECT EXISTS (SELECT 1 FROM sales WHERE store_id = $1) AS has', [req.store.id]);
    res.json(Object.assign({}, storeRow(req.store), { hasSales: has.rows[0].has }));
  }));
  app.put('/api/store', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Toko tidak ditemukan');
    const s = readStore(req.body || {});
    const { rows } = await pool.query(
      `UPDATE stores SET name=$1, address=$2, phone=$3, logo_url=$4, tax_percent=$5,
         bri_account_no=$6, bri_account_name=$7
       WHERE id=$8 RETURNING *`,
      [s.name, s.address, s.phone, s.logoUrl, s.tax, s.briNo, s.briName, req.store.id]);
    res.json(storeRow(rows[0]));
  }));

  // ── Products ──
  app.get('/api/products', h(async (req, res) => {
    if (!req.store) return res.json({ products: [] });
    const { rows } = await pool.query(
      'SELECT * FROM products WHERE active AND store_id = $1 ORDER BY name', [req.store.id]);
    res.json({ products: rows.map(productRow) });
  }));

  function readProduct(b) {
    return {
      name: text(b.name, 'Nama produk', { max: 120, required: true }),
      sku: text(b.sku, 'SKU / barcode', { max: 60, required: true }),
      category: text(b.category, 'Kategori', { max: 60 }) || 'Umum',
      cost: int(b.costPrice, 'Harga modal'),
      sell: int(b.sellPrice, 'Harga jual'),
      min: int(b.minStock, 'Batas stok minimum'),
    };
  }
  const dupSku = (e) => (e.code === '23505' ? new HttpError(409, 'SKU / barcode sudah dipakai produk lain') : e);

  app.post('/api/products', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Toko tidak ditemukan');
    const storeId = req.store.id;
    const p = readProduct(req.body || {});
    const stock = int((req.body || {}).stock ?? 0, 'Stok awal');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO products (store_id, name, sku, category, cost_price, sell_price, stock, min_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [storeId, p.name, p.sku, p.category, p.cost, p.sell, stock, p.min]);
      if (stock > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, qty_change, stock_after, note, actor)
           VALUES ($1,$2,'restock',$3,$3,'Stok awal',$4)`, [storeId, rows[0].id, stock, actor(req)]);
      }
      await client.query('COMMIT');
      res.status(201).json(productRow(rows[0]));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw dupSku(e);
    } finally { client.release(); }
  }));

  // Stock is changed only through adjustments and sales, never by editing.
  app.put('/api/products/:id', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Produk tidak ditemukan');
    const p = readProduct(req.body || {});
    try {
      const { rows } = await pool.query(
        `UPDATE products SET name=$1, sku=$2, category=$3, cost_price=$4, sell_price=$5, min_stock=$6
         WHERE id=$7 AND active AND store_id=$8 RETURNING *`,
        [p.name, p.sku, p.category, p.cost, p.sell, p.min, int(req.params.id, 'ID'), req.store.id]);
      if (!rows.length) throw new HttpError(404, 'Produk tidak ditemukan');
      res.json(productRow(rows[0]));
    } catch (e) { throw dupSku(e); }
  }));

  // Soft delete: past receipts keep their lines.
  app.delete('/api/products/:id', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Produk tidak ditemukan');
    const { rowCount } = await pool.query(
      `UPDATE products SET active = FALSE, sku = sku || '#' || id
       WHERE id = $1 AND active AND store_id = $2`,
      [int(req.params.id, 'ID'), req.store.id]);
    if (!rowCount) throw new HttpError(404, 'Produk tidak ditemukan');
    res.json({ ok: true });
  }));

  // restock: qty added. return: qty sent back to the supplier, removed.
  // opname: qty is the physical count; stock is set to it.
  app.post('/api/products/:id/adjust', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Produk tidak ditemukan');
    const storeId = req.store.id;
    const b = req.body || {};
    if (!MOVEMENT_TYPES.includes(b.type)) throw bad('Jenis penyesuaian tidak valid');
    const qty = int(b.qty, b.type === 'opname' ? 'Stok fisik' : 'Jumlah', { min: b.type === 'opname' ? 0 : 1 });
    const note = text(b.note, 'Catatan', { max: 200 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT * FROM products WHERE id=$1 AND active AND store_id=$2 FOR UPDATE',
        [int(req.params.id, 'ID'), storeId]);
      if (!cur.rows.length) throw new HttpError(404, 'Produk tidak ditemukan');
      const stock = cur.rows[0].stock;
      const after = b.type === 'restock' ? stock + qty : b.type === 'return' ? stock - qty : qty;
      if (after < 0) throw new HttpError(409, `Stok hanya ${stock}, tidak cukup untuk diretur`);
      const { rows } = await client.query('UPDATE products SET stock=$1 WHERE id=$2 RETURNING *', [after, cur.rows[0].id]);
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, qty_change, stock_after, note, actor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [storeId, cur.rows[0].id, b.type, after - stock, after, note, actor(req)]);
      await client.query('COMMIT');
      res.json(productRow(rows[0]));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }));

  app.get('/api/movements', h(async (req, res) => {
    if (!req.store) return res.json({ movements: [] });
    const { rows } = await pool.query(
      `SELECT m.*, p.name AS product_name FROM stock_movements m JOIN products p ON p.id = m.product_id
       WHERE m.store_id = $1 ORDER BY m.id DESC LIMIT 30`, [req.store.id]);
    res.json({ movements: rows.map((r) => ({
      id: r.id, product: r.product_name, type: r.type, qtyChange: r.qty_change, stockAfter: r.stock_after,
      note: r.note, ref: r.ref, createdAt: r.created_at })) });
  }));

  // ── Sales ──
  app.post('/api/sales', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Toko tidak ditemukan');
    const storeId = req.store.id;
    const b = req.body || {};
    const lines = Array.isArray(b.items) ? b.items : [];
    if (!lines.length || lines.length > 200) throw bad('Keranjang kosong');
    const method = b.paymentMethod;
    if (!PAYMENT_METHODS.includes(method)) throw bad('Metode pembayaran tidak valid');
    const dType = ['percent', 'fixed'].includes(b.discountType) ? b.discountType : 'none';
    const dValue = dType === 'none' ? 0 : Number(b.discountValue);
    if (!Number.isFinite(dValue) || dValue < 0 || (dType === 'percent' && dValue > 100)) throw bad('Diskon tidak valid');
    const taxPct = Number(b.taxPercent);
    if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 100) throw bad('PPN tidak valid');
    const wanted = lines.map((l) => ({
      id: int(l.productId, 'Produk'), qty: int(l.qty, 'Jumlah', { min: 1, max: 100000 }),
      price: int(l.price, 'Harga', { min: 1, max: 1000000000 }),
    }));
    if (new Set(wanted.map((w) => w.id)).size !== wanted.length) throw bad('Produk ganda di keranjang');
    let clientRef = null;
    if (b.clientRef != null) {
      if (typeof b.clientRef !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(b.clientRef)) throw bad('Referensi transaksi tidak valid');
      clientRef = b.clientRef;
    }
    const findByRef = async (db) => (await db.query(
      'SELECT * FROM sales WHERE store_id = $1 AND client_ref = $2', [storeId, clientRef])).rows[0];
    // The customer is named before the transaction so a bad name fails fast.
    // Names are matched case- and space-insensitively in SQL; this collapse
    // keeps "Pak  Budi" and "Pak Budi" from becoming two people.
    let customerName = null;
    if (method === 'credit') {
      customerName = text(b.customerName, 'Nama pelanggan', { max: 80, required: true })
        .replace(/\s+/g, ' ').trim();
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM products WHERE id = ANY($1) AND active AND store_id = $2 ORDER BY id FOR UPDATE',
        [wanted.map((w) => w.id), storeId]);
      // Looked up after the product locks: a concurrent attempt with the same
      // reference has committed by now, so a repeated tap finds its sale.
      if (clientRef) {
        const done = await findByRef(client);
        if (done) {
          await client.query('COMMIT');
          return res.status(200).json({ sale: saleRow(done), duplicate: true });
        }
      }
      // After the duplicate check, so a retried cart never upserts twice.
      let customerId = null;
      if (method === 'credit') {
        const up = await client.query(
          `INSERT INTO customers (store_id, name) VALUES ($1, $2)
           ON CONFLICT (store_id, (lower(name))) DO UPDATE SET name = customers.name
           RETURNING id`, [storeId, customerName]);
        customerId = up.rows[0].id;
      }
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      let subtotal = 0; let cogs = 0;
      for (const w of wanted) {
        const p = by[w.id];
        if (!p) throw new HttpError(404, 'Ada produk yang sudah dihapus dari katalog');
        if (p.stock < w.qty) throw new HttpError(409, `Stok ${p.name} tidak cukup (sisa ${p.stock})`);
        subtotal += w.qty * w.price;
        cogs += w.qty * p.cost_price;
      }
      const discount = dType === 'percent' ? Math.round(subtotal * dValue / 100) : Math.min(Math.round(dValue), subtotal);
      const tax = Math.round((subtotal - discount) * taxPct / 100);
      const total = subtotal - discount + tax;
      if (total > 2000000000) throw bad('Total transaksi terlalu besar');
      let paid = total;
      if (method === 'cash') {
        paid = int(b.paid, 'Uang diterima', { max: 2000000000 });
        if (paid < total) throw bad('Uang diterima kurang dari total');
      }
      // Nothing was received now, so there must be something to owe.
      if (method === 'credit') {
        if (total < 1) throw bad('Total harus lebih dari Rp 0 untuk bayar nanti');
        paid = 0;
      }
      const change = method === 'credit' ? 0 : paid - total;
      const seq = (await client.query("SELECT nextval('invoice_seq') AS n")).rows[0].n;
      const invoice = `INV-${jakartaDate(req.now).replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
      const sale = (await client.query(
        `INSERT INTO sales (store_id, invoice_no, cashier, subtotal, discount_type, discount_value, discount_amount,
           tax_percent, tax_amount, total, cogs, payment_method, paid, change_amount, client_ref, customer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [storeId, invoice, actor(req), subtotal, dType, dValue, discount, taxPct, tax, total, cogs, method, paid, change,
          clientRef, customerId])).rows[0];
      for (const w of wanted) {
        const p = by[w.id];
        const after = p.stock - w.qty;
        await client.query(
          `INSERT INTO sale_items (store_id, sale_id, product_id, name, sku, qty, list_price, price, cost_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [storeId, sale.id, p.id, p.name, p.sku, w.qty, p.sell_price, w.price, p.cost_price]);
        await client.query('UPDATE products SET stock = $1 WHERE id = $2', [after, p.id]);
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, qty_change, stock_after, note, ref, actor)
           VALUES ($1,$2,'sale',$3,$4,'',$5,$6)`, [storeId, p.id, -w.qty, after, invoice, actor(req)]);
      }
      await client.query('COMMIT');
      res.status(201).json({ sale: saleRow(sale) });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // Lost the race to an attempt with the same reference: answer with its sale.
      if (clientRef && e.code === '23505') {
        const done = await findByRef(pool);
        if (done) return res.status(200).json({ sale: saleRow(done), duplicate: true });
      }
      throw e;
    } finally { client.release(); }
  }));

  app.get('/api/sales/:id', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Transaksi tidak ditemukan');
    const id = int(req.params.id, 'ID');
    const sale = await pool.query(
      `SELECT s.*, c.name AS customer_name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.id = $1 AND s.store_id = $2`, [id, req.store.id]);
    if (!sale.rows.length) throw new HttpError(404, 'Transaksi tidak ditemukan');
    const items = await pool.query('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id', [id]);
    res.json({
      sale: saleRow(sale.rows[0]),
      items: items.rows.map((i) => ({ name: i.name, sku: i.sku, qty: i.qty, listPrice: i.list_price, price: i.price })),
    });
  }));

  // ── Piutang (customer debt) ──
  // The outstanding amount is always computed, never stored: a customer's
  // credit sales minus their append-only payments. "Lunas" is a difference
  // of 0, so no balance can ever drift out of sync with the records.
  const customerOwed = async (db, storeId, customerId) => {
    const { rows } = await db.query(
      `SELECT COALESCE((SELECT SUM(total) FROM sales WHERE store_id = $1 AND customer_id = $2 AND payment_method = 'credit'), 0)
         - COALESCE((SELECT SUM(amount) FROM debt_payments WHERE store_id = $1 AND customer_id = $2), 0) AS owed`,
      [storeId, customerId]);
    return Number(rows[0].owed);
  };

  app.get('/api/customers', h(async (req, res) => {
    if (!req.store) return res.json({ customers: [] });
    const { rows } = await pool.query(
      'SELECT id, name FROM customers WHERE store_id = $1 ORDER BY name LIMIT 500', [req.store.id]);
    res.json({ customers: rows });
  }));

  app.get('/api/debts', h(async (req, res) => {
    if (!req.store) return res.json({ debts: [], total: 0, count: 0 });
    const storeId = req.store.id;
    const { rows } = await pool.query(
      `SELECT c.id, c.name, COALESCE(s.total, 0) - COALESCE(p.paid, 0) AS owed, s.last_sale_at
       FROM customers c
       LEFT JOIN (SELECT customer_id, SUM(total) AS total, MAX(created_at) AS last_sale_at
                  FROM sales WHERE store_id = $1 AND payment_method = 'credit' GROUP BY customer_id) s
         ON s.customer_id = c.id
       LEFT JOIN (SELECT customer_id, SUM(amount) AS paid
                  FROM debt_payments WHERE store_id = $1 GROUP BY customer_id) p
         ON p.customer_id = c.id
       WHERE c.store_id = $1 AND COALESCE(s.total, 0) - COALESCE(p.paid, 0) > 0
       ORDER BY owed DESC`, [storeId]);
    const debts = rows.map((r) => ({ customerId: r.id, name: r.name, owed: Number(r.owed), lastSaleAt: r.last_sale_at }));
    res.json({ debts, total: debts.reduce((a, d) => a + d.owed, 0), count: debts.length });
  }));

  app.post('/api/debts/:customerId/payments', h(async (req, res) => {
    if (!req.store) throw new HttpError(404, 'Toko tidak ditemukan');
    const storeId = req.store.id;
    const customerId = int(req.params.customerId, 'ID');
    const b = req.body || {};
    let clientRef = null;
    if (b.clientRef != null) {
      if (typeof b.clientRef !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(b.clientRef)) throw bad('Referensi transaksi tidak valid');
      clientRef = b.clientRef;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cust = (await client.query(
        'SELECT * FROM customers WHERE id = $1 AND store_id = $2 FOR UPDATE', [customerId, storeId])).rows[0];
      if (!cust) { await client.query('ROLLBACK'); throw new HttpError(404, 'Pelanggan tidak ditemukan'); }
      // The lock on the customer row serialises concurrent payments, so the
      // computed debt can never go below 0.
      const answer = async (duplicate) => {
        const owed = Math.max(await customerOwed(client, storeId, customerId), 0);
        await client.query('COMMIT');
        const body = { customerId, name: cust.name, owed };
        if (duplicate) body.duplicate = true;
        return res.json(body);
      };
      if (clientRef) {
        const done = (await client.query(
          'SELECT id FROM debt_payments WHERE store_id = $1 AND client_ref = $2', [storeId, clientRef])).rows[0];
        if (done) return answer(true);
      }
      const owed = await customerOwed(client, storeId, customerId);
      const amount = int(b.amount, 'Jumlah dibayar', { min: 1 });
      if (amount > owed) throw new HttpError(409, 'Sisa piutang hanya ' + rp(owed));
      await client.query(
        `INSERT INTO debt_payments (store_id, customer_id, amount, actor, client_ref)
         VALUES ($1,$2,$3,$4,$5)`, [storeId, customerId, amount, actor(req), clientRef]);
      await answer(false);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // Lost the race to an attempt with the same reference.
      if (clientRef && e.code === '23505') {
        const row = (await pool.query(
          'SELECT id, name FROM customers WHERE id = $1 AND store_id = $2', [customerId, storeId])).rows[0];
        if (row) {
          const owed = Math.max(await customerOwed(pool, storeId, customerId), 0);
          return res.json({ customerId, name: row.name, owed, duplicate: true });
        }
      }
      throw e;
    } finally { client.release(); }
  }));

  // Daily or monthly report. Omzet = sales after discount, before PPN; PPN is
  // collected for the state and is not revenue. Laba kotor = omzet minus HPP.
  // A day or month is named on the Asia/Jakarta calendar.
  app.get('/api/reports', h(async (req, res) => {
    const mode = req.query.mode === 'monthly' ? 'monthly' : 'daily';
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date : jakartaDate(req.now);
    const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)
      ? req.query.month : jakartaDate(req.now).slice(0, 7);
    if (!req.store) {
      return res.json({ mode, ...(mode === 'monthly' ? { month } : { date }),
        summary: { count: 0, revenue: 0, cogs: 0, grossProfit: 0, tax: 0, discount: 0, total: 0 },
        byMethod: [], sales: [] });
    }
    const storeId = req.store.id;
    const param = mode === 'monthly' ? month : date;
    // Columns are qualified because customers also has created_at and store_id.
    const day = `${mode === 'monthly'
      ? `to_char(s.created_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $1`
      : `(s.created_at AT TIME ZONE '${TZ}')::date = $1::date`} AND s.store_id = $2`;
    const sum = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(s.subtotal - s.discount_amount),0)::bigint AS revenue,
              COALESCE(SUM(s.cogs),0)::bigint AS cogs, COALESCE(SUM(s.tax_amount),0)::bigint AS tax,
              COALESCE(SUM(s.discount_amount),0)::bigint AS discount, COALESCE(SUM(s.total),0)::bigint AS total
       FROM sales s WHERE ${day}`, [param, storeId])).rows[0];
    const methods = await pool.query(
      `SELECT s.payment_method, COUNT(*)::int AS count, SUM(s.total)::bigint AS total FROM sales s
       WHERE ${day} GROUP BY s.payment_method ORDER BY s.payment_method`, [param, storeId]);
    const list = await pool.query(
      `SELECT s.*, c.name AS customer_name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${day} ORDER BY s.id DESC LIMIT 200`, [param, storeId]);
    const revenue = Number(sum.revenue); const cogs = Number(sum.cogs);
    res.json({
      mode, ...(mode === 'monthly' ? { month } : { date }),
      summary: { count: sum.count, revenue, cogs, grossProfit: revenue - cogs, tax: Number(sum.tax),
        discount: Number(sum.discount), total: Number(sum.total) },
      byMethod: methods.rows.map((m) => ({ method: m.payment_method, count: m.count, total: Number(m.total) })),
      sales: list.rows.map(saleRow),
    });
  }));

  // JSON errors for every API failure.
  app.use('/api', (err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Terjadi kesalahan di server' });
  });

  return { migrate };
}

module.exports = { mountApi };
