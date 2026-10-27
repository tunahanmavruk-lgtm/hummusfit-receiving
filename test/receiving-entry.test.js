const test = require('node:test');
const assert = require('node:assert/strict');
const {receivingDay, freshReceivingPath, currentReceivingEntry} = require('../receiving-entry');

test('the same printed QR renews on the next New York day, including daylight saving time', () => {
  for (const [before, after, previousDay, nextDay] of [
    ['2026-10-28T03:59:59Z','2026-10-28T04:00:00Z','2026-10-27','2026-10-28'],
    ['2026-11-03T04:59:59Z','2026-11-03T05:00:00Z','2026-11-02','2026-11-03']
  ]) {
    const first = new URL(freshReceivingPath('Lake Grove','test-only',new Date(before)), 'http://receiving.test');
    const query = Object.fromEntries(first.searchParams);
    assert.equal(receivingDay(new Date(before)), previousDay);
    assert.equal(currentReceivingEntry(query,new Date(before)), true);
    assert.equal(currentReceivingEntry(query,new Date(after)), false);
    const next = new URL(freshReceivingPath('Lake Grove','test-only',new Date(after)), first);
    assert.equal(next.pathname,first.pathname);
    assert.equal(next.searchParams.get('day'),nextDay);
    assert.notEqual(next.searchParams.get('visit'),query.visit);
    assert.equal(currentReceivingEntry(Object.fromEntries(next.searchParams),new Date(after)),true);
  }
});

test('legacy or malformed entry markers must take the fresh-entry redirect', () => {
  for (const query of [{}, {visit:'old'}, {entry:'1',day:receivingDay(),visit:'old'}]) {
    assert.equal(currentReceivingEntry(query),false);
  }
});
