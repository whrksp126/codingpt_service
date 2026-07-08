# 코딩PT — 모바일 바이브 코딩 서비스 기획서 (Final / MVP)

> **채택**: 2026-07-08. 이후 설계 논의에서 일부 항목이 확정 결정으로 **대체**되었다 — 최신 결정은 [`mvp-roadmap.md`](./mvp-roadmap.md)의 "확정 결정 요약"이 이 문서보다 **우선**한다.
> 주요 대체 사항: code-server/풀 IDE 모드 **완전 폐기**(§5.6·§7.5의 code-server 탈출구 무효, 충돌은 자체 UI로 완결), 웹 바이브코딩 MVP 동결, 데몬 OS = Mac+Linux 병행, 기존 클라우드 엔진 빅뱅 철거, PC 대화 이어받기(--resume) MVP 채택, 클라우드 크레덴셜 암호화 동면 포함.
> 러너 인터페이스의 구체 명세는 [`runner-contract.md`](./runner-contract.md), 현재 구현 토대는 [`byo-pc-status.md`](./byo-pc-status.md).

---

> **성격 규정(중요):** 코딩PT는 **AI 에이전트 도구가 아니라, 모바일에서 사용자의 PC·서버를 조작하게 해주는 "원격 조작 서비스"**다. 파일·터미널·실행·프리뷰 접근을 폰으로 제공하고, **AI 에이전트는 그 위에서 돌리는 주력 워크로드일 뿐**이다. 따라서 에이전트 공급사 ToS는 우리 리스크가 아니라 사용자 안내 사항이다(§10·§11).
>
> **확정 전제:** (1) CLI로 실행되는 AI 에이전트를 (주 워크로드로) 지원, (2) 클라우드 폴백 MVP 필수, (3) 파워유저·입문자 둘 다 타겟.

## 핵심 결정 요약 (한눈에 — 담당 에이전트 인수인계용)
- **정체성**: 모바일 원격 조작 서비스(PC/서버) + 그 위의 바이브 코딩.
- **구성**: 모바일 앱(iOS·Android, RN) ↔ 릴레이 서버(우리 운영) ↔ Runner(PC 데몬 / 클라우드).
- **Runner**: 로컬(Mac 데몬 우선) + 클라우드(자체 microVM). 동일 인터페이스.
- **동기화**: git 기반 정본 스냅샷(§5), 단일 활성 타겟, 핸드오프 시 3-way(§5.6).
- **연결**: 아웃바운드 WSS 릴레이(포트포워딩 X), 프로토콜 §6.5, 세션 리플레이 §5.5.
- **화면 2개(§7.5)**: 바이브 코딩(채팅형) + IDE(트리·에디터·터미널·웹). IDE 엔진 구현은 담당 에이전트 위임.
- **에이전트 인증**: 우리가 중계 안 함 — 사용자가 러너에 직접 설치·로그인(BYO). LLM 비용 0.
- **비용**: 클라우드 scale-to-zero + 사용량 계측(§10·§10.5·§11.5). 자체 microVM이 최대 실행 리스크 → 초기엔 컨테이너+격리로 시작.
- **어댑터**: MVP는 Claude Code(구조화)+generic(PTY). 이후 Codex→Gemini→Copilot(§9).

## 0. 한 줄 정의
**"모바일에서 내 PC·서버에 원격 접속해, 그 위의 CLI AI 에이전트를 돌리고 코드를 실제 실행하며, 결과를 실시간으로 확인·조작하는 워크스페이스 단위의 원격 개발 서비스."**
(주력 유스케이스 = 모바일 바이브 코딩. 아키텍처 성격 = 범용 원격 조작.)

## 1. 기획이 막혔던 지점을 푸는 핵심 통찰 3개
1. **에이전트를 이해하려 하지 마라.** CLI 에이전트는 그냥 "PTY 안에서 도는 프로세스"다. 서비스는 stdin을 넣고 stdout/stderr를 뽑고 파일 변화를 감시할 뿐, 에이전트의 속을 몰라도 된다. → 어떤 CLI 에이전트든 얹을 수 있다.
2. **"완전 동일한 클라우드"는 실시간 미러링이 아니라 정본 스냅샷 문제다.** PC가 꺼진 순간 실시간 동기화는 불가능하다. 그러니 애초에 **서버에 살아있는 정본 스냅샷**이 있어야 하고, PC와 클라우드는 그걸 받아쓰는 클라이언트다. 실시간 미러링은 "둘 다 켜져 있을 때의 편의"일 뿐 핵심이 아니다.
3. **"즉시즉시 확인"(스트리밍)과 "동기화"(체크포인트)는 완전히 다른 축이다.** 결과 스트리밍은 항상 실시간, 동기화는 핸드오프 시점에만. 이 둘을 분리해야 설계가 안 꼬인다.

## 2. 핵심 추상화 — Runner 인터페이스
로컬이든 클라우드든 **똑같은 인터페이스**를 구현한다. 모바일은 "타겟이 로컬인지 클라우드인지" 몰라도 되게.

