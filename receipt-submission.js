const crypto = require('node:crypto');
const { cleanExtraLines } = require('./receiving-extra-evidence');

function orderIds(value) {
  const ids = String(value || '').split(',').map(s => s.trim());
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length ||
      ids.some(id => !/^gid:\/\/shopify\/Order\/\d+$/.test(id))) {
    throw new Error('An exact delivery order is required. Reopen the store receiving link.');
  }
  return ids.sort();
}
const canonicalOrder = value => orderIds(value).join(',');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function receiptFingerprint(report) {
  return digest([report.store, canonicalOrder(report.orderId),
    sorted(report.items.map(i => [i.sku || i.title, i.orderedQty, i.expectedFromPicking, i.actuallyReceived])),
    sorted((report.extraItems || []).map(i => [i.code, i.qty]))]);
}

function submissionIdentity(body) {
  const ids = orderIds(body.orderId);
  if (!Array.isArray(body.expectedItems) || !body.expectedItems.length || body.expectedItems.length > 1000 ||
      !body.scannedCounts || typeof body.scannedCounts !== 'object' || Array.isArray(body.scannedCounts)) {
    throw new Error('Delivery items and received counts are required. Your draft has not been submitted.');
  }
  if (body.submissionId != null && !/^[a-zA-Z0-9_-]{16,100}$/.test(body.submissionId)) {
    throw new Error('Invalid receipt submission ID. Keep this draft and contact logistics.');
  }
  const keys = new Set();
  const items = body.expectedItems.map(i => {
    const key = i.sku || i.title;
    const qty = body.scannedCounts[key] ?? 0;
    if (!key || keys.has(key) || !Number.isSafeInteger(qty) || qty < 0 || qty > 100000 ||
        !Number.isSafeInteger(i.pickedQty) || i.pickedQty < 0 ||
        !Number.isSafeInteger(Number(i.expectedQty)) || Number(i.expectedQty) < 0) {
      throw new Error('Each delivery item needs a unique SKU and a whole-number received count (zero is allowed).');
    }
    keys.add(key);
    return { sku: i.sku, title: i.title, orderedQty: Number(i.expectedQty), expectedFromPicking: i.pickedQty, actuallyReceived: qty };
  });
  if (Object.keys(body.scannedCounts).some(k => !keys.has(k))) throw new Error('Some saved counts do not belong to this delivery. Contact logistics; do not discard your draft.');
  const fingerprint = receiptFingerprint({ store: body.store, orderId: body.orderId, items,
    extraItems: cleanExtraLines(body.extraScans, body.extraDetails) });
  return { ids, fingerprint, submissionId: body.submissionId || null };
}

function findSubmission(reports, store, identity) {
  const scoped = reports.filter(r => r.store === store);
  const sameId = identity.submissionId && scoped.find(r => r.submissionId === identity.submissionId);
  if (sameId) {
    if (sameId.submissionFingerprint !== identity.fingerprint) return { conflict: true, report: sameId };
    return { report: sameId, replayed: true };
  }
  const overlaps = scoped.filter(r => !r.supersededBy && String(r.orderId || '').split(',').some(id => identity.ids.includes(id.trim())));
  if (!overlaps.length) return null;
  if (overlaps.length === 1) {
    try {
      if (receiptFingerprint(overlaps[0]) === identity.fingerprint) return { report: overlaps[0], replayed: true };
    } catch { /* Historical incomplete evidence must never be replayed. */ }
  }
  return { conflict: true, report: overlaps.length === 1 ? overlaps[0] : null };
}

// One service replica with a persistent reports volume. Serialize across the
// catalog await as well as the atomic file write, including overlapping orders.
function createSubmissionLock() {
  const tails = new Map();
  return async (store, action) => {
    const previous = tails.get(store) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    tails.set(store, next);
    try { return await next; }
    finally { if (tails.get(store) === next) tails.delete(store); }
  };
}
module.exports = { orderIds, canonicalOrder, submissionIdentity, receiptFingerprint, findSubmission, createSubmissionLock };
