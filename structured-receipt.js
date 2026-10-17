const { canonicalOrder } = require('./receipt-submission');

// Resolve order identity and product metadata from Route Board, never from a
// typed product description or client-supplied inventory policy.
function verifiedDelivery(body, delivery) {
  const changed = () => new Error('Delivery details could not be verified or have changed. Your draft is preserved. Contact logistics before submitting.');
  if (!delivery || canonicalOrder(delivery.orderId) !== canonicalOrder(body.orderId) ||
      !Array.isArray(delivery.items) || delivery.items.length !== body.expectedItems.length) throw changed();
  const key = i => i.sku || i.title;
  const submitted = new Map(body.expectedItems.map(i => [key(i), i]));
  const seen = new Set();
  for (const item of delivery.items) {
    const id = key(item), client = submitted.get(id);
    if (!id || seen.has(id) || !client || client.title !== item.title ||
        Number(client.expectedQty) !== Number(item.expectedQty) || client.pickedQty !== item.pickedQty ||
        !Number.isSafeInteger(item.pickedQty) || item.pickedQty < 0 ||
        !Number.isSafeInteger(Number(item.expectedQty)) || Number(item.expectedQty) < 0) throw changed();
    seen.add(id);
    if (item.status !== 'missing' && !Object.hasOwn(body.scannedCounts, id)) {
      throw new Error('Confirm a whole-number received count for every delivery item, including zero. Your draft has not been submitted.');
    }
  }
  return delivery;
}

function requireVerifiedExtras(extras, items) {
  const seen = new Set();
  for (const item of extras) {
    if (!item.catalogVerified) throw new Error('Every wrong/extra item needs an exact, verified barcode or SKU. Keep your draft and ask logistics to identify unmatched items, then scan again.');
    if (items.some(i => i.sku === item.sku)) throw new Error('An extra item is already on this delivery. Enter its total received count on the order line before submitting.');
    if (seen.has(item.sku)) throw new Error('Two extra codes identify the same product. Combine their physical counts under one verified code before submitting.');
    seen.add(item.sku);
  }
}

module.exports = { verifiedDelivery, requireVerifiedExtras };
