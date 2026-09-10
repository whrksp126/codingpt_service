// enrichHosts 실동작 — 귀속 빠진 로컬 워크스페이스를 정말로 채우고 **저장까지** 하는가.
//  실행: node --test test/workspace-host-enrich.test.js
//
//  왜 소스 대조로 안 끝내는가: 응답에 hostDeviceId 가 보인다고 저장된 것은 아니다(계산값일 수 있다).
//  실서버에서 둘을 구분할 방법이 없어서(원본 메타를 그대로 주는 라우트가 없다) 여기서 갈라 확인한다.
//  s3Service 와 models 를 require 캐시에 심어 네트워크·DB 없이 돌린다.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';
process.env.REFRESH_SECRET = process.env.REFRESH_SECRET || 'test-refresh-secret';

const resolve = (rel) => require.resolve(path.join(__dirname, '..', rel));

/** require 캐시에 가짜 모듈을 심는다(로드되기 전에 호출해야 한다). */
function stub(rel, exports) {
  const id = resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
}

function load({ devices, saved }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/services/') || k.includes('/models/')) delete require.cache[k];
  }
  stub('models/index.js', { DaemonDevice: { findAll: async () => devices } });
  stub('services/daemonRelayService.js', { listRunners: () => [] });
  stub('services/s3Service.js', {
    getFileContent: async (key) => ({
      success: true,
      encoding: 'utf-8',
      content: JSON.stringify({ id: 'p-1', name: 'ws', compute: 'local' }),
      key,
    }),
    saveFile: async (key, body) => { saved.push({ key, body }); return { success: true }; },
    deleteFile: async () => ({ success: true }),
    listFiles: async () => ({ success: true, files: [] }),
  });
  return require(resolve('services/workspaceService.js'));
}

const HOST = { id: 393, device_name: 'MacBook', device_alias: null, role: 'host', runner_kind: 'local' };
const PHONE = { id: 394, device_name: 'Android', device_alias: null, role: 'controller', runner_kind: 'local' };
const CLOUD = { id: 395, device_name: '클라우드 러너', device_alias: null, role: 'host', runner_kind: 'cloud' };
const WS = { id: 'p-1', name: 'ws', compute: 'local' };

const settle = () => new Promise((r) => setTimeout(r, 20)); // fire-and-forget 저장을 기다린다

test('★ PC 가 하나뿐이면 귀속을 채우고 저장한다 (폰 사이드바에서 사라지던 그 상태의 복구)', async () => {
  const saved = [];
  const svc = load({ devices: [HOST, PHONE, CLOUD], saved });
  const [out] = await svc.enrichHosts(79, [{ ...WS }]);

  assert.strictEqual(out.hostDeviceId, 393, '응답에 귀속이 안 실렸다');
  assert.strictEqual(out.hostName, 'MacBook');

  await settle();
  assert.strictEqual(saved.length, 1, '저장이 안 됐다 — 다음 조회마다 같은 계산을 반복하게 된다');
  assert.strictEqual(JSON.parse(saved[0].body).hostDeviceId, 393);
});

test('PC 가 여럿이면 채우지도 저장하지도 않는다 (유령 워크스페이스 방지)', async () => {
  const saved = [];
  const svc = load({ devices: [HOST, { ...HOST, id: 500, device_name: 'PC2' }], saved });
  const [out] = await svc.enrichHosts(79, [{ ...WS }]);

  assert.strictEqual(out.hostDeviceId, undefined);
  await settle();
  assert.strictEqual(saved.length, 0, '추측해서 저장하면 다른 PC 목록에 유령이 생긴다');
});

test('이미 귀속된 것은 건드리지 않는다 (읽기가 매번 쓰기를 유발하면 안 된다)', async () => {
  const saved = [];
  const svc = load({ devices: [HOST, PHONE], saved });
  const [out] = await svc.enrichHosts(79, [{ ...WS, hostDeviceId: 393 }]);

  assert.strictEqual(out.hostDeviceId, 393);
  await settle();
  assert.strictEqual(saved.length, 0);
});

test('컨트롤러(폰)만 있으면 귀속할 PC 가 없다', async () => {
  const saved = [];
  const svc = load({ devices: [PHONE], saved });
  const [out] = await svc.enrichHosts(79, [{ ...WS }]);
  assert.strictEqual(out.hostDeviceId, undefined);
  await settle();
  assert.strictEqual(saved.length, 0);
});

test('클라우드 워크스페이스는 호스트 귀속 대상이 아니다', async () => {
  const saved = [];
  const svc = load({ devices: [HOST], saved });
  const [out] = await svc.enrichHosts(79, [{ id: 'p-c', name: 'c', compute: 'cloud' }]);
  assert.strictEqual(out.hostName, '클라우드');
  assert.strictEqual(out.hostDeviceId, undefined);
  await settle();
  assert.strictEqual(saved.length, 0);
});

test('저장이 실패해도 목록은 그대로 나간다 (읽기 경로가 쓰기에 죽지 않는다)', async () => {
  const saved = [];
  const svc = load({ devices: [HOST], saved });
  const s3 = require(resolve('services/s3Service.js'));
  s3.saveFile = async () => ({ success: false, message: 'objectstore 장애' });

  const [out] = await svc.enrichHosts(79, [{ ...WS }]);
  assert.strictEqual(out.hostDeviceId, 393, '저장 실패가 응답까지 망가뜨렸다');
  await settle(); // 처리되지 않은 거부가 있으면 여기서 프로세스가 죽는다
});
