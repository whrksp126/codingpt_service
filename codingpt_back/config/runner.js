// 러너 제공 정책 플래그.
//
// CLOUD_RUNNER_ENABLED — 클라우드 러너(우리가 호스팅하는 실행환경) 제공 on/off. 기본 false.
//  서비스 방향을 "사용자 자신의 PC 여러 대 ↔ 모바일/태블릿 원격 조작"(BYO)으로 좁히며 잠정 중단.
//  코드는 전부 보존 — env 로 스위치 온 하면 그대로 부활한다.
//
//  off 일 때 막히는 것:
//   · POST /api/daemon/runner/cloud/ensure (클라우드 러너 프로비저닝/핸드오프) → 403
//   · compute:'cloud' 워크스페이스 생성 (workspaceController.create / daemonCreateWorkspace) → 403
//   · GET /api/daemon/devices 의 가상 "클라우드" 호스트 노출
//  off 여도 허용되는 것(데이터 보존·정리):
//   · 기존 클라우드 워크스페이스의 조회/목록/삭제
//   · 이미 클라우드 활성인 상태에서 로컬로 복귀(activateRunner kind:'local')
const bool = (v) => String(v || 'false').toLowerCase() === 'true';

module.exports = {
  CLOUD_ENABLED: bool(process.env.CLOUD_RUNNER_ENABLED),
};
