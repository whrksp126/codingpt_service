# 자동화 번들 설계 정본 (2026-09-29, rev1)

> "폰에서 한 문장을 보낸다 → AI 가 어느 PC·어느 저장소·몇 명의 에이전트로 할지 계획한다 → 한 번 탭으로 작업이 만들어진다 →
> PR 의 CI 가 깨지거나 리뷰가 달리면 [고치기] 한 번으로 에이전트에게 되돌려 보낸다 → 반복되는 일은 AI 가 스스로 자동화를
> 만들어 두고 사용자는 목록에서 본다 → 그동안 PC 는 잠들지 않는다".
>
> 이 문서는 `agent-tasks-design.md`(이하 **설계**)·`agent-tasks-sidebar.md`(이하 **사이드바**) 위에 얹는 **네 기능 한 묶음**의
> 유일한 계약이다. 6개 슬라이스(S1~S6, §10)가 서로 대화 없이 동시에 구현한다. 메서드명·필드명·상태값·에러코드·원문·파일
> 소유권은 그대로 쓴다. 바꿔야 하면 이 문서를 먼저 고친다(§13).
>
> 표기: 산문 한국어, 식별자·JSON·경로 영어. MUST/SHOULD 는 RFC 의미. 줄번호는 2026-09-29 `feat/automation` 트리 기준.
> 설계·사이드바 문서와 충돌하면 **이 문서가 우선**한다(이 네 기능 범위에 한해). 부록 Z 는 결정과 근거·리스크.

---

## 0. 결정 요약 (한 페이지)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 네 기능 | **F1 한 줄 지시(dispatch)** · **F2 PR 후속(followup)** · **F3 자동화(automations)** · **F4 PC 깨어 있기(power)**. 전부 이번 라운드, Mac·Android·iOS |
| 2 | 공통 뼈대 | 데몬 안 **이벤트 버스 `events.js`**(`task.review_ready`·`task.merged`·`task.failed`·`pr.ci_failed`·`pr.review_comments`·`auto.fired`·`activity.changed`). tasks.js 가 발행, automations/power 가 구독 |
| 3 | caps | `dispatch.v1` · `auto.v1` · `power.v1`(데몬 `OPTIONAL_CAPS` + back `SERVER_CAPS`). F2 는 `task.v1` **추가 전용**(새 필드 optional) + 새 메서드 2개는 `auto.v1` 가 광고(§4.4) |
| 4 | 전송 | 새 RPC 전부 봉인 우선, 평문 폴백은 `taskRpc` 규칙 그대로(구조적 미지원에서만). back 평문 라우트 **`POST /api/daemon/auto`** 하나 + `AUTO_RPC_OK`(§7.1). LAN 직결 없음 |
| 5 | F1 플래너 | **사용자 자신의 CLI 를 헤드리스**로(`claude -p` → `codex exec` → `gemini -p` 순, 로그인 된 첫 것). 실행 PC = 활성 PC. 카탈로그(모든 온라인 PC 의 워크스페이스 이름·경로·remote·README 머리·최근 커밋 제목)는 **클라이언트가 PC 마다 봉인으로 모아 플래너 PC 에 봉인으로 전달**(back 은 내용 0). 실패·미로그인·타임아웃 → **결정적 이름 매칭 폴백**(자동화는 제안하지 않음) |
| 6 | F1 결정권 | 항상 **플랜 카드** → 사용자가 저장소·에이전트·개수 조정 → [시작] 1탭 → 기존 `task.create`(+`auto.create`). 자동 실행 없음 |
| 7 | F2 감지 | 데몬 **백그라운드 폴러**(3분, `pr.state==='open'` 인 run 만, gh 인증 시) + 상세 열림 중 `git.pr.status`(30s) 가 같은 판정기를 탄다. check-run 은 `name@headSha`, 코멘트는 GitHub id 로 dedupe |
| 8 | F2 결정권 | 자동 수정 없음. 알림 + 카드 [고치기] → `task.run.fix` 가 실패 로그(`gh run view --log-failed` 꼬리)·코멘트를 **기존 프롬프트 배달 경로**(`waitAgentReady`+`chatInput`)로 보낸다 → run `running` → 다음 턴 종료에 `review_ready` |
| 9 | F3 모델 | 자동화 = 트리거 1개 + 액션 1~5개(순서열 = **매크로**) + 가드. 트리거 `schedule`(cron+tz / 일회 `at`)·`git.commits`·`github.issues`·`pr.ci_failed`·`pr.review_comments`·`task.event`. 액션 `task.create`·`terminal.prompt`·`notify`. **임의 셸 없음, 파일 감시·터미널 출력 패턴 없음**(§5.2 근거) |
| 10 | F3 생성자 | 에이전트는 **`cpt auto`**(그 PC 의 CodingPT 터미널 안, `assertCptContext` 통과 + tmux `cpt-` 자기좌표 필수)·플래너(`createdBy.kind:'dispatch'`)·사용자(UI). AI 가 만들면 알림 `auto_created`. **자동화가 만든 작업의 에이전트는 자동화를 만들 수 없다**(`AUTO_LOOP`), 연쇄 깊이 ≤ 2(`AUTO_DEPTH`) |
| 11 | F3 가드 | PC 당 30개 · 하루 실행 기본 10(상한 50) · 동시 1 · 스케줄 최소 간격 15분 · 폴링 5분 · 작업은 **worktree 만**(`task.create` 경유, `TASK_LIMIT` 공유) · 감사 로그 NDJSON · 전체 일시정지 킬스위치 · 놓친 스케줄은 **24h 안이면 깨어난 뒤 1회**, 그 밖은 건너뜀 |
| 12 | F3 위치 | 사이드바 고른 PC 밑 `진행 현황` **다음 줄 `자동화`** = 장소(사이드바 개정 1 규칙 그대로). 목록·상세·일시정지/재개/지금 실행/삭제/이름 변경. 작업 카드에 `자동` 칩 |
| 13 | F4 두 층 | (a) 작업 활성 중 `caffeinate -i -s`(권한 없음) (b) 덮개 닫힘 = `pmset -a disablesleep 1`(root) → **1회 설정**: `osascript … with administrator privileges` 가 macOS 인증 다이얼로그를 띄우고 `/etc/sudoers.d/codingpt-pmset`(그 명령 2개만 NOPASSWD, `visudo -c` 검증, 0440) 설치. 데몬은 **활성 중·AC 전원일 때만** 1, 유휴·종료·기동 복구에서 항상 0 |
| 14 | F4 알림 | PC 앱(Tauri) `NSWorkspaceWillSleepNotification` → 데몬 → `pc_sleeping` 푸시(best effort). 데몬은 `runner_busy {busy, awake}` 프레임만 보내고 back 은 **끊김 후 90초 유예** 뒤 `pc_disconnected` 푸시(내용 0, 불리언 2개) |
| 15 | 공유 순수 모델 | `tasksModel` 에 needs_input 사유 `ciFailed`·`reviewComments` 추가(픽스처 model-12/13). 신규 `automationsModel`(픽스처 auto-01/02). 교차 테스트는 기존 방식 |
| 16 | 제품 규칙 | 이모지 0 · 선택은 무채색 · 상태 신호만 색 · RN PressableScale · 7개 언어(master.json + 양쪽 카탈로그 **직접 삽입**, emit 금지) · UI 에 "Claude Code" 등 벤더 제품명 금지(Claude/Codex/Gemini 만) |

---

## 1. 범위·흐름·비목표

### 1.1 사용자 흐름 (네 기능이 이어지는 하루)
1. 폰 진행 현황 헤더 [한 줄 지시] → "codingpt 백엔드에 결제 실패 재시도 넣고, 매일 아침 9시에 열린 bug 이슈 정리해줘" → 카탈로그 수집(온라인 PC 2대) → 활성 PC 가 `claude -p` 로 계획 → 카드: 작업 1(MacBook · codingpt/codingpt_back · claude×1) + 자동화 1(매일 09:00 · github.issues label bug → task.create). 사용자가 에이전트를 codex 로 바꾸고 [시작].
2. 작업이 진행 현황에 생기고(설계 §1.3 그대로), 자동화가 `자동화` 장소에 생긴다("AI 가 만든 자동화" 알림은 플래너 경로에선 내지 않는다 — 사용자가 방금 [시작] 을 눌렀다).
3. 에이전트가 PR 을 만들고 CI 가 깨진다 → 3분 안에 카드가 "검사 실패" 로 입력 대기에 올라오고 푸시 → [고치기] → 로그가 에이전트에게 들어가고 작업 중 → 리뷰 준비 → 사용자가 푸시.
4. 그동안 MacBook 은 덮개를 닫아도 계속 돈다(1회 설정 완료 시). 작업이 끝나 2분 유휴면 잠자기 허용으로 돌아간다.
5. 작업 중 PC 가 끊기면(전원·네트워크) 90초 뒤 "PC 연결이 끊겼어요" 푸시.
6. 다음날 09:00 자동화가 이슈 3개로 작업 3개를 만든다(하루 상한 10). 에이전트가 이슈를 처리하다 "이 저장소는 커밋될 때마다 테스트 돌리는 게 좋겠다" 고 판단하면 **자기가** `cpt auto create` 로 자동화를 만든다 → 사용자에게 `auto_created` 알림 → 목록에서 확인·일시정지 가능. 단 **자동화가 만든 작업 안의 에이전트**라면 거부된다(`AUTO_LOOP`).

### 1.2 비목표
- 사용자가 폼으로 자동화를 처음부터 만드는 편집 UI(이번 라운드: 이름 변경·일시정지·재개·지금 실행·삭제만. 생성은 한 줄 지시 또는 에이전트).
- 자동화 액션에서 임의 셸 실행·파일 쓰기·git push·PR 머지. 파일 감시·터미널 출력 패턴 트리거(§5.2).
- 서버측 자동화 저장/오프라인 열람(PC 꺼지면 그 PC 자동화는 "PC 오프라인").
- Windows/Linux 의 F4(power.js 는 darwin 외 `POWER_UNSUPPORTED`). F1~F3 는 플랫폼 중립.
- 플래너에 우리 키·우리 서버 모델을 쓰는 것. 벤더별 헤드리스 플래그 실측 전 확정(부록 Z-1).
- 잠자는 PC 를 스케줄 시각에 깨우기(`pmset schedule wake`, 부록 Z-9).

---

## 2. 공통 기반 (데몬)

### 2.1 새 파일 / 수정 파일

| 파일 | 슬라이스 | 역할 |
|---|---|---|
| `runner-core/events.js` (신규) | S1 | 프로세스 내 이벤트 버스. `on(type, fn) → off`, `emit(type, payload)`(동기, 리스너 예외 격리+로그). 타입은 §2.2 |
| `runner-core/json-store.js` (신규) | S1 | `readJson(file, {fallback, validate})`, `writeJsonAtomic(file, obj)`(`.<pid>.tmp` + mode 0600 + chmod + rename — tasks.js:213 패턴 추출). tasks.js 는 **무수정**(기존 저장 코드 유지) |
| `runner-core/automations.js`, `cron.js`, `template.js` (신규) | S1 | §5 |
| `runner-core/dispatch.js`, `power.js` (신규) | S2 | §3, §6 |
| `runner-core/tasks.js` (수정) | S2 | F2 필드·RPC·폴러, `origin`, 이벤트 발행(§2.2), `internalCreate` |
| `runner-core/task-git.js` (수정) | S2 | `prComments`·`prReviews`·`issueComments`·`runLogFailed`·`actionsRunIdOf`·`issuesList`·`commitsSince`(§4.1, §5.2) |
| `runner-core/agents.js` (수정) | S2 | CATALOG `headless` + `loginStatus(id)` 추가 전용(§3.3) |
| `runner-core/control.js` (수정) | S1 | `OPTIONAL_CAPS` 3줄 + `dispatchRpc` 분기 1줄 + 킬스위치 + `runner_busy` 송신(§2.3, §6.5) |
| `runner-core/cpt-server.js` (수정) | S1 | `handleAutoRpc`, 소켓 분기, `CAPABILITIES` 추가, `wireAutomations/wireDispatch/wirePower`, `notifyAutomationsChanged`·`notifyDispatchChanged`·`notifyPowerChanged` |
| `cpt-cli/bin/cpt.js`, `GUIDE.md`, `SKILL.md` (수정) | S1 | `cpt auto …`(§5.7) |
| `test/{automations,cron,template,dispatch,power,followup}.test.js`, `test/automation-e2e.test.js` (신규) | S1/S2 | §9 |
| `docs/fixtures/automation/*.json` (신규) | S6(모델/UI) · S1/S2(rpc-*) | §8 |

### 2.2 이벤트 버스 (`events.js`)

```ts
type Ev =
 | { type:'task.created',        task: TaskLite, origin: Origin|null }
 | { type:'task.review_ready',   task: TaskLite, run: RunLite }
 | { type:'task.merged',         task: TaskLite, run: RunLite }
 | { type:'task.failed',         task: TaskLite, run: RunLite, code: string }
 | { type:'pr.ci_failed',        task: TaskLite, run: RunLite, ci: FollowupCi }          // §4.2
 | { type:'pr.review_comments',  task: TaskLite, run: RunLite, reviews: FollowupReviews }
 | { type:'auto.fired',          automation: AutomationLite, firingId: string }
 | { type:'activity.changed',    active: boolean, reasons: string[] }                     // §6.3
```
- 발행 지점(tasks.js): `emit('task.created')` = §2.5 4단계 저장 직후; `task.review_ready` = `evaluateTurn` 이 `review_ready` 로 올릴 때(알림 `task_ready` 와 같은 자리, `pushNotification` 직전); `task.merged` = `finishMerge` 승자 확정; `task.failed` = `failRun`; `pr.*` = §4.1 판정기.
- 리스너 예외는 삼키고 `log('[events] listener error', type, e.message)`. 리스너가 느려도 발행자를 막지 않게 **`setImmediate` 로 분리**(발행 순서는 유지).
- 테스트 훅 `_reset()`.

