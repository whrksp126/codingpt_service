'use client';

// M5-웹 W4 — 클라우드 러너 핸드오프 오케스트레이션(앱 useCloudHandoff 웹 이식).
//  라우팅 두 축: 활성 러너(activeRunnerId) + 폴더(cwd). 웹은 제어 서피스라 CLOUD 러너를 주로 씀
//  (사용자가 PC 데몬을 돌리면 로컬 러너로도 잡히지만, 브라우저 자체는 러너가 아님).
//  핸드오프 = 체크포인트 → 러너 확보/활성 → materialize(조건부) → cwd 반환(useAgentSession cwd 로 소비).
//  앱의 handoffToLocal(내 PC 복귀)은 앱 중심이라 웹 v1 엔 생략.

import { useCallback, useRef, useState } from 'react';
import daemon from '../lib/daemon';
import type { WorkspaceMeta } from '../lib/agentTypes';

export type HandoffPhase = null | 'checkpoint' | 'ensure' | 'waking' | 'activate' | 'materialize' | 'enter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 클라우드 러너 작업 폴더명 — 웹 워크스페이스는 localPath 가 없으므로 id 를 sanitize.
export function cloudCwdForWorkspace(ws: { id: string; localPath?: string }): string {
  const base = (ws.localPath || '').replace(/\/+$/, '').split('/').pop();
  return (base || ws.id).replace(/[^A-Za-z0-9_.-]/g, '-');
}

// 특정 러너(deviceId+kind)가 relay 에 연결될 때까지 상태 폴링(기본 45s).
async function waitRunnerConnected(runnerId: number, kind: 'local' | 'cloud', timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await daemon.getStatus().catch(() => null);
    if (st?.runners?.some((r) => r.deviceId === runnerId && r.kind === kind)) return true;
    await sleep(1500);
  }
  return false;
}

export function useCloudHandoff() {
  const [phase, setPhase] = useState<HandoffPhase>(null);
  const [message, setMessage] = useState('');
  // 핸드오프 후 클라우드 러너가 로그아웃 상태면 로그인 시트를 띄우도록 신호(runnerId 지정 로그인).
  const [pendingCloudLogin, setPendingCloudLogin] = useState<{ runnerId: number } | null>(null);
  const clearCloudLogin = useCallback(() => setPendingCloudLogin(null), []);
  const busyRef = useRef(false);

  // 워크스페이스 → 클라우드 러너 확보/활성 전환 → cwd 반환. skipCheckpoint: 오프라인이면 head 로 복원.
  const handoffToCloud = useCallback(async (
    ws: WorkspaceMeta,
    opts?: { skipCheckpoint?: boolean },
  ): Promise<{ cwd: string; runnerId: number } | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    try {
      // 1. 현재 상태 스냅샷(온라인일 때만).
      if (!opts?.skipCheckpoint) {
        setPhase('checkpoint'); setMessage('현재 상태 저장 중…');
        await daemon.syncCheckpoint(ws.id, 'handoff').catch(() => { /* 스냅샷 실패해도 최신 head 로 진행 */ });
      }
      // 2. 이미 연결된 클라우드 러너 재사용, 없으면 ensure(프로비저닝+기동/동면 깨우기).
      setPhase('ensure'); setMessage('클라우드 준비 중…');
      const st = await daemon.getStatus().catch(() => null);
      let runnerId = st?.runners?.find((r) => r.kind === 'cloud')?.deviceId;
      let dataPresent = false;
      if (!runnerId) {
        const e = await daemon.ensureCloudRunner(ws.id);
        runnerId = e.runnerId;
        dataPresent = !!e.wasDormant; // 동면 복귀 = 볼륨에 코드·크레덴셜 잔존(콜드스타트)
        if (e.needsManualRun) setMessage('개발용: 컨테이너 수동 기동 대기 중…');
      } else {
        dataPresent = true; // 이미 연결된 클라우드 러너 = 볼륨에 코드 존재
      }
      // 3. 러너 연결 대기.
      setPhase('waking'); setMessage(dataPresent ? '환경 깨우는 중…' : '클라우드 준비 중…');
      const ok = await waitRunnerConnected(runnerId!, 'cloud');
      if (!ok) throw new Error('클라우드 러너 연결 시간이 초과됐어요.');
      // 4. 활성 러너 = 클라우드.
      setPhase('activate');
      await daemon.activateRunner({ kind: 'cloud' });
      // 5. 최초 이동만 materialize. 동면 복귀/재사용은 볼륨에 코드가 있어 생략.
      const cwd = cloudCwdForWorkspace(ws);
      if (!dataPresent) {
        setPhase('materialize'); setMessage('작업 폴더 복원 중…');
        const r = await daemon.syncMaterialize(ws.id, { targetCwd: cwd });
        if (r.conflict) throw new Error('동기화 충돌이 있어요 — 잠시 후 파일을 선택해 해결해 주세요.');
      }
      // 6. 클라우드 러너가 아직 로그아웃이면(프레시 컨테이너) 로그인 시트 유도.
      setPhase('enter');
      const ls = await daemon.agentLoginStatus({ runnerId }).catch(() => ({ loggedIn: true } as { loggedIn: boolean }));
      if (!ls.loggedIn) setPendingCloudLogin({ runnerId: runnerId! });
      return { cwd, runnerId: runnerId! };
    } finally {
      busyRef.current = false; setPhase(null); setMessage('');
    }
  }, []);

  return { phase, message, handoffToCloud, pendingCloudLogin, clearCloudLogin };
}

export default useCloudHandoff;
