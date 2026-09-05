# 터미널 v3 — 한 격자, 한 소유자, 한 구현

작성 2026-09-05. 근거 조사: `~/other/project/_ref/*`(Orca·Herdr·cmux·tmux·Zellij·wezterm·mosh·ET·shpool·sshx·ttyd·VibeTunnel·Happy·Blink 최신 소스) + 보고서 "같은 터미널, 다른 화면".

## 0. 왜 갈아엎나

현재 구조의 복잡도는 버그가 아니라 **정책 선택의 필연**이다.

- tmux `window-size latest` = "마지막에 키/resize/attach 한 클라이언트가 크기를 정한다"(tmux `server-client.c:1356-1368`). PC 와 폰이 번갈아 만지면 PTY 가 179↔48 을 오가며 TUI 가 재배치된다. 그걸 막으려 얹은 15초 controller lease 는 데몬(JS)과 PC(Rust)가 따로 구현해 owner 규칙이 어긋났고(PC 는 `"pc"` 하드코딩), 크기 결정이 4곳, 과거 페이징·스냅샷이 각 3벌, 그 부작용을 40/80/600/1200ms 타이머로 덮는 상태.
- tmux 가 **tty 클라이언트에게 보내는 재도장**(줄 단위 EL + attach 시 `CSR+INDN sy+1`, `tty.c:357-370`)을 그대로 xterm.js 에 먹였기 때문에 클라이언트 스크롤백에 잔재가 쌓였다. tmux 는 화면 렌더러지 상태 동기화기가 아니다.
- 조사한 25개 제품 중 "기기마다 자기 크기로 같은 TUI 를 동시에 최적 배치"는 0개. 진지한 제품(Herdr·Zellij·Orca)은 전부 **크기 소유자 1명 + 나머지는 그 격자를 축소/크롭해 보는 뷰어 + 가져오기**로 수렴했다.

## 1. 결정

1. **크기 소유자(owner)는 터미널마다 정확히 1명이고 사용자가 정한다.** 기본은 터미널을 만든 기기. 비소유 기기는 알약("<기기> 크기로 보는 중 · 내 크기로 맞추기")을 보고, 그 버튼을 눌러야 소유권이 넘어온다. 자동 탈취(마지막 입력 승)는 **하지 않는다** — 그게 재배치 폭풍의 원인이다. (구현 문구는 2026-09-06 "이 기기로 조작"→"내 크기로 맞추기": 입력은 어느 기기에서나 되고 이 버튼이 바꾸는 것은 **격자 크기뿐**이라 옛 문구가 오해를 샀다.)
2. **tmux 는 남긴다 — 프로세스 영속·세션 목록 전담.** 화면은 tmux 에게 그리게 하지 않는다. 데몬이 터미널마다 **control mode(`tmux -C attach`) 클라이언트 하나**로 붙어 `%output` 의 원시 PTY 바이트를 받는다. 실측(2026-09-05, 3.7b): 컨트롤 클라이언트가 유일할 때 `refresh-client -C WxH` 가 window 크기를 그대로 정한다(80x24 → 120x40 → 48x21). `%output` 은 8진 이스케이프(`\033`, `\015\012`)만 풀면 원시 바이트다. tmux 의 tty 재도장 계층이 통째로 사라지므로 잔재·smcup·indn 해킹이 불필요해진다(`scroll-on-clear off` 만 남는다 — §5 참조: 재시작 시드가 tmux history 를 읽는다).
3. **데몬이 터미널마다 headless VT(@xterm/headless 5.5 + serialize)를 소유한다 = 정본.** 스냅샷·과거·모드·커서는 전부 여기서 나온다. tmux capture-pane 은 더 이상 쓰지 않는다.
4. **뷰어에게는 원시 바이트를 그대로 흘린다(seq 포함).** 셀 diff 는 만들지 않는다 — mosh/Herdr 가 diff 를 둔 이유는 고지연 링크/대역폭이고 우리는 1인 LAN/릴레이다. 원시 바이트는 xterm.js 가 이미 완벽히 해석하고, alt-screen(1049)·마우스 모드가 클라이언트에 그대로 도달하므로 **스크롤 라우팅을 서버에 물어볼 필요가 없어진다.**
5. **모든 뷰어의 xterm 은 소유자 격자 크기로 만든다.** 컨테이너가 더 작으면 축소해 보고 세로 초과분은 스크롤한다. 소유자만 컨테이너에 fit 해서 resize 를 보낸다.
   ★ 축소는 **글꼴 크기**로 한다(2026-09-06 안드로이드 실기 회귀로 확정). CSS `transform: scale()` 은 Android WebView 에서 무효다 — WebGL 캔버스를 별도 하드웨어 레이어로 합성해 조상의 transform 배율을 먹지 않아 iPad 만 줄고 안드로이드는 원래 크기로 잘렸다.
