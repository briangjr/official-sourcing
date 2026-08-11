// test-checkout.js
//
// FREE TEST - no Anthropic API calls. Runs the real checkout/coupon
// automation (quantity-of-3, ZIP, coupon codes) against a URL you provide
// directly, so you can see exactly what it finds without spending anything
// on the search step.
//
// Usage:
//   TEST_URL="https://www.example.com/some-product" node scripts/test-checkout.js
//
// Optional:
//   SHIP_ZIP=48101 TEST_URL="..." node scripts/test-checkout.js
//   (add codes to try by editing knownCodes below, or wire up loadKnownCodes
//   from process.js if you want it to pull from your CouponCodes tab)

import { checkCheckoutPrice } from "./checkoutCheck.js";

const { TEST_URL, SHIP_ZIP = "", TEST_CODES = "" } = process.env;

async function main() {
  if (!TEST_URL) {
    console.error("Set TEST_URL to a product page URL first, e.g.:");
    console.error('  TEST_URL="https://www.walmart.com/ip/..." node scripts/test-checkout.js');
    process.exit(1);
  }

  const knownCodes = TEST_CODES ? TEST_CODES.split(",").map((c) => c.trim()) : [];

  console.log(`Testing checkout flow on: ${TEST_URL}`);
  console.log(`Quantity: 3 | ZIP: ${SHIP_ZIP || "(none)"} | Codes to try: ${knownCodes.join(", ") || "(none)"}\n`);

  const result = await checkCheckoutPrice(TEST_URL, knownCodes, SHIP_ZIP);

  console.log("Result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
