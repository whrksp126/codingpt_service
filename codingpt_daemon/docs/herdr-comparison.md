# herdr 비교 분석 (2026-10-30, herdrdev/herdr ee5bfb5 기준)

herdr = Rust 단일 바이너리 TUI 멀티플렉서. 에이전트의 터미널을 소유하고, CLI·소켓 API 로 에이전트가 에이전트를 부린다.

## 무엇이 잘 돼 있나 (가져온 것)

| herdr | CodingPT 적용 |
|---|---|
| `agent start/prompt/wait/read/send-keys` — 이름으로 부른다, ID 를 응답에서 읽는다 | `cpt agent …`(agent-control.js). orch 보다 얇은 한 건짜리 |
| `--machine` — 저장한 SSH 머신에 같은 명령을 그대로 | `cpt --machine <PC> agent …` — SSH 대신 계정 허브 + 봉인 RPC. 포트·키 설정이 0 |
| 프롬프트 뒤 5초 안에 시작 신호를 본다(`agent_prompt_stalled`), 승인 창이면 입력 거부(`agent_blocked`) | 같은 계약. `AGENT_PROMPT_STALLED`·`AGENT_BLOCKED` |
| 상태 어휘 working·blocked·idle·done·unknown, unknown ≠ 끝남 | working·blocked·idle·starting·gone·unknown |
| 실패가 곧 "안 보내짐" 이 아니다 → 재전송 전에 확인 | 안내서 규칙 + 봉투 시간 초과 시 평문 재시도 금지 |
| 접두키 + `?` 도움말 + Goto 피커(상태 필터) | ⌃B 접두키(prefix.js), ⌃B ? 전체 보기, ⌃B g 팔레트에 에이전트 행(승인 대기 우선) |

## herdr 의 약점 (따라가지 않은 것)

- 결과를 화면에서 긁는다. 긴 답은 "파일로 쓰게 시켜라" 가 폴백이다 → 우리는 `agent result` 가 대화 기록(transcript)에서 읽는다.
- 다른 머신은 SSH 프로필·양쪽 서버 기동이 전제이고 폰에서 쓸 수 없다 → 우리는 페어링만으로 되고 폰·PC 어디서든 그 탭을 본다.
- 상태를 매니페스트·화면 인식으로 추정한다 → 우리는 훅 1차 + 관찰 폴백이라 더 정확하다.
- 스킬이 "사용자가 herdr 를 말했을 때만" 발동한다 → 우리는 세션 시작 인덱스 + 도구 훅으로 먼저 고르게 한다.
- ⌃B 는 claude 의 백그라운드 전환과 겹친다 → 두 번 누르면 터미널로 그대로 보낸다.

## CodingPT 의 약점이었던 것

- 호출이 무거웠다: 하나 묻는 데도 orch 묶음·시도가 필요했다 → `cpt agent`.
- 다른 PC 의 에이전트를 AI 가 부를 길이 없었다(사람 화면만 가능) → `--machine`.
- 내장 기능을 두고 외부 창을 쓰는 경로가 열려 있었다 → `cpt emulator boot` 는 창 없이, 직접 실행은 훅이 막는다.
- 단축키가 ⌘ 조합뿐이라 외우기 어렵고 터미널 습관이 안 통했다 → 접두키.

## 다음 차수

- 다른 PC 의 에이전트 상태를 코디네이터가 푸시로 받기(지금은 폴링 3초).
- orch 워커를 다른 PC 에 띄우기(`worker-start --machine`) — 묶음 기록을 두 PC 에 나누는 문제가 있다.
- 복사 모드(키보드로 스크롤백 선택), 접두키 재바인딩 UI.
