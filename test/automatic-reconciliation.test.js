const test=require('node:test'),assert=require('node:assert/strict');
const {queueReport,retryReport,createReconciliationWorker}=require('../automatic-reconciliation');
const {correctionKey,LOCATIONS}=require('../verified-correction');
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