6. **PC 로컬 터미널도 같은 경로를 쓴다.** PC 터미널 pane 은 데몬에 로컬 WS(`terminal-local`)로 붙는 뷰어 중 하나다 → 페이징·스냅샷·모드 판정이 **한 언어, 한 구현**. (Rust `pty.rs` 는 win32 와 에이전트 패널이 아직 쓴다 — §5 "남긴 것" 참조.)
7. **v1 ANSI 부트스트랩·canonical 플래그·controller lease·nudge·claim 은 삭제.** 구 릴레이 호환은 v3 프레임을 못 받는 클라이언트를 거부하는 방식으로 끝낸다(앱·PC 는 동시 배포).

## 2. 구성

```
tmux 서버(-L codingpt)                     데몬(runner-core)                         뷰어(PC pane.js / 앱 TerminalWebView)
 cpt-<ws>--t-<tid>  ──%output 원시바이트──▶ TerminalHost(tid)                      ──OUTPUT(seq)──▶ xterm.js (owner 격자 크기)
                    ◀──send-keys/stdin──   ├ headless VT (정본)                    ◀──INPUT──
                    ◀─refresh-client -C──  ├ owner: deviceId, cols×rows            ──RESIZE(owner 만)──
                                           ├ scrollback 10000 → HISTORY_PAGE       ──HISTORY req──
                                           └ snapshot = serialize(VT)+modes+cursor ──SNAPSHOT/RESIZED/OWNER──
```

- **TerminalHost** 하나 = tmux control 클라이언트 프로세스 1 + VT 1 + 뷰어 N. 뷰어 0 이 되면 `CPT_HOST_IDLE_MS`(기본 30초) 뒤 해제한다 — 영원히 붙잡으면 열어 본 터미널 수만큼 `tmux -C` 자식과 VT 가 쌓인다. 놓아도 손실이 없는 이유는 시드 때문이다: 데몬 재시작이든 재attach 든 TerminalHost 는 `capture-pane -e -S -10000` 으로 VT 를 **1회 시드**하고(유일한 capture 사용처) epoch 를 새로 발급해 뷰어에게 스냅샷을 준다.
- **입력**: `send-keys -H <hex>`(16진 바이트, 1KB 청크)로 확정. 순서는 `TmuxControl.command()` 가 **동기 stdin write** 라는 사실이 보장한다(tmux 가 그 줄들을 순차 처리) — 회귀는 `test/terminal-input-order.test.js`.
- **크기**: owner 의 `RESIZE(cols,rows)` 만 받아 **`resize-window -x -y`** + `refresh-client -C` + VT.resize. `refresh-client` 만으로는 부족하다(2026-09-06 실측): 그건 클라이언트 크기만 바꾸고 window 크기는 window-size 정책이 유도하며, 한 번이라도 `resize-window` 가 불린 window 는 `window-size manual` 로 영구 고정돼 이후 refresh 를 통째로 무시한다. 비소유자의 RESIZE 는 무시하고 `OWNER` 프레임으로 되돌려준다. 퇴화 크기(<8x3) 거부는 유지.
- **탭 전환**: `terminal.select` → 살아 있는 뷰어의 정본을 갈아끼운다(`swapTo`). 스트림은 유지하고 새 SNAPSHOT 을 먼저 보낸다.
- **소유권**: `CLAIM` 프레임(deviceId) → owner 교체 → 모든 뷰어에 `OWNER{deviceId,name,cols,rows}` 브로드캐스트 → 뷰어는 자기가 owner 면 fit+resize, 아니면 scale 모드. 소유 상태는 tmux window 옵션(`@cpt_owner`)에 두어 데몬 재시작에도 남긴다.

