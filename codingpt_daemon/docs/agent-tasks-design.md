# Agent Tasks 설계 정본 (2026-09-29, rev2 — 리뷰 반영)

> "폰(또는 PC)에서 작업을 만든다 → 내 PC 가 git worktree 안에서 에이전트를 돌린다 → 현황판에서 본다 →
> diff 를 리뷰한다 → PR 을 열고 머지한다(원격이 없으면 로컬 머지)".
>
> 이 문서는 **4명의 구현자(daemon+cpt / back / PC / mobile)가 서로 대화 없이 동시에 구현하는 유일한 계약**이다.
> 여기 적힌 메서드명·필드명·상태값·에러코드·i18n 원문·파일 소유권은 그대로 쓴다. 바꿔야 할 이유가 생기면
> 이 문서를 먼저 고치고(§12 변경 규칙) 나서 코드를 고친다.
>
> 표기: 산문은 한국어, 식별자·JSON·경로는 영어. "MUST/SHOULD" 는 RFC 의미. 코드 인용 줄번호는 2026-09-29 트리 기준.
> rev2 에서 바뀐 결정은 부록 A(리뷰 반영 기록)에 근거와 함께 적었다. 부록 B 는 제품 오너 결정이 필요한 열린 질문.

---

## 0. 결정 요약 (한 페이지)

| 항목 | 결정 |
|---|---|
| 작업(Task) | 프롬프트 1개 + 저장소 1개 + base 브랜치 1개 + 실행(Run) N개. 데몬 소유 레코드 `<stateDir>/tasks.json`(0600) |
| 실행(Run) | 에이전트 1개 = worktree 1개 = 브랜치 1개 = tmux 터미널 1개(기존 터미널 풀의 **보통 터미널**) |
| 경로·이름 | worktree `<stateDir>/worktrees/<repoSlug>-<t6>-<k>` · 브랜치 `cpt/<t6>-<k>` · **와이어에는 의미 없는 이름만**(제목 슬러그는 tasks.json 에만) |
| worktree = 워크스페이스 | 데몬이 run 마다 back 워크스페이스를 등록한다(`localPath=.codingpt/worktrees/...`, `remoteUrl:null`). 클라이언트는 공통 술어 `isTaskWorkspace(meta)` 로 **기본 셀렉터에서** 숨긴다. IDE·프리뷰·승인·agent_state 가 전부 공짜로 동작 |
| 프롬프트 배달 | **런치 인자**: 프롬프트를 `<stateDir>/tasks/<taskId>/<runId>.prompt`(0600) 에 쓰고 `claude "$(cat '<path>')"` 로 실행 — CLI 가 폴더 신뢰 확인을 끝낸 뒤 스스로 제출한다. `promptArg` 가 없는 에이전트(cursor-agent·opencode)만 준비 판정 뒤 붙여넣기(§2.5) |
| 팬아웃 | 한 프롬프트를 N 에이전트에(예: claude+codex, claude x2). worktree add 만 저장소 락으로 직렬, 나머지는 run 병렬. 하나를 골라 PR/머지, 나머지는 폐기 |
| GitHub | PC 의 **사용자 gh CLI** 만 쓴다(데몬이 spawn, 항상 `--repo`). 서버는 토큰 0. gh 없음/미로그인 → 안내 화면 |
| 원격 없는 저장소 | "base 브랜치에 로컬 머지"(base 가 체크아웃돼 있지 않으면 임시 detached worktree 에서) |
| 머지 후 | 머지 성공은 즉시 회신, worktree/브랜치/워크스페이스 정리와 나머지 run 폐기는 **비동기**(`tasks.changed` 로 보고). 미커밋 변경·미머지 커밋이 있는 run 은 남긴다. 삭제 전 복구 ref 기록 |
| 현황판 | **모든 PC·모든 워크스페이스의 에이전트**를 입력 대기 / 작업 중 / 리뷰 준비 / 대기 중 / 완료 로 묶는다. 기존 훅 기반 `agent_state` 재사용 |
| 전송 | 새 RPC 전부 `task.*`/`git.*` → 봉인 RPC(E2EE) 우선. **전용 래퍼 `taskRpc`**: 평문 폴백은 구조적 미지원 코드에서만, 타임아웃·5xx 는 폴백 금지(이중 실행 방지) |
| 변이 = 비동기 op | git/터미널 변이 RPC 는 `{accepted, opId}` 즉시 회신 → 백그라운드 실행 → `run.op`/`run.lastOp` + `tasks.changed`. 클라가 `opId`(UUID) 를 보내고 데몬이 멱등 재생 |
| 라이브 갱신 | 데몬 → `ui_command` 브로드캐스트 `tasks.changed {host, taskIds, reason}` → 클라가 그 host 의 `task.list` 재조회. 리뷰 준비/머지/실패는 기존 알림(`POST /api/notifications`, 제목은 일반 문구) + FCM |
| 제품 규칙 | 이모지 0 · 선택/활성은 무채색 명암만(accent 는 상태 신호 전용) · RN 은 PressableScale · 7개 언어 · "Claude Code" 를 기능/제품 이름으로 쓰지 않는다 |

---

## 1. 목표 / 비목표 / 흐름 / 상태기계

### 1.1 목표
1. 폰·태블릿·PC 어디서든 "저장소 + base + 프롬프트 + 에이전트 N" 으로 작업을 만든다.
2. 그 PC 가 worktree 를 파고 에이전트를 **보통 터미널**로 띄운다 — 어느 기기에서든 그 터미널을 열어 개입할 수 있다.
3. 현황판 한 화면에서 모든 PC 의 에이전트가 무엇을 기다리는지 본다.
4. run 의 diff 를 base 기준으로 리뷰하고, 코멘트를 에이전트에게 되돌려 보내거나, 커밋·푸시·PR·머지한다.
5. 서버는 **프롬프트 전문·diff 내용·파일명·PR 본문**을 보지 않는다(E2EE 우선; 평문 폴백은 사용자 정책이 허용할 때만). 작업 제목·브랜치명·저장소 이름은 워크스페이스 이름과 같은 등급의 메타데이터이며 §2.2 의 이름 규칙으로 **와이어에는 의미 없는 값만** 나가게 한다(§10).

### 1.2 비목표 (이번 라운드에 안 한다)
- 서버측 작업 테이블/오프라인 열람(PC 가 꺼져 있으면 그 PC 의 작업은 "PC 오프라인" 으로만 보인다).
- GitHub 외 호스팅(GitLab 등) PR. 원격이 github.com 이 아니면 "로컬 머지" 경로만 제공.
- 에이전트 간 자동 승자 판정. 비교는 사람이 한다.
- 자동 재시도·자동 rebase·충돌 자동 해결. 충돌은 사용자에게 파일 목록으로 돌려준다.
- LAN 직결(`lan.js RPC_ALLOW_PREFIX`)에 `task.`/`git.` 추가.
- 폴더 신뢰 자동 수락(`~/.claude.json`·codex config 기록). 부록 B-1.
- Windows. 설계는 `spawn-util` 을 타지만 검증 범위는 macOS 다.

### 1.3 사용자 흐름

**폰에서 만들기**
1. 사이드바 "작업" 행(또는 헤더 아이콘, 팔레트 `tasks.open`) → 현황판.
2. [+ 새 작업] → NewTaskSheet: PC 선택(온라인 local 러너가 2대 이상일 때만) → 저장소(워크스페이스) 선택 → base 브랜치(기본 현재 브랜치; 메인 체크아웃에 미커밋 변경이 있으면 "main 에 미커밋 변경 N개는 포함되지 않아요" 안내) → 프롬프트(마이크 받아쓰기) → 에이전트 칩 다중 선택 + 개수 → [시작].
3. 현황판 "작업 중" 에 run 카드 N 개가 즉시 생긴다(creating → launching → running).
4. **새 worktree 는 에이전트에게 처음 보는 폴더다.** claude/codex 가 "이 폴더를 신뢰합니까" 를 물으면 카드가 "입력 대기" 로 올라오고 [신뢰하고 계속] 한 번으로 답한다(§2.5 10b). 그 뒤 CLI 가 런치 인자의 프롬프트를 스스로 제출한다.
5. 에이전트가 승인/질문을 띄우면 카드가 "입력 대기" 로 올라오고 카드에서 바로 답한다(기존 승인 카드) 또는 [터미널 열기].
6. 턴이 끝나고 변경이 있으면 "리뷰 준비" + 푸시 알림. 카드 → 상세: run 들을 나란히 비교, diff 리뷰(헝크 단위), [코멘트 보내기] / [PR 만들기](미커밋이면 커밋 메시지까지 한 시트에서) / [로컬 머지].
7. PR 상태·CI 체크가 상세에 보인다. [PR 머지] → 승자 확정 → (비동기) 나머지 run 폐기 → worktree/브랜치 정리 → "완료".

**PC 에서 만들기**
- 워크스페이스 헤더 [+] 메뉴 "새 작업…" 또는 `Mod+Shift+N` → 같은 시트(현재 워크스페이스가 저장소 기본값).
- 현황판은 메인 영역 뷰(`state.view='tasks'`), `Mod+Shift+A`.
- run 터미널은 워크스페이스 pane 으로 열린다(작업 카드 [터미널 열기] = 해당 worktree 워크스페이스 활성화 + 그 tid 포커스).

### 1.4 Task 상태기계

```
                 task.create
                     |
                     v
                 [ open ] ---- 모든 run 이 discarded ----> [ closed ]
                     |
                     |  어느 run 이 merged (PR 머지 or 로컬 머지 or GitHub 웹에서 머지 감지)
                     v
                 [ merged ]

 생성 자체 실패(저장소 아님·base 없음·git 없음·상한) ----> [ failed ]
```

`Task.state ∈ {open, merged, closed, failed}`. `merged/closed/failed` 는 종결 상태이며 `winnerRunId` 는 merged 일 때만 non-null.
- `closed` 는 **모든 run 이 `discarded`** 일 때만. `failed` run 은 재시도 가능(`task.run.reopen`)이므로 작업을 종결시키지 않는다.
- `merged` 작업 안에 남은 run(미커밋/미머지 커밋 때문에 폐기를 건너뛴 것)은 계속 현황판에 보인다(§5.2 규칙 1).

### 1.5 Run 상태기계 (영속 lifecycle)

```
 creating ──(worktree 생성 완료)──> launching ──(에이전트 명령 입력 완료)──> running
    │                                    │
    └──── 실패 ────> failed <──── 실패 ───┘        (데몬 재시작으로 끊기면 둘 다 failed{OP_INTERRUPTED}, §2.11)
                                          running <────(prompt 훅: 사용자가 새 지시)──── review_ready
                                          running ──(턴 종료 + 변경 있음)──> review_ready
                                          running/review_ready ──(git.pr.merge | git.merge.local 시작)──> merging
                                          merging ──성공──> merged        merging ──실패──> review_ready (run.error 기록)
                                          running/review_ready/failed ──(task.discard)──> discarded
```

`Run.state ∈ {creating, launching, running, review_ready, merging, merged, discarded, failed}`.

- "입력 대기(needs input)" 와 "작업 중(working)" 은 **영속 상태가 아니다**. 라이브 `agent_state`(permission/needsInput/working)와 승인 대기 목록, `run.op`, `run.trustPending` 을 겹쳐서 현황판이 계산한다(§5).
- `review_ready` 는 데몬이 **턴 종료 시점의 diff 유무**로 판정해 영속화한다(§2.7). 사용자가 다시 지시하면(prompt 훅 → working) `running` 으로 돌아간다.
- `merging` 실패는 **항상 `review_ready`** 로 돌아간다(이전 상태를 저장하지 않는다 — 머지는 review_ready 카드에서만 시작할 수 있고, running 에서 시작한 경우도 변경이 있었다는 뜻이다).
- `failed` 는 재시도 가능(`task.run.reopen`).
- `agentGone:true`(reconcile 이 계산, §2.11) 는 상태가 아니라 플래그: 터미널은 살아 있으나 에이전트가 안 도는 run. 카드에 [에이전트 다시 실행].

### 1.6 팬아웃 의미론
- `agents: [{id:'claude', count:2}, {id:'codex', count:1}]` → run 3개, `idx`(=`k`) 1..3, 모두 **같은 프롬프트, 같은 base**, 각자 브랜치·worktree·터미널.
- run 은 서로 독립이다. 한 run 의 실패가 다른 run 에 영향을 주지 않는다.
- **타이밍**: 같은 저장소의 `git worktree add` 만 저장소 락(§2.12)으로 직렬화한다. 그 뒤 단계(env 복사·워크스페이스 등록·터미널 생성·런치·신뢰 확인·프롬프트)는 run 마다 `Promise.all` 로 병렬. 4 run 이면 마지막 run 의 런치는 첫 run 과 수 초 차이여야 한다(E2E 2).
- 승자 선택 = `git.pr.merge` 또는 `git.merge.local` 이 성공한 run. `task.winnerRunId` 확정 → `discardOthers`(기본 true)면 비동기로 나머지 run 을 `task.discard {force:false}` 규칙으로 폐기하되 **`UNCOMMITTED_CHANGES`/`UNMERGED_COMMITS` 인 run 은 남긴다**(`discardSkipped:[{runId, code}]`, `tasks.changed reason:'discarded'`).
- 상한: 한 작업에 run 최대 4, 한 저장소에 동시 open 작업 최대 8, 총 open run 최대 12 (`TASK_LIMIT`).

---

## 2. 데몬 설계 (codingpt_daemon/packages/runner-core)

### 2.1 새 파일 / 수정 파일

| 파일 | 역할 |
|---|---|
| `tasks.js` (신규) | 작업 스토어(tasks.json) + 상태기계 + `handle(method, params)` RPC 디스패치 + 오케스트레이션(생성·런치·신뢰 확인·프롬프트·review_ready 판정·비동기 op·정리). 순수 모듈 + 주입 `configure({notify, poolChanged, launch, chatInput, chatDialog, screen, backFetch, now, log, deviceId})` + `start()`(agent-state 구독 + reconcile). **configure/start 는 cpt-server 기동 시 1회**(§2.3) |
| `task-git.js` (신규) | git/gh 실행기. 바이너리 절대경로 해석 + env 구성 + `git(args,{cwd,timeout})`, `gh(args,{cwd,timeout})`, worktree add/remove, base diff, commit/push, pr create/view/merge, 로컬 머지, env 파일 복사 |
| `control.js` (수정) | `dispatchRpc` 에 `task.`/`git.` 분기 1개 추가(§2.3). `OPTIONAL_CAPS` 에 `['task.v1', './tasks', 'handle']` |
| `cpt-server.js` (수정) | `handleTaskRpc(method, params)`(디스패치만), 유닉스 소켓 디스패치에 `task.`/`git.` 추가, `CAPABILITIES` 에 `task.list`·`task.get` 만 공개, `start()` 에서 `tasks.configure({...})` + `tasks.start()`, `notifyTasksChanged`, `launchAgentInTerminal` 에 `args` 추가 전용 |
| `agent-state.js` (수정) | `subscribe(fn)`, `rawStateOf(key)`, `configure({shouldNotify})` 추가(§2.7). 기존 동작 무변경 |
| `agents.js` (수정) | `module.exports` 에 `probeLoginPath`, `searchDirs`, `findBin` **추가**(현재 `searchDirs`/`findBin` 은 `_internals` 에만 있고 `probeLoginPath` 는 미노출 — agents.js:452-482). `_internals` 유지. CATALOG 항목에 `promptArg` 추가(§2.5) |
| `test/tasks.test.js`, `test/task-git.test.js`, `test/task-contract.test.js` (신규) | §7 |
| `docs/agent-tasks-design.md` (이 문서) · `docs/fixtures/agent-tasks/*.json` (신규, §8.5) | 계약 픽스처 |

`packages/cpt-cli`: `cpt task list|get` 2개 읽기 명령만. 자기 run 은 `CPT_TSESSION` 으로 찾는다(`task.list` 결과에서 `run.tsession === $CPT_TSESSION` — 새 env 변수 없음, `pty.createTerminal` 시그니처 무변경, 재부팅 복원(`poolEnvMap`)에서도 유실 없음). 쓰기 명령은 노출하지 않는다.

### 2.2 온디스크 스토어 `<stateDir>/tasks.json`

- 경로: `path.join(runtime.stateDir(), 'tasks.json')`. **`~/.codingpt` 하드코딩 금지**(`runtime.init({stateDir, root})` 로 테스트·클라우드 러너가 바꾼다, runtime.js:21-22).
- 쓰기: tmp 파일에 쓰고 `chmodSync(0o600)` → `renameSync`(surfaces.js 패턴). `{v:1, savedAt, items:[Task]}`, 읽을 때 스키마 검증(깨진 항목은 버리고 로그).
- worktree 루트 `WORKTREES = path.join(runtime.stateDir(), 'worktrees')`, 프롬프트 파일 루트 `path.join(runtime.stateDir(), 'tasks')`. 기동 시 둘 다 `fs.safeResolve` 홈 jail(`runtime.root()`) 안인지 assert — 아니면 `task.v1` cap 을 광고하지 않고 모든 `task.*` 가 `TASKS_DISABLED` 로 실패한다(`sessionForCwd` 가 홈 폴백해 잘못된 세션에 붙는 것을 막는다).

