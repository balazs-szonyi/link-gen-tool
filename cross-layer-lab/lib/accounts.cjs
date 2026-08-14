'use strict';

const fs = require('node:fs');

function loadAccounts(file) {
  if (!file || !fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.accounts)) throw new Error('accounts.local.json must contain an accounts array');
  if (parsed.accounts.some((entry) => Object.keys(entry).some((key) => /password|secret|token/i.test(key)))) {
    throw new Error('accounts.local.json must not contain passwords, secrets, or tokens');
  }
  return parsed.accounts.map(({ brand, accountId }) => ({ brand: String(brand).toLowerCase(), accountId: String(accountId) }));
}

function isAllowed(accounts, brand, accountId) {
  return accounts.some((entry) => entry.brand === brand && entry.accountId === String(accountId));
}

module.exports = { loadAccounts, isAllowed };
