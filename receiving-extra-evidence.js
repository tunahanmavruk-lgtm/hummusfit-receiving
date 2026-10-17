const MAX_EXTRA_LINES = 10;

function cleanExtraLines(extraScans, extraDetails, { legacyFingerprint = false } = {}) {
  if (extraScans == null) return [];
  if (typeof extraScans !== "object" || Array.isArray(extraScans)) {
    throw new Error("Wrong/extra items must be submitted as item counts");
  }
  const entries = Object.entries(extraScans);
  if (entries.length > MAX_EXTRA_LINES) throw new Error("Too many wrong/extra item lines for one receipt");
  return entries.map(([code, qty]) => {
    if (typeof code !== "string" || !code.trim() || code.length > 120 ||
        (!legacyFingerprint && !/^[A-Za-z0-9_-]{5,60}$/.test(code)) ||
        !Number.isSafeInteger(qty) || qty < 1 || qty > 1000) {
      throw new Error("Each wrong/extra item needs an identifying code and a whole-number physical count");
    }
    const source = extraDetails?.[code]?.source;
    if (!legacyFingerprint && source === 'manual') throw new Error('Free-text item entries cannot be submitted. Scan or enter an exact barcode or SKU.');
    return { code: code.trim(), qty, source: ["scan", "entered", "manual"].includes(source) ? source : "unverified" };
  });
}

async function verifyExtraLines(lines, lookup) {
  return Promise.all(lines.map(async (line) => {
    const result = { ...line, catalogStatus: "needs_review", catalogVerified: false };
    if (/^[A-Za-z0-9_-]{5,60}$/.test(line.code)) {
      try {
        const catalog = await lookup(line.code);
        if (catalog?.status === "matched" &&
            catalog.productStatus === "ACTIVE" &&
            /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(catalog.variantId || "") &&
            /^[A-Za-z0-9_-]{1,100}$/.test(catalog.sku || "")) {
          result.catalogStatus = "matched";
          result.catalogVerified = true;
          result.variantId = catalog.variantId;
          result.sku = catalog.sku;
          result.title = String(catalog.title || "").slice(0, 200);
        } else if (["ambiguous", "unmatched"].includes(catalog?.status)) {
          result.catalogStatus = catalog.status;
        }
      } catch {
        result.catalogStatus = "lookup_unavailable";
      }
    }
    return result;
  }));
}

module.exports = { cleanExtraLines, verifyExtraLines };