### 2.3 caps · RPC 배선 · 킬스위치

**control.js**
```js
// OPTIONAL_CAPS 에 3줄 추가(모듈 로드 실패/미지원 플랫폼이면 자동으로 광고 안 됨 — task.v1 과 동일 규칙)
['auto.v1',     './automations', 'handle'],
['dispatch.v1', './dispatch',    'handle'],
['power.v1',    './power',       'handle'],   // power.js 는 darwin 외에서 handle 을 undefined 로 둔다
// dispatchRpc: task./git. 분기 바로 뒤
if (method.startsWith('auto.') || method.startsWith('dispatch.') || method.startsWith('power.')) {
  const fam = method.split('.')[0];
  const cap = { auto:'auto.v1', dispatch:'dispatch.v1', power:'power.v1' }[fam];
  if (serverCaps.length && !hasServerCap(cap)) { fail(`${fam.toUpperCase()}_DISABLED`, …); return; }   // 서버 킬스위치(task.v1 패턴 control.js:396 과 동일)
  callLazy('./cpt-server', 'handleAutoRpc', [method, params || {}], ok, fail); return;
}
```
- F2 의 `task.run.fix`·`task.run.followup.dismiss` 는 `task.` 접두라 기존 분기를 탄다. 클라는 **`hostCaps(host)` 에 `auto.v1` 가 있을 때만** [고치기] 를 그린다(구 데몬은 `BAD_PARAMS` 로 실패하므로 카드에 버튼을 내지 않는다).
- 각 모듈은 tasks.js 와 같은 규약: `configure(opts)`, `start()`, `handle` **getter**(비활성이면 undefined → cap 미광고), `_internals`.

**cpt-server.js**
```js
function wireAutomationBundle() {                     // start() 에서 wireTasks() 직후 1회
  const common = { notify: notifyAutomationsChanged, backFetch, deviceId: () => cfg.deviceId, log };
  require('./automations').configure({ ...common, tasks: require('./tasks'), chatInput: (a) => chatInput(a), serverCaps: () => control.serverCaps() });
  require('./dispatch').configure({ ...common, notify: notifyDispatchChanged, tasks: require('./tasks'), agents: agentsLib, fsRead: fsLib.readHead });
  require('./power').configure({ ...common, notify: notifyPowerChanged, tasks: require('./tasks'), sendControl: (frame) => control.send(frame) });
  for (const m of ['./automations', './dispatch', './power']) { const lib = require(m); if (lib.handle) lib.start(); }
}
function handleAutoRpc(method, params) {
  const fam = method.split('.')[0];
  const lib = require({ auto:'./automations', dispatch:'./dispatch', power:'./power' }[fam]);
  if (!lib.handle) throw codedError(`${fam.toUpperCase()}_DISABLED`);
  return lib.handle(method, params || {});
}
```
- 유닉스 소켓 디스패치(cpt-server.js:786 옆): `if (/^(auto|dispatch|power)\./.test(cmd)) return handleAutoRpc(cmd, req.args||{}, req)` — **`auto.*` 는 `resolveCtx`+`assertCptContext` 를 먼저 통과**시킨다(에이전트 생성 게이트, §5.7). `dispatch.*`·`power.*` 는 PC 앱 로컬 커맨드 전용(게이트 밖, `task.*` 와 동일).
- `CAPABILITIES` 에 추가: `auto.list, auto.get, auto.create, auto.update, auto.remove, auto.pause, auto.resume, auto.runNow, auto.log, auto.validate`. **의도된 결정**: 설계 §2.3 의 "AI 가 스스로를 늘리는 명령은 비공개" 규칙의 **명시적 예외**다(사용자 지시). 방어는 §5.5 가드·루프 규칙·알림·킬스위치.
- 데몬 env 킬스위치: `CPT_AUTOMATIONS=0` → automations `handle` undefined + 엔진 미기동. `CPT_DISPATCH=0`, `CPT_POWER=0` 동일.
- `notify*Changed` 는 `notifyTasksChanged`(cpt-server.js:430) 복제: 300ms 코얼레싱 → `sendUiCommand('<fam>.changed', {host, ids, reason}, {mode:'broadcast', timeoutMs:5000})`. 수신 클라는 반드시 `ui_result ok`.

### 2.4 스토어 공통
- `<stateDir>/automations.json`, `dispatch/`(0700, 플랜 결과 캐시 + 플래너 cwd), `power.json`, `automations.log`(NDJSON, 2MB 넘으면 `.1` 로 회전, 1세대만). 전부 `runtime.stateDir()` 기준, `~/.codingpt` 하드코딩 금지.
- 스키마 검증 실패 항목은 버리고 로그(tasks.json 규칙).

---

## 3. F1 — 한 줄 지시 (dispatch)

### 3.1 시퀀스 (클라이언트가 오케스트레이터)
```
폰/PC: [한 줄 지시] 시트에 문장 입력 → [계획]
 1. hosts = 온라인 local 러너 ∧ hostCaps ∋ 'dispatch.v1'        (0대 → noHost 안내, 시트 닫힘)
 2. 각 host 에 병렬 dispatch.catalog {}  (봉인, 30s)             → 실패한 PC 는 카탈로그에서 제외 + 카드 상단 "MacMini 카탈로그 실패" 한 줄
 3. planner = 활성 PC(activeDeviceId; 오프라인이면 hosts[0])
    dispatch.plan {opId, instruction, catalog:{hosts:[…]}, prefer:{agent?}}  → {accepted, planId, planner:{agent|null}}
 4. dispatch.get {planId} 를 2s 폴링(최대 120s) — 또는 ui_command dispatch.changed {host, planId} 수신 즉시
 5. state==='done' → 플랜 카드. 'failed' → 폴백 플랜(데몬이 이미 만들어 plan 에 실었다, planner.mode==='fallback')
 6. [시작] → tasks[] 각각 task.create(그 host, origin:{kind:'dispatch', planId}) 순서대로, automations[] 각각 auto.create(그 host, createdBy:{kind:'dispatch', planId})
    → 생성된 taskId 들로 openTasksDashboard({taskId: 첫 작업, host}) — 자동화만 있으면 openAutomations({id, host})
```
플래너 실행 PC 를 활성 PC 로 두는 이유: 카탈로그는 클라가 모으므로 어느 PC 든 계획할 수 있고, 활성 PC 가 사용자가 지금 보는 곳(로그인 상태를 사용자가 가장 잘 아는 PC)이다. 카탈로그 기준 `hosts[]` 는 클라가 준 그대로 플래너에 간다.

### 3.2 `dispatch.catalog {}` (각 PC, 동기 30s)
```jsonc
{ "host": 12, "hostName": "MacBook Pro", "generatedAt": 1790000000000,
  "agents": [ { "id":"claude", "installed":true, "loggedIn":true }, { "id":"codex", "installed":true, "loggedIn":null } ],   // loggedIn null = 판정 불가
  "workspaces": [ {
    "id": "ws_abc", "name": "codingpt", "path": "work/codingpt", "subdir": "",           // 홈-상대(설계 §2.2 규칙)
    "remoteUrl": "https://github.com/whrksp126/codingpt.git", "github": {"owner":"whrksp126","repo":"codingpt"} | null,
    "branch": "main", "dirtyCount": 3,
    "readmeHead": "# CodingPT …(UTF-8 600바이트, 줄 경계에서 자름)",
    "recentCommits": ["fix: 결제 재시도", "…"],     // ≤5, 각 ≤80자, `git log -5 --format=%s`
    "topDirs": ["codingpt_back","codingpt_front","…"],   // 1단계 디렉토리 ≤12 (모노레포 서브폴더 선택용)
    "lastActivityAt": 1789990000000                      // git log -1 %ct*1000
  } ] }
```
- 원천: `backFetch('GET','/api/daemon/workspaces')` 를 `freshness.js tick()` 규칙으로 이 PC 것만(`compute==='local' && hostDeviceId===cfg.deviceId && localPath`). `isTaskWorkspace` 는 제외. 폴더 없음 → 항목 생략.
- git 정보는 `task-git.git()` 접두 규칙, 저장소당 총 3s, 동시 4개. README 는 `README.md`→`README`→`readme.md` 첫 존재 파일을 `fs.readHead(rel, 600)`(fsLib 에 추가 전용, jail) 로. 없으면 `""`.
- 캐시 10분(`catalogCache`, `refresh:true` 로 무효화). 상한 40개 워크스페이스·전체 48KB(`CATALOG_TOO_LARGE` 아님 — 초과분은 `lastActivityAt` 오래된 순으로 **자른다**, `truncated:true`).
- 내용(README·커밋 제목)은 **봉인 경로로만** 폰에 간다. 평문 폴백은 `fs.read` 와 같은 등급(사용자 정책).

### 3.3 `dispatch.plan` (플래너 PC, 비동기)
`dispatch.plan {opId, instruction, catalog, prefer?}` → 즉시 `{accepted:true, planId, planner:{agent}|null}` (opId 멱등, 최근 20개). `instruction` ≤ 4000 UTF-8 바이트(`BAD_PARAMS`), catalog ≤ 256KB.

**플래너 선택 `pickPlanner()`**(10분 캐시): `prefer.agent` → 아니면 `claude, codex, gemini` 순으로 `agents.resolveBin(id)` 존재 ∧ `agents.loginStatus(id)` ≠ `'out'`. 전부 없으면 `planner:null` 로 즉시 폴백(§3.5).
- `agents.loginStatus(id)`(신규, 4s 캐시 5분): claude → `claude auth status --json` exit 0 ∧ `loggedIn===true`(agent.js:366 `authStatus` 재사용) ; codex → `codex login status` exit 0 ; gemini → `null`(판정 불가, 실행해 보고 판단).

**헤드리스 실행**(CATALOG `headless` 추가 전용 — 부록 Z-1 실측 항목):
| agent | 인자 | 프롬프트 | 결과 파싱 |
|---|---|---|---|
| claude | `-p --output-format json --max-turns 1 --tools "" --append-system-prompt <SYS>` | stdin | stdout JSON → `.is_error` false ∧ `.result` 문자열에서 첫 `{`~마지막 `}` → JSON |
| codex | `exec --skip-git-repo-check --sandbox read-only --output-last-message <tmpFile>` | stdin | tmpFile 내용에서 첫 `{`~마지막 `}` |
| gemini | `-p <prompt> --output-format json` | 인자(SYS 포함) | stdout JSON `.response` → 첫 `{`~마지막 `}` |
- 바이너리는 **`agents.resolveBin(id)`**(원본 CLI — 우리 `<stateDir>/bin` 래퍼 제외 → 훅·statusLine 주입 없음). env = `task-git.tools().env`(로그인 셸 PATH 포함) + `CPT_HOOKS_DISABLED=1`, `TMUX` 제거. cwd = `<stateDir>/dispatch/`(빈 폴더 — 프로젝트 CLAUDE.md/AGENTS.md 를 읽지 않게). 데드라인 `PLANNER_TIMEOUT_MS=90000`, 초과 시 SIGTERM→2s→SIGKILL, `PLANNER_TIMEOUT` → 폴백.
- stdout 에 `trust|Do you trust` 다이얼로그 문구가 보이거나 exit≠0 → `PLANNER_FAILED{stderr 앞 300자}` → 폴백. **자격증명은 읽지 않는다**(CLI 가 자기 로그인으로 API 를 부른다 — agent.js 와 같은 등급).
- 프롬프트 = SYS(고정 한국어 지시: "너는 작업 계획기다. 도구를 쓰지 말고 아래 JSON 스키마만 출력해라 …") + `catalog` JSON + `instruction`. 스키마 위반 JSON(필수 필드 누락·host/workspaceId 가 카탈로그에 없음·agents id 가 미설치) → 항목 단위로 버리고, 남는 tasks 가 0 이면 폴백.
- 비용·지연 기대치: 입력 ≈ 카탈로그 48KB 상한 → 보통 8~12k 토큰, 출력 ≤ 2k. claude 6~20s, codex 10~30s. 구독 사용량으로 계산되며 데몬은 비용 필드를 저장하지 않는다(`total_cost_usd` 무시).

**플랜 결과 `dispatch.get {planId}`** → `{planId, state:'planning'|'done'|'failed', plan?: Plan, error?:{code,message}, startedAt, finishedAt}`. 결과는 `<stateDir>/dispatch/<planId>.json`(0600) 에 24h 보관 후 삭제.
```jsonc
// Plan
{ "v":1, "planner": { "agent":"claude"|"codex"|"gemini"|null, "mode":"cli"|"fallback", "durationMs":8400, "fallbackReason": null|"PLANNER_UNAVAILABLE"|"PLANNER_TIMEOUT"|"PLANNER_FAILED"|"BAD_PLAN" },
  "summary": "codingpt_back 에 결제 재시도 추가 + 매일 09:00 bug 이슈 정리",
  "tasks": [ { "host":12, "workspaceId":"ws_abc", "repo":"work/codingpt", "subdir":"codingpt_back", "base":"main",
               "title":"결제 실패 재시도", "prompt":"…", "agents":[{"id":"claude","count":1}], "confidence":0.82, "why":"README 에 codingpt_back 이 결제 API 라고 적혀 있음" } ],
  "automations": [ { "host":12, "draft": AutomationDraft, "why":"'매일 아침 9시' 반복 지시" } ],   // §5.1 draft
  "questions": ["'정리' 가 이슈 닫기까지 포함하나요?"] }
```
`tasks` ≤ 4(합계 run ≤ 4 — `TASK_LIMIT` 와 동일), `automations` ≤ 3, `prompt` ≤ 30000B(초과분 자름), `questions` ≤ 3.

