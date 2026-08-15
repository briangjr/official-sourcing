// netlify/functions/keepa-search.js
//
// Two Keepa API calls per search:
//   1. /query (Product Finder) - returns a bare ASIN list matching your filters.
//   2. /product - fetches title/price/details for those specific ASINs.
// Token cost: ~10 + 1/100 results (finder) + 1 per ASIN detail fetch.
// The response includes tokensLeft so you always see what a search costs.

const DOMAIN_US = 1;

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const { KEEPA_API_KEY, ADMIN_KEY } = process.env;
  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let filters;
  try {
    filters = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  // Keepa's minimum for perPage appears to be higher than the dashboard's
  // 30-result default in some configurations - clamp to a safer floor.
  // "page" is left out entirely rather than sent as 0 - Keepa's own error
  // pointed at that combination specifically.
  const perPage = Math.min(Math.max(parseInt(filters.perPage, 10) || 30, 10), 100);

  // Map the dashboard's filter fields to Keepa's actual Product Finder
  // field names. Only include a filter if the person actually set a value -
  // an unset field should not restrict the search.
  // Stopped trying to guess Keepa's exact perPage/page validation rule -
  // two attempts at getting that combination right both failed with the
  // same error. Simplest fix: don't send either field at all. Keepa
  // returns its own (larger) default result set, and we just trim it down
  // to what was actually requested ourselves, below.
  const selection = {};
  if (filters.salesRankMin != null) selection.current_SALES_gte = filters.salesRankMin;
  if (filters.salesRankMax != null) selection.current_SALES_lte = filters.salesRankMax;
  if (filters.buyBoxMin != null) selection.current_BUY_BOX_SHIPPING_gte = Math.round(filters.buyBoxMin * 100);
  if (filters.buyBoxMax != null) selection.current_BUY_BOX_SHIPPING_lte = Math.round(filters.buyBoxMax * 100);
  if (filters.sellersMin != null) selection.totalOfferCount_gte = filters.sellersMin;
  if (filters.sellersMax != null) selection.totalOfferCount_lte = filters.sellersMax;
  if (filters.amazonBuyBoxPctMax != null) selection.buyBoxStatsAmazon90_lte = filters.amazonBuyBoxPctMax;
  if (filters.topSellerBuyBoxMax != null) selection.buyBoxStatsTopSeller90_lte = filters.topSellerBuyBoxMax;
  if (filters.minMonthlySold != null) selection.monthlySold_gte = filters.minMonthlySold;
  if (filters.maxWeightLbs != null) {
    // Keepa wants grams.
    selection.packageWeight_lte = Math.round(filters.maxWeightLbs * 453.59237);
  }
  if (filters.maxOutOfStockPct != null) selection.outOfStockPercentage90_lte = filters.maxOutOfStockPct;
  // Trend/seasonality signal: a low 30-day average rank combined with a
  // higher 365-day average means the product is ranking meaningfully
  // better right now than its yearly average - a sign of a current
  // upswing (seasonal or otherwise). Same avg{N}_TYPE naming pattern as
  // the already-confirmed current_SALES field.
  if (filters.avg30RankMax != null) selection.avg30_SALES_lte = filters.avg30RankMax;
  if (filters.avg365RankMin != null) selection.avg365_SALES_gte = filters.avg365RankMin;
  if (filters.rootCategory != null) selection.rootCategory = filters.rootCategory;

  try {
    // Step 1: Product Finder - get matching ASINs.
    // IMPORTANT: "selection" goes in the URL as a query parameter (JSON,
    // URL-encoded), same as domain and key - not as the POST body. This
    // was wrong in the first version and is the most likely cause of the
    // first "search failed" error.
    const selectionParam = encodeURIComponent(JSON.stringify(selection));
    const findRes = await fetch(
      `https://api.keepa.com/query?key=${KEEPA_API_KEY}&domain=${DOMAIN_US}&selection=${selectionParam}`,
      { method: "POST" }
    );
    const findData = await findRes.json();
    if (!findRes.ok || !findData.asinList) {
      // A negative/very low tokensLeft with no explicit error message
      // usually means Keepa rejected the request for being rate-limited,
      // not a real bug - surface that plainly instead of a raw JSON dump.
      if (findData.tokensLeft != null && findData.tokensLeft < 5) {
        const waitMins = Math.ceil((findData.refillIn || 0) / 60000) || Math.ceil((5 - findData.tokensLeft) / (findData.refillRate || 1));
        return {
          statusCode: 429,
          body: JSON.stringify({
            error: `Keepa token balance too low (${findData.tokensLeft} left) - wait about ${waitMins} minute(s) and try again.`,
          }),
        };
      }
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Keepa search failed", detail: findData }),
      };
    }

    const asins = findData.asinList.slice(0, perPage);
    if (asins.length === 0) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: [], totalResults: findData.totalResults || 0, tokensLeft: findData.tokensLeft }),
      };
    }

    // Step 2: fetch details for those specific ASINs.
    const detailRes = await fetch(
      `https://api.keepa.com/product?domain=${DOMAIN_US}&key=${KEEPA_API_KEY}&asin=${asins.join(",")}&stats=180`
    );
    const detailData = await detailRes.json();
    if (!detailRes.ok || !detailData.products) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Keepa product detail fetch failed", detail: detailData }),
      };
    }

    // Field names below are Keepa's documented product/stats object fields.
    // Keepa uses negative numbers (e.g. -1, -2) as a "no data available"
    // sentinel, not a real price - treating those as a literal price
    // produces garbage like -$0.02. validPrice() rejects anything <= 0.
    // Defensive fallbacks throughout - a missing field shows as null/"—"
    // on the dashboard rather than breaking the whole search.
    const validPrice = (raw) =>
      typeof raw === "number" && raw > 0 ? +(raw / 100).toFixed(2) : null;

    const results = detailData.products.map((p) => ({
      asin: p.asin,
      title: p.title || "(no title)",
      // Prefer the actual Buy Box price; if Keepa has no current Buy Box
      // (common when Amazon itself isn't in the box, or it's briefly
      // unavailable), fall back to Amazon's own listed price rather than
      // leaving it blank or writing a nonsense negative value.
      buyBoxPrice: validPrice(p.stats?.buyBoxPrice) ?? validPrice(p.stats?.current?.[0]),
      salesRank: p.stats?.current?.[3] ?? p.salesRank ?? null,
      totalOfferCount: p.totalOfferCount ?? null,
      monthlySold: p.monthlySold ?? null,
      packageWeightLbs: p.packageWeight ? +(p.packageWeight / 453.59237).toFixed(2) : null,
      buyBoxPctAmazon90: p.stats?.buyBoxStatsAmazon90 ?? null,
      buyBoxPctTopSeller90: p.stats?.buyBoxStatsTopSeller90 ?? null,
      brand: p.brand || "",
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        results,
        totalResults: findData.totalResults || 0,
        tokensLeft: detailData.tokensLeft,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
