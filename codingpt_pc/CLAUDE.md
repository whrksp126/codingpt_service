# codingpt_pc — PC 데스크톱 앱 (Tauri)

"내 PC 연결"용 네이티브 설치 앱(.dmg). 데몬(`../codingpt_daemon`)을 사이드카로 번들·기동하고,
cmux식 워크스페이스 셸(터미널 미러/IDE/프리뷰 타일링)을 제공한다. 프론트는 **번들러 없는 순수 JS 모듈**(src/js/*).

## 구조

```
src/js/
  main.js            부트스트랩·트레이·페어링 게이트
  state.js           워크스페이스/pane 상태 정본(로컬), 리컨실러(tmux 풀 폴링), 알림 미러
  tiling.js          타일링 트리(분할/이동/비율) — 서버 아님, ~/.codingpt/pc-ui.json 영속
  pane.js            pane 렌더/입력(터미널 xterm·IDE·프리뷰 탭), OSC 알림 콜백
  workspace-view.js  워크스페이스 화면 조립
  sidebar.js         사이드바(프로젝트 그룹핑 렌더·분리/합치기 메뉴)
  ide.js             CodeMirror IDE(자동저장·linkedDoc 에디터 그룹)
  devtools.js        프리뷰 크롬 데브툴(chii) 세션 관리 — 도킹 iframe/Undock 별도 창
  ui-channel.js      back WSS 구독(notif_event·ui_command 왕복)
  api.js             Rust bridge invoke 래퍼
src/devtools-frame.html  chii 프론트엔드 래퍼(쿼리 유지용 정적 문서)
src-tauri/src/
  bridge.rs          REST(ureq+deviceToken)·워크스페이스·스트림 토큰 커맨드
  pty.rs / tmux.rs   로컬 tmux(-L codingpt) 직결 터미널
  preview.rs         네이티브 WKWebView 프리뷰(preview_eval/screenshot 포함)
  fsapi.rs           로컬 파일 IDE 백엔드
scripts/bundle-sidecar.sh  node+tmux+dylib 자립 번들(dmg 무설치)
```

## 절대 함정 (실측으로 확인된 것 — 어기면 재발)

- **번들 바이너리는 반드시 `rm -f` 후 `cp`** (bundle-sidecar.sh). 같은 inode에 덮어쓰면 macOS
  vnode 서명 캐시 불일치로 exec 즉시 SIGKILL(137). `codesign -vv`는 valid로 나와 오진하기 쉬움.
- **터미널 입력은 input 델타 방식**(한글 IME): xterm 키보드 비활성 + textarea input 델타 전송.
  xterm이 blur 시 textarea를 비우므로 **blur 때 미러(_sentBuf) 리셋 필수** — 안 하면 백스페이스 폭탄.
  편집 조합키(⌘⌫=^U 등)는 textarea 기본동작이 아니라 **셸 시퀀스 직접 전송**(KeyAssist termSeqFor와 동일 규칙).
- **tmux 타겟은 전부 `=` 정확 일치**(`-t =세션명`). 접두사 매칭이 다른 세션을 오염시킨 사고 있음.
- tmux는 항상 전용 소켓 `-L codingpt`. 사용자 개인 tmux 서버 절대 접근 금지.
- Tauri 별도 창을 추가하면 `capabilities/default.json`의 `windows`에 라벨 패턴 추가 필수(예: `dt-*`).
- chii 데브툴: Tauri WKWebView UA에 Safari 토큰이 없어 폴리필 강제 선로드 필요, srcdoc은 쿼리를 못
  가지므로 정적 래퍼(devtools-frame.html) 유지. 세부는 devtools.js 헤더 주석.
- 프리뷰는 DOM 위에 겹치는 **네이티브 웹뷰**(항상 최상위) — DOM UI가 가려지면 슬롯 rect부터 의심.

## 개발/검증

```bash
npm install && npm run dev           # 개발 실행 — 사이드카 번들 후 tauri dev (번들은 반드시 선행·동기)
bash scripts/release-pc.sh           # 릴리스: 서명 빌드→업데이터 아티팩트→objectstore 발행(latest.json)
```

- **릴리스 서명 필수**: 릴리스(CPT_RELEASE=1)는 키체인의 Developer ID Application 을 자동 탐지해
  서명하고, 없으면 빌드가 실패한다(ad-hoc 릴리스 금지). dev 는 ad-hoc 허용.
- **자동 업데이트**: 앱이 `/api/pc/update/{target}/{arch}/{ver}` 를 확인(설정>정보>업데이트).
  업데이터 개인키 `~/.codingpt-release/pc-updater.key` — 유출 금지, 분실 시 기존 설치본 업데이트 불가.
  자동업데이트 배포물은 objectstore `codingpt/pc-releases/`에 두고 back 스트리밍(`/api/pc/dl/*`).
  웹 DMG는 공개 버전별 객체 `common/downloads/CodingPT-<ver>-arm64.dmg`를 ObjectStore에서 직접 받는다.
- **공증 필수**: release-pc.sh 가 키체인 프로필 `codingpt-notary`(App Store Connect API 키)로
  dmg 를 공증+스테이플한다(프로필 없으면 릴리스 중단). 업데이터 tar.gz 는 공증 무관(자체 서명 검증).

- **데몬 코드(runner-core) 수정은 `npm run dev` 재시작으로만 반영**(선행 재번들).
  주의: tauri 의 beforeDevCommand 는 dev 에서 비동기(dev 서버용)라 번들-빌드 경주가 나므로 쓰지 않는다.
  실행 중 rust 파일 저장으로 인한 자동 재빌드는 사이드카를 갱신하지 않는다 — 스테일 데몬 주의.
- **수정 후엔 반드시 실행해 실제 동작 확인 후 완료 보고**(스크린샷 권장). UI 자동화로 클릭할 땐
  창 위치가 세션 중 움직이므로 **매번 좌표 재조회** 후 계산.
- 검증 시 tmux 상태 확인: `tmux -L codingpt list-windows -t =<세션명>` / `capture-pane`.