### 3.4 결정권 (플랜 카드)
- 항목마다 PC(온라인만)·저장소(그 PC 카탈로그)·에이전트 칩+`×n` 스텝퍼·프롬프트(접힘, 편집 가능)·why(한 줄, dim). 자동화 항목은 트리거 요약 + 액션 요약 + 포함 체크(기본 on).
- `questions` 가 있으면 카드 위에 질문 박스(입력 없음 — 사용자가 문장을 고쳐 [다시 계획] 하거나 그대로 [시작]).
- `planner.mode==='fallback'` 이면 카드 상단 pill `간단 매칭`(무채색) + 사유 문구(`fallbackNoAgent`/`fallbackTimeout`/`fallbackFailed`). 저장소가 못 정해진 항목(`workspaceId:null`)은 [시작] 비활성 + 저장소 셀렉터 강조.

### 3.5 결정적 폴백 `planFallback(instruction, catalog)` (dispatch.js 순수 함수, 테스트 대상)
1. 토큰화: NFKC → 소문자 → `[^\p{L}\p{N}]+` 로 분리, 길이 ≥ 2, 불용어(`좀 해줘 해주세요 the a to in on 추가 수정 만들어`) 제거.
2. 워크스페이스 점수: `name` 정확 일치 +6 · name 토큰 +3 · `topDirs` 토큰 +3(→ `subdir` 지정) · `path` 마지막 2 세그먼트 토큰 +2 · `github.repo` 토큰 +3 · README 토큰(≤ +2 누적) · 최근 활동 7일 안 +1.
3. 최고점 ≥ 3 → 그 워크스페이스(동점은 `lastActivityAt` 최신). 카탈로그에 워크스페이스가 정확히 1개면 무조건 그것. 그 외 `workspaceId:null`(카드에서 고른다).
4. 에이전트 = 그 host 의 `tasks.json` 최근 작업 `runs[0].agent`(있으면) → 아니면 `claude, codex, gemini` 중 첫 설치. count 1. `base` = 카탈로그 `branch`. `title` = instruction 첫 60자. `prompt` = instruction 그대로. `confidence` = min(1, score/10).
5. **자동화는 제안하지 않는다**(오탐으로 반복 작업이 생기는 비용 > 편익). `questions:[]`.

### 3.6 에러 코드
`DISPATCH_DISABLED, DISPATCH_NOT_FOUND(planId), PLANNER_UNAVAILABLE, PLANNER_TIMEOUT, PLANNER_FAILED, BAD_PLAN, CATALOG_TOO_LARGE(>256KB 입력)`. 폴백이 있으므로 `PLANNER_*` 는 **에러로 던지지 않고** `plan.planner.fallbackReason` 에 실린다(`dispatch.get` 은 `done`). `failed` 는 폴백조차 못 만든 경우(`BAD_PARAMS`·`DISPATCH_DISABLED`)뿐.

---

## 4. F2 — PR 후속 자동 처리 (followup)

### 4.1 감지
**판정기 `assessFollowup(t, r, {prInfo, comments, reviews, issueComments, now})`**(tasks.js 순수 함수) — 두 호출자가 같은 함수를 쓴다:
- (a) `git.pr.status`(클라 30s 폴링, 상세 열림 중) — `prView` 뒤에 코멘트 3종도 조회.
- (b) **데몬 백그라운드 `followupTick()`**: `setInterval(PR_FOLLOW_POLL_MS=180000).unref()`, `tools().gh.authenticated` 일 때만. 대상 = `run.pr?.state==='open' && run.state ∈ {running, review_ready}` 이고 op 없음. 틱당 최대 10 run(`followup.polledAt` 오래된 순). run 당 gh 호출 4개(≤ 40/3분 — GitHub 5000/h 대비 여유). 실패는 로그만, 다음 틱.

**task-git.js 추가**(전부 `--repo` 규칙·`gh api` 는 `-q` jq 로 필드만):
- `prComments(dir, github, n, since)` → `gh api repos/{o}/{r}/pulls/{n}/comments?since=<iso> --paginate -q '[.[]|{id,kind:"review_comment",author:.user.login,bot:(.user.type=="Bot"),path,line:(.line//.original_line),body,url:.html_url,at:.created_at}]'`
- `prReviews(dir, github, n)` → `…/pulls/{n}/reviews` → `state ∈ {CHANGES_REQUESTED, COMMENTED, APPROVED}` 이고 `body` 비어 있지 않거나 `CHANGES_REQUESTED` 인 것 `{id, kind:'review', author, bot, state, body, url, at:submitted_at}`
- `issueComments(dir, github, n, since)` → `…/issues/{n}/comments?since=` `{id, kind:'issue_comment', …}`
- `actionsRunIdOf(url)` → `/actions/runs/(\d+)/` 캡처 또는 null
- `runLogFailed(dir, github, runId)` → `gh run view <runId> --repo o/r --log-failed`(60s, maxBuffer 16MB) → ANSI 제거 → **마지막 200줄, 12KB** 로 자름 `{text, truncated}`

**CI 판정**: `pr.checks.status==='failing'` 이고 실패 항목 집합 `failing = items.filter(status==='failing').map(i => `${i.name}@${headOid}`)` 중 `followup.ci.seen` 에 없는 것이 하나라도 있으면 **새 실패**. `seen` 은 최근 50개 유지. 헤드가 바뀌면(`headOid` 변경) 자연히 새 키가 된다.
**리뷰 판정**: 3종 합집합에서 `id ∉ followup.reviews.seenIds`(최근 300) ∧ `at > followup.reviews.cursor` ∧ **자기 코멘트 제외 규칙 없음**(사용자가 GitHub 앱에서 단 코멘트도 에이전트에게 보내고 싶은 경우가 정상 사용). 봇 코멘트 포함. 첫 관찰 시 `cursor = now`(기능 도입 전 코멘트를 재생하지 않는다).

### 4.2 모델 변경 (tasks.json · 와이어 — `RUN_FIELDS` 에 `followup` 추가, `TASK_FIELDS` 에 `origin` 추가)
```jsonc
"followup": {
  "polledAt": 1790000000000,
  "ci": { "status": "failing"|null, "headSha":"abc…", "detectedAt": 1790000000000, "dismissedAt": null, "fixOpId": null,
          "failed": [ { "name":"ci / lint", "url":"https://…/actions/runs/2/job/9", "runId":"2" } ],   // ≤ 10
          "seen": ["ci / lint@abc…"] },
  "reviews": { "cursor":"2026-09-29T00:00:00Z", "detectedAt": 1790000000000, "dismissedAt": null, "fixOpId": null,
               "pending": [ { "id":123, "kind":"review_comment", "author":"alice", "bot":false, "path":"src/a.ts", "line":12,
                              "bodyHead":"…(300자)", "url":"…", "at":"…" } ],   // ≤ 30(넘치면 오래된 것부터 버리고 overflow:n)
               "overflow": 0, "seenIds": [123] }
}
// Task.origin (optional): { "kind":"dispatch"|"automation", "planId"?:string, "automationId"?:string, "firingId"?:string, "depth":0|1|2 }
```
- `followup.ci.status='failing'` 은 **새 실패 감지 시 세팅**, `dismissedAt`(카드 [무시]) 또는 `fixOpId`(고치기 배달 완료) 로 해제(`status:null`). 헤드가 바뀌어 검사가 통과하면 `status:null`, `failed:[]`.
- `reviews.pending` 은 [고치기] 배달 시 비우고 `seenIds` 로 이동. [무시] 는 `dismissedAt` + 비우기.
- 클라 `needsInputReason` 확장(§8.1): `…keptDirty → ciFailed → reviewComments → opFailed`. 단 라이브 `working` 이면 group 은 `working`(§5.3 순서상 needs_input 판정이 먼저이므로 **`ciFailed/reviewComments` 두 사유는 `live.state==='working'` 일 때 무시**한다 — 에이전트가 이미 고치는 중).

### 4.3 `task.run.fix` / `task.run.followup.dismiss`
`task.run.fix {opId, taskId, runId, what:'ci'|'reviews'|'both'}` (op kind `fix`, 데드라인 3분) → `OpAccepted`. 전제: `what` 대상이 비어 있으면 `FOLLOWUP_NOTHING`; `RUN_BUSY`; `pr` 없으면 `PR_NOT_FOUND`.
1. 로그 수집(ci): `failed[]` 앞 3개, `runId` 있는 것만 `runLogFailed`; 없는 것은 이름+url 만.
2. 본문 조립(한국어 고정 문자열, i18n 안 함 — `serializeReviewComments` 규칙과 동일):
```
CI 실패 수정 요청 (PR #12)
실패한 검사: ci / lint — https://…
--- ci / lint 로그(마지막 200줄) ---
…
리뷰 코멘트 반영 요청 (PR #12)
- @alice src/a.ts:12: 여기서 null 체크가 빠졌어요
- @coderabbit (review, CHANGES_REQUESTED): …
위 내용을 반영해 고치고, 커밋·푸시까지 해 주세요. 원인을 모르겠으면 이유를 적고 멈추세요.
```
   총 ≤ 28000 UTF-8 바이트(초과 시 로그부터 자르고 `… (잘림)`).
3. 배달: `terminalAlive` 아니거나 `agentGone` 이면 먼저 `task.run.reopen` 본문(§2.6 `resumeArgs`)을 같은 op 안에서 수행 → `deliverPrompt`(`waitAgentReady` 16s + `chatInput submit:true`). 실패 → `lastOp {ok:false, code:'PROMPT_NOT_DELIVERED'}`(카드 [다시 시도]).
4. 성공 → `run.state review_ready→running`, `followup.ci.fixOpId/reviews.fixOpId=opId`, `pending→seenIds`, `lastOp.result {delivered:true, what, bytes, checks:n, comments:n}`, emit `run`. 다음 턴 종료가 다시 `review_ready`+`task_ready`(설계 §2.7 그대로).

`task.run.followup.dismiss {taskId, runId, what}` (동기 15s) → `{ok}`.

### 4.4 알림·이벤트·cap
| kind | title | subtitle | deeplink |
|---|---|---|---|
| `task_ci_failed` | `검사 실패 · {agent 표시명}` | `{repoSlug} · PR #{n}` | `codingpt://task/<taskId>?host=&run=` |
| `task_review_comments` | `리뷰 코멘트 {k}개 · {agent 표시명}` | `{repoSlug} · PR #{n}` | 같음 |
- 각 run 당 감지 1회(`detectedAt` 세팅 시). 같은 실패가 `pending` 상태로 남아 있는 동안 재알림 없음. 코멘트가 더 쌓이면 `pending` 만 늘고 알림은 `dismissedAt/fixOpId` 이후 첫 새 코멘트에만.
- 이벤트 `pr.ci_failed`/`pr.review_comments` 를 버스에 발행(자동화 트리거 §5.2).
- 두 메서드는 `TASK_RPC_OK` 에 추가(§7.1)되고 클라는 `hostCaps ∋ 'auto.v1'` 로 게이팅(§2.3).

---

## 5. F3 — 자동화 (automations)

### 5.1 모델 (`<stateDir>/automations.json` — `{v:1, savedAt, paused:false, items:[Automation]}`)
```jsonc
{ "id": "a_k3j9x2m1qa",            // "a_" + base36 10자
  "v": 1, "name": "매일 bug 이슈 정리",   // ≤ 80자. 봉인 경로에만(알림·ui_command 에 안 싣는다)
  "enabled": true, "paused": false, "pausedReason": null,   // 'user' | 'limit' | 'server' | 'error'
  "createdBy": { "kind":"agent"|"dispatch"|"user", "agent":"claude"|null, "tsession":"cpt-…--t-123"|null, "taskId":"t_…"|null, "planId":null, "deviceId":12, "at":1790000000000 },
  "trigger": Trigger, "actions": [Action],           // 1..5
  "guards": { "maxRunsPerDay": 10, "maxConcurrent": 1, "cooldownMs": 300000 },
  "state": { "nextRunAt": 1790030000000, "lastRunAt": null, "runsToday": 0, "dayKey": "2026-09-29",
             "inflight": 0, "cursor": { /* 트리거별 */ }, "consecutiveFailures": 0,
             "lastResult": { "firingId":"f_…", "ok":true, "code":null, "message":null, "at":…, "taskIds":["t_…"], "steps":[{"type":"task.create","ok":true,"taskId":"t_…"}] } },
  "createdAt": …, "updatedAt": … }

// Trigger
{ "type":"schedule", "cron":"0 9 * * 1-5", "tz":"Asia/Seoul", "missed":"once"|"skip" }        // 5필드 cron. * */n a-b a,b. 최소 간격 15분
{ "type":"schedule", "at": 1790100000000, "tz":"Asia/Seoul" }                                    // 일회 — 실행 후 enabled:false
{ "type":"git.commits", "repo":"work/codingpt", "branch":"main", "remote":"origin" }             // fetch 폴링 5분, cursor.sha
{ "type":"github.issues", "repo":"work/codingpt", "labels":["bug"], "state":"open" }             // gh 폴링 5분, cursor.sinceIso + seen ids
{ "type":"pr.ci_failed", "repo":"work/codingpt"|null }                                            // null = 이 PC 전체
{ "type":"pr.review_comments", "repo":… }
{ "type":"task.event", "event":"review_ready"|"merged"|"failed", "repo":… }

// Action (순서열 = 매크로. 각 단계 출력이 {prev.*} 로 다음 단계에)
{ "type":"task.create", "repo":"work/codingpt", "subdir":"", "base":null|"main", "agents":[{"id":"claude","count":1}], "title":"{issue.title}", "prompt":"이슈 #{issue.number} '{issue.title}' 를 처리해라.\n\n{issue.body}", "copyEnv":true }
{ "type":"terminal.prompt", "target": {"taskId":"t_…","runId":"r_…"} | {"event":true} | {"cwd":"work/codingpt","tid":1234567}, "text":"…{ci.failedLogs}…" }
{ "type":"notify", "title":"{repo.name}: 이슈 {issue.number} 작업 시작", "subtitle":"" }
```
- `AutomationDraft` = 위에서 `id/state/createdAt/updatedAt/createdBy` 를 뺀 것(`auto.create` 입력). `AutomationLite` = 전체(`actions[].prompt/text` 포함 — 봉인 경로).
- `terminal.prompt.target.event:true` = 트리거 이벤트의 run(pr.*/task.event 에서만 유효, 검증 시 `AUTO_BAD_ACTION`).

