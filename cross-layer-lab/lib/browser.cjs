'use strict';

const path = require('node:path');
const { envOrigin } = require('./model.cjs');
const { createRouteHandler } = require('./router.cjs');

class LabBrowser {
  constructor(options) { this.options = options; this.context = null; this.page = null; }
  async start(session, dependencies) {
    const { chromium } = require('playwright');
    await this.stop();
    const extensionPath = path.resolve(__dirname, '..', '..', 'extension');
    this.context = await chromium.launchPersistentContext(this.options.profileDir, {
      headless: false, channel: 'chromium', viewport: session.device === 'mobile' ? { width: 390, height: 844 } : null,
      userAgent: session.device === 'mobile' ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36' : undefined,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run'],
    });
    dependencies.getCookies = (url) => this.context.cookies(url);
    await this.context.route('**/*', createRouteHandler(dependencies));
    if (session.mode === 'full-runtime') {
      const bootstrap = await this.context.newPage();
      await bootstrap.goto(`${envOrigin(session.brand, session.bundleEnv)}/en/login`, { waitUntil: 'domcontentloaded' });
      // Login remains manual. Keeping this target-origin tab in the same
      // context bootstraps and preserves its cookies for proxied requests.
    }
    this.page = await this.context.newPage();
    await this.page.goto(`${envOrigin(session.brand, session.pageEnv)}/en/sportsbook`, { waitUntil: 'domcontentloaded' });
    this.context.on('close', () => dependencies.pending.rejectAll('browser-context-closed'));
    return this.page.url();
  }
  async stop() {
    if (!this.context) return;
    const context = this.context; this.context = null; this.page = null;
    await context.close().catch(() => {});
  }
}

module.exports = { LabBrowser };
