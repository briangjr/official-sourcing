// Amazon Sourcing Tool - background price/coupon checker
//
// The Sheet's columns A through "Business Discount: Percentage" are an exact
// mirror of Keepa's Product Finder export, in the same order - so periodic
// Keepa exports can be pasted straight in without reformatting. Priority,
// Status, and the result columns are appended after that, at the end.
//
// What this does, once per run (see .github/workflows/source.yml for schedule):
//   1. Open the Google Sheet (Sheet1 tab) - reads the LIVE current contents,
//      every single run, whether triggered by the schedule or run manually.
//   2. Find rows where Status is blank or "Pending".
//   3. Sort them by the Priority column (1 = highest priority, checked first).
//   4. Respect the daily cap: count rows already marked Done today, stop once
//      today's total would exceed DAILY_CAP.
//   5. For each row in this run's batch (up to BATCH_SIZE):
//        - Mark it "Processing" (so a second run can't grab it too).
//        - Ask Claude (with web search) to find a cheaper price for this
//          exact product - checking for coupons, sales, subscribe & save.
//        - Write the result back: best price found, source link, deal type,
//          confidence, and mark it "Done".
//   6. Stop. The next scheduled run picks up wherever this one left off.

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import Anthropic from "@anthropic-ai/sdk";
import { checkCheckoutPrice } from "./checkoutCheck.js";

const {
  SHEET_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  ANTHROPIC_API_KEY,
  BATCH_SIZE = "10",
  DAILY_CAP = "100",
  RUN_COUNT = "1",
} = process.env;

const batchSize = parseInt(BATCH_SIZE, 10);
const dailyCap = parseInt(DAILY_CAP, 10);
const runCount = Math.max(1, parseInt(RUN_COUNT, 10) || 1);

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Google's private keys are picky about formatting once they arrive as a
// GitHub secret (plain text). This handles the common ways they get mangled
// in copy-paste: surrounding quotes, literal "\n" sequences instead of real
// newlines, and stray \r characters from Windows editors.
function normalizePrivateKey(raw) {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  return key;
}

async function loadSheet() {
  const normalizedKey = normalizePrivateKey(GOOGLE_PRIVATE_KEY);
  if (!normalizedKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "GOOGLE_PRIVATE_KEY doesn't look like a valid key (missing 'BEGIN PRIVATE KEY'). " +
      "Re-copy the private_key value from your service account JSON file and update the secret."
    );
  }
  const jwt = new JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: normalizedKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle["Sheet1"];
  if (!sheet) {
    throw new Error(
      'Could not find a tab named "Sheet1". Check the tab name matches exactly.'
    );
  }
  return { doc, sheet };
}

// Reads your list of known/go-to coupon codes from a second tab called
// "CouponCodes" (one code per row, column A). Optional - if the tab doesn't
// exist or is empty, checkout verification still runs, it just won't have
// codes to try and will report that in the notes.
async function loadKnownCodes(doc) {
  const tab = doc.sheetsByTitle["CouponCodes"];
  if (!tab) return [];
  const rows = await tab.getRows();
  return rows
    .map((r) => (r._rawData && r._rawData[0]) || "")
    .map((c) => c.trim())
    .filter(Boolean);
}

// Ask Claude to search the web and return a structured result for one product.
// "Buy Box: Current" is what a customer actually pays on Amazon right now
// (not "Amazon: Current", which is Amazon's own price when they're a seller
// but isn't always the price shown to a buyer). Change this if you'd rather
// compare against a different Keepa column.
const AMAZON_PRICE_COLUMN = "Buy Box: Current";

