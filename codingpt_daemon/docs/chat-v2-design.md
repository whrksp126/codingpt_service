# 채팅 v2 — 구조화 대화 엔진 설계 (정본)

작성 2026-09-30. 이 문서가 데몬·back·PC·앱 4곳의 **계약 정본**이다. 구현이 문서와 다르면 문서를 먼저 고친다.

## 0. 왜 다시 만드는가

채팅 v1 은 "터미널 TUI 의 읽기 뷰 + 키 입력 리모컨"이다(트랜스크립트 JSONL tail + tmux send-keys +
capture-pane 정규식 24지점). 그래서 글자 단위 스트리밍이 없고, 보낸 메시지의 도달을 보장하지 못하고,
CLI 가 업데이트되면 화면 문구 파싱이 깨진다. 다듬어서는 해결되지 않는다.

v2 는 에이전트 CLI 를 **공식 구조화 프로토콜**로 직접 구동한다.

| | v1 (유지, 터미널 탭의 베타 토글) | v2 (새 "채팅" 탭) |
|---|---|---|
| 출력 | JSONL tail(완결 라인) | stdout stream-json(토큰 델타) |
| 입력 | tmux paste + 고정 sleep + Enter | stdin JSON, replay ack 로 도달 확인 |
| 승인·질문 | 훅 + 화면 파싱 | `control_request can_use_tool` (데이터) |
| 중단·모드 | 키 주입 | `control_request interrupt / set_permission_mode` |
| 상태 | 훅 + 제목 글리프 + 화면 | 프로세스 이벤트(결정적) |

### 0.1 실측 (claude 2.1.284, 2026-09-30)

구동 인자:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --replay-user-messages
       --permission-prompt-tool stdio --permission-mode <mode>
       [--session-id <uuid> | --resume <uuid>] [--model <m>]
```

- `--session-id <uuid>` 로 새 세션의 id 를 우리가 정한다. `--resume` 은 같은 id 를 유지한다.
- stdin 사용자 메시지: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"uuid"?:"…"}`
- replay ack: 같은 메시지가 stdout 에 `{"type":"user",…,"uuid":"…","isReplay":true}` 로 돌아온다.
  stdin 에 `uuid` 를 실으면 **그 uuid 그대로** 돌아온다(종단 실측) → 데몬은 uuid 로 짝짓고, 안 돌아오면 보낸 순서로 짝짓는다.
- stdout 의 `uuid` 는 세션 파일(JSONL) 줄의 `uuid` 와 같다(실측) → 가져오기의 중복 판정 키.
- 완성 `assistant` 줄은 content block 1개당 1줄, 같은 `message.id` 로, 그 블록의 `content_block_stop` **앞**에 온다.
  줄에는 블록 인덱스가 없으므로 "가장 최근 `content_block_start` 의 index" 가 그 줄의 인덱스다.
- 우리가 stdin 에 쓴 `control_response` 는 stdout 에 그대로 되돌아온다(메아리 — 무시한다).
- `result.total_cost_usd` 는 턴 값이 아니라 **세션 누적**이다(이어받은 뒤에도 이어서 쌓인다).
- 승인: stdout `{"type":"control_request","request_id","request":{"subtype":"can_use_tool","tool_name","input","description","permission_suggestions":[…],"tool_use_id"}}`
  → stdin `{"type":"control_response","response":{"subtype":"success","request_id","response":{"behavior":"allow","updatedInput":{…},"updatedPermissions"?:[…]}}}`
  또는 `{"behavior":"deny","message":"…"}`.
- 질문: 같은 can_use_tool, `tool_name:"AskUserQuestion"`, `requires_user_interaction:true`.
  응답은 `behavior:"allow"` + `updatedInput:{questions, answers:{"<질문 문구>":"<라벨|자유 텍스트>"}}`.
- 모드: stdin `{"type":"control_request","request_id","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}` → `control_response … {"mode":"acceptEdits"}`.
- 중단: stdin `{"type":"control_request","request_id","request":{"subtype":"interrupt"}}` → `control_response … {"still_queued":[]}`
  → `user` "[Request interrupted by user]" → `result`(result 필드 없음). **프로세스는 살아 있고 다음 메시지를 받는다.**
- `system/init` 은 **턴마다** 온다(`permissionMode`, `model`, `slash_commands`, `terminal_slash_commands`, `capabilities`).
- 그 외 관측된 이벤트: `system/status`, `system/thinking_tokens`, `system/task_started`, `system/background_tasks_changed`, `rate_limit_event`.
- `-p` 는 워크스페이스 신뢰 화면을 띄우지 않는다.
- 터미널 TUI ↔ 구조화 세션은 같은 세션 파일을 쓴다. 양방향 이어받기 실측: 대화 보존, 프롬프트 캐시 적중
  (TUI→구조화: cache_read 45,008 / cache_creation 750).
- **동시에 두 프로세스가 같은 세션을 열면 기록이 섞인다 → 소유자는 항상 1명.**

### 0.2 정책 경계 (codingpt_daemon/CLAUDE.md 와 동일)

- 실행 = 사용자 PC, 사용자가 설치한 **수정되지 않은** CLI, 사용자 본인 로그인.
- 자격증명(Keychain, `~/.claude` OAuth)은 읽지도 옮기지도 않는다. `--bare` 금지(구독 로그인 불가).
- UI 에 벤더 제품명("Claude Code")을 쓰지 않는다. 에이전트 표시명은 `agents.js` 카탈로그.
- 과금 정책이 바뀌어 구조화 경로만 별도 과금이 되면 킬스위치로 끌 수 있어야 한다(§9).

