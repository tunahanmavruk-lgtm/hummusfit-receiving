// Coalesce store display reads across devices. Submission verification does not
// use this cache: it must read the latest picked manifest from Route Board.
function createRouteBoardReadCache(fetchImpl, now = Date.now) {
  const entries = new Map();
  return async function read(key, url, options = {}, ttlMs = 30000) {
    const entry = entries.get(key);
    if (entry?.promise) return entry.promise;
    if (entry?.value && entry.expiresAt > now()) return entry.value;

    const promise = (async () => {
      const response = await fetchImpl(url, options);
      const value = { status: response.status, ok: response.ok, text: await response.text() };
      if (value.ok) {
        try {
          JSON.parse(value.text);
          entries.set(key, { value, expiresAt: now() + ttlMs });
        } catch {
          entries.delete(key);
        }
      } else {
        entries.delete(key);
      }
      return value;
    })();
    entries.set(key, { promise });
    try {
      return await promise;
    } catch (error) {
      entries.delete(key);
      throw error;
    }
  };
}

module.exports = { createRouteBoardReadCache };
