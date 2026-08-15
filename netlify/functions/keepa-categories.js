// netlify/functions/keepa-categories.js
//
// Fetches the full root category list from Keepa (category=0 is a special
// value meaning "give me all root categories") - used to populate the
// Discover tab's category dropdown. Cheap, one-off lookup, not a per-ASIN
// cost like the product search.

const DOMAIN_US = 1;

export async function handler(event) {
  const { KEEPA_API_KEY, ADMIN_KEY } = process.env;
  const providedKey = event.headers["x-admin-key"];
  if (ADMIN_KEY && providedKey !== ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    const res = await fetch(
      `https://api.keepa.com/category?key=${KEEPA_API_KEY}&domain=${DOMAIN_US}&category=0`
    );
    const data = await res.json();
    if (!res.ok || !data.categories) {
      return { statusCode: 502, body: JSON.stringify({ error: "Keepa category lookup failed", detail: data }) };
    }

    const categories = Object.entries(data.categories)
      .map(([id, cat]) => ({ id, name: cat.name || `Category ${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categories }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
