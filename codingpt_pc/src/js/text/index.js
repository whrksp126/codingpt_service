import * as i18n from '../i18n/index.js';
// text/ — 화면 문구를 기능별 한 파일로 모아 두는 자리.
//
// 2026-08-05 다국어(7종)를 켜면서 **번역 계층은 `js/i18n/` 하나로 통일**했다. 여기 사전들은
//  이제 "한국어 원문 모음"일 뿐이고, 실제 언어 선택은 `tx()` 가 `i18n.t()` 로 넘긴다.
//  (예전엔 이 파일이 `{ko, en}` 두 벌을 직접 골랐다 — 두 메커니즘이 공존하면 새 화면은 이쪽,
//   옛 화면은 저쪽이 된다. 옛 `en` 값들은 지우기 전에 전부 카탈로그로 회수했다.)
//
// 규율:
//  · 값에 문장 조립(`'파일 ' + n + '개'`)을 넣지 않는다 → 함수 값이거나 `t('파일 {n}개', {n})`.
//  · 새 문구는 여기 넣든 화면에서 `t('…')` 로 바로 쓰든 상관없다. 어느 쪽이든 같은 사전을 탄다.
//
// ⚠ 앱(`codingpt_app/src/text/index.ts`)에 같은 구조가 있다.

const cache = new WeakMap();

/**
 * 사전을 **읽는 순간** 번역해 주는 껍데기.
 *
 * 왜 미리 안 바꾸고 접근할 때 바꾸나: 호출부가 `const TX = tx(DICT)` 를 **모듈 최상위**에서 한다.
 *  그 시점엔 아직 언어가 안 정해져 있다(설정을 읽기 전) → 미리 바꾸면 영원히 한국어로 굳는다.
 *  프록시로 미루면 실제로 화면을 그릴 때 번역된다.
 */
function lazy(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const hit = cache.get(obj);
  if (hit) return hit;
  const proxy = new Proxy(obj, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v === "string") return i18n.t(v);
      if (v && typeof v === "object") return lazy(v);
      return v;   // 함수 값은 그대로 — 안에서 t() 를 부르는 건 그 함수의 몫이다
    },
  });
  cache.set(obj, proxy);
  return proxy;
}

/** 사전 → 지금 언어의 문구 묶음. */
export function tx(dict) {
  if (!dict) return {};
  return lazy(dict.ko) || {};
}
