const CATEGORY = Object.freeze({
  FOOD: "food",
  RETAIL: "retail_essentials",
  OTHER: "other_essentials",
});

const INVENTORY_POLICY = Object.freeze({
  FOOD_EXISTING_FLOW: "food_existing_flow",
  RETAIL_CASE_TO_POS_UNITS: "retail_case_to_pos_units",
  RECEIPT_ONLY_NO_POS: "receipt_only_no_pos",
});

const APPAREL = /\b(hoodie|apparel|clothing|crop hoodie|t-?shirt|tee|sweatshirt|sweater|hat|cap|beanie|jacket|shorts|pants|leggings|socks)\b/i;

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function explicitClassifications(item) {
  return [
    item && item.receivingCategory,
    item && item.essentialsType,
    ...(Array.isArray(item && item.productTags) ? item.productTags : []),
    ...(Array.isArray(item && item.productCollections)
      ? item.productCollections.flatMap((collection) =>
          typeof collection === "string"
            ? [collection]
            : [collection && collection.title, collection && collection.handle]
        )
      : []),
  ].map(normalize);
}

function categoryForItem(item) {
  const searchable = `${item && item.title || ""} ${item && item.sku || ""}`;
  if (APPAREL.test(searchable)) return CATEGORY.FOOD;
  const classifications = explicitClassifications(item);
  if (classifications.some((value) => ["retail", "retail essentials", "retail essential"].includes(value))) {
    return CATEGORY.RETAIL;
  }
  if (classifications.some((value) => ["other", "other essentials", "other essential"].includes(value))) {
    return CATEGORY.OTHER;
  }
  return CATEGORY.FOOD;
}

function inventoryPolicyForItem(item) {
  const category = categoryForItem(item);
  if (category === CATEGORY.RETAIL) return INVENTORY_POLICY.RETAIL_CASE_TO_POS_UNITS;
  if (category === CATEGORY.OTHER) return INVENTORY_POLICY.RECEIPT_ONLY_NO_POS;
  return INVENTORY_POLICY.FOOD_EXISTING_FLOW;
}

function buildReceivingPolicy(item) {
  const category = categoryForItem(item);
  const unitsPerCase = Math.max(0, Number(item && item.unitsPerCase) || 0);
  const pickedCases = Math.max(0, Number(item && item.pickedQty) || 0);
  return {
    category,
    inventoryPolicy: inventoryPolicyForItem(item),
    pickedCases,
    unitsPerCase,
    projectedPosUnits:
      category === CATEGORY.RETAIL && unitsPerCase > 0 ? pickedCases * unitsPerCase : 0,
    posInventoryWriteEnabled: false,
  };
}

function receiptCountKey(item) {
  return String(item && item.sku || "").trim() || String(item && item.title || "").trim();
}

module.exports = {
  CATEGORY,
  INVENTORY_POLICY,
  buildReceivingPolicy,
  categoryForItem,
  inventoryPolicyForItem,
  receiptCountKey,
};