```
interface Runner {
  spawnAgent(adapter, workspacePath, env) -> sessionId   // 에이전트 실행(구조화 모드 우선, 안되면 PTY)
  writeStdin(sessionId, bytes)                           // 폰에서 명령 입력
  streamOutput(sessionId) -> stream<PtyChunk>            // stdout/stderr 실시간
  watchFiles(workspacePath) -> stream<FileChangeEvent>   // 파일 diff 감시
  runCommand(profile) -> stream<CmdOutput>               // build/test/dev 실행
  exposePort(port) -> previewUrl                         // 웹 프리뷰 터널
  checkpoint(workspacePath) -> checkpointId              // 정본 스냅샷 생성
  materialize(checkpointId) -> workspacePath             // 스냅샷 복원

  // 모바일 IDE용 서비스 (§7.5) — 로컬/클라우드 러너 공통
  files:    listDir/read/write/create/rename/delete/move + watch  // File Service
  terminal: open/write/stream/resize/close (멀티 PTY, 에이전트도 그중 하나)  // Terminal Service
  preview:  exposePort/serveStatic -> previewUrl                   // Preview Service
  ideServer: startCodeServer() -> ideUrl                          // [폐기됨 — code-server 미채택]
}
```

- **LocalRunner** = 사용자 PC에 깔린 데몬이 구현.
- **CloudRunner** = 네 서버의 격리 컨테이너/microVM가 구현.
- 워크스페이스는 하나, `activeTarget`만 스위칭한다.

### 2.1 에이전트 출력 처리 — 구조화 이벤트 우선, PTY 폴백 (⭐ 모바일 UX의 핵심)
터미널 화면을 그대로 미러링하지 않는다. 에이전트에게 **기계용 구조화 출력**을 요청해 받아, 모바일 네이티브 UI로 새로 그린다. (Claude Code 앱이 하는 방식.)

**2계층 렌더링**
1. **구조화 계층(상)** — 에이전트가 구조화 출력 모드를 지원하면 그걸 소비. 예: Claude Code는 `claude -p --output-format stream-json --verbose`로 한 줄당 JSON 이벤트(세션 시작, tool 호출, tool 결과, 부분 메시지, 승인 요청, 재시도, 최종 결과)를 뱉는다. `--input-format stream-json`으로 폰의 명령·승인을 되돌려 넣는다. → 버블·diff카드·승인버튼 같은 네이티브 위젯.
2. **PTY 폴백(하)** — 구조화 출력이 없는 임의 CLI는 진짜 PTY로 띄워 화면 텍스트를 정규식으로 best-effort 파싱. 품질은 낮음. [확정: 정규식 승인 파싱은 미채택, raw 터미널만 — §13-5]

**정규화 이벤트 스키마 (CodingPT Event)** — 에이전트 중립의 열쇠
각 어댑터가 자기 에이전트의 출력을 아래 **공통 스키마로 매핑**한다. 모바일은 공통 스키마만 렌더링하므로, 새 에이전트를 붙여도 UI는 안 바꾼다.
```
agent_message    → 채팅 버블
tool_call        → "🔧 파일 편집" 카드
file_edit        → diff 카드(before/after)
approval_request → 승인/거절 버튼
progress / todo  → 진행 체크리스트
test_result      → 성공/실패 뱃지
cost             → 사용량 미터
result / error   → 완료/에러
```

## 3. 시스템 아키텍처

```
 ┌──────────────┐        ┌──────────────────────┐        ┌──────────────────┐
 │  모바일 앱     │◀─WSS─▶│   릴레이 서버(네가운영)   │◀─WSS─▶│  PC 데몬(LocalRunner)│
 │ (명령·결과뷰)   │        │  - 인증/세션 라우팅       │  아웃  │  - 에이전트 PTY      │
 └──────────────┘        │  - 정본 스냅샷 저장소      │  바운드 │  - 파일감시/실행      │
                         │  - 프리뷰 터널            │        └──────────────────┘
                         │  - CloudRunner 오케스트레이션│
                         │        │                 │        ┌──────────────────┐
                         │        └────────────────▶│◀──────▶│ 클라우드 러너(CloudRunner)│
                         └──────────────────────────┘        │  격리 컨테이너/microVM │
                                                             └──────────────────┘
```

**포트포워딩·VPN 필요 없음.** PC 데몬이 릴레이로 **아웃바운드** 상시 연결(WebSocket/gRPC 스트림)을 맺고, 릴레이가 모바일 ↔ 러너 사이 메시지를 중계한다. (Remote Control·ngrok·VS Code 터널과 동일 패턴.)

**주요 컴포넌트**
- **모바일 앱**: 명령 입력, 결과 뷰(§7), 워크스페이스 전환, 승인/조종.
- **릴레이 서버**: 인증, 세션 라우팅, 정본 스냅샷 스토어, 프리뷰 터널, 클라우드 러너 수명주기 관리.
- **PC 데몬**: 설치형. 에이전트 실행 + 파일감시 + 실행 + 스냅샷.
- **클라우드 러너**: 사용자별 격리 실행 환경(폴백/입문자용).

