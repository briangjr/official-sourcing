// netlify/functions/get-products.js
//
// Reads Sheet1 and returns the completed rows as JSON, plus a simple
// "is the sourcer currently active" signal for the dashboard's animation.

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
  const { SHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, ADMIN_KEY } = process.env;

  // Simple shared-password check, same pattern as your other dashboard.
  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    const jwt = new JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key: normalizePrivateKey(GOOGLE_PRIVATE_KEY),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Sheet1"];
    const rows = await sheet.getRows();

    const products = rows
      .filter((r) => (r.get("Status") || "") === "Done")
      .map((r) => {
        const amazonPrice = parseFloat(r.get("Buy Box: Current")) || null;
        const sourcingPrice =
          parseFloat(r.get("Checkout Verified Price")) ||
          parseFloat(r.get("Best Price Found")) ||
          null;
        const diff =
          amazonPrice != null && sourcingPrice != null
            ? +(amazonPrice - sourcingPrice).toFixed(2)
            : null;

        return {
          title: r.get("Title") || "",
          amazonPrice,
          sourcingPrice,
          priceDifference: diff,
          salesRank: r.get("Sales Rank: Current") || "",
          vendor: r.get("Deal Type") || "",
          sourceLink: r.get("Checkout Notes")?.includes("Tried")
            ? r.get("Source Link")
            : r.get("Source Link") || "",
          dateFound: r.get("Processed Date") || "",
        };
      })
      .filter((p) => p.priceDifference !== null && p.priceDifference > 0)
      .sort((a, b) => b.priceDifference - a.priceDifference);

    const processingRow = rows.find((r) => (r.get("Status") || "") === "Processing");
    const pendingCount = rows.filter((r) => (r.get("Status") || "").trim() === "" || r.get("Status") === "Pending").length;

    // Daily stats: leads found (positive price difference) and total
    // potential profit (sum of savings), grouped by Processed Date.
    const byDate = {};
    for (const p of products) {
      const d = p.dateFound || "Unknown";
      if (!byDate[d]) byDate[d] = { date: d, leads: 0, potentialProfit: 0 };
      byDate[d].leads += 1;
      byDate[d].potentialProfit += p.priceDifference || 0;
    }
    const dailyStats = Object.values(byDate)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ ...d, potentialProfit: +d.potentialProfit.toFixed(2) }))
      .slice(-14); // last 14 days with activity

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        products,
        isActive: Boolean(processingRow),
        currentlyChecking: processingRow ? processingRow.get("Title") : null,
        pendingCount,
        dailyStats,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
