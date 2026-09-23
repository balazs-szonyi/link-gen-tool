/* Shared tab-lifetime scoping for bundle overrides and diagnostic URL parameters. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LgtBundleNavigation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizedPath(pathname) {
    var value = pathname || '/';
    return value.length > 1 ? value.replace(/\/+$/, '') : value;
  }

  function scopeForUrl(value) {
    // Validate the source URL, but intentionally do not bind the override to
    // it. Once enabled, the user owns the lifecycle explicitly through the
    // Disable button (or by closing the tab), not through site routing.
    new URL(value);
    return { kind: 'tab' };
  }

  function matches(scope, value) {
    try {
      if (scope && scope.kind === 'tab') return true;
      var url = new URL(value);
      var pathname = normalizedPath(url.pathname);
      if (!scope || scope.origin !== url.origin) return false;
      if (scope.kind === 'page') return normalizedPath(scope.pathname) === pathname;
      if (scope.kind === 'path-prefix') {
        var prefix = normalizedPath(scope.pathPrefix);
        return pathname === prefix || pathname.startsWith(prefix + '/');
      }
    } catch (error) { /* malformed URLs fail closed */ }
    return false;
  }

  return { normalizedPath: normalizedPath, scopeForUrl: scopeForUrl, matches: matches };
});
