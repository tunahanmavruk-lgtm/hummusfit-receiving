const test=require('node:test');
const assert=require('node:assert/strict');
const {correctionKey,verifiedCorrection,mergeVerifiedCorrection}=require('../verified-correction');
const {reconciliationStatus}=require('../reconciliation-status');
function fixture(){
  const report={id:'Miller Place::123',store:'Miller Place',orderId:'gid://shopify/Order/123',orderName:'#123',
    submittedAt:'2026-10-12T13:00:00Z',items:[{sku:'FOOD',receivingCategory:'food',orderedQty:15,actuallyReceived:14,diff:-1,orderDiff:-1}],inventoryCorrections:[]};
  const order={id:report.orderId,name:report.orderName,displayFulfillmentStatus:'FULFILLED',customer:{tags:['HUMMUS FIT STORE','Hummus Fit Miller Place']},
    fulfillments:[{status:'SUCCESS',location:{id:'gid://shopify/Location/103133642999'}}],
    lineItems:{nodes:[{sku:'FOOD',quantity:15,variant:{inventoryItem:{id:'gid://shopify/InventoryItem/111'}}}],pageInfo:{hasNextPage:false}}};
  const group={id:'gid://shopify/InventoryAdjustmentGroup/111',createdAt:'2026-10-12T14:00:00Z',
    referenceDocumentUri:`gid://agent-hazar-receiving/FoodCorrection/${correctionKey(report,'FOOD')}`,
    changes:[{name:'available',delta:-1,item:{id:'gid://shopify/InventoryItem/111',sku:'FOOD'},location:{id:'gid://shopify/Location/105516073207'}}]};
  return {report,order,group};
}
test('exact Shopify proof closes the discrepancy without writing inventory',()=>{
  const {report,order,group}=fixture();
  const correction=verifiedCorrection(report,'FOOD',group,order);
  mergeVerifiedCorrection(report,correction);mergeVerifiedCorrection(report,correction);
  assert.equal(report.inventoryCorrections.length,1);
  assert.equal(reconciliationStatus(report).status,'corrected');
});
const invalid={
  'superseded report':f=>f.report.supersededBy='newer',
  'ambiguous store tags':f=>f.order.customer.tags.push('Hummus Fit Holbrook'),
  'wrong location':f=>f.group.changes[0].location.id='gid://shopify/Location/1',
  'wrong delta':f=>f.group.changes[0].delta=-2,
  'wrong inventory item':f=>f.group.changes[0].item.id='gid://shopify/InventoryItem/9',
  'wrong SKU':f=>f.group.changes[0].item.sku='OTHER',
  'wrong order reference':f=>f.group.referenceDocumentUri='gid://agent-hazar-receiving/FoodCorrection/other',
  'pre-receipt adjustment':f=>f.group.createdAt='2026-10-11T13:00:00Z',
  'unfulfilled order':f=>f.order.displayFulfillmentStatus='UNFULFILLED',
  'warehouse mismatch':f=>f.order.fulfillments[0].location.id='gid://shopify/Location/1',
  'store mismatch':f=>f.order.customer.tags=['HUMMUS FIT STORE','Hummus Fit Holbrook'],
  'partial lines':f=>f.order.lineItems.pageInfo.hasNextPage=true,
  'duplicate sku':f=>f.order.lineItems.nodes.push(f.order.lineItems.nodes[0]),
  'retail disguised as food':f=>f.report.items[0].receivingCategory='retail_essentials',
  'quantity mismatch':f=>f.report.items[0].orderedQty=16,
  'wrong report order':f=>f.report.orderName='#456',
  'out of scope store':f=>f.report.store='B2B',
  'pre-cutover report':f=>f.report.submittedAt='2026-10-05T13:00:00Z',
  'extra adjustment line':f=>f.group.changes.push({...f.group.changes[0]}),
};
function zeroFixture(){const f=fixture();Object.assign(f.report.items[0],{receivingCategory:'retail_essentials',actuallyReceived:0,expectedFromPicking:0,orderDiff:-15,diff:0});f.report.posInventoryResults=[{sku:'FOOD',status:'zero_received',units:0}];f.group.referenceDocumentUri=`gid://agent-hazar-receiving/ZeroCaseShortage/${correctionKey(f.report,'FOOD','zero_case')}`;f.group.changes[0].delta=-15;return f;}
test('zero missing cases accept only exact case removal proof, not a sell-unit deduction',()=>{const f=zeroFixture();const c=verifiedCorrection(f.report,'FOOD',f.group,f.order,'zero_case');assert.equal(c.delta,-15);mergeVerifiedCorrection(f.report,c);assert.equal(reconciliationStatus(f.report).status,'corrected');});
for(const [name,change] of Object.entries({converted:f=>f.report.posInventoryResults.push({sku:'FOOD',status:'posted',units:12}),received:f=>f.report.items[0].actuallyReceived=1,picked:f=>f.report.items[0].expectedFromPicking=1,unitDelta:f=>f.group.changes[0].delta=-180,noZeroProof:f=>f.report.posInventoryResults=[]}))test(`zero case rejects ${name}`,()=>{const f=zeroFixture();change(f);assert.throws(()=>verifiedCorrection(f.report,'FOOD',f.group,f.order,'zero_case'));});
for(const [name,change] of Object.entries(invalid)) test(`rejects ${name}`,()=>{const f=fixture();change(f);assert.throws(()=>verifiedCorrection(f.report,'FOOD',f.group,f.order));});
test('one Shopify correction can be evidenced on matching duplicate reports, never different received counts',()=>{
  const f=fixture();const c=verifiedCorrection(f.report,'FOOD',f.group,f.order);
  f.report.id='Miller Place::duplicate';
  assert.equal(verifiedCorrection(f.report,'FOOD',f.group,f.order).adjustmentId,c.adjustmentId);
  f.report.items[0].actuallyReceived=13;f.report.items[0].orderDiff=-2;
  assert.throws(()=>verifiedCorrection(f.report,'FOOD',f.group,f.order));
});
test('refuses replacing an existing correction or conflicting location',()=>{
  const f=fixture(),c=verifiedCorrection(f.report,'FOOD',f.group,f.order);
  mergeVerifiedCorrection(f.report,c);
  assert.throws(()=>mergeVerifiedCorrection(f.report,{...c,adjustmentId:'gid://shopify/InventoryAdjustmentGroup/222'}));
  f.report.inventoryLocationId='gid://shopify/Location/1';
  assert.throws(()=>mergeVerifiedCorrection(f.report,c));
});
test('canonical store tag identifies Miller Place even without generic marketing tag',()=>{
  const f=fixture();f.order.customer.tags=['Hummus Fit Miller Place','Miller Place'];
  assert.equal(verifiedCorrection(f.report,'FOOD',f.group,f.order).store,'Miller Place');
});
