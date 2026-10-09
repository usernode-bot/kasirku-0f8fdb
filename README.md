# KasirKU

A simple cashier (point of sale) app for your shop's sales, built on
Homeroom. One shared shop: everyone who opens the app sees the same products
and sales.

- **Sell** — tap product tiles into the cart, step quantities up or down,
  and Checkout: stock is deducted, the sale is recorded and its receipt
  opens. A sold-out tile cannot be tapped, and a checkout that would take a
  product below zero is refused with the product's name.
- **Products** — the catalogue with price and stock. Add product, or tap a
  row to edit. Shop settings at the bottom holds the tax rate (one whole
  percent for the whole shop).
- **Transactions** — every sale, newest first, with its item count and
  total. Tapping a sale opens its receipt, which prints through the browser
  like a paper till slip.

Money is Indonesian Rupiah, whole numbers, written like `Rp 12.500`; tax is
one rate (11% to start) rounded to the nearest rupiah on the server. A sale
snapshots each item's name and price, so later product edits never rewrite an
old receipt.

## How it works

- **Sign-in** — the server verifies the platform-issued user token (an RS256
  JWT) on every request, so the app already knows who is using it; guests can
  browse, and writes need an account. No accounts to build.
- **Database** — the app's own private Postgres holds `products`, `sales`,
  `sale_items` and `shop_settings`; the schema is created idempotently on
  boot. A checkout runs in one database transaction, so stock, the sale and
  its items commit together or not at all.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The design kit lives in `styles/tailwind-input.css`.

## Developing

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the change in plain English. You can also run Claude Code against this repo
directly; start with `CLAUDE.md`, which carries the app-specific notes and
points at the platform rules.

Locally: `npm ci --include=dev`, `npm run build` (compiles the stylesheet),
then `node server.js` with `DATABASE_URL` set. `USERNODE_ENV=staging` seeds a
fake demo shop at boot; production starts empty.