## 1. 이름

| 대상 | 이름 |
|---|---|
| RPC 계열 | `conv.*` |
| 능력(cap) | `conv.v1` (데몬·서버·클라 교집합 게이팅) |
| push 프레임 | `{type:'conv_event'}` |
| REST | `POST /api/daemon/conv` `{method, params, hostDeviceId?}` |
| 데몬 모듈 | `runner-core/conv.js` (+ `conv-store.js`, `conv-engine-claude.js`) |
| 데몬 저장 | `<stateDir>/conv/index.json`, `<stateDir>/conv/<threadId>.jsonl` |
| 탭 종류 | `chat` (PC·앱 공통) |
| 킬스위치 | 서버 `CONV_ENABLED=0`, 데몬 설정 `conv.enabled=false` |

`agent.*`(2026-07 동면 엔진)은 로그인·doctor 용으로 남긴다. v2 는 그 코드를 참고하되 새 모듈로 쓴다.

## 2. 데이터 모델

### 2.1 Thread

```js
{
  id,            // = 에이전트 세션 id(uuid). 새 대화는 데몬이 생성해 --session-id 로 넘긴다
  agent,         // 'claude' (어댑터 id)
  cwd,           // 워크스페이스 상대 경로(다른 RPC 의 cwd 와 같은 규약, fs.safeResolve 로 해석)
  title,         // 첫 사용자 메시지 앞 60자. 사용자가 바꿀 수 있다
  titleSet,      // 사용자가 직접 바꿨으면 true(자동 갱신 금지)
  createdAt, lastAt,           // epoch ms
  state,         // 'idle' | 'working' | 'waiting' | 'stopped' | 'error'
  owner,         // 'chat' | 'terminal' | 'none'
  ownerTid,      // owner==='terminal' 일 때 그 터미널 tid
  mode,          // 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'
  model,         // init 이 알려준 모델 id
  headSeq,       // 마지막 영속 이벤트 seq
  pending,       // 대기 중 요청 수
  preview,       // 마지막 assistant 텍스트 앞 120자
  usage,         // { contextTokens, contextMax, costUsd } (있으면)
  external,      // true = 우리 로그가 아직 없는 에이전트 세션(터미널에서 만든 대화)
}
```

`state` 의 뜻:
- `working` 턴 진행 중. `waiting` 승인·질문 응답 대기(턴은 진행 중). `idle` 입력 가능.
- `stopped` 프로세스 없음(다음 입력에 자동으로 다시 뜬다 — 사용자에게는 idle 과 같다).
- `error` 마지막 기동/턴이 실패. `notice` 이벤트에 사유.

### 2.2 이벤트 로그

thread 마다 단조 증가 `seq`(1부터). **영속 이벤트**만 seq 를 가진다.

```js
{ seq, ts, op:'msg',    msg: ConvMsg, first?, uuid? }
{ seq, ts, op:'turn',   phase:'start'|'end', turn:n, ok?, subtype?, interrupted?, durationMs?, usage?, costUsd? }
{ seq, ts, op:'req',    req: ConvReq, first? }
{ seq, ts, op:'state',  state?, mode?, model?, usage?, owner?, ownerTid?, title?, titleSet?, pending? }
{ seq, ts, op:'notice', level:'info'|'warn'|'error', code, text }
```

`msg` 와 `req` 는 **key/id 기준 upsert** 다. 같은 key 의 뒤 이벤트가 앞을 대체한다(클라는 key 로 접는다).

- `ts` 는 epoch ms. 가져온 메시지는 **원래 말한 시각**이다(가져온 시각이 아니다).
- `first` — upsert(둘째 판부터)에만 실린다. 그 key 가 처음 나온 seq. 클라는 행의 자리를 `first ?? seq` 로 잡는다
  (라이브의 제자리 교체와 스냅샷의 자리가 같아진다). msg 와 req 는 key 이름공간이 다르다.
- `uuid` — 에이전트가 그 줄에 붙인 uuid(세션 파일의 uuid 와 같다). 가져오기 중복 판정과 `conv.detail` 의 원본 찾기에 쓴다.
- **접은 스냅샷** = 로그에서 "같은 key 의 더 뒤 이벤트가 있는 줄"을 뺀 부분열. seq 오름차순이고 seq 는 띄엄띄엄하다.
- `turn.usage = {input, output, cacheRead, cacheCreate}`(그 턴). `turn.costUsd` 는 세션 누적(§0.1).
  `turn.subtype`: 에이전트가 준 값 또는 `process_exit` · `daemon_shutdown` · `daemon_restart` · `stopped` · `idle` · `evicted` · `handoff`.
- `state` 이벤트는 mode·model·title·owner·usage 변경과 턴 종료(idle/error)·프로세스 종료(stopped/error)에 남는다.
  **working/waiting 전이는 따로 적지 않는다** — turn·req 이벤트가 이미 말해 준다. 현재값은 `thread` 힌트 프레임과
  pull 응답의 `thread.state` 다.
- `notice.code`: `PROCESS_EXIT` `START_FAILED` `TURN_FAILED` `AGENT_NOT_LOGGED_IN` `RATE_LIMITED`
  `TERMINAL_ONLY_COMMAND` `IMPORT_TRUNCATED` `MODEL_NEXT_START`.

### 2.3 ConvMsg

v1 의 ChatMsg(`transcript.js msg()`) 와 **같은 모양**에 필드를 더한다. 클라의 기존 행 렌더러를 그대로 쓴다.