## 4. Workspace 데이터 모델

```yaml
Workspace:
  id: ws_xxx
  name: "내 사이드프로젝트"
  source:
    type: git                 # 정본은 git 기반
    remote: "git@github.com:user/repo.git"   # 없어도 됨(로컬온리 가능)
  targets:
    local:  { pcId: pc_123, path: "/Users/me/proj" }   # null 가능(입문자)
    cloud:  { template: "node20", cpu: 2, mem: 4Gi }
  activeTarget: local|cloud
  agent:
    adapter: "claude-code"     # §9 어댑터 id
    auth: user-managed           # 사용자가 러너에서 직접 로그인, 우리는 저장/중계 안 함
    settings: { model: "...", ... }
  runProfiles:                 # 이름 붙인 실행 명령
    - { name: "dev",  cmd: "npm run dev",  port: 3000 }
    - { name: "test", cmd: "npm test" }
    - { name: "build",cmd: "npm run build" }
  sync:
    lastCheckpoint: ckpt_789
    dirty: { local: false, cloud: true }
    status: clean|syncing|conflict
  secrets:                     # .env 등, 클라우드 반입 여부 사용자가 지정
    excludeFromCloud: [".env.production"]
```

### 워크스페이스 타겟 상태머신
```
DETACHED
  └─(연결)→ LOCAL_ACTIVE ⇄ CLOUD_ACTIVE
                  │  ▲          │  ▲
                  ▼  │(핸드오프)  ▼  │
              CHECKPOINTING → MATERIALIZING
                              (충돌 시)→ CONFLICT → (사용자 해결)→ 복귀
```
**MVP 원칙: 한 번에 하나의 활성 타겟만.** 로컬·클라우드에서 동시에 편집하면 충돌이 나므로, MVP에선 명시적 "핸드오프"로만 타겟을 바꾼다. → 충돌을 거의 원천 차단.

## 5. 동기화 전략 (⭐ 가장 중요)

### 모델: Git 기반 정본 체크포인트
- 정본(source of truth)은 릴레이의 **워크스페이스 스토어**에 있는 git 상태. [확정: objectstore git-bundle 허브]
- 커밋 안 된 변경도 잃지 않게 **shadow 커밋(WIP 스냅샷)** 으로 통째로 저장한다. (사용자의 실제 커밋 히스토리는 안 건드림.)
- 대용량/빌드 산출물(node_modules 등)은 스냅샷에 안 넣고 클라우드에서 재설치/캐시.

### 핸드오프 흐름 (로컬 → 클라우드)
1. PC 데몬이 현재 작업트리를 `checkpoint()` → shadow 커밋 + 델타 업로드.
2. 클라우드 러너가 `materialize(checkpointId)` → 동일 상태 복원 + `npm ci` 등 환경 준비.
3. 이후 클라우드가 활성. PC 다시 켜지면 델타를 fast-forward, 갈라졌으면 3-way 머지 후 충돌만 사용자에게 표시.

### "즉시즉시" 요구 해결 (핵심)
- **결과 스트리밍**(터미널·로그·프리뷰)은 타겟과 무관하게 항상 실시간 → 사용자가 느끼는 "즉시"는 여기서 충족.
- **동기화**는 의미 있는 경계에서만: 에이전트 턴 종료 / 사용자가 핸드오프 / 주기적 자동저장(예: 30초) / 타겟 전환 직전.
- 즉, 키 입력마다 동기화하지 않는다. "즉시 확인"과 "정합성"을 분리해 둘 다 만족.

### 폴백(PC 꺼짐) 동작
- PC가 꺼져도 릴레이 스토어에 마지막 체크포인트가 살아있으므로, 클라우드 러너가 그걸 `materialize`해서 그대로 이어감. → 이게 "완전 동일"의 실현 방식.

> Phase 2 옵션: 둘 다 켜져 있을 때 Mutagen/rsync식 양방향 실시간 미러링을 얹어 체감 지연을 더 줄인다. MVP엔 불필요(오히려 충돌 위험).

## 5.5 세션 수명주기 · 연결 복구 (⭐ "걸어두고 나갔다 확인"의 뼈대)

### 원칙: 에이전트는 러너에서 살고, 폰은 보는 창
폰 연결이 끊겨도 에이전트 작업은 러너(PC/클라우드)에서 계속 돈다.

### 연결 끊김·복구
- 러너가 **순번(seq) 붙은 이벤트 로그**를 append. 폰은 마지막 본 `lastSeq`를 기억.
- 재접속 시 폰이 `lastSeq`를 보내면 러너/릴레이가 그 이후 이벤트만 **리플레이** → 순식간에 따라잡음.
- 릴레이가 **롤링 버퍼**를 유지 → 러너는 붙어있는데 폰만 끊긴 경우(지하철·엘리베이터)도 커버.
- 하트비트로 죽은 연결 감지 + 지수 백오프 자동 재연결.
- **PC 데몬이 죽어도 에이전트가 같이 안 죽게**: 데몬이 에이전트를 지속 PTY 세션(tmux류)으로 감싸, 데몬 재기동 시 재부착.