### 5.2 트리거 표 (포함/제외와 근거)
| 트리거 | 구현 | 근거 |
|---|---|---|
| `schedule` | `cron.js`(5필드, tz = `Intl.DateTimeFormat` 부품으로 로컬 시각 계산, 의존성 0). 30s 틱. `nextRunAt` 저장 | "매일 아침" 이 사용자 예시 |
| `git.commits` | 5분마다 `git fetch <remote> <branch>`(60s, `task-git` 접두 규칙, 저장소 락) → `cursor.sha` 와 `rev-parse <remote>/<branch>` 비교 → 새 커밋 `git log --format=%H%x00%s%x00%an <old>..<new>`(≤50) → 변수 `commits.*` | 원격 협업 흐름. **로컬 브랜치 이동은 안 본다**(사용자 체크아웃은 건드리지 않는다는 설계 원칙) |
| `github.issues` | 5분마다 `gh api repos/{o}/{r}/issues?state=open&since=<cursor>&labels=a,b&per_page=30 -q '[.[]|select(.pull_request==null)|{number,title,body,url:.html_url,labels:[.labels[].name],author:.user.login,at:.created_at}]'` → `seen` ids(최근 500) 제외 → 이슈 **1건당 1 firing** | 이슈 → 작업이 가장 흔한 자동화 |
| `pr.ci_failed`, `pr.review_comments` | 버스 이벤트(F2) | 동일 판정기 재사용 |
| `task.event` | 버스 이벤트. `origin.automationId===self.id` 인 작업은 무시(자기 유발 차단) | "리뷰 준비되면 알려줘/다음 단계 실행" |
| 파일 변경 감시 | **제외** | `fs.watch` 는 있으나 에디터 저장마다 폭주·디바운스 기준이 저장소마다 다름·에이전트 자신의 편집을 트리거로 되먹임. `git.commits` 가 안전한 상위 개념 |
| 터미널 출력 패턴 | **제외** | 화면 스크랩은 이미 "공식 채널로 대체" 결정(메모리 agent_status_official_channel). 패턴이 사용자 개인 출력을 상시 grep 하는 것이라 프라이버시·CPU 비용 대비 가치 낮음. 필요하면 에이전트가 `cpt notify` 로 직접 알린다 |
| webhook | **제외** | 서버가 내용을 받아야 한다(E2EE 원칙 위반). 폴링으로 충분 |

### 5.3 액션 · 매크로 · 안전 범위
- `task.create`: `tasks.internalCreate(params, origin)` 호출 — `origin={kind:'automation', automationId, firingId, depth}`. **worktree 작업만** 만들 수 있고 메인 체크아웃은 건드리지 않는다(tasks.js 가 보장). `TASK_LIMIT` 은 그대로 적용(초과 → firing 실패 `TASK_LIMIT`, 자동 재시도 없음).
- `terminal.prompt`: 대상 터미널에 `agentState.attachmentOf(tsession).attached` 가 참(에이전트가 붙어 있음)일 때만 `waitAgentReady`+`chatInput`. 라이브 `working` 이면 **건너뛴다**(`AGENT_BUSY` 결과, 재시도 없음 — 작업 중 끼어들기는 사람이 한다). 셸에는 절대 타이핑하지 않는다.
- `notify`: `backFetch POST /api/notifications {source:'agent', kind:'auto_notify', title(≤200), subtitle(≤300), deeplink:'codingpt://auto/<id>?host='}` — 사용자 정의 문구는 **사용자가 만든 자동화의 산물**이므로 평문 알림 허용(기존 `cpt notify` 와 같은 등급).
- **매크로 = `actions[]` 순서열**(최대 5, 분기·반복 없음). 단계 실패 시 중단(`steps[]` 에 기록). `{prev.taskId}`·`{prev.runId}` 로 이어짐(예: task.create → notify "작업 {prev.taskId} 시작").
- **임의 셸을 넣지 않는 이유**: 셸 한 줄은 `git push --force`·`rm -rf` 와 구분할 방법이 없고 sudoers 같은 허용 목록도 없다. 필요한 부작용은 전부 "작업을 만들어 에이전트가 승인 흐름 안에서 하게" 표현할 수 있다(에이전트의 Bash 는 기존 승인 카드가 지킨다).

### 5.4 템플릿 변수 (`template.js render(str, vars)` — `{a.b}` 정확 치환만, 표현식 없음, 미정의 → `""` + 감사 warn)
`{now}`(ISO, tz) `{repo.name}` `{repo.path}` `{branch}` · issues: `{issue.number} {issue.title} {issue.body}(≤4000B) {issue.url} {issue.labels}(쉼표) {issue.author}` · commits: `{commits.count} {commits.range} {commits.subjects}(줄바꿈) {commits.authors}` · pr: `{pr.number} {pr.url} {ci.failedChecks} {ci.failedLogs}(§4.3 규칙으로 잘림) {review.comments}(§4.3 줄 형식)` · task: `{task.id} {task.title} {run.id} {run.branch} {run.agent}` · `{prev.taskId} {prev.runId}` · `{auto.name}`. 렌더 결과가 30000B 를 넘으면 자르고 `… (잘림)`. `AUTO_TEMPLATE_TOO_LARGE` 는 **원본** 템플릿이 20000B 를 넘을 때(검증 시).

### 5.5 엔진 (`automations.js`)
- `start()`: 로드 → 각 항목 `state.nextRunAt` 재계산 → 놓친 스케줄 처리(아래) → `tick` 30s(`unref`) → 폴러 5분(`unref`, git/gh 각각 저장소당 직렬) → `events.on` 5종 구독. `stop()` 이 전부 clear.
- **실행 큐**: 전역 `Promise` 체인 1개(동시 firing 1 — PC 당) + 항목별 `inflight`. firing 1건 = 액션 순서 실행, 데드라인 5분.
- **가드 순서**(firing 시작 전, 하나라도 걸리면 감사 로그 + `lastResult{ok:false, code}` + 알림 없음): 전체 `paused`(킬스위치) → 서버 caps 에 `auto.v1` 없음(`serverCaps()` 가 비어 있지 않을 때만) → 항목 `paused/enabled` → `consecutiveFailures ≥ 5` 면 `paused=true, pausedReason:'error'` + 알림 `auto_paused` → `runsToday ≥ maxRunsPerDay`(dayKey 는 tz 기준 날짜) → `cooldownMs` 안이면 스킵 → `inflight ≥ maxConcurrent`.
- **루프 방지**: (1) `origin.depth`: 사용자/디스패치 작업 0, 자동화가 만든 작업 = 트리거 이벤트 작업의 depth+1(이벤트 없는 트리거는 1). depth > 2 → firing 실패 `AUTO_DEPTH`. (2) `task.event`/`pr.*` 트리거는 `origin.automationId === self.id` 인 작업의 이벤트를 무시. (3) `cpt auto create` 의 호출 터미널이 `origin.automationId` 가 있는 작업의 run 이면 `AUTO_LOOP`(§5.7). (4) 자동화가 만드는 작업의 프롬프트 뒤에 데몬이 한 줄을 붙인다: `(이 작업은 자동화 '{auto.name}' 가 만들었습니다. 새 자동화를 만들지 마세요.)` — 확률적 방어, 결정적 방어는 (3).
- **감사 로그** `automations.log`: firing 시작/단계/종료 마다 `{at, autoId, firingId, stage:'start'|'step'|'end'|'skip', type?, ok, code?, message?(≤200), taskId?}`. `auto.log` 가 꼬리를 돌려준다. 프롬프트 본문은 로그에 쓰지 않는다.
- **재시작·슬립**: `nextRunAt` 은 저장된 값. 기동/틱에서 `now - nextRunAt > 60s` 이면 "놓침": `missed==='once'`(기본) ∧ 24h 이내 → 즉시 1회 실행 후 다음 시각 계산; 24h 초과 또는 `skip` → 다음 시각으로 건너뜀 + 감사 `skip{code:'MISSED'}`. 폴링 트리거는 cursor 덕에 깨어난 뒤 자연히 따라잡는다(이슈 30개 이상 밀리면 per_page 상한으로 잘림 — 상한 안에서만). 데몬 재시작 중이던 firing 은 `inflight=0` 으로 리셋 + `lastResult{code:'OP_INTERRUPTED'}`.
- **상한 상수** `AUTO_LIMITS = {maxItems:30, maxActions:5, maxRunsPerDayDefault:10, maxRunsPerDayCap:50, maxConcurrentCap:2, minScheduleMs:900000, pollMs:300000, tickMs:30000, firingDeadlineMs:300000, templateMaxBytes:20000, nameMax:80}`.
- 멀티 PC: 자동화는 만든 PC 에 산다. `repo` 는 그 PC 홈-상대 경로. 다른 PC 로 옮기는 기능 없음(재생성).
- `activity.changed` 발행: firing inflight 변화마다(§6.3).

### 5.6 RPC `auto.*` (봉인 우선, 전부 15s)
| method | params | result |
|---|---|---|
| `auto.list` | `{}` | `{items: AutomationLite[], paused:bool, limits: AUTO_LIMITS, counts:{total, paused, attention}}` |
| `auto.get` | `{id}` | `{automation, log: LogLine[≤50]}` |
| `auto.validate` | `{draft}` | `{ok:true, normalized: AutomationDraft, nextRunAt, warnings:[…]}` / throw `AUTO_BAD_TRIGGER`·`AUTO_BAD_ACTION`·`AUTO_TEMPLATE_TOO_LARGE`·`NOT_A_REPO`·`AGENT_NOT_INSTALLED` |
| `auto.create` | `{opId, draft, createdBy?}` | `{automation}` (동기 — 저장만. opId 멱등 최근 50). `createdBy` 는 **소켓 경로가 채운다**(§5.7); 릴레이 경로는 `{kind:'user'|'dispatch', deviceId, planId?}` 만 허용 |
| `auto.update` | `{id, patch:{name?, trigger?, actions?, guards?, enabled?}}` | `{automation}` (validate 재실행, `nextRunAt` 재계산) |
| `auto.remove` | `{id}` | `{ok}` |
| `auto.pause` / `auto.resume` | `{id}` | `{automation}` (`pausedReason:'user'`/null, resume 은 `consecutiveFailures=0`) |
| `auto.pauseAll` | `{paused:bool}` | `{paused}` — 킬스위치 |
| `auto.runNow` | `{opId, id, dryRun?}` | `{accepted:true, firingId}` → 가드 중 **하루 상한만** 무시하고 큐에 넣는다. 결과는 `state.lastResult` + `automations.changed reason:'result'`. `dryRun` 은 트리거 표본(최근 cursor 값)으로 템플릿만 렌더해 `{rendered:[…]}` 즉시 회신 |
| `auto.log` | `{id?, limit?=100}` | `{lines: LogLine[]}` |
`ui_command automations.changed {host, ids:[…], reason:'created'|'updated'|'removed'|'fired'|'result'|'paused'}`.
에러: `AUTO_DISABLED, AUTO_NOT_FOUND, AUTO_LIMIT, AUTO_LOOP, AUTO_DEPTH, AUTO_BAD_TRIGGER, AUTO_BAD_ACTION, AUTO_TEMPLATE_TOO_LARGE, AUTO_PAUSED, AUTO_RATE_LIMITED, AUTO_BUSY(firing 중 update/remove)`.

### 5.7 `cpt auto` (에이전트 표면) + 스킬
```
cpt auto list [--json]                 이 PC 의 자동화(이름·트리거·다음 실행·마지막 결과)
cpt auto get <id> [--json]
cpt auto create --file <spec.json> | -  (stdin JSON = AutomationDraft) [--dry-run]   → id 출력. --dry-run = auto.validate 만
cpt auto update <id> --file <patch.json>
cpt auto remove|pause|resume|run <id>
cpt auto log [<id>] [--limit n]
cpt auto schema                        Draft JSON 스키마 + 예시 3개(GUIDE.md 의 §7 을 그대로 출력)
```
- 소켓 경로 `createdBy` 결정: `resolveCtx` 결과 `tmux.session` 이 `cpt-` 접두 **이고** `CPT_WS`(ctx.ws 문자열) 가 있을 때만 `kind:'agent'`(`agent` 는 `agentWatch.titleAgent`/agent-state 의 그 tsession 에이전트, 모르면 null). CWD 폴백으로 게이트를 통과한 호출(열린 워크스페이스 폴더의 일반 셸)은 `AUTO_OUT_OF_TERMINAL` 거부 — 자동화 생성은 **CodingPT 터미널 안**에서만. 그 tsession 이 작업 run 이고 그 작업 `origin.automationId` 가 있으면 `AUTO_LOOP`.
- 생성 성공 시 알림 `auto_created`(§5.8) — `kind:'agent'` 일 때만(dispatch/user 는 사용자가 직접 눌렀다).
- GUIDE.md `## 7. 자동화(cpt auto)`: 언제 만드나("사용자가 '매일/매주/…마다/…하면/자동으로/알림 설정' 처럼 반복·조건을 말하면 작업 대신 또는 작업과 함께 자동화를 만든다. 만든 뒤 사용자에게 id 와 요약을 한 줄로 알린다. 확신이 없으면 만들지 말고 물어라"), 스키마·변수 표·예시 3개(매일 이슈 정리 / 커밋마다 테스트 작업 / CI 실패 시 알림만), 금지("자동화 안에서 자동화를 만들지 않는다 · 하루 10회 상한 · 셸 실행 없음"). `HELP` 문자열에 `# 자동화` 절. SKILL.md description 트리거 구문 추가: `"매일", "자동으로", "반복해서", "…할 때마다", "알림 설정", "automate", "every day", "whenever"`. 자기-스코핑 문장 유지.

