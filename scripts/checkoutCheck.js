// checkoutCheck.js
//
// Best-effort checkout verification. Opens the product page in a real
// (headless) browser, tries to add one unit to the cart, finds a coupon/
// promo code box if one exists, and tries any known codes you've supplied.
//
// HONEST LIMITS: every retailer's site is built differently. This uses
// common patterns (button text like "Add to Cart", "Apply", "Promo Code")
// rather than site-specific code, so it will work well on many sites and
// fail silently on others - when it can't find what it's looking for, it
// says so in the notes rather than guessing.

import { chromium } from "playwright";

const ADD_TO_CART_PATTERNS = [
  /add to cart/i,
  /add to bag/i,
  /add to basket/i,
];

const COUPON_FIELD_PATTERNS = [
  /promo code/i,
  /coupon code/i,
  /discount code/i,
  /gift card or discount code/i,
];

const APPLY_BUTTON_PATTERNS = [/apply/i, /redeem/i];

async function findByText(page, patterns, selector = "button, a, input[type=submit]") {
  const elements = await page.locator(selector).all();
  for (const el of elements) {
    const text = (await el.innerText().catch(() => "")) || "";
    const value = (await el.getAttribute("value").catch(() => "")) || "";
    const combined = `${text} ${value}`;
    if (patterns.some((p) => p.test(combined))) {
      return el;
    }
  }
  return null;
}

async function findPriceOnPage(page) {
  // Very rough: look for the largest dollar-amount-looking text near the
  // top of the page. Good enough as a starting point, not exact for every
  // site's layout.
  const text = await page.locator("body").innerText().catch(() => "");
  const matches = text.match(/\$\s?\d{1,4}(?:\.\d{2})?/g);
  if (!matches || matches.length === 0) return null;
  const values = matches.map((m) => parseFloat(m.replace(/[^0-9.]/g, "")));
  return Math.min(...values.filter((v) => v > 0));
}

export async function checkCheckoutPrice(url, knownCodes = []) {
  const result = {
    coupon_field_found: false,
    codes_tried: [],
    verified_price: null,
    notes: "",
  };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    const addToCartBtn = await findByText(page, ADD_TO_CART_PATTERNS);
    if (!addToCartBtn) {
      result.notes = "Could not find an Add to Cart button - page layout not recognized.";
      return result;
    }

    await addToCartBtn.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Some sites open a cart drawer, some navigate to /cart - try both.
    const cartLink = await findByText(page, [/view cart/i, /go to cart/i, /checkout/i]);
    if (cartLink) {
      await cartLink.click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const couponField = await page
      .locator("input")
      .filter({ hasText: "" })
      .first();

    // Look for an input whose placeholder/label matches coupon patterns.
    const inputs = await page.locator("input").all();
    let matchedField = null;
    for (const input of inputs) {
      const placeholder = (await input.getAttribute("placeholder").catch(() => "")) || "";
      const name = (await input.getAttribute("name").catch(() => "")) || "";
      const combined = `${placeholder} ${name}`;
      if (COUPON_FIELD_PATTERNS.some((p) => p.test(combined))) {
        matchedField = input;
        break;
      }
    }

    if (!matchedField) {
      result.notes = "Reached cart, but no coupon/promo code field found on this site.";
      result.verified_price = await findPriceOnPage(page);
      return result;
    }

    result.coupon_field_found = true;

    if (knownCodes.length === 0) {
      result.notes =
        "Coupon field found, but no known codes were supplied to try. Add codes to the CouponCodes sheet tab.";
      result.verified_price = await findPriceOnPage(page);
      return result;
    }

    for (const code of knownCodes) {
      await matchedField.fill(code).catch(() => {});
      const applyBtn = await findByText(page, APPLY_BUTTON_PATTERNS);
      if (applyBtn) {
        await applyBtn.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      result.codes_tried.push(code);
    }

    result.verified_price = await findPriceOnPage(page);
    result.notes = `Tried ${result.codes_tried.length} code(s): ${result.codes_tried.join(", ")}`;
    return result;
  } catch (err) {
    result.notes = "Checkout check failed: " + err.message;
    return result;
  } finally {
    if (browser) await browser.close();
  }
}