### 세션 상태 & 수명주기
```
Session: { id, workspaceId, target, adapter, state, lastSeq, createdAt, lastActivityAt }
state: starting → running → waiting_input → idle → stopped | crashed
```
- **폰 앱을 닫아도 세션 유지** — 이 서비스 핵심 매력.
- 완료 / 입력대기 / 크래시 / 장기명령 종료 → **푸시 알림**. [확정: 핵심 3종]
- 앱 재오픈 → 세션 재구독 + 백로그 리플레이.
- 클라우드: 실행 중이면 컨테이너 유지, idle N분 후에만 체크포인트+동면. 로컬: PC 잠들/꺼짐 → 일시정지 → 깨면 재개 or 클라우드 핸드오프 제안.
- MVP: 워크스페이스당 활성 세션 1개.

## 5.6 동기화 충돌 처리 · UX (⭐ 로컬↔클라우드 오갈 때의 급소)

### 언제 충돌 나나 (단일 활성 타겟이라 드묾, 그래도 발생)
- 클라우드 활성 중 PC에서 CodingPT 밖으로 로컬 파일·git을 건드림(오프라인 편집, `git pull`/브랜치 변경).
- 핸드오프가 네트워크 끊김으로 중간에 깨짐.
- (Phase 2) 다중 기기.
→ 공통 원인: 러너 트리의 base와 정본(canonical) head가 갈라짐.

### 탐지 (git 3-way)
- 각 체크포인트가 base 커밋 id 기록, 러너는 자기가 materialize한 base를 앎.
- 동기화/핸드오프 시 `diff(러너)` vs `diff(정본 since base)` 비교 → **겹치는 파일·hunk만 충돌**, 나머지는 자동 머지.
- WIP(미커밋)도 shadow 커밋 단위로 동일 처리, 사용자 실제 히스토리는 불변.

### 예방이 우선 (규칙)
- **활성 리스(lease)**: 릴레이가 한 타겟에만 활성 권한 부여. 나머지는 핸드오프 전까지 읽기전용·체크인 불가.
- 재접속 시 러너 트리가 정본과 갈라졌으면 **stale 표시 + 명시적 reconcile 요구**(조용한 덮어쓰기 금지).
- 잦은 자동 체크포인트(§5, ~30초/턴 경계)로 갈라짐 창을 최소화.
- 충돌 중엔 에이전트 일시정지(충돌 트리에 쓰지 않음).

### 모바일 UX (작은 화면 — 파일 단위 우선)
1. **파일 단위**: 충돌 파일만 목록(보통 소수). 각 파일 "양쪽에서 바뀜" → `[내 PC 버전 / 클라우드 버전 / 둘 다 보기]`. [확정: MVP는 이 수준까지만 + "전부 한쪽으로"]
2. **hunk 단위(필요 시)**: [Post-MVP로 이동]
3. ~~풀 IDE 모드(code-server) 머지 에디터~~ [폐기]
4. 바이너리(이미지 등): 머지 불가 → "택1"만.
- 원시 conflict 마커·전체 3-way 편집기는 폰에 안 띄움.

### 안전
- 파괴적 해결 전에 **진 쪽을 stash/브랜치로 보존**(rescue) → 되돌리기 가능. 절대 조용히 버리지 않음.
- 상태 흐름(§4 확장): `SYNCING → (clean→active) | (conflict→CONFLICT_RESOLUTION→resolved→active)`. CONFLICT 동안 워크스페이스 준-읽기전용, 에이전트 정지.

## 6. 연결 · 전송 · 프리뷰
- **전송**: PC 데몬/클라우드 러너 ↔ 릴레이는 아웃바운드 WSS 상시 스트림. 인바운드 포트 개방 0.
- **인증**: 세션마다 짧은 수명의 스코프 토큰. 세션 접근권=완전 제어권이므로 세션 링크는 자격증명처럼 취급(공유 주의, 폰 생체인증으로 조종 확인).
- **에이전트 인증 = 사용자가 직접, 우리는 중계 안 함**: PC든 클라우드 러너든 **사용자 소유 머신**으로 보고, 사용자가 터미널에서 자기 에이전트 CLI를 직접 설치·로그인(`claude /login` 등)한다. 크레덴셜은 **그 러너에만** 존재하고 우리 시스템(릴레이)은 저장·중계하지 않는다. → 크레덴셜 처리 서브시스템 불필요, LLM 토큰 비용 0(BYO), 모든 CLI 에이전트에 균일 적용.
- **웹 프리뷰**: 러너가 dev 서버 포트를 열면 릴레이가 `https://ws-xxx.preview.codingpt.app` 서브도메인으로 터널 → 앱 내 웹뷰로 열람. 로컬/클라우드 동일.