```jsonc
// Task
{
  "id": "t_k3j9x2m1qa",              // "t_" + base36 10자
  "v": 1,
  "title": "로그인 폼 유효성 검사 추가",   // 사용자 입력 or 프롬프트 첫 줄 60자. TaskLite/task.get(봉인 경로)에만. 알림·워크스페이스 이름·브랜치명에는 절대 안 쓴다
  "prompt": "…전문…",                 // UTF-8 30000 바이트 이하(PROMPT_TOO_LARGE). 이벤트/알림에 절대 싣지 않는다. task.get 에만 실린다.
  "repo": {
    "path": "work/codingpt",         // 홈-기준 상대(cwdRel) — git top-level(§2.5 1단계에서 정규화)
    "subdir": "codingpt_back",       // 워크스페이스 localPath 가 top-level 의 하위면 그 상대경로, 아니면 ""
    "common": "work/codingpt/.git",  // realpath(git rev-parse --git-common-dir) 홈-상대 — 저장소 락 키
    "name": "codingpt",              // basename(top-level)
    "remoteUrl": "https://github.com/whrksp126/codingpt.git", // origin 또는 null. tasks.json 에만(워크스페이스 등록에는 안 보낸다)
    "github": { "owner": "whrksp126", "repo": "codingpt" }   // gh 가 확정(§2.4). 아직 모름/아님 = null
  },
  "base": "main",
  "workspaceId": "ws_abc",           // 저장소 워크스페이스의 back id(클라가 준 값) 또는 null
  "state": "open",                   // open | merged | closed | failed
  "winnerRunId": null,
  "error": null,                     // { code, message } — failed 일 때
  "createdAt": 1790000000000, "updatedAt": 1790000000000, "closedAt": null,
  "runs": [ /* Run */ ]
}
// Run
{
  "id": "r_8fk2ma1q",                // "r_" + base36 8자
  "idx": 1,                          // = k
  "agent": "claude",                 // agents.js CATALOG id
  "branch": "cpt/x2m1qa-1",          // cpt/<t6>-<k>
  "dir": ".codingpt/worktrees/codingpt-x2m1qa-1",   // cwdRel — worktree 루트(git 작업 cwd)
  "cwd": ".codingpt/worktrees/codingpt-x2m1qa-1/codingpt_back", // dir + subdir — 터미널·에이전트·워크스페이스 localPath·agent_state 조인 키
  "baseSha": "abc123…",              // 시작점 커밋(fetch 성공 시 origin/<base>, 아니면 로컬 <base>)
  "workspaceId": "ws_def",           // 데몬이 등록한 worktree 워크스페이스 id, 실패 시 null
  "tid": 1234567, "tsession": "cpt-codingpt-worktrees-codingpt-x2m1qa-1-codingpt_back--t-1234567",
  "terminalAlive": true,             // 응답 시점 계산(영속하지 않음)
  "agentGone": false,                // 응답 시점 계산: 터미널 셸이 유휴이고 agent-state attachment 없음
  "trustPending": false,             // 영속: 폴더 신뢰 다이얼로그가 떠 있음(§2.5 10b). 답하면 false
  "state": "running",
  "promptMode": "arg",               // 'arg' | 'paste' — 이 run 의 프롬프트 배달 방식(§2.5)
  "promptDelivered": true, "promptDeliveredAt": 1790000012345,
  "launchedAt": 1790000010000,
  "copiedFiles": [".env", ".env.local"],
  "diff": { "files": 3, "additions": 41, "deletions": 7, "at": 1790000050000 },   // merge-base 대비 워킹트리+인덱스+미추적. null=미계산
  "commits": { "ahead": 2, "at": 1790000050000 },   // <base>..HEAD 커밋 수
  "dirty": true,                     // 미커밋 변경(추적/미추적) 존재 — 마지막 refresh 시점 값(정리 판단에는 쓰지 않는다, §2.10)
  "pushed": false,                   // upstream 이 있고 ahead-of-upstream == 0
  "pr": null,                        // §3.1 PrInfo
  "op": null,                        // 진행 중 op { opId, kind, startedAt } — kind: commit|push|pr.create|pr.merge|merge.local|discard|reopen|cleanup
  "lastOp": null,                    // 마지막 op 결과 { opId, kind, ok, code, message, result, at } — result 는 kind 별(§3.1)
  "lastTurnEndedAt": null, "lastActivityAt": 1790000050000, "reviewNotifiedAt": null,
  "lastTurnFailed": false,
  "error": null,                     // { code, message }
  "cleanup": null,                   // { worktreeRemoved, branchDeleted, workspaceDeleted, recoveryRef, at }
  "createdAt": 1790000000000, "updatedAt": 1790000050000
}
```

와이어 화이트리스트(`pickTask`, `pickRun`): 위 필드만. `prompt` 는 `task.get` 에서만. 내부 필드(타이머 핸들·락)는 절대 저장/전송하지 않는다. `opIds`(run 당 최근 20개 `{opId, at, outcome}`)는 tasks.json 에 저장하되 와이어에는 싣지 않는다.

**이름 규칙(와이어에 의미를 싣지 않는다)**
- `t6` = taskId 뒤 6자(base36). `k` = run.idx.
- `repoSlug` = `repo.name` 을 NFKD → `[a-z0-9]+` 만 남기고 구분자 `-` 로 접되 **연속 `-` 는 1개로**, 최대 32자, 비면 `repo`. 결과에 `--` 가 없어야 한다(cpt-server `liveWorkspaceNs` 가 `name.split('--')[0]` 로 ns 를 자르므로 — cpt-server.js:488-497; `nsOfCwd` 는 `-` 연속을 접지 않는다).
- 브랜치: `cpt/<t6>-<k>` (예 `cpt/x2m1qa-2`). 에이전트 이름·제목 슬러그를 넣지 않는다.
- worktree 폴더: `<WORKTREES>/<repoSlug>-<t6>-<k>`. 이미 있으면 `WORKTREE_ADD_FAILED`(taskId 가 유일하므로 정상적으로 발생하지 않는다).
- 워크스페이스 이름(서버 평문): `<repoSlug>-<t6>-<k>` 그대로. 사람이 읽는 제목은 tasks.json/task.get 에서만 온다(클라가 `taskBadge` 로 그린다).
- 프롬프트 파일: `<stateDir>/tasks/<taskId>/<runId>.prompt`(0600, 디렉토리 0700). run 정리 시 삭제.

### 2.3 RPC 배선

**control.js `dispatchRpc`** — `ws.` 분기 앞에 한 줄:
```js
// Agent Tasks(task.*/git.*) — worktree 작업·git/gh 조작. 로컬 소켓과 같은 함수(cpt-server.handleTaskRpc). 구 번들은 명확한 실패.
if (method.startsWith('task.') || method.startsWith('git.')) { callLazy('./cpt-server', 'handleTaskRpc', [method, params || {}], ok, fail); return; }
```
봉인 경로(`handleSealedRpc` → 같은 `dispatchRpc`)는 자동으로 통한다.

**cpt-server.js**
```js
// start() 안, 소켓 listen 직후 1회. 주입 뒤 tasks.start() 가 agent-state.subscribe + reconcile 을 한다.
//  ★ handleTaskRpc 안에서 configure 하지 않는다 — 클라이언트가 한 번도 RPC 를 안 부른 데몬(재시작 직후)에서
//    stop 훅이 오면 review_ready 승격·알림이 조용히 사라진다.
function wireTasks() {
  const lib = require('./tasks');
  lib.configure({
    notify: notifyTasksChanged,                 // §2.8
    poolChanged: notifyPoolChanged,             // 터미널 생성/삭제 뒤 리컨실 트리거(코얼레싱은 tasks.js 가 한다)
    launch: (a) => launchAgentInTerminal(agentsLib, a),   // {cwd, index, id, args?} — args 는 §2.5 런치 인자
    chatInput: (a) => chatInput(a),
    chatDialog: (a) => chatDialog(a),           // §2.5 10b 신뢰 다이얼로그 응답(driveDialog: expect 대조)
    screen: (a) => chatScreen(a),               // extractDialog 용 화면
    backFetch,
    deviceId: () => cfg.deviceId,
  });
  lib.start();
}
function handleTaskRpc(method, params) { return require('./tasks').handle(method, params || {}); }
```
유닉스 소켓 디스패치(PC 앱 `task_local` 커맨드가 여기로 온다): `if (cmd.startsWith('task.') || cmd.startsWith('git.')) return handleTaskRpc(cmd, args);` — `hasCptContext` 게이트 **바깥**. cpt CLI 노출은 `task.list`, `task.get` 뿐(`CAPABILITIES`).

**caps**: `OPTIONAL_CAPS.push(['task.v1', './tasks', 'handle'])`. 클라이언트가 데몬 caps 를 얻는 길은 **`GET /api/daemon/status` 의 `runners[].caps`** 뿐이다(`runner_status` 프레임에는 caps 가 없다 — daemonRelayService.js:870-900; 릴레이는 무수정). 클라는 그 값을 `hostCaps(host)` 로 캐시하고 `runner_status online` 전이(해당 deviceId)마다 재조회한다(PC 앱 업데이트로 caps 가 바뀐다). `task.v1` 없으면 "PC 앱 업데이트 필요".

### 2.4 git / gh 실행기 (`task-git.js`) — PATH 함정 포함

```js
// 해석은 60초 캐시, 실패도 캐시(재시도 폭주 방지). refresh:true 로 무효화.
async function tools({ refresh } = {}) → {
  git: { ok, path, version, error },          // error: 'GIT_MISSING' | 'GIT_CLT_MISSING'
  gh:  { installed, path, version, authenticated, user, host, error }, // error: 'GH_MISSING' | 'GH_NOT_AUTHED' | 'GH_ERROR'
  env  // spawn 용 env
}
```
- 후보 디렉토리 = `agents.searchDirs(await agents.probeLoginPath())` (process PATH ∪ 로그인 셸 PATH ∪ FALLBACK_DIRS). `agents.findBin('git', dirs)`, `agents.findBin('gh', dirs)`.
- macOS `/usr/bin/git` 은 CLT 심이다. `git --version` 이 비정상 종료하고 stderr 에 `xcode-select` 가 있으면 `GIT_CLT_MISSING`.
- gh 인증 판정: `gh auth status --hostname github.com` exit 0 → `authenticated:true`; `gh api user --jq .login`(5s) 로 `user`. exit 1 → `GH_NOT_AUTHED`(안내: 터미널에서 `gh auth login` **또는** 환경변수 `GH_TOKEN` — 셸 rc 의 export 는 Finder 로 뜬 데몬에 안 보이므로 문구에 명시).
- env: `{...process.env, PATH: [dirname(git), dirname(gh), ...dirs].uniq.join(':'), GIT_TERMINAL_PROMPT:'0', GH_PROMPT_DISABLED:'1', GH_NO_UPDATE_NOTIFIER:'1', GH_PAGER:'cat', GIT_PAGER:'cat', LANG: process.env.LANG || 'en_US.UTF-8'}`. `TMUX` 제거. **`GIT_SSH_COMMAND` 를 설정하지 않는다**(사용자 `core.sshCommand`/1Password 에이전트 설정을 덮어쓴다). 자식은 TTY 가 없으므로 ssh 가 물어볼 수 없고 `GIT_TERMINAL_PROMPT=0` 이 git 프롬프트를 막는다. **자격증명 env 를 만들거나 옮기지 않는다.**
- **기계 판독 git 호출의 공통 접두**: `git --no-optional-locks -c core.quotepath=false -c color.ui=never` + diff 류에는 `--no-ext-diff --no-textconv`, 목록 출력은 `-z`. 이유: 기본 `core.quotepath=true` 가 한글 경로를 8진수로 인용해 파일 목록이 깨지고, `diff.external`/`textconv`/`color.ui=always`/`diff.noprefix` 가 출력을 바꾸며, `--no-optional-locks` 가 없으면 에이전트가 같은 worktree 에서 도는 동안 `index.lock` 충돌을 일으킨다.
- `git(args, {cwd, timeout=15000})` / `gh(args, {cwd, timeout=30000})` : `execFile` + `maxBuffer 16MB`, 반환 `{ok, code, out, err}`; throw 하지 않는다. **데드라인 초과 시 자식을 `SIGTERM`(2s 뒤 `SIGKILL`) 하고 `TIMEOUT` 으로 접는다** — 자식이 계속 도는 채로 락을 풀지 않는다. 사용자 텍스트가 들어가는 옵션은 `--flag=value` 형(`--title=`, `--message=`)이거나 stdin(`--body-file=-`)으로 넘겨 `-` 로 시작하는 값이 옵션으로 오해되지 않게 한다. 경로 앞에는 항상 `--`.
- **gh 는 항상 `--repo <owner>/<repo>`**. 값은 worktree 에서 `gh repo view --json owner,name`(작업당 1회 캐시, `repo.github` 에 저장) — origin URL 정규식 대신 gh 의 판정을 쓴다(`git@github-work:owner/repo` 같은 SSH 별칭·다중 remote 를 gh 가 푼다). `repo view` 실패 → `NOT_GITHUB`(gh 미설치/미인증은 각각 `GH_MISSING`/`GH_NOT_AUTHED` 가 먼저).
- 재현: `env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin node packages/daemon/index.js run` 에서 `git.gh.status` 가 gh 를 찾아야 한다.

### 2.5 작업 생성 시퀀스 (`task.create`)

동기 구간(≤ 1s, 회신 전):
1. 파라미터 검증(§3.1). `prompt` 는 `Buffer.byteLength(prompt,'utf8') ≤ 30000` 아니면 `PROMPT_TOO_LARGE`. `repo` 는 `fs.safeResolve` 홈 jail 통과 + 존재 + `git rev-parse --is-inside-work-tree`. **정규화**: `top = git rev-parse --show-toplevel`, `common = realpath(git rev-parse --git-common-dir)`, `subdir = relative(top, repoAbs)`. `repo.path` 는 top 의 홈-상대, `repo.subdir`, `repo.common` 저장. top 이 홈 jail 밖이면 `NOT_A_REPO`.
2. `refs/heads/<base>` 와 `refs/remotes/origin/<base>` 둘 다 없으면 `BASE_NOT_FOUND`.
3. 상한 검사(§1.6) → `TASK_LIMIT`. 에이전트 설치 여부(`agents.list`) → `AGENT_NOT_INSTALLED`. `tools().git.ok` 아니면 `GIT_MISSING`/`GIT_CLT_MISSING`.
4. Task/Run 레코드 생성(`state: creating`), 프롬프트 파일 기록, 저장, `notify({taskIds:[id], reason:'created'})`, **즉시 회신** `{task}`(TaskLite).

비동기 구간 — **저장소 락은 5~6 단계만** 잡는다. 7 단계부터는 run 마다 병렬(`Promise.all`):
5. (fetch) `git fetch origin <base>` 60s. 성공 → 시작점 `refs/remotes/origin/<base>`; 실패 또는 `fetch:false` → `refs/heads/<base>`(없으면 `refs/remotes/origin/<base>`). 로컬 `<base>` 는 **움직이지 않는다**(사용자 체크아웃 불변). 선택된 시작점 커밋을 `run.baseSha` 에 기록. 이후 diff/ahead 는 `merge-base <base> HEAD` 기준(§2.9) — fetch 로 시작점이 앞서 있어도 `git merge-base origin/<base>` 가 아니라 `run.baseSha` 를 base 로 쓴다(`mergeBase = git merge-base <baseSha> HEAD`).
6. `git worktree add --no-track -b <branch> -- <absDir> <startPoint>` (**타임아웃 10분** — 비동기 구간이므로 길게. LFS/대형 저장소). 실패 → `git worktree remove --force -- <absDir>` + `git branch -D <branch>` + `git worktree prune` 으로 되돌린 뒤 run `failed {WORKTREE_ADD_FAILED, stderr 앞 300자}`. `<absDir>/.gitmodules` 가 있으면 `git submodule update --init --recursive`(10분, 실패는 경고 로그).
7. env 파일 복사(`copyEnv`, 기본 true): `top` 과 `top/<subdir>` 의 `.env`, `.env.*`(단 `.env.example`·`.env.sample`·`*.example` 제외) 중 **worktree 안에서** `git check-ignore -q -- <rel>` 가 참이고 심링크가 아니며 1MB 이하인 파일만 같은 상대경로로 복사. `run.copiedFiles`(worktree 상대경로) 기록. `node_modules` 는 복사하지 않는다.
8. 워크스페이스 등록: `backFetch('POST','/api/daemon/workspaces', {name: '<repoSlug>-<t6>-<k>', compute:'local', localPath: run.cwd, hostDeviceId, remoteUrl: null, stack: null})` → `run.workspaceId`. `remoteUrl` 을 보내지 않고 이름이 유일하므로 `resolveProjectId` 가 저장소 프로젝트 그룹에 합류시키지 않는다(workspaceService.js:265-279 는 remoteUrl **또는 이름 일치**로 합류). 실패는 치명 아님(null, reconcile 재시도).
9. 터미널 생성: `const {session, abs} = pty.sessionForCwd(run.cwd)`(`session === 'codingpt'` 홈 폴백이면 `WORKTREE_MISSING`) → `pty.createTerminal(session, abs)`(시그니처 무변경) → `run.tid/tsession`. 이름: `termBackend.rename(tsession, `${agent} #${idx}`)`. `poolChanged()` 는 **작업의 모든 터미널이 생긴 뒤 1회**(코얼레싱 — ui_command 는 유저당 10/s 상한, daemonRelayService.js:1084).
10. run `launching`, `launchedAt=now`; `launch({cwd: run.cwd, index: run.tid, id: run.agent, args, timeoutMs: 12000})`. `busy:true` 면 `LAUNCH_BUSY`, throw 면 `failed`(`AGENT_LAUNCH_FAILED`).
    - **런치 인자(`promptMode:'arg'`)**: agents.js CATALOG 에 `promptArg` 추가 — `claude: {positional:true}`, `codex: {positional:true}`, `gemini: {flag:'-i'}`, `cursor-agent: null`, `opencode: null`. `launchAgentInTerminal` 은 `a.args`(문자열 배열)를 받으면 `command + ' ' + args.join(' ')` 를 literal 로 타이핑한다(기존 `agents.launch` 호출은 args 없음 → 동작 동일). tasks.js 가 만드는 인자: POSIX 셸(zsh/bash/sh — `termBackend.info(tsession).command` 로 판정) → `"$(cat '<promptFileAbs>')"`; `fish` → `(cat '<promptFileAbs>' | string collect)`. 경로는 데몬이 만든 것(공백·따옴표 없음)이고 **프롬프트 내용은 셸 평가를 거치지 않는다**. CLI 가 폴더 신뢰 확인을 끝낸 뒤 프롬프트를 스스로 제출하므로 붙여넣기 타이밍 문제가 없고 훅 없는 에이전트(gemini)도 받는다. 부록 B-2.
    - `promptArg:null` 인 에이전트 → `promptMode:'paste'`, 11 단계.
