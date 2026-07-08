# 러너 계약 명세 (Runner Contract) — 초안 v0.1

> **목적**: 모바일 앱·웹 ↔ 릴레이(back) ↔ 러너(PC 데몬 / 클라우드) 사이의 **단일 계약**을 정의한다.
> 이 계약 하나를 기준으로 ① 모바일 IDE 소스 레이어 교체(isDaemon 분기 소거), ② 데몬 구조화 에이전트 세션(BYO), ③ 클라우드 러너 BYO 전환이 각각 독립적으로 진행된다.
>
> **관계 문서**: 기획 정본 = 새 기획서(Final/MVP) §2·§2.1·§5.5·§6.5. 현재 토대 = [`byo-pc-status.md`](./byo-pc-status.md).
> **상태**: 설계 초안. 구현 전 검토용. 최종 갱신 2026-07-09.

---

## 0. 설계 원칙

1. **러너 fs = 단일 원본.** 에디터·터미널·프리뷰·에이전트는 전부 러너의 실제 파일시스템 하나를 읽고 쓴다. objectstore는 체크포인트(정본 스냅샷)와 메타 전용 — IDE 저장 경로에서 제거된다.
2. **클라이언트는 타겟을 모른다.** 앱/웹은 이 계약만 바라본다. local(데몬)이든 cloud(컨테이너)든 동일 메서드·동일 이벤트. `isDaemon` 분기 금지.
3. **기존 자산 승격, 재발명 금지.**
   - 에이전트 이벤트 8종(`agent_init/text/thinking/tool_use/tool_result/permission_request/done/error`)은 그대로 이 계약의 정규화 스키마가 된다 (기획서 CodingPT Event와 1:1).
   - 데몬의 제어 WS + dial-back 스트림 구조, PTY 와이어 계약(바이너리=stdin, JSON resize, raw out), 프리뷰 HMAC 토큰은 유지·확장.
4. **드롭 정책**: `files`·`control`·`agent` 이벤트는 절대 드롭 금지(순서 보장). `terminal` 출력·프리뷰는 고volume이라 최신 우선 드롭 허용.
5. **AI 우선 편집 규칙** (제품 결정): 모바일 IDE는 확인+가벼운 수정 용도. 에이전트 파일 수정은 항상 이기고, 사용자 버퍼는 그에 맞춰 갱신된다. §3.4 참조.

---

## 1. 전송 · 프레이밍

### 1.1 연결 토폴로지 (기존 유지)

```
클라이언트(앱/웹) ──WSS──► 릴레이(back) ◄──아웃바운드 WSS── 러너
                              · 제어 채널 1개 (JSON 프레임)
                              · dial-back 스트림 N개 (pty/tcp 바이너리)
```

- 러너는 인바운드 포트 0. 제어 WS로 상시 연결, 고대역 스트림은 `stream_open` 지시 → 러너가 아웃바운드로 다이얼.
- 클라이언트↔릴레이도 WSS 1개에 채널 다중화. (현재 SSE로 받는 에이전트 이벤트는 이 WSS의 `agent` 채널로 이관 — 리플레이(§2.3)를 위해 필수.)

### 1.2 공통 프레임 (JSON, 제어·이벤트용)

```jsonc
{
  "v": 1,
  "id": "req-uuid",        // req/res 상관관계용 (event엔 없음)
  "type": "req|res|err|event|input",
  "channel": "control|files|terminal|agent|preview",
  "workspaceId": "ws_xxx",
  "sessionId": "as_xxx",   // agent 채널만
  "seq": 123,              // event만, 채널별 단조 증가
  "method": "fs.read",     // req만
  "payload": { }
}
```

- `req` → `res`(성공) 또는 `err`(§7 에러 모델). 타임아웃 기본 15s, `fs.tree`·`fs.grep`은 60s.
- `event`: 서버→클라이언트 단방향, 채널별 `seq` 단조 증가. 갭 감지 시 클라이언트가 `control.resync` 요청.
- 바이너리(터미널 raw, 프리뷰 tcp)는 프레임에 싸지 않고 기존 dial-back 전용 소켓 그대로.

