const test=require('node:test'),assert=require('node:assert/strict');
const {verifiedCorrection,correctionKey,mergeVerifiedCorrection}=require('../verified-correction');
const {mergeRetailPostings}=require('../retail-conversion-retry');
const {reconciliationStatus}=require('../reconciliation-status');
function fixture(){
  const report={id:'Huntington::receipt',store:'Huntington',orderId:'gid://shopify/Order/1',orderName:'#1',submittedAt:'2026-10-16T17:04:16Z',items:[
    {sku:'food',receivingCategory:'food',orderedQty:2,expectedFromPicking:2,actuallyReceived:4,diff:2,orderDiff:2},
    {sku:'ghost',receivingCategory:'retail_essentials',orderedQty:1,expectedFromPicking:0,actuallyReceived:0,diff:0,orderDiff:-1}]};
  const order={id:report.orderId,name:report.orderName,displayFulfillmentStatus:'PARTIALLY_FULFILLED',customer:{tags:['Hummus Fit Huntington']},lineItems:{nodes:[
    {id:'gid://shopify/LineItem/1',sku:'food',quantity:2,variant:{inventoryItem:{id:'gid://shopify/InventoryItem/1'}}},
    {id:'gid://shopify/LineItem/2',sku:'ghost',quantity:1}],pageInfo:{hasNextPage:false}},
    fulfillments:[{id:'gid://shopify/Fulfillment/1',createdAt:'2026-10-16T22:00:00Z',status:'SUCCESS',location:{id:'gid://shopify/Location/103133642999'},fulfillmentLineItems:{nodes:[{quantity:2,lineItem:{id:'gid://shopify/LineItem/1'}}],pageInfo:{hasNextPage:false}}}]};
  const group={id:'gid://shopify/InventoryAdjustmentGroup/1',createdAt:'2026-10-16T22:01:00Z',referenceDocumentUri:`gid://agent-hazar-receiving/FoodCorrection/${correctionKey(report,'food')}`,
    changes:[{name:'available',delta:2,item:{id:'gid://shopify/InventoryItem/1',sku:'food'},location:{id:'gid://shopify/Location/103133511927'}}]};
  const result={sku:'ghost',status:'backordered',units:0,shopifyVerified:true,orderId:report.orderId,lineItemId:'gid://shopify/LineItem/2',orderedCases:1,verifiedAt:'2026-10-16T22:00:00Z'};
  return {report,order,group,result};
}
test('partial delivery keeps unchanged +2 food calculation and reports backorder separately',()=>{
  const {report,order,group,result}=fixture();
  mergeVerifiedCorrection(report,verifiedCorrection(report,'food',group,order));
  const retail=[report.items[1]];
  assert.equal(mergeRetailPostings(report,retail,{results:[result]}),true);
  const status=reconciliationStatus(report);assert.equal(status.status,'received_with_backorder');assert.equal(status.pendingCount,0);assert.equal(status.backorderCount,1);assert.equal(status.correctedCount,1);
  assert.equal(report.inventoryCorrections.length,1);assert.equal(report.inventoryCorrections[0].delta,2);
  mergeRetailPostings(report,retail,{results:[]});assert.equal(reconciliationStatus(report).backorderCount,1);
});
test('unshipped food and unverified backorder do not clear the report',()=>{
  const f=fixture();f.order.fulfillments[0].fulfillmentLineItems.nodes=[];
  assert.throws(()=>verifiedCorrection(f.report,'food',f.group,f.order));
  f.result.shopifyVerified=false;mergeRetailPostings(f.report,[f.report.items[1]],{results:[f.result]});
  assert.equal(reconciliationStatus(f.report).pendingCount,2);
});
test('other stores and mismatched backorder quantities cannot use the Huntington exception',()=>{
  for(const change of [f=>f.report.store='Holbrook',f=>f.result.orderedCases=2,f=>f.result.orderId='gid://shopify/Order/2',f=>f.report.items[1].actuallyReceived=1]){
    const f=fixture();change(f);mergeRetailPostings(f.report,[f.report.items[1]],{results:[f.result]});assert.ok(reconciliationStatus(f.report).pendingCount>0);
  }
});
test('all 14 stores retain unchanged food deltas and exact store-bound backorder proof',()=>{
  const {LOCATIONS}=require('../store-fulfillment-policy');
  for(const [store,location] of Object.entries(LOCATIONS)) {
    const f=fixture();f.report.store=store;f.report.id=store+'::receipt';
    f.order.customer.tags=['Hummus Fit '+store];f.order.fulfillments[0].createdAt='2026-10-18T22:00:00Z';
    f.group.referenceDocumentUri=`gid://agent-hazar-receiving/FoodCorrection/${correctionKey(f.report,'food')}`;
    f.group.changes[0].location.id='gid://shopify/Location/'+location;f.result.store=store;
    mergeVerifiedCorrection(f.report,verifiedCorrection(f.report,'food',f.group,f.order));
    mergeRetailPostings(f.report,[f.report.items[1]],{results:[f.result]});
    assert.equal(reconciliationStatus(f.report).status,'received_with_backorder',store);
    assert.equal(f.report.inventoryCorrections[0].delta,2,store);
    mergeRetailPostings(f.report,[f.report.items[1]],{results:[]});
    assert.equal(f.report.inventoryCorrections.length,1,store);
  }
});
