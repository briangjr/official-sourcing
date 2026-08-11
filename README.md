[README.md](https://github.com/user-attachments/files/30961517/README.md)
# Amazon Sourcing Tool

Reads a Google Sheet of pre-filtered Keepa candidates (you supply these — this
tool doesn't touch Keepa itself), and for each product searches the web to see
if it can be found cheaper via a coupon, sale, or subscribe-and-save pricing.
Runs automatically on a schedule via GitHub Actions — no button to click day
to day.

See the setup guide PDF for full step-by-step instructions. Quick summary:

1. Create a Google Sheet using `sheet-template.csv` as your column layout
   (tab must be named `Sheet1`).
2. Set up a Google Cloud service account with access to the Sheets API,
   and share your Sheet with its email address (Editor access).
3. Get an Anthropic API key from console.anthropic.com.
4. Add all four as GitHub Actions secrets on your fork of this repo:
   `SHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ANTHROPIC_API_KEY`.
5. The workflow in `.github/workflows/source.yml` runs hourly, processing up
   to `BATCH_SIZE` rows per run and stopping once `DAILY_CAP` is hit for the
   day. Adjust both at the bottom of that file any time.

## Columns the script reads/writes

`sheet-template.csv` mirrors Keepa's Product Finder export exactly, column
for column, in the same order — so future Keepa exports can be pasted
straight into columns A onward with no reformatting. Eight extra columns are
appended at the very end:

- **You fill in:** all the Keepa columns (paste directly from a Keepa
  export), plus **Priority** per row — a score where **higher = checked
  first**. Can be typed manually, or auto-filled with a formula (see below).
- **The script fills in:** Status, Best Price Found, Source Link, Deal Type,
  Confidence, Notes, Processed Date.

**Important when pasting a fresh Keepa export in later:** only paste into
the Keepa columns (A through "Business Discount: Percentage"). Don't paste
over the Priority/Status/result columns at the end — that's what preserves
already-checked products' results, and what leaves brand-new rows blank so
the tool knows to pick them up. If a product from a past export appears
again, its old Status stays intact and it won't be re-checked unnecessarily.

## Auto-filling Priority with a formula

Paste this into cell `FX2` (the Priority column, row 2) and drag it down /
fill-down for every row:

```
=IFERROR((100000/MAX(1,E2)) + (L2*2) - (AC2*100), 0)
```

This rewards a low Sales Rank (E), rewards higher monthly units sold (L),
and penalizes a Buy Box dominated by one top seller (AC) — higher score =
checked sooner. Adjust the weights (the `*2` and `*100` multipliers) to
change how much each factor matters relative to the others.

## Checkout verification (Phase 2)

For any product where the search step finds a coupon or sale lead, a second
pass opens a real headless browser, sets quantity to **3** (not 1), adds to
cart, and looks for a promo/coupon code field — trying any codes you've
supplied in a second sheet tab called **CouponCodes** (one code per row,
column A). It also fills in a shipping ZIP code if you supply one (see
below), so cart totals reflect shipping-estimated pricing where a site shows
that before checkout. The 3-unit total is divided back down to a per-unit
price for a fair comparison against Amazon's single-unit listing — both the
per-unit price (**Checkout Verified Price**) and the raw 3-unit total
(**Checkout Total (3 units)**) are recorded, along with **Checkout Notes**.

No payment information is ever entered anywhere — pricing is read from the
cart/checkout page before any payment step, which is normally enough to see
a coupon-adjusted or bulk-quantity price.

**Shipping ZIP (optional):** add a `SHIP_ZIP` secret in GitHub (just a ZIP
code, e.g. "48101") if you want shipping-estimated totals where a site
offers that on its cart page. Skip it entirely if you'd rather not — the
tool works fine without it, just without shipping factored in.

This is genuinely best-effort: retailer checkout flows vary a lot, and some
sites block automated browsers outright. When it can't find what it's
looking for, it says so in the notes rather than guessing — treat a blank
or "not found" result as "unverified," not "no deal."

## Dashboard (Phase 2)

A small Netlify site in `/dashboard` (frontend) and `/netlify/functions`
(backend) reads your Sheet and shows a live status indicator, two charts
(leads found per day, potential profit per day), and a table of every
product where a genuinely cheaper price was found — sorted by biggest price
difference first. Protected by the same `ADMIN_KEY` pattern as your other
dashboard.

Two buttons let you trigger a run on demand instead of waiting for the
hourly schedule: **Run Once** processes one normal batch; **Run Ten Times**
processes up to ten batches back-to-back in a single continuous job (much
more efficient than actually launching ten separate jobs). This requires a
GitHub personal access token (see the setup guide PDF) so the dashboard can
tell GitHub Actions to start a run.

## Reliability & accuracy improvements

- **Stricter matching:** the search step now requires confirming pack size,
  variant, and current price before accepting a match — an uncertain result
  is discarded rather than shown as a real deal.
- **Sanity checks:** a "cheaper" price that isn't actually lower than
  Amazon's, or a link that isn't a real URL, gets discarded automatically.
- **Automatic retries:** a row that errors is retried up to 3 times before
  being marked "Failed" and left alone (tracked in the **Retry Count**
  column), so a temporary glitch doesn't strand a product forever, and a
  permanently broken site doesn't quietly burn budget forever either.
- **Last-run tracking:** a small **Meta** tab (created automatically) logs
  the timestamp of every run, shown on the dashboard as "Last checked X ago"
  — an easy way to notice if the schedule has gone quiet.
- **Dashboard summary bar:** total leads found, total potential profit, and
  average ROI, at a glance above the charts.

## Free testing (no API cost)

Two things can be tested without spending anything on the Anthropic API:

- **Sheet connection** — `npm run test:sheet` (or GitHub Actions → "Free
  Tests (no API cost)" → run with "sheet" selected) confirms your service
  account can read/write your Sheet correctly.
- **Checkout automation** — `npm run test:checkout` with a `TEST_URL` env
  var (or the same GitHub Actions workflow with "checkout" selected and a
  product URL) runs the real quantity-of-3 / ZIP / coupon-code logic
  against a page you choose, with zero AI involved.

The only part that genuinely requires the paid API is the product-matching
search step itself — there's no way to test that specific piece for free,
since it's the AI reading and judging search results. Keep `BATCH_SIZE` and
`DAILY_CAP` at 1 while testing that part to keep the cost to a single row.

## Cost controls

Search calls are capped at `MAX_SEARCHES_PER_PRODUCT` (default 3) per
product, and the default model is Haiku 4.5 rather than Sonnet — both
configurable in `.github/workflows/source.yml`. If match quality noticeably
drops, try raising the search cap before switching back to a pricier model;
it's usually the bigger lever.

## Notes on this first version

- Search matching is by product title, same approach as searching it
  manually — it checks the first page of results.
- "No cheaper price found" is a normal, expected outcome for most rows —
  it still marks the row Done so it isn't re-checked every run.
- Checkout verification and the dashboard (above) are the Phase 2 additions
  — not yet included: checking specific trusted sites (e.g. Vitacost, Sam's
  Club) first.