## 6.5 통신 프로토콜 규격 (릴레이 ↔ 러너 ↔ 모바일)
[구체 명세는 `runner-contract.md`로 이관 — 아래는 원 기획 원칙]

**전송**: 단일 WSS 위에 채널 다중화. 모바일↔릴레이, 러너↔릴레이 둘 다 아웃바운드. 릴레이가 workspace/session 기준 라우팅.

**공통 프레임**
```
{ v, id, ts, type, channel, workspaceId, sessionId, seq?, payload }
channel: control | agent(§2.1) | terminal | files | preview | ide
```

**메시지 3종**
- `req/res/err` (상관 id): 파일 CRUD, 터미널 open 등 요청·응답.
- `event` (server→client, 채널별 **monotonic seq**): 에이전트 이벤트·터미널 출력·파일 watch·명령 출력.
- `input` (client→server): 터미널 stdin, 에이전트 명령/승인, 파일 write.

**인증 핸드셰이크**
1. WSS 접속 + 단명 액세스 토큰(로그인 발급).
2. `hello { token, clientType: mobile|daemon|cloud, deviceId, v }`
3. `hello_ack { capabilities, serverTime, resume }`
4. daemon은 계정에 기기 등록 → 폰의 기기 목록에 노출(§8 자동발견).
5. 토큰 만료 → control 채널로 무중단 refresh, 실패 시 재접속.

**세션 attach · 리플레이** (§5.5 연동)
- `attach { workspaceId, sessionId?, lastSeq? }` → 러너가 `lastSeq` 이후 event 리플레이 → `attach_ack { sessionId, headSeq }`.
- 클라이언트가 주기적 `ack { channel, seq }` → 러너/릴레이가 버퍼 트리밍.
- 재접속 = `attach`로 갭 채움(끊김 복구).

**흐름 제어 · 순서 보장**
- 채널별 seq 단조 증가, 순서대로 적용, 갭 감지 시 resync 요청.
- 고volume(터미널 ANSI)은 윈도우 ack 또는 최신 우선 드롭 허용 — **단 파일 write·control·에이전트 이벤트는 절대 드롭 금지**.
- 대용량 파일 읽기는 페이지 청크.

**에러 모델**: `{ code, message, retryable, channel }`
code: `AUTH_EXPIRED / SESSION_GONE / RUNNER_OFFLINE / RATE_LIMITED / CONFLICT / NOT_FOUND / INTERNAL`

**보안 · 버전**: 토큰은 workspace+session 스코프·짧은 TTL(세션=완전제어 §6). 릴레이는 에이전트 키 미보유. `v` 필드로 하위호환(가산 변경만).

## 7. 결과 표시 채널 ("다양한 방식" 구체화)
| 채널 | 내용 | 비고 |
|---|---|---|
| 터미널 스트림 | PTY stdout/stderr, ANSI 렌더 | 기본 |
| 구조화 이벤트 | "파일 편집 중 / 테스트 실행 / 승인 대기" | 어댑터가 파싱 |
| 파일 diff 뷰어 | before/after, 문법 하이라이트 | 승인·조종 중심 |
| 웹 프리뷰 | dev 서버 터널 URL | 앱 내 웹뷰 |
| 테스트·빌드 결과 | exit code, 테스트 러너 출력 파싱 | 성공/실패 뱃지 |
| 로그 뷰 | run 프로필 stdout 로그 | 필터링 |
| 스크린샷 | 러너의 headless 브라우저 캡처 | Phase 2 |
| 산출물 파일 | 생성 파일 다운로드/미리보기 | |

이 채널들은 §2.1의 **정규화 이벤트를 렌더링**한다(구조화 우선, 없으면 PTY 폴백). 모바일은 화면이 작으니 **정독 편집이 아니라 "승인·조종·모니터링"에 최적화**한다.

## 7.5 바이브 코딩 화면 + 모바일 IDE (⭐ 필수)

> **위임 방침**: 모바일 IDE는 이미 안정화된 별도 구현이 있다. 이 시스템에 붙는 **계약만 지키면 내부는 자유**: (1) 통신 프로토콜(runner-contract), (2) 러너 fs가 단일 원본, (3) 세션·리플레이 §5.5.
> [확정: 기존 커스텀 IDE 유지 + 소스 레이어만 러너 계약으로 교체. code-server 폐기.]

### 핵심 통찰: 새 동기화 없음
IDE는 별도 동기화를 만들지 않는다. **러너의 실제 파일시스템이 유일 원본**이고, 에디터·터미널·프리뷰·에이전트가 전부 그 하나의 fs를 읽고 쓴다. 그래서 "에이전트 수정이 실시간 반영"이 저절로 성립. git 체크포인트(§5)는 로컬↔클라우드 핸드오프 때만 관여.

