// Preserve the saved combined receipt; resolve only exact Shopify order IDs.
function receiptOrders(report) {
  const ids=String(report?.orderId||'').split(',').map(s=>s.trim());
  const names=String(report?.orderName||'').split(',').map(s=>s.trim());
  if(!ids.length || ids.length>20 || ids.length!==names.length ||
    new Set(ids).size!==ids.length || new Set(names).size!==names.length ||
    ids.some(id=>!/^gid:\/\/shopify\/Order\/\d+$/.test(id)) || names.some(n=>!n)) {
    throw new Error('Exact unique receipt order IDs and names required');
  }
  return ids.map((id,index)=>({id,name:names[index]}));
}
function receiptForOrder(report,id) {
  const order=receiptOrders(report).find(o=>o.id===id);
  if(!order) throw new Error('Correction order is not part of this saved receipt');
  return {...report,orderId:order.id,orderName:order.name};
}
module.exports={receiptOrders,receiptForOrder};
