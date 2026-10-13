const crypto = require('node:crypto');
const { AGENT_LABEL } = require('./reconciliation-status');
const LOCATIONS = Object.freeze({
  Bellmore:'103133315319', 'Deer Park':'66819653879', Islip:'103133413623',
  Farmingdale:'103133479159', Holbrook:'66819490039', Huntington:'103133511927',
  'Island Park':'103133348087', 'Lake Grove':'97226490103', Lindenhurst:'69550473463',
  Lynbrook:'97226588407', 'Miller Place':'105516073207', Ronkonkoma:'66352283895',
  Selden:'66819555575', Woodbury:'97226555639',
});
const PROOF_QUERY = `query CorrectionProof($groupId:ID!,$orderId:ID!){
  node(id:$groupId){... on InventoryAdjustmentGroup{id createdAt referenceDocumentUri
    changes{name delta item{id sku} location{id name}}}}
  order(id:$orderId){id name displayFulfillmentStatus customer{tags}
    lineItems(first:250){nodes{sku quantity variant{inventoryItem{id}}} pageInfo{hasNextPage}}
    fulfillments(first:50){status location{id}}}
}`;

function correctionKey(report, sku, kind='food') {
  return crypto.createHash('sha256').update(JSON.stringify([
    kind==='extra'?'agent-hazar-extra':kind==='zero_case'?'agent-hazar-zero-case':'agent-hazar-food',report.store,report.orderId,sku,
  ])).digest('hex');
}

// This path imports proof only; it cannot adjust stock. A manager cannot
// close a report by supplying a status/quantity. Shopify is read independently.
function verifiedCorrection(report, sku, group, order, kind='food', variant=null) {
  if(!['food','zero_case','extra'].includes(kind) || report?.supersededBy) throw new Error('Current receipt correction kind required');
  const locationId = LOCATIONS[report?.store] && `gid://shopify/Location/${LOCATIONS[report.store]}`;
  const submitted = Date.parse(report?.submittedAt);
  if (!locationId || !Number.isFinite(submitted) || submitted < Date.parse('2026-10-06T04:00:00Z') ||
      !order || order.id !== report.orderId || order.name !== report.orderName ||
      order.displayFulfillmentStatus !== 'FULFILLED' || order.lineItems?.pageInfo?.hasNextPage ||
      !order.fulfillments?.some(f=>f.status==='SUCCESS' && f.location?.id==='gid://shopify/Location/103133642999')) {
    throw new Error('Exact post-cutover fulfilled store order is required');
  }
  const tags = (order.customer?.tags || []).map(t=>t.toLowerCase());
  const storeTags = report.store === 'Islip' ? ['hummus fit islip','hummus fit east islip'] : [`hummus fit ${report.store.toLowerCase()}`];
  const destinations=Object.keys(LOCATIONS).filter(store=>tags.includes(`hummus fit ${store.toLowerCase()}`) || (store==='Islip' && tags.includes('hummus fit east islip')));
  if (destinations.length!==1 || destinations[0]!==report.store || !storeTags.some(t=>tags.includes(t))) throw new Error('Order destination does not match report store');
  if(kind==='extra') return verifiedExtra(report,sku,group,order,variant,locationId,submitted);
  const items = report.items.map((item,index)=>({...item,index})).filter(i=>i.sku===sku);
  const lines = order.lineItems.nodes.filter(i=>i.sku===sku);
  if (items.length!==1 || lines.length!==1) throw new Error('SKU is missing or ambiguous');
  const item=items[0], line=lines[0];
  const delta=item.actuallyReceived-item.orderedQty;
  const category=kind==='zero_case'?'retail_essentials':'food';
  if(kind==='zero_case' && (item.actuallyReceived!==0 || item.expectedFromPicking!==0 ||
    item.posInventoryPostedUnits>0 || !(report.posInventoryResults||[]).some(r=>r.sku===sku&&r.status==='zero_received') ||
    (report.posInventoryResults||[]).some(r=>r.sku===sku&&['posted','already_posted'].includes(r.status)))) throw new Error('Zero-case shortage must have no prior POS conversion');
  if (item.receivingCategory!==category || !Number.isSafeInteger(item.actuallyReceived) ||
      item.actuallyReceived<0 || !Number.isSafeInteger(item.orderedQty) || item.orderedQty<1 ||
      item.orderedQty!==line.quantity || !Number.isSafeInteger(delta) || !delta || delta!==item.orderDiff) {
    throw new Error('Exact saved food discrepancy is required');
  }
  if (!/^gid:\/\/shopify\/InventoryAdjustmentGroup\/\d+$/.test(group?.id || '') ||
      group.referenceDocumentUri!==`gid://agent-hazar-receiving/${kind==='zero_case'?'ZeroCaseShortage':'FoodCorrection'}/${correctionKey(report,sku,kind)}` ||
      !Number.isFinite(Date.parse(group.createdAt)) || Date.parse(group.createdAt)<submitted) {
    throw new Error('Shopify proof does not belong to this order and correction');
  }
  const changes=(group.changes || []).filter(c=>c.name==='available');
  if (changes.length!==1 || changes[0].delta!==delta || changes[0].location?.id!==locationId ||
      changes[0].item?.sku!==sku || changes[0].item?.id!==line.variant?.inventoryItem?.id) {
    throw new Error('Shopify adjustment item, location or signed delta does not match');
  }
  return {status:'posted',shopifyVerified:true,source:AGENT_LABEL,reportId:report.id,
    store:report.store,orderId:report.orderId,discrepancyKey:`item:${item.index}`,
    sku,delta,locationId,inventoryItemId:changes[0].item.id,adjustmentId:group.id,
    postedAt:group.createdAt,referenceDocumentUri:group.referenceDocumentUri};
}

