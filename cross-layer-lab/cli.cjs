#!/usr/bin/env node
'use strict';

const { createLab } = require('./server.cjs');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    result[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1]; i += 1;
  }
  return result;
}

async function requestSession(config) {
  const response = await fetch('http://127.0.0.1:8845/v1/session', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.session;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lab = createLab();
  lab.server.listen(8845, '127.0.0.1', async () => {
    console.log('Cross-Layer Lab listening on http://127.0.0.1:8845');
    if (args.brand || args.pageEnv || args.bundleEnv || args.mode) {
      try {
        const session = await requestSession(args);
        console.log(`Ready: Host=${session.pageEnv.toUpperCase()} Bundle=${session.bundleEnv.toUpperCase()} Backend=${session.backendEnv.toUpperCase()} (${session.mode}, ${session.device})`);
      } catch (error) {
        console.error(`Session failed: ${error.message}`); process.exitCode = 1; lab.server.close();
      }
    }
  });
  const stop = () => lab.server.close(() => process.exit(process.exitCode || 0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

main().catch((error) => { console.error(error); process.exit(1); });
