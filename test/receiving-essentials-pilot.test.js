const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CATEGORY,
  INVENTORY_POLICY,
  buildReceivingPolicy,
  categoryForItem,
} = require("../receiving-policy");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("retail cases project POS units but cannot write inventory", () => {
  const policy = buildReceivingPolicy({
    title: "Protein Drink Case",
    pickedQty: 2,
    unitsPerCase: 12,
    productCollections: [{ title: "Retail Essentials", handle: "retail-essentials" }],
  });
  assert.equal(policy.category, CATEGORY.RETAIL);
  assert.equal(policy.inventoryPolicy, INVENTORY_POLICY.RETAIL_CASE_TO_POS_UNITS);
  assert.equal(policy.projectedPosUnits, 24);
  assert.equal(policy.posInventoryWriteEnabled, false);
});

test("Other Essentials are receipt-only and never create POS units", () => {
  const policy = buildReceivingPolicy({
    title: "Toilet Paper Case",
    pickedQty: 3,
    unitsPerCase: 24,
    productTags: ["Other Essentials"],
  });
  assert.equal(policy.category, CATEGORY.OTHER);
  assert.equal(policy.inventoryPolicy, INVENTORY_POLICY.RECEIPT_ONLY_NO_POS);
  assert.equal(policy.projectedPosUnits, 0);
  assert.equal(policy.posInventoryWriteEnabled, false);
});

test("food remains on the existing flow and apparel cannot enter Retail Essentials", () => {
  assert.equal(categoryForItem({ title: "Chicken Stir Fry" }), CATEGORY.FOOD);
  assert.equal(categoryForItem({ title: "Hummus Fit Hoodie", productTags: ["Retail Essentials"] }), CATEGORY.FOOD);
});

test("the iPhone app shell is store-specific and never caches live orders", () => {
  const server = read("server.js");
  const html = read("public/receiving.html");
  const worker = read("public/receiving-sw.js");
  assert.match(server, /app\.get\("\/manifest\/:store\.webmanifest"/);
  assert.match(server, /start_url: `\/receiving\/\$\{encodeURIComponent\(store\)\}`/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /manifest\.href = '\/manifest\/'/);
  assert.match(html, /serviceWorker\.register\('\/receiving-sw\.js'\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/receiving\/"\)/);
});

test("the pilot records policies but contains no Shopify or POS inventory mutation", () => {
  const server = read("server.js");
  const html = read("public/receiving.html");
  assert.match(server, /posInventoryWritesEnabled: false/);
  assert.match(server, /posInventoryWriteEnabled: false/);
  assert.match(html, /These items never enter POS inventory/);
  assert.match(html, /no inventory was changed/);
  for (const forbidden of ["inventoryAdjust", "inventorySet", "shopifyGraphQL", "/api/pos-inventory"]) {
    assert.equal((server + html).includes(forbidden), false, `must not contain ${forbidden}`);
  }
});
