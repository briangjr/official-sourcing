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
  CLAUDE_MODEL = "claude-haiku-4-5-20251001",
  MAX_SEARCHES_PER_PRODUCT = "3",
  SHIP_ZIP = "",
  MIN_AMAZON_PRICE = "15",
} = process.env;

const batchSize = parseInt(BATCH_SIZE, 10);
const dailyCap = parseInt(DAILY_CAP, 10);
const runCount = Math.max(1, parseInt(RUN_COUNT, 10) || 1);
const maxSearches = parseInt(MAX_SEARCHES_PER_PRODUCT, 10) || 3;
const minAmazonPrice = parseFloat(MIN_AMAZON_PRICE) || 0;

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

// Reads your trusted-vendor list from a tab called "VendorTiers"
// (columns: Domain, Tier — e.g. "walmart.com, S"). Optional - vendors not
// listed just get treated as unranked, not penalized.
async function loadVendorTiers(doc) {
  const tab = doc.sheetsByTitle["VendorTiers"];
  if (!tab) return {};
  const rows = await tab.getRows();
  const map = {};
  for (const r of rows) {
    const domain = (r._rawData?.[0] || "").trim().toLowerCase();
    const tier = (r._rawData?.[1] || "").trim().toUpperCase();
    if (domain) map[domain] = tier;
  }
  return map;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
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

// Searches for currently-circulating coupon codes for a specific site,
// to supplement (not replace) whatever you've listed in the CouponCodes
// tab. Capped tightly on searches since this runs per checkout-verified
// row, not per product - keep it cheap. Codes found this way are unverified
// by definition (that's what checkCheckoutPrice actually tests) - treat
// this as "candidates to try," not "confirmed working codes."
async function findCandidateCoupons(anthropic, domain) {
  if (!domain) return [];
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: `Search for currently active/valid coupon codes for the retailer whose domain is
given. Respond with ONLY a JSON array of code strings, max 5, no other text, no code
fences - e.g. ["SAVE10","WELCOME15"]. If you find nothing credible, respond with [].`,
      messages: [{ role: "user", content: `Domain: ${domain}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();
    const codes = JSON.parse(text);
    return Array.isArray(codes) ? codes.slice(0, 5) : [];
  } catch (err) {
    return []; // fail quietly - this is a nice-to-have on top of manual codes, not critical
  }
}

// Ask Claude to search the web and return a structured result for one product.
// "Buy Box: Current" is what a customer actually pays on Amazon right now
// (not "Amazon: Current", which is Amazon's own price when they're a seller
// but isn't always the price shown to a buyer). Change this if you'd rather
// compare against a different Keepa column.
const AMAZON_PRICE_COLUMN = "Buy Box: Current";

async function findCheaperPrice(anthropic, row, trustedDomains = []) {
  const title = row.get("Title");
  const amazonPrice = row.get(AMAZON_PRICE_COLUMN);

  const trustedSiteInstruction =
    trustedDomains.length > 0
      ? `\nSTEP 1 (do this first): search ONLY these sites, one at a time, using
"site:DOMAIN <exact product title>": ${trustedDomains.join(", ")}.
STEP 2: only if step 1 finds nothing, do one general web search instead.
A match from step 1 is more trustworthy - always prefer it over a step 2 result.\n`
      : "";

  const systemPrompt = `You are checking whether a specific product can be bought cheaper
somewhere online than its current Amazon price - via a coupon code, an active sale,
or subscribe-and-save pricing. Search using the exact product title, the way a
shopper would. Check the first page of results; only dig further if nothing
matches there.
${trustedSiteInstruction}
BE STRICT ABOUT MATCHES. A wrong-but-similar product is worse than no match at all -
it wastes the user's time and money if they buy it. Before reporting a price, confirm:
- Same pack size / count / quantity (e.g. "24-pack" is NOT the same as "12-pack",
  a single unit is NOT the same as a multi-pack)
- Same variant (size, color, flavor, model number) as the Amazon listing's title
- The price you're reporting is the actual current price on that page, not a
  crossed-out original price, a different seller's price, or a price from a
  different but similar listing

If you can't confirm all of the above with real confidence, set "exact_match" to
false and "found_cheaper" to false - do NOT report a price you're not sure matches.
It is completely fine, and expected, for most products to come back with no match.

Respond with ONLY a JSON object, no other text, no code fences:

{
  "found_cheaper": true or false,
  "exact_match": true or false,
  "best_price": number or null,
  "source_link": "url or null",
  "deal_type": "coupon" | "sale" | "subscribe_and_save" | "none",
  "confidence": "high" | "medium" | "low",
  "matched_trusted_site": true or false,
  "notes": "short note - if exact_match is false, briefly say why (e.g. 'found similar item but different pack size')"
}`;

  const userPrompt = `Product title: ${title}
Current Amazon price: ${amazonPrice}

Find the cheapest legitimate current price for this exact product from any
retailer, factoring in coupon codes and subscribe-and-save pricing where
visible. Note if a deal looks time-limited.`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
  });

  const textBlock = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const cleaned = textBlock.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    // Belt-and-suspenders: even if the model says found_cheaper, don't trust
    // it unless it also confirmed an exact match. Downgrade to "not found"
    // rather than risk showing a wrong product's price as a real deal.
    if (parsed.found_cheaper && parsed.exact_match !== true) {
      parsed.found_cheaper = false;
      parsed.confidence = "low";
      parsed.notes = "Discarded uncertain match: " + (parsed.notes || "");
    }
    // Sanity checks: a "cheaper" price that isn't actually cheaper than
    // Amazon's, or a link that isn't a real URL, isn't usable either way.
    if (parsed.found_cheaper) {
      const amazonPriceNum = parseFloat(amazonPrice);
      const priceInvalid = !parsed.best_price || parsed.best_price <= 0;
      const notActuallyCheaper =
        !isNaN(amazonPriceNum) && parsed.best_price >= amazonPriceNum;
      const linkInvalid =
        !parsed.source_link || !/^https?:\/\//i.test(parsed.source_link);
      if (priceInvalid || notActuallyCheaper || linkInvalid) {
        parsed.found_cheaper = false;
        parsed.confidence = "low";
        parsed.notes =
          "Discarded failed sanity check (price/link invalid): " + (parsed.notes || "");
      }
    }
    return parsed;
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

// Classifies a finished row into qualifies / medium / low, based on the
// same $ profit / % ROI bar used everywhere else, plus the model's own
// confidence flag as a secondary signal for borderline cases.
function classifyRow(row) {
  if (row.get("Status") === "Failed") return "low"; // no reliable data either way

  const amazonPrice = parseFloat(row.get(AMAZON_PRICE_COLUMN));
  const sourcingPrice =
    parseFloat(row.get("Checkout Verified Price")) || parseFloat(row.get("Best Price Found"));
  const dealType = row.get("Deal Type") || "none";
  const confidence = (row.get("Confidence") || "low").toLowerCase();

  if (!sourcingPrice || dealType === "none") return "low";

  const diff = amazonPrice - sourcingPrice;
  const roi = sourcingPrice ? (diff / sourcingPrice) * 100 : 0;

  if (diff >= MIN_PROFIT_FLOOR || roi >= MIN_ROI_FLOOR) return "qualifies";
  if (diff > 0 || confidence === "medium" || confidence === "high") return "medium";
  return "low";
}

// Reads the ASINs of everything already checked before - both full Archive
// entries (qualifying/medium) and the lean SeenASINs list (low-confidence,
// detail discarded) - so nothing gets re-checked and re-billed regardless
// of which bucket it landed in last time.
async function loadArchivedAsins(doc) {
  const asins = new Set();

  const archive = doc.sheetsByTitle["Archive"];
  if (archive) {
    const rows = await archive.getRows();
    rows
      .filter((r) => r.get("Status") === "Done")
      .forEach((r) => {
        const asin = (r.get("ASIN") || "").trim();
        if (asin) asins.add(asin);
      });
  }

  const seen = doc.sheetsByTitle["SeenASINs"];
  if (seen) {
    const rows = await seen.getRows();
    rows.forEach((r) => {
      const asin = (r.get("ASIN") || "").trim();
      if (asin) asins.add(asin);
    });
  }

  return asins;
}

const ARCHIVE_KEEP_COUNT = 200; // how many finished rows stay live in Sheet1

// Moves old Done/Failed rows out of Sheet1, routed by confidence tier:
//   - qualifies / medium -> full row moved to "Archive" (kept for the
//     dashboard's history and, for medium, in case it's worth a second
//     look later - just not shown prominently, since it didn't clear the
//     $3/20% ROI bar).
//   - low -> only the ASIN is kept, in a lean "SeenASINs" tab, purely so
//     it's never re-checked and re-billed again. No title/price/link kept
//     - there's nothing worth remembering beyond "already checked, no
//     good match."
// Both tabs are created automatically the first time they're needed.
async function archiveOldRows(doc, sheet) {
  const rows = await sheet.getRows();
  const finished = rows
    .filter((r) => ["Done", "Failed"].includes(r.get("Status")))
    .sort((a, b) => new Date(a.get("Processed Date") || 0) - new Date(b.get("Processed Date") || 0));

  if (finished.length <= ARCHIVE_KEEP_COUNT) return 0;

  const toMove = finished.slice(0, finished.length - ARCHIVE_KEEP_COUNT);
  const headers = sheet.headerValues;

  let archive = doc.sheetsByTitle["Archive"];
  let seen = doc.sheetsByTitle["SeenASINs"];

  let archivedCount = 0;
  let seenCount = 0;

  for (const row of toMove) {
    const tier = classifyRow(row);

    if (tier === "low") {
      if (!seen) {
        seen = await doc.addSheet({
          title: "SeenASINs",
          headerValues: ["ASIN", "Title", "Date Checked"],
        });
      }
      await seen.addRow({
        ASIN: row.get("ASIN") || "",
        Title: row.get("Title") || "",
        "Date Checked": row.get("Processed Date") || "",
      });
      seenCount++;
    } else {
      if (!archive) {
        archive = await doc.addSheet({ title: "Archive", headerValues: headers });
      }
      const rowData = {};
      headers.forEach((h) => (rowData[h] = row.get(h) || ""));
      await archive.addRow(rowData);
      archivedCount++;
    }

    await row.delete();
  }

  console.log(
    `Moved ${toMove.length} row(s): ${archivedCount} to Archive (qualifying/medium), ${seenCount} to SeenASINs (low confidence, detail discarded).`
  );
  return toMove.length;
}

// Snapshots today's top 10 leads (by the same profit+ROI+reliability score
// used on the dashboard) into a "DailyReports" tab, one row per lead, so
// you can click into any past day later even after Sheet1/Archive rows
// have moved around. Only writes something if today had at least one
// qualifying lead - a quiet day just doesn't add rows.
const TIER_POINTS_LOCAL = { S: 3, A: 2, B: 1, C: 0.5, D: 1.5 };
const MIN_PROFIT_FLOOR = 3; // dollars - matches the dashboard's qualifying-lead bar
const MIN_ROI_FLOOR = 20; // percent

async function writeDailyReport(doc, sheet, today) {
  const rows = await sheet.getRows();
  const todaysRows = rows.filter(
    (r) => r.get("Status") === "Done" && r.get("Processed Date") === today
  );

  const leads = todaysRows
    .map((r) => {
      const amazonPrice = parseFloat(r.get(AMAZON_PRICE_COLUMN)) || null;
      const sourcingPrice =
        parseFloat(r.get("Checkout Verified Price")) || parseFloat(r.get("Best Price Found")) || null;
      if (amazonPrice == null || sourcingPrice == null) return null;
      const diff = +(amazonPrice - sourcingPrice).toFixed(2);
      const roi = sourcingPrice ? +((diff / sourcingPrice) * 100).toFixed(1) : 0;
      if (diff < MIN_PROFIT_FLOOR && roi < MIN_ROI_FLOOR) return null;
      const tier = (r.get("Vendor Tier") || "").trim();
      const score = +(diff + roi * 0.4 + (TIER_POINTS_LOCAL[tier] || 0) * 8).toFixed(1);
      return {
        title: r.get("Title") || "",
        amazonPrice,
        sourcingPrice,
        diff,
        roi,
        tier: tier || "Unranked",
        score,
        sourceLink: r.get("Source Link") || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Only skip entirely if nothing has been processed today at all yet -
  // once at least one row has run, always write an entry (even "0 leads")
  // so the Daily Reports panel shows today exists rather than looking
  // broken/empty.
  if (todaysRows.length === 0) return;

  let reportTab = doc.sheetsByTitle["DailyReports"];
  if (!reportTab) {
    reportTab = await doc.addSheet({
      title: "DailyReports",
      headerValues: [
        "Date", "Rank", "Title", "Amazon Price", "Sourcing Price",
        "Profit", "ROI %", "Vendor Tier", "Score", "Source Link",
      ],
    });
  } else {
    // This runs multiple times a day (hourly) - clear out today's old
    // snapshot first so we don't accumulate duplicate rows each run.
    const existing = await reportTab.getRows();
    for (const r of existing) {
      if (r.get("Date") === today) await r.delete();
    }
  }

  if (leads.length === 0) {
    await reportTab.addRow({
      Date: today,
      Rank: 0,
      Title: `(${todaysRows.length} checked today, no qualifying leads yet)`,
      "Amazon Price": "",
      "Sourcing Price": "",
      Profit: "",
      "ROI %": "",
      "Vendor Tier": "",
      Score: "",
      "Source Link": "",
    });
    console.log(`Wrote daily report for ${today}: 0 qualifying leads (${todaysRows.length} checked).`);
    return;
  }

  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    await reportTab.addRow({
      Date: today,
      Rank: i + 1,
      Title: l.title,
      "Amazon Price": l.amazonPrice,
      "Sourcing Price": l.sourcingPrice,
      Profit: l.diff,
      "ROI %": l.roi,
      "Vendor Tier": l.tier,
      Score: l.score,
      "Source Link": l.sourceLink,
    });
  }

  console.log(`Wrote daily report for ${today}: ${leads.length} lead(s).`);
}

async function main() {
  const { doc, sheet } = await loadSheet();
  const rows = await sheet.getRows();
  const knownCodes = await loadKnownCodes(doc);
  const vendorTiers = await loadVendorTiers(doc);
  // S-tier only, and capped to 15 - a shorter, higher-confidence list is
  // more likely to actually be followed by a cheaper model than a long
  // one. Widen back to S+A later if S-tier alone proves reliable.
  const trustedDomains = Object.entries(vendorTiers)
    .filter(([, tier]) => tier === "S")
    .map(([domain]) => domain)
    .slice(0, 15);
  const archivedAsins = await loadArchivedAsins(doc);

  // Skip anything already checked in a prior batch (now archived) - mark
  // it so it's visible in the sheet rather than silently ignored, but
  // don't spend anything re-checking it.
  for (const row of rows) {
    const status = (row.get("Status") || "").trim();
    const asin = (row.get("ASIN") || "").trim();
    if ((status === "" || status === "Pending") && asin && archivedAsins.has(asin)) {
      row.set("Status", "Skipped (already checked)");
      await row.save();
    }
  }

  // Skip products too cheap for a "cheaper elsewhere" win to realistically
  // matter - saves paying for a search on rows that were never going to be
  // worth pursuing even in the best case.
  for (const row of rows) {
    const status = (row.get("Status") || "").trim();
    const price = parseFloat(row.get(AMAZON_PRICE_COLUMN));
    if ((status === "" || status === "Pending") && !isNaN(price) && price < minAmazonPrice) {
      row.set("Status", "Skipped (below profit floor)");
      await row.save();
    }
  }

  const today = todayStr();
  const doneToday = rows.filter(
    (r) => r.get("Status") === "Done" && r.get("Processed Date") === today
  ).length;

  const remainingToday = Math.max(0, dailyCap - doneToday);
  if (remainingToday === 0) {
    console.log(`Daily cap of ${dailyCap} already reached for ${today}. Stopping.`);
    await writeLastRunTimestamp(doc, 0);
    return;
  }

const MAX_RETRIES = 3;

  const pending = rows
    .filter((r) => {
      const status = (r.get("Status") || "").trim();
      if (status === "" || status === "Pending") return true;
      // Retry errored rows automatically, up to MAX_RETRIES, so a temporary
      // glitch doesn't leave a product stuck forever - but a row that keeps
      // failing stops being retried instead of quietly burning budget.
      if (status === "Error") {
        const retries = parseInt(r.get("Retry Count"), 10) || 0;
        return retries < MAX_RETRIES;
      }
      return false;
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
    await writeLastRunTimestamp(doc, 0);
    return;
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  for (const row of batch) {
    row.set("Status", "Processing");
    await row.save();

    try {
      const result = await findCheaperPrice(anthropic, row, trustedDomains);

      row.set("Status", "Done");
      row.set("Processed Date", today);
      row.set("Retry Count", ""); // clear any prior retry count on success
      row.set("Best Price Found", result.best_price ?? "");
      row.set("Source Link", result.source_link ?? "");
      row.set("Deal Type", result.deal_type ?? "none");
      row.set("Confidence", result.confidence ?? "low");
      row.set("Notes", result.notes ?? "");

      const domain = getDomain(result.source_link || "");
      row.set("Vendor Tier", vendorTiers[domain] || "Unranked");
      row.set("Matched Trusted Site", result.matched_trusted_site === true ? "Yes" : "No");

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

        // Combine your manual CouponCodes list with codes discovered by a
        // quick site-specific search - dedupe, cap the total tried so a
        // run doesn't spiral into trying dozens of codes on one product.
        const discoveredCodes = await findCandidateCoupons(anthropic, domain);
        const combinedCodes = [...new Set([...knownCodes, ...discoveredCodes])].slice(0, 6);

        const checkout = await checkCheckoutPrice(result.source_link, combinedCodes, SHIP_ZIP);
        const discoveredCount = discoveredCodes.filter((c) => !knownCodes.includes(c)).length;
        const sourceNote =
          discoveredCount > 0
            ? ` (${knownCodes.length} from your list, ${discoveredCount} auto-discovered)`
            : "";
        row.set(
          "Checkout Verified Price",
          checkout.verified_price != null ? checkout.verified_price : ""
        );
        row.set(
          "Checkout Total (3 units)",
          checkout.verified_total_price != null ? checkout.verified_total_price : ""
        );
        row.set("Checkout Notes", checkout.notes + sourceNote);
      }

      await row.save();

      console.log(`Processed: ${row.get("Title")} -> ${result.deal_type}`);
    } catch (err) {
      const priorRetries = parseInt(row.get("Retry Count"), 10) || 0;
      const newRetries = priorRetries + 1;
      row.set("Status", newRetries >= MAX_RETRIES ? "Failed" : "Error");
      row.set("Retry Count", newRetries);
      row.set(
        "Notes",
        `Error during processing (attempt ${newRetries}/${MAX_RETRIES}): ` + err.message
      );
      await row.save();
      console.error(`Error on row "${row.get("Title")}" (attempt ${newRetries}):`, err.message);
    }
  }

  console.log(`Run complete. Processed ${batch.length} row(s).`);
  await writeDailyReport(doc, sheet, today);
  await archiveOldRows(doc, sheet);
  await writeLastRunTimestamp(doc, batch.length);
}

// Writes a timestamp to a small "Meta" tab so the dashboard can show
// "last checked X ago" - a quick way to notice if the schedule has gone
// quiet. Creates the tab automatically the first time it runs.
async function writeLastRunTimestamp(doc, rowsProcessed) {
  let meta = doc.sheetsByTitle["Meta"];
  if (!meta) {
    meta = await doc.addSheet({
      title: "Meta",
      headerValues: ["Key", "Value"],
    });
  }
  const rows = await meta.getRows();
  let row = rows.find((r) => r.get("Key") === "LastRun");
  const value = new Date().toISOString();
  if (row) {
    row.set("Value", value);
    await row.save();
  } else {
    await meta.addRow({ Key: "LastRun", Value: value });
  }
  let countRow = rows.find((r) => r.get("Key") === "LastRunRowCount");
  if (countRow) {
    countRow.set("Value", rowsProcessed);
    await countRow.save();
  } else {
    await meta.addRow({ Key: "LastRunRowCount", Value: rowsProcessed });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
