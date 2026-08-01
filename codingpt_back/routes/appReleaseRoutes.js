// 모바일 앱 릴리스 — 최신 스토어 버전 확인(공개, 무인증. 시크릿 없음).
//  앱이 "업데이트 확인" 시 이 값을 자기 버전과 비교 → 더 높으면 "업데이트" 버튼으로 스토어 이동.
//  값의 정본·자동 감지 규칙은 services/appReleaseService.js 주석 참조(iOS 자동, Android 는 env).
const express = require('express');
const router = express.Router();
const { successResponse } = require('../utils/response');
const appRelease = require('../services/appReleaseService');

// GET /api/app/version[?platform=ios|android]
//  응답: { version, url, minVersion?, source }  (platform 미지정이면 { ios, android })
router.get('/version', async (req, res) => {
  const p = String(req.query.platform || '').toLowerCase();
  try {
    if (p === 'ios' || p === 'android') return successResponse(res, await appRelease.latestFor(p));
    const [ios, android] = await Promise.all([appRelease.latestFor('ios'), appRelease.latestFor('android')]);
    return successResponse(res, { ios, android });
  } catch (_) {
    // 이 API 는 앱 부팅 경로에서 불린다 — 어떤 이유로도 5xx 를 내지 않는다(안내를 못 할 뿐).
    return successResponse(res, { version: '0.1.0', url: '', source: 'default' });
  }
});

module.exports = router;
