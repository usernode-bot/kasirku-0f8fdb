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

A point-of-sale (cashier) app for a small shop: record product sales, keep
inventory stock up to date, calculate bills with tax, and keep a printable
receipt for every sale. Three screens — Sell (the till), Products (catalogue
and stock) and Sales (receipts). One shared shop: everyone sees and changes
the same products, stock and sales; any signed-in member can sell, add and
edit products, and change the tax rate. The app is public, so visitors
without an account can look around and build a bill; saving needs an
account.

## Design

This app's look. Every later change follows it, and updates it when a
request changes the look on purpose.

- **Palette:** a deep banknote blue (`accent`) for actions and the selected
  tab, cool grey neutrals (`ground`/`surface`/`raised`/`line`), and a burnt
  orange (`warn`) reserved for stock warnings — "Low stock" and "Sold out"
  only.
- **Signature element:** the bill and the receipt are drawn as till paper —
  an off-white sheet (`.paper`, token `paper`), typewriter-style monospace
  lettering, dashed rules between sections (`.paper-rule`) and a torn zigzag
  bottom edge (`.paper-edge`). The bill on Sell is the same paper as the
  receipt, so the receipt is visibly the bill you were building. Printing a
  receipt forces the light token values so the paper prints white with dark
  ink.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (unchanged). System UI stack everywhere; the system monospace stack only
  on the paper.
- Navigation is three tabs — Sell, Products, Sales — bottom bar on phones,
  a row in the header from `sm:` up; the active tab takes the accent and a
  bar on its edge (`.tab[aria-current='page']`).
- Money is always written "Rp 12.500".

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

- Money is whole rupiah integers, never floats. The tax rate is basis
  points in `settings.tax_rate_bp` (1100 = 11%); tax is
  `Math.round(subtotal * rate / 10000)`.
- `sale_items` snapshots the product's name and unit price at sale time, so
  price or name edits change future sales only.
- Products are never deleted (old receipts keep their items); setting stock
  to 0 takes a product off sale.
- `sales` and `sale_items` are financial data and carry
  `COMMENT ON TABLE … 'staging:private'`, so the platform's staging copy of
  the shop never includes them; the staging demo (`?demo=1`, seeded at
  request time on staging only) shows made-up products and sales instead.
- Checkout quantities and prices are read from the database under row locks
  (`SELECT … FOR UPDATE`), never trusted from the page.
- `created_at` values come from `req.now`, never SQL `NOW()`.