async function findCheaperPrice(anthropic, row) {
  const title = row.get("Title");
  const amazonPrice = row.get(AMAZON_PRICE_COLUMN);

  const systemPrompt = `You are checking whether a specific product can be bought cheaper
somewhere online than its current Amazon price - via a coupon code, an active sale,
or subscribe-and-save pricing. Search using the exact product title, the way a
shopper would. Check the first page of results; only dig further if nothing
matches there. Respond with ONLY a JSON object, no other text, no code fences:

{
  "found_cheaper": true or false,
  "best_price": number or null,
  "source_link": "url or null",
  "deal_type": "coupon" | "sale" | "subscribe_and_save" | "none",
  "confidence": "high" | "medium" | "low",
  "notes": "short note, e.g. 'one-day sale, may not last' or 'no match found'"
}`;

  const userPrompt = `Product title: ${title}
Current Amazon price: ${amazonPrice}

Find the cheapest legitimate current price for this exact product from any
retailer, factoring in coupon codes and subscribe-and-save pricing where
visible. Note if a deal looks time-limited.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });

  const textBlock = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const cleaned = textBlock.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return {
      found_cheaper: false,
      best_price: null,
      source_link: null,
      deal_type: "none",
      confidence: "low",
      notes: "Could not parse result - check manually. Raw: " + cleaned.slice(0, 200),
    };
  }
}

async function main() {
  const { doc, sheet } = await loadSheet();
  const rows = await sheet.getRows();
  const knownCodes = await loadKnownCodes(doc);

  const today = todayStr();
  const doneToday = rows.filter(
    (r) => r.get("Status") === "Done" && r.get("Processed Date") === today
  ).length;

  const remainingToday = Math.max(0, dailyCap - doneToday);
  if (remainingToday === 0) {
    console.log(`Daily cap of ${dailyCap} already reached for ${today}. Stopping.`);
    return;
  }

  const pending = rows
    .filter((r) => {
      const status = (r.get("Status") || "").trim();
      return status === "" || status === "Pending";
    })
    .sort((a, b) => {
      // Priority is now a raw score (see the FX2 formula in the setup notes) -
      // higher score = higher priority, so sort descending.
      const pa = parseFloat(a.get("Priority")) || 0;
      const pb = parseFloat(b.get("Priority")) || 0;
      return pb - pa;
    });

  const thisRunLimit = Math.min(batchSize * runCount, remainingToday);
  const batch = pending.slice(0, thisRunLimit);

  if (runCount > 1) {
    console.log(`Run Ten Times mode: processing up to ${thisRunLimit} rows in this single run.`);
  }

  if (batch.length === 0) {
    console.log("No pending rows to process.");
    return;
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  for (const row of batch) {
    row.set("Status", "Processing");
    await row.save();

    try {
      const result = await findCheaperPrice(anthropic, row);

      row.set("Status", "Done");
      row.set("Processed Date", today);
      row.set("Best Price Found", result.best_price ?? "");
      row.set("Source Link", result.source_link ?? "");
      row.set("Deal Type", result.deal_type ?? "none");
      row.set("Confidence", result.confidence ?? "low");
      row.set("Notes", result.notes ?? "");

      // Second pass: if the search step found a promising lead (a coupon or
      // sale, with an actual link to check), verify it with a real checkout
      // pass rather than trusting the listed page price.
      if (
        result.found_cheaper &&
        result.source_link &&
        (result.deal_type === "coupon" || result.deal_type === "sale")
      ) {
        row.set("Checkout Notes", "Checking checkout price...");
        await row.save();

        const checkout = await checkCheckoutPrice(result.source_link, knownCodes);
        row.set(
          "Checkout Verified Price",
          checkout.verified_price != null ? checkout.verified_price : ""
        );
        row.set("Checkout Notes", checkout.notes);
      }

      await row.save();

      console.log(`Processed: ${row.get("Title")} -> ${result.deal_type}`);
    } catch (err) {
      row.set("Status", "Error");
      row.set("Notes", "Error during processing: " + err.message);
      await row.save();
      console.error(`Error on row "${row.get("Title")}":`, err.message);
    }
  }

  console.log(`Run complete. Processed ${batch.length} row(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
