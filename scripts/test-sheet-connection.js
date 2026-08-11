// test-sheet-connection.js
//
// FREE TEST - no Anthropic API calls. Just confirms your Google Sheets
// service account can actually read and write your Sheet, before you
// spend anything on the real thing.
//
// Run it the same way as the main script (same env vars), e.g. locally:
//   SHEET_ID=... GOOGLE_CLIENT_EMAIL=... GOOGLE_PRIVATE_KEY=... node scripts/test-sheet-connection.js
// Or as a one-off GitHub Actions run - see the setup guide.

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const { SHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;

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

async function main() {
  console.log("Testing Google Sheets connection (no API cost)...\n");

  const jwt = new JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: normalizePrivateKey(GOOGLE_PRIVATE_KEY),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
  await doc.loadInfo();
  console.log(`✔ Connected to Sheet: "${doc.title}"`);

  const sheet = doc.sheetsByTitle["Sheet1"];
  if (!sheet) throw new Error('✘ No tab named "Sheet1" found.');
  const rows = await sheet.getRows();
  console.log(`✔ Sheet1 found, ${rows.length} row(s) of data.`);

  const vendorTiers = doc.sheetsByTitle["VendorTiers"];
  console.log(vendorTiers ? "✔ VendorTiers tab found." : "  (no VendorTiers tab yet - optional)");

  const couponCodes = doc.sheetsByTitle["CouponCodes"];
  console.log(couponCodes ? "✔ CouponCodes tab found." : "  (no CouponCodes tab yet - optional)");

  // Write test: adds a throwaway row, then deletes it, to confirm write access.
  const testRow = await sheet.addRow({ Title: "TEST ROW - safe to ignore/delete" });
  console.log("✔ Write access confirmed (test row added).");
  await testRow.delete();
  console.log("✔ Test row cleaned up.");

  console.log("\nAll checks passed - your Sheet connection is working correctly.");
}

main().catch((err) => {
  console.error("\n✘ Test failed:", err.message);
  process.exit(1);
});
