# KasirKU

A simple cashier app for your shop's sales. Ring up what a customer is
buying, see the bill with tax, complete the sale, and the receipt stays
around to be reopened and printed.

## The three screens

- **Sell** — a grid of the shop's products with price and stock left. Tap a
  product to add it to the bill; tap again for another. The bill is drawn as
  till paper: quantities with minus and plus, Subtotal, Tax, Total. Sold-out
  products are greyed and cannot be added, and you cannot add more than the
  stock left. **Complete sale** saves the sale, takes the sold amounts off
  stock, and opens the receipt. On a phone the bill sits in a bar at the
  bottom ("View bill" opens it); on a wide screen it is always beside the
  products.
- **Products** — every product in name order with its price and stock
  ("Low stock, N" at 5 or fewer, "Sold out" at zero). **Add product** and a
  row tap open the same short form (Name, Price, Stock). A **Tax rate** row
  at the bottom changes the one shop-wide rate. Products are never deleted,
  so old receipts keep their items.
- **Sales** — completed sales, newest first. Opening one shows the receipt:
  shop name, receipt number, date and time, cashier, each line with quantity
  and price, subtotal, tax, total, and "Thank you". **Print receipt** uses
  the browser's print dialog; **New sale** returns to Sell with an empty
  bill.

## Data model

- `products` — id, name, price, stock. Public. Never deleted.
- `settings` — key/value; `tax_rate_bp` is the shop tax rate in basis
  points (1100 = 11%).
- `sales` — one row per completed sale: subtotal, the tax rate it was sold
  at, tax, total, item count, cashier, created_at. Marked `staging:private`
  (financial data).
- `sale_items` — one row per line, with the product's **name and unit price
  snapshotted** at sale time, so later price edits change future sales only.
  Also `staging:private`.

## Money and tax

Money is Indonesian Rupiah, whole rupiah integers with no cents, written
"Rp 12.500". The tax rate is one value for the whole shop, stored in basis
points and applied as `tax = Math.round(subtotal * rate / 10000)`. Changing
the rate never changes old receipts — they keep the rate they were sold at.
Prices and stock are read from the database under row locks at checkout,
never trusted from the page, so two cashiers racing for the last unit ends
with one sale and one "Only N left of …" notice.

## Staging preview

Open the staging preview with `?demo=1` to see a made-up shop: fourteen
everyday goods with some low and sold-out stock, and a dozen past sales from
a made-up cashier, labelled once at the top of the screen. Everything works
on the demo, including completing sales.