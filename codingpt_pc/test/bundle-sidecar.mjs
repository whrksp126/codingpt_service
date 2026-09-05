import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../scripts/bundle-sidecar.sh', import.meta.url), 'utf8');
const copy = 'cp -R "$DAEMON_SRC/packages/term-host"    "$OUT/app/node_modules/@codingpt/term-host"';
assert.ok(source.includes(copy), 'macOS/Windows 공통 사이드카에 term-host가 포함돼야 한다');
assert.ok(!/if \[\[ "\$TARGET" == win32-\* \]\]; then[\s\S]{0,500}cp -R "\$DAEMON_SRC\/packages\/term-host"/.test(source), 'term-host 복사가 win32 조건 안에 있으면 mac canonical 데몬이 부팅 실패한다');
console.log('bundle-sidecar contract ok');
