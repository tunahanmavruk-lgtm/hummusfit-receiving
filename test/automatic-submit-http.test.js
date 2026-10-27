const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
test('staff confirmation saves immediately, then verifies and posts in background without heartbeat',async t=>{
  if(fs.existsSync('/data'))return t.skip('Local isolated test only');
  const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-auto-http-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  for(const f of fs.readdirSync(root).filter(f=>f.endsWith('.js')))fs.copyFileSync(path.join(root,f),path.join(tmp,f));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(tmp,'node_modules'),'dir');
  let receipt,release,correctionRequests=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};res.setHeader('Content-Type','application/json');
    if(req.url==='/api/picked-summary/Holbrook') {
      res.end(JSON.stringify({orderId:'gid://shopify/Order/1',orderName:'#1',pickedBy:'Test',items:[{title:'Crispy Chicken Wrap',sku:'WRAP',expectedQty:7,pickedQty:7}]}));
    } else if(req.url==='/api/automatic-receiving-correction') {
      correctionRequests++;
      receipt=body.report;await gate;res.end(JSON.stringify({results:[{status:'posted',kind:'food',sku:'WRAP',adjustmentId:'gid://shopify/InventoryAdjustmentGroup/10'}]}));
    } else if(req.url==='/api/receiving-adjustment-proof') {
      const key=crypto.createHash('sha256').update(JSON.stringify(['agent-hazar-food','Holbrook',receipt.orderId,'WRAP'])).digest('hex');
      res.end(JSON.stringify({node:{id:body.groupId,createdAt:new Date().toISOString(),referenceDocumentUri:'gid://agent-hazar-receiving/FoodCorrection/'+key,
        changes:[{name:'available',delta:-7,item:{id:'gid://shopify/InventoryItem/4',sku:'WRAP'},location:{id:'gid://shopify/Location/66819490039'}}]},
        order:{id:receipt.orderId,name:receipt.orderName,displayFulfillmentStatus:'FULFILLED',customer:{tags:['Hummus Fit Holbrook']},
          fulfillments:[{status:'SUCCESS',location:{id:'gid://shopify/Location/103133642999'}}],lineItems:{pageInfo:{hasNextPage:false},nodes:[{sku:'WRAP',quantity:7,variant:{inventoryItem:{id:'gid://shopify/InventoryItem/4'}}}]}}}));
    } else {res.statusCode=404;res.end('{}');}
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
  const portServer=http.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const proc=spawn(process.execPath,['server.js'],{cwd:tmp,env:{PATH:process.env.PATH,PORT:String(port),HF_LOGISTICS_HANDOFF_SECRET:'test-only',STORE_TRACKING_SECRET:'store-test-only',ROUTE_BOARD_URL:`http://127.0.0.1:${mock.address().port}`},stdio:['ignore','pipe','pipe']});
  t.after(()=>proc.kill());await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout')),10000);proc.stdout.once('data',()=>{clearTimeout(timer);resolve();});proc.once('error',reject);});
  const payload=Buffer.from(JSON.stringify({v:1,scope:'receiving.store',store:'Holbrook'})).toString('base64url');
  const access=payload+'.'+crypto.createHmac('sha256','store-test-only').update(payload).digest('base64url');
  const url=`http://127.0.0.1:${port}/api/submit-receiving-check`;
  const body={store:'Holbrook',access,submissionId:'a'.repeat(32),orderId:'gid://shopify/Order/1',orderName:'#1',expectedItems:[{title:'Crispy Chicken Wrap',sku:'WRAP',expectedQty:7,pickedQty:7}],scannedCounts:{WRAP:0}};
  const diagnostic=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,receivedBy:'Isolated browser check'})});
  assert.equal(diagnostic.status,400);assert.equal((await diagnostic.json()).code,'diagnostic_submission_blocked');
  assert.equal(fs.existsSync(path.join(tmp,'reports.json')),false);assert.equal(correctionRequests,0);
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.report.automation.status,'queued');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp,'reports.json'))).length,1);
  release();let posted;
  for(let i=0;i<100;i++){posted=JSON.parse(fs.readFileSync(path.join(tmp,'reports.json')))[0];if(posted.automation.status==='complete')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(posted.automation.status,'complete');assert.equal(posted.inventoryCorrections[0].delta,-7);assert.equal(posted.inventoryCorrections[0].shopifyVerified,true);
  const retries=await Promise.all(Array.from({length:12},()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json())));
  assert.ok(retries.every(r=>r.replayed&&r.report.id===saved.report.id));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp,'reports.json'))).length,1);
  assert.equal(correctionRequests,1);
  assert.equal(retries[0].report.inventoryCorrections[0].adjustmentId,posted.inventoryCorrections[0].adjustmentId);
  const conflicting=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,submissionId:'b'.repeat(32),scannedCounts:{WRAP:1}})});
  assert.equal(conflicting.status,409);assert.equal(correctionRequests,1);
  body.access='invalid';assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
});
