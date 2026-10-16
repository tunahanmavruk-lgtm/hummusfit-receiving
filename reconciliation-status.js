// Reporting only. This module never changes Shopify inventory. A case-to-unit
// conversion is not proof that a shortage, overage, or wrong item was fixed.
const POS_STORES = new Set([
  "Bellmore", "Deer Park", "Islip", "Farmingdale", "Holbrook", "Huntington",
  "Island Park", "Lake Grove", "Lindenhurst", "Lynbrook", "Miller Place",
  "Ronkonkoma", "Selden", "Woodbury",
]);
const AGENT_LABEL = "Agent Hazar – Receiving";

// Manager-audited Shopify Admin history is distinct from an automated posting.
// These records can only be attached by an operator, never by store submission.
function existingManualCorrection(report, key) {
  if (!POS_STORES.has(report.store) || !/^extra:\d+$/.test(key)) return null;
  const records = (report.verifiedManualCorrections || []).filter(c => c.discrepancyKey === key);
  if (records.length !== 1) return null;
  const c = records[0], item = report.extraItems?.[Number(key.split(':')[1])];
  const expectedLocations = require('./verified-correction').LOCATIONS;
  if (!item || c.status !== 'verified_existing_manual' || c.inventoryChanged !== false ||
      c.source !== AGENT_LABEL || c.reportId !== report.id || c.orderId !== report.orderId ||
      c.store !== report.store || c.originalCode !== item.code || c.originalQty !== item.qty ||
      c.locationId !== `gid://shopify/Location/${expectedLocations[report.store]}` ||
      !Number.isSafeInteger(c.confirmedReceivedQty) || c.confirmedReceivedQty < 1 ||
      c.delta !== c.confirmedReceivedQty || !c.sku || !c.title ||
      c.catalogVerified !== true || !/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(c.inventoryItemId || '') ||
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(c.variantId || '') ||
      report.items.some(i => i.sku === c.sku) || c.offOrderVerified !== true ||
      c.ownerConfirmation?.confirmsExistingCorrection !== true || !c.ownerConfirmation?.text ||
      !Number.isFinite(Date.parse(c.ownerConfirmation?.confirmedAt)) ||
      c.evidence?.type !== 'shopify_admin_inventory_history' ||
      c.evidence.locationId !== c.locationId || c.evidence.inventoryItemId !== c.inventoryItemId ||
      c.evidence.availableDelta !== c.delta || c.evidence.onHandDelta !== c.delta ||
      !c.evidence.createdBy || !Number.isFinite(Date.parse(c.evidence.observedAt)) ||
      !Number.isFinite(Date.parse(c.evidence.postedAtMinute)) ||
      Date.parse(c.evidence.postedAtMinute) < Date.parse(report.submittedAt) ||
      c.evidence.url !== `https://admin.shopify.com/store/myhummusfit/products/inventory/${c.inventoryItemId.split('/').pop()}/inventory_history`) return null;
  return c;
}

function discrepancyEntries(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  const extras = Array.isArray(report.extraItems) ? report.extraItems : [];
  return [
    ...items.flatMap((item, index) => Number(item.diff) !== 0 ||
      (POS_STORES.has(report.store) && item.orderDiff !== null && item.orderDiff !== undefined && Number(item.orderDiff) !== 0)
      ? [{ key: `item:${index}`, title: item.title || item.sku || "Item", sku: item.sku || "", diff: Number(item.diff), orderDiff: item.orderDiff, kind: "ordered_item", category: item.receivingCategory }]
      : []),
    ...extras.flatMap((item, index) => {
      const manual = existingManualCorrection(report, `extra:${index}`);
      return Number(item.qty) > 0
        ? [{ key: `extra:${index}`, title: manual?.title || (item.catalogVerified === true && item.catalogStatus === 'matched' ? (item.title || item.code) : (item.code || "Unidentified item")), sku: manual?.sku || (item.catalogVerified === true && item.catalogStatus === 'matched' ? (item.sku || "") : ""), diff: manual?.confirmedReceivedQty || Number(item.qty), kind: "extra_item" }]
        : [];
    }),
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
       (correction.delta !== Number(discrepancy.orderDiff) &&
        !confirmedUnitShortage(report, discrepancy, correction)))) return false;
  const submitted = Date.parse(report.submittedAt || "");
  const posted = Date.parse(correction.postedAt || "");
  // Shopify adjustment timestamps have second precision; receipt timestamps
  // retain milliseconds. Exact order/item/location/delta checks above still apply.
  return Number.isFinite(submitted) && Number.isFinite(posted) && posted >= Math.floor(submitted / 1000) * 1000;
}