### 5.8 알림
| kind | title | subtitle | deeplink | 조건 |
|---|---|---|---|---|
| `auto_created` | `자동화 생성 · {agent 표시명}` | `{triggerLabel}`(§11 `trig*` 한국어 원문: "매일 일정"/"새 커밋"/"새 이슈"/"검사 실패"/"리뷰 코멘트"/"작업 이벤트") | `codingpt://auto/<id>?host=` | 에이전트 생성 시 |
| `auto_failed` | `자동화 실패` | `{triggerLabel} · {FAIL 한국어}` | 같음 | firing 실패(연속 실패 5회째는 `auto_paused`) |
| `auto_paused` | `자동화 일시정지` | `연속 실패 5회` | 같음 | |
| `auto_notify` | 사용자 템플릿 | 사용자 템플릿 | 같음 | `notify` 액션 |
이름은 싣지 않는다(봉인 경로에서만). 작업이 만들어졌음은 별도 알림 없음(그 작업의 `task_ready` 가 온다).

### 5.9 UI — `자동화` 장소
**사이드바(PC `sidebar.js`, 앱 `SidebarContent.tsx`)**: 개정 1 블록에서 `tasksRow()` 바로 아래 `autoRow()` / `<AutoRow/>`.
```
│ MacBook Pro                  │  .sb-sec-dev
│ ☑ 진행 현황               [2]│  .pc-row.tasks-row
│ ⟳ 자동화                  [1]│  .pc-row.auto-row   (배지 = attention 수: 실패/일시정지(error) · 없으면 배지 없음)
```
- 아이콘 SVG `icons.repeat`(PC 신설, Feather repeat: `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`) / 앱 phosphor `ArrowsClockwise`.
- 장소 규칙: `state.view='automations'`(PC) / `automationsUi.open`(앱). 열면 상대 장소를 닫는다: PC `openAutomations()` 는 `S.setView('automations')`, `openTasksDashboard` 와 로컬 행 클릭은 그대로(`setView` 가 덮는다). 앱 `openAutomations()` 가 `closeTasksDashboard()` 를, `openTasksDashboard()` 가 `closeAutomations()` 를, `openWs`·PC 행 onPress 가 둘 다 호출. 하드웨어 back: `AppBackHandler` 에 `handleAutomationsBack()` 을 `handleTasksBack()` 다음 줄에.
- `sbSig` 에 `autoN`(attention 수)·`view` 포함(view 는 이미 있음). `hostCaps ∌ 'auto.v1'` 인 PC 는 행을 **그리되** 클릭 시 `pcNeedsUpdate` 토스트.

**목록(PC `automations-view.js` `#automationsView` / 앱 `AutomationsHost.tsx` — TasksDashboardHost 형제 층, 같은 헤더 규칙)**:
```
┌ 자동화 · MacBook Pro                     [전체 일시정지 ◯] [새로고침] ┐
│ ● 매일 bug 이슈 정리                 09:00 매일 (Asia/Seoul)          │  .au-row  (점: error=실패/일시정지, spin=실행 중, none)
│    [c] Claude 가 만듦 · 다음 실행 14시간 뒤 · 마지막: 작업 3개 생성   │  .au-sub
│    [지금 실행] [일시정지] [삭제]                                       │  .au-acts (hover/롱프레스 메뉴 대신 항상 노출 — 폰은 스와이프 없음)
│ ○ main 커밋마다 테스트                 새 커밋 · origin/main         │
│    한 줄 지시로 만듦 · 마지막: 5분 전 성공                            │
│ ▸ 일시정지됨 (1)                                                     │  기본 접힘 그룹
└──────────────────────────────────────────────────────────────────────┘
```
- 행 클릭 → 상세(PC ≥1100 우측 패널 / 폰 인모달 push): 이름(탭하면 인라인 편집 → `auto.update {name}`)·트리거 카드(사람 문장 = `automationsModel.triggerLabel`)·액션 목록(단계 번호 + 유형 + 대상 + 템플릿 접힘)·가드·상태(다음/마지막/오늘 n/10)·감사 로그 꼬리 50줄(모노, 시각+stage+code)·[지금 실행][일시정지/재개][삭제(확인)].
- 빈 상태: `autoEmpty` + `autoEmptyHint`("한 줄 지시에서 '매일 …' 처럼 말하거나, 에이전트에게 부탁하면 만들어져요") + [한 줄 지시].
- 전체 일시정지 토글은 error 색이 아니라 무채색 Toggle + 켜지면 헤더 아래 배너 `autoPausedAll`.
- 작업 카드/사이드바 작업 행: `task.origin?.kind==='automation'` 이면 제목 앞 칩 `자동`(`.wsg-fan` 지표, 앱 `Chip`), 클릭 → `openAutomations({id: origin.automationId, host})`.
- 폴링: 열려 있는 동안 60s `auto.list`; `automations.changed` 수신 즉시(호스트 일치); `runner_status online` 전이.
- 팔레트: `automations.open`(PC `Mod+Shift+U`, app), `dispatch.open`(PC `Mod+Shift+I`, app). 충돌 시 `Mod+Alt+U/I`(commands.js 주석). 라벨 §11.

---

## 6. F4 — PC 깨어 있기 (power)

### 6.1 두 층
| 층 | 수단 | 권한 | 막는 것 | 못 막는 것 |
|---|---|---|---|---|
| A | `/usr/bin/caffeinate -i -s`(자식 프로세스, 활성 중만) | 없음 | 유휴 잠자기(-i), AC 에서 시스템 잠자기(-s) | 덮개 닫힘(클램셸), 배터리 부족 강제 잠자기 |
| B | `sudo -n /usr/bin/pmset -a disablesleep 1` | root(sudoers.d 1회 설정) | 덮개 닫힘 포함 모든 잠자기 | 배터리 소진·과열 보호 |
- B 는 **AC 전원일 때만** 켠다(`pmset -g batt` 첫 줄에 `AC Power`). 배터리면 `state.lidBlocked:'battery'` 로 표시만.
- 대안 검토: IOKit `IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep)` 는 caffeinate 와 동급(클램셸 불가) · `pmset -a sleep 0` 도 root 이며 클램셸을 못 막음 · SMJobBless 특권 헬퍼는 서명·번들 구조 변경이 커서 기각 · `disablesleep` 은 문서화되지 않았지만 macOS 10.x~26 에서 유지되는 유일한 클램셸 우회. sudoers.d 한 줄이 가장 좁은 권한.

### 6.2 1회 설정 `power.setup {remove?:false}` (비동기, 결과는 `power.status.setup`)
1. 전제: darwin, `os.userInfo().username` 이 `/^[a-z_][a-z0-9_-]{0,31}$/`(아니면 `POWER_SETUP_FAILED`), GUI 세션(`launchctl managername` 이 `Aqua` — 아니면 `POWER_NO_GUI`, 안내 "PC 앱에서 설정하세요").
2. 데몬이 임시 파일(0600) 에 sudoers 내용을 쓴다:
   ```
   # CodingPT keep-awake (lid closed). Removable via CodingPT settings.
   <user> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0
   ```
3. `osascript -e 'do shell script "<script>" with administrator privileges with prompt "CodingPT: 덮개를 닫아도 작업을 계속하도록 설정합니다"'` — `<script>` = `/usr/sbin/visudo -c -f <tmp> && /usr/bin/install -o root -g wheel -m 0440 <tmp> /etc/sudoers.d/codingpt-pmset`(제거 시 `rm -f`). 경로는 데몬이 만든 것(공백 없음), 사용자 입력 0. **암호는 macOS 다이얼로그에 사용자가 직접** 입력한다. 데몬 데드라인 180s. 취소(exit 1, `User canceled`) → `POWER_SETUP_CANCELLED`.
4. 검증: `sudo -n /usr/bin/pmset -a disablesleep 0` exit 0 → `power.json.setupAt=now`, `status.setup='done'`. 실패 → `POWER_SETUP_FAILED`.
5. 폰에서 원격 PC 에 요청하면 다이얼로그는 **PC 화면**에 뜬다 — 클라는 `setupRemoteHint` 를 먼저 보여준다.

### 6.3 데몬 상태기계 (`power.js`)
```jsonc
// <stateDir>/power.json
{ "v":1, "keepAwake": false, "lidClosed": false, "setupAt": null, "weSetDisableSleep": false, "caffeinatePid": null, "updatedAt": … }
// power.status 결과
{ "supported": true, "keepAwake": false, "lidClosed": false, "setup": "none"|"pending"|"done"|"failed", "setupError": null,
  "active": false, "reasons": ["task:t_…", "automation:a_…", "dispatch:p_…"], "layers": { "caffeinate": false, "disableSleep": false },
  "power": "ac"|"battery"|"unknown", "lidBlocked": null|"battery"|"setup"|"sudo", "lastError": null, "since": … }
```
- `isWorkActive()` = 살아 있는 run 중 라이브 `working`(`agentState.rawStateOf`) 또는 `run.op` 존재 또는 `run.state ∈ {creating, launching, merging}` ‖ 자동화 `inflight>0` ‖ 플래너 실행 중. 계산 트리거: 버스 `activity.changed`(automations/dispatch 가 발행), `agentState.subscribe`, tasks `notify` 후크, 30s 틱.
- 히스테리시스: 활성 전이 즉시, 비활성 전이는 **120s 연속 유휴**(`POWER_IDLE_MS`) 뒤.
- 활성 & `keepAwake` → A 층 spawn(이미 살아 있으면 유지). 활성 & `lidClosed` & setup done & AC → B 층 `disablesleep 1` + `weSetDisableSleep=true`. 비활성 → A kill(SIGTERM), B `disablesleep 0` + `weSetDisableSleep=false`. 어느 단계든 실패는 `lastError` + `power.changed`(다음 틱 재시도, 알림 없음).
- 종료: `process.on('exit'|'SIGTERM'|'SIGINT'|'SIGHUP')` 에서 동기적으로 A kill + `spawnSync sudo -n pmset disablesleep 0`(B 를 켰을 때만).
- 기동 복구: `power.json.caffeinatePid` 가 살아 있고 `ps -o comm= -p` 가 `caffeinate` 면 kill. `pmset -g | SleepDisabled` 가 `1` 이고 `weSetDisableSleep` 이면 0 으로 복구; `1` 인데 우리가 켠 게 아니면 **건드리지 않고** `lastError:'FOREIGN_DISABLESLEEP'`(사용자가 직접 켠 설정 존중).
- `runner_busy` 프레임: `isWorkActive()` 또는 `layers` 가 바뀔 때 `sendControl({type:'runner_busy', busy, awake, at})`(10s 스로틀) + `hello` 에도 `busy, awake` 동봉(control.js `helloFrame` 추가 전용).

### 6.4 RPC `power.*` (15s)
`power.status {}` → 위 · `power.set {keepAwake?, lidClosed?}` → `{status}`(즉시 재평가; `lidClosed:true` 인데 setup 아니면 저장은 하되 `lidBlocked:'setup'`) · `power.setup {remove?}` → `{accepted:true}` · `power.event {kind:'willSleep'|'didWake'}`(**로컬 소켓 전용**, 릴레이/봉인 경로는 `BAD_PARAMS`) → `{ok}`. `ui_command power.changed {host}`.
에러: `POWER_DISABLED, POWER_UNSUPPORTED, POWER_SETUP_REQUIRED, POWER_SUDO_MISSING(sudo -n 실패 = 규칙이 사라짐), POWER_NO_GUI, POWER_SETUP_CANCELLED, POWER_SETUP_FAILED`.

### 6.5 잠자기 알림 · 끊김 푸시
- **PC 앱(Tauri)**: `src-tauri/src/power.rs` — `NSWorkspace.sharedWorkspace().notificationCenter()` 에 `NSWorkspaceWillSleepNotification`/`NSWorkspaceDidWakeNotification` 옵저버(objc2-app-kit `NSWorkspace` feature + `block2`). 콜백 → `app.emit("cpt-power", {kind})`. JS `ui-channel.js wirePower()`: `willSleep` → `api.powerLocal('power.event', {kind:'willSleep'})`; `didWake` → 같은 호출 + `refreshAll()`(tasks/automations/caps).
- 데몬 `power.event willSleep`: `isWorkActive()` 면 `POST /api/notifications {source:'system', kind:'pc_sleeping', title:'PC 가 잠자기에 들어가요', subtitle:'{deviceName} · 작업 {n}개 진행 중', deeplink:'codingpt://tasks?host=<id>', pushGate:'ignore-pc-active', push:{data:{hostDeviceId}}}` — macOS 가 주는 시간은 수 초라 best effort(실패 무시). `keepAwake` 가 켜져 있었는데 잠든다는 건 배터리/강제 — 문구는 같다.
- **back**(§7.2): 데몬 `runner_busy` 로 `conn.busy/awake` 유지. `cleanup` 에서 `conn.busy && !updating` 이면 `armBusyDisconnect(userId, deviceId, deviceName)`: `setTimeout(BUSY_DISCONNECT_GRACE_MS=90000)`; `registerControl` 같은 deviceId 재접속이 취소. 발화 시 `createNotification(userId, {source:'system', kind:'pc_disconnected', title:'PC 연결이 끊겼어요', subtitle:'{deviceName} · 작업이 진행 중이었어요', deeplink:'codingpt://tasks?host=<id>', pushGate:'ignore-pc-active', push:{data:{hostDeviceId}}})`. 서버는 불리언 2개·기기 이름만 안다. 기기당 끊김 1회.

