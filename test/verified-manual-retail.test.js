const test = require('node:test');
const assert = require('node:assert/strict');
const {CASES, verifiedManualRetail, mergeManualRetail} = require('../verified-manual-retail');

function fixture(sku='SD-RASPBERRY-60G-CS8') {
  const config=CASES[sku];
  const report={id:'Farmingdale::1793991667864:931a461e-730d-4674-8431-5b74feff0d6b',
    store:'Farmingdale',orderId:'gid://shopify/Order/8145520361719',orderName:'#805371',
    submittedAt:'2026-11-06T19:01:07.864Z',extraItems:[],items:[
      {sku,receivingCategory:'retail_essentials',orderedQty:1,expectedFromPicking:1,actuallyReceived:1,unitsPerCase:0},
    ],posInventoryResults:[{sku,status:'requires_mapping'}]};
  const order={id:report.orderId,name:report.orderName,displayFulfillmentStatus:'FULFILLED',
    customer:{tags:['Hummus Fit Farmingdale']},lineItems:{nodes:[{sku,quantity:1,variant:{inventoryItem:{id:config.legacyItemId}}}],pageInfo:{hasNextPage:false}},
    fulfillments:[{status:'SUCCESS',location:{id:'gid://shopify/Location/103133642999'}}]};
  const location={id:'gid://shopify/Location/103133479159'};
  const pair=[{name:'available',delta:-1,item:{id:config.activeItemId,sku},location},
    {name:'available',delta:8,item:{id:config.unitItemId,sku:config.unitSku},location}];
  const group={id:config.groupId,createdAt:'2026-11-06T23:47:31Z',referenceDocumentUri:config.reference,
    changes:[...pair,...pair.map(c=>({...c,name:'on_hand'}))]};
  return {report,order,group,sku};
}

test('imports exact Shopify case-to-eight-unit proof once without another stock write',()=>{
  const f=fixture();const posting=verifiedManualRetail(f.report,f.sku,f.group,f.order);
  assert.equal(posting.units,8);assert.equal(posting.shopifyVerified,true);
  mergeManualRetail(f.report,posting);
  assert.equal(f.report.posInventoryWritesEnabled,true);
  assert.equal(f.report.items[0].posInventoryPostedUnits,8);
  mergeManualRetail(f.report,posting);
  assert.equal(f.report.posInventoryResults.length,1);
});

test('rejects a wrong order, store, original item, adjustment, location or quantity',()=>{
  const changes=[
    f=>f.report.store='Selden',
    f=>f.order.customer.tags.push('Hummus Fit Selden'),
    f=>f.order.lineItems.nodes[0].variant.inventoryItem.id='gid://shopify/InventoryItem/1',
    f=>f.order.fulfillments[0].location.id='gid://shopify/Location/1',
    f=>f.group.id='gid://shopify/InventoryAdjustmentGroup/1',
    f=>f.group.changes[0].location.id='gid://shopify/Location/1',
    f=>f.group.changes[1].delta=7,
    f=>f.report.items[0].actuallyReceived=0,
  ];
  for(const change of changes){const f=fixture();change(f);assert.throws(()=>verifiedManualRetail(f.report,f.sku,f.group,f.order));}
});

test('both approved flavors use separate exact inventory items and groups',()=>{
  const r=fixture(),g=fixture('SD-GREENAPPLE-60G-CS8');
  assert.notEqual(CASES[r.sku].groupId,CASES[g.sku].groupId);
  assert.equal(verifiedManualRetail(g.report,g.sku,g.group,g.order).units,8);
  assert.throws(()=>verifiedManualRetail(g.report,g.sku,r.group,g.order));
});