// Legacy case shortages were reversed on the sell-unit inventory item after
// conversion. Recognize that proof in its original units; never replay stock.
function confirmedUnitShortage(report, discrepancy, correction) {
  if (discrepancy.category !== 'retail_essentials' || discrepancy.orderDiff >= 0 ||
      !/^gid:\/\/agent-hazar-receiving\/Report\/[a-f0-9]{64}$/.test(correction.referenceDocumentUri || '') ||
      !correction.posSku || correction.posSku === correction.sku) return false;
  const item = report.items.find((i, index) => `item:${index}` === discrepancy.key);
  const units = item?.unitsPerCase;
  const posting = (report.posInventoryResults || []).find(r => r.sku === discrepancy.sku);
  return Number.isSafeInteger(units) && units > 0 &&
    Number.isSafeInteger(item.orderedQty) && item.orderedQty > 0 &&
    item.expectedFromPicking === item.orderedQty &&
    correction.pickedCases === item.expectedFromPicking &&
    correction.receivedCases === item.actuallyReceived &&
    item.actuallyReceived - item.orderedQty === discrepancy.orderDiff &&
    item.posInventoryPostedUnits === item.expectedFromPicking * units &&
    ['posted', 'already_posted'].includes(posting?.status) &&
    /^gid:\/\/shopify\/InventoryAdjustmentGroup\/\d+$/.test(posting.adjustmentId || '') &&
    posting.units === item.posInventoryPostedUnits &&
    correction.delta === discrepancy.orderDiff * units;
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
    const item=entry.key.startsWith('item:')?items[Number(entry.key.split(':')[1])]:null;
    const backordered=item&&(report.posInventoryResults||[]).some(r=>require('./retail-conversion-retry').confirmedBackorder(report,item,r));
    const correction = corrections.find((candidate) => confirmedCorrection(report, entry, candidate));
    const manual = existingManualCorrection(report, entry.key);
    return { ...entry, status: backordered?'backordered':entry.category === 'other_essentials' ? 'receipt_only' : correction || manual ? "corrected" : "pending",
      adjustmentId: correction?.adjustmentId || null,
      postedAt: correction?.postedAt || manual?.evidence?.postedAtMinute || null,
      locationId: correction?.locationId || manual?.locationId || null,
      delta: correction?.delta || manual?.delta || null,
      ...(manual ? {resolution:'verified_existing_manual',evidenceUrl:manual.evidence.url,createdBy:manual.evidence.createdBy,inventoryChanged:false} : {}) };
  });
  const correctedCount = correctionLines.filter((entry) => entry.status === "corrected").length;
  const pendingCount = correctionLines.filter((entry) => entry.status === 'pending').length;
  const receiptExceptionCount = correctionLines.filter((entry) => entry.status === 'receipt_only').length;
  const backorderCount=correctionLines.filter(entry=>entry.status==='backordered').length;
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
    const status = pendingCount === 0 && !conversionPending ? (backorderCount?'received_with_backorder':receiptExceptionCount ? 'receipt_exception' : "corrected") :
      correctedCount > 0 ? "partially_corrected" : "needs_review";
    return { status,
      label: status==='received_with_backorder'?'Received items complete — backorder remains':status === 'receipt_exception' ? 'Supply exception — logistics follow-up' : status === "corrected" ? `Solved by ${AGENT_LABEL}` :
        status === "partially_corrected" ? `Partially corrected by ${AGENT_LABEL}` : "Inventory correction not confirmed",
      detail: (backorderCount?`${backorderCount} unshipped line(s) remain on backorder; no inventory credit or shortage reversal was made for them. `:'')+(pendingCount === 0 ? (correctedCount ? "Every delivered-item inventory discrepancy has a confirmed Shopify adjustment at this store." + (correctionLines.some(c=>c.resolution==='verified_existing_manual') ? " Existing manual correction verified by Agent Hazar; no inventory was posted again." : '') : "No further POS inventory correction is required for this receipt.") :
        `${pendingCount} discrepant line${pendingCount === 1 ? "" : "s"} still need${pendingCount === 1 ? "s" : ""} a confirmed Shopify adjustment. ` +
        (['queued','processing','retry'].includes(report.automation?.status) ? 'Agent Hazar is processing or safely retrying this saved receipt.' :
          (report.automation?.error || report.automation?.results?.filter(r=>r.status!=='posted').map(r=>r.error).filter(Boolean).join('; ') || 'Logistics review is required; no unverified inventory change is marked solved.'))) +
        (conversionPending ? " Retail Essentials POS case conversion is also not confirmed." : "") +
        (receiptExceptionCount ? ` ${receiptExceptionCount} Other Essentials supply exception(s) remain recorded for logistics follow-up; no POS stock change applies.` : ''),
      discrepancyLines: discrepancies.length, correctedCount, pendingCount, receiptExceptionCount, backorderCount, correctionLines, postedUnits,
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