10b. **폴더 신뢰 다이얼로그**(새 worktree 는 항상 처음 보는 폴더다 — claude 의 "Do you trust the files in this folder?", codex 의 프로젝트 신뢰 질문. agent-state.js:224 가 codex 는 이 질문 중 sessionId 가 없다고 적어 두었고, runner-core 에 신뢰 다이얼로그 처리 코드는 없다): 런치 뒤 20초 동안 500ms 간격으로 `status-line.extractDialog(screen)` 를 본다. 다이얼로그가 있고 제목이 `TRUST_DIALOG_RE = /trust/i` 에 맞으면 `run.trustPending=true`, `run.trustTitle=<제목>` 저장 + notify(reason 'run') — 현황판은 이 run 을 **입력 대기**로 올리고 카드에 [신뢰하고 계속] 을 그린다 → `task.run.trust {taskId, runId}` → 데몬이 `chatDialog({cwd, tid, pick:1, expect: run.trustTitle})`(driveDialog 의 expect 대조로 다른 질문에 답하는 사고 방지) → `trustPending=false`. 사용자가 터미널에서 직접 답해도 다음 폴링(5s 간격, trustPending 인 동안만)에서 다이얼로그가 사라진 것을 보고 `trustPending=false`. **자동 수락은 하지 않는다**(`~/.claude.json`·codex config 무기록 — 부록 B-1).
11. 프롬프트 배달(`promptMode:'paste'` 에만, 그리고 `task.run.prompt` 재전송에 항상): "에이전트 준비됨" 판정은 **정확히 다음 셋 중 하나**(최대 30s, 250ms 폴링):
    - (a) `agentState.attachmentOf(tsession).attached === true` **이고** `agentState.rawStateOf(tsession) !== 'launching'`(신규 export — `statusOf` 는 launching 을 idle 로 접고 레코드 없음도 idle 이라 게이트가 되지 않는다, agent-state.js:521-525);
    - (b) 이 tsession 의 `SessionStart` 훅이 `run.launchedAt` 이후에 도착(subscribe 콜백에서 `ctx.ev === 'session_start'` 기록);
    - (c) `agentWatch.agentSignalOf(tsession, paneCmd, paneTitle)`(실제 시그니처 `(session, cmd, title)`, agent-watch.js:129 — `paneCmd/paneTitle` 은 `termBackend.info(tsession)` 의 `command/title` 한 번에서) 가 `on === true` 이고 `paneCmd` 가 셸이 아니며 `extractDialog(screen) === null` 이고 그 상태가 2s 유지.
    준비되면 `chatInput({cwd: run.cwd, tid: run.tid, text, submit:true})` → `promptDelivered=true`, run `running`. 타임아웃이면 run `running` + `promptDelivered=false`, `error={code:'PROMPT_NOT_DELIVERED'}` → 카드 [프롬프트 다시 보내기]. **셸에 그냥 타이핑하지 않는다**(단위 테스트: pane command 가 셸인 동안 chatInput 이 호출되지 않는다, §7.1).
    `promptMode:'arg'` 인 run 은 런치 명령 입력 완료 시점에 `promptDelivered=true`, run `running`(CLI 가 제출한다 — E2E 2 가 claude·codex 모두 실측).
12. 각 단계마다 저장 + `notify`.

`task.run.prompt {taskId, runId, text?}`(동기, 20s): `text` 없으면 저장된 prompt(UTF-8 30000 바이트 이하라 chatInput 32KB 상한 cpt-server.js:1357 안). 11 의 준비 판정을 거쳐 `chatInput`, 성공 시 `promptDelivered=true`, `review_ready` 였다면 `running`.
`task.run.trust {taskId, runId}`(동기, 15s): 10b 의 응답. 다이얼로그가 이미 없으면 `{ok:true, dialog:null}` 이고 `trustPending=false`.

### 2.6 터미널 = 보통 터미널
- run 터미널은 `terminal.list {cwd: run.cwd}` 에 그대로 나온다. `terminal-manifest` 가 재부팅 뒤 같은 tid 로 복원한다(단, **빈 셸로** 복원된다 — 에이전트는 안 돈다. §2.11 `agentGone`).
- 삭제: `task.discard`/정리는 **`pty.handleTerminalRpc('terminal.close', {cwd: run.cwd, index: run.tid})`** 를 부른다(kill + `terminal-manifest.forget`, pty.js:757-764 — `termBackend.kill` 직접 호출은 매니페스트 항목을 남겨 같은 이름의 폴더가 다시 생기면 재부팅 때 부활한다). 사용자가 터미널을 먼저 닫아도 run 은 남고 `terminalAlive:false` → [터미널 다시 열기](`task.run.reopen`: 9~10 재실행, 프롬프트 없이 `claude --continue`/`codex resume --last`/그 외는 맨 명령 — `agents.js` CATALOG 에 `resumeArgs` 추가).
- `hasCptContext` 는 `cpt-` 접두 세션이면 통과 → cpt·훅이 worktree 터미널에서도 그대로 동작한다.

### 2.7 review_ready 판정 (훅 기반) + 알림 중복 억제

`agent-state.js` 에 추가:
```js
const listeners = new Set();
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// bump() 끝에: for (const fn of listeners) { try { fn(rec, prev, ctx); } catch (_) {} }
function rawStateOf(key) { const rec = states.get(String(key || '')); return rec ? rec.state : null; }   // launching 을 접지 않는 원본
// configure({ shouldNotify }) — fire 직전에 shouldNotify(rec, kind) === false 면 알림을 내지 않는다(기본 true).
```
`tasks.js` 는 `start()` 에서 `subscribe` 하고 `tsession → {taskId, runId}` 색인으로 자기 run 만 처리한다. 또 `agentState.configure({shouldNotify: (rec, kind) => !(index.has(rec.key) && kind === 'done' && runHasChanges(rec.key))})` 를 등록한다 — agent-state 의 `stop` 처리가 모든 터미널에 kind `done` 알림을 낸다(agent-state.js:397-414 → fire → POST /api/notifications). run 터미널에서 변경이 있는 턴 종료는 `task_ready` 로 대체하고 `done` 을 억제한다; 변경이 없으면 `done` 을 그대로 통과시킨다(그 턴은 `task_ready` 가 없다).

| 전이 (rec.state) | ctx.ev / source | run 처리 |
|---|---|---|
| `* → working` | prompt / watch | `review_ready → running`, `lastActivityAt`, `trustPending=false` |
| `working → idle` | `stop` (hook) 또는 watch 로 idle | 1.5s 디바운스 후 `refreshRun(run)`(§2.9): `diff.files>0 || commits.ahead>0` 면 `review_ready` + 알림 `task_ready`(턴당 1회: `reviewNotifiedAt < lastTurnEndedAt` 일 때만). 변경 0 이면 `running` 유지 |
| `* → idle` | `stop_failure` | `lastTurnFailed=true`, 위와 같은 diff 갱신. 알림은 **내지 않는다**(agent-state 가 이미 `error` 알림을 낸다) |
| `* → permission / needsInput` | | 저장 없음(라이브) — `lastActivityAt` 갱신·`notify` 로 카드 재정렬 |
| `* → ended` | session_end | `refreshRun`; 변경 있으면 `review_ready` |
| (any) | `session_start` | `run.sessionStartedAt=now`(§2.5 11-(b)) |

훅이 없는 에이전트(tier launch)는 agent-watch 폴백 전이(source 'watch')로 같은 표를 탄다. 아무 신호도 없으면 상세 화면의 [변경 확인](`task.diff`)이 `refreshRun` 을 겸한다.

### 2.8 변경 통지 `tasks.changed`

`notifyTasksChanged(payload)`: 300ms 코얼레싱 후 `sendUiCommand('tasks.changed', {host: cfg.deviceId, taskIds:[...], reason}, {mode:'broadcast', timeoutMs:5000})`. `host` 가 필요한 이유: back 은 `{cmd, params, uiId, executor}` 만 전달하고 발신 데몬 id 를 붙이지 않는다(daemonRelayService.js:1180-1186). **수신 클라이언트 둘 다 `ui_result ok` 로 응답해야 한다**(executor 가 응답하지 않으면 데몬이 UI_TIMEOUT 을 본다). `reason ∈ {created, run, diff, pr, merged, discarded, failed, deleted, reconciled, op}`. `poolChanged()` 는 tasks.js 안에서 500ms 코얼레싱.

### 2.9 git 작업 상세

모든 git 작업의 cwd 는 `run.dir`(worktree 루트) 절대경로. 접두는 §2.4. `refreshRun(run)`(직렬화: run 당 1개만 진행, 겹치면 마지막 요청만 재실행):
- `git status --porcelain=v1 -z --untracked-files=all` → `dirty`, 미커밋 파일 수.
- `mergeBase = git merge-base <baseSha> HEAD`; `git rev-list --count <mergeBase>..HEAD` → `commits.ahead`.
- `git diff --numstat -z --no-ext-diff --no-textconv <mergeBase>`(워킹트리+인덱스 vs merge-base, 한 번) + `git ls-files --others --exclude-standard -z` 의 미추적 파일(텍스트만 줄수 세기, 바이너리 제외) → 경로로 dedupe → `diff {files, additions, deletions}`.
- upstream: `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` 성공 + `git rev-list --count @{upstream}..HEAD === 0` → `pushed:true`.
- 결과 저장 + notify(reason 'diff').

`task.diff` 파일 목록:
1. `git diff --name-status -z --no-ext-diff --no-textconv <mergeBase>` + `git ls-files --others --exclude-standard -z`(미추적 = `?`). 이 두 목록의 합집합이 **허용 파일 집합**이다.
2. 파일별 diffText: `git diff --no-ext-diff --no-textconv <mergeBase> -- <file>`; 미추적은 `git diff --no-index --no-ext-diff --no-textconv -- /dev/null <file>`. 바이너리는 `binary:true`.
3. **`file` 파라미터는 1 의 허용 집합에 정확히 일치할 때만** 받는다(그 외 `BAD_PARAMS`). 추가로 `realpath(path.resolve(worktreeAbs, file))` 가 worktree 안이어야 한다(`--no-index` 는 저장소에 묶이지 않아 `../../daemon.json` 같은 경로가 임의 파일을 읽는다 — deviceToken 이 worktrees/ 의 형제 `daemon.json` 에 있다).
4. 상한: 파일당 64KB(초과 `truncated:true`), 전체 400KB(초과분 파일은 `diffText` 생략 + `omitted:true`, 클라가 `file` 지정으로 개별 조회 최대 1MB). 파일 수 상한 500.

**비동기 op 공통 규칙(§2.12)**: 아래 변이는 `{accepted:true, opId, run}` 을 즉시 돌려주고 백그라운드에서 실행, 결과는 `run.lastOp` + `tasks.changed reason:'op'`. 데드라인 초과 시 자식 kill + `lastOp {ok:false, code:'TIMEOUT'}`.

`git.commit {message, noVerify?=false}`(op, 데드라인 5분 — worktree 에는 node_modules 가 없어 husky/lint-staged 가 느리거나 실패한다):
- 복사한 시크릿이 커밋되지 않게 `git add -A -- . ':(exclude)<copied>'…`(`run.copiedFiles` 전부 exclude pathspec) 후 `git commit --message=<m> [--no-verify]`. `user.email` 빈 값 → `GIT_IDENTITY_MISSING`(봇 신원 주입 금지). 변경 0 → `NOTHING_TO_COMMIT`. `index.lock` 오류 → 0.5/1/2s 백오프 3회 재시도 후 `GIT_LOCKED`. 훅 실패(exit≠0, stderr 에 husky/pre-commit/lint-staged 또는 `--no-verify` 없이 훅 스크립트 실패) → `COMMIT_HOOK_FAILED` + `lastOp.result.stderrTail`(마지막 2KB). `commit.gpgsign` 은 **존중**한다(끄지 않는다) — 서명 실패(stderr `gpg failed|signing failed|ssh-keygen`) → `GIT_SIGN_FAILED`(안내: 터미널에서 한 번 커밋하거나 `git config commit.gpgsign false`). 성공 `result {sha, short}`.

`git.push`(op, 3분): 원격 없음 → `NO_REMOTE`. `git push -u origin <branch>`. stderr `rejected` → `PUSH_REJECTED`, `Authentication failed|Permission denied|could not read Username` → `AUTH_FAILED`. 성공 `result {remote:'origin', branch}`.

`git.pr.create {title, body?, draft?=false, push?=true, commitMessage?}`(op, 5분): `repo.github` 없으면 `NOT_GITHUB`(§2.4). **`dirty` 이고 `commitMessage` 가 있으면 먼저 `git.commit` 규칙으로 커밋**(폰에서 커밋·푸시·PR 을 한 시트로), `commitMessage` 없이 dirty 면 `UNCOMMITTED_CHANGES`. ahead 0 → `NOTHING_TO_PR`. `pushed` 아니면 push 선행. `gh pr create --repo <o/r> --head <branch> --base <base> --title=<t> --body-file=- [--draft]`(body 는 stdin) → URL → `gh pr view --repo <o/r> <number> --json …` 으로 `pr`. 이미 있으면(`already exists`) view 로 회수하고 **성공 결과** `result {pr, existed:true}`(에러 코드 아님 — 에러 페이로드는 데이터를 못 싣는다, §2.13).

`git.pr.status`(동기, 30s): `gh pr view --repo <o/r> <branch> --json number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,baseRefName,title,mergedAt` → PrInfo. `statusCheckRollup` 을 `checks {status, total, passed, failed, pending, items[≤20]}` 로 접는다. **`state === 'MERGED'` 를 처음 보면** `git.pr.merge` 성공과 같은 완료 경로(승자 확정·정리·`task_merged` 알림)를 탄다(GitHub 웹에서 머지한 경우). `CLOSED` 는 `pr.state:'closed'` 로만 표시("PR 닫힘"), 아무것도 정리하지 않는다. 웹 머지 경로는 에이전트가 `working` 이거나 로컬 HEAD 가 PR head(`headRefOid`, 없으면 `@{upstream}`) 뒤에 커밋을 더 갖고 있으면 승자 worktree·브랜치·터미널을 **건드리지 않고** `lastOp.result.cleanupSkipped = 'AGENT_BUSY'|'UNMERGED_COMMITS'` 만 기록한다(2026-09-29 리뷰). 무변화 조회는 `tasks.changed` 를 내지 않는다(PR 필드가 바뀔 때만).

`git.pr.merge` 는 `gh pr merge` 가 0 으로 끝나도 **다시 조회한 PR 이 `merged` 일 때만** 완료 경로를 탄다 — 머지 큐·자동 머지 예약이면 PR 은 OPEN 인 채다. 그때 op 결과는 `{merged:false, queued:true, pr}`(ok), run 은 `review_ready`, 원격 브랜치는 지우지 않는다(지우면 큐에서 빠져 PR 이 닫힌다). 마무리는 `git.pr.status` 가 MERGED 를 볼 때(위 웹 머지 경로). 작업당 승자는 1명 — 머지 본문은 시작 즉시 작업 단위 표식을 잡고(같은 작업의 다른 run 머지는 `RUN_BUSY`), 저장소 락 안·`gh pr merge` 직전에 `t.state==='open' && !winnerRunId` 를 다시 확인한다(아니면 `TASK_CLOSED`).

`git.pr.merge {method, discardOthers?=true, force?=false}`(op, 3분): 전제 — run 이 `dirty` 면 `UNCOMMITTED_CHANGES`, 라이브 agent_state 가 `working` 이면 `AGENT_BUSY`, `pr` 없으면 `PR_NOT_FOUND`. run `merging`. `gh pr merge --repo <o/r> <number> --<method>`(`--delete-branch` 는 쓰지 않는다 — gh 가 로컬 브랜치를 지우려다 worktree 때문에 실패한다). `mergeable:'CONFLICTING'` → `PR_NOT_MERGEABLE`; 체크 실패 → `CHECKS_FAILING`(`force:true` 면 그냥 시도). 성공 → **즉시** `lastOp.result = MergeResult {ok:true, sha, cleanup:'pending', discarded:[], discardSkipped:[]}`, run `merged`, task `merged`, winner, `task_merged` 알림 → 이어서 백그라운드로 (1) 원격 브랜치 삭제 `git push origin --delete <branch>`(실패는 경고) (2) `git fetch origin <base>` 후 로컬 `<base>` 가 체크아웃되지 않았거나(어느 worktree 에도) 체크아웃돼 있고 clean 이면 `git fetch origin <base>:<base>`(fast-forward 만; 실패는 경고) — 다음 작업이 머지된 코드에서 시작하게 (3) §2.10 정리 → `tasks.changed reason:'merged'` (4) `discardOthers` → `reason:'discarded'`, `lastOp.result.cleanup='done'`, `discarded/discardSkipped` 갱신.

`git.merge.local {method, discardOthers?=true}`(op, 3분): 전제 — run `dirty` → `UNCOMMITTED_CHANGES`, 라이브 `working` → `AGENT_BUSY`. base 가 **어디에 체크아웃돼 있는지**(`git worktree list --porcelain` 의 `branch refs/heads/<base>`)로 분기:
- (a) 어디에도 없음 → 임시 detached worktree `<WORKTREES>/.merge-<t6>` 를 `<base>` 커밋으로 만들어 그 안에서 머지 → 성공 시 `git update-ref refs/heads/<base> <newSha> <oldSha>`(CAS — 그 사이 base 가 움직였으면 `BASE_MOVED`) → 임시 worktree 제거.
- (b) 메인 worktree(`repo.path`)에 체크아웃 + clean → 거기서 머지(체크아웃이 곧 갱신된다).
- (c) 체크아웃 + dirty → `MAIN_DIRTY`(폰에서는 해결 못 함 — 안내: PC 에서 커밋/스태시).
`method`: `merge` → `git merge --no-ff --message=<Merge cpt/...> -- <branch>`, `squash` → `git merge --squash -- <branch>` + `git commit --message=<title>`, `ff` → `git merge --ff-only -- <branch>`. 충돌 → `git merge --abort` 후 **성공 결과** `MergeResult {ok:false, code:'MERGE_CONFLICT', files:[…]}`(run 은 `review_ready` 복귀). 성공 → pr.merge 와 같은 완료 경로(원격 삭제 없음).

`git.branches {repo}`(동기): 로컬 브랜치 최대 200 + `current`, `detached`, `dirtyCount`(메인 체크아웃의 `status --porcelain` 줄 수 — 시트가 "main 에 미커밋 변경 N개는 포함되지 않아요" 를 그린다), `github`(캐시된 `repo view` 결과 또는 null).

### 2.10 정리(cleanup)

