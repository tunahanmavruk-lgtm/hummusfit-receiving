// Reporting only. This module never changes Shopify inventory. A case-to-unit
// conversion is not proof that a shortage, overage, or wrong item was fixed.
const POS_STORES = new Set([
  "Bellmore", "Deer Park", "Islip", "Farmingdale", "Holbrook", "Huntington",
  "Island Park", "Lake Grove", "Lindenhurst", "Lynbrook", "Miller Place",
  "Ronkonkoma", "Selden", "Woodbury",
]);

function reconciliationStatus(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  const extraItems = Array.isArray(report.extraItems) ? report.extraItems : [];
  const results = Array.isArray(report.posInventoryResults) ? report.posInventoryResults : [];
  const discrepancies = items.filter((item) => Number(item.diff) !== 0).length +
    extraItems.filter((item) => Number(item.qty) > 0).length;
  const retail = items.filter((item) => item.receivingCategory === "retail_essentials");
  const postedResults = results.filter((result) => ["posted", "already_posted"].includes(result.status));
  const postedUnits = postedResults.reduce((sum, result) => sum + (Number(result.units) || 0), 0);
  const posResultsBySku = new Map(results.filter((result) => result.sku).map((result) => [result.sku, result]));
  const conversionPending = POS_STORES.has(report.store) && retail.some((item) => {
    if (Number(item.actuallyReceived) === 0 && Number(item.expectedFromPicking) === 0) return false;
    const result = posResultsBySku.get(item.sku || item.title);
    return !result || !["posted", "already_posted"].includes(result.status);
  });

  if (discrepancies > 0) return {
    status: "needs_review", label: "Inventory correction not confirmed",
    detail: "A shortage, overage, or wrong item still needs reconciliation against the store's Shopify inventory.",
    discrepancyLines: discrepancies, postedUnits,
  };
  if (conversionPending) return {
    status: "needs_review", label: "POS posting needs review",
    detail: "The receipt was saved, but at least one Retail Essentials sell-unit posting is not confirmed.",
    discrepancyLines: 0, postedUnits,
  };
  if (postedResults.length > 0) return {
    status: "conversion_posted", label: "POS case conversion posted",
    detail: "The verified Retail Essentials cases were converted to sell-units. No receiving discrepancy was reported.",
    discrepancyLines: 0, postedUnits,
  };
  return {
    status: "receipt_verified", label: "Receipt verified",
    detail: "No discrepancy was reported. This does not represent a Shopify inventory adjustment.",
    discrepancyLines: 0, postedUnits: 0,
  };
}

module.exports = { reconciliationStatus, POS_STORES };
