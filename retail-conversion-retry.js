const { POS_STORES } = require('./reconciliation-status');

// An unrelated food discrepancy must not strand a verified retail receipt.
// Retail discrepancies and unknown extras still require their own review.
function retryRetailLines(report) {
  if (!report || report.supersededBy || !POS_STORES.has(report.store) || !report.orderId ||
      !Number.isFinite(Date.parse(report.submittedAt)) ||
      Date.parse(report.submittedAt) < Date.parse('2026-10-06T04:00:00Z') ||
      (report.extraItems || []).length) {
    throw new Error('An exact post-cutover Hummus Fit POS report without unresolved extras is required');
  }
  const retail = (report.items || []).filter(item => item.receivingCategory === 'retail_essentials');
  if (!retail.length || new Set(retail.map(item => item.sku)).size !== retail.length ||
      retail.some(item => !item.sku || !Number.isSafeInteger(item.actuallyReceived) ||
        item.actuallyReceived < 0 || item.actuallyReceived !== item.expectedFromPicking ||
        (item.actuallyReceived !== item.orderedQty && item.actuallyReceived !== 0))) {
    throw new Error('Retail cases must exactly match the saved order, pick, and receipt');
  }
  return retail;
}

function confirmedBackorder(report,item,entry) {
  return POS_STORES.has(report.store)&&entry?.sku===item.sku&&entry.status==='backordered'&&entry.shopifyVerified===true&&
    (entry.store===report.store || (!entry.store&&report.store==='Huntington'))&&
    entry.orderId===report.orderId&&/^gid:\/\/shopify\/LineItem\/\d+$/.test(entry.lineItemId||'')&&
    entry.units===0&&entry.orderedCases===item.orderedQty&&item.actuallyReceived===0&&item.expectedFromPicking===0&&
    Number.isFinite(Date.parse(entry.verifiedAt));
}
function confirmedPosting(item, entry) {
  return entry?.sku === item.sku && ((item.actuallyReceived === 0 && entry.status === 'zero_received' && entry.units === 0) ||
    (item.actuallyReceived > 0 && ['posted', 'already_posted'].includes(entry.status) &&
      /^gid:\/\/shopify\/InventoryAdjustmentGroup\/[0-9]+$/.test(entry.adjustmentId || '') &&
      Number.isSafeInteger(entry.units) && entry.units > 0));
}

function mergeRetailPostings(report, retail, result) {
  const incoming = Array.isArray(result.results) ? result.results : [];
  const prior = Array.isArray(report.posInventoryResults) ? report.posInventoryResults : [];
  const postings = retail.map(item => {
    const candidates = incoming.filter(entry => entry.sku === item.sku);
    const oldProof = prior.find(entry => confirmedPosting(item, entry));
    const current = candidates.length === 1 ? candidates[0] : null;
    // A transient failure must never erase an already recorded Shopify proof.
    if (oldProof) return oldProof;
    if (confirmedBackorder(report,item,current)) return current;
    const oldBackorder=prior.find(entry=>confirmedBackorder(report,item,entry));
    if(oldBackorder) return oldBackorder;
    if (confirmedPosting(item, current)) return current;
    if (current && !['posted', 'already_posted', 'zero_received'].includes(current.status)) return current;
    return { sku: item.sku, status: 'requires_review', error: result.error || 'Shopify posting proof was not confirmed' };
  });
  report.posInventoryResults = postings;
  report.posInventoryWritesEnabled = retail.every(item => postings.some(entry => confirmedPosting(item, entry)||confirmedBackorder(report,item,entry)));
  report.posInventoryRetriedAt = new Date().toISOString();
  for (const item of report.items) {
    if (item.receivingCategory !== 'retail_essentials') continue;
    const proof = postings.find(entry => confirmedPosting(item, entry));
    if (proof && item.actuallyReceived > 0) {
      item.posInventoryWriteEnabled = true;
      item.posInventoryPostedUnits = proof.units;
    }
  }
  // hasErrors, received counts, extras and food corrections stay untouched.
  return report.posInventoryWritesEnabled;
}

module.exports = { retryRetailLines, confirmedPosting, confirmedBackorder, mergeRetailPostings };
