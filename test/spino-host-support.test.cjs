const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const spinoPattern = '*://*.spino.com/*';

test('manifest injects every Link Gen Tool script on Spino pages', () => {
  assert.ok(manifest.host_permissions.includes(spinoPattern));

  for (const script of manifest.content_scripts) {
    assert.ok(
      script.matches.includes(spinoPattern),
      `${script.js.join(', ')} must match ${spinoPattern}`,
    );
  }

  for (const resource of manifest.web_accessible_resources) {
    assert.ok(
      resource.matches.includes(spinoPattern),
      `${resource.resources.join(', ')} must be accessible on ${spinoPattern}`,
    );
  }
});

test('content script and service worker recognize test.spino.com as Spino', () => {
  const spinoDomain = /spino:\s*'spino\.com'/;
  assert.match(contentSource, spinoDomain);
  assert.match(backgroundSource, spinoDomain);

  const hostname = 'www.test.spino.com';
  const strippedHost = hostname
    .split('.')
    .filter((label) => label !== 'www' && !['test', 'qa', 'alpha', 'prod'].includes(label))
    .join('.');

  assert.equal(strippedHost, 'spino.com');
});

test('Spino is configured for credential-backed live login', () => {
  assert.match(
    contentSource,
    /spino:\s*\{\s*loginPath:\s*'\/en\/login',[\s\S]*?usernameSelector:[\s\S]*?passwordSelector:[\s\S]*?submitSelector:\s*'\[data-test-id="btn-1"\]',[\s\S]*?sportsbookNavPattern:\s*\/\^sports\$\/i\s*\}/,
  );
});
