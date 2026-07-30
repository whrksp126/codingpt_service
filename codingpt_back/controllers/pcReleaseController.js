/**
 * PC 앱 릴리스 컨트롤러 — 자동 업데이트 확인 + 배포물 다운로드(공개, 무인증).
 *  Tauri updater 프로토콜: 업데이트 있음=200 JSON, 최신=204 No Content.
 */
const pcReleaseService = require('../services/pcReleaseService');
const { errorResponse } = require('../utils/response');

// GET /api/pc/update/:target/:arch/:version
async function update(req, res) {
  try {
    const { target, arch, version } = req.params;
    if (!/^[a-z0-9]+$/i.test(target) || !/^[a-z0-9_]+$/i.test(arch) || !/^[0-9][0-9a-z.\-]*$/i.test(version)) {
      return res.status(400).json({ message: '잘못된 파라미터' });
    }
    const manifest = await pcReleaseService.updateManifest(target, arch, version);
    if (!manifest) return res.status(204).end();
    return res.json(manifest); // updater 프로토콜 — 응답 포맷 헬퍼(successResponse 래핑) 사용 금지
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// GET /api/pc/dl/*  — objectstore pc-releases/ 이하를 스트리밍(대용량, 메모리 비적재).
async function download(req, res) {
  try {
    const rel = String(req.params[0] || '');
    // 경로 화이트리스트 — 세그먼트 문자 제한 + 상위 탈출 금지.
    if (!rel || rel.includes('..') || !/^[A-Za-z0-9._\-/]+$/.test(rel)) {
      return res.status(400).json({ message: '잘못된 경로' });
    }
    const f = await pcReleaseService.streamFile(rel);
    // CodingPT.dmg는 릴리스 때마다 내용이 바뀌는 최신판 별칭이다. CDN이 이 경로를 캐시하면
    // 새로 설치해도 구버전이 내려가므로 모든 캐시 계층에 저장 금지를 명시한다.
    if (rel === 'CodingPT.dmg') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('CDN-Cache-Control', 'no-store');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
      res.setHeader('Surrogate-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    res.setHeader('Content-Type', f.contentType);
    if (f.contentLength) res.setHeader('Content-Length', f.contentLength);
    res.setHeader('Content-Disposition', `attachment; filename="${rel.split('/').pop()}"`);
    f.body.on('error', () => { try { res.destroy(); } catch (_) { /* noop */ } });
    f.body.pipe(res);
  } catch (e) {
    const code = e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) ? 404 : 500;
    return errorResponse(res, code === 404 ? new Error('파일을 찾을 수 없습니다.') : e, code);
  }
}

module.exports = { update, download };