```js
{
  key,          // 안정 id. assistant 블록 = '<message.id>:<blockIndex>', 도구 = tool_use id,
                //  도구 결과 = 'r:'+tool_use id, 사용자 = 'u:'+clientId 또는 'u:'+uuid
  seq, ts, role, kind, text, truncated, hidden,
  tool?, result?, question?, questions?, attachments?, meta?, model?, isSidechain?, agentId?,
  clientId?,    // 사용자 메시지: 보낸 클라가 만든 id(낙관 버블과 정확히 짝짓는다)
  status?,      // 사용자 메시지: 'queued' | 'sent' | 'failed'
  turn?,        // 속한 턴 번호
  parent?,      // 서브에이전트 메시지: parent_tool_use_id
}
```

- `ts` 는 v1 과 같은 ISO 문자열(이벤트의 `ts` 는 epoch ms). `status` 는 `'queued' | 'sent' | 'failed'`.
- `kind` 는 v1 의 값에 `interrupt`(중단 표식 — 항상 `hidden`)가 더해진다.
- 그 밖의 key: 도구 id 가 없는 결과·한 줄의 둘째 메시지 = `'u:'+uuid+':'+n`, 시스템 줄(압축·API 오류) = `'s:'+uuid+':'+n`.
  가져오기에서 기존 key 와 겹치면 `key+'~'+uuid 앞 8자`.
- 본문 상한은 v1 의 4096자가 아니라 **64KB(65,536 문자)**. 넘으면 `truncated:true` + `conv.detail` 로 전문(상한 1MB).
- 도구 요약·diff·결과 프리뷰는 `transcript.js` 의 `normalize` 를 그대로 통과시켜 만든다
  (stream-json 의 `assistant`/`user` 객체는 JSONL 라인과 같은 `message.content` 구조).

### 2.4 ConvReq

```js
{
  id,            // 'req_'+uuid (에이전트 request_id 는 내부에만)
  kind,          // 'permission' | 'question' | 'plan'
  tool, toolUseId,
  summary, detail, relPath, diff, inputPreview,   // approvals.js 의 summaryOf/detailOf/diffOf 재사용(리댁션 포함)
  questions?,    // kind==='question'
  plan?,         // kind==='plan' (ExitPlanMode 본문)
  alwaysLabel?,  // permission_suggestions 가 있을 때만(3번째 선택지)
  status,        // 'pending' | 'allowed' | 'denied' | 'answered' | 'canceled'
  always?,       // true = "허용하고 다음부터 묻지 않기" 로 허용됨
  reason?,       // canceled 사유: 'interrupted' | 'process_exit' | 'turn_end'
  by?,           // 응답한 기기 표시명
  requestedAt, resolvedAt?,
  turn,
}
```

요청에는 **마감이 없다**(사용자가 답할 때까지 열려 있다). 닫히는 경로는 응답·중단·프로세스 종료뿐.

- `summary` 는 파일 도구면 워크스페이스 상대 경로다(알림 본문으로도 나가므로 홈 절대경로를 싣지 않는다).
- `alwaysLabel` 은 `kind:'permission'` 에만. 제안이 `addRules` 면 규칙 내용, `setMode` 면 "이번 대화에서 파일 수정 자동 허용" 등.

### 2.5 델타 (비영속, push 전용)

```js
{ key, kind:'text'|'thinking', off, text }   // off = 이 조각 앞까지의 누적 길이(문자)
```

- 데몬이 50ms 로 코얼레싱한다. `off`/길이의 단위는 UTF-16 코드 유닛(JS `string.length`)이다.
- 생각 블록은 시작할 때 빈 조각(`off:0, text:''`)이 한 번 나간다 — 본문이 끝내 비어도 "생각 중" 을 띄울 수 있게.
- 완성되지 못한 초안(중단·프로세스 종료)은 메시지가 되지 않는다. 클라는 `turn end` 를 받으면 남은 초안을 버린다.
- 클라는 `off` 가 자기 누적 길이와 다르면 조각을 버리고 `conv.since` 로 `live` 를 받는다.
- 블록이 완성되면 같은 `key` 의 `msg` 이벤트가 온다 → 클라는 초안을 그것으로 교체한다.
- thinking 본문은 비어 올 수 있다(서명만). 그때는 "생각 중" 표시만.

## 3. push 프레임

```js
{ type:'conv_event', threadId, headSeq, events:[…] }          // 영속 이벤트(1개 이상, seq 연속)
{ type:'conv_event', threadId, delta:{…} }                    // 델타
{ type:'conv_event', threadId, thread:{…} }                   // 목록 갱신 힌트(제목·상태·preview)
{ type:'conv_event', control:{ kind:'gone'|'deleted', threadId } }
```

back 은 모든 프레임에 `hostDeviceId`(프레임이 온 PC)를 붙인다 — 멀티 PC 에서 클라가 자기 호스트의 것만 받는다.
화이트리스트: threadId, headSeq, events, delta, thread, control (+ back 이 붙이는 hostDeviceId). 그 밖의 필드는 버려진다.

**push 는 힌트, pull 이 정본.** 클라는 `events[0].seq !== localHead + 1` 이면 프레임을 버리고
`conv.since` 를 부른다. back 은 conv_event 를 버퍼링하지 않고 라이브 중계만 한다(chat_event 와 같은 규율).

## 4. RPC

모든 응답은 `{ … }` 객체. 오류는 `{code}` 를 단다. 클라는 문구가 아니라 code 로 분기한다.

