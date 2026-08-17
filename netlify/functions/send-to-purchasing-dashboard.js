// netlify/functions/send-to-purchasing-dashboard.js
//
// Pushes one sourced lead into your OTHER (purchasing/tracking) dashboard's
// Google Sheet - a completely separate spreadsheet from this tool's own
// Sheet1. Uses the same Google service account credentials as everything
// else here, so the target sheet just needs to be shared with that same
// client_email (Editor access) for this to work.
//
// Financial fields (Total Fees, Breakeven, Profit, ROI, Profit Margin) are
// calculated here using a flat 15% referral-fee estimate - a reasonable
// starting number, not an exact Amazon fee (real fees vary by category and
// include FBA fulfillment costs based on weight/size, which aren't
// reliably available for every lead). Treat these as estimates.

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const REFERRAL_FEE_RATE = 0.15;

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

function amazonImageUrl(asin) {
  return `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const {
    PURCHASING_SHEET_ID,
    GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY,
    ADMIN_KEY,
  } = process.env;

  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  if (!PURCHASING_SHEET_ID) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "PURCHASING_SHEET_ID is not configured yet." }),
    };
  }

  let lead;
  try {
    lead = JSON.parse(event.body || "{}");
    if (!lead.asin && !lead.title) throw new Error("No product data provided");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request: " + err.message }) };
  }

  try {
    const jwt = new JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key: normalizePrivateKey(GOOGLE_PRIVATE_KEY),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const doc = new GoogleSpreadsheet(PURCHASING_SHEET_ID, jwt);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Sheet1"];
    if (!sheet) {
      throw new Error(
        'No "Sheet1" tab found on the purchasing dashboard sheet - check the tab name matches exactly.'
      );
    }

    const costPrice = lead.sourcingPrice || 0;
    const salePrice = lead.amazonPrice || 0;
    const totalFees = +(salePrice * REFERRAL_FEE_RATE).toFixed(2);
    const breakeven = +(costPrice + totalFees).toFixed(2);
    const profit = +(salePrice - costPrice - totalFees).toFixed(2);
    const roi = costPrice > 0 ? +((profit / costPrice) * 100).toFixed(1) : "";
    const profitMargin = salePrice > 0 ? +((profit / salePrice) * 100).toFixed(1) : "";

    await sheet.addRow({
      Date: new Date().toISOString().slice(0, 10),
      Image: lead.asin ? amazonImageUrl(lead.asin) : "",
      "Product Name": lead.title || "",
      Category: "", // not reliably available yet - left blank on purpose
      ASIN: lead.asin || "",
      "Amazon URL": lead.asin ? `https://www.amazon.com/dp/${lead.asin}` : "",
      "Source URL": lead.sourceLink || "",
      "Last Note": lead.notes || "",
      Quantity: "", // you fill this in once you've decided how many to buy
      "Cost Price": costPrice,
      Tags: lead.vendorTier || "",
      "Sale Price": salePrice,
      Breakeven: breakeven,
      Profit: profit,
      ROI: roi,
      "Profit Margin": profitMargin,
      "Sales Rank": lead.salesRank || "",
      "Total Fees": totalFees,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sent: true, profit, roi, breakeven }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