### 6.6 설정 UI · 상태 표시 · 주의 문구
**PC `settings.js` `system` 섹션** 새 카드(`sm-card2`, `sett-row` 패턴, get/set 은 `power-settings.js` 모듈):
```
PC 깨어 있기
[○] 작업 중에는 잠자기 방지            에이전트가 작업하는 동안 PC 가 잠들지 않아요      (keepAwake → power.set)
[○] 덮개를 닫아도 계속 작업              관리자 암호로 1회 설정이 필요해요  [설정하기] / 설정됨 · [해제]   (lidClosed; 미설정이면 토글 눌렀을 때 설정 흐름 먼저)
    지금: 깨어 있음 · 작업 2개 · 전원 어댑터                                (power.status 30s 폴링 + power.changed)
    주의: 덮개를 닫은 채 계속 실행하면 발열이 늘고 배터리가 빨리 닳아요. 전원 어댑터를 연결하고 통풍이 되는 곳에 두세요. 배터리 전원에서는 덮개 닫힘 유지가 꺼져요.
```
**앱**: 새 `PcSettingsSheet.tsx`(바텀시트, `ui/Toggle` 재사용) — PC 행 ⋯ 메뉴 `PC 설정`(`pcMenu` 에 항목 추가) + 자동화/진행 현황 헤더 PC 이름 탭. 내용은 PC 카드와 같고 `hostCaps ∌ 'power.v1'` 면 `pcNeedsUpdate`, 비 macOS 면 `powerUnsupported`. [설정하기] 는 `setupRemoteHint` 확인 뒤 `power.setup`.
**상태 표시**: `runner_status.awake===true` 인 PC 행 뒤에 `icons.sun({size:12})`(PC) / phosphor `Sun 12`(앱) `--dim`, title/accessibilityLabel `awakeNow`. 진행 현황 헤더 PC 이름 옆 같은 글리프.

---

## 7. back 변경 (S3)

### 7.1 라우트·allow-list·caps
```js
// controllers/daemonController.js
const AUTO_RPC_OK = new Map([
  ['auto.list',15000],['auto.get',15000],['auto.validate',15000],['auto.create',15000],['auto.update',15000],['auto.remove',15000],
  ['auto.pause',15000],['auto.resume',15000],['auto.pauseAll',15000],['auto.runNow',15000],['auto.log',15000],
  ['dispatch.catalog',30000],['dispatch.plan',15000],['dispatch.get',15000],
  ['power.status',15000],['power.set',15000],['power.setup',15000],
]);
// TASK_RPC_OK 추가 2줄
['task.run.fix',15000], ['task.run.followup.dismiss',15000],
// autoRpc = taskRpc 복제: 킬스위치는 method 접두별 cap(auto→auto.v1, dispatch→dispatch.v1, power→power.v1) 없으면 403 {code:'<FAM>_DISABLED'};
// 미허용 400; DAEMON_OFFLINE 409; 타임아웃 TIMEOUT; 그 외 e.code || 'AUTO_ERROR'. export _AUTO_RPC_OK
// routes/daemonRoutes.js: router.post('/auto', accountAuth, daemonController.autoRpc);  (/task 다음 줄)
// config/caps.js: DISPATCH_ENABLED→'dispatch.v1', AUTOMATIONS_ENABLED→'auto.v1', POWER_ENABLED→'power.v1' (envOff 규칙, 헤더 주석 3항목)
```
`power.event` 는 allow-list 에 **없다**(로컬 전용). 봉인 경로(`/api/daemon/rpc`)는 무수정 — 데몬이 `power.event` 를 봉인 경로에서 거부한다(§6.4).

### 7.2 릴레이 (`daemonRelayService.js`)
- `registerControl` conn 필드 추가: `busy:false, awake:false, busyAt:0`. `hello` 에서 `busy/awake` 읽기(불리언 강제). 새 `case 'runner_busy'`: `conn.busy=!!msg.busy; conn.awake=!!msg.awake; conn.busyAt=now` → `fanoutRunnerStatus(userId, {deviceId, online:true, kind, deviceName, busy, awake})`(10s 안 중복은 마지막 값만).
- `listRunners`·`replayRunnerStatus` 에 `busy, awake` 동봉.
- `cleanup` 5단계 뒤: `if (conn.busy && !upd) armBusyDisconnect(userId, conn.deviceId, conn.deviceName)`. `registerControl` 첫 줄: `clearBusyDisconnect(userId, deviceId)`. 타이머 맵 `busyTimers: Map<'<userId>|<deviceId>', Timeout>`(approvalService `hostSweepTimers` 패턴). 발화 시 `require('./notificationService').createNotification(...)`(lazy require — 순환).
- `agentStateLast` 는 무수정.

### 7.3 알림 (`notificationService.js`) 무수정. 새 kind 들은 whitelist 가 없어 그대로 통과. `SUBTITLE_SUFFIX` 추가 없음(데몬/서버가 subtitle 을 직접 준다).

### 7.4 테스트 `test/auto-route.test.js`: `_AUTO_RPC_OK` 표 deep-equal · 미허용 400 · 킬스위치별 403 code · `computeServerCaps({AUTOMATIONS_ENABLED:'0'})` 에 `auto.v1` 없음(3종). `test/relay-busy.test.js`: `runner_busy` → `runner_status` 에 `busy/awake` · 끊김 뒤 `mock.timers` 90s 에 `createNotification` 1회 · 89s 재접속이면 0회 · `reason:'updating'` 이면 0회.

---

## 8. 공유 순수 모델 + 픽스처 (`docs/fixtures/automation/`)

### 8.1 `tasksModel` 확장 (PC `tasks-model.js` / 앱 `tasksModel.ts` — S4/S5 각자, 픽스처 S6)
- `NeedsInputReason` += `'ciFailed' | 'reviewComments'`. `needsInputReason(row)` 순서: `… → keptDirty → (live.state!=='working' && run.followup?.ci?.status==='failing' && !run.followup.ci.dismissedAt) → ciFailed → (live.state!=='working' && run.followup?.reviews?.pending?.length>0 && !…dismissedAt) → reviewComments → opFailed`.
- `waitSince` = `followup.ci.detectedAt` / `reviews.detectedAt`. 카드 dot: `ciFailed` → error, `reviewComments` → warn. 카드 문구 §11 `ciFailedLine {n}`·`reviewCommentsLine {n}`. 카드 액션: `[고치기]`(`task.run.fix what`) `[무시]`(`dismiss`) `[PR 열기]` `[터미널 열기]`. `hostCaps ∌ 'auto.v1'` 면 `[고치기]` 대신 `[PR 열기]` 만.
- `TaskRow.task.origin` 통과(칩용).
- 픽스처: `model-12-followup-ci.json`(ci failing → needs_input/ciFailed; dismissed → review_ready; live working → working), `model-13-followup-reviews.json`(pending 2 → reviewComments; ci 와 동시면 ciFailed 우선; `keptDirty` 가 둘보다 우선). `test/tasks-crossimpl.mjs` 의 `model-\d+` glob 이 자동으로 집는다(≥10 조건 유지). 앱 `listFixtures('model-')` 동일.

### 8.2 신규 `automationsModel` (PC `automations-model.js` / 앱 `automationsModel.ts`)
```ts
type AutoInput  = { now:number, tz?:string, items: AutomationLite[], paused:boolean, hostOnline:boolean };
type AutoRow    = { id, name, creator:'agent'|'dispatch'|'user', creatorAgent:string|null, triggerKey:'trigSchedule'|'trigOnce'|'trigCommits'|'trigIssues'|'trigCi'|'trigReviews'|'trigTaskEvent',
                    triggerVars:{cron?, tz?, branch?, repo?, labels?, event?}, dot:'error'|'spin'|'none', attention:boolean, group:'active'|'paused',
                    nextRunAt:number|null, lastOk:boolean|null, lastAt:number|null, lastCode:string|null, taskIds:string[], runsToday:number, maxRunsPerDay:number, sortAt:number };
type AutoOutput = { rows: AutoRow[], groups:{active:AutoRow[], paused:AutoRow[]}, counts:{total, paused, attention} };
```
- `attention` = `pausedReason ∈ {'error','limit'}` ‖ `lastResult?.ok===false` ‖ `consecutiveFailures>0`. `dot`: attention → error, `inflight>0` → spin, 그 외 none. `group` = `paused||!enabled` → paused.
- 정렬: active = attention 먼저 → `nextRunAt` 오름(없으면 뒤) → `name` 코드포인트. paused = `updatedAt` 내림.
- `summarizeAuto(out)` → `{rows:[{id, group, dot, attention, triggerKey}], counts}`. 픽스처 `auto-01-list.json`(스케줄/일회/커밋/이슈/이벤트 5종 + 실패 1 + 일시정지 1 + inflight 1), `auto-02-empty.json`.
- 트리거 문장은 **클라가 `tt(triggerKey, triggerVars)` 로 그린다**(cron 은 원문 그대로 `trigSchedule {cron} ({tz})` — cron 을 사람 문장으로 푸는 것은 비목표).

### 8.3 rpc 픽스처(데몬 슬라이스 소유, `test/task-contract.test.js` 가 필드 화이트리스트와 대조)
`rpc-auto.list.json`, `rpc-auto.get.json`, `rpc-auto.validate.json`, `rpc-dispatch.catalog.json`, `rpc-dispatch.get.json`(done/fallback/planning 3개), `rpc-power.status.json`, `rpc-task.run.fix.json`(OpAccepted + lastOp.result), `rpc-errors-automation.json`(§3.6·§5.6·§6.4·§4.3 코드 전체 집합). 기존 `rpc-task.get.json` 에 `followup`·`origin` 샘플 추가(S2).
`dispatch-fallback-01.json`(`planFallback` 입력/기대 — 이름 정확·topDirs subdir·README 토큰·단일 워크스페이스·미매칭 null), `cron-01.json`(표현식 → 다음 5회 시각, tz 2종·DST 경계 1개), `template-01.json`(변수 치환·미정의·잘림). 셋 다 데몬 단위 테스트가 읽는다(S1/S2).

---

## 9. 테스트 계획

### 9.1 데몬 (`npm test`, node:test — tasks.test.js 격리 규약 그대로: 임시 HOME·`runtime.init`·`CODINGPT_TMUX_SOCKET` 전용·가짜 bin)
- `cron.test.js`: cron-01 픽스처, 최소 간격 거부, `at` 일회, 잘못된 필드 `AUTO_BAD_TRIGGER`.
- `template.test.js`: template-01, 30000B 잘림, 원본 20000B 초과 거부.
- `automations.test.js`: 가짜 시계(`now` 주입)로 스케줄 firing → `tasks.internalCreate` 스텁 호출·`origin.depth` · 하루 상한/쿨다운/동시 1 · 연속 실패 5회 → paused + `auto_paused` 알림 1회 · 놓친 스케줄 once/skip/24h · `task.event` 자기 유발 무시 · depth 3 거부 · `pauseAll` · `runNow` 가 상한 무시 · 감사 로그 회전 · 재시작 시 inflight 리셋 · 소켓 경로 `createdBy.kind:'agent'` 판정과 `AUTO_OUT_OF_TERMINAL`/`AUTO_LOOP` · `cpt auto create -` stdin 왕복(가짜 소켓, tasks.test.js:925 방식).
- `followup.test.js`: 가짜 `gh`(`pr view` JSON 픽스처·`api …/comments`·`run view --log-failed` 고정 출력, `--repo` assert) → 새 실패 1회 감지·같은 `name@sha` 재감지 없음·헤드 변경 시 재감지·코멘트 cursor/seenIds·`task.run.fix` 본문 조립(28000B 잘림·한국어 고정 문자열)·`agentGone` 이면 reopen 선행·배달 후 `running`·이벤트 발행·백그라운드 틱이 open PR 만 본다.
- `dispatch.test.js`: 가짜 `claude` 셸 스크립트(stdin 을 읽고 고정 JSON 출력 / `--tools ""` 인자 assert / exit 1 케이스 / 무응답 케이스로 타임아웃) → cli 모드·폴백 모드·`BAD_PLAN` 항목 제거·카탈로그 잘림·opId 멱등·planId 24h 만료. `planFallback` 픽스처.
- `power.test.js`: `exec` 주입 스텁으로 활성/비활성 전이·120s 히스테리시스·AC/배터리 분기·기동 복구(우리 것만 0)·종료 훅·`runner_busy` 스로틀. 실제 `caffeinate`/`sudo` 는 호출하지 않는다.
- `automation-e2e.test.js`(**헤드리스 E2E, in-process**): cpt-server 를 임시 stateDir 로 띄우고(이 Mac 의 라이브 데몬은 **추가 기동 금지** — 별도 프로세스가 아니라 테스트 프로세스 안에서, 전용 tmux 소켓) 로컬 소켓 NDJSON 으로 `auto.create`(github.issues, 가짜 gh 가 이슈 2개) → 폴러 강제 틱 → `task.list` 에 origin 있는 작업 2개 → 그 run 터미널의 tsession 으로 `cpt auto create` → `AUTO_LOOP` → `auto.pauseAll` → 틱 → 0건. 끝에 `srv.close` 필수.

### 9.2 back: §7.4.

### 9.3 PC (`npm test` 체인에 `automations-crossimpl`, `dispatch-ui`, `power-settings` 추가)
- `automations-crossimpl.mjs`: auto-01/02 픽스처 → PC/앱 모델 동일 출력 · 소스 계약 핀: `autoRow()` 가 `tt("automations")` · ui-channel `automations.changed`/`dispatch.changed`/`power.changed` 핸들러가 `{ok:true}` · `cptsock.rs` 에 `auto_local`(`auto.`/`dispatch.`/`power.` 펜스, `spawn_blocking`, 35s) · `lib.rs` 등록 · `power.event` 는 `power_local` 로만.
- `tasks-crossimpl.mjs`: model-12/13 자동 포함 + `ERROR_KEY` 에 새 코드 전부.
- `i18n-crossimpl.mjs`: `AUTO_TEXT.ko`·`TASKS_TEXT.ko` 신규 원문이 7개 PC 카탈로그에 존재.
- `palette-crossimpl.mjs`: `automations.open`, `dispatch.open` 양쪽 표 정합.

### 9.4 앱 (`jest`, `tsc --noEmit`): `automationsModel.test.ts`(픽스처), `tasksModel.test.ts`(자동 포함), `automationService.test.ts`(폴백 규칙 = taskService 와 동일), `dispatchFlow.test.tsx`(카탈로그 2대 중 1대 실패 → 카드에 실패 줄·폴백 pill), `pcSettingsSheet.test.tsx`(caps 없음/비 macOS/setup 흐름 문구), `autoDeeplink.test.ts`(`codingpt://auto/`, `codingpt://tasks?host=`), `AppBackHandler` 순서(드로어 → 시트 → tasks → automations).

