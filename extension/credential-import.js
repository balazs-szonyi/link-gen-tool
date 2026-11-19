'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtCredentialImport = api;
})(globalThis, function () {
  const FORMAT = 'lgt-credentials-import-v1';

  function parse(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON' }; }
    if (!data || data.format !== FORMAT || !Array.isArray(data.credentials)) {
      return { error: 'Unsupported file (expected format "' + FORMAT + '")' };
    }
    const records = [];
    let skipped = 0;
    data.credentials.forEach(function (c) {
      if (!c || typeof c.username !== 'string' || !c.username || typeof c.password !== 'string' || !c.password) { skipped++; return; }
      records.push({
        label: typeof c.label === 'string' && c.label ? c.label : c.username,
        username: c.username,
        password: c.password,
        urls: Array.isArray(c.urls) ? c.urls.filter(function (u) { return typeof u === 'string'; }) : []
      });
    });
    return { records: records, skipped: skipped };
  }

  // brandOf(url) -> brand key or null. uid() -> new credential id.
  // Existing credentials are matched on label + username: password and brands
  // are refreshed (brands are only ever added), the default flag and ids stay.
  function merge(list, records, brandOf, uid) {
    const out = list.map(function (c) { return Object.assign({}, c, { brands: (c.brands || []).slice() }); });
    let added = 0, updated = 0, unassigned = 0;
    records.forEach(function (r) {
      const brands = [];
      r.urls.forEach(function (u) {
        const b = brandOf(u);
        if (b && brands.indexOf(b) === -1) brands.push(b);
      });
      const existing = out.find(function (c) { return c.label === r.label && c.username === r.username; });
      if (existing) {
        existing.password = r.password;
        brands.forEach(function (b) { if (existing.brands.indexOf(b) === -1) existing.brands.push(b); });
        updated++;
      } else {
        out.push({ id: uid(), label: r.label, username: r.username, password: r.password, isDefault: out.length === 0, brands: brands });
        added++;
        if (!brands.length) unassigned++;
      }
    });
    return { list: out, added: added, updated: updated, unassigned: unassigned };
  }

  return { FORMAT: FORMAT, parse: parse, merge: merge };
});
