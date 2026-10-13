const {POS_STORES}=require('./reconciliation-status');
function supersedeEarlierReports(reports,reportId,physicalCounts,manager) {
  const latest=reports.find(r=>r.id===reportId);
  if(!latest || !POS_STORES.has(latest.store) || !latest.orderId || latest.supersededBy ||
    !physicalCounts || Array.isArray(physicalCounts)) throw new Error('Exact latest local-store receipt and confirmed counts required');
  const related=reports.filter(r=>r.store===latest.store&&r.orderId===latest.orderId);
  if(related.some(r=>Date.parse(r.submittedAt)>Date.parse(latest.submittedAt))) throw new Error('A newer receipt exists');
  const changed=new Set();
  for(const prior of related.filter(r=>r.id!==latest.id)) {
    if(prior.extraItems?.length || latest.extraItems?.length || prior.items.length!==latest.items.length) throw new Error('Receipt contents require separate review');
    for(const item of prior.items) {
      const receiptOnly=!item.sku && item.receivingCategory==='other_essentials' && item.title;
      const matches=latest.items.filter(i=>receiptOnly ? !i.sku && i.receivingCategory==='other_essentials' && i.title===item.title : item.sku && i.sku===item.sku);
      if(matches.length!==1||matches[0].orderedQty!==item.orderedQty||matches[0].expectedFromPicking!==item.expectedFromPicking) throw new Error('Order or pick evidence differs');
      if(item.actuallyReceived!==matches[0].actuallyReceived) {
        if(receiptOnly) throw new Error('Changed unscannable supply requires separate review');
        changed.add(item.sku);
        if(physicalCounts[item.sku]!==matches[0].actuallyReceived ||
          !Number.isSafeInteger(physicalCounts[item.sku]) || physicalCounts[item.sku]<0 ||
          (prior.inventoryCorrections||[]).some(c=>c.sku===item.sku)) throw new Error('Changed count needs confirmation or an existing adjustment needs review');
      }
    }
  }
  if(!changed.size||Object.keys(physicalCounts).length!==changed.size) throw new Error('Confirm exactly the changed receipt quantities');
  const timestamp=new Date().toISOString();
  for(const prior of related.filter(r=>r.id!==latest.id)) {
    prior.supersededBy=latest.id;
    prior.supersession={confirmedBy:manager,confirmedAt:timestamp,physicalCounts};
  }
  latest.authoritativeReceipt={confirmedBy:manager,confirmedAt:timestamp,physicalCounts};
  return related.filter(r=>r.id!==latest.id).map(r=>r.id);
}
module.exports={supersedeEarlierReports};
