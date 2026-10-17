const test=require('node:test'),assert=require('node:assert/strict');
const {confirmRetailPackCount:confirm}=require('../retail-pack-confirmation');
const input={sku:'POINTS-DARK-CS',previousCount:12,receivedCases:1,receivedUnits:12,reason:'Tony confirmed 12 individual bags, one case'};
function fixture(){return {id:'Lynbrook::test',store:'Lynbrook',orderId:'gid://shopify/Order/8083872383223',submittedAt:'2026-10-17T17:22:23Z',submissionFingerprint:'original',automation:{status:'requires_review'},items:[{sku:'POINTS-DARK-CS',receivingCategory:'retail_essentials',actuallyReceived:12,orderedQty:1,expectedFromPicking:1,diff:11,orderDiff:11},{sku:'FOOD',receivingCategory:'food',actuallyReceived:4,orderedQty:5,orderDiff:-1}],inventoryCorrections:[]};}
test('confirmed pack misunderstanding preserves original and cannot double amend',()=>{
 const r=fixture(),food=JSON.stringify(r.items[1]);assert.equal(confirm(r,input,'tony'),true);
 assert.equal(r.items[0].actuallyReceived,1);assert.equal(r.items[0].orderDiff,0);
 assert.equal(r.managerCountAmendments[0].originalItem.actuallyReceived,12);
 assert.equal(r.submissionFingerprint,'original');assert.equal(JSON.stringify(r.items[1]),food);
 assert.equal(r.automation.status,'requires_review');assert.equal(confirm(r,input,'tony'),false);
 assert.equal(r.managerCountAmendments.length,1);
});
test('processing, posted, conflicting, foreign and unconfirmed counts stay blocked',()=>{
 for(const change of [r=>r.automation.status='processing',r=>r.automation.status='queued',r=>r.store='B2B',r=>r.items[0].posInventoryWriteEnabled=true,r=>r.posInventoryResults=[{sku:input.sku,status:'pending'}],r=>r.items[0].expectedFromPicking=0]){
  const r=fixture();change(r);const before=JSON.stringify(r);assert.throws(()=>confirm(r,input,'tony'));assert.equal(JSON.stringify(r),before);
 }
 for(const change of [{receivedCases:12},{receivedUnits:144},{previousCount:1},{sku:'FOOD'}])assert.throws(()=>confirm(fixture(),{...input,...change},'tony'));
});
