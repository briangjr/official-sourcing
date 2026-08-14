// netlify/functions/get-daily-reports.js
//
// Returns the DailyReports tab, grouped by date, most recent first -
// capped to the last 30 days with data so this stays light.

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
    const reportTab = doc.sheetsByTitle["DailyReports"];

    if (!reportTab) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: [] }),
      };
    }

    const rows = await reportTab.getRows();
    const byDate = {};
    for (const r of rows) {
      const date = r.get("Date");
      if (!date) continue;
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push({
        rank: parseInt(r.get("Rank"), 10) || 0,
        title: r.get("Title") || "",
        amazonPrice: parseFloat(r.get("Amazon Price")) || null,
        sourcingPrice: parseFloat(r.get("Sourcing Price")) || null,
        profit: parseFloat(r.get("Profit")) || null,
        roi: parseFloat(r.get("ROI %")) || null,
        vendorTier: r.get("Vendor Tier") || "Unranked",
        sourceLink: r.get("Source Link") || "",
      });
    }

    const days = Object.keys(byDate)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 30)
      .map((date) => ({
        date,
        leadCount: byDate[date].filter((l) => l.rank > 0).length,
        leads: byDate[date].sort((a, b) => a.rank - b.rank),
      }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
