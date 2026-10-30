# CodingPT 외부 연동 API

다른 프로젝트·서비스에서 **사용자 PC 에 설치된 에이전트(사용자 자신의 CLI·구독)** 를 세션 단위로 부른다.
에이전트는 PC 의 진짜 폴더에서 파일을 고치고 명령을 실행한다. 일반 LLM API 가 아니라 **PC 에서 일하는 동료에게 일을 맡기는 API** 다.

- 기본 주소: `https://codingpt-back.ghmate.com/api/v1`
- 인증: `Authorization: Bearer cptx_…` (CodingPT PC 앱 > 설정 > 외부 연동에서 만든다. 원문은 만들 때 한 번만 보인다)
- 응답은 JSON. 실패는 `{ "success": false, "message": "...", "detail": { "code": "..." } }` — **`detail.code` 로 분기한다.**
- 현재 지원 에이전트: `claude`.

## 꼭 알아야 할 규칙

- **키는 PC 한 대에 묶인다.** 그 PC 가 꺼져 있으면 `503 DAEMON_OFFLINE`.
- **이 키로 만든 세션만** 보이고 이어 갈 수 있다. 사람이 CodingPT 에서 하던 대화나 다른 키의 세션은 `404 SESSION_NOT_FOUND`.
- 사용자는 같은 세션을 CodingPT 앱(PC·폰)의 대화 탭으로 보고, 승인에 답하고, 끼어들 수 있다. 먼저 답한 쪽이 적용된다.
- 키에 허용 폴더가 있으면 그 밖은 `403 PATH_NOT_ALLOWED`.
- 프롬프트는 TLS 로 CodingPT 서버를 지나 PC 로 간다(종단간 암호화 아님). 비밀값을 프롬프트에 넣지 않는다.
- **API 키는 서버 측 환경변수에만 둔다.** 이 키는 사용자 PC 에서 명령을 실행하는 권한이다. 브라우저·앱 번들에 넣지 않는다.
- **최종 사용자의 입력을 프롬프트에 그대로 이어 붙이지 않는다.** 그 사람이 PC 의 에이전트를 조종하게 된다.

## 세션 흐름

```
POST /sessions → GET /sessions/:id/events?wait=25 (반복)
                  ├ session.state = working      계속 받는다
                  ├ pending 있음(state=waiting)   POST /sessions/:id/requests/:reqId 로 답한다
                  └ session.state = idle|stopped  끝. POST /sessions/:id/messages 로 이어서 지시한다
```

