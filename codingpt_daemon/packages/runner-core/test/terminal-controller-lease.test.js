'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../terminal-controller-lease');

test('active controller lease blocks observers until expiry', () => {
  const value = L.format('ipad', 1000);
  assert.strictEqual(L.allows(value, 'ipad', 1001), true);
  assert.strictEqual(L.allows(value, 'android', 1001), false);
  assert.strictEqual(L.allows(value, 'android', 1000 + L.LEASE_MS), true);
});

test('missing or malformed leases fail open for recovery', () => {
  assert.strictEqual(L.allows('', 'pc', 1), true);
  assert.strictEqual(L.allows('broken', 'pc', 1), true);
});
