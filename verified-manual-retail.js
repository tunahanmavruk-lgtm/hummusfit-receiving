const { AGENT_LABEL } = require('./reconciliation-status');

// These two historical order lines were credited to draft case items, then
// moved to the active cases at Farmingdale. The owner confirmed that the
// moved cases are the two eight-tin cases on Sara's saved receipt.
const REPORT_ID = 'Farmingdale::1793991667864:931a461e-730d-4674-8431-5b74feff0d6b';
const ORDER_ID = 'gid://shopify/Order/8145520361719';
const LOCATION_ID = 'gid://shopify/Location/103133479159';
const CASES = Object.freeze({
  'SD-RASPBERRY-60G-CS8': Object.freeze({
    legacyItemId: 'gid://shopify/InventoryItem/54058872439031',
    activeItemId: 'gid://shopify/InventoryItem/54153102819575',
    unitItemId: 'gid://shopify/InventoryItem/54153102885111',
    unitSku: '860014183447',
    groupId: 'gid://shopify/InventoryAdjustmentGroup/68839347814647',
    reference: 'gid://agent-hazar-receiving/ManualRetailConversion/Farmingdale-805371-Raspberry-v1',
  }),
  'SD-GREENAPPLE-60G-CS8': Object.freeze({
    legacyItemId: 'gid://shopify/InventoryItem/54058880073975',
    activeItemId: 'gid://shopify/InventoryItem/54153102852343',
    unitItemId: 'gid://shopify/InventoryItem/54153102917879',
    unitSku: '860014183423',
    groupId: 'gid://shopify/InventoryAdjustmentGroup/68839347847415',
    reference: 'gid://agent-hazar-receiving/ManualRetailConversion/Farmingdale-805371-GreenApple-v1',
  }),
});

function verifiedManualRetail(report, sku, group, order) {
  const config = CASES[sku];
  if (!config || report?.id !== REPORT_ID || report.store !== 'Farmingdale' ||
      report.orderId !== ORDER_ID || report.orderName !== '#805371' || report.supersededBy ||
      (report.extraItems || []).length || !Number.isFinite(Date.parse(report.submittedAt)) ||
      order?.id !== ORDER_ID || order.name !== report.orderName || order.displayFulfillmentStatus !== 'FULFILLED' ||
      order.lineItems?.pageInfo?.hasNextPage ||
      !order.fulfillments?.some(f => f.status === 'SUCCESS' && f.location?.id === 'gid://shopify/Location/103133642999')) {
    throw new Error('Exact saved Farmingdale receipt and Shipping Warehouse order required');
  }
  const destinations = (order.customer?.tags || []).filter(t => /^hummus fit (farmingdale|bellmore|deer park|islip|east islip|holbrook|huntington|island park|lake grove|lindenhurst|lynbrook|miller place|ronkonkoma|selden|woodbury)$/i.test(t));
  if (destinations.length !== 1 || destinations[0].toLowerCase() !== 'hummus fit farmingdale') {
    throw new Error('Order destination is not uniquely Farmingdale');
  }
  const items = (report.items || []).filter(i => i.sku === sku && i.receivingCategory === 'retail_essentials');
  const lines = (order.lineItems?.nodes || []).filter(i => i.sku === sku);
  if (items.length !== 1 || lines.length !== 1 || items[0].orderedQty !== 1 ||
      items[0].expectedFromPicking !== 1 || items[0].actuallyReceived !== 1 ||
      lines[0].quantity !== 1 || lines[0].variant?.inventoryItem?.id !== config.legacyItemId) {
    throw new Error('Saved picked case differs from the exact legacy Shopify order line');
  }
  if (group?.id !== config.groupId || group.referenceDocumentUri !== config.reference ||
      !Number.isFinite(Date.parse(group.createdAt)) || Date.parse(group.createdAt) < Date.parse(report.submittedAt)) {
    throw new Error('Shopify adjustment does not belong to this saved receipt');
  }
  const expected = new Set(['available', 'on_hand']);
  for (const name of expected) {
    const changes = (group.changes || []).filter(c => c.name === name);
    if (changes.length !== 2 ||
        !changes.some(c => c.delta === -1 && c.item?.id === config.activeItemId && c.location?.id === LOCATION_ID) ||
        !changes.some(c => c.delta === 8 && c.item?.id === config.unitItemId && c.item?.sku === config.unitSku && c.location?.id === LOCATION_ID)) {
      throw new Error('Shopify case and sell-unit quantities do not match the exact store conversion');
    }
  }
  if (group.changes.length !== 4) throw new Error('Shopify adjustment contains unrelated changes');
  return {sku, status:'posted', units:8, adjustmentId:group.id, shopifyVerified:true,
    source:AGENT_LABEL, store:report.store, orderId:report.orderId, locationId:LOCATION_ID,
    caseInventoryItemId:config.activeItemId, unitInventoryItemId:config.unitItemId,
    referenceDocumentUri:config.reference, postedAt:group.createdAt};
}

function mergeManualRetail(report, posting) {
  if (report.id !== REPORT_ID || !CASES[posting.sku] || report.supersededBy) throw new Error('Exact saved receipt required');
  if (report.inventoryLocationId && report.inventoryLocationId !== LOCATION_ID) throw new Error('Report POS location differs from Shopify proof');
  const previous = (report.posInventoryResults || []).find(r => r.sku === posting.sku);
  if (previous?.adjustmentId && previous.adjustmentId !== posting.adjustmentId) throw new Error('A different Shopify posting is already recorded');
  const item = report.items.find(i => i.sku === posting.sku && i.receivingCategory === 'retail_essentials');
  if (!item) throw new Error('Saved retail line is missing');
  report.inventoryLocationId = LOCATION_ID;
  report.posInventoryResults = [...(report.posInventoryResults || []).filter(r => r.sku !== posting.sku), posting];
  item.unitsPerCase = 8;
  item.posInventoryWriteEnabled = true;
  item.posInventoryPostedUnits = 8;
  report.posInventoryWritesEnabled = report.items.filter(i => i.receivingCategory === 'retail_essentials')
    .every(i => (report.posInventoryResults || []).some(r => r.sku === i.sku && r.status === 'posted' && r.adjustmentId));
  report.posInventoryRetriedAt = new Date().toISOString();
}

module.exports = {CASES, verifiedManualRetail, mergeManualRetail};
