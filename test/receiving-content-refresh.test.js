const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const progress=require('../public/receiving-progress');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/receiving.html'),'utf8');
const refresh=html.slice(html.indexOf('  function refreshCurrentDelivery('),html.indexOf('\n  function loadExpected('));
const expected={orderId:'100',items:[{sku:'WRAP',expectedQty:2,pickedQty:2,status:'picked'}]};
function fixture(overrides={}){
  const notice={hidden:true,textContent:'',appendChild(){}},main={hidden:false};
  let resolve;
  const state={expected:structuredClone(expected),progress,progressEnabled:true,deliveryRefreshInFlight:false,expectedLoadPending:false,submissionInFlight:false,pendingLookupCount:0,finishedReport:null,completedReportId:null,pendingSubmission:null,scannedCounts:{},resolvedKeys:{},extraScans:{},extraDetails:{},receivedByValue:'',draftMismatch:false,receiptConflict:false,draftProblem:'',lastDraftState:'unchanged',confirmFinish:true,storeName:'Holbrook',storeAccessToken:'test',submissionError:'',saved:0,rendered:0,opened:0,closed:0,
    document:{visibilityState:'visible',getElementById(id){return id==='deliveryUpdate'?notice:main;}},AbortSignal,
    fetch(){return new Promise(r=>{resolve=r;});},saveProgress(){state.saved++;return true;},render(){state.rendered++;},closeScanner(){state.closed++;},openFreshReceiving(){state.opened++;},...overrides};
  vm.createContext(state);vm.runInContext(refresh,state);
  return {state,notice,async refresh(data,event){state.refreshCurrentDelivery(event);if(resolve){resolve({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));}},resolve(data){resolve({ok:true,json:async()=>data});}};
}
const added={...expected,items:[...expected.items,{sku:'BUFFIN',expectedQty:12,pickedQty:12,status:'picked'}]};
test('same-order added and removed items appear on untouched forms',async()=>{
  for(const items of [added.items,[]]){const f=fixture();await f.refresh({...expected,items});assert.deepEqual(f.state.expected.items,items);assert.equal(f.state.rendered,1);assert.equal(f.state.saved,1);assert.equal(f.state.opened,0);assert.match(f.notice.textContent,/updated/);}
});
test('active counts including explicit zero, extras, names and confirmation are preserved and locked',async()=>{
  for(const draft of [{scannedCounts:{WRAP:0}},{resolvedKeys:{WRAP:true}},{extraScans:{unknown:1}},{extraDetails:{unknown:{title:'Extra'}}},{receivedByValue:'Staff'}]){
    const f=fixture(draft);await f.refresh(added);assert.deepEqual(f.state.expected,expected);for(const [k,v] of Object.entries(draft))assert.deepEqual(f.state[k],v);assert.equal(f.state.draftMismatch,true);assert.equal(f.state.confirmFinish,false);assert.equal(f.state.closed,1);assert.equal(f.state.opened,0);
  }
});
test('quantity, status and food-shipment changes are detected',async()=>{
  for(const changed of [{...expected,items:[{...expected.items[0],pickedQty:1}]},{...expected,items:[{...expected.items[0],status:'missing'}]},{...expected,foodShipmentKey:'new'}]){const f=fixture({scannedCounts:{WRAP:1}});await f.refresh(changed);assert.equal(f.state.draftMismatch,true);assert.equal(f.state.scannedCounts.WRAP,1);}
});
test('pending submission payload and completed receipts never reopen or mutate',async()=>{
  for(const props of [{pendingSubmission:{requestId:'same',scannedCounts:{WRAP:1}}},{finishedReport:{id:'saved'}},{completedReportId:'saved'}]){const f=fixture(props);await f.refresh(added,{type:'pageshow',persisted:true});assert.deepEqual(f.state.expected,expected);for(const [k,v]of Object.entries(props))assert.deepEqual(f.state[k],v);assert.equal(f.state.saved,0);assert.equal(f.state.rendered,0);assert.equal(f.state.draftMismatch,false);assert.equal(f.state.opened,0);assert.equal(f.notice.hidden,false);}
});
test('storage failure or newer tab draft prevents refresh even if local snapshot did not change',async()=>{
  const entries=new Map(),storage={getItem:k=>entries.get(k)||null,setItem:(k,v)=>entries.set(k,v)};
  const first=progress.create(storage,'Holbrook'),second=progress.create(storage,'Holbrook');first.read('100');first.save({expected,scannedCounts:{}});second.read('100');second.save({expected,scannedCounts:{WRAP:7}});
  const f=fixture();f.state.saveProgress=()=>{assert.equal(f.state.lastDraftState,'');try{first.save({expected,scannedCounts:{}});return true;}catch(e){f.state.draftProblem=e.message;return false;}};
  await f.refresh(added);assert.deepEqual(f.state.expected,expected);assert.equal(f.state.rendered,0);assert.match(f.notice.textContent,/another tab/);assert.equal(second.read('100').scannedCounts.WRAP,7);
  const broken=fixture({saveProgress:()=>false,draftProblem:'Storage is full'});await broken.refresh(added);assert.deepEqual(broken.state.expected,expected);assert.equal(broken.state.rendered,0);
});
test('requests completing after submission or barcode lookup starts do nothing',async()=>{
  for(const key of ['submissionInFlight','pendingLookupCount']){const f=fixture();f.state.refreshCurrentDelivery();f.state[key]=1;f.resolve(added);await new Promise(r=>setImmediate(r));assert.deepEqual(f.state.expected,expected);assert.equal(f.state.saved,0);assert.equal(f.state.rendered,0);}
});
test('unchanged same-order items are a no-op; repeated mismatch stays locked',async()=>{
  const f=fixture();await f.refresh({...expected,orderId:'100'});assert.equal(f.state.saved,0);assert.equal(f.notice.hidden,true);
  const active=fixture({scannedCounts:{WRAP:2}});await active.refresh(added);active.state.saveProgress=()=>false;await active.refresh(added);assert.equal(active.state.draftMismatch,true);assert.deepEqual(active.state.expected,expected);assert.equal(active.state.scannedCounts.WRAP,2);
});

test('non-enabled stores keep existing same-order behavior',async()=>{const f=fixture({progressEnabled:false,scannedCounts:{WRAP:1}});await f.refresh(added);assert.deepEqual(f.state.expected,expected);assert.equal(f.state.draftMismatch,false);assert.equal(f.state.rendered,0);assert.equal(f.state.saved,0);assert.equal(f.notice.hidden,true);});
