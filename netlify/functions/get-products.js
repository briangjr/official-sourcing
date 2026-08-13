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

const MIN_PROFIT_FLOOR = 3; // dollars
const TIER_POINTS = { S: 3, A: 2, B: 1, C: 0.5, D: 1.5 };
const MIN_ROI_FLOOR = 20; // percent

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
    const sheetRows = await sheet.getRows();

    // Merge in the Archive tab too, so the dashboard's history survives
    // even if Sheet1 gets cleared out - Archive only ever holds
    // qualifying/medium-confidence rows (low-confidence detail is
    // discarded entirely, kept only as a lean ASIN in SeenASINs, which
    // isn't read here since it has nothing worth showing).
    const archiveTab = doc.sheetsByTitle["Archive"];
    const archiveRows = archiveTab ? await archiveTab.getRows() : [];
    const rows = [...sheetRows, ...archiveRows];

    let lastRun = null;
    const metaTab = doc.sheetsByTitle["Meta"];
    if (metaTab) {
      const metaRows = await metaTab.getRows();
      const lastRunRow = metaRows.find((r) => r.get("Key") === "LastRun");
      if (lastRunRow) lastRun = lastRunRow.get("Value");
    }

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
        const roiPercent =
          diff != null && sourcingPrice ? +((diff / sourcingPrice) * 100).toFixed(1) : null;
        const vendorTier = (r.get("Vendor Tier") || "").trim();
        const reliabilityPoints = TIER_POINTS[vendorTier] || 0;

        // Score blends all three factors you asked for: profit ($), ROI (%),
        // and vendor reliability (tier). Weights are adjustable - this
        // favors real dollar profit slightly over ROI %, with tier as a
        // meaningful but not dominant boost.
        const score =
          diff != null
            ? +((diff * 1.0) + (roiPercent || 0) * 0.4 + reliabilityPoints * 8).toFixed(1)
            : null;

        return {
          title: r.get("Title") || "",
          amazonPrice,
          sourcingPrice,
          priceDifference: diff,
          roiPercent,
          vendorTier: vendorTier || "Unranked",
          score,
          salesRank: r.get("Sales Rank: Current") || "",
          vendor: r.get("Deal Type") || "",
          sourceLink: r.get("Checkout Notes")?.includes("Tried")
            ? r.get("Source Link")
            : r.get("Source Link") || "",
          dateFound: r.get("Processed Date") || "",
        };
      })
      .filter(
        (p) =>
          p.priceDifference !== null &&
          (p.priceDifference >= MIN_PROFIT_FLOOR || (p.roiPercent !== null && p.roiPercent >= MIN_ROI_FLOOR))
      )
      .sort((a, b) => b.priceDifference - a.priceDifference);

    const profitRanked = [...products].sort((a, b) => b.score - a.score).slice(0, 10);

    // Main table: most recent 50 leads by date found, not all of them -
    // keeps the dashboard light. Full history still lives in your Sheet's
    // Archive tab even as old rows roll off here.
    const recentProducts = [...products]
      .sort((a, b) => (b.dateFound || "").localeCompare(a.dateFound || ""))
      .slice(0, 50);

    const summary = {
      totalLeads: products.length,
      totalPotentialProfit: +products.reduce((sum, p) => sum + (p.priceDifference || 0), 0).toFixed(2),
      avgRoi:
        products.length > 0
          ? +(products.reduce((sum, p) => sum + (p.roiPercent || 0), 0) / products.length).toFixed(1)
          : 0,
    };

    // Funnel: where leads actually drop off, computed straight from existing
    // columns - no schema change needed.
    const searchedStatuses = ["Done", "Failed"];
    const searched = rows.filter((r) => searchedStatuses.includes(r.get("Status") || "")).length;
    const matchFound = rows.filter(
      (r) => r.get("Status") === "Done" && (r.get("Deal Type") || "none") !== "none"
    ).length;
    const checkoutVerified = rows.filter((r) => (r.get("Checkout Verified Price") || "") !== "").length;
    const worthPursuing = products.length;
    const funnel = { searched, matchFound, checkoutVerified, worthPursuing };

    // Vendor tier breakdown among qualifying leads, for the donut chart.
    const tierCounts = {};
    for (const p of products) {
      const t = p.vendorTier || "Unranked";
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }
    const tierBreakdown = Object.entries(tierCounts).map(([tier, count]) => ({ tier, count }));

    // Hit-rate trend: % of that day's searched rows that became a real lead.
    const searchedByDate = {};
    for (const r of rows) {
      if (!searchedStatuses.includes(r.get("Status") || "")) continue;
      const d = r.get("Processed Date") || "Unknown";
      searchedByDate[d] = (searchedByDate[d] || 0) + 1;
    }
    const hitRateTrend = Object.keys(searchedByDate)
      .sort()
      .slice(-14)
      .map((date) => {
        const leadsThatDay = products.filter((p) => p.dateFound === date).length;
        const total = searchedByDate[date];
        return {
          date,
          hitRate: total > 0 ? +((leadsThatDay / total) * 100).toFixed(1) : 0,
        };
      });

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

    // Day-over-day change for the KPI cards (most recent day vs the one before).
    function dayOverDayChange(arr, key) {
      if (!arr || arr.length < 2) return null;
      const last = arr[arr.length - 1][key] || 0;
      const prev = arr[arr.length - 2][key] || 0;
      if (prev === 0) return last > 0 ? 100 : 0;
      return +(((last - prev) / prev) * 100).toFixed(0);
    }
    const trends = {
      leadsChange: dayOverDayChange(dailyStats, "leads"),
      profitChange: dayOverDayChange(dailyStats, "potentialProfit"),
      leadsSparkline: dailyStats.slice(-7).map((d) => d.leads),
      profitSparkline: dailyStats.slice(-7).map((d) => d.potentialProfit),
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        products: recentProducts,
        profitRanked,
        summary,
        funnel,
        tierBreakdown,
        trends,
        hitRateTrend,
        lastRun,
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
