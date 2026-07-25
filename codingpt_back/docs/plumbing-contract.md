# 11 — 배관 계약(정본): 비어 있는 가운데 5곳

작성: 2026-07-25 · **읽기 전용 조사 결과(코드 무수정)** · 근거는 전부 `파일:줄`

이 문서는 구현 지시서가 아니라 **와이어 계약서**다. 5개 갭은 양쪽 절반이 이미 커밋돼 있고
가운데(프레임/라우트/핸들러)만 없다. 4명이 병렬로 구현할 때 **이 문서만 보고도 서로 어긋나지 않게**
하는 것이 목적이므로, 코드에서 확인한 사실과 아직 결정이 필요한 부분을 문장마다 구분했다.

> 표기: **[실측]** = 파일:줄 또는 실행 출력으로 확인. **[추정]** = 코드 근거가 없거나 두 해석이
> 가능해 내가 권고안을 적은 것. 구현자는 [추정]을 그대로 믿지 말고 착수 전 확인할 것.

---

## 0. 먼저 읽을 것 — caps 교리와 현재 교집합

게이팅 = `데몬caps ∩ SERVER_CAPS ∩ 기기caps`. **서버가 실제 처리 코드를 가진 커밋에서만** 그 문자열을
선언한다(`codingpt_back/config/caps.js` 파일 주석이 정본). 미리 선언하면 데몬이 기능을 켜고 서버가
프레임을 버려 **조용한 유실**이 된다 — 지난 라운드의 결함 #8이 정확히 이것이었다.

지금 이 순간의 교집합을 실제로 측정했다(HOME 격리, 데몬 미기동):

```
$ HOME=<격리> node -e "…"   # runner-core/e2ee-gate + control + back/config/caps
scope rpc caps [] epoch 0
daemonCaps ["caps.v1","hooks.v2","approval.v1","transcript.v1","lan.v1"]
SERVER_CAPS(no env)  ["caps.v1","approval.v1","transcript.v1","e2ee.keys.v1"]
SERVER_CAPS(lan on)  ["caps.v1","approval.v1","transcript.v1","e2ee.keys.v1","lan.v1"]
```

읽어야 할 사실 3개:

1. **데몬은 `e2ee.*` 를 하나도 선언하지 않는다.** `e2ee.js:1136 caps()` 가 `hasKey()` 를 요구하고
   (`e2ee-gate.js:98-111` 이 그걸 그대로 통과시킨다), 열쇠는 `bootstrapMasterKey`/`acceptGrant` 로만
   생기는데 **데몬 어디에도 그 호출자가 없다** — `packages/**` 전체에서 `api/daemon/e2ee` 문자열 0건,
   `bootstrapMasterKey`/`acceptGrant` 호출은 `test/e2ee.test.js` 뿐. → 갭 2의 숨은 전제(§2.6).
2. `hooks.v2` 는 데몬만 선언하고 서버는 모른다(서버 처리 코드가 필요 없는 능력이라 정상). 반면
   `agentstate.v1` 은 **양쪽 다** 없다 → 갭 1.
3. `lan.v1` 은 데몬이 기본으로 선언하지만(`CPT_LAN` 미설정 = scope `tcp`), **리스너는 서버가
   `lan.v1` 을 선언한 hello_ack 이후에만 열린다**(`control.js:371-374 → startLanIfAllowed`).
   즉 "인바운드 포트 0" 불변식은 서버 스위치가 지킨다.

이번 라운드에서 새로 선언할 문자열은 아래 4개뿐이고, **선언 조건**은 각 갭 절에 못 박았다.

| 문자열 | 선언 주체 | 선언 조건(이게 충족되기 전엔 절대 선언 금지) |
|---|---|---|
| `agentstate.v1` | back + 데몬 | back 이 `agent_state` 수신·검증·팬아웃 코드를 갖고, 데몬이 emit 코드를 가진 커밋 |
| `e2ee.rpc.v1` | back | `POST /api/daemon/rpc` 라우트가 존재하고 `callRpc(...,'sealed',…)` 로 중계하는 커밋 |
| `e2ee.stream.v1` | back | 터미널/포워딩 토큰 발급이 `e2ee.begin` 을 선협상하고 스트림 params 에 `sid` 를 싣는 커밋 |
| `e2ee.snap.v1` | back | 매니페스트에 `enc`/`epoch` 를 **실제로 저장**하는 커밋(구 경로 `checkpoint()` 포함 — §5.7) |

`lan.v1` 은 이미 양쪽에 있다(스위치만 OFF). 갭 4·5는 **새 caps 문자열이 필요 없다** — 갭 4는 기존
`lan.v1` 안에서, 갭 5는 HTTP 404 폴백으로 게이팅된다(§4.6 / §5.5).

---

## 갭 1 — `agent_state` 팬아웃 (기능3 2단계)

### 1.1 양쪽 끝 현황

**데몬(있음)**
- `runner-core/agent-state.js` — 상태 단일 소유자. `bump()`(:112)이 상태·단조 `version` 을 바꾸는
  **유일한 지점**, `applyHook`(:190) / `applyWatch`(:353) / `forget`(:460) / `snapshot(cwdRel,{includeUnknown})`(:447) /
  `statusOf`(:408, `launching`→`idle` 접기) / `configure({now,notify,log})`(:48).
- `control.js:78 sendEvent(frame, cap)` — cap 미선언·연결 없음이면 **보내지 않고 `false`**(조용한 폴백).
  `control.js:510` 에서 `require('./agent-state').start({})` 로 기동(주입 인자 자리 비어 있음).
- 상태 도메인 [실측 `agent-state.js:78, 240-327`]: `launching | idle | working | needsInput | permission | ended`.

**클라이언트(절반 있음)**
- PC: **수신기가 이미 있다.** `codingpt_pc/src/js/ui-channel.js:194-197` → `S.setAgentState(msg.event || msg)`,
  저장은 `state.js:633-644` 로 키가 **`${cwd}|${win}`**, `state === "gone"` 이면 삭제.
  소비는 `pane.js:781-789 _agentOn()`(1순위 push, 2순위 `tab.cmd`), 주입은 `workspace-view.js:112`.
- 앱: **수신기 없음.** 판정은 `PaneView.tsx:52-57 hasAgentCmd()` + `:473` 뿐이고, `tab.cmd` 는
  리컨실러가 채운다(`contexts/WorkspaceShellContext.tsx:196`, 5~9초 지연). 두 번째 소비자 후보 =
  `workspace/chatModel.ts:309-320 looksBusy()`("기능3 이 도달하면 이 함수 대신 `state==='working'`").

**없는 것**: 데몬 emit · back 수신/검증/팬아웃 · 앱 수신기 · caps `agentstate.v1`.

### 1.2 터미널 식별자 결정 — `cwd`(cwdRel) + `win`(tid)

세 후보 중 **클라이언트가 실제로 가진 것**만 쓴다.

| 후보 | 클라이언트 보유 여부 | 판정 |
|---|---|---|
| `cwdRel` | PC `ctx.localPath`(=`state.js` 워크스페이스 localPath), 앱 `ws.localPath`(`PaneView.tsx:452`) — 그리고 `UiCommandBridge.tsx:100` 이 이미 `w.localPath === p.ws` 로 매칭한다 | **채택** |
| `tid` | 터미널 탭의 `win`(정수 안정 ID, `tiling.ts:16`, PC 동일) | **채택**(와이어 필드명 `win`) |
| tmux 세션명 | 어느 클라이언트도 갖고 있지 않다(데몬 내부 키) | 기각 |

→ **와이어 키 = `(cwd, win)`.** PC 의 기존 저장 키와 바이트 단위로 같아 PC 는 무수정 수신 가능.
`hostDeviceId` 는 back 이 **추가로** 스탬프한다(멀티 PC 에서 같은 cwdRel 이 두 PC 에 있을 수 있다).
PC 의 현재 구현은 이 필드를 무시하므로 additive 이고, 앱은 처음부터 `(hostDeviceId, cwd, win)` 로
색인할 것을 권고한다 [추정 — PC 의 키 충돌은 이론상 가능하지만 실사고 사례는 없다].

★ **host 관용은 양방향이어야 한다**(2026-07-25 실측 사고). 팬아웃 프레임에는 back 이 **항상**
`conn.deviceId` 를 싣지만, 조회측 워크스페이스 메타에는 `hostDeviceId` 가 **없을 수 있다** —
`workspaceService.js:104` 는 `m.hostDeviceId != null` 일 때만 응답에 싣기 때문에 필드 도입 전에
만든 로컬 ws·`claimWorkspaceHost` 미경유 ws 는 앱에서 `host=undefined` 로 조회된다. 그러면
`'0|cwd|win'` 으로 찾고 저장 키는 `'12|cwd|win'` 이라 **그 워크스페이스만 영구히 tab.cmd 폴백**에
갇힌다(에러·로그 0건, PC 는 `(cwd,win)` 색인이라 정상 → "PC 는 되는데 폰만 안 됨"). 그래서 조회는
① 저장 항목에 host 가 없을 때 host 무관 조회, ② **질의측에 host 가 없을 때 `(cwd,win)` 일치 항목을
host 무관으로 채택**(여러 건이면 가장 최근 수신) 둘 다 해야 한다. 앱 구현·회귀 테스트:
`agentStateStore.ts agentSnapOf()` / `__tests__/agentState.test.ts`.

### 1.3 와이어 계약

**① 데몬 → back (제어 WS, 신규 type)**

```jsonc
{ "type": "agent_state",
  "event": {
    "cwd": "other/project/codingpt",   // cwdRel(홈-상대). 필수. 빈 문자열 허용(홈)
    "win": 1000123,                    // tid(정수, 안정 ID). 필수
    "state": "working",                // idle|working|permission|needsInput|gone  ← ★ 아래 매핑 규칙
    "agent": "claude",                 // claude|codex|gemini|null
    "version": 42,                     // 이 (cwd,win) 안에서 단조 증가(agent-state.rec.version 그대로)
    "at": 1753432801000,               // 데몬 Date.now()
    "sessionId": "21b28dc2-…",         // null 가능
    "source": "hook",                  // hook|watch (진단용)
    "since": 1753432800000             // 현재 state 진입 시각(옵셔널)
  } }
```

**② back → 전 기기 (기존 팬아웃 채널 동승 — 새 WS 경로 금지)**

```jsonc
{ "type": "agent_state",
  "event": { /* ①의 event 그대로 + 아래 2개를 back 이 스탬프 */
    "hostDeviceId": 12,               // 이 프레임을 보낸 데몬 conn.deviceId
    "kind": "local"                    // conn.kind (진단용, 옵셔널)
  } }
```

**금지 필드**: `summary` / `body` / `promptId` / `pending.tool` 등 **내용성 정보는 싣지 않는다.**
상태 프레임은 순수 메타데이터다(E2EE 로 봉인할 것이 없어야 한다 = 봉투 배관과 독립적으로 안전).
요약은 이미 알림 body 경로(`agent-state.js:151 fire()` → `POST /api/notifications`)가 담당한다.

**★ `state` 매핑 규칙(어기면 조용히 죽는다)**

```
agent-state 내부 상태            →  와이어 state
launching                        →  idle        (statusOf() 가 이미 접는다 — agent-state.js:411)
idle | working | permission | needsInput → 그대로
ended                            →  "gone"      ★ 반드시 변환
forget(key) (터미널 소멸)         →  "gone" 1회 발사
agent-watch 셸 복귀(observedState=null, shell) → 내부 'ended' 로 기록 → 와이어 "gone"   ★ 아래 참조
```

**★ 셸 복귀는 'idle' 이 아니라 소멸이다(2026-07-25 추가, 실측 결함)**

와이어에서 `idle` 은 "에이전트가 붙어 있고 유휴" 를 뜻한다(PC `pane.js` 는 `st.state !== "gone"`,
앱 `resolveAgentOn` 도 동형). 그래서 `applyWatch` 의 관찰 경로가 셸 복귀를 `idle` 로 기록하면 두 입구로
조용히 죽는다:

- **훅 없는 경우**(gemini · `--settings` 직접 지정 · idle 중 `kill -9`): 마지막 방출값이 `idle` 로 남아
  **빈 셸 탭에 Chat 토글이 stale 상한(15분)까지 켜진 채 굳는다**(push 가 있으면 `tab.cmd` 폴백은
  건너뛰어진다).
