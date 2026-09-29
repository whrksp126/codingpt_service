'use strict';
// qcow2 → raw 변환(읽기 전용) — 외부 도구(qemu-img) 없이 Ubuntu 클라우드 이미지를 lume 의 raw disk.img 로.
//  에이전트 PC(Linux) 이미지 준비에 쓴다. qcow2 v2/v3, 64KB 클러스터, zlib 압축 클러스터, 미할당(0) 지원.
//  backing file 은 지원 안 함(클라우드 이미지는 없음 — 있으면 에러). 결과는 sparse(ftruncate + 필요한 클러스터만 write).
const fs = require('fs');
const zlib = require('zlib');

const L2E_OFFSET_MASK = 0x00fffffffffffe00n;   // 언압축 클러스터 host offset 비트
const QCOW_OFLAG_COMPRESSED = 1n << 62n;
const QCOW_OFLAG_ZERO = 1n << 0n;              // v3 표준 0 클러스터

/** qcow2 파일 → raw 파일. 진행 콜백(0~1) 선택. virtualSize 를 돌려준다. */
function convert(srcPath, dstPath, onProgress) {
  const fd = fs.openSync(srcPath, 'r');
  try {
    const head = Buffer.alloc(104);
    fs.readSync(fd, head, 0, 104, 0);
    if (head.readUInt32BE(0) !== 0x514649fb) throw new Error('qcow2 매직이 아니에요');
    const version = head.readUInt32BE(4);
    const backingOffset = head.readBigUInt64BE(8);
    if (backingOffset !== 0n) throw new Error('backing file 이 있는 qcow2 는 지원하지 않아요');
    const clusterBits = head.readUInt32BE(20);
    const clusterSize = 1 << clusterBits;
    const virtualSize = Number(head.readBigUInt64BE(24));
    const l1Size = head.readUInt32BE(36);
    const l1Offset = Number(head.readBigUInt64BE(40));
    const l2Entries = clusterSize / 8;             // L2 테이블 한 개의 엔트리 수
    const csectorBits = clusterBits - 8;           // 압축 디스크립터의 sector 카운트 비트폭

    const out = fs.openSync(dstPath, 'w');
    try {
      fs.ftruncateSync(out, virtualSize);          // sparse 파일 크기 확정

      const l1 = Buffer.alloc(l1Size * 8);
      fs.readSync(fd, l1, 0, l1.length, l1Offset);
      const cluster = Buffer.alloc(clusterSize);
      const compBuf = Buffer.alloc(clusterSize * 2);
      let done = 0; const totalClusters = Math.ceil(virtualSize / clusterSize); let written = 0; let lastPct = -1;

      for (let l1i = 0; l1i < l1Size; l1i++) {
        const l1e = l1.readBigUInt64BE(l1i * 8);
        const l2Offset = Number(l1e & L2E_OFFSET_MASK);
        if (l2Offset === 0) { done += l2Entries; continue; }   // L2 없음 = 전부 0
        const l2 = Buffer.alloc(clusterSize);
        fs.readSync(fd, l2, 0, clusterSize, l2Offset);
        for (let l2i = 0; l2i < l2Entries; l2i++) {
          const guestOff = (l1i * l2Entries + l2i) * clusterSize;
          if (guestOff >= virtualSize) break;
          const l2e = l2.readBigUInt64BE(l2i * 8);
          done++;
          if (l2e === 0n) continue;                             // 미할당 = 0(sparse)
          if (l2e & QCOW_OFLAG_ZERO && !(l2e & QCOW_OFLAG_COMPRESSED)) continue;  // 명시적 0
          if (l2e & QCOW_OFLAG_COMPRESSED) {
            // 압축: [offset(하위 x비트)][nb_sectors(csectorBits 비트)]. x = 62 - csectorBits
            const x = 62 - csectorBits;
            const desc = l2e & ((1n << 62n) - 1n);
            const hostOff = Number(desc & ((1n << BigInt(x)) - 1n));
            const nbSectors = Number((desc >> BigInt(x)) & ((1n << BigInt(csectorBits)) - 1n)) + 1;
            const readLen = nbSectors * 512 - (hostOff & 511);
            const clen = Math.min(readLen, compBuf.length);
            fs.readSync(fd, compBuf, 0, clen, hostOff);
            let raw;
            try { raw = zlib.inflateRawSync(compBuf.subarray(0, clen)); }
            catch (e) { throw new Error(`압축 클러스터 해제 실패 @${guestOff}: ${e.message}`); }
            const w = raw.subarray(0, clusterSize);
            fs.writeSync(out, w, 0, w.length, guestOff); written++;
          } else {
            const hostOff = Number(l2e & L2E_OFFSET_MASK);
            if (hostOff === 0) continue;
            fs.readSync(fd, cluster, 0, clusterSize, hostOff);
            const n = Math.min(clusterSize, virtualSize - guestOff);
            fs.writeSync(out, cluster, 0, n, guestOff); written++;
          }
        }
        if (onProgress) { const pct = Math.floor((done / totalClusters) * 100); if (pct !== lastPct) { lastPct = pct; onProgress(done / totalClusters); } }
      }
      return { virtualSize, clustersWritten: written, version };
    } finally { fs.closeSync(out); }
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  const [, , src, dst] = process.argv;
  if (!src || !dst) { console.error('사용법: node qcow2-to-raw.js <src.qcow2> <dst.raw>'); process.exit(2); }
  const r = convert(src, dst, (p) => process.stderr.write(`\r변환 ${(p * 100).toFixed(0)}%  `));
  process.stderr.write('\n');
  console.log(JSON.stringify(r));
}

module.exports = { convert };
