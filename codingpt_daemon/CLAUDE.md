# codingpt_daemon — CodingPT PC 에이전트

사용자 PC에 설치되는 데몬. 모바일 앱이 PC 터미널을 미러링/조작하게 릴레이한다.
설계 정본: `../codingpt_back/docs/byo-pc-design.md` (와이어 프로토콜/단계 로드맵/보안 원칙).

## 절대 규칙 (ToS 경계) — 2026-07-09 M1 피벗으로 갱신

경계의 핵심은 **실행 위치·자격증명 소유**다("헤드리스냐"가 아님). AI는 항상 **사용자 PC에서
사용자 자신의 claude·구독으로** 돈다.

- **AI 자격증명(Keychain·`~/.claude` OAuth·구독 토큰)을 읽거나 옮기거나 우리 인프라로 라우팅하는 코드는
  절대 추가하지 않는다.**
- ✅ 허용: 데몬이 **사용자 자신의 로컬 `claude` CLI를 구조화 모드로 spawn**한다
  (`claude -p --output-format stream-json --input-format stream-json`). 사용자가 터미널에 직접 치는 것과
  동일하게 사용자 PC·사용자 구독으로 실행되고, 크레덴셜은 그 PC에만, API는 PC→Anthropic 직결.
  (`lib/agent.js`가 이 spawn을 담당. 승인은 `--permission-prompt-tool` + 번들 MCP로 앱에 중계.)
- ✅ 허용: 세션 재개용 `~/.claude/projects/<cwd>/*.jsonl` **대화 로그** 읽기(자격증명 아님).
- ❌ 금지: 우리 서버/우리 키로 claude 구동, 사용자 크레덴셜을 back/릴레이로 전송하는 모든 형태.
- GA 전 Anthropic 서면 확인 권고(비차단).

## macOS 권한(TCC) — 원격에서 폴더 접근 프롬프트 안 뜨게

외부에서 모바일로 작업하면 Mac 화면의 "폴더 접근 허용?" 프롬프트를 승인할 수 없다. **앱이 권한을 스스로 승인하는 건 불가능**(Apple 차단) — 초기 세팅 때 사람이 한 번 정리한다. 두 지렛대:

1. **워크스페이스를 보호폴더 밖에 둔다(기본 전략, 승인 불필요).** `~/CodingPT/workspaces`(홈 바로 아래)는 TCC 보호 대상이 아니라 접근 프롬프트가 **아예 안 뜬다**. `lib/workspace.js`의 `DEFAULT_ROOT_REL`이 이 위치, `ws.useDefaultRoot`가 생성+지정. 앱 피커 상단 "추천 위치 사용" 원탭. Desktop/Documents/Downloads/Movies/Music/Pictures/Library 는 보호폴더 → 앱이 경고.
2. **전체 디스크 접근(FDA) 1회 부여(선택, 모든 프롬프트 제거).** 데몬을 띄우는 터미널 앱(또는 P4에서 패키징된 .app)에 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근에서 켜면 어디든 프롬프트 없음. `node index.js setup`이 폴더 생성 + FDA 설정창(`open x-apple.systempreferences:...Privacy_AllFiles`)을 열어 안내.

> LaunchAgent/패키징(P4) 전까지 FDA는 "터미널 앱" 기준. 정식 배포 시 서명된 .app 에 FDA 부여로 정리 예정.

## 구조 (M5 Slice0: npm workspaces 모노레포)

`codingpt_daemon/` 은 이제 workspaces 루트다. 러너 계약 구현은 `runner-core` 로 추출돼 로컬 데몬/클라우드 러너가 공유한다.

```
package.json                      workspaces 루트({workspaces:[packages/*]}). 실행 스크립트만.
packages/runner-core/  @codingpt/runner-core — 계약 구현 한 벌(로컬/클라우드 공유)
  config.js    ~/.codingpt/daemon.json (0600, deviceToken 원문은 여기만) — Slice0-B에서 경로 파라미터화 예정
  control.js   제어 WS(/api/daemon/connect) — 재접속 백오프, stream_open/rpc 디스패치. hello 에 clientType(daemon|cloud)
  pty.js       dial-back PTY 스트림 — node-pty + tmux(-L codingpt 전용 소켓)
  fs.js        fs RPC(list/tree/read/write/watch/grep) — 홈 jail(safeResolve)
  workspace.js 워크스페이스 스캐폴드(ws.*) — 루트 지정·git init·clone
  proxy.js     net.ports(lsof) + dial-back TCP 터널(프리뷰)
  agent.js     BYO 에이전트 — 사용자 claude spawn(stream-json), 8-이벤트 정규화, agent.* RPC (M1)
  sync.js      동기화(sync.*) — shadow 체크포인트 + git bundle + 세션묶음 + 3-way 충돌 (M4)
  approval-mcp.js  승인 중계 MCP(--permission-prompt-tool) — claude 권한요청 → 앱 카드 (M1)
  index.js     public API 재export({config,control,pty,fs,agent,sync,proxy,workspace})
packages/daemon/       @codingpt/daemon — 로컬 부트스트랩(페어링 CLI·tmux·TCC), runner-core 의존
  index.js     CLI (pair | run | status | setup | unpair)
packages/cloud-runner/ @codingpt/cloud-runner — 클라우드 컨테이너 부트스트랩(env config) (M5 Slice0-C 예정)
```

## 컨벤션

- 의존성 최소(ws, node-pty만). 프레임워크/빌드 도구 금지 — 순수 node로 실행 가능해야.
- tmux는 항상 전용 소켓 `-L codingpt` — 사용자 개인 tmux 서버를 절대 건드리지 않는다.
- 자식 프로세스 env에서 `TMUX` 제거(중첩 가드 우회 — 데몬 자체가 tmux/cmux 안에서 돌 수 있음).
- PTY 와이어 계약(termproxy와 동일)을 깨지 않는다: 바이너리=stdin, `{type:'resize'}`=리사이즈, 출력=raw.
- P1 fs RPC 구현 시: **allowlist 기본 deny**, `path.resolve`+`fs.realpath`로 `..`/심링크 탈출 거부 필수.

## 개발/테스트

```bash
# 최초 1회: workspaces 설치(node-pty 네이티브 빌드 포함) — codingpt_daemon/ 에서
npm install

# 로컬 back(:5300)과 페어링 + 실행 (run 커맨드가 packages/daemon 으로 이동됨)
node packages/daemon/index.js pair --server http://localhost:5300
node packages/daemon/index.js run          # (= npm run daemon:run)

# 데몬이 만든 세션을 Mac 터미널에서 같이 보기(미러 확인)
tmux -L codingpt attach -t codingpt

# 상태 확인 (tmux 경로 포함)
node packages/daemon/index.js status
```
> ⚠️ 데몬은 nodemon 아님 → runner-core lib 수정 후 `node packages/daemon/index.js run` 재기동 필수.

에뮬레이터 E2E: 앱 마이페이지 → "내 PC" → 페어링 코드 발급 → 위 pair 실행 → 화면이 자동으로
터미널로 전환되는지, Mac attach 화면과 실시간 동기화되는지 확인.
