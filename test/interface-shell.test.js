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
    assert.match(html, /class="hf-appbar"/);
    assert.match(html, /https:\/\/logistics\.myhummusfit\.com\//);
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
