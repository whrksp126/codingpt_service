# 오케스트레이션 — 에이전트가 다른 에이전트를 부리는 조율 계층 (2026-10-06)

> 구현 정본: `packages/runner-core/orch.js`(코어) · `cpt-server.js`(배선) · `packages/cpt-cli`(`cpt orch …`, `ORCH.md` = 에이전트용 가이드).
> 참고한 것: Orca(stablyai/orca, MIT, v1.4.214 `a2f197fd`)의 orchestration 계약 — 코드가 아니라 **계약**을 우리 데몬에 다시 구현했다.

## 0. 사용자 결정 (2026-10-06)

| 결정 | 내용 |
|---|---|
| 에이전트 권한 | **머지까지 완전 자율.** 이전 규칙("터미널 안의 AI 는 작업을 만들거나 머지할 수 없다")을 뒤집는다 |
| 폭주 방지 | 금지가 아니라 **상한** — 중첩 깊이 2 · 묶음당 동시 워커 6 · PC 전체 12 (`daemon.json` `orch.{maxDepth,maxWorkersPerRun,maxWorkers}`) |
| 화면 | 시안 없이 바로 구현 |
| 범위 밖 | 세션 기록 검색 · 다른 PC 에 워커 실행 · 결과물 공유 링크 |

## 1. 세 층

```
Run(묶음)        조율 한 건 + 코디네이터 수신함. 일정을 잡지 않는다 — 이름표와 우편함이다.
 └ Task(일)      할 일 하나: 명세 · 선행 관계(deps) · 결과.   pending → ready → dispatched → completed | failed | blocked
    └ Dispatch   그 일의 시도 1회 = 워커 터미널 1개. 재시도는 새 Dispatch.
                 starting → ready → succeeded | failed | stopped | abandoned
```

- **호출자 식별 = 터미널 좌표**(`cpt-<ws>--t-<tid>`). 워커는 자기 Dispatch, 코디네이터는 자기 Run 으로 풀린다.
  Orca 는 핸들을 인자로 넘기지만(`--from <handle>`), 우리는 터미널마다 세션이 하나라 좌표로 충분하다 — 인자를 잘못 복사할 일이 없다.
  단 생애 메시지(`done`·`heartbeat`·`ask`·`escalate`)는 `--dispatch <id>` 를 함께 받아 **지난 시도의 늦은 보고**가 새 시도를 끝내지 못하게 한다.
- **사람 화면**(PC 앱·폰)은 좌표 없이 부른다 → 보기 + 답하기·결정·멈추기·정리·닫기만(`orch.USER_METHODS`). 워커를 띄우는 쪽은 에이전트뿐이다.

## 2. 워커가 도는 곳

| `--worktree` | 실체 | 정리 |
|---|---|---|
| `current`(기본) | 코디네이터와 같은 폴더의 새 터미널. 명세는 `<stateDir>/orch/<dispatchId>.prompt`(0600)에 쓰고 실행 인자로 넘긴다 | 터미널 닫기 |
| `new` | 기존 **작업(Agent Tasks)** 을 그대로 쓴다 — `tasks.internalCreate(…, {kind:'orch', planId:<dispatchId>})`. git worktree + 전용 브랜치 + 작업 워크스페이스 | `--merge` 면 `git.merge.local`, 아니면 `task.discard`(30일 복구) |

`new` 워커는 사이드바에서 묶음 아래 워커 행으로만 보인다(작업 행으로 한 번 더 그리지 않는다). 폴더 신뢰 확인은 오케스트레이션 워커에 한해 데몬이 대신 수락한다(사용자가 조율을 맡겼으므로 — 일반 작업은 종전대로 사람이 누른다).

## 3. 메시지와 수신함

- 수신함: `run:<id>`(코디네이터) · `dispatch:<id>`(워커).
- 종류: `worker_done`(결과, 정확히 1회) · `question`/`reply`(막고 묻기) · `escalation`(막힘) · `status`(자유 메시지) · `decision_gate`(사람의 결정). heartbeat 는 수신함에 넣지 않고 시도의 `phase`·`heartbeatAt` 만 갱신한다(수신함 오염 방지).
- **배달(Delivery)**: `check` 는 읽지 않은 메시지를 묶어 배달로 내주고, `--ack <deliveryId>` 전까지 같은 묶음을 다시 준다. 다 처리한 뒤에만 ack.
- **기다리기**: `check --wait [--types …] [--timeout-ms N]` · `ask` 는 데몬이 응답을 쥐고 있는다(기본 100초 = 에이전트 셸 도구의 기본 제한 2분 안쪽, 상한 1시간). 요청 소켓이 닫히면 대기를 끝낸다. **시간 초과는 실패가 아니다.**
- **깨우기**: 받는 쪽이 기다리고 있지 않으면, 그 에이전트가 **한가할 때만** 입력창에 한 줄을 넣는다(`[오케스트레이션] … cpt orch check`). 일하는 중이면 넣지 않는다(쓰던 입력과 섞인다). 넣었다는 것은 읽었다는 증거가 아니다.
- **보고 없이 멈춘 워커**: 워커 에이전트가 유휴가 됐는데 시도가 아직 진행 중이면 최대 2번(1분 간격) "결과를 보고하세요" 를 넣는다.