| 메서드 | params | 결과 |
|---|---|---|
| `conv.caps` | `{}` | `{ enabled, agents:[{id,label,available,version}], modes:[…], maxLive }` |
| `conv.list` | `{ cwd?, limit?, includeExternal? }` | `{ threads:[Thread] }` lastAt 내림차순 |
| `conv.create` | `{ cwd, agent?, mode?, model?, text?, clientId?, attachments? }` | `{ thread, seq? }` |
| `conv.open` | `{ threadId, limit?, cwd? }` | `{ thread, events, headSeq, floorSeq, live, pending }` |
| `conv.since` | `{ threadId, sinceSeq }` | `{ thread, events, headSeq, live, pending, more, reset?, floorSeq? }` |
| `conv.before` | `{ threadId, beforeSeq, limit? }` | `{ events, floorSeq }` |
| `conv.send` | `{ threadId, clientId, text, attachments? }` | `{ ok, status:'sent'\|'queued'\|'failed', seq, code? }` |
| `conv.respond` | `{ threadId, reqId, decision, always?, message?, answers?, by? }` | `{ ok }` |
| `conv.interrupt` | `{ threadId }` | `{ ok, interrupted, code? }` |
| `conv.set` | `{ threadId, mode?, model?, title? }` | `{ thread }` |
| `conv.stop` | `{ threadId }` | `{ ok }` (프로세스만 내림. 대화는 남는다) |
| `conv.remove` | `{ threadId }` | `{ ok }` (우리 로그·목록에서 제거. 에이전트의 세션 파일은 건드리지 않는다) |
| `conv.detail` | `{ threadId, key }` | `{ text, raw? }` |
| `conv.commands` | `{ threadId?, cwd? }` | `{ items:[{name,desc}] }` |
| `conv.toTerminal` | `{ threadId }` | `{ ok, cwd, agent, command, args }` (§6) |
| `conv.adopt` | `{ cwd, tid }` | `{ thread }` (§6) |

오류 코드(데몬): `CONV_DISABLED` `AGENT_UNAVAILABLE` `AGENT_NOT_LOGGED_IN` `THREAD_NOT_FOUND` `THREAD_BUSY`
`THREAD_BUSY_IN_TERMINAL` `REQ_NOT_PENDING` `TOO_MANY_LIVE` `BAD_REQUEST` `START_FAILED` `ADOPT_FAILED`
`CONTROL_TIMEOUT` `CONTROL_FAILED`(에이전트가 모드 변경 등 제어 요청에 답하지 않음/거절).

응답 필드 보충:
- `live` = 완성 전 블록 `[{key, kind, text}]`. 다음 델타의 `off` 는 그 `text.length` 에서 이어진다.
- `pending` = 지금 열려 있는 요청 `[ConvReq]`(개수가 아니다 — 페이지 밖에 있어도 카드를 그릴 수 있게). 개수는 `thread.pending`.
- `floorSeq` = 돌려준 첫 이벤트의 seq. **더 앞이 없으면 1.** 클라는 `floorSeq > 1` 일 때만 `conv.before` 를 부른다.
- `conv.since` 의 `more:true` 면 마지막 이벤트의 seq 를 `sinceSeq` 로 다시 부른다. 접기는 돌려준 구간 안에서만 한다.
  `sinceSeq` 가 데몬의 head 보다 크면(삭제 후 재생성 등) `reset:true` 와 함께 `conv.open` 과 같은 스냅샷을 준다 —
  클라는 로컬 상태를 버리고 그것으로 바꾼다.
- `conv.open` 의 `cwd` — 우리 색인에 없는 대화(목록의 `external:true`)를 처음 열 때 필요하다. 없으면 훅 바인딩에서 찾는다.
- `conv.caps.agents[].version` 은 모를 수 있다(null).
오류 코드(back 이 만든다): `TIMEOUT`(릴레이 타임아웃) `DAEMON_OFFLINE`(PC 미연결) `CONV_ERROR`(데몬이 code 를 안 줌).

### 4.0 REST 모양 (back 구현 확정)

- 요청 `POST /api/daemon/conv` `{method, params, hostDeviceId?}`. 성공은 **데몬 결과가 최상위**(래핑 없음), 200.
- 실패는 `{success:false, message, detail:{code}}`. HTTP 상태: 미허용 메서드 400(detail 없음), 꺼짐 403,
  PC 미연결 409, 그 외 데몬 오류 전부 500. **클라는 상태가 아니라 `detail.code` 로 분기한다**
  (기존 클라가 409 를 "PC 끊김"으로 읽으므로 데몬 오류에 409 를 쓰지 않는다).
- 데몬은 오류 시 `rpc_result` 에 `code` 를 실어야 한다.
- 클라 HTTP 타임아웃 = back 값 + 5초(create/send/open/adopt/toTerminal 35초, 나머지 20초).
  타임아웃 뒤에도 데몬이 성공했을 수 있다 → 재시도는 반드시 같은 `clientId`.
- 응답 크기: 데몬은 `conv.open`/`since`/`before` 응답을 **512KB 예산**으로 자른다(넘으면 개수를 줄이고
  `more:true`/`floorSeq` 로 이어받기). 앞단 Cloudflare 의 413/524 이력 때문.
- 서버 킬스위치는 평문 REST·중계·caps 만 닫는다. 봉투 RPC 로는 메서드가 보이지 않으므로, **데몬이
  `serverCaps` 에 `conv.v1` 이 없으면 `conv.*` 를 `CONV_DISABLED` 로 거절**해야 차단이 완성된다.

