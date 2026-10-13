(function(root){
  function upcCheckDigit(data){
    if(!/^\d{11}$/.test(data)) return null;
    var sum = 0;
    for(var i=0;i<data.length;i++) sum += Number(data[i]) * (i % 2 === 0 ? 3 : 1);
    return String((10 - sum % 10) % 10);
  }
  function variants(value){
    var code = String(value || '').trim();
    var codes = new Set([code]);
    if(/^\d{11}$/.test(code)) codes.add(code + upcCheckDigit(code));
    if(/^0\d+$/.test(code)) codes.add(code.slice(1));
    if(/^\d+$/.test(code)) codes.add('0' + code);
    return codes;
  }
  function matches(code, expectedCodes){
    if(!String(code || '').trim()) return false;
    var scanned = variants(code);
    return (expectedCodes || []).some(function(expected){
      var value = String(expected || '').trim();
      return value && (scanned.has(value) || variants(value).has(String(code).trim()));
    });
  }
  function expectedItem(items, code){
    var found = (items || []).filter(function(item){
      return matches(code, item.scanCodes || [item.sku]);
    });
    return found.length === 1 ? found[0] : null;
  }
  function confirmedTotal(value){
    if(value===null || value===undefined || !/^\d+$/.test(String(value).trim())) return null;
    var count=Number(String(value).trim());
    return Number.isSafeInteger(count)&&count>=0&&count<=1000 ? count : null;
  }
  var api = { matches:matches, expectedItem:expectedItem, confirmedTotal:confirmedTotal };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HFReceivingBarcode = api;
})(typeof window !== 'undefined' ? window : globalThis);
