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

  const perPage = Math.min(Math.max(parseInt(filters.perPage, 10) || 30, 1), 100);

  // Map the dashboard's filter fields to Keepa's actual Product Finder
  // field names. Only include a filter if the person actually set a value -
  // an unset field should not restrict the search.
  const selection = { perPage, page: 0 };
  if (filters.salesRankMin != null) selection.current_SALES_gte = filters.salesRankMin;
  if (filters.salesRankMax != null) selection.current_SALES_lte = filters.salesRankMax;
  if (filters.sellersMin != null) selection.totalOfferCount_gte = filters.sellersMin;
  if (filters.sellersMax != null) selection.totalOfferCount_lte = filters.sellersMax;
  if (filters.topSellerBuyBoxMax != null) selection.buyBoxStatsTopSeller90_lte = filters.topSellerBuyBoxMax;
  if (filters.minMonthlySold != null) selection.monthlySold_gte = filters.minMonthlySold;
  if (filters.maxWeightLbs != null) {
    // Keepa wants grams.
    selection.packageWeight_lte = Math.round(filters.maxWeightLbs * 453.59237);
  }
  if (filters.maxOutOfStockPct != null) selection.outOfStockPercentage90_lte = filters.maxOutOfStockPct;

  try {
    // Step 1: Product Finder - get matching ASINs.
    const findRes = await fetch(
      `https://api.keepa.com/query?domain=${DOMAIN_US}&key=${KEEPA_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      }
    );
    const findData = await findRes.json();
    if (!findRes.ok || !findData.asinList) {
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
    // Defensive fallbacks throughout - a missing field shows as null/"—"
    // on the dashboard rather than breaking the whole search.
    const results = detailData.products.map((p) => ({
      asin: p.asin,
      title: p.title || "(no title)",
      buyBoxPrice: p.stats?.buyBoxPrice != null ? +(p.stats.buyBoxPrice / 100).toFixed(2) : null,
      salesRank: p.stats?.current?.[3] ?? p.salesRank ?? null,
      totalOfferCount: p.totalOfferCount ?? null,
      monthlySold: p.monthlySold ?? null,
      packageWeightLbs: p.packageWeight ? +(p.packageWeight / 453.59237).toFixed(2) : null,
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
