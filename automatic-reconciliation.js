const { POS_STORES } = require('./reconciliation-status');
const { verifiedCorrection,mergeVerifiedCorrection } = require('./verified-correction');
const { retryRetailLines,mergeRetailPostings,confirmedPosting } = require('./retail-conversion-retry');
const { receiptOrders,receiptForOrder } = require('./receipt-orders');
const RELEASE='receiving-auto-2026-10-13-v1';
const CUTOVER=Date.parse('2026-10-13T20:21:19Z');

function queueReport(report) {
  if(POS_STORES.has(report.store)&&Date.parse(report.submittedAt)>=CUTOVER) {
    report.automation={version:RELEASE,status:'queued',attempts:0,nextAttemptAt:Date.now(),results:[]};
  }
  return report;
}
function retryReport(report,identity,now=Date.now()) {
  if(!report||report.supersededBy||!POS_STORES.has(report.store)||
    report.automation?.version!==RELEASE||!(Date.parse(report.submittedAt)>=CUTOVER))
    throw new Error('Only an authoritative report already enrolled after the automatic cutover can be retried');
  receiptOrders(report);
  if(report.automation.status==='processing') throw new Error('This report is already processing');
  if(report.automation.status==='complete') return false;
  // Preserve all posted proofs and attempt history. The canonical order/item ledger
  // remains the only authority for inventory writes; retrying never resets it.
  Object.assign(report.automation,{status:'queued',nextAttemptAt:now,error:null,
    retryRequestedAt:new Date(now).toISOString(),retryRequestedBy:identity});
  return true;
}
function createReconciliationWorker({loadReports,saveReports,request,readProof,now=Date.now}) {
  let running=false,timer;
  function update(id,fn) {
    // Never write a whole-file snapshot captured before an awaited request.
    const all=loadReports(),report=all.find(r=>r.id===id);
    if(!report||report.supersededBy) return;
    fn(report);saveReports(all);return report;
  }
  async function process(report) {
    let retry=false;
    const results=[];
    let orderIds;
    try { orderIds=receiptOrders(report).map(o=>o.id); }
    catch(e) { update(report.id,r=>{r.automation.status='requires_review';r.automation.error=e.message;});return; }
    const other=loadReports().some(r=>r.id!==report.id&&r.store===report.store&&!r.supersededBy&&
      String(r.orderId||'').split(',').some(id=>orderIds.includes(id.trim())));
    if(other) {
      update(report.id,r=>{r.automation.status='requires_review';r.automation.error='Multiple receiving reports for this order require confirmation of the authoritative counts';});
      return;
    }
    update(report.id,r=>{r.automation.status='processing';r.automation.attempts++;r.automation.lastAttemptAt=new Date(now()).toISOString();});
    const food=(report.items||[]).some(i=>i.receivingCategory==='food'&&i.orderDiff!==0)||(report.extraItems||[]).length;
    if(food) {
      try {
        const response=await request('/api/automatic-receiving-correction',{report});
        for(const result of response.results||[]) {
          if(result.status==='posted') {
            try {
              const scoped=receiptForOrder(report,result.orderId||report.orderId);
              const proof=await readProof(result.adjustmentId,scoped.orderId,result.variantId);
              update(report.id,current=>{
                const correction=verifiedCorrection(receiptForOrder(current,scoped.orderId),result.sku,proof.node,proof.order,result.kind,proof.variant);
                correction.sourceOrderId=scoped.orderId;
                correction.orderId=current.orderId;
                mergeVerifiedCorrection(current,correction);
              });
              results.push({...result,shopifyVerified:true});
            } catch(e) { retry=true;results.push({...result,status:'retry',error:`Posted adjustment awaiting independent verification: ${e.message}`}); }
          } else { results.push(result);if(result.status==='retry'||result.status==='processing') retry=true; }
        }
        if(!Array.isArray(response.results)) throw new Error('Correction service returned no results');
      } catch(e) { retry=!e.review;results.push({status:e.review?'requires_review':'retry',error:e.message}); }
    }
    const retail=(report.items||[]).filter(i=>i.receivingCategory==='retail_essentials');
    if(retail.length) {
      try {
        // Off-order food is reconciled independently; it cannot block a complete retail receipt.
        retryRetailLines({...report,extraItems:[]});
        const latest=loadReports().find(r=>r.id===report.id);
        const complete=retail.every(i=>(latest?.posInventoryResults||[]).some(e=>confirmedPosting(i,e)));
        if(!complete) {
          const response=await request('/api/essentials-pos-receipt',{
            store:report.store,orderId:report.orderId,
            receivedCounts:Object.fromEntries(retail.map(i=>[i.sku,i.actuallyReceived])),
            receiptEvidence:{id:report.id,store:report.store,orderId:report.orderId,orderName:report.orderName,
              submittedAt:report.submittedAt,items:retail.map(({sku,orderedQty,expectedFromPicking,actuallyReceived})=>({sku,orderedQty,expectedFromPicking,actuallyReceived}))},
          });
          let done=false;
          update(report.id,r=>{done=mergeRetailPostings(r,retail,response);});
          if(!done) {
            const pending=(response.results||[]).filter(r=>!['posted','already_posted','zero_received'].includes(r.status));
            const transient=pending.length===0||pending.some(r=>['processing','retry'].includes(r.status));
            retry=retry||transient;
            results.push({kind:'retail',status:transient?'retry':'requires_review',error:response.error||pending.map(r=>r.error).filter(Boolean).join('; ')||'Retail conversion proof is incomplete'});
          }
        }
      } catch(e) { const review=e.review||/Retail cases|exact post-cutover/.test(e.message);retry=retry||!review;results.push({kind:'retail',status:review?'requires_review':'retry',error:e.message}); }
    }
    update(report.id,r=>{
      const expired=now()-Date.parse(r.submittedAt)>24*60*60*1000;
      r.automation.results=results;
      r.automation.status=retry&&!expired?'retry':results.some(x=>x.status!=='posted')?'requires_review':'complete';
      r.automation.error=expired&&retry?'Automatic retries reached 24 hours; review required':null;
      r.automation.nextAttemptAt=now()+Math.min(300000,15000*2**Math.min(r.automation.attempts,5));
      r.automation.updatedAt=new Date(now()).toISOString();
    });
  }
  async function tick() {
    if(running) return;running=true;
    try {
      for(const report of loadReports().filter(r=>!r.supersededBy&&r.automation?.version===RELEASE&&
        ['queued','retry','processing'].includes(r.automation.status)&&
        (r.automation.status==='processing'||r.automation.nextAttemptAt<=now()))) {
        try { await process(report); }
        catch(e) { update(report.id,r=>{r.automation.status='retry';r.automation.error=e.message;r.automation.nextAttemptAt=now()+60000;}); }
      }
    } finally { running=false; }
  }
  return {tick,kick:()=>setImmediate(()=>tick().catch(e=>console.error('[receiving-worker]',e.message))),
    start(){timer=setInterval(()=>tick().catch(e=>console.error('[receiving-worker]',e.message)),15000);timer.unref();this.kick();},
    stop(){clearInterval(timer);}};
}
module.exports={RELEASE,CUTOVER,queueReport,retryReport,createReconciliationWorker};
