const crypto = require('node:crypto');

const ENTRY_VERSION = '2';
function receivingDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function freshReceivingPath(store, access, now = new Date()) {
  const query = new URLSearchParams({access, visit: crypto.randomUUID(), day: receivingDay(now), entry: ENTRY_VERSION});
  return `/receiving/${encodeURIComponent(store)}?${query}`;
}
function currentReceivingEntry(query, now = new Date()) {
  return query.entry === ENTRY_VERSION && query.day === receivingDay(now) &&
    typeof query.visit === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.visit);
}
module.exports = {receivingDay, freshReceivingPath, currentReceivingEntry};
