/* eslint-disable */
// e2eeCore.js — cpt-e2ee/v1 순수 JS 암호 코어 (의존성 0).
//
// ★ 이 파일은 codingpt_app/src/services/e2ee/e2eeCore.js 의 **동일 사본**이다(import 경로만 다름).
//   한쪽만 고치면 두 플랫폼의 와이어가 갈라져 복호 실패(=평문 폴백 or 연결 에러)로 나타난다.
//   수정 시 두 파일을 함께 바꾸고 앱의 `npm test`(e2ee.test.ts + e2eeConformance.test.ts)를 다시 돌린다.
//
// 왜 순수 JS 인가 (실측 근거)
//  · 모바일 터미널/에디터는 WebView(`source={{html}}`) = **비보안 컨텍스트**라 `crypto.subtle` 이 없다.
//  · RN Hermes 에도 WebCrypto 가 없다(getRandomValues 조차 폴리필 필요).
//  · 데몬은 node 내장 crypto, PC 는 WKWebView. 4환경에서 **같은 알고리즘**을 쓰려면 순수 JS 가 최소 공통분모.
//
// 스위트(설계 §2.1): X25519 / HKDF-SHA256 / ChaCha20-Poly1305(IETF) / b64url no-pad
//
// 성능 메모: poly1305·x25519·ed25519 는 BigInt 구현이다(정확성 우선). RPC 봉투(수 KB)와 키 수립에는
//  충분하나, PTY 스트림(kind=data 프레임 폭주)에 쓰기 전에 반드시 계측할 것 — 그래서 기본 scope=rpc.

export const SUITE = 'cpt-e2ee/v1';

// ── 바이트 유틸 ────────────────────────────────────────────────
export function u8(x) {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return new Uint8Array(x);
  throw new Error('u8: Uint8Array 필요');
}
/** 부분 사본 — ⚠ `.slice()` 를 쓰지 말 것: node Buffer 는 slice 가 **뷰**라 원본 키를 오염시킨다
 *  (실측 버그: edDecode 가 부호 비트를 지우며 호출자의 공개키/서명을 변조 → 검증 간헐 실패). */
export function copyOf(b, start, end) {
  const s = u8(b);
  const from = start || 0;
  const to = end == null ? s.length : end;
  const out = new Uint8Array(Math.max(0, to - from));
  out.set(s.subarray(from, to));
  return out;
}
export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function utf8(s) {
  const str = String(s);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
export function fromUtf8(bytes) {
  const b = u8(bytes);
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i];
    if (c < 0x80) { s += String.fromCharCode(c); i += 1; }
    else if (c < 0xe0) { s += String.fromCharCode(((c & 31) << 6) | (b[i + 1] & 63)); i += 2; }
    else if (c < 0xf0) { s += String.fromCharCode(((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63)); i += 3; }
    else {
      const cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
      s += String.fromCodePoint(cp); i += 4;
    }
  }
  return s;
}