---

## 2. control 채널

| method / event | 방향 | 내용 |
|---|---|---|
| `hello` → `hello_ack` | 양쪽 | 토큰, clientType(mobile/web/daemon/cloud), deviceId, v, capabilities |
| `attach { workspaceId, channels, lastSeq{} }` → `attach_ack { headSeq{} }` | 클라→릴레이 | 채널별 lastSeq 이후 이벤트 리플레이(§2.3) |
| `ack { channel, seq }` | 클라→릴레이 | 주기적(5s). 릴레이 버퍼 트리밍 기준 |
| `runner_status { workspaceId, state }` | event | 러너 online/offline/provisioning — 앱 연결 인디케이터 소스 |
| `token_refresh` | 클라↔릴레이 | 무중단 토큰 갱신, 실패 시 재접속 |

### 2.3 리플레이 (기획서 §5.5의 뼈대)

- 릴레이는 워크스페이스별 **롤링 이벤트 버퍼**(채널별, 기본 최근 1,000건 또는 5분)를 유지한다.
- `agent` 채널은 추가로 러너가 **세션 전체 이벤트 로그**를 보관(에이전트 세션 파일과 별개로, seq 붙은 우리 이벤트) — 앱을 오래 닫았다 와도 `attach(lastSeq)`로 따라잡는다.
- 폰이 죽든 백그라운드든, **세션은 러너에서 계속 돈다.** 완료/승인대기/에러 시 푸시 알림(릴레이가 발송, 별도 명세).

---

## 3. files 채널

### 3.1 메서드

| method | params | 반환 | 비고 |
|---|---|---|---|
| `fs.list` | dir | entries[] | 1депь |
| `fs.tree` | dir, depth?, ignore? | tree | 무거운 dir 필터(현행 데몬 규칙 유지) |
| `fs.read` | path, offset?, limit? | { content, encoding, size, mtime } | 텍스트=utf8. **바이너리=base64** (이미지 프리뷰 지원). 대용량은 청크 |
| `fs.write` | path, content, **baseMtime?** | { mtime } | §3.4 충돌 규칙. 자동 저장의 write 지점 |
| `fs.stat` | path | { size, mtime, type } | |
| `fs.mkdir` / `fs.rename` / `fs.delete` / `fs.move` | | | delete는 휴지통/보존 정책 러너 재량(데몬=PC 파일이므로 보수적) |
| `fs.watch` / `fs.unwatch` | dir | | watch 중 변경 → `fs_event` |
| `fs.grep` | query, dir?, glob?, regex?, limit | matches[{path,line,text}] | **MVP 포함 확정.** 러너에서 ripgrep/grep 실행, 결과 상한(기본 500) |

- 파일 내 검색/치환은 클라이언트(CodeMirror) 몫 — 계약에는 grep(프로젝트 전체)만 있다.

### 3.2 이벤트

`fs_event { kind: add|change|unlink|addDir|unlinkDir, path, mtime, origin? }`
- `origin`: 가능하면 `agent|user|external` 힌트 (에이전트 tool_use 직후의 변경은 agent로 마킹). 클라이언트 UI가 "에이전트가 수정함" 표시에 사용. best-effort.

### 3.4 편집·저장 규칙 (제품 결정 반영 — AI 우선 + 자동 저장)

1. **자동 저장**: 클라이언트는 타이핑 멈춤 후(디바운스 ~1s) `fs.write`를 보낸다. 저장 버튼 없음.
2. **AI 우선**: 열려 있는 파일에 `fs_event(change)`가 오면 —
   - 사용자가 안 건드린 파일: 즉시 버퍼 갱신 (라이브 반영).
   - 사용자가 타이핑 중(dirty)인 파일: **버퍼를 에이전트 내용으로 교체**하고 pending 자동 저장을 **취소**한다.
