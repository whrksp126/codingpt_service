# codingpt_daemon — CodingPT PC 에이전트

사용자 PC에 설치되는 데몬. 모바일 앱이 PC 터미널을 미러링/조작하게 릴레이한다.
설계 정본: `../codingpt_back/docs/byo-pc-design.md` (와이어 프로토콜/단계 로드맵/보안 원칙).

## 절대 규칙 (ToS 경계)

- **AI 자격증명을 읽거나 다루는 코드를 절대 추가하지 않는다.** (Keychain, `~/.claude`, OAuth 토큰 등)
- 이 데몬은 터미널/파일/프리뷰 바이트 릴레이 전용. 사용자 claude는 사용자가 터미널에서 직접 실행한다.
- claude를 헤드리스로 구동하는 기능(`claude -p` 등) 추가 금지 — Anthropic ToS 위반.

## macOS 권한(TCC) — 원격에서 폴더 접근 프롬프트 안 뜨게

외부에서 모바일로 작업하면 Mac 화면의 "폴더 접근 허용?" 프롬프트를 승인할 수 없다. **앱이 권한을 스스로 승인하는 건 불가능**(Apple 차단) — 초기 세팅 때 사람이 한 번 정리한다. 두 지렛대:

1. **워크스페이스를 보호폴더 밖에 둔다(기본 전략, 승인 불필요).** `~/CodingPT/workspaces`(홈 바로 아래)는 TCC 보호 대상이 아니라 접근 프롬프트가 **아예 안 뜬다**. `lib/workspace.js`의 `DEFAULT_ROOT_REL`이 이 위치, `ws.useDefaultRoot`가 생성+지정. 앱 피커 상단 "추천 위치 사용" 원탭. Desktop/Documents/Downloads/Movies/Music/Pictures/Library 는 보호폴더 → 앱이 경고.
2. **전체 디스크 접근(FDA) 1회 부여(선택, 모든 프롬프트 제거).** 데몬을 띄우는 터미널 앱(또는 P4에서 패키징된 .app)에 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근에서 켜면 어디든 프롬프트 없음. `node index.js setup`이 폴더 생성 + FDA 설정창(`open x-apple.systempreferences:...Privacy_AllFiles`)을 열어 안내.

> LaunchAgent/패키징(P4) 전까지 FDA는 "터미널 앱" 기준. 정식 배포 시 서명된 .app 에 FDA 부여로 정리 예정.

## 구조

```
index.js        CLI (pair | run | status | unpair)
lib/config.js   ~/.codingpt/daemon.json (0600, deviceToken 원문은 여기만)
lib/control.js  제어 WS(/api/daemon/connect) — 재접속 백오프, stream_open 디스패치
lib/pty.js      dial-back PTY 스트림 — node-pty + tmux(-L codingpt 전용 소켓)
```

## 컨벤션

- 의존성 최소(ws, node-pty만). 프레임워크/빌드 도구 금지 — 순수 node로 실행 가능해야.
- tmux는 항상 전용 소켓 `-L codingpt` — 사용자 개인 tmux 서버를 절대 건드리지 않는다.
- 자식 프로세스 env에서 `TMUX` 제거(중첩 가드 우회 — 데몬 자체가 tmux/cmux 안에서 돌 수 있음).
- PTY 와이어 계약(termproxy와 동일)을 깨지 않는다: 바이너리=stdin, `{type:'resize'}`=리사이즈, 출력=raw.
- P1 fs RPC 구현 시: **allowlist 기본 deny**, `path.resolve`+`fs.realpath`로 `..`/심링크 탈출 거부 필수.

## 개발/테스트

```bash
# 로컬 back(:5300)과 페어링
node index.js pair --server http://localhost:5300
node index.js run

# 데몬이 만든 세션을 Mac 터미널에서 같이 보기(미러 확인)
tmux -L codingpt attach -t codingpt

# 상태 확인 (tmux 경로 포함)
node index.js status
```

에뮬레이터 E2E: 앱 마이페이지 → "내 PC" → 페어링 코드 발급 → 위 pair 실행 → 화면이 자동으로
터미널로 전환되는지, Mac attach 화면과 실시간 동기화되는지 확인.
