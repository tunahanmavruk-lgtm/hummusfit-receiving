// Verified against Shopify's active location IDs on 2026-10-17.
const LOCATIONS = Object.freeze({
  Bellmore:'103133315319', 'Deer Park':'66819653879', Islip:'103133413623',
  Farmingdale:'103133479159', Holbrook:'66819490039', Huntington:'103133511927',
  'Island Park':'103133348087', 'Lake Grove':'97226490103', Lindenhurst:'69550473463',
  Lynbrook:'97226588407', 'Miller Place':'105516073207', Ronkonkoma:'66352283895',
  Selden:'66819555575', Woodbury:'97226555639',
});
// All 13 legacy writers removed and all 14 direct callbacks verified against
// the official active Flow export on 2026-10-17. Huntington's original key and
// cutover remain unchanged; historical receipts are never replayed.
const PARTIAL_FULFILLMENT_STORES = Object.freeze(Object.keys(LOCATIONS));
const STORE_CUTOVER = '2026-10-17T13:26:05Z';
function storePolicy(store) {
  if(!Object.hasOwn(LOCATIONS,store)) throw Error('Store is outside the 14 POS locations');
  return {store,locationId:'gid://shopify/Location/'+LOCATIONS[store],
    cutover:Date.parse(store==='Huntington'?'2026-10-16T21:40:00Z':STORE_CUTOVER)};
}
function orderPolicy(order) {
  const tags=[...(order?.tags||[]),...(order?.customer?.tags||[])].map(t=>String(t).trim().toLowerCase());
  const destinations=[...new Set(tags.filter(t=>t.startsWith('hummus fit ')&&t!=='hummus fit store'))];
  if(destinations.length!==1) throw Error('Exactly one store destination is required');
  const store=Object.keys(LOCATIONS).find(s=>destinations[0]==='hummus fit '+s.toLowerCase() || s==='Islip'&&destinations[0]==='hummus fit east islip');
  return storePolicy(store);
}
function usesSafeCredits(order) {
  try {const policy=orderPolicy(order);return PARTIAL_FULFILLMENT_STORES.includes(policy.store) && !!order.fulfillments?.length && order.fulfillments.every(f=>Date.parse(f.createdAt)>=policy.cutover);} catch {return false;}
}
module.exports={LOCATIONS,PARTIAL_FULFILLMENT_STORES,STORE_CUTOVER,storePolicy,orderPolicy,usesSafeCredits};