`cleanupRun(run, {force, reason})`(op kind 'discard' 또는 'cleanup'):
1. **정리 시점에 다시 계산**한다(`run.dirty` 캐시 금지): `git status --porcelain=v1 -z` → 변경 있으면 `UNCOMMITTED_CHANGES`(force 아니면). 없으면 `commits.ahead > 0` 이고 브랜치가 `<base>` 에 머지되지 않았고(`git merge-base --is-ancestor <branch> <base>` 거짓) `pushed` 도 아니면 `UNMERGED_COMMITS`(force 아니면). 둘 다 사용자 확인 뒤 `force:true` 로만 진행하고, `discardOthers` 는 이 둘을 `discardSkipped` 로 남긴다.
2. 터미널: `pty.handleTerminalRpc('terminal.close', {cwd: run.cwd, index: run.tid})`(멱등) → `poolChanged()`.
3. 복구 ref: `git update-ref refs/codingpt/discarded/<runId> <HEAD sha>` — 30일 지난 것은 reconcile 이 `git update-ref -d` 로 정리한다(`merged` 인 run 도 기록한다; 비용 0).
4. `git worktree remove --force -- <absDir>`(dirty 검사는 1 에서 끝났으므로 항상 `--force`; 서브모듈 있는 worktree 는 force 없이는 거부된다) → 실패 시 **다음 셋을 모두 만족할 때만** `rm -rf`: `realpath(absDir)` 가 `realpath(WORKTREES)` 의 엄격한 하위 · 심링크 아님 · 이 저장소의 `git worktree list --porcelain` 에 나옴. 그 뒤 `git worktree prune`. 그래도 실패 → `WORKTREE_REMOVE_FAILED`(run 은 남긴다).
5. `git branch -D <branch>` (3 의 복구 ref 가 있으므로 안전).
6. 프롬프트 파일 삭제. `run.workspaceId` 있으면 `backFetch('DELETE', '/api/daemon/workspaces/<id>')`(실패 무해, reconcile 재시도).
7. `run.cleanup = {…, recoveryRef, at}`. 저장·notify.

`task.discard {taskId, runId?, force?}`(op, run 마다): runId 없으면 전 run. 모든 run 이 `discarded` 가 되면 task `closed`.
`task.delete`(레코드 삭제, 동기)는 종결 상태에서만. `task.list` 는 종결 후 30일 지난 작업을 기본 제외(`includeClosed:true` 로 전부).

### 2.11 기동 reconcile

`tasks.start()`(cpt-server `start()` 에서 configure 직후; `hello_ack` 뒤에도 워크스페이스 재등록 부분만 재실행):
- `creating` run: worktree 폴더가 있고 `git worktree list` 에 있으면 7 단계부터 재개; 아니면 6 의 되돌리기(worktree remove/branch -D/prune) 후 `failed {OP_INTERRUPTED}`.
- `launching` run: `failed {OP_INTERRUPTED}` + [다시 열기].
- open run 마다: worktree 폴더 없음 → `failed {WORKTREE_MISSING}`; 폴더는 있는데 `git worktree list --porcelain` 에 없음 → `git worktree prune` 뒤 재검사.
- `run.op` 가 남아 있으면(데몬이 죽었음) null 로, `lastOp={opId, kind, ok:false, code:'OP_INTERRUPTED'}`, `merging` 이었으면 `review_ready` 로.
- `trustPending` 이면 다이얼로그 존재를 다시 확인(없으면 false).
- 응답 시점 계산(`task.list`/`task.get`, 세션 목록 1회 조회로 일괄): `terminalAlive = termBackend.info(tsession)` 성공; `agentGone = terminalAlive && SHELLS.has(info.command) && !agentState.attachmentOf(tsession).attached`(재부팅 뒤 `terminal-manifest.restoreIfNeeded` 가 빈 셸로 복원한 경우). 카드 [에이전트 다시 실행] = `task.run.reopen`(터미널이 살아 있으면 재생성 없이 10 단계만: `resumeArgs` 로 대화 이어가기).
- `workspaceId` 가 null 인 살아 있는 run 은 워크스페이스 등록 재시도.
- 30일 지난 `refs/codingpt/discarded/*` 삭제.
- 완료 뒤 `notify({reason:'reconciled'})`.

### 2.12 동시성 / 락 / 멱등

- 스토어 변이는 `mutate(fn)` 하나로: 동기 load → fn → 동기 save.
- **run 당 `op` 락**: 변이 RPC(commit/push/pr.create/pr.merge/merge.local/discard/reopen)는 `op` 가 있으면 `RUN_BUSY`. **락은 자식 프로세스가 종료했을 때만** 풀린다(데드라인에 자식을 kill 한 뒤). 데몬 재시작은 §2.11 이 푼다.
- **opId 멱등**: 모든 변이 RPC 는 `opId`(클라 UUID v4, 필수)를 받는다. run 의 `opIds` 에 같은 opId 가 있으면 다시 실행하지 않고 그 결과를 돌려준다: 진행 중이면 `{accepted:true, opId, replay:true}`, 끝났으면 `{accepted:true, opId, replay:true, lastOp}`. 이유: 봉인 타임아웃 뒤 클라가 재전송해도 이중 실행(worktree 중복·머지 2회)이 없다. `task.create` 도 `opId` 를 받아 task 단위로 같은 규칙(`opId → taskId` 표 최근 50개).
- 저장소 당 락(`repoLocks: Map<repo.common, Promise>`): `worktree add/remove`, `merge.local`, `fetch origin <base>:<base>` 직렬화. 키는 `git-common-dir` 의 realpath(같은 저장소의 두 워크스페이스가 다른 path 로 경쟁하지 않게).

### 2.13 에러 코드 (와이어 `{code, message}`; `message` 는 한국어 원문, 클라는 code 로 i18n)

**던지는 에러는 `code`+`message` 만 싣는다.** 데이터가 딸린 실패(충돌 파일 목록, 이미 있는 PR)는 **성공 결과**로 돌려준다 — 봉인 경로는 `{e, code}` 만 봉인하고(e2ee.js:1048), 평문 경로는 control.js 가 `{error, code}` 만 보내며 back 릴레이도 `code` 만 남기고(daemonRelayService.js:340), PC 로컬 소켓은 `CODE: msg` 문자열이다(cptsock.rs `cpt_request_coded`). 세 경로 어디에서도 구조가 살아남지 못한다.

| code | 뜻 / 클라 처리 |
|---|---|
| `BAD_PARAMS`, `PROMPT_TOO_LARGE` | 검증 실패 / 프롬프트 UTF-8 30000 바이트 초과 |
| `TASK_NOT_FOUND`, `RUN_NOT_FOUND`, `TASK_CLOSED`, `TASKS_DISABLED` | |
| `NOT_A_REPO`, `BASE_NOT_FOUND`, `BASE_MOVED`, `TASK_LIMIT` | |
| `AGENT_NOT_INSTALLED` | 에이전트 CLI 없음(`agents.list` 기준) |
| `GIT_MISSING`, `GIT_CLT_MISSING` | git 없음 / CLT 없음 — 안내 화면 |
| `GH_MISSING`, `GH_NOT_AUTHED`, `GH_ERROR` | gh 안내 화면(§6.7) |
| `NOT_GITHUB`, `NO_REMOTE` | PR 불가 → 로컬 머지 버튼만 |
| `WORKTREE_ADD_FAILED`, `WORKTREE_MISSING`, `WORKTREE_REMOVE_FAILED` | |
| `AGENT_LAUNCH_FAILED`, `LAUNCH_BUSY`, `PROMPT_NOT_DELIVERED`, `TERMINAL_GONE` | |
| `UNCOMMITTED_CHANGES`, `UNMERGED_COMMITS` | 커밋 먼저 / 강제 폐기 확인 |
| `NOTHING_TO_COMMIT`, `NOTHING_TO_PR`, `GIT_IDENTITY_MISSING`, `GIT_LOCKED`, `COMMIT_HOOK_FAILED`, `GIT_SIGN_FAILED` | |
| `PUSH_REJECTED`, `AUTH_FAILED` | |
| `PR_NOT_FOUND`, `PR_NOT_MERGEABLE`, `CHECKS_FAILING` | |
| `MAIN_DIRTY`, `AGENT_BUSY` | (`MAIN_NOT_ON_BASE` 는 없다 — §2.9 (a) 가 처리) |
| `MERGE_CONFLICT` | **결과 코드**(`MergeResult.ok:false`) — 에러로 던지지 않는다 |
| `RUN_BUSY`, `OP_INTERRUPTED` | |
| `TIMEOUT` | 데몬 내부 데드라인(자식 kill 됨) 또는 back 릴레이 타임아웃 — 클라는 `task.get` 재조회로 실제 결과 확인 |

**code 가 도착하는 자리(3 경로 정본)**: 봉인 → 클라 `E2eeError.code`(봉투 `{e, code}`); back 평문 → HTTP 500 body `detail.code`(back `taskRpc` 가 `e.publicDetail = {code: e.code}` 로 붙인다 — `utils/response.js` 무수정, `errorResponse` 는 `publicDetail` 만 `detail` 로 싣는다); PC 로컬 소켓 → 문자열 접두 `^([A-Z_]+): ` 를 `tasks-api.js` 가 파싱. back 릴레이 타임아웃(메시지 `데몬이 응답하지 않습니다(RPC 타임아웃).`, code 없음)은 back `taskRpc` 가 `code:'TIMEOUT'` 으로 매핑한다.

---

## 3. RPC 계약

### 3.1 메서드 표

공통: 모든 params 는 JSON 객체. `taskId`/`runId` 문자열. 타임아웃은 **back 평문 allow-list 의 값**; 클라이언트 HTTP 타임아웃은 그 값 **+5s**(back 의 에러가 먼저 도착하게). 변이(op)는 즉시 회신이라 전부 15s.

| method | params | result | timeout | 종류 |
|---|---|---|---|---|
| `task.list` | `{includeClosed?:bool, repo?:string}` | `{items: TaskLite[], caps:{gh:GhStatusLite}}` | 15s | 읽기 |
| `task.get` | `{taskId}` | `{task: Task}` | 15s | 읽기(prompt 포함) |
| `task.create` | `{opId, repo, base, prompt, title?, agents:[{id,count}], copyEnv?=true, fetch?=false, workspaceId?}` | `{task: TaskLite}` | 15s | 즉시 회신, 이후 비동기 |
| `task.run.prompt` | `{taskId, runId, text?}` | `{ok, delivered:bool}` | 20s | 동기 |
| `task.run.trust` | `{taskId, runId}` | `{ok, dialog:null|Dialog}` | 15s | 동기 |
| `task.run.reopen` | `{opId, taskId, runId}` | `OpAccepted` | 15s | op → `lastOp.result {tid}` |
| `task.diff` | `{taskId, runId, file?:string}` | `TaskDiff` | 30s | 읽기 |
| `task.discard` | `{opId, taskId, runId?, force?=false}` | `OpAccepted` | 15s | op → `lastOp.result {discarded:[runId], skipped:[{runId, code}]}` |
| `task.delete` | `{taskId}` | `{ok}` | 15s | 동기, 종결 상태만 |
| `git.branches` | `{repo}` | `{current, detached, dirtyCount, branches:[{name}], remoteUrl, github|null}` | 15s | 읽기 |
| `git.status` | `{taskId, runId}` | `RunGit` | 15s | 읽기(`refreshRun` + `{branch, base, baseSha, upstream, aheadUpstream, behindUpstream, lastCommit}`) |
| `git.commit` | `{opId, taskId, runId, message, noVerify?=false}` | `OpAccepted` | 15s | op → `{sha, short}` |
| `git.push` | `{opId, taskId, runId}` | `OpAccepted` | 15s | op → `{remote, branch}` |
| `git.pr.create` | `{opId, taskId, runId, title, body?, draft?=false, push?=true, commitMessage?}` | `OpAccepted` | 15s | op → `{pr, existed:bool}` |
| `git.pr.status` | `{taskId, runId}` | `{pr: PrInfo|null, run: RunLite}` | 30s | 읽기(상세 열림 중 30s 폴링) |
| `git.pr.merge` | `{opId, taskId, runId, method:'merge'|'squash'|'rebase', discardOthers?=true, force?=false}` | `OpAccepted` | 15s | op → `MergeResult` |
| `git.merge.local` | `{opId, taskId, runId, method:'merge'|'squash'|'ff', discardOthers?=true}` | `OpAccepted` | 15s | op → `MergeResult` |
| `git.gh.status` | `{refresh?:bool}` | `GhStatus` | 15s | 읽기 |

```ts
type TaskLite = Omit<Task,'prompt'|'runs'> & { runs: RunLite[] };
type RunLite  = Run;
type OpAccepted = { accepted:true, opId:string, replay?:true, run: RunLite, lastOp?: Run['lastOp'] };
type TaskDiff = { taskId, runId, base, baseSha, head:string|null, mergeBase:string, uncommitted:boolean,
                  files: { path:string, status:'A'|'M'|'D'|'R'|'?'|'B', additions:number, deletions:number,
                           binary?:boolean, diffText?:string, truncated?:boolean, omitted?:boolean }[],
                  totals:{files, additions, deletions}, truncatedTotal:boolean };
type PrInfo   = { number, url, state:'open'|'merged'|'closed', isDraft:boolean, title,
                  mergeable:'MERGEABLE'|'CONFLICTING'|'UNKNOWN', mergeStateStatus:string, reviewDecision:string|null,
                  checks:{ status:'none'|'pending'|'passing'|'failing', total, passed, failed, pending,
                           items:{name, status:'pending'|'passing'|'failing'|'skipped', url?}[] },
                  at:number };
type MergeResult = { ok:true, sha:string, cleanup:'pending'|'done', discarded:string[], discardSkipped:{runId, code}[] }
                 | { ok:false, code:'MERGE_CONFLICT', files:string[] };
type GhStatus = { git:{ok, path, version, error?}, gh:{installed, path, version, authenticated, user, host:'github.com', error?} };
type GhStatusLite = { gitOk:boolean, ghInstalled:boolean, ghAuthed:boolean };
type Dialog = ReturnType<typeof extractDialog>;   // status-line.js 의 {title, options[]} 그대로
```

### 3.2 전송 경로 — 전용 래퍼 `taskRpc`

```
taskRpc(method, params, hostDeviceId, timeoutMs)     // PC tasks-api.js / 앱 taskService.ts
   ├─ sealedRpc(...)  → 결과 객체 → 끝
   ├─ 봉인 실패 code ∈ SEALED_STRUCTURAL ∪ {E2EE_NO_ENVELOPE, E2EE_BAD_METHOD} 또는 HTTP 501 (구 데몬·열쇠 없음·미지원)
   │      → 정책이 required 면 throw, 아니면 평문: POST /api/daemon/task {method, params, hostDeviceId}
   └─ 그 외(타임아웃·5xx·네트워크·도메인 code) → **throw. 평문 재전송 금지.**
```
기존 `sealedFs`/`mayFallbackFor`(e2eeState.ts:58-63 — 4xx/5xx 전부 폴백)를 **쓰지 않는다**: 봉인 타임아웃 뒤 평문으로 같은 변이를 다시 보내면 이중 실행이다(opId 멱등이 2차 방어이지만 1차는 여기).
- 읽기(`task.list/get/diff`, `git.status/pr.status/branches/gh.status`)는 실패 시 **1회 재시도** 가능.
- 변이 호출이 어떤 에러로든 실패하면 클라는 "확인 중…" 을 그리고 `task.get` 을 1회 조회해 `run.op/lastOp/state` 로 실제 결과를 그린다(호스트가 이미 끝냈을 수 있다). `opId` 를 **같은 값으로** 재전송해도 안전하다(§2.12).
- LAN 직결은 쓰지 않는다.

### 3.3 back 평문 폴백 `POST /api/daemon/task` (accountAuth)

```js
const TASK_RPC_OK = new Map([
  ['task.list', 15000], ['task.get', 15000], ['task.create', 15000], ['task.run.prompt', 20000], ['task.run.trust', 15000],
  ['task.run.reopen', 15000], ['task.diff', 30000], ['task.discard', 15000], ['task.delete', 15000],
  ['git.branches', 15000], ['git.status', 15000], ['git.commit', 15000], ['git.push', 15000],
  ['git.pr.create', 15000], ['git.pr.status', 30000], ['git.pr.merge', 15000], ['git.merge.local', 15000], ['git.gh.status', 15000],
]);
```
body `{method, params, hostDeviceId}`. 미허용 메서드 400 `'허용되지 않은 명령입니다.'`. params 는 그대로 전달(데몬이 검증, surfaceRpc 선례). `taskRpc` 컨트롤러의 에러 처리: `DAEMON_OFFLINE` → 409(`mapRpcError`); 릴레이 타임아웃 메시지 → `e.code='TIMEOUT'`; 그 외 `e.publicDetail = {code: e.code || 'GH_ERROR'}` 로 `errorResponse(res, e, 500)` → body `{success:false, message, detail:{code}}`. `utils/response.js`·`daemonRelayService.js` 무수정.

봉인 경로(`/api/daemon/rpc`)는 무수정. `SEALED_TIMEOUT_MAX_MS=60000` 그대로(표의 최대 30s).

`config/caps.js`: `task.v1` 을 `SERVER_CAPS` 에 추가. `TASKS_ENABLED=0` 으로 회수.

### 3.4 이벤트 / 푸시

| 채널 | 프레임 | 발신 | 내용 |
|---|---|---|---|
| ui_command (기존) | `{cmd:'tasks.changed', params:{host, taskIds:[…], reason}}` | 데몬 → back → uiCmds 광고 클라이언트 전부 | 수신 클라는 `params.host` 의 `task.list` 재조회(300ms 디바운스) 후 **`ui_result ok`** |
| agent_state (기존) | `{cwd, win, state, agent, version, at, since, …, hostDeviceId}` | 데몬 → back → 전 클라 + ui_hello 리플레이 | `cwd === run.cwd && win === run.tid` 로 조인. `since` = 상태 전이 시각(agent-state.js:126) |
| approval_event (기존) | | | 입력 대기 판정에 사용 |
| notification (기존 `POST /api/notifications`) | `{source:'agent', kind, title, subtitle, cwd: run.cwd, win: run.tid, wsName, deeplink, workspaceId: run.workspaceId}` | 데몬 | kind: `task_ready` · `task_merged` · `task_failed`. `needs_input` 은 agent-state 의 `permission_request` 가 담당. run 터미널의 `done` 은 §2.7 `shouldNotify` 로 억제 |
| FCM | 위 알림의 `deeplink: codingpt://task/<taskId>?host=<hostDeviceId>&run=<runId>` | back(기존 라우팅) | 앱은 딥링크로 현황판 → 그 작업 상세. 푸시 `kind` 는 `task_*` 그대로이며 **라우팅은 deeplink 접두 `codingpt://task/`** 로 한다 |

알림 문구(데몬, 한국어 원문 — **작업 제목·브랜치명을 싣지 않는다**: back 이 title 을 DB 에 저장하고 `[notif-route] … title="…"` 로 로그에 찍는다, notificationService.js:143):
- task_ready: title `리뷰 준비 · {agent 표시명}`, subtitle `{repoSlug} · 파일 {n}개`.
- task_merged: title `머지 완료 · {agent 표시명}`, subtitle `{repoSlug} · {base}`.
- task_failed: title `작업 실패 · {agent 표시명}`, subtitle = 에러 code 의 한국어 message.
비한국어 사용자에게 한국어 푸시가 가는 것은 기존 agent-state 알림과 같은 **알려진 갭**(클라 로컬라이즈 없음).