### 4.1 conv.send 규칙

- **멱등**: 같은 `clientId` 가 다시 오면 기존 결과를 돌려준다(재시도가 중복 전송이 되지 않는다). `seq` 는 그 메시지가
  **처음 기록된 seq**(= `first`)다. 겹쳐 들어온 같은 `clientId` 는 하나로 합친다. `conv.create` 도 `clientId` 로 멱등이다.
  **`failed` 인 메시지의 재시도만 다시 보낸다**(§10.2 의 [다시 시도]).
- 접수 즉시 `msg`(role user, `key:'u:'+clientId`, `status:'queued'`)를 기록·push 하고 stdin 에 쓴다.
- replay ack 가 오면 같은 key 로 `status:'sent'` upsert(`turn` 은 도달한 턴으로 바뀐다).
- 회신의 `status`: 쉬고 있던 대화면 도달 확인을 **최대 4초** 기다려 `'sent'`, 그 안에 확인이 없으면 `'queued'`
  (확인은 push 로 뒤따른다 — 느린 기동). 턴 진행 중이면 기다리지 않고 `'queued'`.
- 프로세스가 없으면 먼저 띄운다(`--resume`). 기동 실패면 `status:'failed'` upsert + 오류 회신(`START_FAILED`).
  선결 조건 거절(`THREAD_BUSY_IN_TERMINAL` · `TOO_MANY_LIVE` · `AGENT_UNAVAILABLE`)은 대화에 남기지 않는다.
- 프로세스가 도달 확인 전에 죽으면 확인을 못 받은 메시지는 전부 `failed` 가 된다.
- 턴 진행 중에 온 메시지는 그대로 stdin 에 쓴다(에이전트가 다음 도구 경계에서 읽는다). 표시상 'queued'.
- `/` 로 시작하는 입력도 그대로 보낸다(`-p` 가 지원하는 명령만 동작). 터미널 전용 명령
  (`init.terminal_slash_commands`)은 `conv.commands` 가 내보내지 않고, 보내면 에이전트에 전달하지 않은 채
  `msg(status:'failed')` + `notice(TERMINAL_ONLY_COMMAND)` 를 남기고 `{ok:false, status:'failed', code}` 로 회신한다.
  목록은 에이전트가 init 으로 알려준 뒤에야 안다 — 그 전에는 카탈로그 표(`commands.js`)로 대신하고 가드는 없다.
- 첨부: v1 과 같은 방식(파일은 PC 경로로 업로드되고 본문에 경로가 인용된다). 이미지 base64 블록은 후속.
  `attachments:[{path, name?, mediaType?}]`(최대 12) → 본문 끝에 `[첨부] <절대경로>` 줄로 붙고 `msg.attachments` 에 남는다.
  홈 jail 밖 경로는 버린다.
- 본문 상한 64KB. 넘으면 `BAD_REQUEST`.

### 4.2 conv.respond 규칙

| decision | 에이전트 응답 |
|---|---|
| `allow` | `behavior:'allow'`, `updatedInput:<원 입력>`, `always` 면 `updatedPermissions:<요청이 준 suggestions>` |
| `deny` | `behavior:'deny'`, `message: message \|\| '사용자가 거부했습니다'` |
| `answer` | 질문: `behavior:'allow'`, `updatedInput:{questions, answers}` / 계획: allow |

- `updatedPermissions` 는 **에이전트가 준 제안만** 되돌린다(클라가 보낸 값을 쓰지 않는다).
- `allow` + `message`(허용하고 추가 지시): 허용 응답 뒤 message 를 사용자 메시지로 stdin 에 쓴다.
- 이미 닫힌 요청이면 `REQ_NOT_PENDING`.
- `answers` 는 §4.4 의 맵이 정본이다. v1 카드와 같은 배열 `[{questionIndex, labels?|label?|text?}]` 도 받는다.
  에이전트에는 질문마다 **문자열 하나**로 넘긴다 — 다중 선택(배열)은 라벨을 `', '` 로 잇는다(에이전트가 배열을
  받는지는 실측하지 못했다. 단일 선택은 문자열로 실측). 질문에 `allow`/`answer` 인데 답이 비면 `BAD_REQUEST`.
- 추가 지시 메시지의 key 는 `'u:r-'+reqId`.
- `conv.interrupt` 는 열려 있는 요청을 **즉시** `canceled(interrupted)` 로 닫는다(턴 종료를 기다리지 않는다).
  턴이 요청을 남긴 채 끝나면 `canceled(turn_end)`.

### 4.3 conv.open 과 가져오기(import)

- 우리 로그가 없는 thread(= 터미널에서 만든 대화)는 에이전트 세션 파일을 `normalize` 로 읽어 로그를 만든다.
- 우리 로그가 있어도, 세션 파일에 우리가 모르는 라인(uuid 기준)이 있으면 그 부분만 덧붙인다
  (터미널에서 이어 간 뒤 채팅으로 돌아온 경우).
- 가져오기는 **프로세스가 떠 있지 않을 때만** 한다(라이브 중에는 stdout 이 정본). `conv.open` 과 `conv.since` 가
  세션 파일의 크기·수정 시각이 바뀌었을 때만 읽는다.
- 가져온 이벤트는 **push 하지 않는다**(수천 건일 수 있다). `thread` 힌트의 `headSeq` 가 늘어난 것을 본 클라가
  `conv.since` 로 당겨 간다.