### 9.5 실기 E2E 체크리스트 (완료 보고 전 필수)
**Mac PC 앱**
1. 한 줄 지시: PC 2대 온라인(하나는 카탈로그 일부러 실패시킴) → 카드에 실패 줄 + 플랜. claude 로그아웃 상태에서 `codex` 로 계획됨(planner.agent). 셋 다 로그아웃 → `간단 매칭` pill. [시작] → 작업 생성 + 자동화 생성, 진행 현황·자동화 장소에 각각 보임.
2. PR 후속(일회용 리포 `cpt-tasks-e2e`, 설계 §7.5): 일부러 실패하는 workflow 커밋 → 3분 안에 카드 "검사 실패" + 푸시 1건 → [고치기] → `tmux capture-pane` 으로 로그가 에이전트 입력으로 들어감(셸 아님) → 작업 중 → 리뷰 준비. 리뷰 코멘트 2개 달기 → 카드 `리뷰 코멘트 2개` → [무시] 로 사라짐, 재알림 없음.
3. 자동화: 에이전트 터미널에서 "이 리포는 커밋될 때마다 테스트 작업 만들어줘" → 에이전트가 `cpt auto create` → `auto_created` 알림 → 목록 행 → 상세. 원격 `git push` → 5분 안에 작업 생성 + 카드 `자동` 칩. 그 작업 터미널에서 `cpt auto create` → `AUTO_LOOP`. 일반 셸(CPT_WS 없음) → `OUT_OF_CONTEXT`. 전체 일시정지 → 커밋해도 0건. 앱 재시작(데몬 재시작) 뒤 `nextRunAt` 유지, 놓친 스케줄 1회 실행.
4. 깨어 있기: 토글 on + 작업 실행 → `pmset -g assertions` 에 caffeinate → 2분 유휴 뒤 사라짐. [설정하기] → macOS 암호 다이얼로그(우리는 입력하지 않는다 — 사용자) → `/etc/sudoers.d/codingpt-pmset` 0440, `visudo -c` OK → 작업 중 `pmset -g | grep SleepDisabled` = 1, 덮개 닫고 5분 뒤 폰에서 터미널이 살아 있음 → 유휴 뒤 0. 배터리 전원에선 1 이 안 됨. 데몬 `kill -9` 뒤 재기동 시 0 복구. PC 앱 종료 시 0.
5. 잠자기 알림: 작업 중 Apple 메뉴 잠자기 → 폰에 `pc_sleeping`(best effort, 실측 기록). 작업 중 Wi-Fi 끊기 → 90초 뒤 `pc_disconnected` 1건, 60초 안 재접속이면 0건.
**Android(에뮬 + 실기) / iOS(시뮬)**
6. 드로어 `자동화` 행 → 장소(헤더 PC 이름) → 상세 → 하드웨어 back/가장자리 스와이프로 목록 → 워크스페이스. 진행 현황과 배타. 한 줄 지시 시트(받아쓰기 1회) → 카드 조정 → 시작. PR 카드 [고치기]. PC 설정 시트 토글이 PC 값과 동기(PC 에서 바꾸면 `power.changed` 로 갱신). 푸시 3종(`task_ci_failed`, `auto_created`, `pc_disconnected`) 탭 → 올바른 장소. `xcrun simctl openurl booted 'codingpt://auto/<id>?host=1'`.
7. 7개 언어 전환 시 새 문구 누락 0(`i18n-guard`). 다크/라이트.
8. E2EE 계정에서 서버 로그·DB `notification`·objectstore 에 **지시 문장·카탈로그(README/커밋 제목)·자동화 이름·프롬프트 템플릿·로그 본문** 0건. `runner_status` 에 불리언만.

---

## 10. 구현 분담 (6 슬라이스 — 파일 소유 겹침 0)

### S1 데몬 자동화 엔진 + 배선 + cpt/스킬 (`codingpt_daemon`)
- 신규: `runner-core/{events.js, json-store.js, automations.js, cron.js, template.js}`, `test/{events,cron,template,automations,automation-e2e}.test.js`, `docs/fixtures/automation/{rpc-auto.*.json, rpc-errors-automation.json, cron-01.json, template-01.json}`.
- 수정: `control.js`(§2.3 — 세 family 전부), `cpt-server.js`(§2.3 — `handleAutoRpc`·`wireAutomationBundle`·소켓 분기·CAPABILITIES·`notify*Changed` 3종), `cpt-cli/bin/cpt.js`(`auto` 절 + HELP), `cpt-cli/GUIDE.md`(§7), `cpt-cli/SKILL.md`(description 구문).
- 소비: `tasks.internalCreate(params, origin)`·`tasks.findRunByTsession(tsession)`(S2 가 export) · `dispatch.handle/configure/start`·`power.handle/configure/start`(S2). 배선 착수 시 S2 모듈이 없어도 `callLazy`/`require` 실패가 cap 미광고로 접히게 한다.
- 완료 기준: §9.1 5개 테스트 그린 · `cpt auto schema` 출력이 GUIDE §7 과 동일 · `env -i PATH=/usr/bin:/bin` 에서 gh 폴링이 동작 · CAPABILITIES 에 `auto.*` 10개.

### S2 데몬 dispatch + followup + power (`codingpt_daemon`)
- 신규: `runner-core/{dispatch.js, power.js}`, `test/{dispatch,followup,power}.test.js`, `docs/fixtures/automation/{rpc-dispatch.*.json, rpc-power.status.json, rpc-task.run.fix.json, dispatch-fallback-01.json}`.
- 수정: `tasks.js`(`followup`·`origin`·`assessFollowup`·`followupTick`·`task.run.fix`·`dismiss`·`internalCreate`·`findRunByTsession`·이벤트 발행·`RUN_FIELDS/TASK_FIELDS/ERROR_CODES` 추가), `task-git.js`(§4.1 6 함수 + `issuesList`·`commitsSince`), `agents.js`(`headless`·`loginStatus`), `fs.js`(`readHead` 추가 전용), `test/task-contract.test.js`(새 픽스처 포함), `rpc-task.get.json`.
- 금지: `control.js`, `cpt-server.js`(S1 소유 — 필요한 export 이름은 이 문서가 고정).
- 완료 기준: §9.1 dispatch/followup/power 그린 · `task-contract` 그린 · 가짜 claude 로 cli/폴백 두 경로 · `pmset`/`sudo`/`caffeinate` 실호출은 테스트에서 0건(exec 주입).

### S3 back (`codingpt_back`)
- 수정: `controllers/daemonController.js`(`AUTO_RPC_OK`·`autoRpc`·`TASK_RPC_OK` 2줄·export), `routes/daemonRoutes.js`(1줄), `config/caps.js`(3 caps + 헤더 주석), `services/daemonRelayService.js`(§7.2), `docs/byo-pc-status.md`(라우트 1줄). 신규 `test/auto-route.test.js`, `test/relay-busy.test.js`.
- 무수정: `notificationService.js`, `utils/response.js`, 모델/마이그레이션(컬럼 추가 없음).
- 완료 기준: §7.4 그린 · dev 배포 후 `GET /api/daemon/status` `serverCaps` 에 3 caps · `runner_status` 에 `busy/awake`.

### S4 PC (`codingpt_pc`)
- 신규: `src/js/{automations-view.js, automations-model.js, automations-api.js(autoRpc = taskRpc 복제, hostHasAuto/Dispatch/Power), dispatch-sheet.js, power-settings.js, text/automations.js}`, `src-tauri/src/power.rs`, `test/{automations-crossimpl.mjs, dispatch-ui.test.mjs, power-settings.test.mjs}`.
- 수정: `index.html`(`#automationsView`), `main.js`(render 분기·SEL·registerCommands 2개·`state.view==='automations'` 전역 스코프 규칙), `state.js`(`view` 값·`automations.byHost` 스토어·`setAutomationsForHost`), `sidebar.js`(`autoRow`·sbSig·PC 행 sun 글리프·pcMenu `PC 설정`), `tasks-view.js`(카드 followup 문구/액션·`자동` 칩·헤더 [한 줄 지시])·`task-detail.js`(followup 블록)·`tasks-model.js`(§8.1)·`text/tasks.js`(§11 tasks 추가분 + `ERROR_KEY`), `settings.js`(system 카드), `commands.js`·`text/palette.js`, `ui-channel.js`(핸들러 3 + `wirePower` + runner_status awake), `notifications.js`(`auto_*`/`pc_*` 라우팅), `icons.js`(`repeat`·`sun`), `styles.css`(`.au-*`, `.auto-row`), `api.js`(`autoLocal`, `powerLocal`, `onPower`), `src-tauri/src/cptsock.rs`(`auto_local`·`power_local`), `lib.rs`(등록 + `power::install(app)`), `Cargo.toml`(`objc2-app-kit`, `block2`), `package.json` 체인, `test/{tasks-crossimpl,i18n-crossimpl,palette-crossimpl}.mjs`.
- 금지: `src/js/i18n/*.js`(S6), `codingpt_app/**`.
- 완료 기준: §9.3 그린 · §9.5 1~5 · 릴리스 빌드에서 `power.rs` 옵저버가 willSleep 을 로그에 남김.

### S5 앱 (`codingpt_app`)
- 신규: `src/workspace/automations/{AutomationsHost.tsx, AutomationList.tsx, AutomationDetail.tsx, automationsUi.ts, useAutomations.ts, automationsModel.ts}`, `src/workspace/dispatch/{DispatchSheet.tsx, PlanCard.tsx, dispatchFlow.ts}`, `src/components/PcSettingsSheet.tsx`, `src/services/{automationService.ts(autoRpc·hostSupportsAuto/Dispatch/Power·타입), dispatchService.ts, powerService.ts}`, `src/hooks/useAutoDeepLink.ts`, `src/text/automations.ts`, `__tests__/{automationsModel,automationService,dispatchFlow,pcSettingsSheet,autoDeeplink}.test.*`.
- 수정: `SidebarContent.tsx`(`AutoRow`·배타 규칙·sun 글리프·pcMenu), `navigation/{RootNavigator,AppBackHandler}.tsx`, `workspace/tasks/{TaskCard,TaskDetail,TasksDashboardHost,tasksModel,tasksUi}.{tsx,ts}`(followup·`자동` 칩·헤더 [한 줄 지시]·`closeAutomations` 호출), `services/taskService.ts`(타입 `followup/origin`·`fixRun`·`dismissFollowup`), `services/pushService.ts`(kind `'auto'|'tasks'` + 파서), `components/NotificationsPanel.tsx`, `workspace/{uiCommandNames.ts, UiCommandBridge.tsx}`(3 커맨드), `palette/commands.ts`·`text/palette.ts`, `text/tasks.ts`, `contexts/WorkspaceShellContext.tsx`(`useAutoDeepLink` 마운트).
- 금지: `i18n/master.json`, `src/i18n/*.ts`(S6), `codingpt_pc/**`.
- 완료 기준: `tsc --noEmit`·jest 그린 · §9.5 6~7 Android 에뮬 + iOS 시뮬(재빌드/재설치로).

### S6 i18n + 모델 픽스처
- 소유: `codingpt_app/i18n/master.json`(§11 전 원문 × 6 언어), `codingpt_app/src/i18n/{ko,en,ja,zh-CN,es,de,fr}.ts` 와 `codingpt_pc/src/js/i18n/{…}.js`(**직접 줄 삽입**, 각 파일 `"작업 현황판":` 줄 아래 블록으로. emit 금지 — 사이드바 §8 규칙), `docs/fixtures/automation/{auto-01-list.json, auto-02-empty.json}`, `docs/fixtures/agent-tasks/{model-12-followup-ci.json, model-13-followup-reviews.json}`.
- 산출 순서: **가장 먼저** 원문 표(§11)를 master.json 에 넣고 14개 카탈로그를 삽입해 커밋 → S4/S5 가 `text/*` 필드를 붙인다. 픽스처는 §8 규칙으로 작성하고 S4/S5 테스트가 읽는다.
- 완료 기준: PC `i18n-crossimpl` 2·5절, 앱 카탈로그 = master 검사 통과 · 픽스처 4개가 양쪽 crossimpl 에서 동일 출력.

의존 순서: S6(원문·픽스처) 와 S1(배선 스텁) 이 첫날 커밋 → S2/S3/S4/S5 병렬 → 통합(§9.5).

---

## 11. i18n 원문 (키 = 한국어 원문. ko/en 만 적고 ja/zh-CN/de/es/fr 는 S6 가 채운다. 플레이스홀더 `{n} {name} {t} {agent} {cron} {tz} {branch} {repo} {labels} {event} {id}`)

