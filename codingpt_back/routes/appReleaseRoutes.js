// 모바일 앱 릴리스 — 최신 스토어 버전 확인(공개, 무인증. 시크릿 없음).
//  앱이 "업데이트 확인" 시 이 값을 자기 버전과 비교 → 더 높으면 "업데이트" 버튼으로 스토어 이동.
//  스토어 게시 버전은 사람이 배포할 때 back .env 로 갱신한다(APP_LATEST_*, APP_STORE_URL_*).
const express = require('express');
const router = express.Router();
const { successResponse } = require('../utils/response');

const ANDROID_PKG = 'com.ghmate.codingpt.app';

// GET /api/app/version[?platform=ios|android]
router.get('/version', (req, res) => {
  const android = {
    version: process.env.APP_LATEST_ANDROID || '0.1.0',
    url: process.env.APP_STORE_URL_ANDROID || `https://play.google.com/store/apps/details?id=${ANDROID_PKG}`,
  };
  const ios = {
    version: process.env.APP_LATEST_IOS || '0.1.0',
    // App Store 게시 후 APP_STORE_URL_IOS 채우기(그전엔 검색 폴백).
    url: process.env.APP_STORE_URL_IOS || 'https://apps.apple.com/search?term=CodingPT',
  };
  const p = String(req.query.platform || '').toLowerCase();
  if (p === 'ios') return successResponse(res, ios);
  if (p === 'android') return successResponse(res, android);
  return successResponse(res, { ios, android });
});

module.exports = router;
