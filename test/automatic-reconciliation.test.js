const test=require('node:test'),assert=require('node:assert/strict');
const {queueReport,retryReport,createReconciliationWorker}=require('../automatic-reconciliation');
const {correctionKey,LOCATIONS}=require('../verified-correction');
const {reconciliationStatus,warehouseReviewLines}=require('../reconciliation-status');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(store='Holbrook') {
  return queueReport({id:store+'::1',store,orderId:'gid://shopify/Order/1',orderName:'#1',submittedAt:new Date().toISOString(),
    items:[{sku:'WRAP',receivingCategory:'food',orderedQty:7,expectedFromPicking:7,actuallyReceived:0,orderDiff:-7,diff:-7}],extraItems:[],inventoryCorrections:[]});
}
function setup(report=fixture()) {
  let all=[report],calls=0,fail=false;
  const deps={loadReports:()=>clone(all),saveReports:r=>{all=clone(r);},now:()=>Date.now()+600000,
    request:async()=>{calls++;if(fail)throw new Error('network');return{results:[{status:'posted',kind:'food',sku:'WRAP',adjustmentId:'gid://shopify/InventoryAdjustmentGroup/10'}]};},
    readProof:async()=>({node:{id:'gid://shopify/InventoryAdjustmentGroup/10',createdAt:new Date(Date.now()+1000).toISOString(),
      referenceDocumentUri:`gid://agent-hazar-receiving/FoodCorrection/${correctionKey(report,'WRAP')}`,
      changes:[{name:'available',delta:-7,item:{id:'gid://shopify/InventoryItem/4',sku:'WRAP'},location:{id:`gid://shopify/Location/${LOCATIONS[report.store]}`}}]},
      order:{id:report.orderId,name:report.orderName,displayFulfillmentStatus:'FULFILLED',customer:{tags:[`Hummus Fit ${report.store}`]},
        fulfillments:[{status:'SUCCESS',location:{id:'gid://shopify/Location/103133642999'}}],
        lineItems:{nodes:[{sku:'WRAP',quantity:7,variant:{inventoryItem:{id:'gid://shopify/InventoryItem/4'}}}],pageInfo:{hasNextPage:false}}}})};
  return{deps,worker:createReconciliationWorker(deps),get:()=>all,calls:()=>calls,fail:v=>{fail=v;},add:r=>all.push(r)};
}
test('queue is limited to new receipts at the 14 POS stores',()=>{
  assert.equal(fixture('Brookfield').automation,undefined);
  const r=fixture();delete r.automation;r.submittedAt='2026-10-06T10:00:00Z';assert.equal(queueReport(r).automation,undefined);
});
test('manager retry preserves proofs and attempts and never reenrolls historical reports',()=>{
  const r=fixture();r.automation.status='requires_review';r.automation.attempts=4;
  r.inventoryCorrections=[{adjustmentId:'existing'}];r.automation.results=[{status:'posted'}];
  assert.equal(retryReport(r,'manager'),true);assert.equal(r.automation.attempts,4);
  assert.equal(r.inventoryCorrections[0].adjustmentId,'existing');assert.equal(r.automation.results[0].status,'posted');
  r.automation.status='complete';assert.equal(retryReport(r,'manager'),false);
  r.automation.status='processing';assert.throws(()=>retryReport(r,'manager'),/processing/);
  r.submittedAt='2026-10-07T10:00:00Z';assert.throws(()=>retryReport(r,'manager'),/cutover/);
  assert.throws(()=>retryReport(undefined,'manager'),/cutover/);
});
test('saved receipt receives independently verified proof and complete status once',async()=>{
  const f=setup();await f.worker.tick();assert.equal(f.get()[0].automation.status,'complete');
  assert.equal(f.get()[0].inventoryCorrections[0].shopifyVerified,true);await f.worker.tick();assert.equal(f.calls(),1);
});
test('network failure retries from durable report after worker restart',async()=>{
  const f=setup();f.fail(true);await f.worker.tick();assert.equal(f.get()[0].automation.status,'retry');
  f.get()[0].automation.nextAttemptAt=0;f.fail(false);await createReconciliationWorker(f.deps).tick();assert.equal(f.get()[0].automation.status,'complete');
});
test('duplicate report requires authoritative count confirmation without writes',async()=>{
  const f=setup();const r=fixture();r.id+='other';f.add(r);await f.worker.tick();assert.equal(f.calls(),0);assert.equal(f.get()[0].automation.status,'requires_review');
});
test('awaited work does not overwrite newly submitted reports',async()=>{
  const f=setup();const request=f.deps.request;f.deps.request=async(...args)=>{f.add({...fixture('Lynbrook'),automation:undefined});return request(...args);};
  await createReconciliationWorker(f.deps).tick();assert.equal(f.get().length,2);assert.equal(f.get()[1].store,'Lynbrook');
});
test('unverified Shopify group never marks report solved',async()=>{
  const f=setup();f.deps.readProof=async()=>{throw new Error('proof missing');};await createReconciliationWorker(f.deps).tick();
  assert.equal(f.get()[0].inventoryCorrections.length,0);assert.equal(f.get()[0].automation.status,'retry');
});
test('combined receipt independently verifies exact source order and retains report association',async()=>{
  const report=fixture('Lake Grove'),f=setup(report),originalProof=f.deps.readProof;
  const proof=await originalProof();
  report.orderId+=',gid://shopify/Order/2';report.orderName+=', #2';
  f.deps.request=async()=>({results:[{status:'posted',kind:'food',sku:'WRAP',orderId:'gid://shopify/Order/1',adjustmentId:proof.node.id}]});
  let requestedId;f.deps.readProof=async(id,orderId)=>{requestedId=orderId;return proof;};
  await createReconciliationWorker(f.deps).tick();
  const saved=f.get()[0];assert.equal(saved.automation.status,'complete');
  assert.equal(requestedId,'gid://shopify/Order/1');
  assert.equal(saved.inventoryCorrections[0].sourceOrderId,requestedId);
  assert.equal(saved.inventoryCorrections[0].orderId,report.orderId);
  assert.equal(require('../reconciliation-status').reconciliationStatus(saved).status,'corrected');
});
test('combined receipt rejects proof for an unrelated order',async()=>{
  const f=setup();f.deps.request=async()=>({results:[{status:'posted',kind:'food',sku:'WRAP',orderId:'gid://shopify/Order/99',adjustmentId:'gid://shopify/InventoryAdjustmentGroup/10'}]});
  await createReconciliationWorker(f.deps).tick();assert.equal(f.get()[0].inventoryCorrections.length,0);
});
test('overlapping combined and standalone reports require review before requests',async()=>{
  const f=setup();const report=fixture();report.id+='second';report.orderId+=',gid://shopify/Order/2';report.orderName+=', #2';f.add(report);
  await f.worker.tick();assert.equal(f.calls(),0);assert.ok(f.get().every(r=>r.automation.status==='requires_review'));
});

