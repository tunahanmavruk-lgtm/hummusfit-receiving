const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/reports.html'),'utf8');
test('manual proof display identifies original actor and does not invent an adjustment id',()=>{
 const code=html.slice(html.indexOf('  function correctionNote('),html.indexOf('  function render('));
 const ctx={esc:String,easternTime:()=> 'Oct 9, 2026 8:13 AM'};vm.createContext(ctx);vm.runInContext(code,ctx);
 const result=ctx.correctionNote({status:'corrected',resolution:'verified_existing_manual',createdBy:'Berke Kaba',delta:10});
 assert.match(result,/Existing Shopify correction by Berke Kaba/);assert.match(result,/no duplicate inventory change/);
 assert.doesNotMatch(result,/adjustment undefined|adjustment null|adjusted by Agent Hazar/);
});
test('inventory action filter includes partially corrected reports',()=>{
 assert.match(html,/\['needs_review','partially_corrected'\]\.includes\(r\.inventoryReconciliation\.status\)/);
});
