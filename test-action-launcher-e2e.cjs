'use strict';

const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

async function main() {
  const extensionPath = path.resolve(__dirname, 'extension');
  const context = await chromium.launchPersistentContext(
    path.join(os.tmpdir(), 'lgt-action-launcher-' + Date.now()),
    {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run'
      ]
    }
  );

  try {
    const pageErrors = [];
    context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });

    const blankPage = await context.newPage();
    await blankPage.goto('about:blank');
    const fallback = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'about:blank' });
      return LgtActionLauncher.launch(chrome, tabs[tabs.length - 1]);
    });
    if (fallback.mode !== 'standalone-created') throw new Error('Expected standalone fallback, got ' + JSON.stringify(fallback));

    const standaloneUrl = worker.url().replace(/background\.js$/, 'standalone.html');
    const standalone = context.pages().find(page => page.url() === standaloneUrl) || await context.waitForEvent('page', {
      predicate: page => page.url() === standaloneUrl,
      timeout: 10000
    });
    if (!standalone) throw new Error('Standalone extension window did not open.');
    await standalone.locator('#lgt-panel').waitFor({ state: 'visible', timeout: 10000 });
    await standalone.waitForTimeout(500);
    if (pageErrors.length) throw new Error('Standalone page error(s): ' + pageErrors.join(' | '));

    console.log('PASS: blank-page fallback opens a visible standalone Link Gen Tool window.');
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
