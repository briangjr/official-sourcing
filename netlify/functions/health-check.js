// netlify/functions/health-check.js
//
// A real diagnostic pass, not cosmetic: checks the Sheet connection, how
// stale the last run is, error/failed row counts, and whether the GitHub
// token can actually reach your repo. No AI involved - free to run anytime.

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
  const {
    SHEET_ID,
    GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY,
    GITHUB_TOKEN,
    GITHUB_OWNER,
    GITHUB_REPO,
    ADMIN_KEY,
  } = process.env;

  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const checks = [];

  // 1. Sheet connection
  let doc, rows;
  try {
    const jwt = new JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key: normalizePrivateKey(GOOGLE_PRIVATE_KEY),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    doc = new GoogleSpreadsheet(SHEET_ID, jwt);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["Sheet1"];
    if (!sheet) throw new Error('No "Sheet1" tab found');
    rows = await sheet.getRows();
    checks.push({
      name: "Google Sheet connection",
      ok: true,
      detail: `Connected to "${doc.title}", ${rows.length} row(s).`,
    });
  } catch (err) {
    checks.push({ name: "Google Sheet connection", ok: false, detail: err.message });
  }

  // 2. Required tabs present (optional ones just noted, not failed)
  if (doc) {
    checks.push({
      name: "VendorTiers tab",
      ok: Boolean(doc.sheetsByTitle["VendorTiers"]),
      detail: doc.sheetsByTitle["VendorTiers"] ? "Found." : "Not found (optional, but scoring won't use tiers without it).",
      warningOnly: true,
    });
    checks.push({
      name: "CouponCodes tab",
      ok: Boolean(doc.sheetsByTitle["CouponCodes"]),
      detail: doc.sheetsByTitle["CouponCodes"] ? "Found." : "Not found (optional).",
      warningOnly: true,
    });
  }

  // 3. Last run staleness
  if (doc) {
    try {
      const metaTab = doc.sheetsByTitle["Meta"];
      if (!metaTab) {
        checks.push({
          name: "Last run",
          ok: false,
          detail: "No Meta tab yet - the tool hasn't completed a run since this feature was added.",
          warningOnly: true,
        });
      } else {
        const metaRows = await metaTab.getRows();
        const lastRunRow = metaRows.find((r) => r.get("Key") === "LastRun");
        if (!lastRunRow) {
          checks.push({ name: "Last run", ok: false, detail: "No run recorded yet.", warningOnly: true });
        } else {
          const lastRun = new Date(lastRunRow.get("Value"));
          const hoursAgo = (Date.now() - lastRun.getTime()) / 3600000;
          const stale = hoursAgo > 3; // scheduled roughly hourly, so >3h suggests something's stuck
          checks.push({
            name: "Last run",
            ok: !stale,
            detail: `${hoursAgo.toFixed(1)} hour(s) ago${stale ? " - longer than expected, check the Actions tab" : ""}.`,
          });
        }
      }
    } catch (err) {
      checks.push({ name: "Last run", ok: false, detail: err.message });
    }
  }

  // 4. Error/Failed row counts
  if (rows) {
    const errorCount = rows.filter((r) => r.get("Status") === "Error").length;
    const failedCount = rows.filter((r) => r.get("Status") === "Failed").length;
    checks.push({
      name: "Errored/Failed rows",
      ok: failedCount === 0,
      detail: `${errorCount} retrying, ${failedCount} permanently failed.`,
      warningOnly: errorCount > 0 && failedCount === 0,
    });
  }

  // 5. GitHub Actions trigger connection
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (res.ok) {
      checks.push({ name: "GitHub Actions connection", ok: true, detail: "Token can reach your repo." });
    } else {
      checks.push({
        name: "GitHub Actions connection",
        ok: false,
        detail: `GitHub API returned ${res.status} - check GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO.`,
      });
    }
  } catch (err) {
    checks.push({ name: "GitHub Actions connection", ok: false, detail: err.message });
  }

  const overallOk = checks.filter((c) => !c.warningOnly).every((c) => c.ok);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overallOk, checks, checkedAt: new Date().toISOString() }),
  };
}
