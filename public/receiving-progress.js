(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.HFReceivingProgress = factory();
})(typeof window === 'undefined' ? globalThis : window, function(){
  'use strict';
  var stores = ['Bellmore','Deer Park','Islip','Farmingdale','Holbrook','Huntington','Island Park','Lake Grove','Lindenhurst','Lynbrook','Miller Place','Ronkonkoma','Selden','Woodbury'];
  function canonical(value){ return String(value || '').split(',').map(function(s){return s.trim();}).sort().join(','); }
  function key(store, order){ return 'hf-receiving-draft-v1:' + encodeURIComponent(store) + ':' + encodeURIComponent(canonical(order)); }
  function signature(expected){
    return JSON.stringify((expected.items || []).map(function(i){return [i.sku || i.title,i.expectedQty,i.pickedQty,i.status];}).sort(function(a,b){return JSON.stringify(a).localeCompare(JSON.stringify(b));}));
  }
  function create(storage, store){
    var prefix = 'hf-receiving-draft-v1:' + encodeURIComponent(store) + ':';
    var seen = Object.create(null);
    return {
      read: function(order){
        var raw = storage.getItem(key(store,order));
        seen[key(store,order)] = raw;
        if(!raw) return null;
        var draft = JSON.parse(raw);
        if(draft.version !== 1 || draft.store !== store || canonical(draft.expected.orderId) !== canonical(order)) throw new Error('Saved draft could not be verified. Do not clear browser storage; contact logistics.');
        return draft;
      },
      save: function(draft){
        var clean = JSON.parse(JSON.stringify(draft));
        clean.version = 1; clean.store = store; clean.updatedAt = new Date().toISOString();
        // A signed access link is never persisted in the draft.
        if(clean.pending) delete clean.pending.access;
        var raw = JSON.stringify(clean), target = key(store,clean.expected.orderId);
        if(Object.prototype.hasOwnProperty.call(seen,target) && storage.getItem(target)!==seen[target]) {
          throw new Error('This receipt was changed in another tab. Your current counts remain on screen. Contact logistics before closing either tab.');
        }
        storage.setItem(target,raw);
        if(storage.getItem(target) !== raw) throw new Error('Browser did not save receiving progress.');
        seen[target] = raw;
        return clean;
      },
      list: function(){
        var drafts=[];
        for(var i=0;i<storage.length;i++){
          var k=storage.key(i);
          if(k && k.indexOf(prefix)===0){
            var draft=JSON.parse(storage.getItem(k));
            if(draft.version===1 && draft.store===store && !draft.completedReportId) drafts.push(draft);
          }
        }
        return drafts.sort(function(a,b){return String(b.updatedAt).localeCompare(String(a.updatedAt));});
      }
    };
  }
  return { enabled: function(store){return stores.indexOf(store)!==-1;}, canonical:canonical, signature:signature, create:create };
});