function verifiedExtra(report,sku,group,order,variant,locationId,submitted) {
  const matches=(report.extraItems||[]).map((e,index)=>({...e,index})).filter(e=>e.sku===sku);
  const extra=matches[0];
  if(matches.length!==1 || !sku || !extra.catalogVerified || extra.catalogStatus!=='matched' || extra.source!=='scan' ||
    !Number.isSafeInteger(extra.qty) || extra.qty<1 || extra.variantId!==variant?.id ||
    variant?.sku!==sku || variant?.inventoryItem?.sku!==sku ||
    ![variant?.barcode,variant?.sku].filter(Boolean).includes(extra.code) ||
    (variant?.product?.tags||[]).some(t=>/essentials/i.test(t)) ||
    report.items.some(i=>i.sku===sku) || order.lineItems.nodes.some(i=>i.sku===sku)) {
    throw new Error('One independently verified off-order scanned food item is required');
  }
  const changes=(group?.changes||[]).filter(c=>c.name==='available');
  if(!/^gid:\/\/shopify\/InventoryAdjustmentGroup\/\d+$/.test(group?.id||'') ||
    group.referenceDocumentUri!==`gid://agent-hazar-receiving/ExtraCorrection/${correctionKey(report,sku,'extra')}` ||
    !Number.isFinite(Date.parse(group.createdAt)) || Date.parse(group.createdAt)<submitted ||
    changes.length!==1 || changes[0].delta!==extra.qty || changes[0].location?.id!==locationId ||
    changes[0].item?.id!==variant.inventoryItem.id || changes[0].item?.sku!==sku) {
    throw new Error('Exact Shopify extra-item quantity, catalog item and store proof required');
  }
  return {status:'posted',shopifyVerified:true,catalogVerified:true,source:AGENT_LABEL,
    reportId:report.id,store:report.store,orderId:report.orderId,discrepancyKey:`extra:${extra.index}`,
    sku,delta:extra.qty,locationId,inventoryItemId:variant.inventoryItem.id,variantId:variant.id,
    adjustmentId:group.id,postedAt:group.createdAt,referenceDocumentUri:group.referenceDocumentUri};
}

function mergeVerifiedCorrection(report, correction) {
  const previous=(report.inventoryCorrections || []).find(c=>c.discrepancyKey===correction.discrepancyKey);
  if (previous && previous.adjustmentId!==correction.adjustmentId) throw new Error('A different correction is already recorded');
  if (report.inventoryLocationId && report.inventoryLocationId!==correction.locationId) throw new Error('Report location conflicts with Shopify proof');
  report.inventoryLocationId=correction.locationId;
  report.inventoryCorrections=[...(report.inventoryCorrections || []).filter(c=>c.discrepancyKey!==correction.discrepancyKey),correction];
}

async function readCorrectionProof(groupId, orderId, variantId) {
  const secret=process.env.HF_LOGISTICS_HANDOFF_SECRET;
  if (!secret) throw new Error('Secure verification access is not configured');
  const payload=Buffer.from(JSON.stringify({sub:'hummusfit-receiving',scope:['essentials.receive'],exp:Math.floor(Date.now()/1000)+60})).toString('base64url');
  const token=payload+'.'+crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  const base=process.env.ROUTE_BOARD_URL || 'https://hummusfit-route-board-production.up.railway.app';
  const response=await fetch(`${base}/api/receiving-adjustment-proof`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:JSON.stringify({groupId,orderId,variantId}),signal:AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Shopify verification returned ${response.status}`);
  const result=await response.json();
  if (!result.node || !result.order) throw new Error('Shopify could not verify correction proof');
  return result;
}
module.exports={LOCATIONS,PROOF_QUERY,correctionKey,verifiedCorrection,mergeVerifiedCorrection,readCorrectionProof};