클라 폴링 보강: 현황판이 보이는 동안 60s 마다 `task.list`; `runner_status online` 전이·WSS 재연결 시 즉시(+ `hostCaps` 재조회).

---

## 4. 워크스페이스 결합 규칙 (3 클라이언트 공통)

- **술어 하나**: `isTaskWorkspace(meta) = typeof meta.localPath === 'string' && /^\.codingpt\/worktrees\//.test(meta.localPath)`. PC `state.js`, 앱 `WorkspaceShellContext.tsx` 에 export.
- **기본 셀렉터에서 거른다**(개별 뷰가 아니라): PC `sortedWorkspaces()`(state.js:124 — `workspacesForDevice`·팔레트 워크스페이스 전환·`surface-sync`·`notifications.js`·`ui-channel.js`·`main.js` 가 전부 이걸 탄다), 앱 `WorkspaceShellContext` 의 워크스페이스 목록 훅(`SidebarContent`·`NotificationsPanel`·`UiCommandBridge`·`WorkspaceView` 가 소비). 활성화는 현황판 카드에서만 일어난다(`setActive(id, {allowTask:true})` — 필터를 우회하는 명시 옵션). 활성화되면 워크스페이스 뷰 헤더에 `작업: {title}` 배지 + [현황판] 링크.
- 카드 [터미널 열기] = `run.workspaceId` 가 목록에 없으면 **먼저 워크스페이스 목록 새로고침**(back 은 생성을 브로드캐스트하지 않는다) → `setActive(run.workspaceId, {allowTask:true})` → `activateNotifTerminal(run.workspaceId, run.tid)`. 새로고침 뒤에도 없거나 `workspaceId` 가 null 이면 버튼 비활성 + 툴팁 `wsNotRegistered`.
- 인앱 알림 패널(PC `notifications.js`, 앱 `NotificationsPanel.tsx`)에서 `kind` 가 `task_*` 인 항목은 cwd/win 라우팅 대신 `openTasksDashboard({taskId, runId, host})`(deeplink 파싱). 미읽음 배지는 작업 워크스페이스에 붙이지 않고 현황판 카드에 붙인다(§5.1 `unread`).
- 사용자가 보고 있는 작업 워크스페이스가 정리로 삭제되면(목록 새로고침에서 사라짐) 현황판으로 돌아가고 토스트 `wsRemoved`.
- 워크스페이스 삭제·정리는 데몬만 한다(클라는 `wsDelete` 를 부르지 않는다).
- agent_state 색인 키는 `(hostDeviceId, cwd=run.cwd, win=run.tid)`.

---

## 5. 현황판 데이터 모델 (PC·앱 공용 순수 로직 — 교차 테스트 대상)

파일: PC `src/js/tasks-model.js`, 앱 `src/workspace/tasks/tasksModel.ts`. **같은 입력에 같은 출력**(`test/tasks-crossimpl.mjs` 가 픽스처로 강제, §8.5).

### 5.1 입력
```ts
type Input = {
  now: number,
  hosts: { id:number, name:string, online:boolean, caps:string[] }[],            // runner_status + hostCaps(GET /status)
  tasks: { host:number, items: TaskLite[] }[],                                     // host 별 task.list
  agentSnaps: { host:number, cwd:string, win:number, agent:string, state:'idle'|'working'|'permission'|'needsInput', at:number, since:number|null }[],
  approvals: { id:string, host:number, cwd:string, win:number, createdAt:number }[],   // pending 만
  unread: { host:number, cwd:string, win:number, count:number }[],
  terminalsFallback: { host:number, cwd:string, win:number, agent:string|null, on:boolean, state:string|null }[],
  workspaces: { id:string, host:number, localPath:string, name:string }[],
};
```
- **host 정규화**: 모든 입력에서 `host` 는 숫자이며 **모름 = 0**(앱 스토어의 `host ?? 0` 규칙과 동일, agentStateStore.ts:54). PC 의 `agentStates` 는 `${cwd}|${win}` 키라 host 가 없다(state.js:770) → 신규 `listAgentSnaps()` 가 저장된 이벤트의 `hostDeviceId ?? 0` 을 `host` 로 돌려준다. run 행의 `host` 는 `tasks[].host`.
- `since` 는 agent_state 프레임의 `since`(데몬이 상태 전이 시각을 실어 보낸다, agent-state.js:126/177/549) — 두 스토어가 이 필드를 스냅에 보존한다(앱 `AgentSnap.since` 추가 전용).

### 5.2 행(row) 생성과 중복 제거
- 키 `k = ${host}|${cwd}|${win}`.
- (1) task run 행: **모든 task(상태 무관)의 run 중 `state ∉ {merged, discarded}`** → `kind:'run'`, `k = ${host}|${run.cwd}|${run.tid}`(tid 없으면 `${host}|${run.cwd}|-`). merged 작업에 남은 run(폐기 건너뜀)도 여기 들어온다.
- (2) 에이전트 행: `agentSnaps` 각각 → `kind:'agent'`. **(1) 의 k 와 같으면 행을 만들지 않고 그 run 행에 `live` 로 붙인다.** run 의 host 가 0 인 스냅과도 매칭한다(`${0}|cwd|win` 재시도).
- (3) `terminalsFallback` 의 `on:true` 항목 중 (1)(2) 에 없는 k 만 `kind:'agent'`(source 'fallback').
- (4) 종결 task(merged/closed/failed, `closedAt` 7일 이내) → `kind:'task'` 행 1개(done 그룹). (1) 의 잔존 run 이 있는 merged 작업도 done 행을 낸다(두 행).
- 승인/미읽음은 k 로 붙인다.

### 5.3 그룹 판정(번호 순, 첫 매치)
1. `needs_input`: `run.state === 'failed'` ‖ `run.error?.code ∈ {PROMPT_NOT_DELIVERED, OP_INTERRUPTED}` ‖ `run.trustPending` ‖ (`run.state === 'running'` && `run.terminalAlive === false`) ‖ `run.agentGone` ‖ `live.state ∈ {permission, needsInput}` ‖ `approvals[k].length > 0` ‖ (merged 작업에 남은 run: `task.state === 'merged' && run.id !== task.winnerRunId`) ‖ `run.lastOp?.ok === false`(마지막 op 실패 — 사용자가 봐야 한다; 카드에서 [확인] 하면 클라가 로컬로 지운다)
2. `working`: `live.state === 'working'` ‖ `run.state ∈ {creating, launching, merging}` ‖ `run.op != null`
3. `review_ready`: `run.state === 'review_ready'`
4. `done`: `kind === 'task'`
5. `idle`: 나머지

정렬: `needs_input` 은 기다린 시간 오래된 순(`approval.createdAt`, 없으면 `live.since`, 없으면 `run.updatedAt` 오름차순). 나머지는 `lastActivityAt`/`live.at` 내림차순. 그룹 순서 고정: 입력 대기 → 작업 중 → 리뷰 준비 → 대기 중(기본 접힘) → 완료(기본 접힘). 각 규칙마다 픽스처 1개 이상(§8.5).

### 5.4 카드가 보여주는 것
```
[AgentLogo] {agent 표시명}   {PC 이름} · {워크스페이스 이름 | 작업 제목 · 브랜치}
{상태 한 줄}  — 예: "3분 기다리는 중" / "작업 중" / "리뷰 준비 · 파일 3 +41 −7" / "PR #12 · 검사 통과" / "폴더 신뢰 확인 필요"
[상태 점]  warn=입력 대기 · text3 스피너=작업 중 · error=실패/CI 실패 · cta=PR 머지 가능/성공  (선택 강조 아님, 상태 신호만)
```
행동(카드 컨텍스트, 그룹별):
- needs_input: 승인이면 [답하기](`openApprovalCard(id)`) · `trustPending` 이면 [신뢰하고 계속](`task.run.trust`) · `agentGone`/terminalAlive false 면 [에이전트 다시 실행]/[터미널 다시 열기](`task.run.reopen`) · failed 면 [다시 열기] [프롬프트 다시 보내기] [폐기] · merged 잔존 run 이면 "미커밋 변경 때문에 남겨둠" 한 줄 + [폐기] · 그 외 [터미널 열기]
- working: [터미널 열기] (중단 버튼 없음)
- review_ready: [리뷰] → 상세 · [터미널 열기]
- done: [상세](읽기 전용) · [기록 삭제](`task.delete`)
- 오프라인 host 의 작업은 "PC 오프라인" 섹션 1줄(호스트 이름만).

---

## 6. UI 명세

### 6.0 공통 규칙
- 이모지 0. 아이콘은 기존 아이콘 세트(PC `icons.js`, 앱 `phosphor` 계열).
- 선택/활성 = 무채색 명암(`--hover`/`C.elevated2`, 탭 상단선 `C.text3`). 상태 신호만 `warn/error/cta/info`.
- 모든 문구 `i18n.t('한국어 원문')` 또는 `tx(TASKS_TEXT)`; 문장 조립 금지. 에러 코드 → 문구는 §9 `ERROR_KEY` 표 하나로.
- 로딩·빈 상태·에러·오프라인·gh 미설치를 전부 그린다(§6.7).
- 라이브 상태가 `working` 이거나 `run.op` 가 있으면 [커밋]/[푸시]/[PR]/[머지]/[폐기] 를 비활성 + 툴팁 `agentBusy`(데몬도 `AGENT_BUSY`/`RUN_BUSY` 로 거부한다).

### 6.1 PC — 현황판 (`state.view='tasks'`)
- `index.html` `<main>` 에 `<section id="tasksView" class="tasks-view" hidden>`; `main.js render()` 가 `updateTasksView()` 호출. `#wsView` 는 `hidden` + `previewSync visible=false` — 프리뷰 실드 `SEL` 에 `.tasks-view` 추가.
- 진입: 사이드바 "내 PC" 위 행 `작업 [n]`(n = needs_input 수, `sbSig` 에 포함) · 타이틀바 벨 옆 아이콘 · 팔레트 `tasks.dashboard`(`Mod+Shift+A`) · `tasks.new`(`Mod+Shift+N`). 충돌 시 `Mod+Alt+A/N`(commands.js 주석에 기록).

```
┌─ 작업 ─────────────────────────────────────────────── [새 작업] [새로고침] ─┐
│ 입력 대기 (2)                                                                  │
│  ┌ [c] claude   MacBook · codingpt · cpt/x2m1qa-1          3분 기다리는 중  ┐    │
│  │   "Bash: npm test 실행 허용?"                     [답하기] [터미널]    │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│ 작업 중 (3)                                                                    │
│ 리뷰 준비 (1)                                                                  │
│  ┌ [x] codex    MacBook · 로그인 폼 유효성 · cpt/x2m1qa-2                    ┐  │
│  │   파일 3 · +41 −7 · 커밋 2 · PR 없음                    [리뷰] [터미널]  │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│ ▸ 대기 중 (4)          ▸ 완료 (6)                                              │
└────────────────────────────────────────────────────────────────────────────────┘
```
- 너비 ≥ 1100px: 왼쪽 목록 360px + 오른쪽 상세. 미만: 목록 → 상세(뒤로 버튼).
- 카드 클릭 = 상세. 더블클릭/Enter = 터미널 열기. 키보드: ↑↓ 이동, Enter 열기, `r` 리뷰, `Esc` 워크스페이스 뷰 복귀.

### 6.2 PC — 작업 상세
```
┌ 로그인 폼 유효성 검사 추가                                  open · base main · codingpt ┐
│ 프롬프트 ▸ (접힘, 펼치면 전문)                                                          │
│ ┌ 실행 1 · claude ─────────┐ ┌ 실행 2 · codex ──────────┐ ┌ 실행 3 · claude ─────────┐  │
│ │ 리뷰 준비                 │ │ 작업 중                    │ │ 실패: 에이전트 미설치    │  │
│ │ 파일 3 +41 −7 · 커밋 2    │ │ 파일 1 +3 −0 · 커밋 0      │ │ [다시 열기] [폐기]       │  │
│ │ PR #12 · 검사 통과        │ │ PR 없음                    │ │                          │  │
│ │ [리뷰] [터미널] [PR 만들기]│ │ [터미널]                   │ │                          │  │
│ └──────────────────────────┘ └────────────────────────────┘ └──────────────────────────┘  │
│ ── 선택한 run 의 diff 리뷰 (review-view, source:'task') ─────────────────────────────── │
│  [코멘트 에이전트에게 보내기]  [커밋…]  [푸시]  [PR 만들기…]  [머지…]  [폐기…]           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
- run 컬럼 최대 3 나란히, 4개면 가로 스크롤. 선택된 run 컬럼은 `--hover` 배경.
- diff 리뷰: `review-view.createReview({reviewId:'task:'+runId, title, files, source:'task'})` 재사용. `source==='task'` 면 [보내기]→[코멘트 에이전트에게 보내기]: `serializeReviewComments(buildSubmission(), {title})`(§8.5, ≤30KB) 를 `chat.input {cwd: run.cwd, tid: run.tid, text, submit:true}` 로 보낸다(review.submit 호출 금지). 코멘트 0·거절 0·메모 빈 값이면 버튼 비활성.
- **주 행동(review_ready 카드)** = 결정표(§6.7 B). [PR 만들기…] 시트: run 이 dirty 면 위에 "커밋 메시지" 필드(기본 작업 제목)가 자동으로 붙는다 → `git.pr.create {commitMessage}` 한 번. 제목(기본 작업 제목)·본문(기본: 프롬프트 요약 + `Task <taskId>`)·draft. [커밋…] 시트: 메시지 + "훅 건너뛰기(--no-verify)" 체크(기본 off). [머지…] 시트: PR 있으면 method(squash 기본)·"나머지 실행 폐기"(기본 on) → `git.pr.merge`; PR 없고 원격 없음/비 GitHub 면 로컬 머지 method(merge 기본) → `git.merge.local`. 결과/에러는 시트 안에 코드별 문구(§9). op 는 `accepted` 뒤 시트가 "진행 중…" 을 그리고 `tasks.changed reason:'op'` → `task.get` 의 `lastOp` 로 마감한다.
- PR 상태 블록: 번호·링크(외부 브라우저 `open`)·draft·mergeable·체크 목록(≤20, 상태 점)·`closed` 면 "PR 닫힘" — 상세 열림 중 30s 폴링.

### 6.3 PC — 새 작업 시트 (`new-task-sheet.js`, `.wv-sheet-overlay` 패턴)
```
┌ 새 작업 ───────────────────────────────────────────┐
│ PC        [MacBook ▾]      (local 러너 2대 이상일 때만)│
│ 저장소    [codingpt ▾]     (그 PC 의 로컬 워크스페이스) │
│ base      [main ▾]         (git.branches, 기본 current)│
│           main 에 미커밋 변경 3개는 포함되지 않아요      │
│ 프롬프트  ┌──────────────────────────────────────┐   │
│           └──────────────────────────────────────┘   │
│           12,345 / 30,000 바이트                      │
│ 에이전트  [claude ×1 ▾] [codex ×1 ▾] [gemini]         │
│ ▸ 고급    [x] .env 파일 복사   [ ] 시작 전 fetch        │
│                                        [취소] [시작]   │
└────────────────────────────────────────────────────┘
```
- 에이전트 칩: 선택한 host 가 로컬 데몬이면 `agents-view.loadAgents()`, **원격 PC 면 `taskApi.agentsRemote(hid)`(= 릴레이 `agents.list` 봉인 RPC)** — `api.agentsLocal` 은 로컬 데몬만 본다(agents-view.js:46-47). 선택된 칩은 `--hover` 배경 + `×n` 스텝퍼(1~4). 총 run ≤ 4. 설치 안 된 칩 비활성+툴팁.
- 프롬프트 카운터는 UTF-8 바이트(`new TextEncoder().encode(s).length`), 30000 초과 시 [시작] 비활성.
- [시작] → `task.create {opId: crypto.randomUUID()}` → 시트 닫고 현황판으로 이동, 새 카드에 포커스.
- 저장소 목록에는 `isTaskWorkspace` 워크스페이스를 넣지 않는다.

### 6.4 앱(폰 < 700) — 현황판 `TasksDashboardHost`
- 모듈 스토어 `tasksUi.ts`: `openTasksDashboard(opts?:{taskId?, runId?, host?})`, `closeTasksDashboard()`, `openNewTask(prefill?)`. 셸 `RootNavigator ShellLayout` 에 `<TasksDashboardHost/>`·`<NewTaskSheet/>` 마운트(NotificationsPanel 옆). 열 때 `collapseKeyAssist()`, Modal 안에 `<KeyAssistOverlay inModal/>`.
- 진입: 사이드바 "내 PC" 위 `작업 [n]` 행 · WorkspaceView 헤더 벨 옆 아이콘 · 팔레트 `tasks.open` · 딥링크 `codingpt://task/…`(§6.9).
- 전체화면 Modal(`animationType="slide"`), 헤더 44: [닫기] 작업 [+ 새 작업]. 섹션 헤더는 `SectionHead`(SidebarContent.tsx:410 의 로컬 함수를 **export** 해 재사용). `idle`·`done` 기본 접힘. 카드는 `PressableScale`(scaleTo 0.98, `haptic.select()`). 당겨서 새로고침 = `task.list`.
- 카드 → 상세는 **인모달 push**(Animated translateX 220ms). 뒤로 = iOS 가장자리 스와이프(`PanResponder`, 시작 x<24) **+** Android 하드웨어 back(`BackHandler`) **+** 헤더 [<] 세 가지 전부. 상세 = run 세그먼트(가로 스크롤 칩; 선택 = `C.elevated2`) + 선택 run 의 요약/PR/액션 + diff 리뷰(`ReviewView mode:'task'`).
- ReviewView `mode:'task'`: "AI 가 요청했어요" 줄 숨김, 하단 바 = [코멘트 보내기] + 결정표의 주 행동 1개 + `…`(나머지: 커밋·푸시·머지·폐기). 직렬화는 공유 함수 `serializeReviewComments`(§8.5).
- 커밋/PR/머지 입력은 바텀시트(PcPickerSheet 스타일: scrim `rgba(5,7,12,0.62)`, radius 18, 그래버). PR 시트는 PC 와 같이 dirty 면 커밋 메시지 필드가 붙는다.

### 6.5 앱(태블릿 ≥ 700)
- 같은 Host 가 가운데 패널(최대 1100, 좌 목록 340 + 우 상세)로 렌더. 도킹 사이드바에 `작업` 행. 나머지 동일.

