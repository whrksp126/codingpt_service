// 모바일 앱 릴리스 — 최신 스토어 버전 확인(공개, 무인증. 시크릿 없음).
//  앱이 "업데이트 확인" 시 이 값을 자기 버전과 비교 → 더 높으면 "업데이트" 버튼으로 스토어 이동.
//  스토어 게시 버전은 사람이 배포할 때 back .env 로 갱신한다(APP_LATEST_*, APP_STORE_URL_*).
const express = require('express');
const router = express.Router();
const { successResponse } = require('../utils/response');

const ANDROID_PKG = 'com.ghmate.codingpt.app';
// App Store 앱 ID(2026-07-27 심사 통과). env 미설정 시의 기본값이 **실제 설치 페이지**여야 한다 —
//  전엔 `apps.apple.com/search?term=CodingPT` 검색 URL 이 기본이라, prod .env 에 APP_STORE_URL_IOS 를
//  넣지 않으면 사용자가 검색 결과 화면으로 떨어졌다(에러 없이 "설치 페이지를 못 찾는" 조용한 실패).
//  ★ 이 링크는 3곳이 같은 값이어야 한다: 여기 · 랜딩 `codingpt_front/app/(public)/page.tsx`
//    · PC `codingpt_pc/src/js/store-qr.js`(QR 이미지까지 재생성 필요).
const IOS_APP_ID = '6751457159';

// GET /api/app/version[?platform=ios|android]
router.get('/version', (req, res) => {
  const android = {
    version: process.env.APP_LATEST_ANDROID || '0.1.0',
    url: process.env.APP_STORE_URL_ANDROID || `https://play.google.com/store/apps/details?id=${ANDROID_PKG}`,
  };
  const ios = {
    version: process.env.APP_LATEST_IOS || '0.1.0',
    url: process.env.APP_STORE_URL_IOS || `https://apps.apple.com/app/id${IOS_APP_ID}`,
  };
  const p = String(req.query.platform || '').toLowerCase();
  if (p === 'ios') return successResponse(res, ios);
  if (p === 'android') return successResponse(res, android);
  return successResponse(res, { ios, android });
});

module.exports = router;
