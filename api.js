// KasirKU API: store profile, product catalog, stock adjustments, sales and
// reports. All money is stored as whole rupiah (integers). The server always
// recomputes totals, stock and cost of goods from its own data.
const TZ = 'Asia/Jakarta';
const PAYMENT_METHODS = ['cash', 'qris', 'debit', 'transfer'];
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_profile (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'KasirKU',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 11
);
INSERT INTO store_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Umum',
  cost_price INT NOT NULL DEFAULT 0,
  sell_price INT NOT NULL DEFAULT 0,
  stock INT NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 5,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,
  qty_change INT NOT NULL,
  stock_after INT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS invoice_seq;
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
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
  sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  qty INT NOT NULL,
  list_price INT NOT NULL,
  price INT NOT NULL,
  cost_price INT NOT NULL DEFAULT 0
);
-- Sales are financial records: staging gets the structure without the rows.
COMMENT ON TABLE sales IS 'staging:private';
COMMENT ON TABLE sale_items IS 'staging:private';
`;

// Obviously fake demo shop for staging previews. Idempotent.
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
  for (const [sku, name, category, cost, sell, stock, min] of DEMO_PRODUCTS) {
    await pool.query(
      `INSERT INTO products (sku, name, category, cost_price, sell_price, stock, min_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (sku) DO NOTHING`,
      [sku, name, category, cost, sell, stock, min]);
  }
  await pool.query(
    `UPDATE store_profile SET name = 'Toko Contoh Sejahtera', address = 'Jl. Contoh No. 12, Jakarta',
     phone = '021-5550123' WHERE id = 1 AND name = 'KasirKU' AND address = ''`);
  const demoSales = [
    ['DEMO-INV-001', 'cash', 100000, [['DEMO-001', 1], ['DEMO-005', 2]], '30 minutes'],
    ['DEMO-INV-002', 'qris', 0, [['DEMO-006', 3], ['DEMO-009', 5]], '20 minutes'],
    ['DEMO-INV-003', 'debit', 0, [['DEMO-002', 1], ['DEMO-003', 2], ['DEMO-010', 1]], '10 minutes'],
  ];
  for (const [inv, method, cash, lines, ago] of demoSales) {
    const { rows } = await pool.query(
      `SELECT sku, name, sell_price, cost_price, id FROM products WHERE sku = ANY($1)`,
      [lines.map((l) => l[0])]);
    const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
    if (lines.some((l) => !by[l[0]])) continue;
    let subtotal = 0; let cogs = 0;
    for (const [sku, qty] of lines) { subtotal += by[sku].sell_price * qty; cogs += by[sku].cost_price * qty; }
    const tax = Math.round(subtotal * 0.11);
    const total = subtotal + tax;
    const ins = await pool.query(
      `INSERT INTO sales (invoice_no, created_at, cashier, subtotal, tax_percent, tax_amount, total, cogs,
         payment_method, paid, change_amount)
       VALUES ($1, NOW() - $2::interval, 'staging-demo-kasir', $3, 11, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (invoice_no) DO NOTHING RETURNING id`,
      [inv, ago, subtotal, tax, total, cogs, method, method === 'cash' ? Math.max(cash, total) : total,
        method === 'cash' ? Math.max(cash, total) - total : 0]);
    if (!ins.rows.length) continue;
    for (const [sku, qty] of lines) {
      const p = by[sku];
      await pool.query(
        `INSERT INTO sale_items (sale_id, product_id, name, sku, qty, list_price, price, cost_price)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
        [ins.rows[0].id, p.id, p.name, p.sku, qty, p.sell_price, p.cost_price]);
    }
  }
}