for (const [shipped,received,delta] of [[10,9,-1],[9,9,0],[9,8,-1],[9,0,-9],[9,10,1]]) {
  test(`Huntington records ${shipped} credited and ${received} received with signed delta ${delta}`,async()=>{
    const r=fixture('Huntington');
    r.foodShipmentKey='a'.repeat(64);
    Object.assign(r.items[0],{orderedQty:10,expectedFromPicking:shipped,actuallyReceived:received,
      orderDiff:received-10,diff:received-shipped});
    const f=setup(r);
    const locationId='gid://shopify/Location/'+LOCATIONS.Huntington;
    const inventoryItemId='gid://shopify/InventoryItem/4';
    const groupId=delta?'gid://shopify/InventoryAdjustmentGroup/10':null;
    const basis={shipmentKey:r.foodShipmentKey,ordered:10,received,shipped,credited:shipped,delta,
      credits:[{fulfillmentId:'gid://shopify/Fulfillment/1',adjustmentId:'gid://shopify/InventoryAdjustmentGroup/9',quantity:shipped}],
      inventoryItemId,locationId,lineItemId:'gid://shopify/LineItem/2'};
    const node=delta?{id:groupId,createdAt:r.submittedAt,
      referenceDocumentUri:`gid://agent-hazar-receiving/FoodCorrection/${correctionKey(r,'WRAP')}`,
      changes:[{name:'available',delta,item:{id:inventoryItemId,sku:'WRAP'},location:{id:locationId}}]}:null;
    const requests=[];
    f.deps.request=async (endpoint,body)=>{
      requests.push(endpoint);
      assert.equal(body.report.foodShipmentKey,r.foodShipmentKey);
      if(endpoint==='/api/verified-food-receiving-correction') {
        return {results:[{status:delta?'posted':'matched',kind:'food',sku:'WRAP',orderId:r.orderId,adjustmentId:groupId}]};
      }
      assert.equal(endpoint,'/api/verified-food-receiving-proof');
      assert.equal(body.groupId,groupId);
      return {basis,node};
    };
    const worker=createReconciliationWorker(f.deps);
    await worker.tick();
    await worker.tick();
    const saved=f.get()[0], status=reconciliationStatus(saved);
    assert.equal(saved.automation.status,'complete');
    assert.equal(requests.length,2);
    assert.equal(status.pendingCount,0);
    assert.equal(status.correctedCount,delta?1:0);
    assert.equal(status.backorderCount,shipped<10?1:0);
    assert.equal(warehouseReviewLines(saved)[0]?.quantity,received<shipped?shipped-received:undefined);
  });
}

