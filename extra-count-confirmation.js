const crypto=require('node:crypto');
const {verifiedCorrection}=require('./verified-correction');
function confirmationKey(report,sku,from,to){return crypto.createHash('sha256').update(JSON.stringify(['agent-hazar-extra-confirmation',report.store,report.orderId,sku,from,to])).digest('hex');}
// Preserve the original scanned report and both independently verified Shopify
// movements when the manager corrects a previously submitted extra quantity.
function confirmExtraCount(report,sku,quantity,originalProof,deltaProof,manager){
  if(!Number.isSafeInteger(quantity)||quantity<1)throw new Error('Positive confirmed extra quantity required');
  const matches=(report.extraItems||[]).map((e,index)=>({...e,index})).filter(e=>e.sku===sku);
  if(matches.length!==1)throw new Error('One exact extra required');
  const extra=matches[0];
  if(extra.countConfirmation)throw new Error('Extra already confirmed; review its existing audit history');
  const original=verifiedCorrection(report,sku,originalProof.node,originalProof.order,'extra',originalProof.variant);
  const recorded=(report.inventoryCorrections||[]).find(c=>c.discrepancyKey===original.discrepancyKey);
  if(recorded?.adjustmentId!==original.adjustmentId || recorded.delta!==extra.qty || quantity===extra.qty)throw new Error('Original posted correction required');
  const group=deltaProof.node,changes=(group?.changes||[]).filter(c=>c.name==='available');
  if(deltaProof.order?.id!==report.orderId || !/^gid:\/\/shopify\/InventoryAdjustmentGroup\/\d+$/.test(group?.id||'') ||
    group.referenceDocumentUri!==`gid://agent-hazar-receiving/ExtraCountConfirmation/${confirmationKey(report,sku,extra.qty,quantity)}` ||
    !Number.isFinite(Date.parse(group.createdAt)) || Date.parse(group.createdAt)<Date.parse(original.postedAt) ||
    changes.length!==1 || changes[0].delta!==quantity-extra.qty || changes[0].location?.id!==original.locationId ||
    changes[0].item?.id!==original.inventoryItemId || changes[0].item?.sku!==sku)throw new Error('Exact confirmation delta proof required');
  report.extraItems[extra.index]={...report.extraItems[extra.index],qty:quantity,countConfirmation:{
    originalSubmittedQuantity:extra.qty,confirmedQuantity:quantity,confirmedBy:manager,
    confirmedAt:new Date().toISOString(),originalAdjustmentId:original.adjustmentId,
    adjustmentId:group.id,delta:quantity-extra.qty,postedAt:group.createdAt}};
  Object.assign(recorded,{delta:quantity,postedAt:group.createdAt,originalPostedDelta:original.delta,
    adjustmentIds:[original.adjustmentId,group.id],confirmationDelta:quantity-extra.qty});
  return report.extraItems[extra.index].countConfirmation;
}
module.exports={confirmationKey,confirmExtraCount};
