const test = require("node:test");
const assert = require("node:assert/strict");
const { reconciliationStatus, POS_STORES, AGENT_LABEL } = require("../reconciliation-status");

const caseItem = {
  title: "Coca-Cola Plus 8-pack", sku: "CASE-8", receivingCategory: "retail_essentials",
  expectedFromPicking: 2, actuallyReceived: 2, diff: 0,
};
const posted = { sku: "CASE-8", status: "posted", units: 16 };

test("only the 14 approved Hummus Fit POS locations have an automatic conversion expectation", () => {
  assert.equal(POS_STORES.size, 14);
  assert.equal(POS_STORES.has("Holbrook"), true);
  assert.equal(POS_STORES.has("Brookfield"), false);
  assert.equal(POS_STORES.has("Fishkill"), false);
});

test("a clean verified case conversion is not described as a discrepancy correction", () => {
  const status = reconciliationStatus({ store: "Holbrook", items: [caseItem], posInventoryResults: [posted] });
  assert.equal(status.status, "conversion_posted");
  assert.equal(status.postedUnits, 16);
});

test("a missing case still requires inventory review even when received cases converted", () => {
  const shortItem = { ...caseItem, actuallyReceived: 1, diff: -1 };
  const status = reconciliationStatus({ store: "Holbrook", items: [shortItem], posInventoryResults: [{ ...posted, units: 8 }] });
  assert.equal(status.status, "needs_review");
  assert.equal(status.discrepancyLines, 1);
  assert.equal(status.postedUnits, 8);
});

test("wrong items and food shortages remain in the action queue", () => {
  const wrong = reconciliationStatus({ store: "Holbrook", items: [], extraItems: [{ code: "UNRECOGNIZED", qty: 1 }] });
  assert.equal(wrong.status, "needs_review");
  const food = reconciliationStatus({ store: "Holbrook", items: [{ ...caseItem, receivingCategory: "food", diff: -1 }] });
  assert.equal(food.status, "needs_review");
});

test("a clean receipt with an unconfirmed POS posting needs review; Other Essentials remain receipt-only", () => {
  assert.equal(reconciliationStatus({ store: "Holbrook", items: [caseItem], posInventoryResults: [] }).status, "needs_review");
  const other = { ...caseItem, receivingCategory: "other_essentials" };
  assert.equal(reconciliationStatus({ store: "Holbrook", items: [other] }).status, "receipt_verified");
});

const report = {
  id: "Holbrook::1", store: "Holbrook", orderId: "gid://shopify/Order/123",
  inventoryLocationId: "gid://shopify/Location/456", submittedAt: "2026-10-05T10:00:00Z",
  posInventoryResults: [{ sku: "CASE-8", status: "posted", units: 8 }],
  items: [{ ...caseItem, orderedQty: 2, actuallyReceived: 1, diff: -1, orderDiff: -1 },
    { title: "Chicken meal", sku: "MEAL-1", receivingCategory: "food", orderedQty: 4, expectedFromPicking: 2, actuallyReceived: 3, diff: 1, orderDiff: -1 }],
};
const correction = (key, sku, adjustmentId) => ({
  status: "posted", shopifyVerified: true, source: AGENT_LABEL,
  reportId: report.id, orderId: report.orderId, store: report.store,
  discrepancyKey: key, locationId: report.inventoryLocationId,
  inventoryItemId: "gid://shopify/InventoryItem/789", sku, delta: -1,
  adjustmentId: `gid://shopify/InventoryAdjustmentGroup/${adjustmentId}`,
  postedAt: "2026-10-05T10:01:00Z",
});

test("one confirmed correction leaves the order partially corrected and shows the pending line", () => {
  const result = reconciliationStatus({ ...report, inventoryCorrections: [correction("item:0", "CASE-8", 900)] });
  assert.equal(result.status, "partially_corrected");
  assert.equal(result.correctedCount, 1);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.correctionLines[0].adjustmentId, "gid://shopify/InventoryAdjustmentGroup/900");
  assert.equal(result.correctionLines[1].status, "pending");
});