## 3. 와이어 v3 (CPT3)

바이너리 헤더는 v2 와 동일(MAGIC·ver·opcode·seq·len). opcode:
`OUTPUT=1` 원시 바이트 · `SNAPSHOT=2` {cols,rows,owner,modes,cursor} + ANSI 본문 · `RESIZED=3` {cols,rows} · `OWNER=4` {deviceId,name} · `HISTORY_PAGE=5` {start,end,total,rows[{offset,ansi}]} · `EXIT=6` · `ERROR=7`.
클라→서버(텍스트 JSON): `hello{lastSeq,epoch}` · `input(base64)` · `resize{cols,rows}` · `claim` · `history{before,limit}` · `keepalive`. (바이너리 프레임은 그대로 stdin.)
seq 는 OUTPUT 에만 단조 증가하며 **한 세대(epoch) 안에서만** 유효하다. 재접속 시 링버퍼(2 MiB, sshx 와 동일) 안이고 epoch 가 같으면 OUTPUT 을 이어 보내고, 아니면 SNAPSHOT.
★ epoch 가 없으면 데몬 재시작(seq 0 리셋) 뒤 옛 뷰어의 큰 lastSeq 를 "최신"으로 오판해 그 화면이 **영원히 멈춘다**(2026-09-06 실기 사고). 앞선 seq·다른 epoch 는 무조건 SNAPSHOT.

## 4. 클라이언트 규칙 (PC·앱 공통, crossimpl 테스트로 고정)

- xterm 크기 = 서버가 준 `cols×rows` 외엔 절대 다른 값으로 만들지 않는다. `fit()` 은 owner 일 때만, 결과를 `resize` 로 보낸다.
- 비소유자: `term.options.fontSize` 를 (컨테이너폭 / 격자열수 / 셀폭비) 로 줄인다(상한 = 기본 글꼴, 0.5px 단위). 격자(cols×rows)는 그대로 두고 세로 초과분만 컨테이너 스크롤. 축소 상태 알약 + "내 크기로 맞추기" 버튼(알약은 **터미널 DOM 밖**에서 그린다 — PC `styles.css .pane-owner-pill`, 앱 `PaneView`).
- 스크롤 라우팅은 **로컬** xterm 상태로 판정한다(1049·mouse 모드가 원시 바이트로 오므로): mouse tracking → 휠 리포트 / alt-screen → 방향키 / 일반 → 과거 오버레이(HISTORY_PAGE). 서버 모드 조회(`modes`) 삭제.
- 과거 오버레이는 지금 설계 유지(한 번 써 넣고 자체 스크롤, 진입 시 재조회, 총량 감소 시 캐시 폐기, 행마다 SGR 닫힘).
- 키보드로 높이만 바뀌는 리사이즈는 보내지 않는다(VibeTunnel·Orca 동일).

## 5. 삭제 목록 — **2026-09-06 실행 완료**

지운 것(모든 클라이언트가 `terminalProtocol:3` 만 요청하므로 도달 불가였던 것들):

- 데몬: `attachPty` 의 v1/v2 본문 553줄 통째 · `terminal-controller-lease.js` · `canonical-terminal.js` · `canonical-stream.js` · `terminal-stream-v2.js` · `CPT_CANONICAL_TERMINAL` · `{type:'modes'}` · nudge 타이머 · 스냅샷 3벌(`sendShellSnapshot`/`sendV1ViewerSnapshot`/`finishHistoryBootstrap`/`buildTerminalSnapshotPayload`) · `normalizeResizePromptHistory`(리사이즈 프롬프트 중복은 소유자 1명이라 안 생긴다).
- tmux.conf: `smcup@:rmcup@:indn@` · `alternate-screen on`(기본) · `window-size latest`(기본) · `aggressive-resize`(클라 여럿일 때만 의미). **`scroll-on-clear off` 는 남긴다** — 데몬 재시작 뒤 `capture-pane` 으로 VT 를 시드할 때 이 history 를 읽으므로, on 이면 지웠던 과거가 그때 되살아난다(2026-09-04 사고의 v3 판). 기본값 실측은 tmux 3.7b.
- 앱: `__readV2`/`__applyV2` · `__srvModes`/`__refreshModes`/`MODES_TTL` · `__localScroll` · `__canonicalModel` · v1 historyBootstrap · `selectTerminal` 의 `claim` 인자.
- PC: `pane.js` 의 서버 modes 조회 경로 주석 정리.

