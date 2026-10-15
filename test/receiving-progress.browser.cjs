// Isolated browser tests: every request is intercepted; no production writes.
// Run with NODE_PATH pointing at the bundled Playwright installation.
const {chromium,webkit}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const expected={orderId:'gid://shopify/Order/100',orderName:'#100',pickedBy:'Test',crateCount:1,items:[
  {sku:'WRAP',title:'Crispy Chicken Wrap',expectedQty:2,pickedQty:2,status:'picked'},
  {sku:'BOWL',title:'Zeus Bowl',expectedQty:1,pickedQty:1,status:'picked'}]};
async function fixture(browser,{failStorage=false,conflict=false}={}){
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  const errors=[],posts=[];let report=null,first=true;
  page.on('pageerror',e=>errors.push(e.message));
  if(failStorage)await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('Storage is full');};});
  await page.clock.install();
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url()),p=u.pathname;
    if(u.hostname!=='receiving.test')return route.abort();
    if(p.startsWith('/receiving/'))return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'public/receiving.html'),'utf8')});
    if(p==='/api/expected/Holbrook')return route.fulfill({json:expected});
    if(p==='/api/eta/Holbrook')return route.fulfill({json:{delivered:true,deliveredAt:'2026-10-14T13:00:00Z'}});
    if(p==='/api/receiving-receipt/Holbrook')return route.fulfill({json:{ok:true,report}});
    if(p==='/api/lookup-received-barcode')return route.fulfill({json:{status:'matched',title:'Extra meal',sku:'EXTRA'}});
    if(p==='/api/submit-receiving-check'){
      const body=route.request().postDataJSON();posts.push(body);
      if(conflict)return route.fulfill({status:409,json:{code:'receipt_conflict',error:'A different receipt already exists; contact logistics.'}});
      report={id:'Holbrook::test-receipt',store:'Holbrook',orderId:expected.orderId,hasErrors:true,errorPercent:50,
        inventoryReconciliation:{status:'corrected',label:'Shopify verified',detail:'Test proof'},automation:{status:'complete'}};
      if(first){first=false;return route.abort('failed');} // server saved; acknowledgment lost
      return route.fulfill({json:{ok:true,replayed:true,report}});
    }
    const file=path.join(root,'public',p);
    if(p.endsWith('.js')&&fs.existsSync(file))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(file,'utf8')});
    return route.fulfill({status:404,body:''});
  });
  await page.goto('http://receiving.test/receiving/Holbrook?access=test-only');
  await page.locator('#receivedByInput').waitFor();
  return {page,context,posts,errors};
}
async function counts(page){
  await page.locator('#receivedByInput').fill('Receiving Test');
  page.once('dialog',d=>d.accept('0'));
  await page.locator('[data-manual-key="WRAP"]').click();
  await page.locator('[data-confirm-key="BOWL"]').click();
}
async function run(engine,name){
  const browser=await engine.launch({headless:true});
  try {
    const f=await fixture(browser),{page}=f;
    await counts(page);
    await page.locator('#reportExtraBtn').click();
    page.once('dialog',d=>d.accept('2'));
    await page.locator('#handheldBarcode').fill('123456789012');await page.locator('#handheldSubmit').click();
    await page.getByText('Extra meal',{exact:false}).first().waitFor();
    await page.reload();await page.locator('#receivedByInput').waitFor();
    assert.equal(await page.locator('#receivedByInput').inputValue(),'Receiving Test');
    assert.equal(await page.locator('[data-manual-key="WRAP"]').textContent(),'0 / 2');
    assert.match(await page.locator('[data-confirm-key="WRAP"]').getAttribute('class'),/done/);
    assert.match(await page.locator('main').textContent(),/Extra meal/);
    await page.locator('#finishBtn').click();await page.locator('#confirmSubmitBtn').click();
    await page.getByText('Connection interrupted or confirmation unavailable.',{exact:false}).waitFor();
    assert.equal(f.posts.length,1);assert.equal(await page.locator('[data-manual-key="WRAP"]').isDisabled(),true);
    await page.reload();await page.locator('#retrySubmitBtn').waitFor();await page.locator('#retrySubmitBtn').click();
    await page.getByText('Receiving report saved.',{exact:false}).waitFor();
    assert.equal(f.posts.length,2);assert.deepEqual(f.posts[0],f.posts[1]);
    assert.equal(f.posts[1].scannedCounts.WRAP,0);assert.equal(f.posts[1].extraScans['123456789012'],2);
    await page.clock.fastForward(16000);assert.equal(await page.locator('#finishBtn').count(),0);
    await page.reload();await page.getByText('Receiving report saved.',{exact:false}).waitFor();
    assert.equal(f.posts.length,2);assert.deepEqual(f.errors,[]);await f.context.close();
    const quota=await fixture(browser,{failStorage:true});await counts(quota.page);await quota.page.locator('#finishBtn').click();
    assert.equal(quota.posts.length,0);assert.match(await quota.page.locator('main').textContent(),/Storage is full/);await quota.context.close();
    const conflict=await fixture(browser,{conflict:true});await counts(conflict.page);await conflict.page.locator('#finishBtn').click();await conflict.page.locator('#confirmSubmitBtn').click();
    await conflict.page.getByText('A different receipt already exists; contact logistics.').waitFor();
    assert.equal(await conflict.page.locator('[data-manual-key="WRAP"]').isDisabled(),true);
    assert.equal(await conflict.page.locator('#retrySubmitBtn').count(),0);assert.equal(conflict.posts.length,1);await conflict.context.close();
    console.log(name+': refresh, zero counts, extra barcodes, lost response, frozen retry, same payload, completed screen, storage failure and conflict passed');
  } finally {await browser.close();}
}
(async()=>{await run(chromium,'Chromium');await run(webkit,'WebKit');})().catch(e=>{console.error(e);process.exitCode=1;});
