const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouteBoardReadCache } = require('../route-board-read-cache');

test('coalesces concurrent reads per store and expires the display cache', async () => {
  let time = 1000;
  let calls = 0;
  const read = createRouteBoardReadCache(async () => {
    calls++;
    return { status: 200, ok: true, text: async () => '{"orderId":"one"}' };
  }, () => time);
  const results = await Promise.all(Array.from({ length: 20 }, () => read('picked:Lake Grove', 'https://route/picked', {}, 30000)));
  assert.equal(calls, 1);
  assert.ok(results.every(result => JSON.parse(result.text).orderId === 'one'));
  await read('picked:Lake Grove', 'https://route/picked', {}, 30000);
  assert.equal(calls, 1);
  time += 30001;
  await read('picked:Lake Grove', 'https://route/picked', {}, 30000);
  assert.equal(calls, 2);
});

test('does not cache rate limits or invalid responses', async () => {
  let calls = 0;
  const read = createRouteBoardReadCache(async () => {
    calls++;
    return calls === 1
      ? { status: 429, ok: false, text: async () => 'rate limited' }
      : { status: 200, ok: true, text: async () => '{"orderId":"recovered"}' };
  });
  assert.equal((await read('picked:Lake Grove', 'https://route/picked')).status, 429);
  assert.equal((await read('picked:Lake Grove', 'https://route/picked')).status, 200);
  assert.equal(calls, 2);
});