- 세션 파일에만 있는 곁가지(첨부 메타·큐 조작·훅 요약)는 버린다. 한 번에 16MB 까지 — 넘으면 꼬리만 읽고
  `notice(IMPORT_TRUNCATED)`.
- 세션 파일 직접 읽기는 "과거 표시" 용도로만 남는 의존이다. 라이브 경로에는 없다.

### 4.4 구현 중 확정한 세부 (2026-09-30)

- `live` = 진행 중 블록의 **배열** `[{key, kind:'text'|'thinking', text}]`(없으면 `[]`). `conv.open`/`conv.since` 공통.
- `conv.respond.answers` = `{"<질문 문구>": "<라벨>" | ["<라벨>",…] | "<자유 텍스트>"}`. 계획 카드에 의견을 달면
  `decision:'allow'` + `message`.
- `conv.create` 도 `clientId` 로 **멱등**이다(타임아웃 뒤 재시도가 대화를 둘 만들지 않는다). 같은 clientId 면 기존 thread 를 돌려준다.
- 공유 표면 id = `c-<threadId>`(데몬 `surfaces.js` 의 id 규칙은 `^[A-Za-z0-9_-]{1,64}$` — 콜론 불가). PC·앱 공통.
- 보고 있다는 신호: push 가 살아 있어도 화면에 떠 있는 동안 **20초마다 `conv.since` 1회**(§7 의 "보는 기기" 30초 창을 유지).
- `conv.toTerminal` 이 돌려준 `command` 는 그대로 치지 않는다. 클라는 실행 파일을 뺀 인자만 기존 에이전트 실행 경로의
  `args` 로 넘긴다(실행 파일은 카탈로그가 정한다). 그래서 응답에 `args:['--resume','<id>']` 도 함께 싣는다.
- `control.kind:'deleted'` 를 받으면 그 탭은 빈 새 대화로 되돌린다. `'gone'` 은 재오픈.

### 4.5 파일 바이트·사용량 (2026-09-30 2차)

- `conv.file {threadId, path}` → `{mediaType, base64, bytes, name}` | `{missing:true, reason}`.
  - 허용 경로 = **그 대화의 이벤트에 등장한 경로만**: 사용자 첨부(`[첨부] <경로>` 줄·attachments), 도구 입력의
    파일 경로(tool.path·argsPreview), 어시스턴트 본문의 마크다운 이미지·링크 대상. 상대 경로는 thread.cwd 기준.
    `fs.safeResolve` jail 을 통과해야 하고 심링크 탈출 거부. 그 외는 `{missing:true, reason:'not_referenced'}`.
  - 상한 8MB(넘으면 `{missing:true, reason:'too_large', bytes}`). mediaType 은 확장자로.
  - back 허용 표에 추가(타임아웃 30초, 클라 35초).
- `thread.usage` = `{ contextTokens, contextMax, contextPct, costUsd, model }` — 턴 끝(result)과 assistant 메시지의
  usage 로 갱신. contextPct 는 0~100 정수. 클라는 컴포저 아래 한 줄로 "모델 · 컨텍스트 n%" 를 보인다(PC·앱 동일).
- 사용자 첨부는 보낸 버블에 **칩**(이미지면 썸네일)으로 보인다. 썸네일 바이트는 `conv.file`.
  클라는 본문의 `[첨부] <경로>` 줄을 본문에서 떼어 칩으로 그린다.
- 에이전트 선택: `conv.caps.agents` 중 `available` 이 2개 이상일 때만 새 대화 화면에 선택 줄을 보인다(지금은 claude 1개 → 숨김).
  `conv.create` 에 `agent` 로 넘긴다.
- 대화 안 검색: 클라 전용. 불러온 이벤트 범위 안에서 찾고, 더 앞은 "이전 내역 더 불러오기"로 넓힌다.

## 5. 프로세스 수명

- thread 당 프로세스 0 또는 1. 첫 `send`/`create` 에 뜬다.
- 동시 라이브 상한 `maxLive = 4`. 넘으면 **가장 오래 idle 인** 프로세스를 내린다. 전부 working 이면 `TOO_MANY_LIVE`.
- idle 10분이면 내린다(대기 중 요청이 있으면 내리지 않는다). 다음 입력에 `--resume` 으로 다시 뜬다.
- 데몬 종료 시 전부 정상 종료(stdin end → 3초 → SIGTERM). working 중이던 턴은 `turn end interrupted` 로 기록.
- 데몬 재시작 후: 로그는 디스크에 있으므로 `conv.open` 이 그대로 동작. `state` 는 `stopped` 로 복원.
  데몬이 비정상 종료해 남은 미결(열린 턴·대기 요청·미도달 메시지)은 그 대화를 처음 만질 때
  `turn end(daemon_restart)` · `canceled(process_exit)` · `failed` 로 닫는다.
- 실패로 끝난 턴(`is_error`, 중단 아님)은 `notice(TURN_FAILED|AGENT_NOT_LOGGED_IN)` + `state:'error'`. 프로세스는 살아 있다.
- 내려가는 중인 프로세스가 완전히 끝난 뒤에야 같은 대화의 새 프로세스를 띄운다.
- 새 세션(`--session-id`)이냐 이어받기(`--resume`)냐: 세션 파일이 있거나 에이전트가 한 번이라도 init 을 냈으면 이어받기.
- 프로세스가 죽으면: 대기 요청 전부 `canceled(process_exit)`, `notice error`, `state:'error'`.
- 실행 파일은 `agents.js` 카탈로그의 절대경로로 띄운다(앱이 띄운 데몬의 PATH 는 `/usr/bin:/bin` 뿐).
  **우리 심(shim)을 거치지 않는다.**
