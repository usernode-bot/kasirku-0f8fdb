# KasirKU

Retail point of sale and warehouse management for a small shop (Indonesian UI).

- **Kasir / Penjualan**: search and category tabs, cart with custom price, percent or fixed discount, PPN, cash (with change), QRIS, debit, bank transfer and Utang (pay later, with the customer's name). Stock is deducted when the sale completes. Receipts can be printed, shared, or sent through WhatsApp.
- **Manajemen Stok Gudang**: product catalog (SKU, category, cost and selling price), low-stock alerts, restock, return and stock opname.
- **Laporan Penjualan**: daily or monthly summary, gross profit estimate (omzet minus HPP), transaction history, printable receipts, and the open debts ("Utang belum lunas") with "Tandai lunas".
- **Kasir offline**: once opened online, the app opens without a connection (`public/sw.js`). Sales rung up offline are kept on the device and sent automatically when it is back online; a band under the header says how many are waiting.
- **Toko / multi-toko**: an owner keeps several stores and switches the active one from the header ("Pilih toko"). Every tab, product, stock change and sale belongs to the active store, and switching stores empties the cart. Each store has its own profile (name, address, phone, logo used on receipts). A new owner starts on "Belum ada toko" and creates their first store.

Run with `npm ci && npm run build && node server.js` (needs `DATABASE_URL`). Server code is in `server.js` and `api.js`; the UI is `public/index.html` and `public/app.js`; the offline service worker is `public/sw.js`.
