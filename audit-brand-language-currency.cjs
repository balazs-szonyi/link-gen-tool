'use strict';

// Live, read-only inventory of every unique brand registry used by the
// extension. The runtime UI reads the same /api/brands endpoint; this script
// makes the complete 34-brand mapping reviewable without hard-coding it into
// the extension and immediately going stale.

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'extension', 'content.js'), 'utf8');
const bodyMatch = source.match(/var BRANDS = \{([\s\S]*?)\n  \};/);
if (!bodyMatch) throw new Error('Could not find BRANDS in extension/content.js');

const entries = [...bodyMatch[1].matchAll(/^\s*([a-z0-9]+):\s*'([0-9a-f-]+)'/gm)]
  .map((match) => ({ key: match[1], id: match[2] }));
const uniqueBrands = entries.filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
const environments = process.argv.slice(2).length ? process.argv.slice(2) : ['test', 'qa', 'alpha', 'prod'];

function normalize(items, codeField) {
  return (items || [])
    .map((item) => `${item[codeField]}:${item.name}`)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}

async function fetchMetadata(brand, environment) {
  const response = await fetch(`https://internal.${environment}.sbplayground1.net/api/brands/${brand.id}`);
  if (response.ok) return { data: (await response.json()).data, source: environment };
  if (brand.key === 'sandbox' && (environment === 'alpha' || environment === 'prod')) {
    const fallback = await fetch(`https://internal.qa.sbplayground1.net/api/brands/${brand.id}`);
    if (fallback.ok) return { data: (await fallback.json()).data, source: 'qa-fallback' };
  }
  throw new Error(`HTTP ${response.status}`);
}

async function main() {
  if (uniqueBrands.length !== 34) {
    throw new Error(`Expected 34 unique brand GUIDs, found ${uniqueBrands.length}`);
  }
  console.log('# Brand language/currency inventory');
  console.log('');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Unique brands: ${uniqueBrands.length}; UI profiles: ${entries.length} (betssonco shares Betsson's GUID).`);

  let failures = 0;
  for (const environment of environments) {
    console.log(`\n## ${environment.toUpperCase()}\n`);
    for (const brand of uniqueBrands) {
      try {
        const result = await fetchMetadata(brand, environment);
        const languages = normalize(result.data.supportedLanguages, 'languageCode');
        const currencies = normalize(result.data.supportedCurrencies, 'currencyCode');
        console.log(`- **${brand.key}** [${result.source}] — Languages: ${languages || '(none)'}; Currencies: ${currencies || '(none)'}`);
      } catch (error) {
        failures += 1;
        console.log(`- **${brand.key}** — ERROR: ${error.message}`);
      }
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
