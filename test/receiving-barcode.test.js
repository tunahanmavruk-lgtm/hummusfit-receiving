const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { matches, expectedItem, confirmedTotal } = require('../public/receiving-barcode');

test('confirmed wrong-item total replaces a count only when explicit and valid',()=>{
  assert.equal(confirmedTotal('0'),0);assert.equal(confirmedTotal(' 12 '),12);
  for(const value of [null,undefined,'','abc','-1','1.5','1001'])assert.equal(confirmedTotal(value),null);
});

test('receiving accepts exact case aliases and UPC/EAN representations', () => {
  const items = [{ title:'Retail case', sku:'CASE-1', scanCodes:['CASE-1','850084224096'] }];
  assert.equal(expectedItem(items, '850084224096'), items[0]);
  assert.equal(expectedItem(items, '0850084224096'), items[0]);
  assert.equal(matches('85008422409', ['850084224096']), true);
});

test('receiving never guesses when the same code maps to more than one order line', () => {
  const items = [{ sku:'A', scanCodes:['123456789012'] }, { sku:'B', scanCodes:['123456789012'] }];
  assert.equal(expectedItem(items, '123456789012'), null);
  assert.equal(expectedItem(items, 'no-match'), null);
});

test('barcode identity is read-only and unknown extras remain review-only', () => {
  const receiving = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../public/receiving.html'), 'utf8');
  assert.match(receiving, /app\.post\("\/api\/lookup-received-barcode", requireStoreAccess/);
  assert.match(receiving, /if \(!POS_STORES\.has\(store\)/);
  assert.match(ui, /inventory review pending/);
  assert.match(ui, /extraDetails: extraDetails/);
});
