const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/receiving.html'),'utf8');
const handler=html.slice(html.indexOf('  function handleScanResult('),html.indexOf('  function reportIsRetrying('));
async function run(total,status='matched') {
  const prompts=['2',total],c={scanMode:'extra',extraScanPending:false,currentlyVisibleCode:null,missedFrameCount:0,
    scannedCounts:{BOWL:5},resolvedKeys:{},extraScans:{},extraDetails:{},expected:{items:[{sku:'BOWL',title:'Zeus Bowl'}]},
    storeAccessToken:'local-test-only',storeName:'Holbrook',itemKey:i=>i.sku,closeScanner(){},playScanFeedback(){},render(){},alert(){},
    document:{getElementById:()=>({style:{display:'flex'}})},prompt:()=>prompts.shift(),
    fetch:async()=>({ok:true,json:async()=>({status,sku:'BOWL',title:'Zeus Bowl'})}),
    window:{HFReceivingBarcode:require('../public/receiving-barcode')}};
  vm.createContext(c);vm.runInContext(handler,c);c.handleScanResult('123456789012','entered');
  await new Promise(resolve=>setImmediate(resolve));return c;
}
test('wrong/extra barcode already on order uses confirmed total instead of a second stock credit',async()=>{
  const c=await run('7');assert.equal(c.scannedCounts.BOWL,7);assert.equal(c.resolvedKeys.BOWL,true);assert.equal(Object.keys(c.extraScans).length,0);
});
test('cancelled or invalid total preserves the flagged extra and previous count',async()=>{
  for(const value of [null,'oops']){const c=await run(value);assert.equal(c.scannedCounts.BOWL,5);assert.equal(c.extraScans['123456789012'],2);}
});
test('unknown barcode never changes an existing order count',async()=>{
  const c=await run('7','unmatched');assert.equal(c.scannedCounts.BOWL,5);assert.equal(c.extraDetails['123456789012'].lookupStatus,'unmatched');
});
