# KasirKU

Retail point of sale and warehouse management for a small shop (Indonesian UI).

- **Kasir / Penjualan**: search and category tabs, cart with custom price, percent or fixed discount, PPN, cash (with change), QRIS, debit and bank transfer. Stock is deducted when the sale completes.
- **Manajemen Stok Gudang**: product catalog (SKU, category, cost and selling price), low-stock alerts, restock, return and stock opname.
- **Laporan Penjualan**: daily summary, gross profit estimate (omzet minus HPP), transaction history and printable receipts.
- **Toko / multi-toko**: an owner keeps several stores and switches the active one from the header ("Pilih toko"). Every tab, product, stock change and sale belongs to the active store, and switching stores empties the cart. Each store has its own profile (name, address, phone, logo used on receipts). A new owner starts on "Belum ada toko" and creates their first store.
- **Langkah awal**: the Kasir tab shows a starter checklist (Buat toko, Tambah produk, Catat penjualan pertama) until the active store has a product and a sale; it then disappears for good. The header carries no visible app name because the platform bar above the app already shows it.

Run with `npm ci && npm run build && node server.js` (needs `DATABASE_URL`). Server code is in `server.js` and `api.js`; the UI is `public/index.html` and `public/app.js`.
