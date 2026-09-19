'use strict';
/**
 * H.264 SPS 에 VUI `bitstream_restriction`(재정렬 0·DPB 1) 을 덧붙인다.
 *
 * 왜: VideoToolbox 는 SPS 에 VUI 를 안 쓴다. VUI 가 없으면 하드웨어 디코더(Exynos 등)는 "최악의 재정렬 깊이" 를
 *  가정해 프레임을 4~6장 쥐고 있다 내놓는다 — 정지 화면 1fps 스트림이면 화면 변화가 **4~5초 뒤** 폰에 보였다
 *  (2026-09-20 실측: 게스트 우클릭 메뉴가 폰에는 5초 뒤에). scrcpy(안드로이드 인코더)는 이 필드를 써 주므로 폰
 *  모바일 화면은 멀쩡했다. 우리가 보내는 config 패킷(SPS+PPS)만 고치면 되고, 프레임은 손대지 않는다.
 *
 * 범위: 프로파일별 확장 필드(High 계열의 chroma/scaling) 도 읽되, scaling list 가 실제로 있으면 건너뛰기 대신
 *  **원본을 그대로** 돌려준다(우리는 Baseline 만 쓴다 — 모르는 건 만지지 않는다). 이미 VUI 가 있으면 그대로.
 */

/** 에뮬레이션 방지 바이트(00 00 03) 를 벗겨 RBSP 로. */
function unescapeRbsp(buf) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

/** RBSP → 에뮬레이션 방지 바이트 삽입(00 00 0x, x<=3 앞에 03). */
function escapeRbsp(buf) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) v = (v * 2) + this.bit(); return v; }
  bit() {
    const byte = this.buf[this.pos >> 3];
    if (byte === undefined) throw new Error('SPS 가 짧다');
    const b = (byte >> (7 - (this.pos & 7))) & 1; this.pos++; return b;
  }
  ue() { let z = 0; while (this.bit() === 0) { z++; if (z > 31) throw new Error('ue 오버플로'); } return z === 0 ? 0 : ((1 << z) - 1 + this.u(z)); }
  se() { const k = this.ue(); return (k & 1) ? (k + 1) / 2 : -(k / 2); }
}

class BitWriter {
  constructor() { this.bits = []; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1); }
  bit(b) { this.bits.push(b ? 1 : 0); }
  ue(v) { const x = v + 1; const n = 32 - Math.clz32(x); for (let i = 0; i < n - 1; i++) this.bits.push(0); this.u(n, x); }
  copyBits(reader, from, to) { const save = reader.pos; reader.pos = from; for (let i = from; i < to; i++) this.bits.push(reader.bit()); reader.pos = save; }
  toBuffer() {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * SPS NAL(헤더 바이트 포함, 시작 코드 없이) 하나를 받아 VUI bitstream_restriction 을 붙인 NAL 을 돌려준다.
 *  손댈 수 없으면(이미 VUI 있음·scaling list·파싱 실패) 원본을 그대로 돌려준다.
 */
function addBitstreamRestriction(nal) {
  try {
    if (!nal || nal.length < 4 || (nal[0] & 0x1f) !== 7) return nal;
    const rbsp = unescapeRbsp(nal.subarray(1));
    const r = new BitReader(rbsp);
    const profile = r.u(8); r.u(8); r.u(8); r.ue();          // profile · constraint · level · sps_id
    if (HIGH_PROFILES.has(profile)) {
      const chroma = r.ue(); if (chroma === 3) r.u(1);
      r.ue(); r.ue(); r.u(1);
      if (r.u(1)) return nal;                                 // scaling matrix — 만지지 않는다
    }
    r.ue();                                                   // log2_max_frame_num_minus4
    const poc = r.ue();
    if (poc === 0) r.ue();
    else if (poc === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    const maxRef = r.ue();
    r.u(1); r.ue(); r.ue();                                   // gaps · width · height
    if (!r.u(1)) r.u(1);                                      // frame_mbs_only → mb_adaptive
    r.u(1);                                                   // direct_8x8
    if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }           // cropping
    const vuiPos = r.pos;
    if (r.u(1)) return nal;                                   // VUI 가 이미 있다

    const w = new BitWriter();
    w.copyBits(r, 0, vuiPos);
    w.bit(1);                                                 // vui_parameters_present_flag
    w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0);         // aspect · overscan · video_signal · chroma_loc · timing
    w.bit(0); w.bit(0);                                       // nal_hrd · vcl_hrd
    w.bit(0);                                                 // pic_struct_present
    w.bit(1);                                                 // bitstream_restriction_flag
    w.bit(1);                                                 // motion_vectors_over_pic_boundaries
    w.ue(0); w.ue(0);                                         // max_bytes_per_pic_denom · max_bits_per_mb_denom
    w.ue(16); w.ue(16);                                       // log2_max_mv_length h/v
    w.ue(0);                                                  // ★ max_num_reorder_frames = 0 — 바로 내놓아라
    w.ue(Math.max(1, maxRef));                                // max_dec_frame_buffering
    w.bit(1); while (w.bits.length % 8) w.bit(0);             // rbsp_trailing_bits
    return Buffer.concat([Buffer.from([nal[0]]), escapeRbsp(w.toBuffer())]);
  } catch (_) { return nal; }
}

/** Annex-B 덩어리(00 00 00 01 …)를 NAL 단위로 나눈다 — [{ start, nal }]. */
function splitAnnexB(buf) {
  const out = [];
  let i = 0;
  const findStart = (from) => {
    for (let k = from; k + 2 < buf.length; k++) {
      if (buf[k] === 0 && buf[k + 1] === 0 && (buf[k + 2] === 1 || (buf[k + 2] === 0 && buf[k + 3] === 1))) return { at: k, len: buf[k + 2] === 1 ? 3 : 4 };
    }
    return null;
  };
  let s = findStart(0);
  while (s) {
    const next = findStart(s.at + s.len);
    const end = next ? next.at : buf.length;
    out.push({ start: buf.subarray(s.at, s.at + s.len), nal: buf.subarray(s.at + s.len, end) });
    i = end; s = next;
  }
  return out;
}

/** config 패킷(Annex-B SPS+PPS) 의 SPS 만 고쳐 돌려준다. */
function patchConfigPacket(buf) {
  const parts = splitAnnexB(buf);
  if (!parts.length) return buf;
  return Buffer.concat(parts.flatMap((p) => [p.start, (p.nal[0] & 0x1f) === 7 ? addBitstreamRestriction(p.nal) : p.nal]));
}

module.exports = { addBitstreamRestriction, patchConfigPacket, splitAnnexB, unescapeRbsp, escapeRbsp };
