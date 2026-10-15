const test=require('node:test'),assert=require('node:assert/strict');
const progress=require('../public/receiving-progress');
function storage(){const m=new Map();return {get length(){return m.size;},key:i=>[...m.keys()][i],getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};}
function draft(order='gid://shopify/Order/1'){return {expected:{orderId:order,orderName:'#1',items:[{sku:'FOOD',expectedQty:2,pickedQty:2,status:'picked'}]},scannedCounts:{FOOD:0},resolvedKeys:{FOOD:true},receivedBy:'Staff',extraScans:{'123456789012':3},extraDetails:{'123456789012':{source:'scan'}},pending:{submissionId:'a'.repeat(32),access:'never-persist-this',scannedCounts:{FOOD:0}}};}
test('draft restores zero confirmations, name, extras and immutable retry after refresh without persisting access token',()=>{
  const disk=storage(),one=progress.create(disk,'Holbrook');one.read(draft().expected.orderId);one.save(draft());
  const restored=progress.create(disk,'Holbrook').read(draft().expected.orderId);
  assert.equal(restored.scannedCounts.FOOD,0);assert.equal(restored.resolvedKeys.FOOD,true);assert.equal(restored.receivedBy,'Staff');
  assert.equal(restored.extraScans['123456789012'],3);assert.equal(restored.pending.submissionId,'a'.repeat(32));assert.equal(restored.pending.access,undefined);
});
test('drafts never mix stores or orders; combined order identity is stable',()=>{
  const disk=storage(),one=progress.create(disk,'Holbrook');one.save(draft());
  assert.equal(progress.create(disk,'Lynbrook').read(draft().expected.orderId),null);
  assert.equal(one.read('gid://shopify/Order/2'),null);
  one.save(draft('gid://shopify/Order/2, gid://shopify/Order/3'));
  assert.ok(one.read('gid://shopify/Order/3,gid://shopify/Order/2'));
  assert.equal(one.list().length,2);
});
test('other tabs cannot silently overwrite saved progress',()=>{
  const disk=storage(),a=progress.create(disk,'Holbrook'),b=progress.create(disk,'Holbrook'),d=draft();
  a.read(d.expected.orderId);b.read(d.expected.orderId);a.save(d);
  assert.throws(()=>b.save({...d,receivedBy:'Other person'}),/another tab/);
  assert.equal(b.read(d.expected.orderId).receivedBy,'Staff');
});
test('storage failures are explicit and completed drafts do not appear as unfinished',()=>{
  const broken={getItem:()=>null,setItem:()=>{throw new Error('quota');}};
  assert.throws(()=>progress.create(broken,'Holbrook').save(draft()),/quota/);
  const good=progress.create(storage(),'Holbrook');good.save({...draft(),completedReportId:'receipt-1'});assert.equal(good.list().length,0);
});
test('enabled for exactly the 14 POS stores and picking changes invalidate confirmations',()=>{
  const {POS_STORES}=require('../reconciliation-status');assert.equal(POS_STORES.size,14);
  for(const store of POS_STORES)assert.equal(progress.enabled(store),true);
  for(const store of ['Ares Philadelphia','Hicksville','Ozone Park'])assert.equal(progress.enabled(store),false);
  const a=draft().expected,b=JSON.parse(JSON.stringify(a));b.items[0].pickedQty=1;assert.notEqual(progress.signature(a),progress.signature(b));
});