3. **역덮어쓰기 방지 (필수 안전장치)**: `fs.write`에 클라이언트가 알고 있던 `baseMtime`을 실어 보낸다. 러너의 실제 mtime과 다르면(=그 사이 에이전트가 씀) 러너는 쓰지 않고 `CONFLICT`를 반환 → 클라이언트는 다시 읽어 버퍼 갱신. 이 한 줄이 없으면 "stale 자동 저장이 에이전트 변경을 도로 덮어쓰는" 역전이 발생해 AI 우선 원칙이 깨진다.

---

## 4. terminal 채널

### 4.1 메서드 (멀티 터미널 — 데몬·클라우드 동일, MVP)

| method | 내용 |
|---|---|
| `term.list { workspaceId }` | 터미널 탭 목록 (tmux 윈도우 기반) |
| `term.open { cwd, name? }` | 새 터미널 → streamToken 발급 |
| `term.attach { termId }` | 기존 터미널에 스트림 재연결 |
| `term.resize { termId, cols, rows }` | |
| `term.close { termId }` | |

### 4.2 스트림 (기존 와이어 유지)

- dial-back `kind:'pty'` 전용 소켓. **바이너리 = stdin/stdout raw, JSON = resize.** 앱 `TerminalWebView` 무수정.
- tmux 규약: 소켓 `-L codingpt`, 워크스페이스 세션 `cpt-<slug>`, 탭 = tmux 윈도우. 러너 프로세스가 죽어도 tmux 세션 생존 → `term.attach`로 재부착. 클라우드 러너도 컨테이너 안 tmux로 동일 구현.

---

## 5. agent 채널 (BYO 구조화 세션)

### 5.1 메서드

| method | params | 내용 |
|---|---|---|
| `agent.sessions` | workspaceId | **저장된 대화 목록** — 러너의 에이전트 세션 스토어(claude는 `~/.claude/projects/<cwd-slug>/*.jsonl`)를 읽어 `{ id, title, lastAt, turns, source: app|external }` 반환. PC 터미널에서 하던 대화도 여기 뜸 (**이어받기 킬러 피처**) |
| `agent.start` | adapter, cwd, resumeId? | 러너가 어댑터 매니페스트대로 **사용자의 CLI를 구조화 모드로 spawn** (claude: `-p --output-format stream-json --input-format stream-json --verbose`; resumeId 있으면 `--resume`). 반환: sessionId |
| `agent.input` | sessionId, text | stdin으로 user 메시지 주입 (멀티턴) |
| `agent.approve` | sessionId, requestId, decision | 승인/거절 되돌려주기 |
| `agent.interrupt` | sessionId | 턴 중단 |
| `agent.stop` | sessionId | 프로세스 종료 (세션 파일은 남음 → 재resume 가능) |
| `agent.status` | sessionId | state: starting/running/waiting_input/waiting_approval/idle/stopped/crashed |

### 5.2 이벤트 (정규화 스키마 — 기존 8종 유지)

`agent_init { sessionId, model, cwd } / text { delta } / thinking / tool_use { toolUseId, tool, input, relPath? } / tool_result { toolUseId, ok, content } / permission_request { requestId, tool, input, relPath, diff } / done { ok, subtype, summary, costUsd?, usage? } / error { code, message }`

- 어댑터가 자기 CLI 출력을 이 스키마로 매핑한다. **클라이언트(앱/웹 채팅 UI)는 무수정 재사용.**
- 매핑 위치: 러너(데몬/클라우드) 안. 릴레이는 중계+버퍼만.

### 5.3 정책·수명주기

- **인증**: 러너에 로그인된 사용자 자신의 CLI/구독. 우리는 크레덴셜을 읽지도 옮기지도 않는다.
- **승인 기본값**: 사용자 PC의 기존 CLI 설정(allowlist 등) 그대로. 우리가 permission-mode를 덮어쓰지 않는다. CLI가 승인을 물으면 그때만 `permission_request` 카드 + (백그라운드면) 푸시.
- **세션 생존**: 프로세스는 러너에서 산다. 폰 연결과 무관. 러너 재시작 후엔 `resumeId`로 대화 복원.
- **핸드오프**: 체크포인트에 코드 + **에이전트 세션 파일 포함**(확정) → 클라우드에서 같은 대화 resume. 반입 여부는 워크스페이스 설정으로 제외 가능(프라이버시 고지).
- MVP 동시성: 워크스페이스당 구조화 세션 1개. 터미널에서 사용자가 직접 띄운 CLI(TUI)는 관여하지 않음(미러만).