test('pilot requires explicit zero even when food was missing from picking, and binds the shipment to retry identity',()=>{
  const {verifiedDelivery}=require('../structured-receipt');
  const {submissionIdentity,findSubmission}=require('../receipt-submission');
  const orderId='gid://shopify/Order/1';
  const foodShipmentKey='a'.repeat(64);
  const item={title:'Wrap',sku:'WRAP',status:'missing',expectedQty:10,pickedQty:0};
  const expected={orderId,foodShipmentKey,shipmentVerifiedAt:new Date().toISOString(),items:[item]};
  const body={store:'Huntington',orderId,foodShipmentKey,expectedItems:[item],scannedCounts:{},submissionId:'test-submission-123'};
  assert.throws(()=>verifiedDelivery(body,expected),/including zero/);
  body.scannedCounts.WRAP=0;
  assert.equal(verifiedDelivery(body,expected),expected);
  const identity=submissionIdentity(body);
  const saved={store:body.store,orderId,foodShipmentKey,submissionId:body.submissionId,submissionFingerprint:identity.fingerprint};
  assert.equal(findSubmission([saved],body.store,identity).replayed,true);
  const changed=submissionIdentity({...body,foodShipmentKey:'b'.repeat(64)});
  assert.equal(findSubmission([saved],body.store,changed).conflict,true);
});

test('November 6 exception reports keep their prior posting evidence and require explicit manager retry',async()=>{
  const cases=[
    ['Ronkonkoma','#805498','Waiting for exact delivered-line store credit proof'],
    ['Lake Grove','#805433','Approved Shopify variant must have the exact unique SKU MF-8670041-CS'],
    ['Island Park','#805093','Waiting for exact delivered-line store credit proof'],
    ['Islip','#804967','Case SKU needs an approved case-to-POS-unit mapping'],
    ['Selden','#805274','Case SKU needs an approved case-to-POS-unit mapping'],
  ];
  for(const [store,orderName,error] of cases) {
    const report=fixture(store);
    report.orderName=orderName;
    report.automation.status='requires_review';
    report.automation.results=[{kind:'retail',status:'requires_review',error}];
    report.posInventoryResults=[{sku:'CASE-X',status:'posted',units:12,adjustmentId:'gid://shopify/InventoryAdjustmentGroup/9'}];
    const f=setup(report);
    await f.worker.tick();
    assert.deepEqual(f.get(),[report]);
    assert.equal(f.calls(),0);
  }
});
