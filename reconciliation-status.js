// Reporting only. This module never changes Shopify inventory. A case-to-unit
// conversion is not proof that a shortage, overage, or wrong item was fixed.
const POS_STORES = new Set([
  "Bellmore", "Deer Park", "Islip", "Farmingdale", "Holbrook", "Huntington",
  "Island Park", "Lake Grove", "Lindenhurst", "Lynbrook", "Miller Place",
  "Ronkonkoma", "Selden", "Woodbury",
]);
const AGENT_LABEL = "Agent Hazar – Receiving";

function discrepancyEntries(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  const extras = Array.isArray(report.extraItems) ? report.extraItems : [];
  return [
    ...items.flatMap((item, index) => Number(item.diff) !== 0 ||
      (POS_STORES.has(report.store) && item.orderDiff !== null && item.orderDiff !== undefined && Number(item.orderDiff) !== 0)
      ? [{ key: `item:${index}`, title: item.title || item.sku || "Item", sku: item.sku || "", diff: Number(item.diff), orderDiff: item.orderDiff, kind: "ordered_item", category: item.receivingCategory }]
      : []),
    ...extras.flatMap((item, index) => Number(item.qty) > 0
      ? [{ key: `extra:${index}`, title: item.catalogVerified === true && item.catalogStatus === 'matched' ? (item.title || item.code) : (item.code || "Unidentified item"), sku: item.catalogVerified === true && item.catalogStatus === 'matched' ? (item.sku || "") : "", diff: Number(item.qty), kind: "extra_item" }]
      : []),
  ];
}

function confirmedCorrection(report, discrepancy, correction) {
  if (!POS_STORES.has(report.store) || !report.inventoryLocationId || !report.orderId) return false;
  if (!correction || correction.status !== "posted" || correction.shopifyVerified !== true ||
      correction.source !== AGENT_LABEL || correction.reportId !== report.id ||
      correction.orderId !== report.orderId || correction.store !== report.store ||
      correction.discrepancyKey !== discrepancy.key || correction.locationId !== report.inventoryLocationId ||
      !/^gid:\/\/shopify\/InventoryAdjustmentGroup\/[0-9]+$/.test(correction.adjustmentId || "") ||
      !/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/.test(correction.inventoryItemId || "") ||
      !String(correction.sku || "").trim() || !Number.isSafeInteger(correction.delta) || correction.delta === 0) return false;
  // An off-order barcode must first be mapped to a verified Shopify SKU.
  if (discrepancy.kind === "extra_item" &&
      (correction.catalogVerified !== true || correction.delta !== discrepancy.diff ||
       (discrepancy.sku && correction.sku !== discrepancy.sku))) return false;
  if (discrepancy.kind === "ordered_item" &&
      (discrepancy.category === "other_essentials" || correction.sku !== discrepancy.sku ||
       !Number.isSafeInteger(Number(discrepancy.orderDiff)) ||
       correction.delta !== Number(discrepancy.orderDiff))) return false;
  const submitted = Date.parse(report.submittedAt || "");
  const posted = Date.parse(correction.postedAt || "");
  // Shopify adjustment timestamps have second precision; receipt timestamps
  // retain milliseconds. Exact order/item/location/delta checks above still apply.
  return Number.isFinite(submitted) && Number.isFinite(posted) && posted >= Math.floor(submitted / 1000) * 1000;
}

