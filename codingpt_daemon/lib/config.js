/**
 * 데몬 설정 — ~/.codingpt/daemon.json
 * { serverUrl, deviceId, deviceToken, deviceName }
 * deviceToken 은 이 파일에만 존재(서버는 해시만 보관) → 0600 권한.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.codingpt');
const CONFIG_FILE = path.join(CONFIG_DIR, 'daemon.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function save(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return CONFIG_FILE;
}

function remove() {
  try { fs.unlinkSync(CONFIG_FILE); return true; } catch (_) { return false; }
}

module.exports = { load, save, remove, CONFIG_FILE };
