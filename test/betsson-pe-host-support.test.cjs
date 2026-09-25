const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const peruPattern = '*://*.betsson.pe/*';
const sharedBetssonGuid = '6a6d80b9-16ac-4387-a413-244d93a74deb';

test('manifest injects every Link Gen Tool script on Betsson Peru pages', () => {
  assert.ok(manifest.host_permissions.includes(peruPattern));

  for (const script of manifest.content_scripts) {
    assert.ok(
      script.matches.includes(peruPattern),
      `${script.js.join(', ')} must match ${peruPattern}`,
    );
  }

  for (const resource of manifest.web_accessible_resources) {
    assert.ok(
      resource.matches.includes(peruPattern),
      `${resource.resources.join(', ')} must be accessible on ${peruPattern}`,
    );
  }
});

test('Betsson Peru uses its real domain with the network-confirmed shared sportsbook GUID', () => {
  const guidEntry = new RegExp(`betssonpe:\\s*'${sharedBetssonGuid}'`);
  const domainEntry = /betssonpe:\s*'betsson\.pe'/;
  assert.match(contentSource, guidEntry);
  assert.match(backgroundSource, guidEntry);
  assert.match(contentSource, domainEntry);
  assert.match(backgroundSource, domainEntry);
});

test('Betsson Peru reuses the canonical Betsson playground without making host detection ambiguous', () => {
  assert.match(contentSource, /if \(brand === 'betssonpe'\) return PLAYGROUND_HOST_SUFFIX\.betsson/);
  assert.match(backgroundSource, /brand === 'betssonpe' \? PLAYGROUND_HOST_SUFFIX\.betsson/);
  const contentSuffixMap = /PLAYGROUND_HOST_SUFFIX\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(contentSource)[1];
  const backgroundSuffixMap = /PLAYGROUND_HOST_SUFFIX\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(backgroundSource)[1];
  assert.doesNotMatch(contentSuffixMap, /betssonpe\s*:/);
  assert.doesNotMatch(backgroundSuffixMap, /betssonpe\s*:/);
});