function mountApi({ app, pool, IS_STAGING }) {
  const jakartaDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

  async function migrate() {
    await pool.query(SCHEMA);
    if (IS_STAGING) await seedDemo(pool);
  }

  const actor = (req) => (req.user && req.user.username) || '';
  const productRow = (r) => ({
    id: r.id, name: r.name, sku: r.sku, category: r.category, costPrice: r.cost_price,
    sellPrice: r.sell_price, stock: r.stock, minStock: r.min_stock,
    low: r.stock < r.min_stock, out: r.stock <= 0,
  });
  const storeRow = (r) => ({
    name: r.name, address: r.address, phone: r.phone, logoUrl: r.logo_url, taxPercent: Number(r.tax_percent),
    staging: IS_STAGING,
  });
  const saleRow = (r) => ({
    id: r.id, invoiceNo: r.invoice_no, createdAt: r.created_at, cashier: r.cashier, subtotal: r.subtotal,
    discountType: r.discount_type, discountValue: Number(r.discount_value), discountAmount: r.discount_amount,
    taxPercent: Number(r.tax_percent), taxAmount: r.tax_amount, total: r.total, cogs: r.cogs,
    paymentMethod: r.payment_method, paid: r.paid, change: r.change_amount,
  });

  // ── Store profile ──
  app.get('/api/store', h(async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM store_profile WHERE id = 1');
    res.json(storeRow(rows[0]));
  }));
  app.put('/api/store', h(async (req, res) => {
    const b = req.body || {};
    const name = text(b.name, 'Nama toko', { max: 80, required: true });
    const address = text(b.address, 'Alamat', { max: 200 });
    const phone = text(b.phone, 'Telepon', { max: 40 });
    const logoUrl = text(b.logoUrl, 'Logo', { max: 500 });
    if (logoUrl && !/^(https?:\/\/|\/)/.test(logoUrl)) throw bad('Logo tidak valid');
    const tax = Number(b.taxPercent);
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) throw bad('PPN harus antara 0 dan 100');
    const { rows } = await pool.query(
      `UPDATE store_profile SET name=$1, address=$2, phone=$3, logo_url=$4, tax_percent=$5 WHERE id=1 RETURNING *`,
      [name, address, phone, logoUrl, tax]);
    res.json(storeRow(rows[0]));
  }));

  // ── Products ──
  app.get('/api/products', h(async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE active ORDER BY name');
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
    const p = readProduct(req.body || {});
    const stock = int((req.body || {}).stock ?? 0, 'Stok awal');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO products (name, sku, category, cost_price, sell_price, stock, min_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.name, p.sku, p.category, p.cost, p.sell, stock, p.min]);
      if (stock > 0) {
        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty_change, stock_after, note, actor)
           VALUES ($1,'restock',$2,$2,'Stok awal',$3)`, [rows[0].id, stock, actor(req)]);
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
    const p = readProduct(req.body || {});
    try {
      const { rows } = await pool.query(
        `UPDATE products SET name=$1, sku=$2, category=$3, cost_price=$4, sell_price=$5, min_stock=$6
         WHERE id=$7 AND active RETURNING *`,
        [p.name, p.sku, p.category, p.cost, p.sell, p.min, int(req.params.id, 'ID')]);
      if (!rows.length) throw new HttpError(404, 'Produk tidak ditemukan');
      res.json(productRow(rows[0]));
    } catch (e) { throw dupSku(e); }
  }));

  // Soft delete: past receipts keep their lines.
  app.delete('/api/products/:id', h(async (req, res) => {
    const { rowCount } = await pool.query(
      `UPDATE products SET active = FALSE, sku = sku || '#' || id WHERE id = $1 AND active`,
      [int(req.params.id, 'ID')]);
    if (!rowCount) throw new HttpError(404, 'Produk tidak ditemukan');
    res.json({ ok: true });
  }));

  // restock: qty added. return: qty sent back to the supplier, removed.
  // opname: qty is the physical count; stock is set to it.
  app.post('/api/products/:id/adjust', h(async (req, res) => {
    const b = req.body || {};
    if (!MOVEMENT_TYPES.includes(b.type)) throw bad('Jenis penyesuaian tidak valid');
    const qty = int(b.qty, b.type === 'opname' ? 'Stok fisik' : 'Jumlah', { min: b.type === 'opname' ? 0 : 1 });
    const note = text(b.note, 'Catatan', { max: 200 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT * FROM products WHERE id=$1 AND active FOR UPDATE', [int(req.params.id, 'ID')]);
      if (!cur.rows.length) throw new HttpError(404, 'Produk tidak ditemukan');
      const stock = cur.rows[0].stock;
      const after = b.type === 'restock' ? stock + qty : b.type === 'return' ? stock - qty : qty;
      if (after < 0) throw new HttpError(409, `Stok hanya ${stock}, tidak cukup untuk diretur`);
      const { rows } = await client.query('UPDATE products SET stock=$1 WHERE id=$2 RETURNING *', [after, cur.rows[0].id]);
      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty_change, stock_after, note, actor)
         VALUES ($1,$2,$3,$4,$5,$6)`, [cur.rows[0].id, b.type, after - stock, after, note, actor(req)]);
      await client.query('COMMIT');
      res.json(productRow(rows[0]));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }));

  app.get('/api/movements', h(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT m.*, p.name AS product_name FROM stock_movements m JOIN products p ON p.id = m.product_id
       ORDER BY m.id DESC LIMIT 30`);
    res.json({ movements: rows.map((r) => ({
      id: r.id, product: r.product_name, type: r.type, qtyChange: r.qty_change, stockAfter: r.stock_after,
      note: r.note, ref: r.ref, createdAt: r.created_at })) });
  }));

  // ── Sales ──
  app.post('/api/sales', h(async (req, res) => {
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
      price: int(l.price, 'Harga', { max: 1000000000 }),
    }));
    if (new Set(wanted.map((w) => w.id)).size !== wanted.length) throw bad('Produk ganda di keranjang');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM products WHERE id = ANY($1) AND active ORDER BY id FOR UPDATE', [wanted.map((w) => w.id)]);
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
      let paid = total;
      if (method === 'cash') {
        paid = int(b.paid, 'Uang diterima', { max: 100000000000 });
        if (paid < total) throw bad('Uang diterima kurang dari total');
      }
      const seq = (await client.query("SELECT nextval('invoice_seq') AS n")).rows[0].n;
      const invoice = `INV-${jakartaDate(req.now).replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
      const sale = (await client.query(
        `INSERT INTO sales (invoice_no, cashier, subtotal, discount_type, discount_value, discount_amount,
           tax_percent, tax_amount, total, cogs, payment_method, paid, change_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [invoice, actor(req), subtotal, dType, dValue, discount, taxPct, tax, total, cogs, method, paid, paid - total])).rows[0];
      for (const w of wanted) {
        const p = by[w.id];
        const after = p.stock - w.qty;
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, name, sku, qty, list_price, price, cost_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [sale.id, p.id, p.name, p.sku, w.qty, p.sell_price, w.price, p.cost_price]);
        await client.query('UPDATE products SET stock = $1 WHERE id = $2', [after, p.id]);
        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty_change, stock_after, note, ref, actor)
           VALUES ($1,'sale',$2,$3,'',$4,$5)`, [p.id, -w.qty, after, invoice, actor(req)]);
      }
      await client.query('COMMIT');
      res.status(201).json({ sale: saleRow(sale) });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }));

  app.get('/api/sales/:id', h(async (req, res) => {
    const id = int(req.params.id, 'ID');
    const sale = await pool.query('SELECT * FROM sales WHERE id = $1', [id]);
    if (!sale.rows.length) throw new HttpError(404, 'Transaksi tidak ditemukan');
    const items = await pool.query('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id', [id]);
    res.json({
      sale: saleRow(sale.rows[0]),
      items: items.rows.map((i) => ({ name: i.name, sku: i.sku, qty: i.qty, listPrice: i.list_price, price: i.price })),
    });
  }));

  // Daily report. Omzet = sales after discount, before PPN; PPN is collected
  // for the state and is not revenue. Laba kotor = omzet minus HPP.
  app.get('/api/reports', h(async (req, res) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date : jakartaDate(req.now);
    const day = `(created_at AT TIME ZONE '${TZ}')::date = $1::date`;
    const sum = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(subtotal - discount_amount),0)::bigint AS revenue,
              COALESCE(SUM(cogs),0)::bigint AS cogs, COALESCE(SUM(tax_amount),0)::bigint AS tax,
              COALESCE(SUM(discount_amount),0)::bigint AS discount, COALESCE(SUM(total),0)::bigint AS total
       FROM sales WHERE ${day}`, [date])).rows[0];
    const methods = await pool.query(
      `SELECT payment_method, COUNT(*)::int AS count, SUM(total)::bigint AS total FROM sales
       WHERE ${day} GROUP BY payment_method ORDER BY payment_method`, [date]);
    const list = await pool.query(`SELECT * FROM sales WHERE ${day} ORDER BY id DESC LIMIT 200`, [date]);
    const revenue = Number(sum.revenue); const cogs = Number(sum.cogs);
    res.json({
      date,
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
