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

## Notes on this first version

- Search matching is by product title, same approach as searching it
  manually — it checks the first page of results.
- "No cheaper price found" is a normal, expected outcome for most rows —
  it still marks the row Done so it isn't re-checked every run.
- Not yet included (future additions): checking specific trusted sites
  (e.g. Vitacost, Sam's Club) first, and add-to-cart checkout-price checking
  for coupon codes that only reveal the discount at checkout.