### 두 개의 화면 (모드 아님)
1. **바이브 코딩 화면 (채팅형)** — 에이전트와 대화하며 개발. 명령·응답·승인·진행 상황이 채팅 흐름으로. 일상 개발의 주 진입점.
2. **IDE 화면 (작업대)** — 파일 트리 · 코드 에디터 · 터미널 · 웹을 PC처럼 각각 조작.

- 두 화면이 같은 fs를 보므로, 채팅에서 에이전트가 고친 걸 IDE 화면에서 바로 확인·이어서 편집 가능(그 반대도).
- [확정 UX 모델: 워크스페이스 기본 화면 = 등록 경로의 **터미널**(raw 미러). 채팅에서 시작하면 데몬이 백그라운드에서 구조화 모드 spawn. 이미 돌던 TUI는 미러만(변환 불가), 저장된 대화는 --resume으로 이어받기.]

### 러너 3서비스 (로컬/클라우드 동일 인터페이스, §2)
1. **File Service** — 트리(지연 로딩), 읽기/쓰기, 파일·폴더 CRUD·이동, `watch`(변경 실시간 푸시).
2. **Terminal Service** — 진짜 PTY 멀티플렉싱. 에이전트가 띄운 dev server·테스트도 이 서비스의 터미널.
3. **Preview Service** — 포트 터널(§6) + 정적 파일 서빙. dev server를 앱 내 웹뷰로 실시간.

### 자동완성
IDE 화면의 자동완성·정의이동은 **러너에서 도는 언어서버(LSP) 기반** — Phase 2. 현재는 커스텀 자동완성(show-hint) 유지.

### 네이티브 앱 프리뷰 (Q3)
웹/dev server 프리뷰는 웹뷰로 즉시 가능. 진짜 네이티브 앱 빌드 프리뷰는 보류. RN/Expo는 web target/Expo dev로 부분 대응 가능.

## 8. 온보딩 (파워유저 · 입문자 이중 경로)

**입문자 = 클라우드 우선**
- 가입 → 템플릿 선택 → 즉시 클라우드 워크스페이스 생성 → 바로 에이전트에게 명령. **로컬 설치 0.**
- 에이전트 인증은 **사용자가 직접 로그인**(BYO). 러너 터미널에서 `claude /login` 등 실행 → 앱이 인증 URL을 인앱 브라우저로 열어주는 **가이드 플로우**. 체험 크레딧 미제공이므로 이 안내를 특히 친절하게.
- 나중에 "내 PC 연결하기"로 로컬 타겟 추가 가능.

**파워유저 = 로컬 우선**
- `brew install codingpt` / `curl | sh` → `codingpt login`(폰 QR 페어링) → 레포 자동 감지 → 에이전트 어댑터 선택.
- 서명된 설치형(메뉴바 앱 .dmg / Linux systemd)도 제공. [확정: 메뉴바 앱 + Developer ID 서명·공증]

### 워크스페이스 생성 · import (첫 화면 = 만들기 허브) [확정: 가입 직후 첫 화면]
소스는 **git/GitHub 기반만**(zip 없음 — git 아닌 폴더는 `git init`으로 흡수).

| 소스 | 데몬 | 흐름 | 시작 타겟 |
|---|---|---|---|
| 내 PC 폴더 | O | (없으면 이 탭에서 연결 유도) 로컬 git 레포 선택 → 정본 등록 | local |
| GitHub | X | 연동 → 레포 선택 → 클라우드가 clone → 정본 등록 | cloud |
| 새로 만들기 | X | 템플릿 → `git init` → 클라우드 생성 | cloud |

- **막다른 길 없음**: "내 PC 폴더"인데 데몬 없으면 그 자리서 연결 유도 or "GitHub로 열기" 대안.
- **"이어서 작업" = 정본 등록**: import한 프로젝트가 곧 §5 정본 스냅샷.

### 기기 페어링 · 신뢰 (생체인증 상시요구 없음)
- **로그인 자동발견**: PC 데몬·폰이 같은 계정으로 로그인 → 릴레이가 계정에 묶인 기기 목록을 폰에 표시 → 선택하면 연결. QR 반복 없음.
- **신규 기기 등록 시 1회만** 확인: 데몬의 "새 기기 승인" 알림 또는 QR/6자리 코드. 이후 자동.
- 앱 진입 잠금은 폰 기본 잠금(OS)에 위임. 위험 동작 승인은 에이전트 자체 permission이 처리하고, 앱은 그 요청을 카드로 중계만(§2.1 `approval_request`).

## 9. 에이전트 어댑터 규격 (에이전트 중립의 열쇠)
각 CLI 에이전트는 얇은 매니페스트 하나로 편입된다. **뼈대(§2 Runner + §2.1 정규화 스키마)는 공용, 어댑터는 에이전트별 부품.** 어댑터가 하는 일: ① 실행/인증 방법 선언, ② 구조화 출력 모드 지정, ③ 출력을 CodingPT Event로 매핑, ④ 승인/중단 방법 정의.