- 환경: `dispatch.js plannerEnv()` 와 같은 기반 + `TMUX` 제거 + `CPT_HOOKS_DISABLED=1`.
  `CPT_WS` 등 cpt 좌표는 **넘기지 않는다**(1차). 채팅에서 `cpt` 를 쓰게 하는 것은 후속.

## 6. 터미널과 이어받기

소유자는 항상 1명이다. `Thread.owner` 가 정본.

### 6.1 채팅 → 터미널 (`conv.toTerminal`)

1. working 이면 거부(`THREAD_BUSY`) — 클라가 "작업이 끝난 뒤 넘길 수 있어요" 안내.
2. 프로세스를 내린다. `owner:'none'`.
3. `{cwd, command:'<bin> --resume <id>'}` 를 돌려준다. 클라가 새 터미널 탭을 열어 그 명령을 실행한다
   (기존 에이전트 실행 경로 재사용). 터미널이 뜨고 훅 바인딩이 확인되면 데몬이 `owner:'terminal', ownerTid`.
   `command` 의 `<bin>` 은 절대경로가 아니라 **이름**(`claude`)이다 — 터미널에서는 우리 심을 거쳐야 훅이 걸린다.
   owner 는 **누가 볼 때**(`conv.list`/`open`/`since`/`send`) 사실을 다시 확인해 맞춘다(훅이 conv 에 통지하지 않는다).

### 6.2 터미널 → 채팅 (`conv.adopt`)

1. `(cwd, tid)` 의 바인딩(`transcript.lookupBind`)에서 세션 id 를 얻는다. 없으면 `THREAD_NOT_FOUND`.
2. 에이전트 상태가 working/permission 이면 거부(`THREAD_BUSY_IN_TERMINAL`).
3. TUI 를 종료한다: `C-u`(입력칸 비우기) → `/exit` → Enter → 셸 복귀(pane_current_command 가 셸) 확인, 최대 5초.
   이미 셸이면 건너뛴다. 실패하면 `ADOPT_FAILED` 로 거부하고 아무것도 바꾸지 않는다.
4. 세션 파일을 가져와 thread 를 만들고 `owner:'chat'`. 프로세스는 첫 입력에 뜬다.

### 6.3 충돌 방지

- `conv.send`/`conv.create(resume)` 전에, 그 세션 id 가 **살아 있는 터미널**에 바인딩돼 있고 에이전트가
  실행 중이면 `THREAD_BUSY_IN_TERMINAL` 로 거부한다. 클라는 "터미널에서 사용 중 — 채팅으로 가져오기" 를 띄운다.
- 목록의 external thread 에는 `owner:'terminal'` 이 표시된다.

## 7. 알림

| 사건 | 알림 |
|---|---|
| 승인·질문 요청 | 즉시. "조치 필요" |
| 턴 종료 | 보는 기기가 없을 때만. "작업 완료" + preview |
| 프로세스 오류 | 즉시 |

- 기존 알림 파이프라인(`notify` → back `createNotification` → present-device 라우팅 → FCM)을 쓴다.
- 알림 payload 에 `threadId` 를 실어, 탭하면 그 채팅 탭이 열린다. back 은 이를 `session_id` 컬럼에
  `conv:<threadId>` 로 저장하고(스키마 변경 없음) API·`notif_event`·FCM data 에 `threadId` 로 돌려준다.
- 알림 `kind`: 요청 `conv_request`, 완료 `conv_done`, 오류 `conv_error`. **`approval_request` 를 쓰지 않는다**
  (승인 인박스와 엮인다). 새 kind 는 back 이 subtitle 을 조합하지 않으므로 데몬이 title·subtitle 을 직접 보낸다.
- 멀티 PC: 데몬이 `push.data.hostDeviceId` 와 `deeplink`(`…&host=<id>`)를 실어 폰이 어느 PC 의 대화인지 안다.
- 데몬이 보내는 payload:
  `{source:'agent', kind, title:<에이전트 표시명>, subtitle:'「<폴더명>」에서 승인 대기|답변 대기|계획 확인 대기|완료|오류',
    body, cwd, wsName, threadId, deeplink:'codingpt://conv/<threadId>?cwd=<cwd>&host=<deviceId>', push:{data:{hostDeviceId}}}`.
  `body` = 요청은 상대 경로 또는 요약(리댁션됨), 완료는 preview. 기기 id 는 `daemon.json` 의 `deviceId`
  (미페어링이면 `host`·`push` 를 뺀다).
- 중단으로 끝난 턴은 알리지 않는다.
- "보는 기기" = 그 thread 에 최근 30초 안에 `conv.open`/`conv.since` 를 부른 클라가 있음.
- 승인 요청을 기존 `approvals.js` 파이프라인에 **이중 등록하지 않는다**(한 사실에 통로 하나).
  채팅 요청 카드는 conv 가 정본이고, 알림만 위 경로로 보낸다.

## 8. back

- `config/caps.js`: `conv.v1` (킬스위치 `CONV_ENABLED`).
- `POST /api/daemon/conv` (`accountAuth`, `connOptsOf(req)` 로 멀티 PC 지정). 허용 표 = §4 의 메서드.
  타임아웃: create/send/open/adopt/toTerminal 30초, 나머지 15초.
- `daemonRelayService`: `conv_event` → `fanoutConvEvent`(화이트리스트: threadId, headSeq, events, delta, thread, control).
  버퍼·알림 없음. SSE 폴백 포함.