**남긴 것과 이유**(§5 초안이 "전부 삭제"라고 적었지만 실제로는 살아 있는 것들):

- `pty.rs` 의 `#[cfg(not(windows))]` tmux attach — **에이전트 패널**(`agents-view.js` PANEL_PANE_ID)이 아직 `api.pty*` 로 쓴다. 터미널 pane 은 이미 v3(`terminal-local`)로 갔다.
- `pane.js` 의 `_claimSize`·`_srvHistory`·`ptyModes` 분기 — 전부 `!localTmuxBackend()`(= win32) 게이트 안이다.
- `terminal.select` 의 `claim` 파라미터는 **받되 무시**한다. 포커스·터치 같은 암묵 신호로 소유권이 넘어가는 것은 §1-1 위반이고, 그게 기기 간 재배치 폭풍의 원인이었다. 가져오기는 뷰어의 `{type:'claim'}`(알약) 하나뿐.

**웨이브3 과제(win32)**: term-host 백엔드는 tmux control mode 가 없어 CPT3 를 못 만든다 → `attachPty` 가 "아직 v3 미지원"으로 **명시 거절**한다. 되살리는 길은 v1/v2 복원이 아니라(클라이언트가 그 말을 못 한다) `TerminalHost` 의 transport 를 `tmux-control` ↔ `term-backend.attach` 로 갈아끼우는 것이다. 그 바탕 계약(attach 스트림·입력·resize·capture)은 `test/term-rewire-host.test.js` 가 계속 지킨다.

**이번에 드러난 v3 구멍 3개(같이 고침)**:
1. **탭 전환이 아예 없었다.** 앱·PC 는 탭을 바꿔도 스트림을 새로 열지 않고 `terminal.select` 만 부르는데, v2 의 swap 이 v3 로 안 넘어와 `paneStreams` 가 비어 있었다 → 탭을 눌러도 옛 터미널이 계속 보였다. `pty-v3.swapTo()` 로 복구(스왑 뒤 SNAPSHOT 이 새 정본 OUTPUT 보다 **먼저** 나가야 한다 — 안 그러면 클라가 옛 세대 seq/epoch 로 판정해 버린다).
2. **뷰어 0 이어도 host 를 영원히 붙잡았다** → 열어 본 터미널 수만큼 `tmux -C` 자식과 headless VT 가 쌓인다. 마지막 뷰어가 떠나고 `CPT_HOST_IDLE_MS`(기본 30초) 뒤 해제(재접속 시 capture-pane 시드 + epoch 교체라 손실 없음).
3. **같은 pane 재접속 시 옛 스트림 축출이 없었다**(릴레이↔LAN 경로 전환) → 죽은 뷰어가 리퍼 90초까지 소켓과 구독을 붙잡았다.

## 6. 단계

1. **데몬 TerminalHost + CPT3** (control 클라이언트·VT·owner·링버퍼·history) — 실 tmux 회귀 테스트: 소유자 교체 시 격자 변경 1회, 비소유자 resize 무시, 재접속 seq 이어받기, clear→history 0, 리사이즈 반복 후 VT==tmux 화면 일치.
2. **PC pane.js v3** (로컬·원격 동일 경로, scale 뷰어, 가져오기 버튼) + Rust 정리.
3. **앱 TerminalWebView v3**.
4. 구 경로 삭제·crossimpl 갱신·실기 검증(PC+Android 동시, 번갈아 조작 → 재배치는 "가져오기" 눌렀을 때만). — **2026-09-06 완료**(§5 참조). 남은 것은 win32 CPT3(웨이브3).
