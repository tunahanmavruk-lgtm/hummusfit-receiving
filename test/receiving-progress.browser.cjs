// Isolated browser tests: every request is intercepted; no production writes.
// Run with NODE_PATH pointing at the bundled Playwright installation.
const {chromium,webkit}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const expected={orderId:'gid://shopify/Order/100',orderName:'#100',pickedBy:'Test',crateCount:1,items:[
  {sku:'WRAP',title:'Crispy Chicken Wrap',expectedQty:2,pickedQty:2,status:'picked'},
  {sku:'BOWL',title:'Zeus Bowl',scanCodes:['123456789099'],expectedQty:1,pickedQty:1,status:'picked'}]};
async function fixture(browser,{failStorage=false,conflict=false,initialUnavailable=false}={}){
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}}),page=await context.newPage();
  const errors=[],posts=[];let report=null,first=true,catalogStatus='matched',currentExpected=structuredClone(expected),expectedStatus=initialUnavailable?409:200;
  page.on('pageerror',e=>errors.push(e.message));
  if(failStorage)await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('Storage is full');};});
  await page.clock.install();
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url()),p=u.pathname;
    if(u.hostname!=='receiving.test')return route.abort();
    if(p.startsWith('/receiving/'))return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'public/receiving.html'),'utf8')});
    if(p==='/api/expected/Holbrook')return route.fulfill({status:expectedStatus,json:expectedStatus===200?currentExpected:{code:'current_delivery_unavailable',error:'Today’s delivery is not yet verified for receiving.'}});
    if(p==='/api/eta/Holbrook')return route.fulfill({json:{delivered:true,deliveredAt:'2026-10-14T13:00:00Z'}});
    if(p==='/api/receiving-receipt/Holbrook')return route.fulfill({json:{ok:true,report:report&&report.orderId===u.searchParams.get('orderId')?report:null}});
    if(p==='/api/lookup-received-barcode')return route.fulfill({json:{status:catalogStatus,title:'Extra meal',sku:'EXTRA'}});
    if(p==='/api/submit-receiving-check'){
      const body=route.request().postDataJSON();posts.push(body);
      if(conflict)return route.fulfill({status:409,json:{code:'receipt_conflict',error:'A different receipt already exists; contact logistics.'}});
      report={id:'Holbrook::test-receipt',store:'Holbrook',orderId:expected.orderId,hasErrors:true,errorPercent:50,
        inventoryReconciliation:{status:'corrected',label:'Shopify verified',detail:'Test proof'},automation:{status:'complete'}};
      if(first){first=false;return route.abort('failed');} // server saved; acknowledgment lost
      return route.fulfill({json:{ok:true,replayed:true,report}});
    }
    const file=path.join(root,'public',p);
    if(p.endsWith('.css')&&fs.existsSync(file))return route.fulfill({contentType:'text/css',body:fs.readFileSync(file,'utf8')});
    if(p.endsWith('.png')&&fs.existsSync(file))return route.fulfill({contentType:'image/png',body:fs.readFileSync(file)});
    if(p.endsWith('.js')&&fs.existsSync(file))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(file,'utf8')});
    return route.fulfill({status:404,body:''});
  });
  await page.goto('http://receiving.test/receiving/Holbrook?access=test-only');
  if(initialUnavailable)await page.getByText('Today’s delivery is not yet verified for receiving.',{exact:false}).waitFor();
  else await page.locator('#receivedByInput').waitFor();
  return {page,context,posts,errors,setCatalogStatus(value){catalogStatus=value;},setDelivery(value){currentExpected=value;expectedStatus=200;}};
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
    await page.locator('#deliverySearch').fill('chicken');
    assert.equal(await page.locator('[data-item-search]:visible').count(),1);
    assert.match(await page.locator('#deliverySearchSummary').textContent(),/Showing 1 of 2/);
    await page.locator('[data-confirm-key="WRAP"]').click();
    assert.equal(await page.locator('#deliverySearch').inputValue(),'chicken');
    assert.equal(await page.locator('#finishBtn').isDisabled(),true);
    await page.locator('#deliverySearch').fill('123456789099');
    assert.equal(await page.locator('[data-item-search]:visible').count(),1);
    assert.equal(await page.locator('[data-manual-key="BOWL"]').isVisible(),true);
    await page.locator('#deliverySearch').fill('no-such-item');assert.equal(await page.locator('#deliverySearchEmpty').isVisible(),true);
    await page.locator('#clearDeliverySearch').click();assert.equal(await page.locator('[data-item-search]:visible').count(),2);
    await page.locator('#deliverySearch').fill('ZEUS bowl');assert.equal(await page.locator('[data-item-search]:visible').count(),1);
    await page.clock.fastForward(16000);assert.equal(await page.locator('#deliverySearch').inputValue(),'ZEUS bowl');
    await page.locator('#clearDeliverySearch').click();
    for(const invalid of ['1.5','2 apples','1e2','-1','']){
      let prompt=true;const listener=async d=>{if(prompt){prompt=false;await d.accept(invalid);}else await d.accept();};
      page.on('dialog',listener);await page.locator('[data-manual-key="WRAP"]').click();page.off('dialog',listener);
      assert.equal(await page.locator('[data-manual-key="WRAP"]').textContent(),'2 / 2');
    }
    await counts(page);
    await page.locator('#reportExtraBtn').click();
    page.once('dialog',d=>d.accept('2'));
    await page.locator('#handheldBarcode').fill('123456789012');await page.locator('#handheldSubmit').click();
    await page.getByText('Extra meal',{exact:false}).first().waitFor();
    await page.reload();await page.locator('#receivedByInput').waitFor();
    assert.equal(await page.locator('#receivedByInput').inputValue(),'Receiving Test');
    assert.equal(await page.locator('[data-manual-key="WRAP"]').textContent(),'0 / 2');
    assert.doesNotMatch(await page.locator('[data-confirm-key="WRAP"]').getAttribute('class'),/done/);
    assert.match(await page.locator('[data-zero-key="WRAP"]').getAttribute('class'),/done/);
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
    assert.equal(await page.evaluate(()=>window.HFReceivingProgress.create(localStorage,'Holbrook').list().length),0);
    assert.equal(f.posts.length,2);assert.deepEqual(f.errors,[]);
    const nextDelivery={...structuredClone(expected),orderId:'gid://shopify/Order/101',orderName:'#101',deliveryDate:'2026-10-27'};
    f.setDelivery(nextDelivery);await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
    await page.locator('#receivedByInput').waitFor();assert.match(await page.locator('#dateOrderRow').textContent(),/#101/);
    assert.equal(await page.locator('#receivedByInput').inputValue(),'');assert.equal(f.posts.length,2,'a new delivery never resubmits the saved receipt');
    await f.context.close();
    const active=await fixture(browser);await counts(active.page);active.setDelivery(nextDelivery);
    await active.page.clock.fastForward(31000);await active.page.getByRole('button',{name:'Open current delivery'}).waitFor();
    assert.equal(await active.page.locator('[data-manual-key="WRAP"]').textContent(),'0 / 2');assert.equal(active.posts.length,0);
    await active.page.getByRole('button',{name:'Open current delivery'}).click();await active.page.locator('#receivedByInput').waitFor();
    assert.match(await active.page.locator('#dateOrderRow').textContent(),/#101/);
    assert.equal(await active.page.evaluate(()=>window.HFReceivingProgress.create(localStorage,'Holbrook').list().find(d=>d.expected.orderId.endsWith('/100')).scannedCounts.WRAP),0);
    assert.deepEqual(active.errors,[]);await active.context.close();
    const waiting=await fixture(browser,{initialUnavailable:true});assert.equal(await waiting.page.locator('#receivedByInput').count(),0);
    waiting.setDelivery(nextDelivery);await waiting.page.clock.fastForward(31000);await waiting.page.locator('#receivedByInput').waitFor();
    assert.match(await waiting.page.locator('#dateOrderRow').textContent(),/Delivery: Tuesday, October 27/);assert.equal(waiting.posts.length,0);assert.deepEqual(waiting.errors,[]);await waiting.context.close();
    const zero=await fixture(browser);
    await zero.page.locator('#receivedByInput').fill('Zero Count Test');
    assert.equal(await zero.page.locator('#finishBtn').isDisabled(),true);
    await zero.page.locator('[data-zero-key="WRAP"]').click();
    assert.equal(await zero.page.locator('[data-manual-key="WRAP"]').textContent(),'0 / 2');
    assert.match(await zero.page.locator('[data-zero-key="WRAP"]').textContent(),/0 received/);
    assert.doesNotMatch(await zero.page.locator('[data-confirm-key="WRAP"]').getAttribute('class'),/done/);
    assert.equal(await zero.page.locator('#finishBtn').isDisabled(),true);
    await zero.page.reload();await zero.page.locator('#receivedByInput').waitFor();
    assert.match(await zero.page.locator('[data-zero-key="WRAP"]').textContent(),/0 received/);
    await zero.page.locator('[data-confirm-key="WRAP"]').click();
    assert.equal(await zero.page.locator('[data-manual-key="WRAP"]').textContent(),'2 / 2');
    assert.equal(await zero.page.locator('[data-zero-key="WRAP"]').count(),0);
    zero.page.once('dialog',d=>d.accept('0'));
    await zero.page.locator('[data-manual-key="WRAP"]').click();
    await zero.page.reload();await zero.page.locator('#receivedByInput').waitFor();
    assert.match(await zero.page.locator('[data-zero-key="WRAP"]').textContent(),/0 received/);
    await zero.page.locator('[data-confirm-key="BOWL"]').click();
    assert.equal(await zero.page.locator('#finishBtn').isDisabled(),false);
    await zero.page.locator('#finishBtn').click();await zero.page.locator('#confirmSubmitBtn').click();
    await zero.page.getByText('Connection interrupted or confirmation unavailable.',{exact:false}).waitFor();
    assert.equal(zero.posts.length,1);assert.equal(zero.posts[0].scannedCounts.WRAP,0);
    assert.equal(zero.posts[0].scannedCounts.BOWL,1);assert.deepEqual(zero.errors,[]);
    await zero.context.close();
    const quota=await fixture(browser,{failStorage:true});await counts(quota.page);await quota.page.locator('#finishBtn').click();
    assert.equal(quota.posts.length,0);assert.match(await quota.page.locator('main').textContent(),/Storage is full/);await quota.context.close();
    const conflict=await fixture(browser,{conflict:true});await counts(conflict.page);await conflict.page.locator('#finishBtn').click();await conflict.page.locator('#confirmSubmitBtn').click();
    await conflict.page.getByText('A different receipt already exists; contact logistics.').waitFor();
    assert.equal(await conflict.page.locator('[data-manual-key="WRAP"]').isDisabled(),true);
    assert.equal(await conflict.page.locator('#retrySubmitBtn').count(),0);assert.equal(conflict.posts.length,1);await conflict.context.close();
    const unmatched=await fixture(browser);await counts(unmatched.page);unmatched.setCatalogStatus('unmatched');
    await unmatched.page.locator('#reportExtraBtn').click();
    assert.equal(await unmatched.page.locator('#scannerManualExtraBtn').count(),0);
    await unmatched.page.locator('#handheldBarcode').fill('Chicken pesto');await unmatched.page.locator('#handheldSubmit').click();
    assert.match(await unmatched.page.locator('#scanProgressLabel').textContent(),/descriptions cannot be submitted/);
    unmatched.page.once('dialog',d=>d.accept('1'));
    await unmatched.page.locator('#handheldBarcode').fill('123456789012');await unmatched.page.locator('#handheldSubmit').click();
    await unmatched.page.getByText('Unverified — scan again or ask logistics',{exact:false}).waitFor();
    assert.equal(await unmatched.page.locator('#finishBtn').isDisabled(),true);assert.equal(unmatched.posts.length,0);
    await unmatched.page.reload();await unmatched.page.locator('#receivedByInput').waitFor();
    assert.equal(await unmatched.page.locator('#finishBtn').isDisabled(),true);
    unmatched.setCatalogStatus('matched');await unmatched.page.locator('[data-retry-extra]').click();
    await unmatched.page.getByText('Product identified',{exact:false}).waitFor();
    assert.equal(await unmatched.page.locator('#finishBtn').isDisabled(),false);assert.deepEqual(unmatched.errors,[]);
    assert.equal(await unmatched.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'phone layout must not overflow horizontally');
    await unmatched.page.setViewportSize({width:390,height:844});await unmatched.page.screenshot({path:'/tmp/hf-receiving-search-'+name.toLowerCase()+'.png',fullPage:true});
    await unmatched.context.close();
    console.log(name+': completed-page rollover, active-draft preservation, waiting-to-ready refresh, item search, hidden unresolved items, strict quantities, blocked text, unverified extras and retry, refresh, zero counts, extra barcodes, lost response, frozen retry, same payload, completed screen, storage failure and conflict passed');
  } finally {await browser.close();}
}
(async()=>{await run(chromium,'Chromium');await run(webkit,'WebKit');})().catch(e=>{console.error(e);process.exitCode=1;});
