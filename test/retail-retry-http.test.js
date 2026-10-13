const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

test('HTTP retry persists a partial ledger result and rejects unauthenticated writes', async t => {
  // The production app uses /data when mounted; never run this isolated test there.
  if (fs.existsSync('/data')) return t.skip('Requires an unmounted local test environment');
  const root = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-retry-test-'));
  t.after(() => fs.rmSync(tmp, {recursive:true,force:true}));
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.js'))) {
    fs.copyFileSync(path.join(root,file),path.join(tmp,file));
  }
  fs.symlinkSync(process.env.HF_TEST_NODE_MODULES || path.join(root,'node_modules'),path.join(tmp,'node_modules'),'dir');
  const retail = sku => ({sku,receivingCategory:'retail_essentials',orderedQty:1,expectedFromPicking:1,actuallyReceived:1,diff:0,orderDiff:0});
  fs.writeFileSync(path.join(tmp,'reports.json'),JSON.stringify([{
    id:'Lake Grove::test',store:'Lake Grove',orderId:'gid://shopify/Order/123',submittedAt:'2026-10-12T13:00:00Z',
    hasErrors:true,extraItems:[],items:[retail('SOUR'),retail('COKE'),
      {sku:'FOOD',receivingCategory:'food',orderedQty:7,expectedFromPicking:0,actuallyReceived:0,diff:0,orderDiff:-7}]
  }]));
  let calls = 0;
  const mock = http.createServer(async (req,res) => {
    assert.equal(req.url,'/api/essentials-pos-receipt');
    let body=''; for await (const chunk of req) body+=chunk;
    const payload=JSON.parse(body);
    assert.deepEqual(payload.receivedCounts,{SOUR:1,COKE:1});
    assert.equal(payload.store,'Lake Grove');
    assert.equal(payload.orderId,'gid://shopify/Order/123');
    assert.equal(payload.receiptEvidence.id,'Lake Grove::test');
    assert.equal(payload.receiptEvidence.items.length,2);
    calls++;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ok:false,results:[
      {sku:'SOUR',status:calls===1?'posted':'already_posted',units:8,adjustmentId:'gid://shopify/InventoryAdjustmentGroup/123'},
      {sku:'COKE',status:'requires_mapping',error:'Missing mapping'}
    ]}));
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve));
  t.after(() => mock.close());
  // Obtain an unused local port without contacting production.
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const app = spawn(process.execPath,['server.js'],{cwd:tmp,env:{PATH:process.env.PATH,PORT:String(port),HF_LOGISTICS_HANDOFF_SECRET:'test-only-secret',ROUTE_BOARD_URL:`http://127.0.0.1:${mock.address().port}`},stdio:['ignore','pipe','pipe']});
  t.after(() => app.kill());
  let stderr = '';
  app.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error(`Test server did not start: ${stderr}`)),20000);
    app.stdout.on('data',()=>{clearTimeout(timer);resolve();});
    app.on('error',reject);
    app.on('exit',code=>{clearTimeout(timer);reject(new Error(`Test server exited ${code}`));});
  });
  const url=`http://127.0.0.1:${port}/api/retry-retail-conversion`;
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const payload=Buffer.from(JSON.stringify({sub:'test',role:'manager',scope:['reports.manage'],exp:Math.floor(Date.now()/1000)+60})).toString('base64url');
  const token=payload+'.'+crypto.createHmac('sha256','test-only-secret').update(payload).digest('base64url');
  for(let i=0;i<2;i++) {
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({reportId:'Lake Grove::test'})});
    assert.equal(response.status,409);
    const saved=JSON.parse(fs.readFileSync(path.join(tmp,'reports.json'),'utf8'))[0];
    assert.equal(saved.items[0].posInventoryPostedUnits,8);
    assert.equal(saved.posInventoryResults[0].adjustmentId,'gid://shopify/InventoryAdjustmentGroup/123');
    assert.equal(saved.hasErrors,true);
  }
  assert.equal(calls,2);
});
