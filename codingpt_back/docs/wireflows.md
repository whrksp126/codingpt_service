# 와이어플로우 — 원격 조작 서비스 MVP (M0-4)

> **목적**: 화면 개발의 기준이 되는 6개 핵심 흐름을 정의한다. UI 목업이 아니라 **흐름·상태·에러 복구**의 계약이다.
> **정본**: [`mvp-roadmap.md`](./mvp-roadmap.md)(확정 결정) · [`runner-contract.md`](./runner-contract.md)(계약) · [`product-plan-final.md`](./product-plan-final.md)(배경).
> **원칙**: 모든 사용자향 에러 = **"무슨 일 + 어떻게 복구"** 한 쌍. 앱은 승인·조종·모니터링에 최적화(정밀 편집은 데스크톱).
> 최종 갱신 2026-07-09.

상태·에러 코드는 계약 §7(에러 모델)·§2(control)·§5(agent)를 그대로 사용한다:
`AUTH_EXPIRED / RUNNER_OFFLINE / SESSION_GONE / AGENT_NOT_READY / CONFLICT / NOT_FOUND / RATE_LIMITED / INTERNAL`.

---

## 1. 첫 화면 — 만들기/연결 허브

가입 직후 첫 화면(기존 메인 채팅 대체). "무엇을 할지"가 아니라 "어디서 작업할지"를 먼저 정한다.

```
[ 허브 ]
 ├─ 내 워크스페이스 목록 (있으면) ──탭─▶ 워크스페이스 진입(§2 온보딩 게이트 통과 시 터미널+채팅)
 ├─ [+ 내 PC 연결]      ──▶ 온보딩 체크리스트(§2)
 ├─ [+ GitHub에서 열기] ──▶ 레포 선택 → 클라우드 clone → 정본 등록 → 진입
 └─ [+ 새로 만들기]     ──▶ 템플릿 → git init → 클라우드 생성 → 진입
```

- **진입점**: 로그인 성공 → 허브. 딥링크(푸시)로 특정 세션 진입도 여기로 라우팅(§6).
- **상태**: 워크스페이스 카드마다 러너 상태 배지(`내 PC`/`클라우드`, online/offline — `runner_status` 이벤트, 계약 §2).
- **막다른 길 없음**: "내 PC 폴더"인데 데몬 없으면 그 자리서 [연결 유도] 또는 [GitHub로 열기] 대안 제시.
- **에러카드**: 목록 로드 실패 → "목록을 못 불러왔어요 · [다시 시도]"(캐시된 목록 우선 표시).

## 2. 온보딩 체크리스트 (파워유저 로컬 · 입문자 클라우드)

`AGENT_NOT_READY`(CLI 미설치/미로그인) 상황을 능동 점검·안내한다. 진입 장벽을 낮추는 **가이드 플로우**.

```
[ 체크리스트 ]  각 항목 = 자동 점검 + [해결] 액션
 1. 데몬 실행중?    ── 아니오 ─▶ 설치/실행 안내(추후 메뉴바 앱/systemd)
 2. claude 설치?    ── 아니오 ─▶ 설치 링크
 3. claude 로그인?  ── 아니오 ─▶ 러너 터미널 `claude /login` → 앱이 인증 URL 인앱브라우저 중계
 4. tmux 설치?      ── 아니오 ─▶ `brew install tmux` 안내
 ▶ 전부 통과 시 [워크스페이스 열기] 활성화
```

- **진입점**: 허브 [내 PC 연결] · 워크스페이스 진입 시 `AGENT_NOT_READY` 수신.
- **BYO 원칙**: claude 로그인은 **사용자 자신이** 수행(우리는 크레덴셜 미보유). 인증 URL 중계만 한다.
- **상태**: 각 항목 pending/ok/fail. 러너 재연결 시 자동 재점검.
- **에러카드**: 로그인 URL 안 뜸 → "터미널에서 `claude /login`을 실행해 주세요 · [터미널 열기]".

## 3. 대화 이어받기 (PC 대화 목록 → 폰 resume) — 킬러 피처

러너의 에이전트 세션 스토어(`~/.claude/projects/<cwd>/*.jsonl`)를 읽어 폰에 노출. PC 터미널에서 하던 대화도 여기 뜬다.

```
[ 이어받기 목록 ]  (agent.sessions, 계약 §5.1)
 └─ 세션 카드 { title, lastAt, turns, source: app|external }
        ──탭─▶ agent.start(resumeId) → --resume 로 대화 복원 → 채팅 화면(백로그 리플레이)
 [+ 새 대화] ──▶ agent.start(신규)
```

