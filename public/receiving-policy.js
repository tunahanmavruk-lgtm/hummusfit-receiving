(function (root) {
  var CATEGORY = { FOOD: 'food', RETAIL: 'retail_essentials', OTHER: 'other_essentials' };
  var APPAREL = /\b(hoodie|apparel|clothing|crop hoodie|t-?shirt|tee|sweatshirt|sweater|hat|cap|beanie|jacket|shorts|pants|leggings|socks)\b/i;
  function normalize(value){
    return String(value || '').normalize('NFKC').toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function categoryForItem(item){
    var searchable = String(item && item.title || '') + ' ' + String(item && item.sku || '');
    if(APPAREL.test(searchable)) return CATEGORY.FOOD;
    var values = [item && item.receivingCategory, item && item.essentialsType]
      .concat(Array.isArray(item && item.productTags) ? item.productTags : [])
      .concat(Array.isArray(item && item.productCollections) ? item.productCollections.reduce(function(all, collection){
        if(typeof collection === 'string') return all.concat(collection);
        return all.concat(collection && collection.title, collection && collection.handle);
      }, []) : [])
      .map(normalize);
    if(values.some(function(value){ return ['retail', 'retail essentials', 'retail essential'].indexOf(value) !== -1; })) return CATEGORY.RETAIL;
    if(values.some(function(value){ return ['other', 'other essentials', 'other essential'].indexOf(value) !== -1; })) return CATEGORY.OTHER;
    return CATEGORY.FOOD;
  }
  function inventoryPolicyForItem(item){
    var category = categoryForItem(item);
    if(category === CATEGORY.RETAIL) return 'retail_case_to_pos_units';
    if(category === CATEGORY.OTHER) return 'receipt_only_no_pos';
    return 'food_existing_flow';
  }
  function buildReceivingPolicy(item){
    var category = categoryForItem(item);
    var unitsPerCase = Math.max(0, Number(item && item.unitsPerCase) || 0);
    var pickedCases = Math.max(0, Number(item && item.pickedQty) || 0);
    return {
      category: category,
      inventoryPolicy: inventoryPolicyForItem(item),
      pickedCases: pickedCases,
      unitsPerCase: unitsPerCase,
      projectedPosUnits: category === CATEGORY.RETAIL && unitsPerCase > 0 ? pickedCases * unitsPerCase : 0,
      posInventoryWriteEnabled: false
    };
  }
  root.HFReceivingPolicy = { CATEGORY:CATEGORY, categoryForItem:categoryForItem, inventoryPolicyForItem:inventoryPolicyForItem, buildReceivingPolicy:buildReceivingPolicy };
})(window);