test("the order says solved only when every discrepancy has Shopify proof for that store", () => {
  const result = reconciliationStatus({ ...report, inventoryCorrections: [
    correction("item:0", "CASE-8", 900), correction("item:1", "MEAL-1", 901),
  ] });
  assert.equal(result.status, "corrected");
  assert.equal(result.label, "Solved by Agent Hazar – Receiving");
  assert.equal(result.correctedAt, "2026-10-05T10:01:00Z");
  assert.equal(result.pendingCount, 0);
});

test("confirmed discrepancy adjustments cannot hide a failed POS case conversion", () => {
  const result = reconciliationStatus({ ...report, posInventoryResults: [], inventoryCorrections: [
    correction("item:0", "CASE-8", 900), correction("item:1", "MEAL-1", 901),
  ] });
  assert.equal(result.status, "partially_corrected");
  assert.match(result.detail, /POS case conversion is also not confirmed/);
  assert.equal(result.correctedAt, null);
});

test("zero received cases do not require a POS unit conversion", () => {
  const emptyCase = { ...report.items[0], actuallyReceived: 0, diff: -2, orderDiff: -2 };
  const result = reconciliationStatus({ ...report, items: [emptyCase],
    posInventoryResults: [{ sku: "CASE-8", status: "zero_received", units: 0 }],
    inventoryCorrections: [{ ...correction("item:0", "CASE-8", 900), delta: -2 }],
  });
  assert.equal(result.status, "corrected");
});

test("a claim without the exact store, order, verified Shopify group, and timestamp cannot say solved", () => {
  const bad = [
    { ...correction("item:0", "CASE-8", 900), store: "Islip" },
    { ...correction("item:0", "CASE-8", 900), adjustmentId: "not-a-Shopify-adjustment" },
    { ...correction("item:0", "CASE-8", 900), shopifyVerified: false },
    { ...correction("item:0", "CASE-8", 900), postedAt: "2026-10-05T09:59:00Z" },
    { ...correction("item:0", "CASE-8", 900), locationId: "gid://shopify/Location/999" },
    { ...correction("item:0", "CASE-8", 900), delta: -2 },
  ];
  for (const entry of bad) {
    assert.equal(reconciliationStatus({ ...report, items: [report.items[0]], inventoryCorrections: [entry] }).status, "needs_review");
  }
});

test("unknown extras require catalog verification, and B2B cannot receive Agent Hazar POS resolution", () => {
  const extra = { ...report, items: [], extraItems: [{ code: "999", qty: 1 }] };
  const entry = { ...correction("extra:0", "KNOWN-SKU", 902), delta: 1, catalogVerified: false };
  assert.equal(reconciliationStatus({ ...extra, inventoryCorrections: [entry] }).status, "needs_review");
  assert.equal(reconciliationStatus({ ...extra, inventoryCorrections: [{ ...entry, catalogVerified: true }] }).status, "corrected");
  assert.equal(reconciliationStatus({ ...extra, store: "Brookfield", inventoryCorrections: [{ ...entry, catalogVerified: true }] }).status, "needs_review");
});

test("a Hummus Fit store sees ordered-versus-received gaps even if picking matched receipt", () => {
  const item = { ...caseItem, orderedQty: 3, expectedFromPicking: 2, actuallyReceived: 2, diff: 0, orderDiff: -1 };
  const result = reconciliationStatus({ ...report, items: [item], inventoryCorrections: [] });
  assert.equal(result.status, "needs_review");
  assert.equal(result.discrepancyLines, 1);
  assert.equal(result.correctionLines[0].orderDiff, -1);
  assert.equal(reconciliationStatus({ ...report, store: "Brookfield", items: [item] }).discrepancyLines, 0);
});