- **진입점**: 워크스페이스 채팅 화면 상단 세션 선택 · 허브 최근 세션.
- **승인 존중**: resume 시 사용자 CLI 설정(allowlist 등) 그대로. permission-mode 덮어쓰지 않음(계약 §5.3).
- **상태**: 세션 state(starting/running/waiting_input/waiting_approval/idle/stopped/crashed).
- **에러카드**: `SESSION_GONE`(세션 종료됨) → "이 대화는 끝났어요 · [목록에서 다시 열기]".

## 4. 핸드오프 원탭 (로컬 ↔ 클라우드)

자동 라우팅이 기본, 사용자는 전환만 원탭. PC 온라인=로컬, 오프라인=클라우드 제안.

```
[ 워크스페이스 ]  현재 타겟 배지: 내 PC ●online
 └─ PC 꺼짐 감지(RUNNER_OFFLINE) ──▶ 배너: "PC가 꺼져 있어요"
        [클라우드에서 계속] ──▶ sync.checkpoint(last) → 클라우드 sync.materialize → 진입
                              (진행: "환경 깨우는 중…" sync_progress)
```

- **진입점**: 워크스페이스 타겟 배지 · `RUNNER_OFFLINE` 배너.
- **동기화**: 코드 + 에이전트 세션 파일 포함(계약 §6.3). node_modules 등은 재설치.
- **폴백 비활성 표시**: macOS/iOS 종속 워크스페이스는 클라우드 폴백 비활성(런타임 차이 원칙).
- **상태**: `sync.status`(clean/syncing/conflict), `sync_progress`(checkpoint/upload/materialize/reinstall).
- **에러카드**: 핸드오프 중 끊김 → "옮기는 중 끊겼어요 · [다시 시도]"(멱등, 체크포인트로 손실 0).

## 5. 충돌 파일 택1 (동기화 충돌)

단일 활성 타겟이라 드물지만, 러너 트리와 정본이 갈라지면 발생. **파일 단위 택1**만(폰 최적).

```
[ 충돌 해결 ]  (sync_conflict: files[])  ← 충돌 중 에이전트 정지
 └─ 충돌 파일 목록(보통 소수)
      각 파일 [내 PC 버전 / 클라우드 버전 / 둘 다 보기]
 [전부 내 PC로] / [전부 클라우드로]  ──▶ sync.resolve(choices) → 진 쪽 rescue 브랜치 보존
```

- **진입점**: 동기화/핸드오프 시 `sync_conflict` 이벤트.
- **안전**: 파괴적 해결 전 진 쪽을 rescue 브랜치로 보존(되돌리기 가능, 조용히 안 버림).
- **범위(MVP)**: 파일 단위 택1 + "전부 한쪽"까지. hunk 단위·풀 IDE 머지 에디터는 Post-MVP/폐기.
- **바이너리**: 머지 불가 → 택1만.
- **에러카드**: 해결 실패 → "충돌을 못 풀었어요 · [다시 시도] · [자세히]"(워크스페이스 준-읽기전용 유지).

## 6. 푸시 랜딩 (걸어두고 나갔다 확인)

세션은 러너에서 계속 돈다. 완료/승인대기/크래시 시 푸시 → 딥링크로 해당 세션 복귀.

```
[ 푸시 알림 ]  kind ∈ { done, permission_request, crashed }  (계약 §10)
   payload { workspaceId, sessionId, kind, title, deeplink }
        ──탭─▶ 앱 열림 → 허브 라우팅 → 워크스페이스/세션 attach(lastSeq) → 백로그 리플레이
                └─ kind=permission_request ─▶ 바로 승인 카드 표시
                └─ kind=done             ─▶ 마지막 턴 결과로 스크롤
                └─ kind=crashed          ─▶ [재시작] / [로그 보기]
```

- **진입점**: OS 푸시 탭 · 앱 재오픈(세션 재구독 + 백로그).
- **상태**: `attach(lastSeq)` → `attach_ack(headSeq)`로 갭 채움(계약 §2·§2.3).
- **RUNNER_OFFLINE 은 푸시 아님**: 앱 연결 인디케이터로만 표시.
- **에러카드**: `AUTH_EXPIRED` → "[다시 로그인]" 딥링크 후 원 세션 복귀. `SESSION_GONE` → 이어받기 목록(§3)으로.

---

## 부록: 흐름 ↔ 계약/로드맵 매핑

| 흐름 | 계약 | 로드맵 |
|---|---|---|
| 1 허브 | control(runner_status) | M1-6 |
| 2 온보딩 | err AGENT_NOT_READY | M1-5 |
| 3 이어받기 | agent.sessions/start(resume) | M1-3 |
| 4 핸드오프 | sync.checkpoint/materialize | M4·M5-4 |
| 5 충돌 | sync_conflict/resolve | M4-3 |
| 6 푸시 | control attach + 푸시 3종 | M3-3 |