**`text/automations.{js,ts}` — `AUTO_TEXT.ko`**
```
automations:      자동화                          | Automations
autoTitle:        자동화 · {name}                  | Automations · {name}
autoEmpty:        아직 자동화가 없어요               | No automations yet
autoEmptyHint:    한 줄 지시에서 '매일 …' 처럼 말하거나, 에이전트에게 부탁하면 만들어져요 | Say "every day …" in a one-line instruction, or ask the agent to set one up
pauseAll:         전체 일시정지                     | Pause all
autoPausedAll:    모든 자동화가 일시정지돼 있어요      | All automations are paused
groupActive:      활성                            | Active
groupPaused:      일시정지됨                        | Paused
runNow:           지금 실행                        | Run now
pause:            일시정지                         | Pause
resume:           재개                            | Resume
deleteAuto:       삭제                            | Delete
deleteAutoConfirm: 이 자동화를 삭제할까요? 만든 작업은 남아요 | Delete this automation? Tasks it created will remain
rename:           이름 변경                        | Rename
madeByAgent:      {agent} 가 만듦                   | Created by {agent}
madeByDispatch:   한 줄 지시로 만듦                  | Created from a one-line instruction
madeByUser:       직접 만듦                        | Created by you
nextRun:          다음 실행 {t}                     | Next run {t}
noNextRun:        예정 없음                        | Not scheduled
lastOk:           마지막: 성공 · {t}                | Last: succeeded · {t}
lastFailed:       마지막: 실패 · {t}                | Last: failed · {t}
lastCreatedTasks: 작업 {n}개 생성                   | Created {n} tasks
runsToday:        오늘 {n}/{d}회                    | Today {n}/{d}
trigSchedule:     {cron} ({tz})                    | {cron} ({tz})
trigOnce:         {t} 한 번                        | Once at {t}
trigCommits:      새 커밋 · {branch}                | New commits · {branch}
trigIssues:       새 이슈 · {labels}                | New issues · {labels}
trigCi:           검사 실패                        | Checks failed
trigReviews:      리뷰 코멘트                       | Review comments
trigTaskEvent:    작업 이벤트 · {event}             | Task event · {event}
actTaskCreate:    작업 만들기                       | Create task
actPrompt:        에이전트에게 지시                   | Send prompt to agent
actNotify:        알림 보내기                       | Send notification
stepN:            {n}단계                          | Step {n}
guards:           제한                            | Limits
auditLog:         실행 기록                        | Run log
autoBadge:        자동                            | Auto
pausedByError:    연속 실패로 일시정지됨              | Paused after repeated failures
pausedByLimit:    하루 실행 상한에 도달했어요           | Daily run limit reached
pausedByServer:   서버에서 자동화가 꺼져 있어요         | Automations are disabled on the server
errAutoDisabled:  이 PC 에서는 자동화를 쓸 수 없어요    | Automations are unavailable on this PC
errAutoNotFound:  자동화를 찾을 수 없어요             | Automation not found
errAutoLimit:     자동화 개수 상한을 넘었어요          | Too many automations
errAutoLoop:      자동화가 만든 작업에서는 자동화를 만들 수 없어요 | Tasks created by an automation cannot create automations
errAutoDepth:     자동화 연쇄가 너무 깊어요           | Automation chain is too deep
errAutoBad:       자동화 정의가 올바르지 않아요         | Invalid automation definition
errAutoBusy:      실행 중이라 바꿀 수 없어요           | Cannot change while running
dispatch:         한 줄 지시                        | One-line instruction
dispatchPlaceholder: 무엇을 어디에 시킬까요?           | What should be done, and where?
plan:             계획                            | Plan
planning:         계획 중 · {agent}                 | Planning · {agent}
collecting:       PC 정보 수집 중 ({n}/{d})          | Collecting PC info ({n}/{d})
replan:           다시 계획                        | Plan again
planSummary:      요약                            | Summary
planTasks:        작업                            | Tasks
planAutomations:  자동화                          | Automations
planQuestions:    확인이 필요해요                    | Needs clarification
simpleMatch:      간단 매칭                        | Simple match
fallbackNoAgent:  로그인된 에이전트 CLI 가 없어 이름으로 골랐어요 | No signed-in agent CLI; matched by name
fallbackTimeout:  계획이 늦어져 이름으로 골랐어요        | Planning timed out; matched by name
fallbackFailed:   계획에 실패해 이름으로 골랐어요        | Planning failed; matched by name
catalogFailed:    {name} 정보를 가져오지 못했어요        | Could not read {name}
pickRepo:         저장소를 골라 주세요                 | Choose a repository
include:          포함                            | Include
why:              이유                            | Why
keepAwake:        PC 깨어 있기                      | Keep PC awake
keepAwakeWork:    작업 중에는 잠자기 방지              | Prevent sleep while working
keepAwakeWorkDesc: 에이전트가 작업하는 동안 PC 가 잠들지 않아요 | The PC stays awake while agents are working
lidClosed:        덮개를 닫아도 계속 작업              | Keep working with the lid closed
lidClosedDesc:    관리자 암호로 1회 설정이 필요해요       | Needs a one-time setup with your admin password
setUp:            설정하기                         | Set up
setUpDone:        설정됨                           | Set up
removeSetup:      해제                            | Remove
setupPending:     PC 화면의 암호 창을 확인하세요         | Check the password dialog on the PC screen
setupRemoteHint:  암호 입력 창은 그 PC 화면에 떠요. PC 앞에서 진행하세요 | The password dialog appears on that PC's screen
setupCancelled:   설정이 취소됐어요                   | Setup was cancelled
setupFailed:      설정에 실패했어요                   | Setup failed
awakeNow:         깨어 있음                        | Awake
awakeStatus:      지금: 깨어 있음 · 작업 {n}개          | Now: awake · {n} tasks
asleepAllowed:    지금: 잠자기 허용                   | Now: sleep allowed
onBattery:        배터리 전원에서는 덮개 닫힘 유지가 꺼져요 | Lid-closed mode is off on battery power
powerCaveat:      덮개를 닫은 채 계속 실행하면 발열이 늘고 배터리가 빨리 닳아요. 전원 어댑터를 연결하고 통풍이 되는 곳에 두세요 | Running with the lid closed increases heat and drains the battery. Keep the power adapter connected and leave room for airflow
powerUnsupported: 이 PC 에서는 지원되지 않아요          | Not supported on this PC
pcSettings:       PC 설정                          | PC settings
```
**`text/tasks.{js,ts}` 추가분**
```
ciFailedLine:     검사 실패 {n}개                    | {n} checks failed
reviewCommentsLine: 리뷰 코멘트 {n}개                | {n} review comments
fix:              고치기                           | Fix
fixing:           에이전트에게 보내는 중…              | Sending to the agent…
ignore:           무시                            | Ignore
fixSent:          에이전트에게 보냈어요                | Sent to the agent
errFollowupNothing: 보낼 내용이 없어요                | Nothing to send
oneLine:          한 줄 지시                        | One-line instruction
```
**팔레트**: `automations.open` = "자동화", `dispatch.open` = "한 줄 지시".
**`ERROR_KEY` 추가**: `AUTO_DISABLED→errAutoDisabled, AUTO_NOT_FOUND→errAutoNotFound, AUTO_LIMIT→errAutoLimit, AUTO_LOOP→errAutoLoop, AUTO_DEPTH→errAutoDepth, AUTO_BAD_TRIGGER|AUTO_BAD_ACTION|AUTO_TEMPLATE_TOO_LARGE→errAutoBad, AUTO_BUSY→errAutoBusy, AUTO_PAUSED→pausedByError, AUTO_RATE_LIMITED→pausedByLimit, DISPATCH_DISABLED|POWER_DISABLED→errTasksDisabled, POWER_UNSUPPORTED→powerUnsupported, POWER_SETUP_REQUIRED→lidClosedDesc, POWER_SUDO_MISSING→setupFailed, POWER_NO_GUI→setupRemoteHint, POWER_SETUP_CANCELLED→setupCancelled, POWER_SETUP_FAILED→setupFailed, FOLLOWUP_NOTHING→errFollowupNothing, AUTO_OUT_OF_TERMINAL→errAutoLoop`(양쪽 같은 객체, 없는 code 는 `errGeneric`).
데몬 알림 문구(§4.4, §5.8, §6.5)는 한국어 고정(기존 정책·알려진 갭 동일).

---

## 12. 보안·프라이버시 불변식 (설계 §10 에 추가)
1. 서버는 **지시 문장·카탈로그(README/커밋 제목/경로)·플랜·자동화 이름·템플릿·감사 로그·CI 로그·리뷰 코멘트**를 봉인 경로에서 보지 않는다. 평문 폴백은 `fs.*`/`task.*` 와 같은 등급. 서버가 평문으로 아는 것은 `busy/awake` 불리언, 알림 일반 문구, 자동화 id, 트리거 유형 라벨뿐.
2. 플래너·자동화·후속은 전부 **사용자 자신의 CLI/gh/git** 을 사용자 PC 에서 돌린다. 자격증명을 읽거나 옮기지 않는다. 헤드리스 플래너는 원본 바이너리(우리 래퍼 아님)를 빈 폴더에서 도구 없이 1턴만.
3. 자동화 액션은 열거된 3종뿐. 셸·파일 쓰기·push·merge 없음. 작업은 worktree 로만(메인 체크아웃 불가침). 상한·루프·감사·킬스위치(§5.5).
4. 자동화 생성은 그 PC 의 CodingPT 터미널(tmux `cpt-` 자기좌표) 또는 인증된 클라이언트에서만. CWD 폴백 컨텍스트로는 불가.
5. sudoers 규칙은 `pmset -a disablesleep {0,1}` 두 명령·한 사용자·`visudo -c` 검증·0440 root:wheel. 데몬은 절대 암호를 다루지 않는다. 우리가 켜지 않은 `SleepDisabled` 는 건드리지 않는다.
6. `gh api` 호출은 `-q` 로 필드만 받고 본문은 300자(코멘트 머리)/12KB(로그) 로 자른다. 템플릿은 정확 치환만(코드 실행 없음).
7. 모든 경로는 `fs.safeResolve` 홈 jail. `execFile` 만. 사용자 문자열은 stdin 또는 `--flag=value`.

## 13. 변경 규칙
- 메서드/필드/상태/에러코드/원문을 바꾸면 이 문서 표 → `docs/fixtures/automation/` → 코드 순. 추가는 자유(optional), 삭제·의미 변경은 `*.v2`.
- 설계 §9·사이드바 §8 의 i18n 절차 그대로(master → 카탈로그 직접 삽입 → text 모듈).

---

## 부록 Z. 결정·근거·열린 리스크

| # | 결정 | 근거 | 리스크·대응 |
|---|---|---|---|
| Z-1 | 플래너 = 사용자 CLI 헤드리스(`claude -p` 우선) | ToS 경계(데몬 CLAUDE.md: 사용자 CLI 구조화 spawn 허용, agent.js 선례). 우리 키 0 | **벤더 플래그 실측 미완**: `--tools ""`(claude), `--output-last-message`(codex), `--output-format json`(gemini) 가 설치 버전에서 다르면 `PLANNER_FAILED` → 폴백. E2E 1 에서 세 CLI 각각 실측 후 CATALOG `headless` 확정. 빈 폴더 `-p` 에서 신뢰 다이얼로그가 뜨면(stdout 패턴) 실패로 접는다 |
| Z-2 | 카탈로그는 클라가 모아 플래너 PC 로 | PC↔PC 직접 채널이 없고 back 은 내용을 못 본다 | 폰 데이터 사용 ≤ 48KB×PC 수. 카탈로그 실패 PC 는 제외(부분 계획) |
| Z-3 | 폴백은 자동화를 제안하지 않음 | 오탐 스케줄의 비용 | "매일" 이 있는데 폴백이면 카드에 `fallback*` 문구로 이유를 보여 준다 |
| Z-4 | F2 감지를 데몬 백그라운드 폴링으로(3분) | 클라 폴링은 상세가 열려 있을 때만 — "폰을 안 보고 있을 때 알림" 이 요구 | gh 호출 ≤ 40/3분·open PR run 만. gh 미인증이면 감지 없음(카드에 기존 gh 안내) |
| Z-5 | 리뷰 코멘트에서 자기 코멘트도 포함 | GitHub 앱에서 사용자가 단 코멘트를 에이전트에 넘기는 흐름이 정상 | 에이전트가 gh 로 남긴 코멘트(드묾)도 잡힘 — [무시] 로 처리 |
| Z-6 | `cpt auto` 를 CAPABILITIES 에 공개(AI 가 자기 자동화를 만듦) | 사용자 명시 지시 | 설계 §2.3 "자기 증식 금지" 규칙의 예외. 방어: 하루 상한·깊이 2·루프 거부·알림·킬스위치·감사 로그. 실전에서 남용이 보이면 `guards.maxRunsPerDay` 기본을 낮춘다 |
| Z-7 | 임의 셸·파일 감시·터미널 패턴 트리거 제외 | §5.2/§5.3 | 요구가 생기면 `task.create` 로 표현(에이전트 승인 흐름 안) |
| Z-8 | 놓친 스케줄 24h 안 1회 실행 | "매일 아침" 은 늦게라도 원한다; 며칠 지난 건 무의미 | 여러 자동화가 동시에 따라잡으면 큐(동시 1)·하루 상한이 완충 |
| Z-9 | 잠든 PC 를 스케줄에 깨우지 않음 | `pmset schedule wake` 도 root — sudoers 규칙 확장은 다음 라운드 | 사용자 안내: 스케줄 자동화는 PC 가 깨어 있을 때 실행 |
| Z-10 | 덮개 닫힘 = `disablesleep` + sudoers.d | 유일한 클램셸 우회, 최소 권한 | 비문서화 키 — macOS 업데이트로 동작이 바뀌면 `lastError` 로 드러남. 배터리에서는 켜지 않음. 과열 안내 문구 |
| Z-11 | 잠자기 알림 best effort | willSleep 뒤 네트워크 시간이 짧다 | 서버 끊김 푸시(90s)가 결정적 안전망 |
| Z-12 | 서버 `busy/awake` 불리언 | E2EE 원칙 안에서 끊김 푸시를 만드는 최소 정보 | `agentStateLast` 로도 추정 가능하나 `forgetAgentStatesOf` 가 cleanup 에서 지우므로 명시 프레임이 안전 |
| Z-13 | `power.event` 로컬 전용 | 원격 기기가 PC 의 잠자기를 주장할 이유 없음 | — |
| Z-14 | 자동화 편집 폼 없음(생성은 AI/한 줄 지시) | 사용자 방향 "사람이 방식을 고르지 않는다" | 세부 수정은 `auto.update` RPC 가 있으므로 다음 라운드에 UI 만 얹으면 된다 |
| Z-15 | 알림 subtitle 에 트리거 유형·PR 번호·기기 이름만 | 설계 B-3 옵션 A | 자동화 이름은 봉인 `auto.get` 으로만 |
| Z-16 | 팔레트 단축키 `Mod+Shift+I/U` | 미사용 조합 추정 | 충돌 시 `Mod+Alt+I/U`(commands.js 주석·palette-crossimpl 동시 수정) |