### 6.6 앱 — NewTaskSheet
- 바텀시트(`KeyboardAvoidingView`). 필드 순서 §6.3. PC 선택은 `PcPickerSheet` 재사용. 프롬프트 입력에 마이크: `useMicDictation()` 훅(ChatComposer :100-165 에서 추출). 바이트 카운터 §6.3 과 동일.
- 에이전트 칩: `listAgents(host)`; 미설치 칩 비활성.

### 6.7 상태·빈·오류·gh 안내 화면 + 결정표
A. 화면
- 빈 현황판: `empty` + [새 작업]. 온라인 local PC 가 0 → `noHost` + [내 PC 연결].
- `hostCaps(host)` 에 `task.v1` 없음 → `pcNeedsUpdate` 배너. 서버 caps 에 `task.v1` 없고 봉인도 불가 → `serverNeedsUpdate`.
- gh 안내(상세의 PR 블록 자리): `GH_MISSING` → `ghMissing`+`ghMissingHint` + [로컬 머지로 진행]. `GH_NOT_AUTHED` → `ghNotAuthed`+`ghNotAuthedHint` + [다시 확인]. `GIT_CLT_MISSING` → `gitCltMissing`(작업 생성 차단).
- `UNCOMMITTED_CHANGES` 폐기 확인: `discardConfirm`. `UNMERGED_COMMITS`: `discardUnmergedConfirm`. (error 색 텍스트 버튼)
- `MERGE_CONFLICT`(결과): 파일 목록 + `conflictHint` + [터미널 열기].
- `PROMPT_NOT_DELIVERED`: 카드 경고 줄 + [프롬프트 다시 보내기]. `trustPending`: 카드 줄 `trustNeeded` + [신뢰하고 계속].
- `COMMIT_HOOK_FAILED`: `errCommitHook` + stderr 꼬리(모노스페이스, 접힘) + [훅 건너뛰고 다시 커밋].

B. review_ready 카드의 **주 행동 결정표**(입력: `repo.github`, `caps.gh.ghInstalled/ghAuthed`, `run.pr`, `pr.state`)
| github | gh 설치 | gh 인증 | pr | pr.state | 주 행동 | 보조(… 메뉴) |
|---|---|---|---|---|---|---|
| null(비 GitHub/원격 없음) | – | – | – | – | [로컬 머지] | 커밋·폐기 |
| 있음 | 아니오 | – | – | – | [로컬 머지] + gh 안내 | 커밋·푸시·폐기 |
| 있음 | 예 | 아니오 | – | – | [gh 로그인 안내] | 로컬 머지·커밋·푸시·폐기 |
| 있음 | 예 | 예 | 없음 | – | [PR 만들기] | 로컬 머지·커밋·푸시·폐기 |
| 있음 | 예 | 예 | 있음 | open | [PR 머지](mergeable 아니면 비활성+이유) | PR 열기·푸시·폐기 |
| 있음 | 예 | 예 | 있음 | closed | [PR 만들기](새 PR) + "PR 닫힘" | 로컬 머지·폐기 |
| 있음 | 예 | 예 | 있음 | merged | (완료 경로 진행 중) | – |

### 6.8 모션(앱)
- 카드 등장: opacity 0→1 + translateY 8→0, 160ms, 스태거 20ms(최대 8개) — **카드 id 의 최초 마운트에만**(`seenIds: Set` 을 Host 수명 동안 유지; `tasks.changed` 재렌더에 재생 금지).
- 그룹 이동: 카드의 그룹이 바뀔 때만 `LayoutAnimation.easeInEaseOut` 1회. Android 구 아키텍처는 `UIManager.setLayoutAnimationEnabledExperimental?.(true)` 를 Host 마운트 시 1회 호출(Reanimated layout transition 을 이미 쓰는 화면이면 그것을 쓴다).
- 상태 점: 작업 중은 `text3` 점 2개 교차 페이드(1.2s 루프), 색 없음.
- 버튼 전부 `PressableScale`; `Pressable` 함수형 style 금지.

### 6.9 앱 딥링크
- `pushService.takePendingPushDeeplink(kind)` 의 kind 에 `'task'` 추가(현재 `'session'|'notif'|'approval'` 뿐, pushService.ts:16). `parseTaskDeeplink(url) → {taskId, host, runId} | null`(`codingpt://task/<id>?host=<n>&run=<r>`).
- RN `Linking` 리스너는 현재 `usePairDeepLink`(pair 만)와 LoginScreen 뿐 → 신규 훅 `useTaskDeepLink()`(`WorkspaceShellContext` 에서 마운트): `Linking.getInitialURL` + `addEventListener('url')` 에서 `codingpt://task/` 접두면 `openTasksDashboard(parseTaskDeeplink(url))`. 푸시 탭(FCM data 의 deeplink)도 같은 파서를 거쳐 `takePendingPushDeeplink('task')` 로 흐른다.

---

## 7. 테스트 계획

### 7.1 데몬 (`npm test` = run-tests.js, `node:test`)
- `test/task-git.test.js`: 임시 홈(`mkdtemp`) + `runtime.init({stateDir, root})`. 임시 git 저장소(커밋 2개, `main`, 한글 파일명 1개) → worktree add/remove, base diff(커밋+인덱스+워킹트리+미추적, 경로 dedupe, 한글 경로 원문 유지), commit(identity 없으면 `GIT_IDENTITY_MISSING`; 복사한 `.env` 가 exclude pathspec 으로 커밋되지 않음; pre-commit 훅 실패 → `COMMIT_HOOK_FAILED` + `--no-verify` 성공), env 복사(ignored 만, example 제외, 1MB 상한, worktree 안 check-ignore), 로컬 머지 3종 + 충돌 abort → `{ok:false, code:'MERGE_CONFLICT', files}` + (a) base 미체크아웃 경로(임시 worktree + CAS), `task.diff file` 검증(허용 집합 밖·`../` → BAD_PARAMS), 서브디렉토리 워크스페이스(`repo.subdir`, run.cwd), 정리 가드(`UNMERGED_COMMITS`, 복구 ref 기록, rm -rf 경로 assert). **가짜 gh**: 임시 `bin/gh` 셸 스크립트(인자별 고정 출력: `auth status`→0, `repo view --json`→owner/name, `pr create`→URL, `pr view --json`→픽스처, `pr merge`→0; `--repo` 인자 존재를 assert) 를 **`agents._internals.setSearchOverride([tmpBin, '/usr/bin', '/bin'])`** 로 주입, 끝나면 `setSearchOverride(null)` + `resetCache()`. `GH_NOT_AUTHED` 케이스는 exit 1 스크립트.
- `test/tasks.test.js`: `tasks.configure({launch, chatInput, chatDialog, screen, backFetch, notify, poolChanged, now})` 스텁 + `termBackend` 스텁. 검증: create 즉시 회신 → 비동기 완료 후 `running`/`promptDelivered`, `launch.args` 에 프롬프트 파일 경로(0600)와 `"$(cat …)"` 형; **paste 모드에서 pane command 가 셸(`zsh`)인 동안 `chatInput` 이 호출되지 않고, `rawStateOf` 가 `launching` 인 동안도 호출되지 않는다**; 신뢰 다이얼로그 화면 스텁 → `trustPending:true` → `task.run.trust` 가 `chatDialog({pick:1, expect})` 호출; **configure+start 뒤 아무 RPC 없이 stop 훅만 와도 `review_ready` 승격 + `task_ready` 1회 + `shouldNotify(rec,'done')===false`**, 변경 0 이면 `done` 통과; prompt 훅 → `running`; 팬아웃 이름 규칙(`--` 없음); `TASK_LIMIT`; `PROMPT_TOO_LARGE`(30001 바이트); opId 재생(같은 opId 두 번 → 실행 1회 + `replay:true`); `RUN_BUSY`; discard(dirty 거부/`UNMERGED_COMMITS` 거부/force); merge 후 `cleanup:'pending'` 즉시 회신 → 비동기 정리(worktree·branch·workspace DELETE·`terminal.close` 경유) → reason 'merged'/'discarded'; reconcile(creating 재개/failed, launching → OP_INTERRUPTED, op 잔존, `agentGone`, 폴더 소실); 봉인 경로 `control.handleSealedRpc` 로 `task.list` 왕복; `dispatchRpc('git.gh.status')`; `poolChanged` 가 4-run create 에서 1회.
- `test/task-contract.test.js`: `docs/fixtures/agent-tasks/*.json` 의 요청/응답 샘플이 `pickTask/pickRun` 화이트리스트와 일치(필드 추가/누락 감지). `rpc-errors.json` 의 코드 집합 = §2.13.
- `env -i PATH=/usr/bin:/bin` 재현 테스트: `task-git.tools()` 가 `searchDirs` 를 통해 임시 bin 의 gh 를 찾는다.

### 7.2 back (`node --test test/task-route.test.js`)
- 허용 메서드/타임아웃 표가 §3.3 과 정확히 일치. 미허용 → 400. `DAEMON_OFFLINE` → 409. 데몬 에러 `code` 가 응답 `detail.code` 로 전달. 릴레이 타임아웃 → `detail.code === 'TIMEOUT'`. `computeServerCaps({TASKS_ENABLED:'0'})` 에 `task.v1` 없음. `accountAuth` 가 deviceToken·JWT 둘 다 통과.

### 7.3 PC (`npm test` 체인에 추가)
- `test/tasks-crossimpl.mjs`: §5 모델 픽스처 입력 → 그룹/정렬/카드 필드 기대값.
- `test/review-crossimpl.mjs` 에 `serializeReviewComments` 케이스(`review-comments-01.json`) 추가.
- `test/palette-crossimpl.mjs`: `tasks.dashboard`, `tasks.new` 가 표에 있고 앱 팔레트 이름과 정합.
- `test/i18n-crossimpl.mjs`: 새 원문 전부 7개 카탈로그에 존재(emit 뒤). `ERROR_KEY` 의 모든 값이 원문 표에 있음.
- `tasks-api.test.mjs`: `taskRpc` 가 타임아웃/5xx 에서 평문으로 가지 않고 `E2EE_UNSUPPORTED`/501 에서만 간다; 로컬 소켓 `CODE: msg` 파싱.

### 7.4 앱 (`jest`, `tsc --noEmit`)
- `__tests__/tasksModel.test.ts`(같은 픽스처), `__tests__/agentStateStore.test.ts` 에 `listAgentSnaps`(host 0 정규화·since 보존), `__tests__/taskDeeplink.test.ts`, `__tests__/reviewSerialize.test.ts`, `__tests__/taskService.test.ts`(폴백 규칙 §3.2).
- **픽스처 경로 계약**: 앱은 별도 git 리포다. `process.env.CPT_FIXTURES || path.resolve(__dirname, '../../codingpt_service/codingpt_daemon/docs/fixtures/agent-tasks')` 를 읽고, 없으면 `console.warn('[fixtures] agent-tasks 픽스처 없음 — 교차 테스트 skip')` 후 `test.skip`(CI 단독 실행에서 깨지지 않게).

### 7.5 E2E 체크리스트(실기 — 완료 보고 전 필수)
**준비**: PR/머지 단계용 **일회용 GitHub 저장소** `<user>/cpt-tasks-e2e`(`gh repo create --private` 로 만들고 끝나면 `gh repo delete --yes`; `scripts/e2e-tasks-repo.sh`). 이 리포(codingpt_service)는 **비변이 단계(2~4)에만** 쓴다 — 실제 main 에 squash 머지 금지.
**Mac PC 앱(Tauri, `npm run dev` 재번들 후)**
1. `git.gh.status` 가 gh 를 찾는다(앱이 띄운 데몬). gh 로그아웃 상태에서 안내 화면.
2. 새 작업: 저장소=이 리포, base=main, claude×1 + codex×1 → 카드 2개. **처음 보는 worktree 에서 두 에이전트 모두** 60초 안에 (신뢰 다이얼로그가 뜨면 카드 [신뢰하고 계속] 1탭 포함) `running`·`promptDelivered:true` 이고 `tmux capture-pane` 으로 프롬프트가 에이전트 입력으로 들어갔음(셸에 안 찍힘)을 확인. 두 run 의 `launchedAt` 차이 < 5s.
3. `<stateDir>/worktrees/` 에 폴더 2개(이름에 `--` 없음), `git worktree list` 2줄, 사이드바·팔레트·알림 패널에 작업 워크스페이스가 **안 보임**, 카드 [터미널 열기]로 열림(등록 직후에도 — 목록 새로고침 경로).
4. 턴 종료 → "리뷰 준비" 이동 + 알림 **정확히 1건**(`done` 없음). 헝크 표시, [코멘트 보내기] 후 터미널에 붙여넣어짐.
5. (일회용 리포) dirty 상태에서 [PR 만들기] 한 시트 → 커밋+푸시+PR, PR 블록 번호/체크. [PR 머지(squash)] → 즉시 완료 표시 → 몇 초 뒤 나머지 run 폐기·worktree/브랜치/워크스페이스 삭제·로컬 base fast-forward·작업 `merged`·"완료" 그룹. 폐기된 run 의 `refs/codingpt/discarded/<runId>` 존재.
6. 원격 없는 임시 저장소로 로컬 머지: base 체크아웃 상태(b)와 다른 브랜치 체크아웃 상태(a) 둘 다. 충돌 시나리오에서 `MERGE_CONFLICT` 목록.
7. 작업 진행 중 PC 앱 업데이트(데몬 재시작) → reconcile: 카드 유지, `terminalAlive`/`agentGone` 정확, [에이전트 다시 실행] 으로 `claude --continue` 가 대화를 잇는다. 봉인 타임아웃 유도(데몬 일시정지) 뒤 같은 opId 재전송이 이중 실행되지 않음.
**Android(에뮬레이터 + 실기)**
8. 사이드바 작업 행 → 현황판(PC 와 같은 그룹/카운트). 새 작업 시트에서 생성(받아쓰기 1회). 승인 카드에서 답하기. 리뷰 준비 푸시(백그라운드) → 탭 → 상세 딥링크. 리뷰·PR(한 시트)·머지 완주. 하드웨어 back 으로 상세 → 목록. 키보드가 시트를 가리지 않는다.
**iOS(시뮬레이터)**
9. 8 과 동일. 딥링크는 `xcrun simctl openurl booted 'codingpt://task/<id>?host=1&run=<r>'`(Linking 경로) + `xcrun simctl push booted <bundle> task.apns`(푸시 탭 경로, payload 의 `deeplink` 사용). 가장자리 스와이프 back. 세이프에어리어·회전·iPad 2컬럼.
**공통**
10. E2EE 켠 계정에서 서버 로그(`docker logs`)·DB `notifications`·objectstore 워크스페이스 meta 에 **프롬프트 본문·diff 내용·작업 제목** 0건(브랜치명·폴더명은 `cpt/<t6>-<k>` 형이라 검색 대상이 아니다 — §10 정의). 정책 off 계정에서 평문 폴백 동작, 타임아웃 시 평문 재전송 0건(back 로그로 확인).
11. 7개 언어 전환 시 현황판·시트·에러 문구 누락 0(`i18n-guard`).

---

## 8. 구현 분담 (파일 소유권 — 겹치지 않는다)

### 8.1 daemon+cpt 구현자 (`codingpt_service/codingpt_daemon`)
소유: `packages/runner-core/tasks.js`, `task-git.js`, `control.js`(dispatchRpc 1줄 + OPTIONAL_CAPS 1줄), `cpt-server.js`(`wireTasks`·`handleTaskRpc`·소켓 분기·CAPABILITIES·`notifyTasksChanged`·`launchAgentInTerminal` args 추가 전용), `agent-state.js`(`subscribe`·`rawStateOf`·`configure({shouldNotify})`), `agents.js`(export 3종 추가 + CATALOG `promptArg`/`resumeArgs`), `packages/cpt-cli/*`(`cpt task list|get`), `test/tasks.test.js`, `test/task-git.test.js`, `test/task-contract.test.js`, `docs/fixtures/agent-tasks/rpc-*.json`.
무접촉: `pty.js`, `terminal-manifest.js`, back/PC/app 리포.

### 8.2 back 구현자 (`codingpt_service/codingpt_back`)
소유: `controllers/daemonController.js`(`TASK_RPC_OK`·`taskRpc`(publicDetail/TIMEOUT 매핑)·export), `routes/daemonRoutes.js`(`router.post('/task', accountAuth, daemonController.taskRpc)` 1줄), `config/caps.js`(`task.v1` + `TASKS_ENABLED`), `test/task-route.test.js`, `docs/byo-pc-status.md`(라우트 1줄).
무수정: `utils/response.js`, `daemonRelayService.js`, `notificationService.js`.

### 8.3 PC 구현자 (`codingpt_service/codingpt_pc`)
소유(신규): `src/js/tasks-view.js`, `tasks-model.js`, `tasks-api.js`(`taskRpc` 래퍼 + `hostCaps(host)` + `agentsRemote(hid)` + 로컬 `task_local` 코드 접두 파싱), `new-task-sheet.js`, `task-detail.js`, `text/tasks.js`(`ERROR_KEY` 포함), `test/tasks-crossimpl.mjs`, `test/tasks-api.test.mjs`.
소유(수정): `src/index.html`(`#tasksView`), `main.js`(render 분기·SEL·registerCommands·활성 워크스페이스 삭제 시 현황판 복귀), `state.js`(`view:'tasks'`, `isTaskWorkspace` + `sortedWorkspaces` 필터, `setActive(id,{allowTask})`, `tasks` 스토어, `listAgentSnaps()`), `sidebar.js`(작업 행 + sbSig + 타이틀바 아이콘), `workspace-view.js`(+ 메뉴 "새 작업…", 작업 배지), `commands.js`(`tasks.dashboard`, `tasks.new`), `text/palette.js`, `ui-channel.js`(`tasks.changed` 핸들러 + uiCmds + `ui_result ok`), `notifications.js`(`task_*` → 현황판 라우팅), `review-view.js`(`source:'task'` 바), `diff-parse.js`(`serializeReviewComments` 추가 전용), `styles.css`(`.tasks-*`), `src-tauri/src/cptsock.rs`(`task_local`: async + spawn_blocking, 타임아웃 35s, prefix `task.`/`git.`, `with_code=true`), `src-tauri/src/lib.rs`(핸들러 등록), `api.js`(`taskLocal`), `package.json` test 체인, `test/review-crossimpl.mjs`, `test/palette-crossimpl.mjs`, `test/i18n-crossimpl.mjs`.
금지: `src/js/i18n/*.js` 편집(생성물 — 모바일 구현자가 emit).