## 4. 없음은 증거가 아니다

생존 판정은 셋이다: `live`(에이전트가 전경에 있다) · `exited`(터미널이 없거나 셸로 돌아왔다) · `unverifiable`(모른다).

- `worker-abandon` 은 `exited` 일 때만 받는다(`NOT_LIVE_PROOF`). 살아 있으면 `worker-stop`.
- `worker-release` 는 끝난 시도에만(`DISPATCH_ACTIVE`).
- 머지가 실패하면 아무것도 지우지 않는다(`MERGE_FAILED` + `detail.code` = `MAIN_DIRTY`·`MERGE_CONFLICT`·…).
- `worker-start` 가 실패하면 `failedStage`·`residualResources` 를 돌려준다 — 그대로 다시 띄우지 않게.

## 5. 화면

- `orch.list` → `{runs:[{…, tasks, workers, gates}], notes:[{cwd, comment, status}]}`. 변경 신호 `orch.changed {host, runIds, reason}` 은 **식별자만** 싣는다(명세·본문 없음). 클라는 받으면 `orch.list` 를 다시 부른다(+30초 폴링 안전망) — push 만으로는 한 번 놓치면 영영 빈칸이다.
- 사이드바: 워크스페이스 머리에 한 줄 메모(`cpt ws set --comment … --status …`), 로컬 행 아래 `묶음 → 워커`. 합산 순서 = 확인 필요 > 실패 > 진행 중 > 끝.
- pane 탭: 워커 = 점, 코디네이터 = 마름모(색은 상태 신호에만).
- 묶음 시트: 질문에 답하기 · 결정 고르기 · 워커 멈추기/정리 · 묶음 닫기.
- 판정은 순수 함수 한 벌(PC `orch-model.js` / 앱 `orchModel.ts`)이고 픽스처로 교차 검증한다.

## 6. 알림

워커 터미널의 "턴 끝" 알림과 작업의 "리뷰 준비" 알림은 사용자에게 보내지 않는다(`orch.quietSession` · origin `orch`) — 워커 N 개가 N 번 울리지 않게. 사용자에게 가는 것은 셋이다: 묶음의 워커가 **모두 끝남**(`orch_settled`) · 워커가 **막힘**(`orch_escalation`) · **결정 필요**(`orch_gate`). 워커의 승인 대기(permission)는 종전대로 알린다 — 사람이 답해야 한다.

## 7. 능력·킬스위치

| | 선언 | 끄기 |
|---|---|---|
| 데몬 | `orch.v1`(OPTIONAL_CAPS — `orch.handle` 이 있을 때) | `CPT_ORCH=0` |
| 서버 | `orch.v1`(`POST /api/daemon/orch`, 허용 표 `ORCH_RPC_OK` = 사람 권한 메서드만) | `ORCH_ENABLED=0` → 403 `ORCH_DISABLED` |

원격 화면은 봉인 RPC 우선, 구조적으로 불가할 때만 평문 라우트(작업 RPC 와 같은 규칙). 데몬은 `via='relay'` 호출에 에이전트 전용 명령을 거부한다(이중 방어).

## 8. 검증

- 단위: `packages/runner-core/test/orch.test.js`(스텁 주입 — 계약 16건).
- 실주행: 진짜 tmux(격리 소켓) + 진짜 소켓 + 진짜 `cpt` CLI + 가짜 에이전트로 "워커 2 → 질문/답 → 결과 → 정리 → 작업 폴더 워커 → 머지 → 묶음 닫기" 30항목.
  ★ 이 PC 에서 데몬을 추가로 띄우지 않는다(운영 데몬과 서로 죽인다) — `cpt-server.start()` 만 격리 stateDir 로 올린다.
- 실기에서 드러난 것: base 가 열려 있는 폴더에 커밋 안 된 변경이 있으면 머지가 거부된다(`MAIN_DIRTY`) — 같은 폴더 워커가 만든 파일도 포함. 안내문과 가이드에 "커밋 → 머지" 순서를 적었다.