```yaml
adapter: claude-code
detect: "claude --version"
launch: "claude -p --output-format stream-json --verbose --input-format stream-json"
mode: structured            # structured | pty
auth: { type: subscription|apiKey, setup: "claude /login" }
eventMap:
  assistant   -> agent_message
  tool_use    -> tool_call
  tool_result -> tool_result
  result      -> result
approve: { sendEvent: { type: "permission", decision: "allow" } }
interrupt: { signal: SIGINT }
```

### 4종 에이전트 매핑 (MVP + Phase 2 대상)
| 어댑터 | 구독 로그인 | 헤드리스/구조화 출력 | 비고 |
|---|---|---|---|
| **Claude Code** | Pro/Max/Team | `-p --output-format stream-json` (성숙, 실측 검증 완료) | MVP 1순위 |
| **Codex CLI** | ChatGPT Plus/Pro 등 | `codex exec` + 자체 포맷 | Phase 2 |
| **Gemini CLI** | 구글 무료 티어 | 자체 포맷 | Phase 2 |
| **Copilot CLI** | Copilot 구독 | 자체 포맷 | Phase 2 |
| *generic* | — | 없음 → **PTY 폴백(터미널)** | MVP 포함 |

### 새 어댑터 추가 체크리스트
1. detect/launch 2. mode 3. auth(구독+API키 양쪽) 4. eventMap(핵심 작업량) 5. approve/interrupt 6. signals(pty 폴백 시) 7. 대표 시나리오 QA(파일 편집·테스트·프리뷰).

## 10. 비용 모델 · 과금 (개인사업자 관점)
- **LLM 토큰 비용 = 0** (사용자 개인 키/계정 사용). 변동비는 **클라우드 컴퓨팅 + 릴레이 대역폭**뿐.
- **인증 원칙(우리는 크레덴셜 미보유)**: PC·클라우드 러너 모두 사용자 소유 머신. 사용자가 직접 설치·로그인, 우리는 유도만. 에이전트 공급사 ToS는 사용자↔공급사 간 문제. 우리는 참고 안내만 제공. [사용자 확정 입장: 우리는 AI 서비스가 아닌 원격 조작 서비스 — 해당 조항 비적용 판단]
- **클라우드 러너 비용 통제(필수 설계)**: 유휴 N분 후 자동 정지(scale-to-zero). 정지 시 워크스페이스를 오브젝트 스토리지에 저장, 재개 시 복원.
- **요금제 안**: Free = 로컬 러너 무제한 + 클라우드 소량 크레딧 / Pro = 월정액 + 클라우드 실행시간 쿼터 / 초과분 사용량 과금. → 매출과 비용 정렬, 로컬 위주 유저는 거의 공짜로 서비스 가능.

## 10.5 클라우드 러너 운영 · 수명주기 (⭐ 비용 급소 — 숫자는 초기 가정, 실측으로 튜닝)

### 러너 수명주기
```
cold(저장됨) → provisioning(콜드스타트) → active(실행) → idle(유휴) → hibernating(체크포인트+정지) → cold
```
- **정지 규칙**: 활성 세션 없고 사용자 연결도 없으면 유휴 10분 후 동면. 에이전트가 `running`이면 유지. 최대 실행시간 cap(예: 무료 30분/작업)으로 폭주 차단.
- **콜드스타트 UX**: "환경 깨우는 중…" 프로그레스. 목표 5~15초.
- [확정: 사용자 에이전트 크레덴셜은 **암호화해서 동면 스냅샷에 포함** — 재로그인 없음]

### 저장 (hibernate 시)
- git 정본(델타) + 캐시 볼륨. `node_modules` 등은 gitignore + 재설치/캐시.
- 저장 한도(가정): 무료 2GB/워크스페이스, 유료 상향. 데이터는 실행 차단과 무관하게 보존.

### 리소스 티어
- 기본(가정): 2 vCPU / 4GB. 무료 고정 스펙, 유료 상향 옵션.

### 무료 초과 처리 (하드 컷 아님)
- 무료 크레딧 소진 → 실행만 정지, 데이터는 보존 + "유료 전환 또는 로컬 사용" 안내.

### 비용 통제 장치 (필수)
- scale-to-zero, 동시 active 워크스페이스 제한(무료 1개), egress 제한, 최대 실행시간 cap, idle 타임아웃, 대역폭 soft limit.

### 인프라 결정: 자체 microVM (직접 운영 — 확정)
- ⚠️ 정직한 리스크: MVP 일정·1인 운영 부담의 최대 위험 지점.
- **완화책(단계적)**: 초기엔 단순 컨테이너 + 엄격 격리(기존 sandbox 격리 자산 재사용)로 출시 → 트래픽 붙으면 microVM으로 고도화.

