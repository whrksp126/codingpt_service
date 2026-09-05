# 터미널 v3 — 한 격자, 한 소유자, 한 구현

작성 2026-09-05. 근거 조사: `~/other/project/_ref/*`(Orca·Herdr·cmux·tmux·Zellij·wezterm·mosh·ET·shpool·sshx·ttyd·VibeTunnel·Happy·Blink 최신 소스) + 보고서 "같은 터미널, 다른 화면".

## 0. 왜 갈아엎나

현재 구조의 복잡도는 버그가 아니라 **정책 선택의 필연**이다.

- tmux `window-size latest` = "마지막에 키/resize/attach 한 클라이언트가 크기를 정한다"(tmux `server-client.c:1356-1368`). PC 와 폰이 번갈아 만지면 PTY 가 179↔48 을 오가며 TUI 가 재배치된다. 그걸 막으려 얹은 15초 controller lease 는 데몬(JS)과 PC(Rust)가 따로 구현해 owner 규칙이 어긋났고(PC 는 `"pc"` 하드코딩), 크기 결정이 4곳, 과거 페이징·스냅샷이 각 3벌, 그 부작용을 40/80/600/1200ms 타이머로 덮는 상태.
- tmux 가 **tty 클라이언트에게 보내는 재도장**(줄 단위 EL + attach 시 `CSR+INDN sy+1`, `tty.c:357-370`)을 그대로 xterm.js 에 먹였기 때문에 클라이언트 스크롤백에 잔재가 쌓였다. tmux 는 화면 렌더러지 상태 동기화기가 아니다.
- 조사한 25개 제품 중 "기기마다 자기 크기로 같은 TUI 를 동시에 최적 배치"는 0개. 진지한 제품(Herdr·Zellij·Orca)은 전부 **크기 소유자 1명 + 나머지는 그 격자를 축소/크롭해 보는 뷰어 + 가져오기**로 수렴했다.

## 1. 결정

1. **크기 소유자(owner)는 터미널마다 정확히 1명이고 사용자가 정한다.** 기본은 터미널을 만든 기기. 다른 기기에서 "이 기기로 조작"을 누르면 소유권이 넘어오고, 이전 소유 기기는 배너("폰이 크기를 잡고 있음 · 되찾기")를 본다. 자동 탈취(마지막 입력 승)는 **하지 않는다** — 그게 재배치 폭풍의 원인이다.
2. **tmux 는 남긴다 — 프로세스 영속·세션 목록 전담.** 화면은 tmux 에게 그리게 하지 않는다. 데몬이 터미널마다 **control mode(`tmux -C attach`) 클라이언트 하나**로 붙어 `%output` 의 원시 PTY 바이트를 받는다. 실측(2026-09-05, 3.7b): 컨트롤 클라이언트가 유일할 때 `refresh-client -C WxH` 가 window 크기를 그대로 정한다(80x24 → 120x40 → 48x21). `%output` 은 8진 이스케이프(`\033`, `\015\012`)만 풀면 원시 바이트다. tmux 의 tty 재도장 계층이 통째로 사라지므로 잔재·smcup·indn·scroll-on-clear 해킹이 전부 불필요해진다.
3. **데몬이 터미널마다 headless VT(@xterm/headless 5.5 + serialize)를 소유한다 = 정본.** 스냅샷·과거·모드·커서는 전부 여기서 나온다. tmux capture-pane 은 더 이상 쓰지 않는다.
4. **뷰어에게는 원시 바이트를 그대로 흘린다(seq 포함).** 셀 diff 는 만들지 않는다 — mosh/Herdr 가 diff 를 둔 이유는 고지연 링크/대역폭이고 우리는 1인 LAN/릴레이다. 원시 바이트는 xterm.js 가 이미 완벽히 해석하고, alt-screen(1049)·마우스 모드가 클라이언트에 그대로 도달하므로 **스크롤 라우팅을 서버에 물어볼 필요가 없어진다.**
5. **모든 뷰어의 xterm 은 소유자 격자 크기로 만든다.** 컨테이너가 더 작으면 CSS `transform: scale()` 로 폭을 맞추고 세로는 스크롤/팬(Orca `terminal-fit-scale.ts`). 소유자만 컨테이너에 fit 해서 resize 를 보낸다.
6. **PC 로컬 터미널도 같은 경로를 쓴다.** Rust 의 tmux attach(`pty.rs`)·`pty_modes`·`pty_history`·`pty_claim` 은 삭제. PC 는 데몬에 로컬 WS 로 붙는 뷰어 중 하나다. 결과적으로 페이징·스냅샷·모드 판정이 **한 언어, 한 구현**이 된다.
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

