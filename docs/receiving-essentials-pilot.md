# Receiving Essentials pilot

This pilot extends the separate Store Receiving service. It does not change the
Route Board, NETUM picking, routing, fulfillment, food labels, or Shopify/POS
inventory.

## One store entry point

- Each location keeps its current permanent store QR code.
- The same store URL is the install target for the **Receiving** iPhone home-screen app.
- Food, Retail Essentials, and Other Essentials are shown as sections inside one receiving session.
- One receiving report records all sections and discrepancies.

## Inventory policy

| Category | Ordered/received | POS policy in this pilot |
| --- | --- | --- |
| Food | Existing quantities | Existing flow remains unchanged |
| Retail Essentials | Cases | Project case × units-per-case, but do not write inventory |
| Other Essentials | Cases | Receipt confirmation only; never write POS inventory |

Every item result records its category and inventory policy. Both the server and
browser policy objects hard-code `posInventoryWriteEnabled: false`. There is no
Shopify inventory client or inventory mutation endpoint in this pilot.

## Future activation gate

Retail POS unit adjustments must not be added until each approved retail SKU has
all of the following verified:

- warehouse case SKU and case GTIN/barcode;
- units per case;
- store unit SKU and retail UPC;
- Shopify unit variant ID;
- destination Shopify store location ID;
- landed case cost and landed unit cost;
- idempotent receiving event ID so a case cannot be posted twice.

Other Essentials must never receive a unit SKU mapping or a POS inventory action.

## PWA behavior

- The manifest is store-specific, so the installed icon returns to that store.
- Live receiving pages and every `/api/` request bypass the service-worker cache.
- Only static shell assets are cached.
- Receiving still requires a live connection to load an order and submit a report.
