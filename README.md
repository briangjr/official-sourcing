[README.md](https://github.com/user-attachments/files/31009780/README.md)
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

## Confidence tiers & dashboard persistence

Every finished product now gets classified into one of three tiers when
it's moved out of Sheet1:

- **Qualifies** (clears $3 profit or 20% ROI) — kept in full in the
  **Archive** tab, shown prominently on the dashboard, same as before.
- **Medium** (a real match was found, or the model flagged genuine
  confidence, but it didn't clear the bar) — kept in full in **Archive**
  too, since there's a real chance it's worth a second look later, but
  **not** shown on the main dashboard — keeps the prominent view free of
  low-value clutter while nothing is actually lost.
- **Low** (no match found, or a match with zero/negative benefit) —
  nothing worth keeping in detail. Only the ASIN is remembered, in a lean
  **SeenASINs** tab (just ASIN, Title, and the date checked) — enough to
  guarantee it's never re-checked (and never re-paid-for) again, without
  carrying any bulky data you'll never use.

**The dashboard now also reads from the Archive tab, not just Sheet1** —
so erasing Sheet1 clears your active working queue, but your leads
history and everything worth remembering stay exactly where they are.

## Qualifying-lead threshold ($3 profit OR 20% ROI)

A lead counts as "worth pursuing" (shown on the dashboard, included in the
daily report) if it clears **$3 profit OR 20% ROI** — either bar, not
both. Adjustable via `MIN_PROFIT_FLOOR` and `MIN_ROI_FLOOR` at the top of
`netlify/functions/get-products.js` and `scripts/process.js` (kept in sync
manually since they're two different files/languages-in-spirit but the
same logic — change both if you adjust this).

## Dashboard redesign

Reorganized into labeled sections (Overview, Sourcing Activity, Leads).
The three top KPI cards now show a 7-day sparkline and a day-over-day
trend badge (green up / red down). A new donut chart shows your leads
broken down by vendor tier (S/A/B/C/D/Unranked) at a glance.

## Keepa API auto-import (parked, pending two things from you)

Your Keepa Pro plan already includes API access (1 token/min) at no extra
cost, so this is feasible without new spend once two things are provided:
your Keepa API key, and the exact filter values from your saved Product
Finder search. Not built yet — guessing at filter criteria risks silently
sourcing against the wrong parameters.

## Recent improvements (matching, cost, and dashboard)

- **Trusted-site-first search:** the search step now checks your S/A tier
  vendor domains specifically (via site-restricted search) before falling
  back to a general web search — raises match trustworthiness and tends to
  resolve faster/cheaper too.
- **Profit floor:** products below `MIN_AMAZON_PRICE` (default $15) skip
  the paid search step entirely — no point paying to check something too
  cheap for a deal to matter.
- **Funnel view** on the dashboard shows exactly where leads drop off:
  Searched → Match Found → Checkout Verified → Worth Pursuing.
- **Hit-rate trend chart** — % of searched rows becoming a real lead, per
  day, so you can see whether changes are actually working over time.
- **Sortable, filterable leads table** — click any column header to sort,
  filter by vendor tier.

Deliberately not included yet: Amazon SP-API ungating checks and a
dedicated coupon-code API — both need real account setup that couldn't be
verified without your credentials; worth tackling as focused follow-ups
once you're ready. Keepa API auto-import was also left out — it's not
free (starts around €49/month separate from your regular subscription),
so it didn't meet the "keep spend low" bar.

## Daily reports

At the end of each day's processing, the top 10 leads (by the same
profit+ROI+reliability score used elsewhere) are snapshotted into a
**DailyReports** tab (created automatically) — one row per lead, per day.
A "Daily Reports" link on the dashboard (next to Diagnostics) lets you
browse past days and click into any of them to see that day's top 10,
independent of whatever's currently sitting in Sheet1 or Archive.

## Archiving & history (avoids re-checking the same product twice)

Once Sheet1 builds up more than 200 completed (Done/Failed) rows, the
oldest ones are automatically moved to a new **Archive** tab (created
automatically) — nothing is deleted, just relocated, keeping Sheet1 fast.
Before processing, the script also checks the Archive tab by ASIN — a
product already checked before (even in an earlier, now-archived batch)
gets marked **"Skipped (already checked)"** instead of being re-processed
and re-billed if it shows up again in a future Keepa paste.

The dashboard's main table shows only the most recent 50 leads, to stay
light — full history persists in the Archive tab regardless of what's
currently visible.

## Checkout verification (Phase 2)

Codes tried at checkout come from two sources: your **CouponCodes** tab
(manual, trusted), and a quick site-specific search that looks for
currently-circulating codes for that domain (automatic, unverified by
definition — that's what the checkout pass actually tests). Both are
combined and deduped, capped at 6 codes total per product. Checkout Notes
shows how many came from each source. This adds one extra search call per
checkout-verified row (not every row), capped at 2 searches — a small,
real addition to cost, only on the subset of rows that already have a
promising lead worth checking out.

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