const B64_A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** base64url no-pad 인코딩 — 와이어의 모든 바이트 필드가 이 형식(설계 §2.1). */
export function b64uEnc(bytes) {
  const b = u8(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
    const rem = b.length - i;
    s += B64_A[(n >> 18) & 63] + B64_A[(n >> 12) & 63];
    if (rem > 1) s += B64_A[(n >> 6) & 63];
    if (rem > 2) s += B64_A[n & 63];
  }
  return s;
}
export function b64uDec(str) {
  const s = String(str || '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_A.indexOf(s[i]);
    if (v < 0) throw new Error('b64u: 잘못된 문자');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

/** 상수시간 비교(태그/confirm 대조 — 조기 반환 금지). */
export function ctEq(a, b) {
  const x = u8(a), y = u8(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// ── 난수(주입식) ───────────────────────────────────────────────
//  플랫폼마다 출처가 다르다: RN=react-native-get-random-values 폴리필, WebView/PC=globalThis.crypto,
//  테스트=node crypto. **주입 없으면 던진다** — 조용히 약한 난수로 폴백하면 전체 보안이 무너진다.
let _rand = null;
export function setRandomSource(fn) { _rand = typeof fn === 'function' ? fn : null; }
export function hasRandomSource() {
  if (_rand) return true;
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return !!(g && g.crypto && typeof g.crypto.getRandomValues === 'function');
}
export function randomBytes(n) {
  const out = new Uint8Array(n);
  if (_rand) { const r = _rand(n); out.set(u8(r).subarray(0, n)); return out; }
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g && g.crypto && typeof g.crypto.getRandomValues === 'function') { g.crypto.getRandomValues(out); return out; }
  throw new Error('E2EE_NO_CSPRNG');
}

// ── SHA-256 ───────────────────────────────────────────────────
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr32 = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

export function sha256(msg) {
  const m = u8(msg);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const total = (m.length + 9 + 63) & ~63;
  const buf = new Uint8Array(total);
  buf.set(m);
  buf[m.length] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = m.length * 8;
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a1 = w[i - 15], b1 = w[i - 2];
      const s0 = rotr32(a1, 7) ^ rotr32(a1, 18) ^ (a1 >>> 3);
      const s1 = rotr32(b1, 17) ^ rotr32(b1, 19) ^ (b1 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

export function hmacSha256(key, msg) {
  let k = u8(key);
  if (k.length > 64) k = sha256(k);
  const pad = new Uint8Array(64);
  pad.set(k);
  const ipad = new Uint8Array(64), opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = pad[i] ^ 0x36; opad[i] = pad[i] ^ 0x5c; }
  return sha256(concat(opad, sha256(concat(ipad, u8(msg)))));
}

/** HKDF-SHA256(RFC5869). salt 생략 = 32B 0(설계의 salt=∅ 표기와 동일). */
export function hkdf(ikm, salt, info, len) {
  const prk = hmacSha256(salt && salt.length ? salt : new Uint8Array(32), ikm);
  const out = new Uint8Array(len);
  let prev = new Uint8Array(0), o = 0, ctr = 1;
  while (o < len) {
    prev = hmacSha256(prk, concat(prev, u8(info || new Uint8Array(0)), new Uint8Array([ctr++])));
    const take = Math.min(32, len - o);
    out.set(prev.subarray(0, take), o);
    o += take;
  }
  return out;
}

// ── SHA-512 (ed25519 전용) ─────────────────────────────────────
const M64 = (1n << 64n) - 1n;
const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc',
  '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
  '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65',
  '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4',
  'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
  '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30',
  'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
  '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178',
  '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c',
  '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((h) => BigInt('0x' + h));
const H512_0 = [
  '6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1',
  '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179',
].map((h) => BigInt('0x' + h));
const rotr64 = (x, n) => (((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64);

export function sha512(msg) {
  const m = u8(msg);
  const H = H512_0.slice();
  const total = (m.length + 17 + 127) & ~127;
  const buf = new Uint8Array(total);
  buf.set(m);
  buf[m.length] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = m.length * 8;
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);
  const w = new Array(80);
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) {
      w[i] = (BigInt(dv.getUint32(off + i * 8)) << 32n) | BigInt(dv.getUint32(off + i * 8 + 4));
    }
    for (let i = 16; i < 80; i++) {
      const a1 = w[i - 15], b1 = w[i - 2];
      const s0 = rotr64(a1, 1) ^ rotr64(a1, 8) ^ (a1 >> 7n);
      const s1 = rotr64(b1, 19) ^ rotr64(b1, 61) ^ (b1 >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (h + S1 + ch + K512[i] + w[i]) & M64;
      const S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) & M64;
      h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    const nx = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) H[i] = (H[i] + nx[i]) & M64;
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    let v = H[i];
    for (let j = 7; j >= 0; j--) { out[i * 8 + j] = Number(v & 0xffn); v >>= 8n; }
  }
  return out;
}

// ── ChaCha20-Poly1305 (IETF, RFC 8439) ─────────────────────────
function chachaBlock(key32, counter, nonce12, out64) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  const kdv = new DataView(key32.buffer, key32.byteOffset, 32);
  for (let i = 0; i < 8; i++) s[4 + i] = kdv.getUint32(i * 4, true);
  s[12] = counter >>> 0;
  const ndv = new DataView(nonce12.buffer, nonce12.byteOffset, 12);
  s[13] = ndv.getUint32(0, true); s[14] = ndv.getUint32(4, true); s[15] = ndv.getUint32(8, true);
  const x = new Uint32Array(s);
  const QR = (a, b, c, d) => {
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotr32(x[d] ^ x[a], 16);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotr32(x[b] ^ x[c], 20);
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotr32(x[d] ^ x[a], 24);
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotr32(x[b] ^ x[c], 25);
  };
  for (let i = 0; i < 10; i++) {
    QR(0, 4, 8, 12); QR(1, 5, 9, 13); QR(2, 6, 10, 14); QR(3, 7, 11, 15);
    QR(0, 5, 10, 15); QR(1, 6, 11, 12); QR(2, 7, 8, 13); QR(3, 4, 9, 14);
  }
  const odv = new DataView(out64.buffer, out64.byteOffset, 64);
  for (let i = 0; i < 16; i++) odv.setUint32(i * 4, (x[i] + s[i]) >>> 0, true);
}

function chacha20Xor(key32, counter0, nonce12, data) {
  const out = new Uint8Array(data.length);
  const blk = new Uint8Array(64);
  for (let o = 0; o < data.length; o += 64) {
    chachaBlock(key32, (counter0 + o / 64) >>> 0, nonce12, blk);
    const n = Math.min(64, data.length - o);
    for (let i = 0; i < n; i++) out[o + i] = data[o + i] ^ blk[i];
  }
  return out;
}

const P1305 = (1n << 130n) - 5n;
function poly1305(key32, msg) {
  let r = 0n, s = 0n;
  for (let i = 15; i >= 0; i--) r = (r << 8n) | BigInt(key32[i]);
  r &= 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  for (let i = 31; i >= 16; i--) s = (s << 8n) | BigInt(key32[i]);
  let acc = 0n;
  for (let o = 0; o < msg.length; o += 16) {
    const n = Math.min(16, msg.length - o);
    let blk = 0n;
    for (let i = n - 1; i >= 0; i--) blk = (blk << 8n) | BigInt(msg[o + i]);
    blk |= 1n << BigInt(8 * n);
    acc = ((acc + blk) * r) % P1305;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { tag[i] = Number(acc & 0xffn); acc >>= 8n; }
  return tag;
}
const pad16 = (n) => (n % 16 === 0 ? 0 : 16 - (n % 16));
function polyInput(aad, ct) {
  const a = u8(aad || new Uint8Array(0));
  const lens = new Uint8Array(16);
  const dv = new DataView(lens.buffer);
  dv.setUint32(0, a.length >>> 0, true);
  dv.setUint32(4, Math.floor(a.length / 4294967296), true);
  dv.setUint32(8, ct.length >>> 0, true);
  dv.setUint32(12, Math.floor(ct.length / 4294967296), true);
  return concat(a, new Uint8Array(pad16(a.length)), ct, new Uint8Array(pad16(ct.length)), lens);
}

/** AEAD 봉인 → ct||tag(16B). key=32B, nonce=12B. */
export function aeadSeal(key, nonce, aad, plaintext) {
  const k = u8(key), n = u8(nonce), pt = u8(plaintext);
  if (k.length !== 32 || n.length !== 12) throw new Error('aead: 키/논스 길이 오류');
  const polyKey = new Uint8Array(64);
  chachaBlock(k, 0, n, polyKey);
  const ct = chacha20Xor(k, 1, n, pt);
  const tag = poly1305(polyKey.subarray(0, 32), polyInput(aad, ct));
  return concat(ct, tag);
}
/** AEAD 개봉 → 평문 | null(태그 불일치·길이 부족). **절대 예외로 흘리지 않는다**(호출부가 폴백 판단). */
export function aeadOpen(key, nonce, aad, sealed) {
  const k = u8(key), n = u8(nonce), s = u8(sealed);
  if (k.length !== 32 || n.length !== 12 || s.length < 16) return null;
  const ct = s.subarray(0, s.length - 16);
  const tag = s.subarray(s.length - 16);
  const polyKey = new Uint8Array(64);
  chachaBlock(k, 0, n, polyKey);
  if (!ctEq(tag, poly1305(polyKey.subarray(0, 32), polyInput(aad, ct)))) return null;
  return chacha20Xor(k, 1, n, ct);
}

// ── X25519 (RFC 7748) ─────────────────────────────────────────
const P25519 = (1n << 255n) - 19n;
const A24 = 121665n;
function fpow(b, e, m) {
  let r = 1n, x = b % m;
  let k = e;
  while (k > 0n) { if (k & 1n) r = (r * x) % m; x = (x * x) % m; k >>= 1n; }
  return r;
}
const finv = (a) => fpow(a, P25519 - 2n, P25519);
function leToBig(b) { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; }
function bigToLe(v, n) { const o = new Uint8Array(n); let x = v; for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; }

export function x25519(scalar, point) {
  const k = copyOf(scalar, 0, 32);
  if (k.length !== 32) throw new Error('x25519: 스칼라 32B');
  k[0] &= 248; k[31] &= 127; k[31] |= 64;
  const kk = leToBig(k);
  const up = copyOf(point, 0, 32);
  up[31] &= 127; // RFC 7748: 최상위 비트 마스크
  const x1 = leToBig(up) % P25519;
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
  for (let t = 254; t >= 0; t--) {
    const kt = (kk >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap) { const a = x2; x2 = x3; x3 = a; const b = z2; z2 = z3; z3 = b; }
    swap = kt;
    const A = (x2 + z2) % P25519;
    const AA = (A * A) % P25519;
    const B = (x2 - z2 + P25519) % P25519;
    const BB = (B * B) % P25519;
    const E = (AA - BB + P25519) % P25519;
    const C = (x3 + z3) % P25519;
    const D = (x3 - z3 + P25519) % P25519;
    const DA = (D * A) % P25519;
    const CB = (C * B) % P25519;
    const t1 = (DA + CB) % P25519;
    const t2 = (DA - CB + P25519) % P25519;
    x3 = (t1 * t1) % P25519;
    z3 = (x1 * ((t2 * t2) % P25519)) % P25519;
    x2 = (AA * BB) % P25519;
    z2 = (E * ((AA + ((A24 * E) % P25519)) % P25519)) % P25519;
  }
  if (swap) { const a = x2; x2 = x3; x3 = a; const b = z2; z2 = z3; z3 = b; }
  return bigToLe((x2 * finv(z2)) % P25519, 32);
}
const X25519_BASE = (() => { const b = new Uint8Array(32); b[0] = 9; return b; })();
export function x25519Public(priv) { return x25519(priv, X25519_BASE); }
export function x25519Keypair() {
  const priv = randomBytes(32);
  return { priv, pub: x25519Public(priv) };
}

// ── Ed25519 (RFC 8032) ────────────────────────────────────────
const ED_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const ED_L = (1n << 252n) + 27742317777372353535851937790883648493n;
const ED_I = 19681161376707505956807079304988542015446066515923890162744021073123829784752n; // sqrt(-1)
const ED_BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const ED_BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
const mod = (a) => ((a % P25519) + P25519) % P25519;

// 확장 좌표 (X:Y:Z:T), T = XY/Z
function edAdd(p, q) {
  const [X1, Y1, Z1, T1] = p, [X2, Y2, Z2, T2] = q;
  const A = mod((Y1 - X1) * (Y2 - X2));
  const B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(T1 * 2n * ED_D * T2);
  const D = mod(Z1 * 2n * Z2);
  const E = B - A, F = D - C, G = D + C, H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function edMul(p, n) {
  let q = [0n, 1n, 1n, 0n], d = p, k = n;
  while (k > 0n) {
    if (k & 1n) q = edAdd(q, d);
    d = edAdd(d, d);
    k >>= 1n;
  }
  return q;
}
const ED_B = [ED_BX, ED_BY, 1n, mod(ED_BX * ED_BY)];
function edEncode(p) {
  const zi = finv(p[2]);
  const x = mod(p[0] * zi), y = mod(p[1] * zi);
  const out = bigToLe(y, 32);
  out[31] |= Number(x & 1n) << 7;
  return out;
}
function edDecode(bytes) {
  const b = u8(bytes);
  if (b.length !== 32) return null;
  const yb = copyOf(b);
  const sign = (yb[31] >> 7) & 1;
  yb[31] &= 127;
  const y = leToBig(yb);
  if (y >= P25519) return null;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n), v = mod(ED_D * y2 + 1n);
  const x2 = mod(u * finv(v));
  let x = fpow(x2, (P25519 + 3n) / 8n, P25519);
  if (mod(x * x) !== x2) x = mod(x * ED_I);
  if (mod(x * x) !== x2) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return [x, y, 1n, mod(x * y)];
}
function edEq(p, q) {
  const zi1 = finv(p[2]), zi2 = finv(q[2]);
  return mod(p[0] * zi1) === mod(q[0] * zi2) && mod(p[1] * zi1) === mod(q[1] * zi2);
}
function clampEd(h) {
  const a = copyOf(h, 0, 32);
  a[0] &= 248; a[31] &= 127; a[31] |= 64;
  return leToBig(a);
}
/** priv = seed(32) — node crypto 의 ed25519 개인키 seed 와 동일. 반환 pub 32B. */
export function ed25519Public(seed32) {
  const h = sha512(u8(seed32).subarray(0, 32));
  return edEncode(edMul(ED_B, clampEd(h)));
}
export function ed25519Keypair() {
  const seed = randomBytes(32);
  return { seed, pub: ed25519Public(seed) };
}
/** 개인키 = seed(32) 또는 seed||pub(64). 반환 서명 64B. */
export function ed25519Sign(priv, msg) {
  const p = u8(priv);
  const seed = p.subarray(0, 32);
  const m = u8(msg);
  const h = sha512(seed);
  const a = clampEd(h);
  const pub = p.length >= 64 ? p.subarray(32, 64) : edEncode(edMul(ED_B, a));
  const r = leToBig(sha512(concat(h.subarray(32, 64), m))) % ED_L;
  const R = edEncode(edMul(ED_B, r));
  const k = leToBig(sha512(concat(R, pub, m))) % ED_L;
  const S = (r + k * a) % ED_L;
  return concat(R, bigToLe(S, 32));
}
export function ed25519Verify(pub, msg, sig) {
  try {
    const A = edDecode(pub);
    const s = u8(sig);
    if (!A || s.length !== 64) return false;
    const R = edDecode(s.subarray(0, 32));
    if (!R) return false;
    const S = leToBig(s.subarray(32, 64));
    if (S >= ED_L) return false;
    const k = leToBig(sha512(concat(s.subarray(0, 32), u8(pub), u8(msg)))) % ED_L;
    // 8[S]B == 8R + 8[k]A (코팩터 형태 — 작은 부분군 공격 여지 제거)
    const lhs = edMul(ED_B, S * 8n);
    const rhs = edAdd(edMul(R, 8n), edMul(A, k * 8n));
    return edEq(lhs, rhs);
  } catch (_) { return false; }
}

export default {
  SUITE, b64uEnc, b64uDec, utf8, fromUtf8, concat, copyOf, ctEq, u8,
  setRandomSource, hasRandomSource, randomBytes,
  sha256, sha512, hmacSha256, hkdf, aeadSeal, aeadOpen,
  x25519, x25519Public, x25519Keypair,
  ed25519Public, ed25519Keypair, ed25519Sign, ed25519Verify,
};
