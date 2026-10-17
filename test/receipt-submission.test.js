const test=require('node:test'),assert=require('node:assert/strict');
const {submissionIdentity,findSubmission,createSubmissionLock}=require('../receipt-submission');
function body(){return {store:'Holbrook',orderId:'gid://shopify/Order/1',submissionId:'a'.repeat(32),expectedItems:[{sku:'FOOD',title:'Food',expectedQty:5,pickedQty:5}],scannedCounts:{FOOD:0}};}
function saved(b=body()){const i=submissionIdentity(b);return {id:'r1',store:b.store,orderId:b.orderId,submissionId:i.submissionId,submissionFingerprint:i.fingerprint,items:[{sku:'FOOD',title:'Food',orderedQty:5,expectedFromPicking:5,actuallyReceived:b.scannedCounts.FOOD}],extraItems:[],inventoryCorrections:[{adjustmentId:'existing-proof'}]};}
test('same ID and same counts return saved receipt; changed counts never replay the ID',()=>{
  const b=body(),r=saved(b);assert.equal(findSubmission([r],b.store,submissionIdentity(b)).report,r);
  b.scannedCounts.FOOD=1;assert.equal(findSubmission([r],b.store,submissionIdentity(b)).conflict,true);
});
test('different devices and legacy clients cannot create a second receipt for same or overlapping order',()=>{
  const b=body(),r=saved(b);delete b.submissionId;assert.equal(findSubmission([r],b.store,submissionIdentity(b)).replayed,true);
  b.scannedCounts.FOOD=1;assert.equal(findSubmission([r],b.store,submissionIdentity(b)).conflict,true);
  b.orderId+=',gid://shopify/Order/2';assert.equal(findSubmission([r],b.store,submissionIdentity(b)).conflict,true);
  assert.equal(findSubmission([r],'Lynbrook',submissionIdentity({...b,store:'Lynbrook'})),null);
});
test('historical free-text receipt can acknowledge an identical retry without creating inventory work',()=>{
  const b=body();b.extraScans={'Old product description':2};b.extraDetails={'Old product description':{source:'manual'}};
  const identity=submissionIdentity(b),r=saved();r.submissionFingerprint=identity.fingerprint;
  r.extraItems=[{code:'Old product description',qty:2}];
  assert.equal(findSubmission([r],b.store,identity).replayed,true);
  b.extraScans['Old product description']=3;
  assert.equal(findSubmission([r],b.store,submissionIdentity(b)).conflict,true);
});
test('invalid input rejects fractional, negative, missing or duplicate order identities',()=>{
  for(const change of [b=>b.orderId='',b=>b.orderId+=','+b.orderId,b=>b.scannedCounts.FOOD=-1,b=>b.scannedCounts.FOOD=1.5,b=>b.expectedItems.push(b.expectedItems[0])]){
    const b=body();change(b);assert.throws(()=>submissionIdentity(b));
  }
});
test('concurrent submissions serialize through asynchronous work and recover after failure',async()=>{
  const locked=createSubmissionLock(),calls=[];
  await Promise.all(Array.from({length:10},(_,i)=>locked('Holbrook',async()=>{calls.push('start'+i);await new Promise(r=>setTimeout(r,1));calls.push('end'+i);}))); 
  for(let i=0;i<10;i++)assert.deepEqual(calls.slice(i*2,i*2+2),['start'+i,'end'+i]);
  await assert.rejects(locked('Holbrook',()=>Promise.reject(new Error('test'))));
  assert.equal(await locked('Holbrook',()=>42),42);
});
