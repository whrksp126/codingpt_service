// 토큰 갱신 폭주가 로그인을 잠그지 못하게 하는 회귀 테스트 — DB 무접촉(위조 토큰은 jwt.verify 에서 끝난다).
//  실행: node --test test/auth-refresh-limit.test.js
//
//  2026-09-07 사고 재현 방지:
//   계정을 지웠더니 폰이 죽은 refreshToken 으로 분당 40여 건을 두들겼고, /refresh 와 /login 이
//   한 버킷(IP당 15분 30회)이라 같은 IP 의 PC 가 "요청이 너무 많습니다"로 **로그인조차 못 했다**.
//   여기서 지키는 계약 두 가지:
//    (1) /refresh 를 한도까지 태워도 /login 은 429 가 아니다 (버킷 분리)
//    (2) 되살아날 수 없는 토큰은 401 + detail.code=REFRESH_INVALID (클라가 재시도를 멈출 근거)
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// 라우터가 끌어오는 모듈들이 기동 시 시크릿 부재를 거부한다 — 테스트용 더미로 채운다(DB 는 건드리지 않는다).
process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';
process.env.REFRESH_SECRET = process.env.REFRESH_SECRET || 'test-refresh-secret';

const userRoutes = require('../routes/userRoutes');

const listen = async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/users', userRoutes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
};

const post = (base, path, body, ip) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });

test('죽은 refreshToken 은 401 + REFRESH_INVALID 로 내려간다 (클라가 포기할 근거)', async () => {
  const { server, base } = await listen();
  try {
    const res = await post(base, '/api/users/refresh', { refreshToken: 'not-a-real-jwt' }, '203.0.113.10');
    assert.strictEqual(res.status, 401, '위조 토큰은 일시 실패(400)가 아니라 영구 실패(401)다');
    const body = await res.json();
    assert.strictEqual(body.detail && body.detail.code, 'REFRESH_INVALID');

    // 토큰이 아예 없는 경우도 같은 영구 실패로 취급된다.
    const empty = await post(base, '/api/users/refresh', {}, '203.0.113.11');
    assert.strictEqual(empty.status, 401);
    assert.strictEqual((await empty.json()).detail.code, 'REFRESH_INVALID');
  } finally {
    server.close();
  }
});

test('refresh 를 한도까지 태워도 같은 IP 의 login 은 잠기지 않는다 (버킷 분리)', async () => {
  const { server, base } = await listen();
  const ip = '203.0.113.20';
  try {
    // 갱신 버킷(15분 120회)을 넘길 때까지 두들긴다 — 실제 사고에서 폰이 한 짓.
    let sawRefresh429 = false;
    for (let i = 0; i < 130; i += 1) {
      const res = await post(base, '/api/users/refresh', { refreshToken: 'dead' }, ip);
      if (res.status === 429) { sawRefresh429 = true; break; }
      await res.arrayBuffer();
    }
    assert.ok(sawRefresh429, '갱신 폭주는 갱신 버킷에서 막혀야 한다');

    // ★ 핵심: 그 상태에서도 로그인은 레이트리밋에 걸리지 않는다.
    const login = await post(base, '/api/users/login', { idToken: 'x' }, ip);
    assert.notStrictEqual(login.status, 429, 'refresh 폭주가 login 버킷을 태우면 안 된다');
  } finally {
    server.close();
  }
});
