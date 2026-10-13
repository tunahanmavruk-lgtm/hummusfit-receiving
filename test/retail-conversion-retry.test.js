const test = require('node:test');
const assert = require('node:assert/strict');
const { retryRetailLines, mergeRetailPostings } = require('../retail-conversion-retry');
const { reconciliationStatus } = require('../reconciliation-status');

function report() {
  return { id: 'Lake Grove::1', store: 'Lake Grove', orderId: 'gid://shopify/Order/123',
    submittedAt: '2026-10-12T13:00:00Z', hasErrors: true, extraItems: [],
    items: [
      { sku: 'FOOD', receivingCategory: 'food', orderedQty: 7, expectedFromPicking: 0, actuallyReceived: 0, diff: 0, orderDiff: -7 },
      { sku: 'SOUR', receivingCategory: 'retail_essentials', orderedQty: 1, expectedFromPicking: 1, actuallyReceived: 1, diff: 0, orderDiff: 0 },
      { sku: 'COKE', receivingCategory: 'retail_essentials', orderedQty: 1, expectedFromPicking: 1, actuallyReceived: 1, diff: 0, orderDiff: 0 },
    ] };
}
const proof = { sku: 'SOUR', status: 'posted', units: 8, adjustmentId: 'gid://shopify/InventoryAdjustmentGroup/123' };

test('unrelated food shortages do not block exact retail receipts', () => {
  assert.equal(retryRetailLines(report()).length, 2);
});

test('zero-picked, zero-received missing cases do not block verified received cases',()=>{
  const r=report();r.items[1].actuallyReceived=0;r.items[1].expectedFromPicking=0;
  assert.equal(retryRetailLines(r).length,2);
});

test('retail differences, extras, pre-cutover reports and B2B remain blocked', () => {
  for (const change of [
    r => { r.items[1].actuallyReceived = 0; },
    r => { r.items[1].actuallyReceived = 2; },
    r => { r.items[1].sku = ''; },
    r => { r.items.push({...r.items[1]}); },
    r => { r.extraItems.push({code:'UNKNOWN',qty:1}); },
    r => { r.store = 'Brookfield'; },
    r => { r.submittedAt = '2026-10-05T13:00:00Z'; },
    r => { r.submittedAt = 'invalid'; },
  ]) {
    const r = report(); change(r); assert.throws(() => retryRetailLines(r));
  }
});

test('partial conversion proof is saved while food and unmapped cases remain review', () => {
  const r = report(), originalCounts = r.items.map(i => i.actuallyReceived);
  const all = mergeRetailPostings(r, retryRetailLines(r), {ok:false, results:[proof,
    {sku:'COKE',status:'requires_mapping',error:'Missing approved mapping'}]});
  assert.equal(all, false);
  assert.equal(r.items[1].posInventoryPostedUnits, 8);
  assert.equal(r.items[2].posInventoryPostedUnits, undefined);
  assert.deepEqual(r.items.map(i => i.actuallyReceived), originalCounts);
  assert.equal(r.hasErrors, true);
  assert.equal(reconciliationStatus(r).status, 'needs_review');
  assert.equal(reconciliationStatus(r).postedUnits, 8);
});

test('retry is ledger-backed and does not erase prior proof after an upstream failure', () => {
  const r = report();
  mergeRetailPostings(r, retryRetailLines(r), {results:[proof]});
  mergeRetailPostings(r, retryRetailLines(r), {error:'Transient timeout'});
  assert.deepEqual(r.posInventoryResults[0], proof);
  assert.equal(r.items[1].posInventoryPostedUnits, 8);
});

test('a posted label without an adjustment group or with duplicate SKU results is not proof', () => {
  for (const results of [[{...proof,adjustmentId:null}], [proof, proof], [{...proof,units:0}]]) {
    const r = report();
    mergeRetailPostings(r, retryRetailLines(r), {results});
    assert.equal(r.items[1].posInventoryPostedUnits, undefined);
    assert.equal(r.posInventoryResults[0].status, 'requires_review');
  }
});

test('complete retail conversion still does not mark an unrelated food discrepancy solved', () => {
  const r = report();
  assert.equal(mergeRetailPostings(r, retryRetailLines(r), {results:[proof,
    {...proof,sku:'COKE',units:24,adjustmentId:'gid://shopify/InventoryAdjustmentGroup/124'}]}), true);
  assert.equal(reconciliationStatus(r).status, 'needs_review');
  assert.equal(r.hasErrors, true);
});