### 5.4 어댑터 매니페스트 (claude-code 예시)

```yaml
adapter: claude-code
detect: "claude --version"
launch: "claude -p --output-format stream-json --input-format stream-json --verbose"
resume: "--resume {sessionId}"
sessionStore: "~/.claude/projects/{cwdSlug}/*.jsonl"
mode: structured
eventMap: { assistant→text/tool_use, user.tool_result→tool_result, result→done, ... }
interrupt: SIGINT          # 1차. control 프로토콜 확인 후 교체 가능
```
- generic(PTY 폴백) 어댑터 = 4장 터미널 그 자체. 구조화 미지원 CLI는 그냥 터미널 탭.

---

## 6. preview 채널 (기존 유지 + 명세화)

| method | 내용 |
|---|---|
| `preview.ports` | 러너의 리스닝 포트 목록 (lsof/proc) |
| `preview.open { port }` | tcp 터널 + HMAC 토큰 URL 발급 (`dpv` 쿠키 루트 라우팅, HMR 브리지 현행 유지) |
| `preview.close` | |

- 러너의 dev 서버를 절대 러너 밖에서 종료하지 않는다 (사용자 프로세스).

---

## 7. 에러 모델

`err { code, message, retryable, channel }`

| code | 의미 / 클라이언트 행동 |
|---|---|
| `AUTH_EXPIRED` | 토큰 갱신 또는 재로그인 |
| `RUNNER_OFFLINE` | "PC가 꺼져 있어요" → [클라우드로 전환] 제안 |
| `SESSION_GONE` | 세션 종료됨 → sessions 목록에서 resume 유도 |
| `AGENT_NOT_READY` | CLI 미설치/미로그인 → 온보딩 체크리스트로 |
| `CONFLICT` | fs.write baseMtime 불일치 → 재읽기 후 버퍼 갱신 (§3.4) |
| `NOT_FOUND` / `RATE_LIMITED` / `INTERNAL` | 표준 처리 |

---

## 8. 러너별 구현 매핑

| 계약 | LocalRunner(데몬, 현행) | CloudRunner |
|---|---|---|
| files | `fs.list/tree/read/write/watch` **거의 그대로** + 신규: grep, stat, mkdir/rename/delete/move, baseMtime, base64 read | 신규 (데몬 fs 모듈 재사용 검토 — §9) |
| terminal | dial-back pty + tmux 있음. 신규: `term.list/open/attach/close` 멀티 탭 API | 컨테이너 내 tmux 동일 |
| agent | **전면 신규** (기존 "claude -p 금지" 경계 폐기 확정) | 동일 코드 |
| preview | `net.ports` + tcp 터널 현행 유지 | devproxy 방식과 통합 |
| control | hello/stream_open/rpc 현행 → attach/ack/seq 추가 | 동일 |

## 9. 미결 (구현 전 확정 필요)

- **러너 코드 공유**: 데몬 lib(fs/pty/proxy)를 "러너 코어" 패키지로 추출해 클라우드 컨테이너에서도 그대로 돌릴지 (권장 — 계약 구현이 한 벌이 됨).
- 클라이언트↔릴레이 WSS 다중화의 기존 SSE/REST 대체 순서 (병행 기간 둘지).
- seq 버퍼 크기·보존 시간, fs.read 청크 크기, grep 상한 기본값.
- 푸시 알림 트리거 목록과 페이로드 (done/permission_request/crashed/RUNNER_OFFLINE).
- 어댑터 2호(codex) 매니페스트 — 계약 검증용.
