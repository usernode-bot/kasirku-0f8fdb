# KasirKU — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the "Starter template" hero with
the app's thumbnail tile and the plain-English note on how the app gets
built (by asking Homeroom bot) — is placeholder content from the
Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About KasirKU

A retail point of sale plus warehouse app for a small shop, in Indonesian, inspired by Kasir Pintar. An owner (a Homeroom account) can keep several stores; each store owns its own profile, products, stock and sales, and the header switcher picks the active one. Three tabs, always scoped to the active store: Kasir / Penjualan (checkout, including "Bayar nanti" credit sales), Manajemen Stok Gudang (catalog, low-stock alerts, restock / return / opname) and Laporan Penjualan (daily summary, history, gross profit, receipts, plus the Piutang pelanggan debt list).

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** accent: teal; neutrals: warm greys; no second colour (the starter tokens)
- **Signature element:** the KasirKU logo (a cash register beside a box, `logoSvg()` in `public/app.js`) in the header and on receipts, and the receipt (monospace, dashed rules)
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  _(change their sizes in `tailwind.config.js` if you must, not their number)_

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- **Stores own everything.** `stores.owner_id` is the Homeroom `req.user.id`; every business table (`products`, `stock_movements`, `sales`, `sale_items`) carries `store_id` and every query filters on it. The active store is named by the `x-usernode-store` header (or `?store=` on a GET), validated against the caller's ownership; with none named the caller's oldest store is used. A caller who owns no store gets an honest empty answer, never another owner's data.
- All business tables are `staging:private`, so staging copies them schema-only; the `IS_STAGING` seed in `api.js` fills obviously fake rows owned by `staging-demo-owner` (id 900100, deliberately not the local sign-in fixture's id 900001), never the visitor.
- **Bayar nanti (credit) sales.** Choosing that method records a `customers` row for the name (matched case- and space-insensitively per store; the first spelling is kept) and links the sale via `sales.customer_id`, with `paid = 0`. A customer's debt is never a stored balance: it is computed as the sum of their credit sales minus the sum of their `debt_payments` (both append-only). A payment lowers the customer's total debt, not one sale. Credit sales count in omzet, HPP and laba kotor when the goods leave; debt payments are not sales. The Piutang pelanggan list (customers who owe > 0) sits at the bottom of the Laporan tab and ignores the report date picker.
- Money never goes negative: payments are serialised with `FOR UPDATE` on the customer row and an over-payment is refused.
- UI copy is Indonesian. Money is whole rupiah (integers), shown as `Rp 10.000`.
- Omzet = sales after discount, before PPN. HPP = cost price at the time of sale. Laba kotor = omzet - HPP.
- "Retur" is a return to the supplier (stock decreases). Low stock means stock below the product's minimum.
- Stock changes only through `/api/products/:id/adjust` and `/api/sales` (every change writes `stock_movements`); editing a product never changes stock.
- `sales` and `sale_items` are `staging:private` (financial records); staging seeds fake `DEMO-` products and sales.
- Reports use the Asia/Jakarta day.
- Payment methods: `cash`, `qris`, `debit`, `transfer` (any bank) and `bri` (the legacy "Transfer BRI" label, still kept so old sales and receipts read right; new sales record as `transfer`). Which of Tunai / QRIS / Debit / Transfer bank the Kasir offers is per store (`pay_cash`/`pay_qris`/`pay_debit`/`pay_transfer`, all default on; at least one must stay on; Bayar nanti has no switch). The server refuses a new sale with a turned-off method.
- Bank accounts are per store: up to 3 in `stores.bank_accounts` (`{bank, accountNo, accountName}`; `accountNo` digits only, 10–20), edited in Profil toko. A BRI account saved before the multi-bank change is copied once into the list at boot; the old `bri_account_no`/`bri_account_name` columns are kept but no longer read or written. The QRIS image lives in `stores.qris_url`, uploaded like the logo; checkout's QRIS pane shows it (or a fill-in prompt when empty), and the Transfer pane lists every account with a copy button.
- The 7-day insights (GET `/api/insights`) look at today plus the 6 days before on the Asia/Jakarta calendar: days left = floor(stock × 7 / sold); an item lands on the Daftar belanja when it sold more last week than it has in stock, with suggested buy = max(sold, min_stock) − stock; "mengendap" means stock > 0 with no sales in those 7 days, ranked by stock × harga modal.
- Tutup shift: `shift_closings` (staging:private, append-only, one row per store per Asia/Jakarta day). Expected cash is the sum of today's `cash` sales' `total`, computed by the server at closing and stored as a snapshot; difference = counted - expected (Lebih / Kurang / Pas). No opening float. The section sits at the top of the Laporan tab, shows the last 20 closings and ignores the report date picker.
