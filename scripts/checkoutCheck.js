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
  // Prefer a price near "total" / "subtotal" text - much more likely to be
  // the actual cart total than a random price elsewhere on the page.
  const totalMatch = await page.evaluate(() => {
    const regex = /(subtotal|order total|cart total|total)/i;
    const priceRegex = /\$\s?\d{1,4}(?:\.\d{2})?/;
    const all = Array.from(document.querySelectorAll("body *"));
    for (const el of all) {
      const text = el.textContent || "";
      if (regex.test(text) && priceRegex.test(text) && text.length < 100) {
        const m = text.match(priceRegex);
        if (m) return m[0];
      }
    }
    return null;
  }).catch(() => null);

  if (totalMatch) {
    return parseFloat(totalMatch.replace(/[^0-9.]/g, ""));
  }

  // Fallback: rough heuristic - smallest dollar-looking amount on the page.
  // Best-effort only; not reliable on every layout.
  const text = await page.locator("body").innerText().catch(() => "");
  const matches = text.match(/\$\s?\d{1,4}(?:\.\d{2})?/g);
  if (!matches || matches.length === 0) return null;
  const values = matches.map((m) => parseFloat(m.replace(/[^0-9.]/g, "")));
  return Math.min(...values.filter((v) => v > 0));
}

const QUANTITY = 3; // test bulk-of-3 pricing, then divide the total back to a per-unit price

async function findQuantityField(page) {
  const inputs = await page.locator("input").all();
  for (const input of inputs) {
    const name = (await input.getAttribute("name").catch(() => "")) || "";
    const id = (await input.getAttribute("id").catch(() => "")) || "";
    const ariaLabel = (await input.getAttribute("aria-label").catch(() => "")) || "";
    if (/qty|quantity/i.test(`${name} ${id} ${ariaLabel}`)) {
      return input;
    }
  }
  // Some sites use a <select> instead of a number input.
  const selects = await page.locator("select").all();
  for (const select of selects) {
    const name = (await select.getAttribute("name").catch(() => "")) || "";
    if (/qty|quantity/i.test(name)) return select;
  }
  return null;
}

async function setQuantity(page, field, qty) {
  const tag = await field.evaluate((el) => el.tagName.toLowerCase()).catch(() => "input");
  if (tag === "select") {
    await field.selectOption({ label: String(qty) }).catch(async () => {
      await field.selectOption(String(qty)).catch(() => {});
    });
  } else {
    await field.fill(String(qty)).catch(() => {});
    await field.press("Tab").catch(() => {});
  }
}

async function fillZipIfPresent(page, zip) {
  if (!zip) return false;
  const inputs = await page.locator("input").all();
  for (const input of inputs) {
    const placeholder = (await input.getAttribute("placeholder").catch(() => "")) || "";
    const name = (await input.getAttribute("name").catch(() => "")) || "";
    const ariaLabel = (await input.getAttribute("aria-label").catch(() => "")) || "";
    const combined = `${placeholder} ${name} ${ariaLabel}`;
    if (/zip|postal/i.test(combined)) {
      await input.fill(zip).catch(() => {});
      const estimateBtn = await findByText(page, [/estimate/i, /calculate/i, /apply/i], "button");
      if (estimateBtn) {
        await estimateBtn.click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      return true;
    }
  }
  return false;
}

export async function checkCheckoutPrice(url, knownCodes = [], shipZip = "") {
  const result = {
    coupon_field_found: false,
    codes_tried: [],
    verified_price: null, // per-unit, after dividing the 3-unit total
    verified_total_price: null, // raw total for 3 units, before dividing
    quantity_tested: QUANTITY,
    zip_applied: false,
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

    // Try to set quantity to 3 before adding to cart (common on product pages).
    const qtyFieldOnPage = await findQuantityField(page);
    if (qtyFieldOnPage) {
      await setQuantity(page, qtyFieldOnPage, QUANTITY);
    }

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

    // If quantity wasn't settable on the product page, try again now we're
    // in the cart - many sites only expose quantity controls here.
    if (!qtyFieldOnPage) {
      const qtyFieldInCart = await findQuantityField(page);
      if (qtyFieldInCart) {
        await setQuantity(page, qtyFieldInCart, QUANTITY);
        await page.waitForTimeout(1500);
      }
    }

    result.zip_applied = await fillZipIfPresent(page, shipZip);

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
      const zipNote = result.zip_applied ? " Shipping estimate applied via ZIP." : "";
      result.notes = "Reached cart, but no coupon/promo code field found on this site." + zipNote;
      recordPrice(result, await findPriceOnPage(page));
      return result;
    }

    result.coupon_field_found = true;

    if (knownCodes.length === 0) {
      const zipNote = result.zip_applied ? " Shipping estimate applied via ZIP." : "";
      result.notes =
        "Coupon field found, but no known codes were supplied to try. Add codes to the CouponCodes sheet tab." +
        zipNote;
      recordPrice(result, await findPriceOnPage(page));
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

    recordPrice(result, await findPriceOnPage(page));
    const zipNote = result.zip_applied ? " Shipping estimate applied via ZIP." : "";
    result.notes = `Tried ${result.codes_tried.length} code(s) on ${QUANTITY} units: ${result.codes_tried.join(", ")}.${zipNote}`;
    return result;
  } catch (err) {
    result.notes = "Checkout check failed: " + err.message;
    return result;
  } finally {
    if (browser) await browser.close();
  }
}

// Stores the raw total found on the page, and the per-unit price after
// dividing by the tested quantity (3) - this is the number that's actually
// comparable to Amazon's single-unit listing price.
function recordPrice(result, totalPrice) {
  if (totalPrice == null) return;
  result.verified_total_price = totalPrice;
  result.verified_price = +(totalPrice / QUANTITY).toFixed(2);
}
