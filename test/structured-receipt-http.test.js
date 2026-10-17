const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');

test('server rejects unstructured, fabricated and unverified receipts before saving or queuing inventory',async t=>{
  if(fs.existsSync('/data'))return t.skip('Local isolated test only');
  const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-structured-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  for(const f of fs.readdirSync(root).filter(f=>f.endsWith('.js')))fs.copyFileSync(path.join(root,f),path.join(tmp,f));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(tmp,'node_modules'),'dir');
  const delivery={orderId:'gid://shopify/Order/123',orderName:'#123',pickedBy:'Actual picker',items:[
    {sku:'WRAP',title:'Crispy Chicken Wrap',expectedQty:2,pickedQty:2,status:'picked'},
    {sku:'CASE-123',title:'Drink case',expectedQty:1,pickedQty:1,status:'picked',productTags:['Retail Essentials'],unitsPerCase:12},
    {sku:null,title:'Store supplies',expectedQty:1,pickedQty:1,status:'picked',productTags:['Other Essentials']}
  ]};
  let catalogStatus='matched',catalogSku='EXTRA-123',unavailable=false,writes=0;
  const mock=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/picked-summary/Holbrook') {res.statusCode=unavailable?503:200;return res.end(JSON.stringify(delivery));}
    if(req.url==='/api/receiving-barcode-lookup')return res.end(JSON.stringify({status:catalogStatus,productStatus:'ACTIVE',variantId:'gid://shopify/ProductVariant/9',sku:catalogSku,title:'Server verified extra'}));
    writes++;res.statusCode=500;res.end('{}');
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const sock=http.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
  const proc=spawn(process.execPath,['server.js'],{cwd:tmp,env:{PATH:process.env.PATH,PORT:String(port),STORE_TRACKING_SECRET:'test-only',HF_LOGISTICS_HANDOFF_SECRET:'test-only',RECEIVING_AUTOMATION_ENABLED:'false',ROUTE_BOARD_URL:`http://127.0.0.1:${mock.address().port}`},stdio:['ignore','pipe','pipe']});
  t.after(()=>proc.kill());await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);});
  const p=Buffer.from(JSON.stringify({v:1,scope:'receiving.store',store:'Holbrook'})).toString('base64url');
  const access=p+'.'+crypto.createHmac('sha256','test-only').update(p).digest('base64url');
  const body=()=>({store:'Holbrook',access,submissionId:crypto.randomUUID(),orderId:delivery.orderId,expectedItems:structuredClone(delivery.items),scannedCounts:{WRAP:0,'CASE-123':1,'Store supplies':1}});
  const post=b=>fetch(`http://127.0.0.1:${port}/api/submit-receiving-check`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
  async function rejected(b){const r=await post(b);assert.equal(r.status,400);assert.equal((await r.json()).notSaved,true);assert.equal(fs.existsSync(path.join(tmp,'reports.json')),false);assert.equal(writes,0);}
  for(const change of [
    b=>b.expectedItems[0].title='Typed new product',
    b=>b.expectedItems[0].pickedQty=200,
    b=>b.expectedItems[0].expectedQty=200,
    b=>b.expectedItems.splice(1,1),
    b=>b.expectedItems.push({sku:'FAKE',title:'Fake',pickedQty:1,expectedQty:1}),
    b=>b.orderId='gid://shopify/Order/999',
    b=>delete b.scannedCounts.WRAP,
    b=>b.scannedCounts.WRAP=null,
    b=>b.scannedCounts.WRAP='0',
    b=>b.scannedCounts.WRAP=1.5,
    b=>b.expectedItems[0]=null,
    b=>b.extraScans={'Chicken pesto':1},
    b=>{b.extraScans={'123456789012':1};b.extraDetails={'123456789012':{source:'manual'}};}
  ]){const b=body();change(b);await rejected(b);}
  unavailable=true;await rejected(body());unavailable=false;
  for(const status of ['unmatched','ambiguous']){
    catalogStatus=status;const b=body();b.extraScans={'123456789012':1};b.extraDetails={'123456789012':{lookupStatus:'matched',sku:'FORGED'}};await rejected(b);
  }
  catalogStatus='matched';catalogSku='WRAP';await rejected({...body(),extraScans:{'123456789012':1}});
  catalogSku='EXTRA-123';await rejected({...body(),extraScans:{'123456789012':1,'123456789013':1}});
  const good=body();good.expectedItems[1].productTags=['Other Essentials'];good.expectedItems[1].unitsPerCase=999;
  good.pickedBy='Forged picker';good.orderName='Forged order';good.extraScans={'123456789012':2};good.extraDetails={'123456789012':{source:'entered',sku:'FORGED'}};
  const response=await post(good);assert.equal(response.status,200);const saved=await response.json();
  assert.equal(saved.report.orderName,'#123');assert.equal(saved.report.pickedBy,'Actual picker');
  assert.equal(saved.report.items[0].actuallyReceived,0);assert.equal(saved.report.items[1].receivingCategory,'retail_essentials');assert.equal(saved.report.items[1].unitsPerCase,12);
  assert.equal(saved.report.extraItems[0].sku,'EXTRA-123');assert.equal(saved.report.extraItems[0].catalogVerified,true);
  unavailable=true;const replay=await post(good);assert.equal(replay.status,200);assert.equal((await replay.json()).report.id,saved.report.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp,'reports.json'))).length,1);assert.equal(writes,0);
});
