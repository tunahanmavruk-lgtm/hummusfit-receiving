const test=require('node:test'),assert=require('node:assert/strict');
const {registerFactsReportExport,createReportSource}=require('../facts-report-export');
const record={id:'synthetic',store:'Lynbrook',orderId:'gid://shopify/Order/123',items:[{sku:'TEST-CS',actuallyReceived:1,receivingCategory:'retail_essentials'}],extraItems:[{code:'unknown',qty:4}],privateContact:'private'};
test('export is GET only, rejects broad/expired/wrong audience access before reading',async()=>{
 let handler,reads=0,p=null;registerFactsReportExport({get(path,fn){assert.equal(path,'/api/jerry/report-source');handler=fn;}},{readReports:()=>{reads++;return [record];},verifyToken:(_token,scope)=>{assert.equal(scope,'jerry.reports.read');return p;}});
 const run=async(store='Lynbrook')=>{let status=200,result;const res={set(){},status(value){status=value;return this;},json(value){result=value;return {status,result};}};return handler({query:{store},get:()=>''},res);};
 assert.equal((await run()).status,403);
 p={sub:'logistics-facts-review',aud:'jerry-report-source',scope:['reports.manage'],stores:['Lynbrook'],exp:Math.floor(Date.now()/1000)+60};
 assert.equal((await run()).status,403);assert.equal(reads,0);
 p.scope=['jerry.reports.read'];assert.equal((await run()).status,200);assert.equal(reads,1);
 assert.equal((await run('Out-of-State')).status,403);
 p.exp+=600;assert.equal((await run()).status,403);
});
test('source never mutates reports or supplies unidentified product identity',async()=>{
 const before=JSON.stringify(record),source=createReportSource({readReports:()=>[record]});
 const snapshot=await source.read({store:'Lynbrook',kind:'receiving_report',id:'synthetic'});
 assert.equal(snapshot.lines[1].sku,null);assert.equal(snapshot.inventoryAuthorization,false);
 assert.equal(snapshot.correctionRetriesAllowed,false);assert.equal(snapshot.liveShopifyProof,false);
 assert.equal(JSON.stringify(snapshot).includes('privateContact'),false);assert.equal(JSON.stringify(record),before);
 await assert.rejects(source.read({store:'Holbrook',kind:'receiving_report',id:'synthetic'}));
});