function reconciliationStatus(report) {
  if(report.supersededBy && report.supersession?.confirmedAt) return {
    status:'superseded',label:'Superseded by confirmed latest receipt',
    detail:`Use report ${report.supersededBy}. Original counts are retained for audit; no inventory was changed by superseding this report.`,
    discrepancyLines:0,correctedCount:0,pendingCount:0,correctionLines:[],postedUnits:0,
  };
  const items = Array.isArray(report.items) ? report.items : [];
  const results = Array.isArray(report.posInventoryResults) ? report.posInventoryResults : [];
  const discrepancies = discrepancyEntries(report);
  const corrections = Array.isArray(report.inventoryCorrections) ? report.inventoryCorrections : [];
  const correctionLines = discrepancies.map((entry) => {
    const correction = corrections.find((candidate) => confirmedCorrection(report, entry, candidate));
    return { ...entry, status: entry.category === 'other_essentials' ? 'receipt_only' : correction ? "corrected" : "pending",
      adjustmentId: correction?.adjustmentId || null,
      postedAt: correction?.postedAt || null,
      locationId: correction?.locationId || null,
      delta: correction?.delta || null };
  });
  const correctedCount = correctionLines.filter((entry) => entry.status === "corrected").length;
  const pendingCount = correctionLines.filter((entry) => entry.status === 'pending').length;
  const receiptExceptionCount = correctionLines.filter((entry) => entry.status === 'receipt_only').length;
  const retail = items.filter((item) => item.receivingCategory === "retail_essentials");
  const postedResults = results.filter((result) => ["posted", "already_posted"].includes(result.status));
  const postedUnits = postedResults.reduce((sum, result) => sum + (Number(result.units) || 0), 0);
  const posResultsBySku = new Map(results.filter((result) => result.sku).map((result) => [result.sku, result]));
  const conversionPending = POS_STORES.has(report.store) && retail.some((item) => {
    const result = posResultsBySku.get(item.sku || item.title);
    if (Number(item.actuallyReceived) === 0 && Number(item.expectedFromPicking) === 0) return false;
    if (Number(item.actuallyReceived) === 0 && result?.status === "zero_received") return false;
    return !result || !["posted", "already_posted"].includes(result.status);
  });

  if (discrepancies.length > 0) {
    const status = pendingCount === 0 && !conversionPending ? (receiptExceptionCount ? 'receipt_exception' : "corrected") :
      correctedCount > 0 ? "partially_corrected" : "needs_review";
    return { status,
      label: status === 'receipt_exception' ? 'Supply exception — logistics follow-up' : status === "corrected" ? `Solved by ${AGENT_LABEL}` :
        status === "partially_corrected" ? `Partially corrected by ${AGENT_LABEL}` : "Inventory correction not confirmed",
      detail: (pendingCount === 0 ? (correctedCount ? "Every inventory discrepancy has a confirmed Shopify adjustment at this store." : "No POS inventory adjustment is required for these receipt-only supplies.") :
        `${pendingCount} discrepant line${pendingCount === 1 ? "" : "s"} still need${pendingCount === 1 ? "s" : ""} a confirmed Shopify adjustment. ` +
        (['queued','processing','retry'].includes(report.automation?.status) ? 'Agent Hazar is processing or safely retrying this saved receipt.' :
          (report.automation?.error || report.automation?.results?.filter(r=>r.status!=='posted').map(r=>r.error).filter(Boolean).join('; ') || 'Logistics review is required; no unverified inventory change is marked solved.'))) +
        (conversionPending ? " Retail Essentials POS case conversion is also not confirmed." : "") +
        (receiptExceptionCount ? ` ${receiptExceptionCount} Other Essentials supply exception(s) remain recorded for logistics follow-up; no POS stock change applies.` : ''),
      discrepancyLines: discrepancies.length, correctedCount, pendingCount, receiptExceptionCount, correctionLines, postedUnits,
      correctedAt: status === "corrected" ? correctionLines.reduce((latest, entry) =>
        !latest || entry.postedAt > latest ? entry.postedAt : latest, null) : null,
    };
  }
  if (conversionPending) return {
    status: "needs_review", label: "POS posting needs review",
    detail: "The receipt was saved, but at least one Retail Essentials sell-unit posting is not confirmed.",
    discrepancyLines: 0, correctedCount: 0, pendingCount: 0, correctionLines: [], postedUnits,
  };
  if (postedResults.length > 0) return {
    status: "conversion_posted", label: "POS case conversion posted",
    detail: "The verified Retail Essentials cases were converted to sell-units. No receiving discrepancy was reported.",
    discrepancyLines: 0, correctedCount: 0, pendingCount: 0, correctionLines: [], postedUnits,
  };
  return {
    status: "receipt_verified", label: "Receipt verified",
    detail: "No discrepancy was reported. This does not represent a Shopify inventory adjustment.",
    discrepancyLines: 0, correctedCount: 0, pendingCount: 0, correctionLines: [], postedUnits: 0,
  };
}

module.exports = { reconciliationStatus, discrepancyEntries, confirmedCorrection, POS_STORES, AGENT_LABEL };
