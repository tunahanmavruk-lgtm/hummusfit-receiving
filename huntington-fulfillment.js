// Scoped fulfillment evidence. This does not change food deltas or picking.
const WAREHOUSE = 'gid://shopify/Location/103133642999';
const LOCATION = 'gid://shopify/Location/103133511927';
const CUTOVER = Date.parse('2026-10-16T21:40:00Z');
const {orderPolicy}=require('./store-fulfillment-policy');
function deliveredQuantities(order) {
  const policy=orderPolicy(order);
  if (!['PARTIALLY_FULFILLED', 'FULFILLED'].includes(order?.displayFulfillmentStatus) ||
      order.cancelledAt || !Array.isArray(order.lineItems?.nodes) || order.lineItems.pageInfo?.hasNextPage ||
      !order.fulfillments?.length || order.fulfillments.length >= 100) throw new Error('Exact store warehouse fulfillment required');
  const totals = new Map(), seen = new Set();
  const lines = new Map(order.lineItems.nodes.map(l => [l.id, l]));
  if (lines.size !== order.lineItems.nodes.length) throw new Error('Duplicate order line identity');
  for (const f of order.fulfillments) {
    if (f.status !== 'SUCCESS' || f.location?.id !== WAREHOUSE ||
        !(Date.parse(f.createdAt) >= policy.cutover) || !/^gid:\/\/shopify\/Fulfillment\/\d+$/.test(f.id || '') ||
        seen.has(f.id) || !Array.isArray(f.fulfillmentLineItems?.nodes) ||
        f.fulfillmentLineItems.pageInfo?.hasNextPage) throw new Error('Complete post-cutover Shipping Warehouse fulfillment lines required');
    seen.add(f.id);
    const perFulfillment = new Set();
    for (const entry of f.fulfillmentLineItems.nodes) {
      const id = entry.lineItem?.id, line = lines.get(id);
      if (!line || perFulfillment.has(id) || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 ||
          !Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new Error('Invalid or duplicate fulfilled order line');
      perFulfillment.add(id);
      totals.set(id, (totals.get(id) || 0) + entry.quantity);
      if (totals.get(id) > line.quantity) throw new Error('Fulfillments exceed ordered quantity');
    }
  }
  return totals;
}
function fullyDelivered(order, sku) {
  const lines = order.lineItems?.nodes?.filter(l => l.sku === sku) || [];
  const totals = deliveredQuantities(order);
  return lines.length === 1 && totals.get(lines[0].id) === lines[0].quantity;
}
function partialReceiptAllowed(report, order) {
  if (order.displayFulfillmentStatus !== 'PARTIALLY_FULFILLED' || orderPolicy(order).store!==report.store) return false;
  const totals = deliveredQuantities(order);
  return (report.items || []).every(item => {
    const lines = order.lineItems.nodes.filter(l => l.sku && l.sku === item.sku);
    if (lines.length !== 1 || lines[0].quantity !== item.orderedQty) return item.receivingCategory === 'other_essentials';
    const qty = totals.get(lines[0].id) || 0;
    // A split retail line must not block an independently fulfilled food line.
    // This grants no retail conversion permission: split-case conversions keep
    // their existing review gate and cannot reuse the original order/SKU key.
    const confirmedSplitRetail=item.receivingCategory==='retail_essentials'&&
      qty>0&&qty<lines[0].quantity&&item.expectedFromPicking===qty&&item.actuallyReceived===qty;
    return qty === lines[0].quantity || confirmedSplitRetail ||
      (qty === 0 && item.actuallyReceived === 0 && item.expectedFromPicking === 0);
  });
}
module.exports = { WAREHOUSE, LOCATION, CUTOVER, deliveredQuantities, fullyDelivered, partialReceiptAllowed };