### 8.4 mobile 구현자 (`codingpt_app`)
소유(신규): `src/workspace/tasks/{TasksDashboardHost.tsx, TaskList.tsx, TaskCard.tsx, TaskDetail.tsx, NewTaskSheet.tsx, tasksModel.ts, tasksUi.ts, useTasks.ts}`, `src/services/taskService.ts`(`taskRpc` + `hostCaps(host)` + 타입), `src/hooks/useMicDictation.ts`, `src/hooks/useTaskDeepLink.ts`, `src/text/tasks.ts`(`ERROR_KEY` 포함), `__tests__/tasksModel.test.ts`, `__tests__/taskDeeplink.test.ts`, `__tests__/reviewSerialize.test.ts`, `__tests__/taskService.test.ts`, `__tests__/fixtures.ts`(경로 계약 §7.4).
소유(수정): `services/agentStateStore.ts`(`listAgentSnaps()`·`since` 보존 추가 전용), `services/daemonService.ts`(`sealedRpc` 저수준 함수 `export` 1줄만 — `sealedFs` 는 쓰지 않는다), `services/pushService.ts`(kind `'task'` + `parseTaskDeeplink`), `contexts/WorkspaceShellContext.tsx`(`isTaskWorkspace` + 목록 훅 필터·`useTaskDeepLink` 마운트·활성 워크스페이스 삭제 시 현황판 복귀), `components/SidebarContent.tsx`(작업 행, `SectionHead` export), `components/NotificationsPanel.tsx`(`task_*` 라우팅), `workspace/WorkspaceView.tsx`(헤더 아이콘·팔레트 `tasks.open`·작업 배지), `workspace/uiCommandNames.ts`(`tasks.changed`), `workspace/UiCommandBridge.tsx`(케이스 + ok 응답), `workspace/ide/ReviewView.tsx`(`mode:'task'`), `workspace/ide/diffParse.ts`(`serializeReviewComments`), `workspace/chat/ChatComposer.tsx`(STT 블록을 훅 사용으로 치환), `navigation/RootNavigator.tsx`(호스트 마운트), `i18n/master.json`(7개 언어) + `node scripts/i18n-emit.js`.
순서 규칙: **master.json + emit 을 가장 먼저** 끝내고 커밋한다.

### 8.5 공유 계약 픽스처 (`codingpt_daemon/docs/fixtures/agent-tasks/`)
- `rpc-task.list.json`, `rpc-task.get.json`, `rpc-task.diff.json`, `rpc-git.pr.status.json`, `rpc-op-accepted.json`, `rpc-merge-result.json`(ok:true / ok:false MERGE_CONFLICT 둘 다), `rpc-errors.json` — 데몬 구현자.
- `model-01-basic.json` … `model-10-*.json` — §5 입력/기대 출력(PC 구현자 초안, 단일 소유). 필수 케이스: 각 §5.3 규칙 1개 이상, host 0/null 스냅과 run 의 dedupe, merged 작업의 잔존 run, `lastOp.ok:false`, 오프라인 host, `trustPending`.
- `review-comments-01.json` — `serializeReviewComments` 입력/출력 6+ 케이스(PC 소유).

`serializeReviewComments(submission, {title})` — 입력은 `buildSubmission()` 결과 `{ comments: ReviewComment[], decisions: Record<hunkKey,'approve'|'reject'>, note: string }`, `ReviewComment = {path, hunk:number, side:'old'|'new', line:number|null, text}`. 문법(정확히):
```
리뷰 코멘트 ({title})
<코멘트 줄>*
<코멘트 없는 거절 헝크 줄>*
[전체 메모: {note}]           // note 가 공백뿐이면 줄 자체를 생략
```
- 코멘트 줄: `- {path}:{line}` (`side==='old'` 면 `:{line}(old)`; `line===null` 이면 `- {path} hunk {hunk}`) + (그 헝크의 decision 이 reject 면 ` [reject]`) + ` ` + `text` 의 개행(`\r?\n`)을 공백 하나로 치환한 값. 순서 = 파일 경로 오름차순 → 헝크 번호 → 코멘트 입력 순. 같은 헝크의 코멘트가 여럿이면 각각 한 줄(`[reject]` 는 각 줄에 반복).
- 코멘트 없는 거절 헝크 줄: `- {path} hunk {hunk} [reject]` (경로·헝크 순).
- 코멘트 0·거절 0·note 빈 값 → 빈 문자열(버튼 비활성). 결과가 UTF-8 30000 바이트를 넘으면 그 앞에서 자르고 마지막 줄에 `… (잘림)` 을 붙인다.
- 한국어 고정 문자열("리뷰 코멘트", "전체 메모", "잘림")은 i18n 하지 않는다.

---

## 9. i18n 원문 목록 (키 = 한국어 원문; `text/tasks.js` / `text/tasks.ts` 의 필드명은 왼쪽)

master.json 에 아래 원문을 전부 넣고 en/ja/zh-CN/de/es/fr 를 채운다. 플레이스홀더: `{n}` 수, `{name}` 이름, `{t}` 상대시간 문자열(기존 relTime), `{branch}`, `{base}`, `{a}`/`{d}` 추가/삭제 수, `{agent}` 표시명.

```
title:            작업
newTask:          새 작업
refresh:          새로고침
dashboard:        작업 현황판
empty:            아직 작업이 없어요
emptyHint:        폰이나 PC 에서 프롬프트를 보내면 PC 가 별도 브랜치에서 에이전트를 실행해요
noHost:           연결된 PC 가 없어요
connectPc:        내 PC 연결
hostOffline:      PC 오프라인
pcNeedsUpdate:    이 PC 앱을 업데이트해야 작업을 만들 수 있어요
serverNeedsUpdate: 서버 업데이트가 필요해요
groupNeedsInput:  입력 대기
groupWorking:     작업 중
groupReviewReady: 리뷰 준비
groupIdle:        대기 중
groupDone:        완료
waitingFor:       {t} 기다리는 중
filesSummary:     파일 {n}개
commitsAhead:     커밋 {n}개
diffStat:         +{a} −{d}
noPr:             PR 없음
prNumber:         PR #{n}
prClosed:         PR 닫힘
prDraft:          초안
prMergeable:      머지 가능
prConflicting:    충돌
checksNone:       검사 없음
checksPending:    검사 진행 중
checksPassing:    검사 통과
checksFailing:    검사 실패
checkItemPending: 진행 중
checkItemPassing: 통과
checkItemFailing: 실패
checkItemSkipped: 건너뜀
answer:           답하기
openTerminal:     터미널 열기
reopenTerminal:   터미널 다시 열기
relaunchAgent:    에이전트 다시 실행
review:           리뷰
reopen:           다시 열기
resendPrompt:     프롬프트 다시 보내기
trustNeeded:      폴더 신뢰 확인이 필요해요
trustContinue:    신뢰하고 계속
discard:          폐기
deleteRecord:     기록 삭제
detail:           상세
prompt:           프롬프트
base:             base
repo:             저장소
pc:               PC
agents:           에이전트
count:            개수
advanced:         고급
copyEnv:          .env 파일 복사
fetchFirst:       시작 전 fetch
baseDirtyHint:    {name} 에 미커밋 변경 {n}개는 포함되지 않아요
promptBytes:      {a} / {d} 바이트
start:            시작
cancel:           취소
confirm:          확인
notInstalled:     설치 안 됨
runN:             실행 {n}
taskOpen:         진행 중
taskMerged:       머지됨
taskClosed:       닫힘
taskFailed:       실패
stateCreating:    준비 중
stateLaunching:   에이전트 실행 중
stateRunning:     실행 중
stateReviewReady: 리뷰 준비
stateMerging:     머지 중
stateMerged:      머지됨
stateDiscarded:   폐기됨
stateFailed:      실패
opInProgress:     진행 중…
checking:         확인 중…
terminalGone:     터미널이 닫혔어요
agentGone:        에이전트가 실행 중이 아니에요
agentBusy:        에이전트가 아직 작업 중이에요
promptNotDelivered: 프롬프트가 전달되지 않았어요
keptDirty:        미커밋 변경이 있어 남겨뒀어요
wsNotRegistered:  PC 가 워크스페이스를 등록하지 못했어요
wsRemoved:        작업 워크스페이스가 정리됐어요
sendComments:     코멘트 에이전트에게 보내기
commit:           커밋
commitMessage:    커밋 메시지
skipHooks:        훅 건너뛰기(--no-verify)
retryCommitNoVerify: 훅 건너뛰고 다시 커밋
push:             푸시
createPr:         PR 만들기
prTitle:          PR 제목
prBody:           PR 본문
draftPr:          초안(draft)으로 만들기
merge:            머지
mergePr:          PR 머지
mergeLocal:       로컬 머지
mergeMethod:      머지 방식
methodMerge:      merge
methodSquash:     squash
methodRebase:     rebase
methodFf:         fast-forward
discardOthers:    나머지 실행 폐기
winner:           선택됨
openPr:           PR 열기
checkChanges:     변경 확인
discardConfirm:   미커밋 변경 {n}개 파일이 사라져요. 폐기할까요?
discardUnmergedConfirm: 머지되지 않은 커밋 {n}개가 사라져요. 폐기할까요?
discardAllConfirm: 이 작업의 모든 실행을 폐기할까요?
ghMissing:        GitHub CLI(gh) 가 이 PC 에 없어요
ghMissingHint:    터미널에서 설치한 뒤 다시 확인하세요: brew install gh
ghNotAuthed:      gh 로그인이 필요해요
ghNotAuthedHint:  PC 터미널에서 gh auth login 을 실행하거나 GH_TOKEN 환경변수를 설정하세요
ghError:          gh 명령이 실패했어요
gitMissing:       이 PC 에 git 이 없어요
gitCltMissing:    git 을 쓰려면 Xcode 명령줄 도구가 필요해요: xcode-select --install
checkAgain:       다시 확인
useLocalMerge:    로컬 머지로 진행
notGithub:        GitHub 원격이 아니라 PR 대신 로컬 머지만 할 수 있어요
noRemote:         원격 저장소가 없어요
errUncommitted:   먼저 커밋해야 해요
errUnmerged:      머지되지 않은 커밋이 있어요
errNothingToCommit: 커밋할 변경이 없어요
errNothingToPr:   base 에 없는 커밋이 없어요
errIdentity:      git 사용자 이름과 이메일을 먼저 설정하세요
errGitLocked:     저장소가 잠겨 있어요. 잠시 뒤 다시 시도하세요
errCommitHook:    커밋 훅이 실패했어요
errSign:          커밋 서명에 실패했어요. PC 터미널에서 한 번 커밋하거나 서명 설정을 확인하세요
errPushRejected:  푸시가 거부됐어요
errAuth:          인증에 실패했어요. PC 터미널에서 한 번 push 하거나 gh auth setup-git 을 실행하세요
errPrNotFound:    PR 을 찾을 수 없어요
errNotMergeable:  지금은 머지할 수 없어요
errChecksFailing: 검사가 실패한 상태예요
errMainDirty:     저장소에 커밋되지 않은 변경이 있어 로컬 머지를 할 수 없어요
errBaseMoved:     머지하는 사이 {base} 가 바뀌었어요. 다시 시도하세요
errConflict:      충돌이 났어요
conflictHint:     터미널에서 해결하거나 에이전트에게 rebase 를 지시하세요
errBusy:          다른 작업이 진행 중이에요
errInterrupted:   PC 가 재시작되어 작업이 중단됐어요
errTimeout:       응답이 늦어요. 잠시 뒤 상태를 다시 확인하세요
errTaskLimit:     동시에 실행할 수 있는 작업 수를 넘었어요
errTaskClosed:    이미 종료된 작업이에요
errBaseNotFound:  base 브랜치를 찾을 수 없어요
errNotRepo:       git 저장소가 아니에요
errAgentMissing:  선택한 에이전트가 이 PC 에 없어요
errLaunch:        에이전트를 실행하지 못했어요
errLaunchBusy:    터미널에서 다른 명령이 실행 중이에요
errWorktree:      작업 폴더를 만들거나 지우지 못했어요
errWorktreeMissing: 작업 폴더가 사라졌어요
errPromptTooLarge: 프롬프트가 너무 길어요(30,000 바이트까지)
errTasksDisabled: 이 PC 에서는 작업 기능을 쓸 수 없어요
errGeneric:       실패했어요
taskBadge:        작업: {name}
backToDashboard:  현황판
mergedInto:       {branch} → {base}
promptPlaceholder: 무엇을 만들까요?
dictate:          받아쓰기
```

**`ERROR_KEY`(code → 필드명, PC `text/tasks.js` 와 앱 `text/tasks.ts` 에 같은 객체; 없는 code 는 `errGeneric`)**:
`BAD_PARAMS→errGeneric, PROMPT_TOO_LARGE→errPromptTooLarge, TASK_NOT_FOUND→errGeneric, RUN_NOT_FOUND→errGeneric, TASK_CLOSED→errTaskClosed, TASKS_DISABLED→errTasksDisabled, NOT_A_REPO→errNotRepo, BASE_NOT_FOUND→errBaseNotFound, BASE_MOVED→errBaseMoved, TASK_LIMIT→errTaskLimit, AGENT_NOT_INSTALLED→errAgentMissing, GIT_MISSING→gitMissing, GIT_CLT_MISSING→gitCltMissing, GH_MISSING→ghMissing, GH_NOT_AUTHED→ghNotAuthed, GH_ERROR→ghError, NOT_GITHUB→notGithub, NO_REMOTE→noRemote, WORKTREE_ADD_FAILED→errWorktree, WORKTREE_REMOVE_FAILED→errWorktree, WORKTREE_MISSING→errWorktreeMissing, AGENT_LAUNCH_FAILED→errLaunch, LAUNCH_BUSY→errLaunchBusy, PROMPT_NOT_DELIVERED→promptNotDelivered, TERMINAL_GONE→terminalGone, UNCOMMITTED_CHANGES→errUncommitted, UNMERGED_COMMITS→errUnmerged, NOTHING_TO_COMMIT→errNothingToCommit, NOTHING_TO_PR→errNothingToPr, GIT_IDENTITY_MISSING→errIdentity, GIT_LOCKED→errGitLocked, COMMIT_HOOK_FAILED→errCommitHook, GIT_SIGN_FAILED→errSign, PUSH_REJECTED→errPushRejected, AUTH_FAILED→errAuth, PR_NOT_FOUND→errPrNotFound, PR_NOT_MERGEABLE→errNotMergeable, CHECKS_FAILING→errChecksFailing, MAIN_DIRTY→errMainDirty, AGENT_BUSY→agentBusy, MERGE_CONFLICT→errConflict, RUN_BUSY→errBusy, OP_INTERRUPTED→errInterrupted, TIMEOUT→errTimeout`

데몬 알림 문구(§3.4)는 데몬이 한국어로 보낸다(기존 agent-state 알림과 동일 정책). 클라이언트 `notif*` 키는 없다.

팔레트 라벨(`text/palette.js` / 앱 팔레트 표): `tasks.dashboard` = "작업 현황판", `tasks.new` = "새 작업" (앱은 `tasks.open` 이 "작업 현황판").

---

## 10. 보안·프라이버시 불변식
1. 서버는 **프롬프트 전문·diff 내용·파일명·PR 본문·작업 제목**을 봉인 경로에서 절대 보지 않는다. 평문 폴백은 사용자 E2EE 정책이 off/optional 일 때만이며 기존 `fs.*` 폴백과 같은 등급이다.
2. 서버에 평문으로 가는 작업 관련 값은 **의미 없는 식별자뿐**이다: 워크스페이스 이름/`localPath`(`<repoSlug>-<t6>-<k>`), agent_state `cwd`, 알림 `cwd/wsName`, `tasks.changed` 의 id·reason. 저장소 이름(`repoSlug`)은 기존 워크스페이스 이름과 같은 등급이다. 알림 title 은 일반 문구(§3.4). 브랜치명은 `cpt/<t6>-<k>` 라 그 자체가 정보가 아니다.
3. gh/git 자격증명을 읽거나 복사하거나 env 로 옮기지 않는다. `gh auth token` 을 호출하지 않는다. 폴더 신뢰를 대신 기록하지 않는다.
4. 모든 경로는 `fs.safeResolve` 홈 jail. worktree 는 `<stateDir>/worktrees/` 아래로만, 저장소 path 도 jail 안. `task.diff file` 은 허용 집합 일치 + realpath 검사(§2.9). `rm -rf` 는 §2.10 4 의 세 조건 전부.
5. `execFile` 만 사용(셸 문자열 금지). 브랜치명·메시지는 인자로만(`--flag=value`/stdin). 프롬프트는 파일(0600)로만 셸에 닿고 내용은 셸 평가를 거치지 않는다.
6. 데몬 측 메서드 allow-list 는 없지만 **파라미터 검증은 데몬이 전부** 한다(back 은 통로).
7. 폐기는 파괴적이지 않다: `branch -D` 전에 `refs/codingpt/discarded/<runId>` 를 남긴다(30일).

## 11. 롤아웃 순서
1. daemon(tasks.js + 테스트) → 데몬 caps `task.v1`.
2. back 라우트 + caps → dev 배포.
3. mobile master.json + emit 커밋 → PC/mobile UI 병렬.
4. 통합: 픽스처 crossimpl 3종 그린 → §7.5 실기 완주(일회용 GitHub 리포) → PC 릴리스 발행(버전 범프) → 앱 빌드.

## 12. 변경 규칙
- 메서드/필드/상태/에러코드/원문을 바꾸려면 이 문서의 해당 표를 먼저 고치고 `docs/fixtures/agent-tasks/` 를 갱신한다. 코드만 고치는 변경은 리뷰에서 되돌린다.
- 추가는 자유(추가 전용 원칙: 새 필드는 optional, 구 클라는 무시), 삭제/의미 변경은 `task.v2` 로.

---

## 부록 A. 리뷰 반영 기록 (2026-09-29 rev2)

각 항목: 지적 → 코드 대조 결과 → 반영. "기각/정정" 은 지적이 코드와 다른 경우.

