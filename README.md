# KasirKU

Retail point of sale and warehouse management for a small shop (Indonesian UI).

- **Kasir / Penjualan**: search and category tabs, cart with custom price, percent or fixed discount, PPN, cash (with change), QRIS, debit and bank transfer. Stock is deducted when the sale completes.
- **Manajemen Stok Gudang**: product catalog (SKU, category, cost and selling price), low-stock alerts, restock, return and stock opname.
- **Laporan Penjualan**: daily summary, gross profit estimate (omzet minus HPP), transaction history and printable receipts.
- **Profil toko**: store name, address, phone and logo used on receipts.

Run with `npm ci && npm run build && node server.js` (needs `DATABASE_URL`). Server code is in `server.js` and `api.js`; the UI is `public/index.html` and `public/app.js`.
