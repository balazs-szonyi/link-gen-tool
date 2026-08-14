'use strict';

// Only contracts explicitly present here may cross a layer boundary. Additions
// require a redacted fixture and regression test. Mutations default to deny.
const CONTRACT_VERSION = '2026-08-14';
const contracts = [
  { id: 'client-config', kind: 'config', methods: ['GET'], pattern: /client.?config|\/config\//i },
  { id: 'startup-context', kind: 'context', methods: ['GET', 'POST'], pattern: /startup.?context/i },
  { id: 'static-context', kind: 'context', methods: ['GET', 'POST'], pattern: /static.?context/i },
  { id: 'user-context', kind: 'context', methods: ['GET', 'POST'], pattern: /user.?context/i },
  { id: 'configuration', kind: 'configuration', methods: ['GET'], pattern: /configuration/i },
  { id: 'route-data', kind: 'route-data', methods: ['GET'], pattern: /route.?data/i },
  { id: 'auth', kind: 'auth', methods: ['GET', 'POST'], pattern: /auth|login|session/i },
  { id: 'realtime', kind: 'realtime', methods: ['GET'], pattern: /signalr|realtime|websocket/i },
  { id: 'wallet', kind: 'wallet', methods: ['GET'], pattern: /wallet|balance/i },
  { id: 'quote', kind: 'bet', methods: ['POST'], pattern: /quote/i, mutation: false },
  { id: 'validation', kind: 'bet', methods: ['POST'], pattern: /validat/i, mutation: false },
  { id: 'place-bet', kind: 'bet', methods: ['POST'], pattern: /place.?bet|bets?\/submit/i, mutation: true },
  { id: 'sportsbook-rest', kind: 'sportsbook', methods: ['GET'], pattern: /\/api\/sb\/|\/sb\/fe-api\//i },
];

function classify(url, method) {
  const upper = String(method || 'GET').toUpperCase();
  return contracts.find((item) => item.methods.includes(upper) && item.pattern.test(url)) || null;
}

module.exports = { CONTRACT_VERSION, contracts, classify };
