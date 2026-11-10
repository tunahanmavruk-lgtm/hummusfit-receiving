const test = require('node:test');
const assert = require('node:assert/strict');
const { routeBoardFetch, ROUTE_BOARD_URL } = require('../route-board-fetch');

test('retries only a Railway edge rate limit through the signed bridge', async () => {
  const originalFetch = global.fetch;
  const originalBridge = process.env.ROUTE_BOARD_BRIDGE_URL;
  const originalSecret = process.env.HF_LOGISTICS_HANDOFF_SECRET;
  const calls = [];
  process.env.ROUTE_BOARD_BRIDGE_URL = 'https://logistics.test/api/receiving-bridge';
  process.env.HF_LOGISTICS_HANDOFF_SECRET = 'test-only';
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response('rate limited', { status: 429, headers: { server: 'railway-hikari' } })
      : Response.json({ orderName: '#812214' });
  };
  try {
    const response = await routeBoardFetch(`${ROUTE_BOARD_URL}/api/picked-summary/Lake%20Grove`);
    assert.equal((await response.json()).orderName, '#812214');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://logistics.test/api/receiving-bridge/api/picked-summary/Lake%20Grove');
    assert.ok(calls[1].options.headers.get('X-HF-Receiving-Bridge'));
  } finally {
    global.fetch = originalFetch;
    if (originalBridge === undefined) delete process.env.ROUTE_BOARD_BRIDGE_URL;
    else process.env.ROUTE_BOARD_BRIDGE_URL = originalBridge;
    if (originalSecret === undefined) delete process.env.HF_LOGISTICS_HANDOFF_SECRET;
    else process.env.HF_LOGISTICS_HANDOFF_SECRET = originalSecret;
  }
});

test('does not replay an application rate limit', async () => {
  const originalFetch = global.fetch;
  const originalBridge = process.env.ROUTE_BOARD_BRIDGE_URL;
  process.env.ROUTE_BOARD_BRIDGE_URL = 'https://logistics.test/api/receiving-bridge';
  let calls = 0;
  global.fetch = async () => { calls++; return Response.json({ error: 'slow down' }, { status: 429 }); };
  try {
    assert.equal((await routeBoardFetch(`${ROUTE_BOARD_URL}/api/essentials-pos-receipt`, { method: 'POST', body: '{}' })).status, 429);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    if (originalBridge === undefined) delete process.env.ROUTE_BOARD_BRIDGE_URL;
    else process.env.ROUTE_BOARD_BRIDGE_URL = originalBridge;
  }
});
