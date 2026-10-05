const test = require("node:test");
const assert = require("node:assert/strict");
const { reconciliationStatus, POS_STORES } = require("../reconciliation-status");

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
