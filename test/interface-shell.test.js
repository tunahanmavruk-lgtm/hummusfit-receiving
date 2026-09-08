const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('shares the HF Logistics shell across every receiving interface', () => {
  for (const file of ['public/index.html', 'public/out-of-state.html', 'public/receiving.html', 'public/reports.html']) {
    const html = read(file);
    assert.match(html, /hf-logistics-theme\.css\?v=1/);
    assert.match(html, /hf-appbar/);
  }
  for (const file of ['public/index.html', 'public/out-of-state.html', 'public/reports.html']) {
    assert.match(read(file), /https:\/\/logistics\.myhummusfit\.com\//);
  }
});

test('keeps receiving scan and submission hooks intact', () => {
  const html = read('public/receiving.html');
  for (const hook of ['storeName', 'dateOrderRow', 'mainContent', 'scannerOverlay', 'scannerCloseBtn', 'receivedByInput', 'scanBtn', 'finishBtn', '/api/submit-receiving-check']) {
    assert.ok(html.includes(hook), `receiving flow must retain ${hook}`);
  }
});

test('keeps report filtering and report API hooks intact', () => {
  const html = read('public/reports.html');
  for (const hook of ['data-filter="all"', 'data-filter="errors"', 'clearBtn', 'lastUpdated', '/api/reports']) {
    assert.ok(html.includes(hook), `reports flow must retain ${hook}`);
  }
});

test('keeps both QR directories connected to their original data source', () => {
  assert.match(read('public/index.html'), /fetch\('\/api\/stores'\)/);
  assert.match(read('public/out-of-state.html'), /data\.outOfStateStores/);
});

test('locks management pages and APIs behind HF Logistics while store QR access is scoped', () => {
  const server = read('server.js');
  const reports = read('public/reports.html');
  assert.match(server, /app\.post\("\/api\/submit-receiving-check", requireStoreAccess/);
  assert.match(server, /app\.get\("\/api\/expected\/:store", requireStoreAccess/);
  assert.match(server, /app\.get\("\/api\/eta\/:store", requireStoreAccess/);
  assert.match(server, /app\.get\("\/api\/stores", requireReportsManager/);
  assert.match(server, /app\.get\("\/api\/reports", requireReportsManager/);
  assert.match(server, /\["\/reports", "\/reports\.html"\], requireReportsManager/);
  assert.match(server, /\["\/", "\/index\.html"\], requireReportsManager/);
  assert.match(server, /scope: "receiving\.store"/);
  assert.match(server, /scope: "store\.vehicle\.track"/);
  assert.match(server, /app\.get\("\/auth\/hf-logistics"/);
  assert.match(server, /app\.post\("\/api\/clear-reports", requireReportsManager/);
  assert.match(server, /verifyLogisticsToken\(token, "reports\.manage"\)/);
  assert.match(server, /authorization\.startsWith\("Bearer "\)/);
  assert.match(reports, /id="clearBtn" hidden/);
  assert.match(reports, /fetch\('\/api\/admin-session'\)/);
});

test('store receiving page exposes only its own order and signed vehicle tracking flow', () => {
  const server = read('server.js');
  const html = read('public/receiving.html');
  assert.match(html, /This store only/);
  assert.match(html, /storeAccessToken/);
  assert.match(html, /\/api\/eta\//);
  assert.match(html, /etaInfo\.trackUrl/);
  assert.doesNotMatch(html, />Route board</);
  assert.doesNotMatch(html, />Accuracy reports</);
  assert.doesNotMatch(html, /\/track\.html\?imei=/);
  assert.match(html, /etaInfo\.trackingAvailable/);
  assert.match(html, /setInterval[\s\S]*15000/);
  assert.match(server, /data\.trackingAvailable/);
});

test('permanent store QR URLs upgrade to signed store-only sessions', () => {
  const server = read('server.js');
  assert.match(server, /const targetUrl = `\$\{req\.protocol\}:\/\/\$\{req\.get\("host"\)\}\/receiving\/\$\{encodeURIComponent\(store\)\}`/);
  assert.match(server, /if \(!access\) \{/);
  assert.match(server, /signStoreToken\(store\)/);
  assert.match(server, /res\.redirect\(302, `\/receiving\/\$\{encodeURIComponent\(store\)\}\?access=/);
  assert.match(server, /if \(!verifyStoreToken\(access, store\)\)/);
});