- 알림 생성 시 `threadId` 통과.

## 9. 게이팅

채팅 탭은 `데몬 caps ∩ 서버 caps ∩ 클라` 에 `conv.v1` 이 모두 있을 때만 보인다. 하나라도 없으면
새 채팅 메뉴가 없고(구버전 PC 는 "PC 업데이트 필요" 안내), 기존 v1 토글은 그대로다.

데몬 킬스위치는 `daemon.json {"conv":{"enabled":false}}` 또는 env `CPT_CONV=0`. 꺼지면 hello 의 caps 에서 `conv.v1` 이
빠지고 `conv.*` 는 `CONV_DISABLED` 로 거절된다.

## 10. 클라이언트 공통 규칙

### 10.1 상태 기계

```
열기: conv.open → events 적용 → live 적용 → 구독 시작
push events: seq 연속이면 적용, 아니면 conv.since
push delta:  off 일치하면 이어 붙임, 아니면 conv.since
재접속·포그라운드 복귀: 즉시 conv.since
폴백 폴링: 15초(push 가 3초 안에 왔으면 건너뜀). 작업 중이면 5초
```

### 10.2 보내기

1. `clientId` 생성 → 낙관 버블(`status:'sending'`) 즉시 표시. 입력칸은 비우되 **원문을 버블이 보관**.
2. `conv.send`. 성공하면 서버의 `msg`(같은 clientId)가 버블을 대체.
3. 실패(오류·타임아웃 20초)면 버블 `failed` + [다시 시도] [삭제]. 다시 시도는 **같은 clientId**.
4. 오프라인(호스트 PC 끊김)이면 보내지 않고 버블을 `failed` 로 두며 상단에 연결 상태를 표시.
5. 전송 중에도 다음 메시지를 쓸 수 있다(직렬화하지 않는다).

### 10.3 작업 중 입력

- 전송 버튼은 작업 중 **중단 버튼**이 된다. 입력칸에 글자가 있으면 전송 버튼(대기열에 넣기)이 된다.
- 대기열 메시지는 흐리게 + "대기 중" 표시.

### 10.4 스크롤

- 바닥에서 48px 안이면 따라간다. 사용자가 위로 올리면 멈추고 "맨 아래로" 버튼.
- 델타로 자라는 동안에도 같은 규칙. 콘텐츠 증가로 생긴 스크롤 이벤트를 사용자 스크롤로 오인하지 않는다.
- 보낸 직후에는 항상 바닥으로.

### 10.5 스트리밍 렌더

- 진행 중 블록만 다시 렌더한다(완료된 행은 고정).
- 미완성 마크다운: 열린 코드 펜스는 닫힌 것으로 간주해 렌더, 표는 구분선이 오기 전까지 일반 텍스트.
- 커서 표시는 무채색. 포인트 컬러·이모지 금지.

### 10.6 빈 상태·목록

- 새 채팅 탭 = 빈 대화 + 입력칸. 첫 메시지에 `conv.create`.
- 대화 목록: 현재 워크스페이스의 thread. 제목, 마지막 활동, 상태 점(작업 중/조치 필요), preview.
- 터미널에서 만든 대화도 목록에 있다(가져오기로 연다).

### 10.7 탭과 공유

- 채팅 탭은 **공유 표면**이다(`surfaces.json` kind `chat`, 속성 `threadId`·`title`). 어느 기기에서 열면 전부에
  나타나고 어디서 닫으면 전부에서 사라진다. 배치는 기기 로컬. 구 클라는 모르는 kind 를 걸러 낸다.
- 탭을 닫아도 대화는 남는다(목록에서 다시 연다). 대화를 지우는 것은 `conv.remove` 뿐.
- 아직 첫 메시지를 보내지 않은 새 채팅 탭은 `threadId` 가 없다 → 표면에 등록하지 않는다(기기 로컬).
  `conv.create` 가 성공한 순간 threadId 를 탭에 쓰고 표면에 등록한다.
- 탭 객체에는 `threadId`, `title`, 초안(4KB)만 둔다. 대화 본문을 레이아웃에 넣지 않는다.

### 10.8 요청 카드

- 승인·질문·계획 카드는 conv 의 `req` 가 정본이다. 기존 카드 컴포넌트를 쓰되 응답은 `conv.respond` 로 보낸다
  (컴포넌트에 응답 콜백을 주입한다 — 기존 `approval_event` 파이프라인에 올리지 않는다).
- 카드는 컴포저 위 고정 도크. 여러 개면 가장 오래된 것부터, "n개 더" 표시.
- 다른 기기가 먼저 답하면 `req` upsert 로 카드가 즉시 닫힌다.

### 10.9 로컬 캐시 (모바일)

- 색인은 AsyncStorage, 본문은 파일(`DocumentDir/cpt-conv/<계정>-<host>-<threadId>.json`). thread 당 최근 300 이벤트.
- 열 때 캐시를 먼저 그리고 `conv.since(캐시 headSeq)` 로 화해한다. 정본은 데몬.
- 로그아웃 시 전부 삭제. E2EE 정책이 `required` 면 캐시하지 않는다.
- PC 는 캐시하지 않는다(데몬이 같은 기기이거나 LAN).

## 11. 후속 (이번 범위 아님)

- codex(`codex app-server`) 어댑터, ACP 어댑터.
- 이미지 base64 첨부, 파일 되감기(checkpoint), 포크.
- 채팅 세션에서 `cpt` CLI 사용(프리뷰 열기 등).
- E2EE 봉투로 conv_event 봉인.
