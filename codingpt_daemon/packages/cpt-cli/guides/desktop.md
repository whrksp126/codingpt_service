# cpt — 에이전트 PC(네이티브 앱·창)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 에이전트 PC — 네이티브 앱·창을 다뤄야 할 때 (desktop)

이 맥 안에 **에이전트 전용 macOS(게스트 VM)** 가 있다. 사용자는 자기 화면·마우스·키보드를 그대로 쓰고
있으니, **네이티브 앱·창·시스템 설정을 조작해야 하면 사용자 화면이 아니라 여기서 하라.** 사용자 화면을
움직이는 컴퓨터 유즈 도구는 CodingPT 워크스페이스에서 쓰지 않는다. (웹 페이지는 `cpt browser`, 모바일 앱은
`cpt emulator` 가 더 정확하고 가볍다 — 그 둘로 안 되는 것만 데스크톱으로.)

```
cpt desktop status                      # 준비/정지/실행, 연결된 폴더, 개입 대기 여부
cpt desktop show                        # 사용자에게 데스크톱 탭을 띄운다(꺼져 있으면 먼저 켠다 — 수십 초, 맨 처음은 1~2분: 자동 로그인 설정+재시작)
cpt desktop open Safari                 # 앱 실행. URL 이면 게스트 브라우저로(호스트 localhost 는 자동 변환)
cpt desktop os [macos|linux]            # 게스트 OS 보기/바꾸기 — Linux 는 경량(~5GB)·브라우저/GUI/개발, macOS 는 Mac 전용 앱. 꺼진 상태에서만. ax/tap 은 두 OS 동일
cpt desktop ax [앱]                     # ★ 화면 읽기 = 접근성 트리(요소 role·글·0~1 좌표). 스크린샷보다 먼저 이걸
cpt desktop tap "Save" [--app Safari]   # 글자로 요소를 찾아 클릭(버튼·링크·메뉴·입력칸). 좌표 추정 금지
cpt desktop screenshot                  # 화면을 파일로(경로를 돌려준다) — 트리에 없는 것(그림·캔버스)만 이걸로
cpt desktop click 0.42 0.31             # 클릭 · double-click · right-click · move · drag x y x2 y2 · scroll x y [dy]
cpt desktop key cmd+space               # 키 조합 · key enter · key cmd+shift+4
cpt desktop type "hello"                # 글자(ASCII 는 키로, 한글 등은 클립보드+⌘V)
cpt desktop run -- ls "/Volumes/My Shared Files"   # 게스트 셸
cpt desktop connect [폴더]              # 폴더를 게스트에 붙인다(필요할 때만 — 켜져 있으면 다시 켜서 바로 쓴다)
cpt desktop path ./src/app.tsx          # 이 워크스페이스 파일의 게스트 경로(connect 한 폴더 아래여야 한다)
cpt desktop handoff "GitHub 로그인이 필요합니다"     # ★ 사용자가 대신 해야 할 때(로그인·2FA·결제)
```

- **화면은 `ax` 로 읽고 `tap` 으로 누른다.** 스크린샷에서 좌표를 눈대중하면 빗나간다. `ax` 가 준 x,y,w,h 는 0~1 비율이라
  `click x y` 에 그대로 쓸 수 있다(가운데 = x+w/2, y+h/2). 트리가 비어 있으면 앱이 접근성을 안 내는 것(캔버스·게임) —
  그때만 스크린샷. 접근성 권한은 첫 켜기 때 자동으로 켜진다; 실패했다는 오류가 오면 안내대로 `handoff` 로 사용자에게.
- 아무도 안 보고 너도 안 쓰면 **1시간 뒤 스스로 꺼진다**(사용자 설정). 꺼져 있으면 `show`/`start` 가 다시 켠다(7초).
- **위험한 일 전엔 스냅샷.** 시스템 설정을 바꾸거나 무언가를 설치·삭제하기 전에 `cpt desktop snapshot "라벨"`(30초).
  망쳤으면 `cpt desktop restore <이름>` — 되돌리기는 그 뒤 변경을 전부 지우므로 **사용자에게 먼저 말하고** 한다.
- **`handoff` 는 기다린다.** 사용자에게 카드가 가고, 사용자가 데스크톱에서 처리한 뒤 [계속]을 누르면
  명령이 끝난다. 비밀번호를 네가 묻거나 치려 하지 마라 — 사용자가 그 화면에서 직접 친다.
- 사용자가 데스크톱을 만지는 동안 네 입력은 **멈춤** 상태로 거절된다(오류 메시지에 `resume` 안내). 기다렸다
  다시 시도하라. 너 스스로 `resume` 하지 마라 — 그건 사용자의 버튼이다.
- **폴더는 자동으로 붙지 않는다 — 게스트에서 파일이 필요하면 네가 붙여라.** `cpt desktop connect [폴더]`(기본 = 이
  워크스페이스). 어떤 경로든 된다. 켜져 있으면 데몬이 끄고 다시 켜서(20~40초) 바로 쓸 수 있는 게스트 경로를 돌려준다
  (`/Volumes/My Shared Files/<폴더명>`, `cpt desktop path` 로 변환). GUI 조작만 할 땐(브라우저·앱·설정) 붙일 필요 없다.
  다 쓴 폴더는 `disconnect`. 붙인 폴더는 사용자 설정 시트에 그대로 보인다.
- 게스트는 앱스토어 앱·Docker·Android 에뮬레이터가 안 돈다(호스트에서 돌고 네트워크로 닿는다).
