const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {POS_STORES}=require('../reconciliation-status');
test('all 14 stores: restart/lost response/parallel requests reuse one receipt, scoped auth, conflicts never overwrite it',async t=>{
  if(fs.existsSync('/data'))return t.skip('Local isolated test only');
  const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-receipt-retry-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  for(const f of fs.readdirSync(root).filter(f=>f.endsWith('.js')))fs.copyFileSync(path.join(root,f),path.join(tmp,f));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(tmp,'node_modules'),'dir');
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let proc;
  async function start(){
    proc=spawn(process.execPath,['server.js'],{cwd:tmp,env:{PATH:process.env.PATH,PORT:String(port),STORE_TRACKING_SECRET:'test-only',RECEIVING_AUTOMATION_ENABLED:'false',ROUTE_BOARD_URL:'http://127.0.0.1:1'},stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);});
  }
  async function stop(){if(proc&&!proc.killed){const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;}}
  t.after(stop);await start();
  const token=store=>{const p=Buffer.from(JSON.stringify({v:1,scope:'receiving.store',store})).toString('base64url');return p+'.'+crypto.createHmac('sha256','test-only').update(p).digest('base64url');};
  const base=`http://127.0.0.1:${port}`;
  const post=body=>fetch(base+'/api/submit-receiving-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const bodies=[...POS_STORES].map((store,i)=>({store,access:token(store),submissionId:crypto.randomUUID(),orderId:'gid://shopify/Order/'+(i+1),orderName:'#'+(i+1),receivedBy:'Test',expectedItems:[{sku:'WRAP',title:'Food',expectedQty:2,pickedQty:2}],scannedCounts:{WRAP:0}}));
  const first=await Promise.all(bodies.map(async body=>{const r=await post(body);assert.equal(r.status,200);return r.json();}));
  await stop();await start();
  for(let i=0;i<bodies.length;i++){
    const b=bodies[i],retries=await Promise.all([post(b),post(b),post({...b,submissionId:crypto.randomUUID()})]);
    for(const r of retries){assert.equal(r.status,200);const d=await r.json();assert.equal(d.replayed,true);assert.equal(d.report.id,first[i].report.id);}
    const saved=await fetch(base+'/api/receiving-receipt/'+encodeURIComponent(b.store)+'?access='+encodeURIComponent(b.access)+'&orderId='+encodeURIComponent(b.orderId));
    assert.equal(saved.status,200);assert.equal((await saved.json()).report.id,first[i].report.id);
  }
  const b=bodies[0];
  assert.equal((await post({...b,scannedCounts:{WRAP:1}})).status,409);
  assert.equal((await post({...b,submissionId:crypto.randomUUID(),orderId:b.orderId+',gid://shopify/Order/99'})).status,409);
  assert.equal((await post({...b,access:token(bodies[1].store)})).status,403);
  const stored=JSON.parse(fs.readFileSync(path.join(tmp,'reports.json')));
  assert.equal(stored.length,14);assert.ok(stored.every(r=>r.items[0].actuallyReceived===0));
});
