// netlify/functions/add-to-sheet.js
//
// Takes the products checked in the Discover tab and appends them to
// Sheet1 as new rows with a blank Status - so the next sourcing run picks
// them up automatically, same as a manual paste. Priority is computed
// server-side (same formula as the FX2 sheet formula) since a formula
// fill-down doesn't automatically extend to rows added via the API.

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

function normalizePrivateKey(raw) {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { SHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, ADMIN_KEY } = process.env;
  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let products;
  try {
    const body = JSON.parse(event.body || "{}");
    products = body.products;
    if (!Array.isArray(products) || products.length === 0) {
      throw new Error("No products provided");
    }
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request: " + err.message }) };
  }

  try {
    const jwt = new JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key: normalizePrivateKey(GOOGLE_PRIVATE_KEY),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Sheet1"];
    if (!sheet) throw new Error('No "Sheet1" tab found');

    let added = 0;
    for (const p of products) {
      const salesRank = p.salesRank || 0;
      const monthlySold = p.monthlySold || 0;
      const topSellerPct = p.buyBoxPctTopSeller90 || 0; // now the real value, not hardcoded 0
      const priority = +(
        100000 / Math.max(1, salesRank) +
        monthlySold * 2 -
        topSellerPct * 100
      ).toFixed(1);

      await sheet.addRow({
        Title: p.title || "",
        ASIN: p.asin || "",
        "Sales Rank: Current": salesRank || "",
        "Monthly Sales Trends: Bought in past month": monthlySold || "",
        "Buy Box: Current": p.buyBoxPrice || "",
        "Total Offer Count": p.totalOfferCount || "",
        "Buy Box: % Amazon 90 days": p.buyBoxPctAmazon90 ?? "",
        "Buy Box: % Top Seller 90 days": p.buyBoxPctTopSeller90 ?? "",
        Priority: priority,
        // Status intentionally left blank - that's the "Pending" signal
        // the sourcing script looks for.
      });
      added++;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ added }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