세션은 PC 에 남는다. 프로세스가 내려가 있어도(`stopped`) 메시지를 보내면 같은 대화가 다시 뜬다.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/agents` | 쓸 수 있는 에이전트·모델·모드 |
| GET | `/workspaces` | PC 의 워크스페이스 `{ workspaces:[{name,path}] }` |
| POST | `/workspaces` | 새 폴더+git 저장소 `{ name, parentPath }` |
| POST | `/sessions` | 세션 만들기 |
| GET | `/sessions` | 이 키의 세션 목록 |
| GET | `/sessions/:id?after=N` | 세션 상태 + `after` 뒤 이벤트 |
| GET | `/sessions/:id/events?after=N&wait=25` | 새 이벤트를 최대 wait 초 기다린다(long-poll) |
| POST | `/sessions/:id/messages` | 이어서 지시 `{ text, clientId? }` |
| POST | `/sessions/:id/requests/:reqId` | 승인·질문에 답 |
| PATCH | `/sessions/:id` | 모드·모델 변경 `{ mode?, model? }` |
| POST | `/sessions/:id/interrupt` | 지금 턴 중단 |
| POST | `/sessions/:id/stop` | 프로세스만 내림(대화는 남음) |
| DELETE | `/sessions/:id` | 세션 삭제. worktree·브랜치는 남고 응답에 경로가 온다 |

### 세션 만들기

```json
POST /sessions
{
  "cwd": "/Users/me/projects/my-app",
  "prompt": "결제 실패 문구를 고쳐 줘",
  "title": "결제 문구",
  "mode": "default",
  "model": "claude-sonnet-5-5",
  "worktree": { "branch": "fix/payment-copy", "base": "main" },
  "clientId": "my-request-123"
}
```

- `cwd` 필수. 절대경로 또는 `~/…`. `prompt` 를 빼면 빈 세션을 만든다.
- `worktree`: 생략 = 그 폴더에서 바로 작업 · `true` = 전용 브랜치·폴더 자동 생성 · 객체 = 이름 지정. git 저장소여야 한다. `.env` 파일은 복사된다.
- `mode`: `default`(수정·실행마다 승인) · `acceptEdits`(파일 수정 자동) · `plan` · `auto` · `bypassPermissions`·`dontAsk`(승인 없이 실행 — 키에서 허용했을 때만, 아니면 `403 BYPASS_NOT_ALLOWED`).
- `clientId`: 같은 값으로 재시도하면 세션이 하나만 생긴다. 메시지도 같다. **타임아웃 뒤 재시도에는 반드시 같은 clientId 를 쓴다.**

응답: `{ "session": Session }`

```
Session = { id, agent, title, state, mode, model, cwd, repo, branch, worktree, pending, preview, usage, createdAt, lastAt }
state   = working | waiting(승인·질문 대기) | idle | stopped(다음 메시지에 자동으로 뜸) | error
```

### 이벤트

`events`/`get` 응답: `{ session, events, cursor, more, partial, pending }`

- 다음 호출의 `after` 에 `cursor` 를 넣는다. `more:true` 면 바로 다시 부른다.
- `partial` = 쓰는 중인 글 `[{key, kind, text}]` (실시간 표시용, 나중에 message 로 확정된다).
- `pending` = 지금 열린 승인·질문. 이것만 보면 답할 것을 놓치지 않는다.

```
{ seq, ts, type:"message", message:{ key, role:"user"|"assistant", kind:"text"|"thinking"|"tool"…, text, … } }
{ seq, ts, type:"request", request:Request }      상태가 바뀔 때마다 같은 id 로 다시 온다
{ seq, ts, type:"turn", phase:"start"|"end", ok, subtype, usage, costUsd }
{ seq, ts, type:"notice", level, code, text }
```

같은 `message.key`·`request.id` 는 뒤의 것이 앞을 대체한다.

### 승인·질문에 답하기

```
Request = { id, kind:"permission"|"question"|"plan", tool, summary, detail, relPath, diff, questions?, plan?, alwaysLabel?, status, requestedAt }
```

| kind | 답 |
|---|---|
| permission | `{ "decision":"allow" }` · `{ "decision":"allow","always":true }`(alwaysLabel 이 있을 때 같은 일 계속 허용) · `{ "decision":"deny","message":"이유" }` |
| question | `{ "decision":"answer","answers":{ "질문 문장":"고른 라벨" } }` |
| plan | `{ "decision":"allow" }` · `{ "decision":"deny","message":"고칠 점" }` |

`allow` 에 `message` 를 함께 보내면 허용한 뒤 추가 지시로 전달된다. 이미 닫힌 요청은 `409 REQ_NOT_PENDING`.
응답이 없으면 요청은 열린 채 기다린다. 서비스 화면에 승인 UI 를 붙이거나, 위험 없는 일이면 `acceptEdits` 모드를 쓴다.

## 오류 코드

`UNAUTHORIZED` 401 · `BAD_REQUEST`·`NOT_A_REPO` 400 · `PATH_NOT_ALLOWED`·`BYPASS_NOT_ALLOWED`·`EXTERNAL_DISABLED` 403 · `SESSION_NOT_FOUND` 404 ·
`REQ_NOT_PENDING`·`THREAD_BUSY`·`THREAD_BUSY_IN_TERMINAL` 409 · `TOO_MANY_LIVE`(동시 실행 상한)·`RATE_LIMITED` 429 ·
`DAEMON_OFFLINE`·`AGENT_UNAVAILABLE`·`AGENT_NOT_LOGGED_IN` 503 · `TIMEOUT` 504

`TIMEOUT` 은 PC 에서 처리됐을 수도 있다는 뜻이다. 같은 `clientId` 로 재시도한다.

## SDK · CLI · MCP (파일 하나, 의존성 없음, Node 18+)

```sh
curl -fsSL https://codingpt-back.ghmate.com/api/v1/sdk/codingpt.mjs -o codingpt.mjs
```

```js
import { CodingPT } from './codingpt.mjs';
const cp = new CodingPT();                       // CODINGPT_API_KEY 사용
const s = await cp.createSession({ cwd: '/Users/me/my-app', prompt: '오타 고쳐 줘', mode: 'acceptEdits' });
for await (const ev of cp.stream(s.id)) console.log(ev);   // 실시간. 일이 멈추면 끝난다
const r = await cp.ask(s.id, '테스트도 돌려 줘', {
  onRequest: async (req) => ({ decision: 'allow' }),       // 승인을 서비스에서 처리
});
console.log(r.text);
```

```sh
node codingpt.mjs new ~/my-app "오타 고쳐 줘" --worktree --wait
node codingpt.mjs send <세션> "테스트도 돌려 줘" --wait
node codingpt.mjs allow <세션> <요청>
node codingpt.mjs help
```

MCP(stdio) — 프로젝트의 `.mcp.json`:

```json
{ "mcpServers": { "codingpt": { "command": "node", "args": ["codingpt.mjs", "mcp"], "env": { "CODINGPT_API_KEY": "${CODINGPT_API_KEY}" } } } }
```

## 끄기

키 폐기: PC 앱 > 설정 > 외부 연동. PC 전체 차단: `~/.codingpt/daemon.json` 에 `"externalApi": false`.
