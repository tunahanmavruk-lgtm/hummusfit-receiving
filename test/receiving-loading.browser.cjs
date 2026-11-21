// Isolated fixtures only: stalled third-party/scanner downloads never reach production.
// Run with NODE_PATH pointing at the bundled Playwright installation.
const {chromium,webkit}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../public');
async function run(engine,name){
  const browser=await engine.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  const page=await context.newPage(),release=[],errors=[];let posts=0,stalled=0;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),p=url.pathname;
    if(request.method()!=='GET'){posts++;return route.abort();}
    if(url.hostname!=='receiving.test'||p.includes('html5-qrcode')){
      stalled++;await new Promise(resolve=>release.push(resolve));
      return route.abort().catch(()=>{});
    }
    if(p.startsWith('/receiving/'))return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'receiving.html'),'utf8')});
    if(p==='/api/expected/Holbrook')return route.fulfill({json:{orderId:'gid://shopify/Order/100',orderName:'#100',deliveryDate:'2026-11-21',crateCount:1,items:[{sku:'TEST',title:'Fixture item',expectedQty:2,pickedQty:2,status:'picked'}]}});
    if(p==='/api/receiving-receipt/Holbrook')return route.fulfill({json:{ok:true,report:null}});
    if(p==='/api/eta/Holbrook')return route.fulfill({json:{started:false}});
    const file=path.join(root,p);
    if(p.endsWith('.js')&&fs.existsSync(file))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(file)});
    if(p.endsWith('.css')&&fs.existsSync(file))return route.fulfill({contentType:'text/css',body:fs.readFileSync(file)});
    return route.fulfill({status:404,body:''});
  });
  try{
    await page.goto('http://receiving.test/receiving/Holbrook?access=test-only',{waitUntil:'commit'});
    await page.locator('#receivedByInput').waitFor({timeout:3000});
    assert.match(await page.locator('#dateOrderRow').innerText(),/#100/);
    await page.locator('#receivedByInput').fill('Local UI verification');
    await page.locator('[data-confirm-key="TEST"]').click();
    assert.equal(await page.locator('[data-manual-key="TEST"]').textContent(),'2 / 2');
    assert.ok(stalled>0,'fixture holds optional downloads open');
    assert.deepEqual(errors,[]);
    assert.equal(posts,0);
    console.log(name+': receiving loads and counts remain usable while optional downloads stall');
  }finally{
    for(const resolve of release)resolve();
    await context.close();await browser.close();
  }
}
(async()=>{await run(chromium,'Chromium');await run(webkit,'WebKit');})().catch(e=>{console.error(e);process.exitCode=1;});