## 11. 보안 · 리스크 (정직하게)
- **임의 코드 실행 호스트**: 클라우드 러너에서 사용자 코드가 돈다 → 강한 격리, egress 제한, 이상탐지, 명확한 ToS 필수.
- **에이전트 ToS는 우리 리스크 아님(운영 유의만)**: 공급사가 서드파티 도구를 차단한 이력은 인지 — 관계 리스크 수준.
- **비밀정보 · 러너 크레덴셜**: 사용자의 `.env`/키, 클라우드 러너의 에이전트 크레덴셜 → 저장 암호화 + 러너 격리 필수. `excludeFromCloud` 유지.
- **동시 편집 충돌**: 단일 활성 타겟으로 원천 회피.
- **세션 하이재킹**: 토큰 단명·기기 신뢰·생체 확인.
- **모바일 코드 리뷰 한계**: 승인/조종 UX에 집중, 정밀 리뷰는 데스크톱 유도.

## 11.5 에러·실패 표면화 + 관측·과금 계측

### A. 에러·실패 표면화
- **에이전트에게 넘길 실패(정상 피드백 루프)**: 빌드/테스트 에러 등 → 에이전트에게 그대로 전달해 스스로 고치게. 사용자에겐 조용히 진행 표시.
- **사용자 개입이 필요한 실패**: 연결·인증·한도·크래시 → 명확한 카드 + (백그라운드면) 푸시.
- **원칙**: 모든 사용자향 에러는 "무슨 일 + 어떻게 복구" 한 쌍. "자세히 보기"로 로그 접근.

| 에러 | 사용자 메시지 · 복구 |
|---|---|
| RUNNER_OFFLINE | "PC가 꺼져 있어요" → [클라우드로 전환] |
| 에이전트 크래시 | [재시작] / 로그 보기 |
| AUTH_EXPIRED | [다시 로그인] 딥링크 |
| OOM | [더 큰 러너로](유료) / 작업 분할 |
| 크레딧/저장 초과 | [로컬로] / [업그레이드] (데이터 보존) |
| CONFLICT | §5.6 충돌 해결 플로우 |

- **Fail-safe**: 실패해도 체크포인트로 작업 손실 없음. "재시도"는 멱등하게 안전.

### B. 관측 · 과금 계측 (처음부터 — 소급 불가)
- **계측 대상**: 클라우드 active 실행시간(과금 핵심), 저장 GB, egress, 세션·실행 횟수, 콜드스타트 지연(SLO), 에러율.
- **파이프라인**: usage event emit → 집계 → (a) 과금 원장(append-only·멱등) + (b) 관측 대시보드.
- **프라이버시**: 코드 내용·프롬프트는 계측/로그에 안 남김. 메타데이터만.
- **남용 탐지**: 실행시간·egress 급증 → 자동 제한.

## 12. MVP 범위 & 로드맵
[구체 실행 계획은 `mvp-roadmap.md`(M0~M6)로 이관 — 이 문서의 MVP 목록은 원 기획 기준]

**MVP**: 모바일 앱(RN) 결과 뷰 전반 / 채팅+IDE 두 화면 / 세션 수명주기·리플레이·푸시 / 릴레이(인증·라우팅·스냅샷·터널·오케스트레이션) / PC 데몬 Mac(+Linux) / 클라우드 러너(materialize+동면) / 어댑터 claude-code+generic / git 체크포인트 핸드오프 / 온보딩 허브+자동발견 페어링.
**Phase 2**: LSP 자동완성, Codex→Gemini→Copilot, 실시간 미러링, 스크린샷 채널, 멀티 워크스페이스, 웹 클라이언트 재건, Windows.
**Phase 3**: 협업(세션 공유), 예약 실행, 팀 플랜.

## 13. 확정된 결정 (구 열린 질문)
1. **모바일 플랫폼**: iOS·Android 동시(RN).
2. **PC 데몬 1차 OS**: ~~Mac 먼저~~ → [갱신: **Mac + Linux 서버 병행**]
3. **클라우드 러너 기반**: 자체 microVM(단계적 — 초기 컨테이너+격리).
4. **입문자 체험 크레딧**: 미제공 — BYO. 가이드 로그인 플로우로 진입 장벽 낮춤.
5. **에이전트 승인 파싱**: 구조화 에이전트만 승인 카드 지원. PTY 폴백은 raw 터미널에서 직접 y/n. 정규식 폴백 승인 미채택.

## 부록 A. 구독형 CLI 에이전트 지형 (대응 대상)
- **Claude Code** — `stream-json` 구조화 출력 성숙(실측 검증: 멀티턴 stdin·resume·tool_use 동작 확인). MVP 1순위.
- **Codex CLI** — 오픈소스, `codex exec` 헤드리스. 자체 remote-control도 개발 중 → 경쟁이자 방향 검증. Claude 대안 1순위.
- **Gemini CLI** — 무료 티어 업계 최대. 무료 진입점.
- **Copilot CLI** — Copilot 구독 포함, GitHub 생태계.
- **(참고) Aider** — BYO API 키 전용. generic/pty로 대응.
- **(참고) Cursor** — CLI 에이전트(`cursor-agent`) 보유.

**대응 전략**: 뼈대는 공용, 어댑터만 추가. Claude Code → Codex → Gemini → Copilot 순.
