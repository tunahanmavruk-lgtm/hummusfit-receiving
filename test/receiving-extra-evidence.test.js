const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanExtraLines, verifyExtraLines } = require("../receiving-extra-evidence");

test("a scanned extra keeps its physical count and only a server catalog match supplies SKU", async () => {
  const lines = cleanExtraLines({ "641837881716": 6 }, {
    "641837881716": { source: "scan", sku: "FORGED-SKU", title: "Forged title" },
  });
  const result = await verifyExtraLines(lines, async () => ({ status: "matched",
    productStatus: "ACTIVE", variantId: "gid://shopify/ProductVariant/123", sku: "ZEUS-BOWL", title: "Zeus Bowl" }));
  assert.deepEqual(result, [{ code: "641837881716", qty: 6, source: "scan",
    catalogStatus: "matched", catalogVerified: true,
    variantId: "gid://shopify/ProductVariant/123", sku: "ZEUS-BOWL", title: "Zeus Bowl" }]);
});

test("typed descriptions and legacy manual entries are rejected before saving", () => {
  assert.throws(() => cleanExtraLines({ "Grilled chicken pesto": 6 }), /identifying code/);
  assert.throws(() => cleanExtraLines({ "ZEUS-BOWL": 6 }, { "ZEUS-BOWL": { source: "manual" } }), /Free-text/);
  assert.throws(() => cleanExtraLines({ " ZEUS-BOWL ": 6 }), /identifying code/);
});

test("an ambiguous or unavailable lookup never authorizes inventory", async () => {
  const lines = cleanExtraLines({ "641837881716": 1 }, { "641837881716": { source: "scan" } });
  assert.equal((await verifyExtraLines(lines, async () => ({ status: "ambiguous" })))[0].catalogVerified, false);
  assert.equal((await verifyExtraLines(lines, async () => { throw new Error("offline"); }))[0].catalogStatus, "lookup_unavailable");
  assert.equal((await verifyExtraLines(lines, async () => ({ status: "matched", productStatus: "DRAFT",
    variantId: "gid://shopify/ProductVariant/123", sku: "ZEUS-BOWL" })))[0].catalogVerified, false);
});

test("invalid counts and excessive lines are rejected before a report is saved", () => {
  assert.throws(() => cleanExtraLines({ CODE123: -1 }), /whole-number/);
  assert.throws(() => cleanExtraLines({ CODE123: 1.5 }), /whole-number/);
  assert.throws(() => cleanExtraLines(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`CODE${i}`, 1]))), /Too many/);
});
