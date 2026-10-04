# Receiving Essentials pilot

This extends the separate Store Receiving service. Route Board provides the
authoritative picked summary and a scoped inventory-conversion endpoint. The
existing NETUM picking, routing, fulfillment, food labels, and regular food
inventory flow are not changed.

## One store entry point

- Each location keeps its current permanent store QR code.
- The same store URL is the install target for the **Receiving** iPhone home-screen app.
- Food, Retail Essentials, and Other Essentials are shown as sections inside one receiving session.
- One receiving report records all sections and discrepancies.

## Inventory policy

| Category | Ordered/received | POS policy in this pilot |
| --- | --- | --- |
| Food | Existing quantities | Existing flow remains unchanged |
| Retail Essentials | Cases | After verified store receipt, convert mapped cases to POS sell units at that store |
| Other Essentials | Cases | Receipt confirmation only; never write POS inventory |

Every item result records its category, expected and received cases, and POS
posting result. Receiving never holds Shopify inventory credentials. It sends
only the retail case receipt to Route Board with a 60-second service token;
Route Board rechecks the completed pick, fulfilled order, 14-store allowlist,
case SKU mapping, and Shopify location before any stock change. Other
Essentials and regular food are never sent for POS conversion.

## Activation gate

Retail POS unit adjustments must not be added until each approved retail SKU has
all of the following verified:

- warehouse case SKU and case GTIN/barcode;
- units per case;
- store unit SKU and retail UPC;
- Shopify unit variant ID;
- destination Shopify store location ID;
- an active, priced unit POS variant with a valid UPC/EAN;
- a dedicated Shopify token with `read_products`, `read_locations`,
  `read_inventory`, and `write_inventory` scopes;
- `ESSENTIALS_POS_CONVERSION_ENABLED=true` on Route Board after the token is
  installed and an end-to-end test passes.

The Route Board uses Shopify's 2026-10 idempotent inventory mutation. It
atomically subtracts received cases and adds case × unit-count sell units at
the same store location, with compare-and-swap quantities. A persistent
receipt ledger under `/data` prevents retries from doubling inventory. Orders
created before the cutover (including Holbrook #743573) cannot be replayed.
Missing mappings, inactive/unpriced/unbarcoded POS variants, or absent case
stock produce a visible `requires_review` result instead of a stock write.

Other Essentials must never receive a unit SKU mapping or a POS inventory action.

## PWA behavior

- The manifest is store-specific, so the installed icon returns to that store.
- Live receiving pages and every `/api/` request bypass the service-worker cache.
- Only static shell assets are cached.
- Receiving still requires a live connection to load an order and submit a report.
