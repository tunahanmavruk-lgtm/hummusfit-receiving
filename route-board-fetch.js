const crypto = require('node:crypto');

const ROUTE_BOARD_URL = process.env.ROUTE_BOARD_URL || 'https://hummusfit-route-board-production.up.railway.app';

function bridgeToken() {
  const secret = process.env.HF_LOGISTICS_HANDOFF_SECRET;
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({
    sub: 'hummusfit-receiving', scope: ['essentials.receive'],
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

async function routeBoardFetch(url, options = {}) {
  const response = await fetch(url, options);
  const bridge = process.env.ROUTE_BOARD_BRIDGE_URL;
  if (response.status !== 429 || !bridge || !url.startsWith(ROUTE_BOARD_URL + '/')) return response;
  // Only retry Railway's edge rejection, which never reached Route Board.
  if (response.headers.get('server') !== 'railway-hikari' ||
      (await response.clone().text()).trim() !== 'rate limited') return response;
  const token = bridgeToken();
  if (!token) return response;
  const headers = new Headers(options.headers || {});
  headers.set('X-HF-Receiving-Bridge', token);
  return fetch(bridge.replace(/\/$/, '') + url.slice(ROUTE_BOARD_URL.length), {
    ...options, headers,
  });
}

module.exports = { routeBoardFetch, ROUTE_BOARD_URL };
