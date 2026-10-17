const {POS_STORES}=require('./reconciliation-status');
// Pack definitions here authorize count interpretation only, never stock writes.
const PACKS=Object.freeze({'POINTS-DARK-CS':12});
function confirmRetailPackCount(report,{sku,previousCount,receivedCases,receivedUnits,reason},actor,now=new Date().toISOString()) {
  if(!report||report.supersededBy||!POS_STORES.has(report.store)||
      !(Date.parse(report.submittedAt)>=Date.parse('2026-10-06T04:00:00Z'))||
      !/^gid:\/\/shopify\/Order\/\d+$/.test(report.orderId||'')||
      !['requires_review','failed'].includes(report.automation?.status)||
      typeof reason!=='string'||reason.trim().length<10||!actor)throw Error('Idle exact reviewed receipt and manager confirmation required');
  const items=report.items.filter(i=>i.sku===sku),item=items[0],pack=PACKS[sku];
  const prior=(report.managerCountAmendments||[]).find(a=>a.sku===sku);
  if(prior&&prior.receivedCases===receivedCases&&prior.receivedUnits===receivedUnits&&item?.actuallyReceived===receivedCases)return false;
  if(prior||items.length!==1||item.receivingCategory!=='retail_essentials'||!pack||
      !Number.isSafeInteger(receivedCases)||receivedCases<1||
      !Number.isSafeInteger(receivedUnits)||receivedUnits!==receivedCases*pack||
      previousCount!==receivedUnits||item.actuallyReceived!==previousCount||
      receivedCases!==item.orderedQty||receivedCases!==item.expectedFromPicking||
      item.posInventoryWriteEnabled||(report.posInventoryResults||[]).some(e=>e.sku===sku)||
      (report.inventoryCorrections||[]).some(e=>e.sku===sku))throw Error('Unposted exact unit-as-case entry and matching ordered/picked case count required');
  const originalItem=JSON.parse(JSON.stringify(item));
  report.managerCountAmendments||=[];
  report.managerCountAmendments.push({sku,previousCount,receivedCases,receivedUnits,unitsPerCase:pack,originalItem,reason:reason.trim(),confirmedBy:actor,confirmedAt:now});
  item.actuallyReceived=receivedCases;item.diff=receivedCases-item.expectedFromPicking;item.orderDiff=receivedCases-item.orderedQty;
  item.unitsPerCase=pack;item.projectedPosUnits=receivedUnits;
  // Preserve original submission fingerprint, staff identity, flags and food fields.
  // This does not queue a retry or claim an inventory posting.
  return true;
}
module.exports={confirmRetailPackCount};