| # | 지적(요약) | 대조 | 반영 |
|---|---|---|---|
| A1 | 준비 게이트가 기다리지 않음(`statusOf` 가 launching→idle, 레코드 없음→idle) / `agentSignalOf(tsession)` 인자 오류 / hookless 는 `ready` 영구 null | **확인** agent-state.js:521-525, 225; agent-watch.js:129 `(session, cmd, title)` | 1차 배달을 런치 인자(프롬프트 파일)로 바꿔 게이트 자체를 없앴다(§2.5 10). paste 경로(`promptArg:null`·재전송)는 `rawStateOf` 신규 export + SessionStart 시각 + `agentSignalOf(session, cmd, title)` 3중 정의(§2.5 11) + 단위 테스트 |
| A2 | 새 worktree 는 신뢰 다이얼로그 → 매번 타임아웃 또는 프롬프트가 다이얼로그에 타이핑됨 | **확인** runner-core 에 trust 처리 0건(grep), agent-state.js:224 codex 주석 | §2.5 10b: `extractDialog` 로 감지 → `trustPending` → 카드 [신뢰하고 계속] → `task.run.trust`(driveDialog expect 대조). 자동 수락 없음(부록 B-1). E2E 2 에 claude·codex 모두 60s 조건 |
| A3 | 봉인 타임아웃 → 평문 재실행(이중 실행) | **확인** e2eeState.ts:58-63 이 4xx/5xx 전부 폴백; daemonController.js:1300 이 code 없는 실패를 `E2EE_UNSUPPORTED`(501) 로 접음(e2eeCodes.js:66-67) — 즉 타임아웃이 "구조적 미지원" 으로 위장돼 폴백된다 | 전용 `taskRpc`(§3.2: 구조적 코드/501 에서만 폴백, 단 타임아웃은 back 이 `TIMEOUT` 으로 먼저 매핑되므로 501 이 아님) + opId 멱등(§2.12) + 변이 전부 비동기 op + 자식 kill 후 락 해제 |
| A4 | discard 가 커밋만 있고 미푸시/미머지인 run 을 파괴; 캐시된 dirty; rm -rf 무검증 | 확인 | §2.10: 정리 시점 재계산, `UNMERGED_COMMITS`, 복구 ref, rm -rf 3조건 |
| A5 | `task.diff file` 경로 탈출(`--no-index`) | 확인(daemon.json 이 worktrees 의 형제) | §2.9 3 |
| A6 | 에러 페이로드가 구조를 못 실음 | **확인** e2ee.js:1048 `{e, code}`, control.js:680-684 `{error, code}`, daemonRelayService.js:340 code 만, response.js `detail=publicDetail`, cptsock.rs `CODE: msg` | `MERGE_CONFLICT`/`PR_EXISTS` 를 결과로(§2.13). code 위치 3경로 정본. 두 리뷰어가 갈린 "response.js 에 top-level code 추가" 는 **기각** — 기존 sealed 경로 선례(`e.publicDetail={code}`)와 같은 `detail.code` 로 통일, response.js 무수정 |
| A7 | `done` 알림 + `task_ready` 이중 푸시 | 확인 agent-state.js:397-414 | `configure({shouldNotify})`(§2.7) |
| A8 | `tasks.changed` 에 발신 host 없음 / ui_result 필수 / 10/s 상한 | 확인 daemonRelayService.js:1180-1186, :1084 | `params.host`, 클라 ok 응답, poolChanged 코얼레싱(§2.8, §2.5 9) |
| A9 | 폴더명 `--` 가 `liveWorkspaceNs` 불변식 파괴 / 제목 슬러그·브랜치명·알림 title 평문 유출 | 확인 cpt-server.js:488-497(`split('--')[0]`), nsOfCwd 는 `-` 연속을 안 접음; notificationService.js:143 title 로그 | 이름 규칙 전면 교체(§2.2), 알림 일반 문구(§3.4), §10 재정의(옵션 A 채택) |
| A10 | reconcile 이 creating/launching 을 못 벗어남 / 재부팅 복원은 빈 셸 / `configure` 가 RPC 시점 lazy | 확인 terminal-manifest.js:125-150(`poolEnvMap` 만), 원안 §2.3 | `tasks.start()` 를 cpt-server `start()` 에서(§2.3), reconcile 규칙(§2.11), `agentGone` + `resumeArgs`, `CPT_TASK_ID` 폐기 → `CPT_TSESSION` 으로 도출(pty 시그니처 무변경) |
| A11 | `termBackend.kill` 직접 호출 → 매니페스트 잔존 | 확인 pty.js:757-764 | `terminal.close` 경유(§2.6, §2.10) |
| A12 | git 위생(quotepath·color·optional-locks·numstat 중복·GIT_SSH_COMMAND·gpgsign) | 확인 | §2.4 공통 접두, §2.9 단일 numstat, SSH env 제거, `GIT_SIGN_FAILED` |
| A13 | worktree 에서 husky 실패 / index.lock | 확인 | `COMMIT_HOOK_FAILED`·`GIT_LOCKED`·`noVerify`·5분(§2.9) |
| A14 | worktree add 엣지(타임아웃·모노레포 subdir·서브모듈·base dirty·origin/base·락 키) | 확인 | §2.5 1/5/6, `repo.subdir/common`, `run.cwd`, `dirtyCount`(§2.9 git.branches) |
| A15 | gh `--repo` 부재 / SSH 별칭 / GH_TOKEN 안내 / `-` 시작 값 / 머지 후 로컬 base | 확인 | §2.4, §2.9 pr.merge (2) |
| A16 | agents.js export / `_setSearchOverride` 오기 | **확인** agents.js:452-482 (`_internals.setSearchOverride`, `probeLoginPath` 미노출) | §2.1, §7.1 |
| A17 | 프롬프트 20000자 vs chatInput 32KB | 확인 cpt-server.js:1357 | 두 리뷰어 값(32KB / 30000B) 중 **30000 UTF-8 바이트** 채택(재전송 paste 경로도 통과), `PROMPT_TOO_LARGE`, 코멘트 직렬화 30KB |
| A18 | caps 가 runner_status 에 없음 | 확인 daemonRelayService.js:870-900 | 옵션 B(릴레이 수정) **기각**(릴레이 무수정 원칙) → GET /status `runners[].caps` + online 전이 재조회(§2.3), `hostCaps` 소유 추가 |
| A19 | 클라 통합(새 workspaceId 미인지·PC agents 로컬만·projectId 자동 합류·필터 산재) | 확인 agents-view.js:46, workspaceService.js:265-279(remoteUrl **또는 이름** 일치 — 그래서 `remoteUrl:null` 만으론 부족, 이름도 유일해야 한다) | §4 술어 + 기본 셀렉터 필터, 목록 새로고침, `agentsRemote(hid)` |
| A20 | 팬아웃 순차 → 마지막 run 2~3분 지연 | 확인 | §1.6, §2.5(락은 5~6 만) |
| A21 | tasks.json 모드·`~/.codingpt` 하드코딩 | 확인 runtime.js:21-22 | §2.2 |
| A22 | dedupe 키 host 불일치 / `since` 데이터 소스 없음 | **부분 정정**: PC `agentStates` 가 `${cwd}|${win}` 키인 것은 맞다(state.js:770). 그러나 "`since` 소스가 없다" 는 **틀림** — 데몬이 agent_state 프레임에 `since`(상태 전이 시각)를 싣는다(agent-state.js:126/177/549, PC state.js:772 주석에도 명시) | `sinceAt` 신설 대신 프레임 `since` 를 두 스토어가 보존(§5.1). host 0 정규화·`listAgentSnaps()` 는 채택 |
| A23 | E2E 가 실제 main 에 squash 머지 | 확인 | 일회용 리포(§7.5) |
| A24 | `fetch:true` 가 시작점에 무효 | 확인 | origin/<base> 시작점 + `baseSha`(§2.5 5) |
| A25 | 상태기계(closed 조건·crash·prevState·잔존 run·웹 머지) | 확인 | §1.4/1.5/§2.9 pr.status/§5.2 |
| A26 | merge.local 전제 역전(MAIN_NOT_ON_BASE) | 확인 | §2.9 (a)(b)(c), 코드 삭제 |
| A27 | pr.merge 에 dirty/working 전제 없음 | 확인 | `UNCOMMITTED_CHANGES`·`AGENT_BUSY` + 클라 비활성(§6.0) |
| A28 | pr.merge + 정리가 60s 안에 못 끝남 | 확인 | `cleanup:'pending'` 즉시 회신(§2.9) |
| A29 | 숨김 워크스페이스의 다른 소비자(알림 패널·surface-sync·팔레트) / 삭제 시 동작 | 확인 | §4 |
| A30 | 모바일 딥링크 리스너 부재 / push kind | 확인 pushService.ts:16, Linking 리스너 = usePairDeepLink·LoginScreen 뿐 | §6.9 |
| A31 | env 복사본이 커밋될 수 있음 | 확인 | exclude pathspec + worktree 안 check-ignore(§2.5 7, §2.9) |
| A32 | §5.3 자기정정 문장 / [중단] 무의미 / terminalAlive false 가 idle 로 | 확인 | 번호 목록(§5.3), [중단] 삭제 |
| A33 | serializeReviewComments 문법 불명확 | 확인 | §8.5 문법 |
| A34 | §9 누락·ERROR_KEY 없음·notif* 죽은 키 | 확인 | §9 전면 보강, notif* 삭제, 알려진 갭 명시 |
| A35 | 소유권 누락 파일 / 앱 픽스처 경로 | 확인 SidebarContent.tsx:410 `SectionHead` 로컬 | §8, §7.4 env 오버라이드 + skip |
| A36 | 폰 4단계 시트 / 결정표 미완 / back 제스처 | 확인 | `commitMessage` 원샷(§2.9), 결정표(§6.7 B), 3종 back(§6.4) |
| A37 | 전송 의미론(읽기 재시도·변이 실패 후 UI·타임아웃 경합) | 확인 | §3.2 |
| A38 | repo path 정규화(subdir) | 확인 | §2.5 1, `run.cwd` |
| A39 | 모션 재트리거·Android LayoutAnimation | 확인 | §6.8 |

## 부록 B. 열린 질문 (제품 오너 결정 필요)

- **B-1 폴더 신뢰 자동 수락**: 새 worktree 마다 claude/codex 가 신뢰를 묻는다. 현재 설계는 카드에서 1탭으로 답한다(자동 기록 없음). 원한다면 (i) `codex -c 'projects."<abs>".trust_level="trusted"'` 런치 플래그(실측 필요, 사용자 config 파일 무수정) (ii) `~/.claude.json` 의 `projects[<abs>].hasTrustDialogAccepted` 기록(사용자 설정 파일을 데몬이 쓰는 것 — 지금까지의 "개인 파일 무수정" 원칙 예외) 중 하나를 켤 수 있다. 기본은 **하지 않음**.
- **B-2 런치 인자 사용**: agents.js `launchCommand` 주석은 "런치 인자 미도입, 사용자 확정 2026-07-27" 이다. 이 설계는 **작업 run 에 한해** 프롬프트 파일 인자(`claude "$(cat …)"`)를 쓴다(일반 `agents.launch` 는 그대로). 이 예외를 승인할지. 거부하면 모든 에이전트가 §2.5 11 의 paste 경로를 타며 신뢰 다이얼로그 뒤 준비 판정에 의존한다(hookless 에이전트는 (c) 휴리스틱만 남는다).
- **B-3 프라이버시 등급**: 옵션 A(알림 제목 일반 문구·이름에 슬러그 없음)를 채택했다. 그 결과 현황판 카드는 `task.list`(봉인) 로 제목을 받기 전까지 "codingpt-x2m1qa-1" 같은 식별자만 보인다(수백 ms). 제목을 워크스페이스 이름에 넣어 서버에 평문으로 두는 대신 즉시 보이게 할지(옵션 B) 결정.
- **B-4 `discardOthers` 기본값**: 승자 머지 시 나머지 run 을 자동 폐기(복구 ref 30일)가 기본이다. 비교 목적이면 남겨 두는 편이 나을 수 있어 기본 off 로 바꿀지.
- **B-5 opencode/cursor-agent 의 프롬프트 인자**: CATALOG `promptArg` 를 null 로 두었다(플래그 실측 안 됨). 실측해 채우면 paste 경로가 필요 없어진다 — 이번 라운드 범위에 넣을지.

## 부록 Z. 제품 결정 확정 (2026-09-29, 제품 책임자 답변 — 본문과 충돌하면 이 절이 우선)

- **B-1 폴더 신뢰**: 자동 승인 없음. 카드의 한 번 탭(`task.run.trust`)으로만 응답한다. 사용자 개인 설정 파일(~/.claude.json 등)은 수정하지 않는다.
- **B-2 프롬프트 전달**: 태스크 실행에 한해 실행 인자 전달(promptArg, 0600 파일에서 읽기) 예외를 승인한다. 일반 터미널은 기존 "실행 인자 없음" 원칙을 유지한다.
- **B-3 프라이버시**: 옵션 A. 브랜치·폴더·워크스페이스 이름·푸시 알림에는 중립 식별자와 일반 문구만 쓴다. 제목은 봉인 RPC(task.list/get)로만 전달한다.
- **B-4 discardOthers**: 기본값 켜짐. 머지 시 나머지 실행은 자동 폐기하고, 복구 ref를 30일간 보관한다.
- **B-5 에이전트 범위**: 이번 라운드의 태스크 에이전트 선택지는 claude, codex, gemini(promptArg 보유)로 한정한다. cursor-agent·opencode는 태스크 선택지에서 제외한다(붙여넣기 경로 불필요).

## 부록 I. 통합 라운드 확정 (2026-09-29 — 4개 구현 교차 대조 결과. 본문과 충돌하면 이 절이 우선, 부록 Z 다음)

| # | 항목 | 확정 |
|---|---|---|
| I-1 | **봉인 경로 릴레이 타임아웃** | back `rpcSealed`(`/api/daemon/rpc`)는 릴레이 타임아웃(문구 `데몬이 응답하지 않습니다(RPC 타임아웃).`)을 **504 `TIMEOUT`** 으로 싣는다(`config/e2eeCodes.js SEALED_STATUS.TIMEOUT`). 종전에는 code 없는 실패로 501 `E2EE_UNSUPPORTED` 가 되어 §3.2 의 "구조적 미지원 → 평문" 규칙에 걸렸다(= 봉인 타임아웃 뒤 같은 변이를 평문으로 재전송, A3 이 막으려던 바로 그 경로). 기존 기능은 504 도 ≥500 폴백 규칙을 타므로 처방이 같다. 앱 `e2ee.sealedRpc` 는 `TIMEOUT` 에 10분 미지원 캐시를 켜지 않는다. |
| I-2 | 앱 봉인 HTTP 타임아웃 | 앱 `e2ee.ts raw()` 가 15s 고정 abort 였다 → 봉인 RPC 는 서버 타임아웃 + 5s(§3.1 규칙). `task.diff`/`git.pr.status`(30s)·`task.run.prompt`(20s)가 15s 에 잘리던 결함. |
| I-3 | **PC 의 caps 출처** | `GET /api/daemon/status` 를 `authMiddleware`(JWT 전용) → `accountAuth`(JWT \| deviceToken)로. PC `back_api` 는 deviceToken 만 보내므로 종전엔 PC `hostCaps` 가 영구 null 이었다(§2.3/A18 의 "유일한 출처" 를 PC 가 못 읽음). `getStatus` 는 `req.user.id` 만 쓴다. |
| I-4 | `MERGE_CONFLICT` 의 자리 | `run.lastOp = {kind:'merge.local'|'pr.merge', ok:false, code:'MERGE_CONFLICT', message, result: MergeResult{ok:false, code:'MERGE_CONFLICT', files}}`. "성공 결과"(§2.9/§2.13)는 **에러로 던지지 않는다**는 뜻이며, `lastOp.ok` 는 false 다 → §5.3 1 의 `lastOp.ok===false` 로 입력 대기 그룹. 파일 목록은 `lastOp.result.files`. 픽스처 `rpc-merge-result.json` 이 정본. |
| I-5 | `git.status` 결과(`RunGit`) | `{run: RunLite, branch, base, baseSha, upstream: string\|null, aheadUpstream: number\|null, behindUpstream: number\|null, lastCommit: {sha, short, subject, at}\|null}`. 현재 클라 소비처 없음(추가 전용). |
| I-6 | 전 run `task.discard` 의 opId | 대상 run **마다 같은 opId** 로 `lastOp` 를 기록한다. 응답 `run` 은 첫 대상 run. 클라는 아무 대상 run 하나의 `lastOp.opId` 로 완료를 판정해도 된다. 자동 폐기(머지 후 `discardOthers`)는 `lastOp.opId = <mergeOpId>:<runId>`, kind `discard`; 건너뛴 run 은 `ok:true` + `result.skipped`. |
| I-7 | 재접속 워크스페이스 재등록 | `control.js hello_ack` → `tasks.onReconnect()`: `workspaceId` 가 null 인 run 만, 60s 스로틀을 이번 한 번 무시하고 등록 재시도. 기동 전·`TASKS_DISABLED` 면 무동작. (그 밖의 재시도: 기동 reconcile · `task.list` 60s 스로틀) |
| I-8 | `task.delete` 거부 | 종결 작업이라도 살아 있는 run(`op` 진행 중 또는 `creating/launching/running/review_ready/merging`)이 남아 있거나, **어느 run 이든 worktree 폴더가 아직 있으면**(머지 후 폐기가 건너뛴 `failed` run·정리 보류된 승자) `BAD_PARAMS`(worktree 고아 방지). 클라는 [기록 삭제] 전에 잔존 run 을 [폐기] 하도록 안내한다. 삭제 시 각 run 의 복구 ref(`refs/codingpt/discarded/<rid>`)도 지운다. |
| I-9 | 폐기 확인의 `{n}` | 에러는 code+message 만 싣는다(§2.13) → `discardConfirm` 은 `run.diff.files`, `discardUnmergedConfirm` 은 `run.commits.ahead` 로 채운다. |
| I-10 | 팔레트 표 | `tasks.dashboard`(⌘⇧A, PC)·`tasks.new`(⌘⇧N, PC)·`tasks.open`(앱) 세 줄이 **PC `commands.js`·앱 `palette/commands.ts` 양쪽에 동일하게** 있다(`pc`/`app` 플래그로 플랫폼별 노출). |
| I-11 | 종결 작업 행 키 | `${host}\|task:${taskId}` — PC·앱 동일(교차 테스트가 정규화 없이 대조). |
| I-12 | 알려진 갭(이번 라운드 비수정) | (a) PC 원격 봉인 실패는 로컬 데몬 `e2ee-local.js` 가 back 의 status/code 를 `E2EE_RELAY_FAILED` 로 접는다 → 서버가 봉인을 꺼도(501) PC 는 평문으로 내려가지 않고 오류를 그린다(안전 방향). PC 는 문구로 TIMEOUT 만 식별. (b) 인앱 알림 행에는 `deeplink`/`hostDeviceId` 가 저장되지 않는다(back 무수정) → 클라가 `(cwd, win)` 으로 run 을 찾아 라우팅한다. 푸시(FCM)는 `deeplink` 를 싣는다. (c) back 평문 경로의 code 없는 실패 기본값 `GH_ERROR` 는 §3.3 그대로. |
