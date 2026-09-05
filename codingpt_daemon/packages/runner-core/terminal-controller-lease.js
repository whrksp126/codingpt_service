'use strict';

const LEASE_MS = 15000;

function parse(value) {
  const raw = String(value || '').trim();
  const at = raw.lastIndexOf(':');
  if (at <= 0) return null;
  const expiresAt = Number(raw.slice(at + 1));
  return Number.isFinite(expiresAt) ? { owner: raw.slice(0, at), expiresAt } : null;
}

function format(owner, now = Date.now()) { return `${owner}:${now + LEASE_MS}`; }

function allows(value, owner, now = Date.now()) {
  const lease = parse(value);
  return !lease || lease.expiresAt <= now || lease.owner === owner;
}

module.exports = { LEASE_MS, parse, format, allows };
