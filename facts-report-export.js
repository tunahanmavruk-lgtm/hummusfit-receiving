const {createHash}=require('node:crypto');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const fingerprint=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const STORES = new Set(['Bellmore','Deer Park','Islip','Farmingdale','Holbrook','Huntington','Island Park','Lake Grove','Lindenhurst','Lynbrook','Miller Place','Ronkonkoma','Selden','Woodbury']);
const fail = message => { throw new Error(message); };
function selector(value) {
  if (!value || !STORES.has(value.store) || !['receiving_report','line_receipt'].includes(value.kind) ||
      typeof value.id !== 'string' || !value.id.trim() || value.id.length > 250) fail('Exact supported report/store required');
  return {store:value.store,kind:value.kind,id:value.id};
}
const nullable = value => value ?? null;
function project(record, kind) {
  return {id:record.id,store:record.store,kind,orderId:record.orderId,orderName:nullable(record.orderName),
    submittedAt:nullable(record.submittedAt),supersededBy:nullable(record.supersededBy),
    status:kind === 'line_receipt' ? record.status : record.inventoryReconciliation?.status ?? record.automation?.status ?? 'unknown',
    lines:kind === 'line_receipt' ? (record.lines || []).map((line,i)=>({lineId:`line:${i}`,sku:nullable(line.sku),title:null,
      received:nullable(line.receivedCases),unit:'cases',ordered:null,picked:null,unitsPerCase:null,category:'retail_essentials'})) :
      [...(record.items || []).map((line,i)=>({lineId:`item:${i}`,sku:nullable(line.sku),title:nullable(line.title),
        received:nullable(line.actuallyReceived),ordered:nullable(line.orderedQty),picked:nullable(line.expectedFromPicking),
        unitsPerCase:nullable(line.unitsPerCase),category:nullable(line.receivingCategory),unit:line.receivingCategory==='retail_essentials'?'cases':'units'})),
      ...(record.extraItems || []).map((line,i)=>({lineId:`extra:${i}`,sku:line.catalogVerified===true?nullable(line.sku):null,
        title:line.catalogVerified===true?nullable(line.title):null,code:nullable(line.code),received:nullable(line.qty),unit:null,
        ordered:null,picked:null,unitsPerCase:null,category:null}))],
    recordedPostingReferences:(record.inventoryCorrections || record.results || []).map(entry=>({
      adjustmentId:nullable(entry.adjustmentId),caseCreditAdjustmentId:nullable(entry.caseCreditAdjustmentId),
      sku:nullable(entry.sku),delta:nullable(entry.delta),status:nullable(entry.status)})),
    inventoryAuthorization:false,correctionRetriesAllowed:false,liveShopifyProof:false,
    limitations:['Recorded report data only; posting references are not fresh Shopify proof.','Missing fields and omitted lines remain unknown.']};
}

// Source-owned callbacks, never caller-supplied paths. No server import or worker startup.
function createReportSource({readReports,readLineReceipts=null,now=Date.now}) {
  async function records(kind) {
    const data = kind==='receiving_report' ? await readReports() : readLineReceipts ? await readLineReceipts() : fail('Line receipt source is not connected');
    const rows = kind==='receiving_report' ? data : Object.values(data);
    if (!Array.isArray(rows) || rows.some(row=>!row || typeof row!=='object')) fail('Report source unavailable');
    return rows;
  }
  return {
    async read(value) {
      const key=selector(value),rows=(await records(key.kind)).filter(row=>row.store===key.store&&row.id===key.id);
      if(rows.length!==1 || typeof rows[0].orderId!=='string' || !rows[0].orderId.split(',').every(id=>/^gid:\/\/shopify\/Order\/\d+$/.test(id.trim()))) fail('Unique exact source report required');
      const record=rows[0];
      // Hash the complete source record, including amendments/manual proof omitted from projection.
      return {...project(record,key.kind),revision:fingerprint(record),observedAt:new Date(now()).toISOString()};
    },
    async list(store) {
      if(!STORES.has(store)) fail('Supported store required');
      const output=[];
      for(const kind of ['receiving_report',...(readLineReceipts?['line_receipt']:[])]) {
        for(const row of (await records(kind)).filter(row=>row.store===store)) output.push({kind,id:row.id,store,orderName:nullable(row.orderName),submittedAt:nullable(row.submittedAt),supersededBy:nullable(row.supersededBy)});
      }
      return {sources:output,lineReceiptCoverage:Boolean(readLineReceipts),inventoryAuthorization:false};
    }
  };
}


function registerFactsReportExport(app,{readReports,readLineReceipts=null,verifyToken}) {
  const source=createReportSource({readReports,readLineReceipts});
  app.get('/api/jerry/report-source',async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try {
      const token=String(req.get('authorization')||'').replace(/^Bearer /,'');
      const p=verifyToken(token,'jerry.reports.read');
      if(!p || p.sub!=='logistics-facts-review' || p.aud!=='jerry-report-source' || p.scope?.length!==1 ||
        p.scope[0]!=='jerry.reports.read' || p.exp>Math.floor(Date.now()/1000)+120 || !p.stores?.includes(req.query.store))
        return res.status(403).json({error:'Dedicated read-only report access required'});
      return res.json(req.query.id?await source.read(req.query):await source.list(req.query.store));
    }catch{return res.status(503).json({error:'Report source unavailable'});}
  });
}
module.exports={registerFactsReportExport,createReportSource};