- **TerminalHost** 하나 = tmux control 클라이언트 프로세스 1 + VT 1 + 뷰어 N. 뷰어 0 이어도 VT 는 유지(과거 보존). 데몬 재시작 시 tmux 가 프로세스를 보존하고 TerminalHost 는 재attach 후 `capture-pane -e -S -10000` 으로 VT 를 **1회 시드**한다(유일한 capture 사용처).
- **입력**: 뷰어 → 데몬 → control 클라이언트 stdin 으로 `send-keys -l`? 아니다 — 컨트롤 모드에서는 `send-keys -t =sess:0 -l --  <문자열>` 을 명령으로 보내야 하며 개행·특수문자 이스케이프가 필요하다. 대안: 입력 전용으로 `tmux send-keys -H`(16진수 바이트) 사용. 확정은 Phase 1 실측으로.
- **크기**: owner 의 `RESIZE(cols,rows)` 만 받아 `refresh-client -C colsxrows` + VT.resize. 비소유자의 RESIZE 는 무시하고 `OWNER` 프레임으로 되돌려준다. 퇴화 크기(<8x3) 거부는 유지.
- **소유권**: `CLAIM` 프레임(deviceId) → owner 교체 → 모든 뷰어에 `OWNER{deviceId,name,cols,rows}` 브로드캐스트 → 뷰어는 자기가 owner 면 fit+resize, 아니면 scale 모드. 소유 상태는 tmux window 옵션(`@cpt_owner`)에 두어 데몬 재시작에도 남긴다.

## 3. 와이어 v3 (CPT3)

바이너리 헤더는 v2 와 동일(MAGIC·ver·opcode·seq·len). opcode:
`OUTPUT=1` 원시 바이트 · `SNAPSHOT=2` {cols,rows,owner,modes,cursor} + ANSI 본문 · `RESIZED=3` {cols,rows} · `OWNER=4` {deviceId,name} · `HISTORY_PAGE=5` {start,end,total,rows[{offset,ansi}]} · `EXIT=6` · `ERROR=7`.
클라→서버(텍스트 JSON): `input(base64)` · `resize{cols,rows}` · `claim` · `history{before,limit}` · `keepalive`.
seq 는 OUTPUT 에만 단조 증가. 재접속 시 클라가 `hello{lastSeq}` 를 보내면 서버는 링버퍼(2 MiB, sshx 와 동일) 안이면 OUTPUT 을 이어 보내고, 아니면 SNAPSHOT.

## 4. 클라이언트 규칙 (PC·앱 공통, crossimpl 테스트로 고정)

- xterm 크기 = 서버가 준 `cols×rows` 외엔 절대 다른 값으로 만들지 않는다. `fit()` 은 owner 일 때만, 결과를 `resize` 로 보낸다.
- 비소유자: `.xterm` 에 `transform: scale(k)` (k = 컨테이너폭 / 격자픽셀폭, 상한 1). 세로 초과분은 컨테이너 스크롤. 축소 상태 표시 + "이 기기로 조작" 버튼.
- 스크롤 라우팅은 **로컬** xterm 상태로 판정한다(1049·mouse 모드가 원시 바이트로 오므로): mouse tracking → 휠 리포트 / alt-screen → 방향키 / 일반 → 과거 오버레이(HISTORY_PAGE). 서버 모드 조회(`modes`) 삭제.
- 과거 오버레이는 지금 설계 유지(한 번 써 넣고 자체 스크롤, 진입 시 재조회, 총량 감소 시 캐시 폐기, 행마다 SGR 닫힘).
- 키보드로 높이만 바뀌는 리사이즈는 보내지 않는다(VibeTunnel·Orca 동일).

## 5. 삭제 목록

- 데몬: `terminal-controller-lease.js`, `mayResizeForLease`, `applyViewerResize`/`resize-window`, nudge 타이머, `sendShellSnapshot`/`sendV1ViewerSnapshot`/`finishHistoryBootstrap`/`buildTerminalSnapshotPayload`, `CPT_CANONICAL_TERMINAL`, `canonical-stream.js`, `{type:'modes'}`, tmux.conf 의 `smcup@:rmcup@:indn@`·`alternate-screen`·`scroll-on-clear`·`window-size`·`aggressive-resize`(컨트롤 클라이언트 단독이라 무의미).
- PC: `pty.rs` 의 tmux attach/resize/claim/modes/history 전부, `pane.js` 의 `_claimSize`·`_bindWheelRouting` 의 서버 조회·`_srvHistory` 분기, `api.pty*`.
- 앱: `__srvModes`/`__refreshModes`, `__localScroll`, v1 historyBootstrap 경로.

## 6. 단계

1. **데몬 TerminalHost + CPT3** (control 클라이언트·VT·owner·링버퍼·history) — 실 tmux 회귀 테스트: 소유자 교체 시 격자 변경 1회, 비소유자 resize 무시, 재접속 seq 이어받기, clear→history 0, 리사이즈 반복 후 VT==tmux 화면 일치.
2. **PC pane.js v3** (로컬·원격 동일 경로, scale 뷰어, 가져오기 버튼) + Rust 정리.
3. **앱 TerminalWebView v3**.
4. 구 경로 삭제·crossimpl 갱신·실기 검증(PC+Android 동시, 번갈아 조작 → 재배치는 "가져오기" 눌렀을 때만).
