/* Shared route scoping for bundle overrides and diagnostic URL parameters. */
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
    var url = new URL(value);
    var segments = normalizedPath(url.pathname).split('/').filter(Boolean);
    var sportsbookIndex = segments.findIndex(function (segment) { return segment.toLowerCase() === 'sportsbook'; });
    if (sportsbookIndex !== -1) {
      return {
        kind: 'path-prefix',
        origin: url.origin,
        pathPrefix: '/' + segments.slice(0, sportsbookIndex + 1).join('/')
      };
    }
    return { kind: 'page', origin: url.origin, pathname: normalizedPath(url.pathname) };
  }

  function matches(scope, value) {
    try {
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