- **훅 있는 경우**: `session_end` 로 `gone` 을 보낸 뒤 그 터미널을 닫지 않고 10분(`HOOK_GOVERN_MS`)
  두면 훅 지배가 풀리고, 같은 셸 관찰이 상태를 `idle` 로 되돌려 **이미 꺼진 토글이 스스로 되켜진다**
  (부록 A #1 의 변종).

→ 규칙: `applyWatch` 의 셸 복귀는 `bump(rec,'ended')`(= 와이어 `gone`)로 기록한다. `'gone'` 을 이미
보냈다면 dedup 이 중복 전송을 막는다(종료 → 10분 → 셸 관찰 = **추가 방출 0건**이어야 한다).
레거시 3값(`cpt terminal wait --for idle`)은 `legacyStatusOf` 가 `ended`→`idle` 로 접으므로 무영향.

이유 [실측]: PC `pane.js:783-784` 는 `if (st) return st.state !== "gone";` 다. `ended` 를 그대로 보내면
**에이전트가 끝났는데 Chat 토글이 영구히 켜진 채로 남는다**(그리고 `tab.cmd` 폴백으로 되돌아가지도
않는다 — push 가 존재하는 순간 폴백은 건너뛰어진다).

**발사 시점(권고)** [추정 — 코드 근거는 `bump()` 가 유일 변경점이라는 사실뿐]
- `bump()` 직후, **와이어 state 가 직전 발사값과 다를 때만** 발사(같은 state 로 version 만 오른 경우는
  발사하지 않음 — 훅 7종이 도는 턴마다 프레임이 3~4개면 충분하다).
- `forget()` 에서 `gone` 1회.
- `hello_ack` 에서 caps 확인 후 **전체 리싱크**: `snapshot()` 의 각 레코드를 event 1건씩 재발사하고
  "마지막 발사값" 캐시를 비운다(back 재시작으로 인메모리 인덱스가 날아간 경우 복구).

**rseq/monotonic 필요 여부**: **rseq 는 불필요, `version` 은 필수.**
- 이유: back 은 이 프레임을 **버퍼링하지 않는다**(`pushAgentEvent`(:643)의 rseq/리플레이 버퍼는
  `agent_event` 전용이고, 거기에 상태 프레임을 넣으면 초당 수십 건이 알림 리플레이 항목을 축출한다 —
  `chat_event` 를 버퍼에 넣지 않는 이유와 동일: `daemonRelayService.js:315-320` 주석).
- 클라이언트는 `(hostDeviceId,cwd,win)` 별 `version` 을 들고 순서 역전을 방어한다. 재접속 캐치업은
  §1.5 의 back 라스트-스테이트 리플레이가 담당한다.
- ★ **폐기 조건은 `version` 단독이 아니다**(2026-07-25 교차검증 확정): `version` 은 (cwd,win) 안에서만
  단조이고 **데몬 재기동에서 1부터 다시 시작한다** — 재기동은 이 제품의 상시 이벤트다(PC 업데이트/
  데몬 재시작, `hello_ack` 의 resyncAll 도 낮은 version 을 싣는다). `version <= last` 만 보면 재기동 후
  모든 프레임을 폐기해 낡은 'working' 에 15분(stale) 고착한다(중단 버튼·종료 배너 타이밍이 전부 틀림).
  → **`version` 도 후퇴하고 `at` 도 후퇴했을 때만 폐기**(둘 중 하나라도 전진하면 채택).
  구현 정본 두 곳이 같은 규칙이어야 한다: 앱 `agentStateStore.applyAgentState`, PC `state.js setAgentState`.

### 1.4 caps 문자열과 선언 조건

- 문자열: **`agentstate.v1`**(`config/caps.js` 주석에 예약된 이름 그대로).
- back: `computeServerCaps()` 에 `caps.push('agentstate.v1')` — **수신·검증·팬아웃 코드가 같은 커밋에
  있을 때만.** 킬스위치는 `AGENTSTATE_ENABLED`(미설정=켜짐, 다른 스위치와 방향 동일) [추정 — 이름은
  기존 `APPROVAL_ENABLED`/`TRANSCRIPT_ENABLED` 관례를 따른 권고안].
- 데몬: `control.js:31 DAEMON_CAPS` 에 `'agentstate.v1'` 추가(emit 코드가 같은 커밋에 있을 때).
  emit 자체는 `sendEvent(frame,'agentstate.v1')` 로 **서버 선언을 확인한 뒤에만** 나간다.
- 기기(ui_hello.caps): 수신기가 실제로 있는 클라이언트만 선언. PC `ui-channel.js:163` 배열 /
  앱 `notificationService.ts:89 CLIENT_CAPS`. **팬아웃은 caps 로 게이팅하지 않는다**(모르는 type 은
  무시되므로 안전, `fanoutRunnerStatus` 선례). 기기 caps 는 진단·통계용.

### 1.5 게이팅·폴백 규칙 — 이게 없으면 무엇으로 되돌아가는가

```
서버가 agentstate.v1 미선언 → sendEvent 가 false → 데몬은 아무것도 보내지 않음
                            → 클라이언트 push 0건 → tab.cmd 폴백(5~9초 지연) = 오늘의 동작
데몬이 구버전(emit 없음)     → 같은 결과(폴백)
클라이언트가 구버전         → unknown type 무시 → 폴백
push 가 왔다가 끊김         → ★ 클라이언트는 마지막 push 를 영구 신뢰하지 말 것:
                              (a) `state:'gone'` 을 받으면 키 삭제(PC 는 이미 그렇게 한다)
                              (b) runner_status.online=false 를 받으면 그 hostDeviceId 의 상태 전부 폐기
                              (c) 마지막 push 로부터 15분 초과면 stale 로 보고 tab.cmd 폴백 [추정]
                              (d) ★ 제어 WS(알림 채널) **재접속 시 보유 상태 전량 폐기 → 그 다음 ui_hello**
```

★ (d)가 왜 필수인가(2026-07-25 교차검증 확정): back 의 라스트-스테이트 리플레이는 **'삭제'를 표현할 수
없다.** 끊긴 사이 에이전트가 끝나면 데몬이 'gone' 을 보내고 back 은 그 키를 캐시에서 **지우므로**
재접속 리플레이에는 그 키에 대한 프레임이 **한 건도 오지 않는다**(실측: fanout working → fanout gone →
`_replayAgentStates` = 0건). 그래서 클라이언트가 먼저 비우지 않으면 끝난 에이전트가 유령으로 15분 남아
토글 ON + '중단' 버튼이 유지되고, push 가 존재하므로 `tab.cmd` 폴백도 건너뛰어진다. 폐기의 대가는
"폴백(5~9s 지연)" = 알려진 지연이고, 반대(스테일 신뢰)는 조용한 고착이다.
순서(폐기 → `ui_hello`)를 지켜야 리플레이가 복원한 살아 있는 프레임을 우리가 지우지 않는다.
구현: 앱 `resetAgentStates()`(알림 채널 재연결·포그라운드 복귀) / PC `state.js resetAgentStates()` 를
`ui-channel.js` 의 `ws.onopen` 에서 `ui_hello` **직전**에 호출.

- **폴백을 지우지 말 것**: `PaneView.tsx:52` / `pane.js:785-788` 의 `tab.cmd` 규칙은 gemini(훅 미지원)·
  `--settings` 직접 지정·cmux PATH 경합에서 유일한 신호다(설계 §6-B).
- back 재접속 캐치업(권고): back 이 `userId → Map('<deviceId>|<cwd>|<win>' → event)` 라스트-스테이트를
  들고 `ui_hello`(`daemonRelayService.js:808`) 수신 시 그 기기에만 재전송, 데몬 제어 WS
  `cleanup()`(:335) 에서 그 deviceId 항목을 **삭제**한다(오프라인 상태를 리플레이하지 않기 위해).
  상한은 유저당 200건 [추정 — 숫자는 권고]. 이걸 안 넣으면 "폰을 켠 직후 토글 판정이 다음 전이까지
  폴백"이 되는데, 그건 조용한 실패가 아니라 알려진 지연이므로 **선택 사항**이다.

### 1.6 패키지별 편집 지점

| 패키지 | 파일:줄 | 무엇을 |
|---|---|---|
| daemon | `runner-core/agent-state.js:39-55` | `configure({emit})` 수용(기본값은 `require('./control').sendEvent` lazy) |
| daemon | `agent-state.js:112 bump()` 끝 / `:460 forget()` | 와이어 state 계산 → 직전 발사값과 다르면 emit |
| daemon | `agent-state.js` 신규 내부 | `wireStateOf(rec)`(ended→gone, launching→idle) + `lastEmitted` Map + `resyncAll()` |
| daemon | `control.js:31` | `DAEMON_CAPS` 에 `'agentstate.v1'` |
| daemon | `control.js:510` | `start({ emit: (f) => sendEvent(f, 'agentstate.v1') })` |
| daemon | `control.js:374` 근처(hello_ack) | `hasServerCap('agentstate.v1')` 이면 `agentState.resyncAll()` |
| daemon | `test/agent-state.test.js` | ended→gone 변환 · 중복 억제 · resync · emit 실패 무해 |
| back | `config/caps.js:computeServerCaps` | `agentstate.v1` (+ 킬스위치) |
| back | `services/daemonRelayService.js:226-333` (`ws.on('message')` 체인) | `if (msg.type === 'agent_state')` 분기 → 검증 → `fanoutAgentState(userId, conn, msg.event)` |
| back | `daemonRelayService.js:595` 근처 | `fanoutAgentState()` 신설 — `fanoutRunnerStatus` 미러(SSE `broadcastEvent` + `agentWsClients`) |
| back | `daemonRelayService.js:808 ui_hello` | (선택) 라스트-스테이트 리플레이 — §1.5 |
| back | `daemonRelayService.js:335 cleanup()` | 라스트-스테이트 캐시에서 그 deviceId 항목 삭제 |
| back | `test/unit.test.js` (또는 신규) | 검증 규칙(필수 필드/상태 enum/길이 상한) 순수 함수 테스트 |
| app | `services/notificationService.ts:63-95` 미러 | `AgentStateEvent` 타입 + `setAgentStateListener` + `dispatchAgentState(m)` 를 `sock.onmessage`(:290-300)에 추가 |
| app | `contexts/WorkspaceShellContext.tsx:700-715` 미러 | 리스너 등록 → `(hostDeviceId,cwd,win)` Map 상태 + `agentStateOf()` 노출 |
| app | `workspace/PaneView.tsx:52-57, :473` | `hasAgentCmd` 앞에 push 우선 판정(PC `_agentOn` 과 **같은 순서**) |
| app | `workspace/chatModel.ts:309` | (선택) `looksBusy` 를 `state==='working'` 로 교체 |
| PC | `state.js setAgentState` / `ui-channel.js` onopen | 수신기는 이미 있었지만 두 곳을 고쳤다(2026-07-25): ① 폐기 조건에 `at` 후퇴 조건 추가(데몬 재기동 대응, §1.3) ② 재접속 시 `resetAgentStates()` → `ui_hello` 순서(§1.5-d). `ui-channel.js` caps 배열에 `'agentstate.v1'` 은 이미 포함 |

### 1.7 이 계약을 깨면 어떻게 조용히 죽는가

`ended` 를 `gone` 으로 바꾸지 않으면 claude 를 끝낸 뒤에도 Chat 토글이 영구히 켜진 상태로 남고
`tab.cmd` 폴백이 다시는 발동하지 않는다(에러 0건, 로그 0건).

---

## 갭 2 — E2EE 봉투 RPC (기능2 B단계)

### 2.1 양쪽 끝 현황

**데몬(있음)**
- `runner-core/e2ee.js` — 봉투 `sealEnvelope`(:963)/`openEnvelope`(:975), 편의 래퍼
  `sealRpc/openRpc/sealRpcResult/sealRpcError/openRpcResult`(:991-995).
  봉투 = `{v:1, suite, epoch, nonce:b64u12, ct:b64u}`, nonce = `[부팅난수 8B][카운터 u32 4B]`(:928),
  AAD = `"cpt-e2ee/v1/rpc"|"…/rpc-resp" ‖ u32(epoch) ‖ u32(hostDeviceId||0)`(:950).
- `control.js:207-237 handleSealedRpc` + `:428` — `method:'sealed'` 를 열어 `dispatchRpc`(:240) 한 벌로
  넘기고 응답/에러를 **반드시 봉인**한다.
- `control.js:179-202 handleE2eeBegin` + `:425` — `e2ee.begin` 은 이미 붙어 있다(갭 3에서 사용).

**back(있음)** — 열쇠 배포 표면 전체: `routes/daemonRoutes.js:90-98` `/e2ee/enroll|bootstrap|pending|approve|deny|keyring|rotate|policy|recovery`,
`services/deviceTrustService.js`, `device_approval_event` 팬아웃(`daemonRelayService.js:545`), `caps` 에 `e2ee.keys.v1`.

**PC(있음)** — `src-tauri/src/cptsock.rs:143-149 e2ee_local`(`e2ee.` 접두사만 통과) · `src/js/api.js:176 e2eeLocal` ·
`src/js/e2ee.js` 전체(상태·승인 시트·정책·복구코드·`sealedRpc`) · `src/js/remote-fs.js:43` 이 fs 를 봉투로 먼저 시도.

**앱(있음)** — `src/services/e2ee.ts:848-890 sealedRpc()` 가 `POST /api/daemon/rpc` 를 호출한다(계약이 헤더
주석 `:43` 에 명시). `daemonService.ts:308-323 sealedFs()` 가 fs 전 함수의 2순위 경로로 쓴다.

**없는 것**: back `POST /api/daemon/rpc` · 데몬 `cpt-server.js` 의 `e2ee.*` 커맨드 11개 ·
(숨은 전제) 데몬의 enroll/keyring 클라이언트 §2.6.

### 2.2 와이어 계약 — back `POST /api/daemon/rpc`

```jsonc
// 요청 (accountAuth: JWT | deviceToken)
POST /api/daemon/rpc
{ "hostDeviceId": 12,        // 옵셔널. 미지정 = 활성 러너(connOptsOf 규약과 동일)
  "timeoutMs": 15000,        // 옵셔널. 기본 15000, 상한 60000 으로 클램프
  "env": { "v":1, "suite":"cpt-e2ee/v1", "epoch":2,
           "nonce":"b64u12", "ct":"b64u" } }

// 성공 (successResponse → 본문이 곧 data. 앱 raw() 가 body.data 를 먼저 보므로 둘 다 안전)
200 { "env": { "v":1, "suite":"cpt-e2ee/v1", "epoch":2, "nonce":"b64u12", "ct":"b64u" } }

// 실패
409 { "success":false, "message":"PC 데몬이 연결되어 있지 않습니다.", "detail":{"code":"DAEMON_OFFLINE"} }
501 { "success":false, "message":"…", "detail":{"code":"E2EE_UNSUPPORTED"} }   // 구 데몬/데몬 OFF
502 { "success":false, "message":"…", "detail":{"code":"E2EE_OPEN_FAILED"} }   // 그 외 데몬 오류
400 { "success":false, "message":"봉투 형식이 올바르지 않습니다.", "detail":{"code":"BAD_ENVELOPE"} }
```

**back → 데몬 (제어 WS, 기존 rpc 프레임 그대로)**

```jsonc
{ "type":"rpc", "id":9, "method":"sealed",
  "params": { "env": { … },
              "hostDeviceId": 12 } }   // ★ 클라가 보낸 값 그대로(미지정이면 필드 생략/null)
{ "type":"rpc_result", "id":9, "ok":true, "result": { "env": { … } } }
{ "type":"rpc_result", "id":9, "ok":false, "error":"…", "code":"E2EE_OPEN_FAILED" }
```

봉투 평문(참고, 서버는 못 봄): 요청 `{"id":"uuid","m":"fs.read","p":{…},"ts":…}` /
응답 `{"ok":true,"r":{…}}` 또는 `{"ok":false,"e":"…","code":"…"}` [실측 `e2ee.js:997-1001`].

### 2.3 ★ hostDeviceId AAD 규칙 — 지금 코드대로면 봉투가 절대 안 열린다

[실측] 앱은 `hostDeviceId: host ?? null` 로 봉인한다(`daemonService.ts:318`) → AAD 에 `u32(0)`
(`e2eeProto.js:140-143`). 반면 데몬은 `hostDeviceId: e2eeGate.selfDeviceId()` **자기 id** 로 열려고
한다(`control.js:215`). 활성 러너 라우팅(host 미지정) 호출은 **AAD 불일치로 100% 복호 실패** →
`E2EE_OPEN_FAILED` → 앱이 UNSUPPORTED 로 캐시하고 평문으로 내려간다. 응답 레그도 대칭으로 깨진다.
= "켜도 안 켜지는데 안전한 평문으로 위장"(결함 #8과 동형).

**확정 규칙**

```
aadHostDeviceId = (클라가 요청 본문에 실은 hostDeviceId)  ?? 0
  · back 은 그 값을 **평문 형제 필드로 그대로** 데몬에 전달한다(봉투 안에 넣지 않는다).
  · 데몬은 params.hostDeviceId 로 AAD 를 재구성해 열고, **같은 값으로 응답을 봉인**한다.
  · params.hostDeviceId 가 명시돼 있고 selfDeviceId 와 다르면 → E2EE_HOST_MISMATCH 로 거절
    (서버가 다른 PC 로 몰래 라우팅한 경우 — beginHost 의 같은 가드 e2ee.js:693-696 미러).
  · 미지정(=0)은 "활성 러너 위임 = 라우팅 바인딩 포기"를 뜻한다. 키는 계정 전역이므로 기밀성은
    그대로지만 "어느 내 PC 로 갔는지"는 서버가 고를 수 있다. 클라이언트는 가능하면 항상 명시할 것.
```

**★ epoch 규칙 — 회전은 무효화여야 한다(2026-07-25 추가, 실측 결함)**

`e2ee.js` 는 옛 epoch 의 MK 를 **영구 보존**한다(`state.keys` — 옛 스냅샷·지난 알림 body 를 읽어야
하므로 `rotate()` 도 지우지 않는다). 그래서 봉투가 주장한 `env.epoch` 를 그대로 믿고 열면,
`e2ee.revoke` 로 세대를 회전한 뒤에도 **해제된 기기(또는 유출된 옛 복구코드) 보유자가 옛 epoch 로
봉인한 `fs.write` 봉투를 계속 실행시킬 수 있다** = 회전이 아무것도 무효화하지 않는다. 스트림 레그도
같았다(`beginHost` 가 `hasKey(ep)` 만 확인 → 옛 세대 세션을 새로 수립 가능).

```
· 실행을 유발하는 수립 지점은 **현재 세대만** 받는다:
    handleSealedRpc  : Number(env.epoch) === e2ee.epoch() 아니면 E2EE_EPOCH_MISMATCH
    beginHost        : hasKey(ep) && ep === 현재 epoch 아니면 E2EE_EPOCH_MISMATCH
· 옛 MK 는 **읽기 전용 복호**로만 쓴다(`e2ee.openText` 의 지난 알림 body · 구 스냅샷 복원).
  옛 세대 열쇠를 지우면 회전 전 알림/스냅샷이 영구히 🔒 가 되므로 삭제는 금지.
· 회전 직후 뒤처진 뷰어도 여기로 떨어진다. 실제 매핑은 5xx 가 아니라 **409**(`config/e2eeCodes.js`
  SEALED_CONTRACT)이고, 클라는 그 코드를 보고 **스스로 refresh 를 해야** 낫는다 — 아래 ★ 참조.
· back 은 `env.epoch` 를 `conn.e2eeEpoch` 와 대조해 **선택적으로** 미리 거절할 수 있다(왕복 절감).
  단 정본 판정은 데몬이다(서버는 열쇠를 모르므로 epoch 만 보고 판단하면 안 된다).
```

→ **데몬 `control.js:213-216` 수정이 갭 2의 필수 항목이다**(back 라우트만 만들면 안 된다).

### 2.4 PC 가 부르는 `e2ee.*` cpt.sock 커맨드 — 정확한 목록

[실측] `src/js/e2ee.js` 의 `cpt("…")` 호출 전량 + 그 파일 헤더 주석(:11-25)이 기대 응답까지 적어 뒀다.
Rust 는 `e2ee.` 접두사만 검사하고 그 밖의 필터는 없다(`cptsock.rs:143-149`).

| cmd | args | result(PC 가 읽는 필드) | 호출 위치 |
|---|---|---|---|
| `e2ee.state` | — | `{available, state, epoch, policy, scope, ikX, userRef, enrollmentId, recoverySet, reason,` **`keyState, checking, nextCheckInMs, phase, accountEpoch`**`}` — ★ 진행상태 정본은 굵은 필드다(아래 규약 3) | `e2ee.js:118` |
| `e2ee.pending` | — | `{pending:[{enrollmentId,label,platform,ikX,requestedAt,verifyCode?}]}` | `:129` |
| `e2ee.keyring` | — | `{epoch, devices:[{deviceKeyId,label,platform,ikX,state}]}` | `:131` |
| `e2ee.approve` | `{enrollmentId, ikX}` | `{ok:true}` (MK 봉인+서명+업로드까지 데몬이 수행) | `:160` |
| `e2ee.deny` | `{enrollmentId}` | `{ok:true}` | `:168` |
| `e2ee.policy` | `{policy:'off'\|'preferred'\|'required'}` | `{policy}` | `:177` |
| `e2ee.recovery.create` | — | `{code}` (1회 표시) | `:181` |
| `e2ee.recovery.restore` | `{code}` | `{ok:true, epoch}` | `:189` |
| `e2ee.revoke` | `{deviceKeyId}` | `{epoch}` (해제 + epoch 회전) | `:195` |
| `e2ee.rpc` | `{method, params, hostDeviceId, timeoutMs}` | `{ok:true, r}` \| `{ok:false, e, code}` | `:217` |
| `e2ee.openText` | `{text}` | `{text, locked}` (알림 body `cptenc:1:` 복호) | `:235` |
| `e2ee.bootstrap` | — | `{ok:true, epoch}` \| `{ok:false, error, code}` — 계정 최초 열쇠 생성. **사람이 버튼을 눌렀을 때만**(데몬 자동 호출 지점 0개) | PC `e2ee.js bootstrapAccount()` |

**응답 규약 3개(어기면 PC 가 조용히 오동작)**
1. 미지원/오류에서 **소켓 에러(ok:false)를 던지면** PC 는 `available=false, state='unsupported'` 로
   내려앉는다(`e2ee.js:76-85`) — 즉 "그 커맨드만 실패"가 아니라 **E2EE 전체가 미지원으로 표시된다**.
   따라서 정상적인 도메인 실패(예: 승인 대상 없음)는 `{ok:false, error}` **result 로** 회신할 것.
2. `e2ee.rpc` 는 성공했는데 결과가 비어도 `{ok:true, r:{}}` 를 돌려야 한다 —
   `null` 로 돌리면 PC 가 "미지원 폴백"으로 오해해 같은 변형(fs.write)을 **평문으로 한 번 더** 실행한다
   (`e2ee.js:221-227` 주석이 이미 경고).
3. ★ **진행상태의 정본 필드는 `keyState` + `checking` 이다. `state` 로 진행을 판정하면 조용히 죽는다**
   (2026-07-26 교차검증 실측). `state` 는 클라이언트 UI 도메인이고 **데몬 버전에 따라 도메인이 다르다**:
   - 좁은 도메인(2026-07-26 이전 `pcState()`): `{off, unsupported, bootstrap, pending, trusted, error}` —
     `'none'`/`'enrolled'` 를 **절대 반환하지 않는다**. 이 도메인만 존재했을 때 PC 의 `state==='none'`·
     `state==='enrolled'` 분기는 **도달 불가 죽은 코드**였고, 그래서 계정 열쇠 0개가 '준비 중' 으로 보였다.
   - 넓은 도메인(2026-07-26 `pcState(keyed,policy,checking)` 확장): `checking` 이면 `bootstrap`,
     아니면 `none`, 봉인문 대기는 `enrolled`. 구 클라는 모르는 값을 안전한 쪽으로 눕히므로 additive 다.

   → 클라이언트는 **`state` 값에 분기하지 않는다.** 두 도메인이 동시에 배포돼 있어도 같은 화면이어야 한다:

   | 실제 상황 | `keyState` | `checking` | `phase` | `state`(좁은/넓은) | 화면이 말해야 하는 것 |
   |---|---|---|---|---|---|
   | 아직 확인 중(왕복/재시도 예약) | `none` | **true** | `boot`/`enroll` | `bootstrap` / `bootstrap` | "확인 중"(대기색) |
   | 확인 끝 · 계정에 열쇠 0개 | `none` | **false** | `bootstrap` | `bootstrap` / **`none`** | "열쇠 없음"(꺼짐색) + **처음 켜기 버튼** |
   | 승인 대기 | `pending` | true | `pending` | `pending` / `pending` | "승인 대기" |
   | 봉인문(열쇠) 전달 대기 | **`enrolled`** | true | `pending` | `pending` / **`enrolled`** | "승인 대기" |
   | 취득 배관 없는 구 번들 | `none` | false | `no_enroll_client` | `bootstrap` / `none` | "열쇠 없음"(버튼 숨김 — 눌러도 실패) |

   두 번째 줄이 이 계약의 존재 이유다: 사람이 켜기 전엔 **영구 평문**인데 `state`(좁은 도메인)만 보면
   '준비 중'(곧 켜진다는 뜻의 대기색)으로 보인다 = 거짓 자물쇠의 다른 얼굴. `keyState` 가 **없는**
   응답(그보다 더 구 데몬)은 예전 판정을 유지한다(모르는 것을 '열쇠 없음' 으로 단정하지 않는다).
   판정 정본 구현: PC `src/js/e2ee-label.js selfStateLabel()/needsBootstrap()` — 설정 화면과 회귀
   테스트가 같은 함수를 본다. 회귀 테스트 2곳: `test/contract.mjs`(데몬 응답 JSON 하드코딩) ·
   `test/e2ee-crossimpl.mjs` §3(**실제 데몬 모듈 `e2ee-local.state()` 출력을 그대로 먹인다** — 한쪽만
   고쳐 놓고 양쪽이 초록이던 사고를 막는 유일한 장치).
   `phase==='bootstrap'` 에서는 PC 가 `e2ee.bootstrap` 버튼을 노출해야 한다 — 데몬은 자동 부트스트랩을
   하지 않으므로(헤드리스가 신뢰 기점을 세우면 폰만 든 사용자가 잠긴다) 버튼이 없으면 사용자는 그
   상태에서 스스로 벗어날 수 없다.

### 2.5 caps 문자열과 선언 조건

- back: **`e2ee.rpc.v1`** — `/api/daemon/rpc` 라우트가 존재하는 커밋에서만. `E2EE_ENABLED=0` 이면
  기존대로 `e2ee.keys.v1` 과 함께 선언하지 않는다.
- 데몬: 자동(`e2ee.js:1136 caps()` 가 `hasKey()` 일 때 `['e2ee.keys.v1','e2ee.rpc.v1']`) — **단 열쇠가
  생기려면 §2.6 이 먼저다.**
- 기기: 앱 `e2ee.ts` 의 `clientCaps()`, PC `e2ee.js:59-67 e2eeCaps()` — 이미 단계별로 쪼개 선언한다.
- **서버는 이 caps 로 라우트를 게이팅하지 않아도 된다** — 라우트가 없으면 404, 앱은 404/501 을
  UNSUPPORTED 로 10분 캐시(`e2ee.ts:830-836`)하므로 그 자체가 폴백이다.

### 2.6 숨은 전제(별 항목으로 반드시 세울 것) — 데몬에 enroll 클라이언트가 없다

[실측] `packages/**` 에서 `api/daemon/e2ee` 0건, `bootstrapMasterKey`/`acceptGrant` 호출자 0건,
`packages/daemon/index.js` 에 `e2ee` 문자열 0건, 격리 실행에서 `e2ee-gate.caps() === []`.
→ **데몬은 열쇠를 얻는 경로가 없다.** `e2ee.state` 를 구현해도 `state:'unsupported'` 밖에 못 준다.

그래서 갭 2 는 사실 두 조각이다:
- **2a** 봉투 프록시(back 라우트 + 데몬 AAD 수정) — 이 문서가 계약을 확정.
- **2b** 데몬 열쇠 클라이언트(`enroll` → pending 폴링/`device_approval_event` → grant 복호 →
  `e2ee.json` 저장, `approve`/`deny`/`rotate`/`policy`/`recovery` 업로드, 페어링 `pair/grant` 경로).
  이게 없으면 2a 는 **영원히 무발현**이다(PC 화면은 "미지원", 앱은 폰끼리만 봉인 가능).
  [추정] 2b 의 서버 계약은 앱 `e2ee.ts:30-46` 헤더 주석과 `deviceTrustService.js` 가 이미 정본이므로
  데몬은 그 REST 를 그대로 호출하면 된다(신규 서버 코드 불필요).

### 2.7 게이팅·폴백 규칙

```
back 라우트 없음(404)      → 앱: UNSUPPORTED 캐시 10분 → 평문 REST (fs/*) — 오늘의 동작
                            PC: sealedRpc null → remote-fs 평문 back_api 폴백
데몬에 sealed 핸들러 없음   → dispatchRpc 가 fs.handle 로 떨어져 throw → back 502 → 위와 같음
열쇠 없음(hasKey false)     → 클라 canSeal() false → 애초에 시도하지 않음(왕복 0)
policy='required'          → 폴백 금지. 앱 `gateReason()`/PC `e2eeGate()` 가 사유 문구를 던진다
복호 실패(회전 직후 등)     → 앱 DECRYPT_FAILED → refresh() 후 폴백 허용(`e2ee.ts:869-874`)
```

★ **폴백 판정 규칙(정본)** — policy≠'required' 이면 **봉투 계층의 모든 실패가 폴백 대상**이다.
코드 화이트리스트로 좁히면 안 된다: 열쇠 없는 PC 데몬(§2.6 2b 미구현 = 지금의 상시 상태)은
`E2EE_NO_KEY` 를 `control.js` 가 `E2EE_OPEN_FAILED` 로 뭉개 회신하고, back `SEALED_UNSUPPORTED` 에
그 코드가 없어 **502** 가 된다. 이때 폴백을 막으면 `fs.*` 가 봉인 단계에서 throw 되어 **뒤의 평문 REST
라인에 도달하지 못하고** IDE 트리·파일 열기·800ms 자동저장이 붉은 오류로 죽는다(= 자기 기기에서
잠긴다. `noteRpcUnsupported()` 10분 캐시 때문에 "10분마다 한 번 무작위 실패"로 보여 진단이 어렵다).

| 응답 | 폴백 | 이유 |
|---|---|---|
| 404 / 501 / 4xx / 5xx(E2EE_OPEN_FAILED·SEAL_FAILED·HOST_MISMATCH·REPLAY 포함) / 네트워크(0) | **허용** | 봉투가 왕복하지 못했다 = 평문 라인으로 계속 가야 한다 |
| 200 + `ok:false`(호스트 처리 실패) | **금지** | 호스트가 이미 실행했다 — 폴백하면 같은 변형(fs.write)을 평문으로 **이중 실행** |
| 200 + 복호 실패(DECRYPT_FAILED) | 허용 | 호스트 처리 결과가 아니다(에폭 회전 등) |
| policy='required' | 전부 금지 | 다운그레이드 공격 차단 |

앱 정본 = `e2ee/e2eeState.ts mayFallbackFor()`(회귀 테스트 `__tests__/e2ee.test.ts`). PC `e2ee.js` 도
같은 규칙이어야 한다. **가장 좋은 조치는 데몬이 '열쇠 없음'을 `E2EE_NO_KEY`/`E2EE_UNSUPPORTED` 로
회신하고 back 이 501 로 매핑하는 것**이지만, 클라이언트 폴백 규칙은 그와 **독립적으로** 위 표를 지켜야
한다(구 데몬·중간 배포 상태가 항상 존재한다).

★ **자물쇠 표시는 호스트별로** — `ready`(내 열쇠 보유)만 보고 '켜짐' 을 그리면 열쇠 없는 PC 로 가는
평문 트래픽이 사용자에게 안 보인다(거짓 자물쇠). back 은 이미 `runner_status.e2eeEpoch`
(`daemonRelayService.js:79/219`, 0=열쇠 없음)를 팬아웃한다 — 클라이언트는 이 값을 받아 PC 별 배지를
그린다. 앱 구현: `e2ee/hostLock.ts` + `e2eeState.ts hostLockLabel()`, 라벨은 '이 기기 준비됨' /
PC 별 '암호화됨 | 이 PC 는 평문(열쇠 없음) | 확인 중'.

★ **자물쇠는 세대(epoch)까지 교집합이다 + 회전 자가복구는 클라 책임**(2026-07-25 교차검증 실측, 앱 반영 완료)

`hostEpoch > 0` 만 보고 '암호화됨' 을 그리면 **회전 직후 최대 15분간 거짓 자물쇠**다: 데몬은 회전을
push 없이 폴링으로만 감지하므로(`e2ee-account.js` TRUSTED_MS=15분) back 이 팬아웃하는
`runner_status.e2eeEpoch` 는 그 동안 옛 세대다. 그 사이 클라가 새 세대로 봉인하면 데몬이
`E2EE_EPOCH_MISMATCH` → back **409** → `mayFallbackFor`=true → **평문 REST** 인데 배지는 초록이었다.

```
표시  : hostLockLabel(selfReady, hostEpoch, myEpoch)
        myEpoch>0 && hostEpoch>0 && myEpoch !== hostEpoch  → '확인 중'(tone wait)  ★ '암호화됨' 금지
        myEpoch 미지(=0/undefined)                          → 대조 생략(구 호출부 호환)
자가복구(둘 다 필요 — 하나만으론 포그라운드 고착이 남는다)
  ① device_approval_event 의 kind:'rotated' | 'policy' | 'bootstrapped' 수신 → 즉시 refresh()
     (back deviceTrustService.js:504/696/722 가 **이미** 팬아웃한다 = 새 배관 0)
  ② sealedRpc 가 code==='E2EE_EPOCH_MISMATCH' 를 받으면 refresh() 1회 발사(억제창 20s — IDE 트리·
     800ms 자동저장이 초당 여러 번 봉인하므로 실패마다 부르면 왕복 폭주)
  ③ 이 코드는 UNSUPPORTED 네거티브 캐시(10분)에 **넣지 않는다**. 넣으면 갱신을 끝냈는데도 10분간
     봉인을 시도하지 않아 전부 평문이다. 반대로 새 세대 grant 채택 성공 시엔 캐시를 즉시 만료시킨다.
```

정본: 앱 `e2ee/e2eeState.ts hostLockLabel()` · `e2ee.ts dispatchDeviceApprovalEvent`/`sealedRpc`
(회귀 `__tests__/e2eeRotate.test.ts`). **PC `src/js/host-lock.js` + `src/js/e2ee.js` 도 같은 규칙·같은
문구여야 한다.** 데몬 쪽 근본 해결(회전 push → `e2ee-account.resync()`)은 이 클라 처방과 별개로 필요하다.

★ **`runner_status` 는 캐치업이 필수다(2026-07-25 추가)** — 팬아웃 시점은 러너 **연결 시**와 hello 의
**값 변화 시** 둘뿐이다. 그래서 데몬이 이미 붙어 있는 정상 상태에서 앱을 다시 열거나 PC 를 재시작하면
프레임이 0건이고, 클라 `hostLock` 이 빈 채로 남아 배지가 **'확인 중' 에 영구 고착**한다(다음 데몬
재접속까지 수 시간~수 일) = 거짓 자물쇠를 드러내려고 만든 배지가 진실을 한 번도 못 보여준다.
계약(구현 완료):

```
back  : ui_hello 수신 시 replayAgentStates 옆에서 replayRunnerStatus(userId, ws)
        → 붙어 있는 러너마다 { deviceId, online:true, kind, deviceName, e2eeEpoch, lanCapable,
          lanEpoch, replay:true } 를 **그 화면에만** 전송(팬아웃 아님).
          · online:true 로만 보내므로 오프라인 오탐이 원리적으로 불가능(applyLanInfo 선례)
          · 열쇠 없는 호스트도 e2eeEpoch:0 으로 반드시 보낸다(안 보내면 그 PC 만 '확인 중' 이 남는다)
          · replay:true 는 additive — 구 클라이언트는 모르는 필드를 무시한다
클라  : (보강) GET /api/daemon/status 응답의 runners[].e2eeEpoch(이미 내려온다 — listRunners)로 시드해도
        같은 구멍이 닫힌다. 두 경로는 상호 배타가 아니다.
순서  : hostLock 을 agent_state 처럼 "재접속·포그라운드 복귀 시 전량 폐기" 규율에 넣는 것은
        **리플레이/시드가 생긴 뒤에만** 한다. 시드 없이 리셋만 넣으면 고착이 악화된다.
```

**서버 불변식(테스트로 고정할 것)**: back 은 `env` 를 파싱·기록·재작성하지 않는다. `env.ct` 를 로그에
남기지 않는다. 응답은 데몬이 준 `env` 를 **그대로** 담는다. 즉 `POST /api/daemon/rpc` 핸들러에
`JSON.parse(...ct)` 류가 등장하면 계약 위반이다.

### 2.8 패키지별 편집 지점

| 패키지 | 파일:줄 | 무엇을 |
|---|---|---|
| back | `routes/daemonRoutes.js:98` 아래 | `router.post('/rpc', accountAuth, daemonController.rpcSealed);` |
| back | `controllers/daemonController.js:845` 근처 | `rpcSealed()` — env 얕은 검증 → `callRpc(req.user.id,'sealed',{env,hostDeviceId},clamp,connOptsOf(req))` → `successResponse(res,{env})`; 오류 코드→상태 매핑(§2.2) |
| back | `config/caps.js` | `e2ee.rpc.v1` |
| back | `test/e2ee-crossimpl.test.js` | "back 은 env 를 열지 않는다"(중계 동일성) + 코드 매핑 |
| back | `daemonRelayService.js` `replayRunnerStatus` + `ui_hello` 분기 | (2026-07-25 반영 완료) 붙어 있는 러너의 `e2eeEpoch` 를 그 화면에만 캐치업 — 없으면 배지가 '확인 중' 영구 고착(§2.7) |
| daemon | `control.js:213-216` | AAD 를 `params.hostDeviceId ?? 0` 로 재구성 + host mismatch 거절 + 응답 봉인에 같은 값 |
| daemon | `cpt-server.js:454` 옆(resolveCtx 전) | `if (cmd.startsWith('e2ee.')) return e2eeLocalCmd(cmd, req.args||{});` — **CAPABILITIES 비공개**(내부용) |
| daemon | 신규 `runner-core/e2ee-account.js`(2b) | enroll/pending/approve/deny/keyring/rotate/policy/recovery + grant 수신·저장(backFetch 사용) |
| daemon | `test/e2ee-gate.test.js` 확장 | AAD 0/명시 두 경우 왕복 + mismatch 거절 |
| PC | `src/vendor/e2ee/e2ee-proto.js` + `src/js/e2ee.js` | 지문 오프셋을 §2.10 정본으로 교정 · `safetyCode` default export 추가 · 승인 UI 대조 대상을 safetyCode 로(앱과 동일 규율) |
| app | (2026-07-25 반영 완료) | `e2eeProto.js` 오프셋 교정 + safetyCode 노출 · `envNonce.ts` 지연 부팅난수(0 nonce 사고) · `mayFallbackFor` 502 계열 폴백 허용 · `hostLock.ts` 호스트별 자물쇠 · **회전 자가복구**(hostLockLabel 3인자 epoch 대조 · `kind:'rotated'/'policy'/'bootstrapped'` → refresh · 409 EPOCH_MISMATCH → refresh(20s 억제)+캐시 제외) |

### 2.9 이 계약을 깨면 어떻게 조용히 죽는가

AAD 의 `hostDeviceId` 를 양쪽이 다르게 계산하면 모든 봉투가 복호 실패하고, 클라이언트는 그것을
"서버 미지원"으로 캐시해 평문으로 내려간다 — 잠금 배지는 켜져 있고 트래픽은 평문이다.

### 2.10 사람이 대조하는 값의 파생 — **4구현체 정본**(2026-07-25 확정)

```
okm = HKDF-SHA256(ikm = ikX(32B 공개키), salt = "cpt-e2ee/v1/fp", info = utf8(userId), len = 16)
safetyCode   = okm[0..8] 의 상위 60비트 → Crockford base32 12글자 → "K7M2-9QXF-B4TR"   ← ★ 대조 대상
fingerprint6 = u32BE(okm[8..12])  % 10^6 → "418 209"   (기기 목록 감사 표기)
verifyCode4  = u32BE(okm[12..16]) % 10^4 → "0878"      (요청 구분용 — **보안값 아님**)
```

- 정본 구현: 데몬 `runner-core/e2ee.js fingerprint()`(safety/legacy/short) · back
  `deviceTrustService.js fingerprintOf()`. 앱 `e2ee/e2eeProto.js` 는 2026-07-25 에 이 오프셋으로 교정됨.
  **PC `src/vendor/e2ee/e2ee-proto.js` 는 앱 파일의 바이트 동일 사본이어야 한다** — 같이 고칠 것.
- 깨졌을 때의 조용한 죽음: 앱/PC 가 `okm[0..4]` 를 쓰던 동안 표시값이 데몬/back 과 **200/200 불일치**
  였고, 그러면 `pickCode` 규칙에 따라 화면이 **항상 서버가 준 숫자**를 그리며 `verified=false` 가 된다
  → (a) 정상 승인마다 경고가 떠 사용자가 경고를 무시하도록 학습되고 (b) 표시값을 서버가 지배하므로
  "두 화면 숫자 대조" 방어가 통째로 사라진다.
- **대조는 60비트 `safetyCode` 로 한다.** 4자리(13비트)는 서버가 자기 키쌍으로 같은 값을 1코어
  1.3초(실측 2,587회/155ms)에 만들 수 있어 방어력이 없다 — 승인 UI 에서 4자리는 "요청 번호(구분용)"
  으로 작게, 문구로 대조 금지를 명시한다. 앱: `E2eeStatus.safetyCode` / `PendingDevice.safetyCode`,
  `DeviceTrustCard`·`E2eeSettingsCard` 가 이 값을 그린다.
- 교차 검증: 앱 `scripts/e2ee-conformance.mjs`(실제 데몬 모듈 로드, jest `e2eeConformance.test.ts` 가
  호출) 가 safety/legacy/short 3값을 각각 대조한다. back `test/e2ee-crossimpl.test.js` 는 back↔데몬만
  비교하므로 앱/PC 의 오프셋 사고를 **잡지 못했다** — 앱/PC proto 를 import 하는 케이스 추가 권장.

### 2.11 데몬 열쇠 클라이언트 불변식 — 2026-07-26 적대적 교차검증에서 확정

전부 "화면은 자물쇠, 트래픽은 평문" 방향의 실측 결함을 닫은 규칙이다. 회귀 테스트 정본 =
`codingpt_daemon/packages/runner-core/test/e2ee-hardening.test.js`(15 케이스).

1. **열쇠 사실이 바뀌는 모든 전이는 hello 를 재신고한다**(`notifyKeyChange` → `control.announceHello`).
   전이 목록: `acceptGrant` · `revoke` · `rollbackEpoch` · `bootstrap` · **`handleRevoked`(해제)** ·
   **`recoveryRestore`(복원, `e2ee-account.noteKeyChanged()` 경유)** · **`setPolicy`(off/on = caps 회수·복귀)**.
   back 이 `runner_status.e2eeEpoch` 를 재팬아웃하는 지점은 러너 연결과 hello 수신 둘뿐이라, 빠뜨리면
   다음 재접속(수 시간)까지 배지가 거짓말을 한다 — 해제 후 '암호화됨', 복원 후 '평문' 양방향.
2. **정책은 단조 강화로만 서버를 따라간다**(`adoptPolicy`). 로컬이 `off`/`required` 인데 서버가 더 약한
   값을 말하면 **채택하지 않는다.** 근거: `required` 의 서버 동기화는 구조적으로 항상
   409 `RECOVERY_REQUIRED`(back 은 복구 blob 을 요구하고, 그 blob 을 올리는 구현체는 3구현체 동치
   규율상 의도적으로 없다) → 무조건 따라가면 사용자가 켠 '항상' 이 15분 뒤 조용히 강등된다.
   동기화 실패는 **무음 금지** — `e2ee.state.reason` 으로 "복구 코드가 필요합니다" 를 내보낸다.
3. **`policy='off'` 는 반쪽 스위치가 아니다**: `e2ee.caps()` 가 `[]` 를 돌려주고(hello 재신고로 back 의
   `conn.caps`·`e2eeEpoch` 즉시 회수) `handleSealedRpc` 도 `E2EE_DISABLED`(501)로 거절한다.
   단 `openText`(지난 알림 body 복호)는 policy 와 무관하게 남긴다 — 끄면 과거 알림이 영구 🔒 가 된다.
4. **봉투 실패 코드를 뭉개지 않는다**: `openRpc` catch 는
   `E2EE_NO_KEY`·`E2EE_REPLAY`·`E2EE_EPOCH_MISMATCH`·`E2EE_HOST_MISMATCH` 를 **보존**하고 그 밖만
   `E2EE_OPEN_FAILED` 로 일반화한다(문구는 계속 일반화 — 경로·내용 누출 금지). 보존하지 않으면 back
   `config/e2eeCodes.js` 의 409 매핑이 **도달 불가 항목**이 되고, 리플레이(보안 이벤트)가 502 로 나가
   앱의 10분 UNSUPPORTED 캐시를 켠다 = 리플레이가 곧 다운그레이드 스위치가 된다.
5. **서버 OFF 판정은 `detail.code` 로 한다**(status 아님): `E2EE_DISABLED` 또는 404 만 1시간 동면이고,
   그 밖의 503(`KEYRING_UNAVAILABLE`·`KEYRING_WRITE_FAILED`·프록시 503)은 일시 장애 백오프(≤5분)다.
   오진하면 그 사이 폰에서 승인해도 최대 1시간 평문으로 남고(승인 결과는 pull 이 유일 경로) 화면에는
   '서버에서 꺼져 있어요' 라는 거짓 진단이 뜬다.
6. **백오프는 kind 별로 보관한다**(`st.delays[kind]`). 하나만 두면 `resolved↔pending` 교대에서 prev 가
   매번 0 으로 리셋돼 재신청이 10분 고정으로 굳고, back 이 그때마다 승인 요청 푸시를 다시 쏜다.
   리셋은 **열쇠 취득 성공에서만**. 회귀 테스트는 순수 함수가 아니라 `runOnce` 반복의 간격 수열을 본다.
7. **PC 의 60초 조회는 폴링 게이트를 우회하지 않는다**: `pending`/`keyring` 은 루프가 한 번도 관여하지
   않았거나(`!started && lastRunAt===0`) `phase==='off'` 면 왕복 없이 마지막 스냅샷을 돌려준다.
   조회 실패에는 네거티브 캐시(킬스위치·404 = 1시간 / 일시 장애 = 5분)를 적용한다.
8. **열쇠 파일은 원자적으로 쓰고, 손상본은 덮어쓰지 않는다**: `config.saveE2ee` = tmp+fsync+rename,
   `config.readE2ee` 가 '없음' 과 '파싱 실패' 를 구분해 손상본 사본(`e2ee.json.corrupt-<ts>`)을 남기고
   `ensureIdentity` 는 `E2EE_STATE_CORRUPT` 로 **실패**한다(blankState 로 덮어쓰면 신원키와 전 세대 MK 가
   백업 없이 영구 소실 = 폰에 뜬금없는 새 기기 승인 요청 + 과거 알림/스냅샷 영구 🔒).
9. **`e2ee.state` 도 규약① 을 지킨다**: 상태 파일을 읽고 쓸 수 없으면 throw 하지 않고
   `{available:true, state:'error', reason:…}` 를 회신한다(pending/keyring 과 동일). `userRef` 는 첫 기동에
   파일로 영속되고 조회 시 동기 복원되며, **모를 때는 파생값(safetyCode/fingerprint/verifyCode)을
   내보내지 않는다**(null) — 틀린 안전코드를 그리면 사람 대조라는 유일한 MITM 방어가 무력화된다.

---

## 갭 3 — E2EE 스트림 `sid` 주입 (기능2 D단계)

### 3.1 양쪽 끝 현황

**호스트 레그(데몬, 완비)**
- `pty.js:350 openPtyStream` → `:357` `const sid = params.sid || params.e2ee?.sid` → `wsPtyIo(ws,sid)`;
  세션을 못 찾으면 **평문으로 흘리지 않고** `ws.close(4090,'E2EE_SESSION_UNKNOWN')`(:367-370).
- `proxy.js:96` 동일 패턴(tcp 레그), `forward.js:33-34, 192-193`(뷰어측 리스너 = PC 앱).
- 세션 확정: `control.js:425 e2ee.begin` → `e2ee.js:684 beginHost()` →
  `{sid, pub, nonce, confirm, epoch, suite, expiresAt}`; 세션 TTL 24h(`e2ee.js:66`), 프로세스 로컬.

**뷰어 레그**
- 앱: 프레임 코덱 완비(`e2ee/e2eeProto.js:301-366 deriveSession/sealFrame/openFrame`) 그러나
  **`startTerminal` 이 offer 를 보내지 않는다**(`daemonService.ts:218-227` — body 에 `e2ee` 없음)
  → 현재 활성화 불가.
- PC: 원격 터미널/포워딩의 MK 는 **데몬**에 있다(JS 에 없음) → 뷰어 offer 도 데몬이 만들어야 한다.
  `createViewerOffer`(:730)/`acceptHostAnswer`(:750)는 있으나 **호출자가 없다.**

**없는 것**: back 의 선협상 + 토큰 params 에 `sid` 주입. (그리고 뷰어측 발신 배관 — §3.5)

### 3.2 스트림 토큰을 발급하는 코드(파일:줄로 특정)

| 레그 | 컨트롤러 | 토큰 발급 | 토큰 소비(스트림 오픈) |
|---|---|---|---|
| 터미널(JWT) | `daemonController.js:784 startTerminal` (route `daemonRoutes.js:37`) | `daemonRelayService.js:919 issueTerminalToken` | `:955 handleAppTerminalUpgrade` → `:972 openStream('pty', {cols,rows,cwd,paneId,win,client})` |
| 터미널(deviceToken=PC) | `daemonController.js:444 daemonTerminalStart` (route `:33`) | 같음 | 같음 |
| 포워딩 | `daemonController.js:1248 forwardStart` (route `:131`) | `daemonRelayService.js:1001 issueForwardToken` | `:1026 handleForwardUpgrade` → `:1036 openStream('tcp', {port})` |
| 토큰 저장소 | `termTokens`(TTL 1h, `:34`, resolve 시 연장 `:946-951`) / `fwdTokens`(TTL 1h, `:997`) | | |

### 3.3 와이어 계약

```jsonc
// ① 클라(뷰어) → back : 기존 start 라우트에 additive 필드 1개
POST /api/daemon/terminal/start
{ "cwd":"proj/a", "paneId":"p1", "win":3, "client":"<clientKey>", "hostDeviceId":12,
  "e2ee": { "suite":"cpt-e2ee/v1", "epoch":2, "pub":"b64u32", "nonce":"b64u32" } }

// ② back → 데몬 (제어 WS, 이미 데몬이 처리하는 메서드)
{ "type":"rpc", "id":7, "method":"e2ee.begin",
  "params": { "purpose":"pty", "transport":"relay", "suite":"cpt-e2ee/v1", "epoch":2,
              "pub":"b64u32", "nonce":"b64u32", "client":"<clientKey>", "hostDeviceId":12,
              "routing": { "cwd":"proj/a", "paneId":"p1", "win":3 } } }

// ③ 데몬 → back : beginHost() 결과 그대로
{ "sid":"b64u32", "pub":"b64u32", "nonce":"b64u32", "confirm":"b64u32",
  "epoch":2, "suite":"cpt-e2ee/v1", "expiresAt":"2026-07-26T…Z" }

// ④ back → 클라 : 토큰 + 답변(sid 포함). 협상 실패는 e2ee:false + 사유
200 { "token":"dterm-…",
      "e2ee": { "sid":"…","pub":"…","nonce":"…","confirm":"…","epoch":2,"suite":"cpt-e2ee/v1" } }
200 { "token":"dterm-…", "e2ee": false, "e2eeReason":"E2EE_SCOPE" }

// ⑤ back → 데몬 (스트림 오픈 시) : params 에 sid 만 추가(호스트 레그가 이미 읽는다)
{ "type":"stream_open", "streamToken":"ds-…", "kind":"pty",
  "params": { "cols":80,"rows":24,"cwd":"proj/a","paneId":"p1","win":3,"client":"…","sid":"b64u32" } }
```

포워딩은 동일하되 `purpose:"tcp"`, `routing:{port}`, 응답은 `{token, port, e2ee}`.

**주의 4개**
0. **길이는 고정이다** — 위 `b64u32` 는 "**32바이트**를 b64u 로 쓴 것"(패딩 없는 43글자)이다.
   `pub`(X25519 공개키)·`nonce`(뷰어/호스트 난스)·`sid`·`confirm` 모두 32B 다. 데몬 `beginHost` 는
   `bytes(p.pub,32)`/`bytes(p.nonce,32)`(`e2ee.js:112, :719-723`)로 잘라 길이가 다르면
   `E2EE_ENCODING` 을 던진다. 그래서 back `normE2eeOffer`(`daemonRelayService.js:452`)도 **디코드해서
   정확히 32B 인지** 확인하고 아니면 begin 왕복 없이 `E2EE_BAD_OFFER` 로 접는다 — 문자 수만 세면
   16B 난스가 통과해 왕복을 낭비하고 결과는 아무 신호 없는 `e2ee:false`(= 평문 스트림)가 된다.
   뷰어를 새로 붙이는 사람은 **32바이트 CSPRNG 난스**를 만들어야 한다(앱 `streamSession` 의
   `nonceViewer`/`privViewer`/`pubViewer` 는 호출자가 만들어 넣는 값이다).
1. `routing`·`client`·`hostDeviceId` 는 **트랜스크립트에 묶여 있다**(`e2ee.js:558-573`,
   앱 `e2eeProto.js:301-317`). back 이 여기 값을 요청과 다르게 채우면 뷰어의 `confirm` 검증이
   실패한다(그게 다운그레이드 방어의 전부다). 즉 **토큰에 저장하는 값과 begin 에 보내는 값이
   같아야 한다.**
2. `e2ee.begin` 은 **스트림을 열 그 conn** 으로 보내야 한다(`callRpc(..., opts)` 의 `runnerId` =
   `issueTerminalToken` 이 검증한 `rid`). 다른 러너로 가면 sid 는 그 러너에만 등록되고
   스트림은 4090 으로 죽는다.
3. `sid` 는 비밀이 아니라 **세션 식별자**다(키는 okm 의 다른 구간). 서버가 알게 되는 것은 설계상
   불가피하고 허용된다.

### 3.4 언제 begin 을 부르는가 / 캐시 수명

| 항목 | 확정 |
|---|---|
| 호출 시점 | **토큰 발급 1회**(스트림 연결마다 아님). 터미널 = `issueTerminalToken` 직전, 포워딩 = `issueForwardToken` 직전 |
| 저장 | `termTokens.get(token).e2ee = { sid }` / `fwdTokens` 동일. `resolveTermToken`(:946) 이 그대로 실어 준다 |
| 재사용 | 같은 토큰의 **모든 연결**이 같은 sid 를 쓴다. 연결별 격리는 `connId`(연결마다 난수)가 담당 → TCP 연결 수십 개(프리뷰 에셋)에도 **추가 RTT 0** |
| 수명 | 토큰 TTL 1h(접근 시 연장) < 데몬 세션 TTL 24h(`e2ee.js:66`) → 정상 경로에서 세션이 먼저 사라지는 일은 없다 |
| 타임아웃 | begin RPC 8000ms [추정 — 설계서 §4.1 권고값. `callRpc` 기본은 15s] |
| 데몬 재기동 | 세션 전멸(프로세스 로컬) → 스트림이 `4090 E2EE_SESSION_UNKNOWN` 으로 닫힘 → **클라이언트는 토큰을 재발급**해야 한다(재연결만 하면 영구 실패). 기존 "토큰 재발급 복구" 경로 재사용 |

### 3.5 폴백 규칙 — 절대 스트림을 죽이지 말 것

```
정책 = preferred (오케스트레이터 확정). required 로 만들지 않는다.

body.e2ee 없음                         → 오늘과 100% 동일(sid 미주입, 평문)
begin 이 throw/timeout/E2EE_* 반환      → 토큰은 **정상 발급**하고 { e2ee:false, e2eeReason:<code> }
서버 caps 에 e2ee.stream.v1 미선언      → begin 자체를 시도하지 않는다
데몬이 stream 스코프 미달(scope=rpc)    → handleE2eeBegin 이 E2EE_SCOPE 로 거절(control.js:193-196) = 안전한 폴백
대상 데몬 오프라인                      → 기존 409 경로(begin 실패와 구분해야 한다)
4090 수신                              → 재연결 금지, 토큰 재발급 1회(그 다음은 평문 토큰)
```

`e2eeReason` 값은 데몬 코드가 정본: `E2EE_UNSUPPORTED`(모듈 없음) · `E2EE_DISABLED`(CPT_E2EE=0) ·
`E2EE_SCOPE`(스트림 단계 미개방) · `E2EE_EPOCH_MISMATCH` · `E2EE_HOST_MISMATCH` [실측 `control.js:183-201`, `e2ee.js:686-696`].

### 3.6 caps 문자열과 선언 조건

- back: **`e2ee.stream.v1`** — ④의 응답과 ⑤의 params 주입이 함께 있는 커밋에서만.
  이 문자열을 먼저 선언하면 데몬 `e2ee-gate.js:109` 가 스트림 능력을 광고하고 클라이언트가
  봉인 프레임을 보내기 시작하는데 back 이 sid 를 안 실어 → 호스트가 `4090` 으로 닫는다
  = **터미널이 열리지 않는 회귀**(이 갭에서 가장 위험한 오작동).
- 데몬: `CPT_E2EE_SCOPE=stream` 이상일 때 자동(`e2ee-gate.js:109`).
- 기기: PC `e2eeCaps()`(`e2ee.js:65`) / 앱 `clientCaps()` — 스코프 `stream` 일 때만.

### 3.7 패키지별 편집 지점

| 패키지 | 파일:줄 | 무엇을 |
|---|---|---|
| back | `daemonRelayService.js:394` 근처 | `beginE2ee(userId, purpose, params, opts)` — `callRpc(...,'e2ee.begin',…,8000,opts)` 래퍼, throw 면 `null` |
| back | `daemonRelayService.js:919 issueTerminalToken` | 5번째 인자 뒤에 `e2ee:{sid}` 를 termTokens 엔트리에 보관 |
| back | `:955-990 handleAppTerminalUpgrade` | `openStream(..., { …, sid: sess.e2ee?.sid })` — **early 버퍼/bridge 로직은 한 줄도 건드리지 않는다**(첫 resize 유실 = 80x24 고착 근원) |
| back | `:1001 issueForwardToken` / `:1026-1048` | 동일 패턴(`purpose:'tcp'`) |
| back | `controllers/daemonController.js:784, :444, :1248` | `body.e2ee` 수신 → `beginE2ee` → 응답에 `e2ee` 블록 or `e2ee:false + e2eeReason` |
| back | `config/caps.js` | `e2ee.stream.v1` |
| back | `daemonRelayService.js` `normE2eeOffer` | (2026-07-25 반영 완료) `pub`/`nonce` 를 디코드해 **정확히 32B** 확인, 아니면 왕복 0회로 `E2EE_BAD_OFFER`(§3.3-0) |
| daemon | — | 호스트 레그 **무수정**. (뷰어측은 아래 열린 질문) |
| app | `services/daemonService.ts:218-227` | `startTerminal` 이 offer 를 실어 보내고 `{token, e2ee}` 를 반환 |
| app | `components/module/ide/TerminalWebView.tsx:70-90, 207-265` | xterm 로컬 vendoring 선행 + WebView 안 seal/open. **25s keepalive resize 유지** |

### 3.8 [열린 질문] PC 뷰어의 offer 를 누가 만드는가

MK 는 데몬에만 있으므로 offer(`createViewerOffer`)도 데몬이 만들어야 하는데, back 의 `/forward/start`·
`/terminal/start` 를 부르는 주체는 PC JS 다(`pane.js`, `api.js`). 세 가지 형태가 가능하다 [추정]:

- (A) **데몬이 협상까지 대행**: cpt.sock `forward.start` 에 `{hostDeviceId, negotiate:true}` 를 받아
  데몬이 `backFetch('/api/daemon/forward/start', {…, e2ee: offer})` → `acceptHostAnswer` →
  `startLocalForward({token, e2ee:{sid}})`. 기존 `{port,token}` 경로는 그대로 유지(폴백).
- (B) `e2ee.streamBegin` 커맨드 신설: PC JS 가 offer 를 데몬에서 받아 back 에 넘기고 answer 를 다시
  데몬에 되돌려 세션을 등록. 왕복 2회, PC JS 가 answer 를 만지지만 키는 안 만진다.
- (C) PC 원격 터미널/프리뷰는 D단계에서 제외(모바일만 먼저).

권고는 (A) — `forward.js` 가 이미 `e2ee.sid` 를 받을 준비가 돼 있고(`:33-34`) 토큰도 데몬이 이미
back REST 를 직접 부르는 선례가 있다(§5). 단 **cpt-server `forward.start` 계약 변경**이 필요하므로
갭 4 의 `upstream` 전달 수정과 한 커밋에 묶는 것이 안전하다.

### 3.9 이 계약을 깨면 어떻게 조용히 죽는가

`e2ee.stream.v1` 을 sid 주입보다 먼저 선언하면 클라이언트가 봉인 프레임을 보내고 호스트는 세션을
못 찾아 `4090` 으로 닫으므로 — **터미널이 아무 메시지 없이 계속 재연결만 하는 상태**가 된다.

---

## 갭 4 — PC LAN 직결 (기능4)

### 4.1 양쪽 끝 현황

**데몬(있음)**
- `runner-core/lan.js` — 호스트 리스너(사설 주소 바인드·challenge-response·IP 차단), 뷰어
  `connect()`(:741)/`probe()`(:947), 경로 상태 `pathKey`(:984)/`pathState`(:992)/`shouldTry`(:998)/
  `noteProbeOk`(:1002)/`noteSuccess`(:1015)/`noteHardFail`(:1033)/`noteSoftFail`(:1035)/`revive`(:1043)/
  `pathSnapshot`(:1051), 메서드 울타리 `rpcAllowed`(:93 + 목록 :73-74 — `fs.`/`net.`/`terminal.`/`ws.`
  접두사 허용, `fs.watch`/`fs.unwatch`/`sealed`/`e2ee.*` 영구 거부).
- `forward.js` — `upstream` 처리 **완비**: `normalizeUpstream`(:69, 사설 주소 아니면 무시),
  `handleConn`(:92, 쿨다운이면 시도조차 안 함), `handleConnLan`(:129, 첫 바이트 전 실패면
  **버퍼 승계해 그 연결만 릴레이**), `handleConnRelay`(:181, 기존 경로 무수정).
- `control.js:102-172` — hello 에 `lan: lanInfo()`, `lan_grant` 수신(:381), `lan_update` 발신,
  리스너는 서버 `lan.v1` 확인 후에만 기동(:371-374).

**back(있음)** — `POST /api/daemon/lan/grant`(route `daemonRoutes.js:157`, 레이트리밋 60/15분),
`daemonController.js:1267 lanGrant`, `daemonRelayService.js:1085 issueLanGrant`(scope = 서버 ∩ 클라 ∩ 데몬,
데몬 사전 통지 실패 시 grant 폐기), `applyLanInfo`(:1058), `config/lanDirect.js`(fail-closed 스위치).

**PC(있음)** — `cptsock.rs:93 lan_probe` / `:101 lan_status` / `:109 lan_rpc` / `:64 forward_start(upstream)`,
`api.js:166-171`, `src/js/lan.js` 전체(grant 캐시·쿨다운·배지·`required` 가드 :176).

**없는 것 (3곳)**
1. 데몬 `cpt-server.js` 의 `lan.probe` / `lan.status` / `lan.rpc` 핸들러 — 전부 부재
   [실측: `grep "lan\." cpt-server.js` 0건].
2. **`forward.start` 가 `upstream` 을 버린다** — `cpt-server.js:436-447` 은 `req.args.upstream` 을 읽지
   않고 `startLocalForward({serverUrl, port, token})` 만 부른다. Rust 는 이미 `args["upstream"]` 을
   싣는다(`cptsock.rs:69-75`). → **LAN 직결이 死文인 진짜 이유는 이 한 줄이다**(핸들러 3개보다 앞선다).
3. 데몬이 **뷰어로서 grant 를 받아 오는 코드**(`backFetch('POST','/api/daemon/lan/grant')` 호출자 0건).

### 4.2 와이어 계약 — cpt.sock 내부 커맨드 3개

Rust 주석의 기대 형태를 그대로 따른다(`cptsock.rs:91-118`).

```jsonc
// ── lan.probe ──  {hostDeviceId} → 왕복 측정 1회
req  { "id":1, "cmd":"lan.probe", "args":{ "hostDeviceId":12 } }
ok   { "id":1, "ok":true, "result":{ "ok":true, "rttMs":7, "endpoint":{"host":"192.168.0.31","port":47321} } }
ok   { "id":1, "ok":true, "result":{ "ok":false, "code":"LAN_UNREACHABLE" } }   // 실패도 ok:true 로 감싼다

// ── lan.status ──  {hostDeviceId} → 경로 스냅샷(배지 전용)
req  { "id":1, "cmd":"lan.status", "args":{ "hostDeviceId":12 } }
ok   { "id":1, "ok":true, "result":{
         "mode":"lan",                        // lan|probing|relay|cooldown|unsupported
         "hostDeviceId":12,
         "endpoint":{"host":"192.168.0.31","port":47321},   // 있으면
         "since":1753432800000, "cooldownUntil":0,
         "scopes":["tcp"] } }

// ── lan.rpc ──  {hostDeviceId, method, params} → LAN RPC 1건 왕복
req  { "id":1, "cmd":"lan.rpc", "args":{ "hostDeviceId":12, "method":"fs.read", "params":{"path":"a.ts"} } }
ok   { "id":1, "ok":true, "result":{ "ok":true, "result":{…} } }
ok   { "id":1, "ok":true, "result":{ "ok":false, "code":"LAN_SCOPE", "error":"…" } }
```

**PC JS 가 실제로 분기하는 값**(`src/js/lan.js`)이 계약의 정본이다:
- `lanStatus` → `r.mode === "lan"` 만 본다(:149). 그 외 값은 "배지 없음". **커맨드가 없어 Err 가
  오면 배지만 안 뜨고 기능은 동작한다**(:148 주석) — 그래서 `lan.status` 는 3개 중 유일하게
  "없어도 무해"한 커맨드다.
- `lanRpc` → `r.ok===true` → result / `LAN_UNSUPPORTED|LAN_SCOPE` → markUnsupported(30분 휴면) /
  `LAN_TIMEOUT|LAN_UNREACHABLE|LAN_AUTH_FAILED` → markFail(쿨다운) / **그 외 코드는 throw**(:181-186).
  ⚠ 따라서 **PC 가 모르는 코드로 정책 거절을 표현하면 IDE 에 에러가 뜬다.** 정책성 거절은 반드시
  `LAN_SCOPE`(또는 `LAN_UNSUPPORTED`)로 표현할 것.
- IPC 자체가 Err 면(`catch`) `markUnsupported` — 즉 **구 데몬에서는 조용히 릴레이**가 보장된다.

**★ 승격 책임 소재 — `lan.probe` **1회로 승격까지** 끝낸다(2026-07-25 추가, 실측 결함)**

`lan.js` 의 승격 조건은 `PROMOTE_OK_STREAK=2`(probe 2연속 성공)인데, 이 문서가 "누가 2번째 probe 를
쏘는가"를 적지 않아 **두 플랫폼이 갈라졌다**: 모바일 `lanLink.maybePromote` 는 한 번의 호출 안에서
`ensureLink` + 1초 뒤 `pingRtt` 로 2회를 채우는데(그래서 동작), PC 는 `lan.probe` 를 1회만 쏘고
`lan.status` 가 `probing` 이면 손을 놓았다 → 경로가 `probing` 에 **영구 고착**(경로 상태에는 TTL 이
없다) → '직결' 배지 영구 미표시 + `lanRpc` 의 `if (!s.direct) return null` 때문에 IDE 원격 fs 직결이
**한 번도 시작되지 않았다**(로그·오류 0건 · 30분 폴링 180회에서 lan_probe 총 1회로 실측).

확정 규칙:

```
① 데몬 lan.probe 는 왕복 1회 커맨드 안에서 probe_ok 를 2번 기록한다(모바일 미러):
     핸드셰이크 RTT = 1번째 · 같은 세션의 PING/PONG RTT = 2번째 · 그 뒤 세션 close
   → 성공했으면 **다음 lan.status 가 'lan' 이어야 한다**(grant 는 1장만 쓴다).
   2번째 측정이 실패하면 승격하지 않고 noteSoftFail. 핸드셰이크는 성공했으니 result 는 ok:true.
② 뷰어(PC/모바일)는 mode==='probing' 을 "데몬이 알아서 할 것"으로 읽지 말 것 — relay 와 같게
   계속 부추긴다(스팸은 PROBE_GAP_MS 60s 가 막는다). 두 곳 중 하나만 어겨도 조용한 데드락이 된다.
③ mode==='cooldown' 에서는 쏘지 않는다(noteProbeOk 가 쿨다운 중엔 무시한다 — 왕복만 낭비).
```

### 4.3 grant 취득과 clientKey — 데몬이 직접 받는다

Rust 는 `lan.probe`/`lan.rpc` 에 grant 를 **싣지 않는다**(`{hostDeviceId}` / `{hostDeviceId,method,params}`).
→ **데몬이 `backFetch('POST','/api/daemon/lan/grant', …)` 로 스스로 받아야 한다**(설계 §3.5 권고와 일치,
`cptsock.rs:84-88` 주석의 "grant secret 을 웹뷰 JS 에 노출하지 않는다"와도 일치).

```jsonc
// 데몬(뷰어) → back
POST /api/daemon/lan/grant     Authorization: Bearer <deviceToken>
{ "hostDeviceId":12, "clientKey":"<데몬 뷰어 키>", "kind":"pc", "scopes":["rpc"] }
→ { grantId, secret, expiresAt, ttlMs, scopes, hostDeviceId, machineId, proto, lanEpoch,
    endpoints:[{host,port,family}] }
```

- `clientKey` [추정 권고]: `pc-daemon-<machineId 앞 8자>`(machineId = `config.machineId()`).
  안정적이고 PC JS 의 `cpt.deviceKey`(`lan.js:48-50`)와 **다른 값**이어도 된다 — 아래 규칙 때문에.
- ★ **`lan.status` 는 clientKey 로 필터하지 말 것.** `pathKey = "<clientKey>|<hostDeviceId>|<fingerprint>"`
  (`lan.js:984-986`)이므로, 포워딩(PC JS clientKey)과 lan.rpc(데몬 clientKey)는 **다른 경로 엔트리**를
  갖는다. `lan.status` 는 `pathSnapshot()` 을 훑어 **중간 세그먼트 == hostDeviceId** 인 엔트리를
  모아 `mode` 를 정한다(하나라도 `lan` 이면 `lan`, 아니면 `probing`>`cooldown`>`relay` 우선순위)
  [추정 — 우선순위는 권고]. 이걸 안 하면 프리뷰가 직결 중인데 배지가 안 뜨거나 반대가 된다.
- grant 캐시: 데몬 안에서 `hostDeviceId → {grant, at}` 8분 캐시 + 실패 시 쿨다운 —
  PC JS `lan.js:27-30, 69-99` 규칙을 미러(같은 숫자). `LAN_AUTH_FAILED` 는 **1회 재발급 재시도**하고
  그 재시도는 강등 카운터를 소모하지 않는다(`forward.js:83-88` 의 `refresh` 규약과 동일).

### 4.4 메서드 울타리 — 정책 정본은 서버

```
lan.rpc 가 통과시키는 조건(전부 AND):
 1) lan.allows('rpc')            — 데몬 스코프(CPT_LAN_SCOPE=rpc|all)
 2) lan.rpcAllowed(method)       — 접두사 화이트리스트(lan.js:93). 여기서 **다이얼 전에** 거른다
 3) grant.scopes 에 'rpc' 포함   — 서버가 준 scope (= LAN_SCOPES ∩ 클라 요청 ∩ 데몬 신고)
 4) (호스트 측 재검사) lan.js:704-705 가 같은 판정을 한 번 더 한다
```

- 1~3 중 하나라도 불만족이면 **다이얼하지 않고** `{ok:false, code:'LAN_SCOPE'}`(PC 가 조용히 릴레이).
- **정책 정본은 서버**다: `LAN_SCOPES` 에 `rpc` 가 없으면 grant 에 scope 가 실리지 않아 클라 코드
  수정 없이 fs 직결이 꺼진다(`config/lanDirect.js:31-39`, `daemonRelayService.js:1099-1104`).
- `fs.watch`/`fs.unwatch` 는 **영구 금지**(전역 단일 watcher — LAN watch 가 릴레이 watch 를 죽여
  IDE 라이브 동기화가 조용히 깨진다). `lan.js:73-74`(RPC_DENY) 가 이미 거부하지만 `lan.rpc`
  핸들러에서도 거부해 왕복을 없앨 것.
- **E2EE `required` 가드(결함 #12)**: PC JS 는 이미 막는다(`lan.js:176`). 데몬도 이중 방어로
  `e2ee.policy()==='required'` 면 `lan.rpc` 를 `{ok:false, code:'LAN_SCOPE'}` 로 거절할 것
  (§4.2 의 코드 규약 때문에 새 코드를 만들면 안 된다).

### 4.5 CAPABILITIES 공개 여부 — **비공개**(결론)

`lan.probe`/`lan.status`/`lan.rpc` 는 `cpt-server.js:974-993 CAPABILITIES` 목록에 **넣지 않는다**.
`forward.*`/`sync.checkpoint`/`daemon.shutdown`/`ui.attach` 와 같은 "PC 앱 내부용" 취급이고,
`resolveCtx` **전에** 처리한다(tmux ctx 불필요).

이유(AI 가 부르면 위험한가에 대한 판단):
- `cpt` 는 터미널 안의 AI 가 쓰는 CLI 다. `lan.rpc` 를 공개하면 **다른 PC 의 파일을 서버가 보지 못하는
  경로로 읽고 쓰는 수단**을 AI 에게 직접 주는 것이 된다(`fs.write` 가 허용 접두사에 있다).
- `lan.probe` 는 사설 IP·포트·RTT 를 반환한다 = 사용자의 내부망 지형을 프롬프트 컨텍스트로 유출.
- 반대로 사람이 이걸 부를 이유가 없다(진단은 `~/.codingpt/*.log` 의 `[lan]` 라인과 PC 배지로 충분).
- 진단이 정말 필요해지면 **읽기 전용인 `lan.status` 만** 나중에 공개하는 것이 안전하다 [추정].

### 4.6 게이팅·폴백 규칙

```
서버 LAN_DIRECT_ENABLED=0 (기본)   → caps 에 lan.v1 없음 → 데몬 리스너 미개방 + grant 404
                                    → upstream 없음 → forward 릴레이(오늘의 동작)
데몬 CPT_LAN=0                     → caps 선언 없음 → 같은 결과
lan.* 커맨드 부재(구 데몬)          → Rust Err → PC JS catch → markUnsupported → 릴레이(무증상)
grant 404/409/429                  → PC lan.js 가 code 로 분기해 쿨다운/미지원 → 릴레이
직결 연결이 첫 바이트 전에 실패      → forward.js:141-149 가 **버퍼 승계해 그 연결만** 릴레이
직결이 흐르던 중 실패               → 그 연결만 죽고 다음 연결이 릴레이(경로 상태는 강등)
E2EE policy=required               → LAN(rpc) 미사용, 봉인 릴레이 유지
```

**★ rpc 단계(fs 직결) 개방 절차 — 스위치를 넣는 지점(2026-07-25 추가)**

데몬 스코프 기본값은 `tcp` 다(`lan.js scope()`). `tcp` 에서는 `lan.rpc` 가 **다이얼 전에** `LAN_SCOPE`
로 거절되고, PC 는 그 코드를 `markUnsupported`(30분 휴면 + **grant 폐기**)로 받는다 → 프리뷰의 tcp
직결까지 함께 죽는다. 그런데 출하 구성 어디에도 `CPT_LAN_SCOPE` 를 설정하는 코드가 없었으므로
(PC 사이드카 spawn env·`bundle-sidecar.sh`·`packages/daemon` 전부 0건) 서버에서 `LAN_SCOPES` 에
`rpc` 를 넣어도 갭 4 의 fs 직결은 켜지지 않았다 = "구현했는데 안 켜지는" 상태. 개방은 **두 곳을 함께**
바꿔야 한다:

```
① 서버:  LAN_DIRECT_ENABLED=1 · LAN_SCOPES 에 rpc 추가   (정책 정본. 이게 없으면 grant 에 scope 미포함)
② 데몬:  ~/.codingpt/daemon.json 의 "lanScope": "rpc"     (영속 설정 지점 — control.applyLanScope)
         또는 사이드카 spawn env CPT_LAN_SCOPE=rpc         (env 가 daemon.json 보다 우선)
```

- `lanScope` 허용값 = `off|tcp|rpc|all`. 그 밖의 값은 경고 후 무시(기본 `tcp` 유지 = fail-closed).
- **재페어링은 `daemon.json` 을 새로 쓴다**(계정 전환 = 클린 슬레이트) → `lanScope` 를 다시 넣어야 한다.
- 두 곳 중 하나만 켜도 안전하다: 서버만 켜면 데몬이 `LAN_SCOPE` 로 조용히 릴레이, 데몬만 켜면
  grant 에 `rpc` 가 실리지 않아 `lan.rpc` 가 `LAN_SCOPE` 로 거절된다(둘 다 릴레이 폴백).

**오프라인 오탐 금지(설계 §5.3)**: LAN 실패 코드/문구에 `DAEMON_OFFLINE`·"데몬이 연결"을 절대
넣지 않는다 — 모바일이 **에러 문구 정규식**으로 호스트 오프라인을 판정한다
[실측 `codingpt_app/src/contexts/WorkspaceShellContext.tsx:1094`
`/데몬이 연결|DAEMON_OFFLINE/.test(...)`]. LAN 전용 코드는 `LAN_*` 접두사만.

### 4.7 패키지별 편집 지점

| 패키지 | 파일:줄 | 무엇을 |
|---|---|---|
| daemon | `cpt-server.js:436-447` | **`forward.start` 가 `args.upstream` 을 `startLocalForward` 로 전달**(+ `upstream.refresh` 콜백 주입) ← 이 한 줄이 死文의 핵심 |
| daemon | `cpt-server.js:454` 옆 | `lan.probe` / `lan.status` / `lan.rpc` 핸들러(resolveCtx 전, CAPABILITIES 비공개) |
| daemon | 신규 `runner-core/lan-grant.js`(또는 cpt-server 내부) | grant 취득·캐시·쿨다운·1회 재발급(backFetch 사용) |
| daemon | `test/lan.test.js` 확장 | ① upstream 전달 회귀(현재 유실을 재현하는 테스트) ② 울타리(method 거부) ③ status 가 clientKey 무관하게 hostDeviceId 로 집계 ④ required 가드 |
| PC | `src/js/lan.js` | Rust·JS 배관은 완비였지만 **승격/강등 3규칙**(§4.9)으로 세 곳을 고쳤다(2026-07-25): 'probing' 에서도 계속 부추김 · 'lan' 검증 probe(5분) · `LAN_SCOPE`/커맨드 부재는 rpc 전용 억제 |
| back | — | **무수정** |
| app | — | 무관(모바일 LAN 은 `lanLink.ts`/`lanPath.ts` 로 이미 구현) |

### 4.8 이 계약을 깨면 어떻게 조용히 죽는가

`lan.rpc` 가 PC 가 모르는 실패 코드를 돌려주면 릴레이 폴백이 아니라 **IDE 에 붉은 오류**가 뜨고,
반대로 `forward.start` 가 `upstream` 을 계속 버리면 grant 는 매번 발급되는데 바이트는 영원히
서버를 경유한다(로그·에러 0건, 직결은 死文).

### 4.9 승격/강등 책임 분담 — 교차검증(2026-07-25)으로 확정된 3개 규칙

앞의 4.2~4.6 은 "누가 경로를 올리고 내리는가"를 적지 않아서 **양쪽이 서로를 기다리는 교착**과
**거짓 배지**가 났다(각 패키지 테스트는 전부 초록이었다). 정본은 아래 3줄이다.

1. **`lan.probe` 1회 = 승격 1단위.** `PROMOTE_OK_STREAK=2` 는 데몬 내부 사정이므로 데몬이 한 커맨드
   안에서 2회 측정(핸드셰이크 RTT + 같은 세션 PING RTT)을 채운다 — 모바일 `lanLink.maybePromote`
   와 같은 모양이고 grant 는 1장만 쓴다. [구현: `lan-local.js probe()`]
   · PC 는 **보조로** `mode:'probing'`(=승격 미완)에서도 `PROBE_GAP_MS`(60s) 간격으로 계속 부추긴다.
     'probing' 에서 손을 놓으면 2단위를 못 채우는 데몬(구 사이드카·2번째 측정 soft-fail)과 만났을 때
     경로가 영구 고착하고 배지·`lan.rpc` 가 통째로 死文이 되기 때문이다. **'cooldown' 에서는 쏘지
     않는다**(데몬 백오프 중 — `noteProbeOk` 가 무시한다). [구현: `codingpt_pc/src/js/lan.js refreshStatus`]
2. **경로가 'lan' 이 된 뒤에도 검증한다.** 경로 엔트리에는 TTL·하트비트가 없어서 실트래픽
   (`forward`/`lan.rpc`)이 없으면 집을 떠나 릴레이로 흐르는 동안에도 'lan' 으로 동결된다 = **거짓
   "직결" 배지 + 죽은 경로로 계속 fs 직결 시도**. → PC 가 `VERIFY_GAP_MS`(5분) 간격으로 검증 probe 를
   쏘고, 실패하면 **강등은 데몬이 한다**(noteSoftFail 2연속 / noteHardFail 1회). PC 는 검증 probe 실패로
   자기 grant/쿨다운을 건드리지 않는다(아직 흐르고 있을 수도 있는 프리뷰 upstream 을 죽이지 않기 위해).
   · ⚠ 남은 한계: 경로 키가 `<clientKey>|<hostDeviceId>|<net>` 라서 **프리뷰(PC JS clientKey)로 승격된
     엔트리는 데몬 뷰어 clientKey 로 도는 검증 probe 로 강등되지 않는다.** 완전한 해결은 데몬 경로
     엔트리의 **무트래픽 TTL**(N분 무트래픽 → 'probing' 으로 되돌림) + `lanLib.revive()` 를 네트워크
     변경/앱 복귀에 실제로 연결하는 것이다(현재 `revive()` 는 호출자 0건) — 데몬 몫으로 남아 있다.
3. **거절의 사정거리(scope)를 넘지 않는다.** `LAN_SCOPE` 는 "이 호스트가 LAN 미지원"이 아니라
   **"이 메서드군만 미지원"**이다. 기본값 `LAN_SCOPES=['tcp']`(단계적 개방)에서 fs 직결 시도는
   정상적으로 `LAN_SCOPE` 를 받는데, 이걸 호스트 단위 미지원으로 처리하면 grant 가 버려지고 30분
   쿨다운이 걸려 **켜져 있는 유일한 scope(프리뷰 포워딩)까지 죽는다**(배지도 함께 꺼진다).
   → PC 는 `LAN_SCOPE`·`lan.rpc` 커맨드 부재를 **rpc 전용 억제**(30분)로 처리하고 grant/upstream/배지는
   손대지 않는다. 호스트 단위 미지원은 `lan.status`→`mode:'unsupported'` 와 `LAN_UNSUPPORTED` 만이다.
   [구현: `codingpt_pc/src/js/lan.js markRpcUnsupported`]

**회귀 테스트는 교차 구현이어야 한다**: 각자 스텁이면 위 3건이 전부 다시 초록으로 통과한다.
정본 = `codingpt_pc/test/lan-crossimpl.mjs`(PC lan.js 실물 + 데몬 lan.js/lan-local.js 실물, 시계 주입,
스텁은 back grant 와 소켓 다이얼뿐) + `codingpt_pc/test/contract.mjs`(PC 쪽 간격/억제 규칙).

---

## 갭 5 — 체크포인트 `begin`/`commit`

### 5.1 양쪽 끝 현황 — 데몬은 **이미 완성돼 있다**

- `cpt-server.js:454` `if (cmd === 'sync.checkpoint') return localCheckpoint(req.args || {});`
- `cpt-server.js:227-268 localCheckpoint()` — begin await → `sync.handle('sync.checkpoint',…)` 백그라운드
  → commit. **주석 :217-224 가 요청/응답 스펙을 스스로 적어 두었고 그것이 정본이다.**
- 회귀 테스트도 있다: `test/local-checkpoint.test.js`(begin 1회·구 경로 0회·404면 실패·좌표 누락이면
  실패·즉시 accepted·중복 busy·업로드 실패 시 commit 미호출).
- PC: `cptsock.rs:125 sync_checkpoint` → `api.js:217-230 syncCheckpoint` 가 **실패 시 구 경로로 폴백**.
- back: `POST /api/daemon/sync/checkpoint`(route `daemonRoutes.js:120`) + `syncService.checkpoint()`(:57-104)
  만 있고 **`/begin`·`/commit` 은 없다** [실측 grep 0건].

즉 갭 5는 **back 엔드포인트 2개만** 만들면 닫힌다. 임무 지시문의 "데몬 내부 커맨드 `sync.checkpoint`
없음"은 이미 해소된 상태다(작업 지시서보다 코드가 앞서 있다).

### 5.2 와이어 계약 (데몬 코드가 정본)

```jsonc
// ── begin ──  accountAuth(JWT|deviceToken). 데몬이 deviceToken 으로 직접 호출한다
POST /api/daemon/sync/checkpoint/begin
{ "workspaceId":"ws_ab12", "reason":"periodic", "cwd":"proj/a" }   // cwd 옵셔널
200 { "checkpointId":"ck_1753432800000_a1b2c3d4",
      "putUrls": { "bundle":"https://objectstore…", "session":"https://objectstore…" },
      "cwd":"proj/a" }                                             // 미지정이면 ws.localPath
400 잘못된 workspaceId / 404 워크스페이스 없음·소유 아님 / 400 compute!=='local'

// ── commit ──
POST /api/daemon/sync/checkpoint/commit
{ "workspaceId":"ws_ab12",
  "checkpointId":"ck_1753432800000_a1b2c3d4",
  "skipped":false, "unchanged":false,
  "baseCommit":"<sha|null>", "commit":"<sha|null>",
  "sizeBytes":123456, "hasSession":true,
  "enc":"cptsnap/1", "epoch":2 }        // 봉인했을 때만(additive — 평문이면 아예 없음)
200 { "id":"ck_…","reason":"periodic","at":"…","baseCommit":"…","commit":"…",
      "bundleKey":"codingpt/sync/<wsId>/<ck>.bundle",
      "sessionKey":"…session.json|null","sizeBytes":123456,"hasSession":true,
      "enc":"cptsnap/1","epoch":2,
      "head": { "checkpointId":"ck_…","commit":"…","baseCommit":"…","at":"…" } }
200 (skipped) { "skipped":true, "unchanged":true, "checkpointId":"ck_…", "head":{…}|null }
```

[실측 근거] 요청 필드는 `cpt-server.js:234-236`(begin) 과 `:252-263`(commit) 이 실제로 보내는 것,
응답 필수 필드는 `:238-243`(`checkpointId`·`putUrls.bundle`·`cwd` 없으면 throw). 응답 봉투는
`successResponse` 가 data 를 최상위로 펼치므로 `begin.data || begin` 양쪽을 데몬이 이미 수용한다(:237).

### 5.3 서버측 구현 규칙

- `syncService.checkpoint()`(:57-104)를 **`checkpointBegin()` + `checkpointCommit()` 로 분해**하고,
  기존 `checkpoint()` 는 그 둘 + `callRpc` 로 재구성한다 → **구 경로의 요청/응답은 1바이트도 바뀌지
  않는다**(모바일 `daemonService.ts:718-722` 가 그 경로를 쓴다).
- 소유권/검증은 두 엔드포인트 각각에서 `requireLocalWorkspace(userId, wsId)`(:27) — begin 에서만
  검사하고 commit 을 믿으면 다른 사용자의 매니페스트를 오염시킬 수 있다.
- `checkpointId` 는 **서버가 만든다**(`newCheckpointId()` :18). commit 이 보내온 id 는
  `/^ck_[A-Za-z0-9_-]+$/`(`:152-156` 미러) 검증 + **begin 이 발급한 id 인지 확인**할 것 [추정 권고:
  `wsId → Set(발급 id)` 인메모리 10분, 없으면 400. 이게 없으면 클라가 임의 키를 매니페스트에
  넣을 수 있다 — 멀티파트 경로가 이미 서버측 키 조립을 강제하는 것과 같은 이유].
- 멱등: 같은 `checkpointId` 로 commit 이 두 번 오면 매니페스트 항목이 중복되지 않아야 한다
  (`manifest.checkpoints.filter(c=>c.id!==ckptId)` 후 push — 기존 코드가 이미 그렇게 한다 :88-89).
- `skipped:true` 면 매니페스트를 **건드리지 않고** 현재 head 를 돌려준다(:74-77 미러).
- `enc`/`epoch` 는 받아서 **entry 에 저장**한다(구 코드의 entry(:80-88)에는 이 필드가 없다 → §5.7).

### 5.4 인증 방식

- 둘 다 **`accountAuth`**(JWT | deviceToken 겸용, `middlewares/accountAuth.js`). 데몬은
  `backFetch` 가 `Authorization: Bearer <deviceToken>` 를 붙이므로(`cpt-server.js:199-209`)
  deviceToken 경로가 반드시 살아 있어야 한다 — `authMiddleware`(JWT 전용)로 붙이면 데몬이 401 을
  받고 PC 는 매번 구 경로로 폴백한다(기능이 조용히 무발현).
- `req.user.id` 는 accountAuth 가 채워 준다(:56-60) → 컨트롤러는 기존 `syncController` 스타일 유지.

### 5.5 게이팅·폴백 규칙 (caps 문자열 없음)

```
back 미배포(404)  → begin await 실패 → cpt.sock ok:false → Rust Err
                  → PC api.js:217-230 catch → 구 경로 POST /api/daemon/sync/checkpoint (background)
데몬이 구버전     → cmd 'sync.checkpoint' 미지원 → 같은 폴백
데몬 미기동       → cpt.sock 연결 실패 → 같은 폴백
begin 응답 불완전 → localCheckpoint 가 throw(:241-243) → 같은 폴백 (반쪽 상태로 백그라운드 금지)
commit 실패       → 번들은 업로드됐지만 매니페스트에 없음 = **고아 오브젝트**. 데몬은 재시도하지
                    않고 로그만 남긴다(:265). [수용된 한계 — 다음 트리거가 새 체크포인트를 만든다]
```

**구 경로 `/sync/checkpoint` 는 남긴다.** 이유 2개: ① 모바일이 그 경로만 쓴다
(`daemonService.ts:719`) ② 개발 중 스테일 사이드카 데몬이 흔하다(PC CLAUDE.md 경고). 지우면
"체크포인트가 조용히 사라지는" 회귀가 된다.

caps 문자열은 필요 없다. **HTTP 404 가 곧 게이팅**이고, 데몬이 begin 을 `await` 하므로 미배포 서버에서
쓸데없는 로컬 작업이 시작되지 않는다(= 조용한 유실이 아니라 즉시 폴백).

### 5.6 패키지별 편집 지점

| 패키지 | 파일:줄 | 무엇을 |
|---|---|---|
| back | `routes/daemonRoutes.js:120` 아래 | `router.post('/sync/checkpoint/begin', accountAuth, syncController.checkpointBegin);` `…/commit` 동일 |
| back | `controllers/syncController.js:16-22` 옆 | `checkpointBegin` / `checkpointCommit` 컨트롤러(얇게, `mapErr` 재사용) |
| back | `services/syncService.js:57-104` | `checkpointBegin`/`checkpointCommit` 추출 + 기존 `checkpoint()` 재구성 + 발급 id 인메모리 집합 |
| back | `services/syncService.js:80-88` | entry 에 `enc`/`epoch` 보존(구 경로 `run()` 도 함께 — §5.7) |
| back | `test/unit.test.js` 또는 신규 | begin→commit 왕복 / 미발급 id 거부 / skipped 무변경 / 구 경로 응답 불변 |
| daemon | — | **무수정**(완비 + 테스트 있음) |
| PC | — | **무수정**(폴백까지 완비) |
| app | — | **무수정**(구 경로 유지) |

### 5.7 곁가지 — `e2ee.snap.v1` 을 선언하려면 여기부터 고쳐야 한다

`sync.js:144-151 serverKnowsSealedSnapshots()` 는 `hasServerCap('e2ee.snap.v1')` 일 때만 번들을
봉인한다. 그런데 지금 서버의 `checkpoint()` entry(:80-88)에는 `enc`/`epoch` 필드가 **없다** →
그 문자열을 선언하면 데몬은 암호문을 올리는데 매니페스트에는 아무 표시가 남지 않는다.
복원은 매직바이트(`CPTS1\0`)로 판별되므로 동작은 하지만(`sync.js:170-176`), "서버가 처리 코드를
가졌을 때만 선언한다"는 교리 위반이고 감사/UX(잠금 배지·복호 실패 진단)가 불가능해진다.
→ **`e2ee.snap.v1` 은 begin/commit + 구 경로 양쪽이 `enc`/`epoch` 를 저장하는 커밋에서만 선언한다.**

### 5.8 이 계약을 깨면 어떻게 조용히 죽는가

라우트를 `authMiddleware`(JWT 전용)로 붙이면 데몬 deviceToken 이 401 을 받아 **항상 구 경로로
폴백**하고, 왕복 제거라는 목적만 조용히 사라진다(체크포인트는 정상 동작하므로 아무도 눈치채지 못한다).

---

## 부록 A — "조용한 죽음" 한 줄 요약표

| 갭 | 깨지는 지점 | 증상(로그·에러 없음) |
|---|---|---|
| 1 | `ended` → `gone` 변환 누락 | claude 종료 후에도 Chat 토글 영구 노출, `tab.cmd` 폴백 영구 비활성 |
| 1 | agent-watch 셸 복귀를 `idle` 로 기록 | 빈 셸 탭에 토글 15분 켜짐 / `gone` 을 보낸 뒤 10분 지나면 토글이 **스스로 되켜짐**(§1.3) |
| 1 | back 이 `agentstate.v1` 을 먼저 선언 | 데몬이 프레임을 보내고 서버가 버림 = 5~9초 지연이 그대로인데 "구현 완료"로 보임 |
| 2 | 봉투/스트림 수립이 `env.epoch` 를 그대로 신뢰 | `e2ee.revoke` 로 회전해도 해제된 세대의 봉투가 계속 실행된다(회전 ≠ 무효화, §2.3) |
| 2 | AAD `hostDeviceId` 불일치 | 모든 봉투 복호 실패 → 클라가 "서버 미지원"으로 캐시 → 평문 + 잠금 배지 |
| 2 | `e2ee.rpc` 가 빈 결과에 `null` 회신 | PC 가 폴백으로 오해해 같은 `fs.write` 를 평문으로 재실행(이중 실행) |
| 3 | `e2ee.stream.v1` 선언이 sid 주입보다 앞섬 | 터미널이 4090 으로 무한 재연결(화면만 안 열림) |
| 3 | begin 을 스트림 대상과 다른 conn 으로 보냄 | confirm 불일치/세션 부재 → 같은 4090 |
| 3 | 오퍼 `pub`/`nonce` 를 32B 로 검사하지 않음 | 16B 난스 뷰어가 붙으면 데몬이 `E2EE_ENCODING` → 아무 신호 없는 `e2ee:false` = 평문 스트림(§3.3-0) |
| 2 | 클라가 `keyState`/`checking` 을 버리고 `state` 로 진행을 판정 | 계정 열쇠 0개(= 사람이 켜기 전엔 **영구 평문**)가 '준비 중'(대기색)으로 보인다. `state` 에 `'none'`/`'enrolled'` 를 기대한 분기는 데몬이 그 값을 반환하지 않으므로 **도달 불가 죽은 코드**(§2.4 규약 3) |
| 2 | `phase==='bootstrap'` 인데 PC 에 `e2ee.bootstrap` 버튼이 없음 | 데몬은 자동 부트스트랩을 하지 않으므로 사용자가 그 상태에서 스스로 벗어날 수 없다(화면은 계속 "준비 중") |
| 2 | `runner_status` 를 `ui_hello` 에 리플레이하지 않음 | 데몬이 이미 붙어 있는 정상 상태에서 자물쇠 배지가 '확인 중' 에 영구 고착(다음 데몬 재접속까지, §2.7) |
| 4 | `forward.start` 가 `upstream` 을 버림 | grant 는 매번 발급되는데 직결은 0건 |
| 4 | `lan.rpc` 가 PC 미지원 코드로 거절 | 조용한 릴레이 폴백이 **붉은 IDE 오류**로 바뀜 |
| 4 | `lan.probe` 가 승격을 1회로 끝내지 않음 | 경로가 `probing` 에 영구 고착 → 배지 미표시 + fs 직결 0건(§4.2) |
| 4 | `CPT_LAN_SCOPE` 를 아무도 설정하지 않음 | 서버 `LAN_SCOPES` 에 rpc 를 넣어도 fs 직결이 안 켜지고, 첫 `lan.rpc` 가 프리뷰 grant 까지 30분 폐기(§4.6) |
| 5 | begin/commit 을 JWT 전용 인증으로 붙임 | 데몬 401 → 영구 구 경로 폴백(기능이 무발현) |
| 5 | 매니페스트에 `enc/epoch` 미저장 상태로 `e2ee.snap.v1` 선언 | 암호문 스냅샷에 표시가 없어 감사/진단 불가 |

## 부록 B — 착수 전 확인이 필요한 [추정] 목록

1. `AGENTSTATE_ENABLED` 킬스위치 이름 · back 라스트-스테이트 리플레이 채택 여부(§1.4/§1.5).
2. agent_state 발사 억제 규칙(같은 state 재발사 금지)과 stale 판정 15분(§1.3/§1.5).
3. PC 가 `(cwd,win)` 만으로 색인하는 것의 멀티 PC 충돌 허용 여부(§1.2).
4. 봉투 RPC 에서 `hostDeviceId` 미지정(=AAD 0) 을 허용할지, 아예 필수로 만들지(§2.3).
5. 데몬 열쇠 클라이언트(2b)를 이번 라운드에 포함할지 — 미포함이면 갭 2는 무발현으로 남는다(§2.6).
6. PC 뷰어 offer 를 누가 만드는가: (A) 데몬 대행 / (B) `e2ee.streamBegin` / (C) PC 는 D단계 제외(§3.8).
7. begin RPC 타임아웃 8s, `e2ee.begin` 실패를 어떤 HTTP 코드로도 노출하지 않는다는 규칙(§3.4/§3.5).
8. 데몬 뷰어 `clientKey` 형식과 `lan.status` 집계 우선순위(§4.3).
9. `lan.status` 만 나중에 CAPABILITIES 에 공개할지(§4.5).
10. commit 의 `checkpointId` 발급 검증(인메모리 집합) 도입 여부(§5.3).
