# cpt CLI — 전체 가이드 (AI 용, 태스크 중심)

**컨텍스트 규칙(최우선)**: `cpt` 는 **CodingPT 터미널 안에서만** 쓴다 — 판정 기준은 오직
환경변수 `CPT_WS` 하나다. 없으면 여기는 CodingPT 터미널이 아니므로 `cpt` 를 실행하지 마라
(**CodingPT 소스 리포를 작업 중인 것은 근거가 아니다** — 데몬도 워크스페이스 밖 조작 요청은
거부한다). 확실치 않으면 `cpt identify --json` 의 `context` 필드로 판정할 수 있다.

`cpt` 는 네가 지금 실행 중인 **CodingPT 워크스페이스**를 조작하는 CLI다. 사용자는 이 화면을
**폰·태블릿·PC 등 다른 기기에서 원격으로** 보고 있을 수 있다. 그래서 "브라우저 띄워서 확인해봐"
라고 사용자에게 미루지 말고, 네가 직접 `cpt` 로 열고·확인하고·보여줘라.

**중요(기기 라우팅)**: 프리뷰·IDE·화면 조작은 **사용자가 지금 보고 있는 활성 기기 1곳**에 나타난다
(전 기기 동시 아님). 다른 기기에 열고 싶으면 `--on <기기>` 로 지정한다. 접속 중인 기기는
`cpt devices` 로 확인한다(● = 지금 활성 기기).

```
cpt devices                                 # 접속 중인 화면(기기) 목록 — ● 가 활성 기기
cpt preview open :5173                       # 활성 기기에 열기(기본)
cpt preview open :5173 --on iPad             # 특정 기기(이름 부분일치·#id·pc/mobile)에 열기
```

지원되는 명령의 정확한 목록·플래그는 항상 `cpt capabilities` 와 `cpt help` 가 정본이다.
아래는 "무엇을 언제 하는가"의 태스크 레시피다.

## 0. 자기 좌표 확인

```
cpt identify --json          # 내 워크스페이스/터미널 좌표
cpt capabilities             # 이 버전이 지원하는 명령 목록
```

CodingPT 터미널이면 워크스페이스를 자동 인지하므로 대부분의 명령에 대상 지정이 필요 없다.

## 1. 사용자에게 URL/실행 결과 보여주기 (프리뷰)

dev 서버를 띄웠거나 웹 결과를 보여주고 싶으면:

```
cpt preview open http://localhost:5173     # 프리뷰 pane 을 열고 URL 로드(활성 기기)
cpt preview open :5173                      # 축약: 포트만
cpt preview navigate http://localhost:5173/settings
cpt preview reload
cpt preview info                            # 현재 URL/제목/뷰포트
cpt preview close
cpt preview handoff --to iPad               # 현재 프리뷰를 다른 기기로 이어주기(로그인 세션·쿠키·localStorage 포함)
```

프리뷰 이어주기(핸드오프): `cpt preview handoff --to <기기>` 는 지금 활성 기기(또는 `--on` 지정 기기)의
프리뷰를 URL·localStorage·쿠키(httpOnly 포함)째 캡처해 `--to` 기기에서 로그인 상태 그대로 이어보게 한다.
사용자가 "이 화면 폰에서 이어서 볼래" 같은 요청을 하면 이걸 쓴다. (기기 오리진이 달라도 쿠키를 자동 재작성.)

- 그냥 `open <url>` 을 써도 CodingPT 터미널 안에서는 자동으로 이 프리뷰로 라우팅된다. 하지만
  의도를 분명히 하려면 `cpt preview open` 을 직접 쓰는 게 낫다.
- 여러 프리뷰를 다룰 땐 `--sid <표면id>` 로 대상을 지정한다(생략 시 활성 프리뷰).

## 2. 프리뷰 내부 확인·조작·검사 (browser)

프리뷰로 띄운 **로컬 개발 페이지**는 자동화·검사할 수 있다(외부 사이트 조작은 보안상 제한).

```
cpt browser snapshot                  # 인터랙티브 요소 트리(ref 포함) — 좌표 대신 ref 로 조작
cpt browser click <ref|selector>      # 또는 좌표: cpt browser click --x 200 --y 300
cpt browser scroll --dy 800           # 상대 스크롤(dx/dy) / 절대(--x --y) / 요소로: cpt browser scroll <ref>
cpt browser press Enter --target "input[name=q]"   # 키 입력(Enter/Escape/Tab/Arrow*/문자, --mod ctrl,shift)
cpt browser type <ref|selector> "텍스트"
cpt browser fill <ref|selector> "값"
cpt browser eval "document.title"     # 페이지 컨텍스트 JS
cpt browser wait --selector ".ready"
cpt browser get text --selector "h1"
cpt browser screenshot                # 캡처 — --out 없으면 ~/.codingpt/tmp/shot-<ts>.jpg 에 저장하고 경로 출력
cpt browser console                   # 프리뷰 콘솔 로그 조회(--limit/--level/--pattern, --clear 로 버퍼 비움)
cpt browser console --level error --pattern "fetch"   # 에러만 + 정규식 필터
cpt browser network                   # 프리뷰 네트워크 요청 조회(fetch/XHR — --limit/--pattern/--status, --clear)
cpt browser network --status 4xx      # 실패 요청만 (4xx/5xx/err=미도달·네트워크 에러/숫자=정확일치)
cpt preview devtools on                # 개발자도구 열기(네가 보는 기기 기준)
```

정직성 계약(console): `console` 은 **프리뷰 웹뷰 한정**이고, 후크가 **주입된 이후의 로그만** 잡힌다
(주입 전 초기 로그·다른 브라우저/외부 창의 로그는 없다). 링버퍼(500개)라 오래된 항목은 밀려난다.
페이지 첫 로드 시점 로그가 필요하면 `preview reload` 후 조회하라.

정직성 계약(network): `network` 도 프리뷰 웹뷰 한정이며, 후크가 **주입된 이후에 시작된 fetch/XHR 만**
잡힌다(주입 전 초기 로드 요청·img/script 태그 로드는 없다). **응답 바디는 수집하지 않는다**(메서드·URL·
status·소요시간·에러만). 리다이렉트는 최종 응답만 보인다. 링버퍼(300개)라 오래된 항목은 밀려난다.
페이지 첫 로드 요청이 필요하면 `preview reload` 후 조회하라.

정직성 계약(press): `press` 의 키 이벤트는 합성(isTrusted:false)이라 앱 JS 리스너엔 통하지만
브라우저 기본동작(폼 submit·단축키 등)은 발화 안 될 수 있다. 폼 제출은 `click` 으로 버튼을 누르거나
`fill`+`click` 을 병용하라.

정직성 계약: `screenshot` 은 **명령을 실행한 기기의 현재 뷰포트 실렌더**다(전체 페이지 아님).
결과 메타의 `{device, viewport}` 를 보고 해석하라. 어느 기기가 실행할지 네가 통제할 수 없으므로,
특정 화면 크기 검증이 목적이면 그 전제를 밝혀라. 요소를 다룰 때는 좌표보다 `snapshot` 의 ref 를
쓰고, ref 가 낡으면 다시 `snapshot` 을 떠라.

### 요소 선택 — 디자인 모드 (preview inspect)

사용자가 "이 요소 어디서 왔어 / 이 버튼 고쳐줘(화면을 가리키며)" 같은 **화면 위 특정 요소** 얘기를
하면, 요소 선택 모드를 켜서 사용자가 직접 찍게 하라:

```
cpt preview inspect                    # 요소 선택 모드 시작(1회성) — 활성 기기의 프리뷰에
cpt preview inspect --off              # 모드 취소
```

워크플로:

1. `cpt preview inspect` 로 모드를 시작한다(CLI 는 모드 시작만 확인하고 즉시 반환).
2. **사용자에게 "화면에서 해당 요소를 클릭(탭)해 주세요"라고 요청**한다. 선택 결과는 비동기다 —
   사용자가 클릭해야만 나온다(ESC/다른 프리뷰 조작 시 취소).
3. 사용자가 클릭하면 결과가 **네 터미널 프롬프트에 한 줄로 삽입**된다:
   `[디자인] <파일:줄> <선택자> "<텍스트>" '<크롭샷경로>'`
   (소스 위치는 React/Vue 디버그 정보가 있을 때만 붙는다 — 없으면 선택자만.)
4. 삽입된 줄의 **파일:줄**로 해당 소스를 바로 열어 수정하고, **크롭샷 경로**(jpg)를 읽어 요소의
   실제 모양을 확인하라.

정직성 계약(inspect): 결과는 사용자가 클릭해야만 온다 — 모드를 켰다고 네가 결과를 기다리며
블록하지 말고, 클릭을 요청한 뒤 삽입된 [디자인] 줄이 프롬프트에 나타나면 그걸 읽어라. 파일:줄은
프레임워크 디버그 빌드(React `_debugSource` 등)에 의존해 프로덕션 빌드에선 빠질 수 있다.

## 3. 코드 보여주기·이동 (IDE)

특정 파일의 특정 위치를 사용자에게 보여주려면:

```
cpt ide open src/App.tsx --line 42     # 파일 열고 42행으로 이동(활성 기기)
cpt ide list                            # 지금 열린 파일 목록
cpt ide close-file src/App.tsx          # 파일 탭 하나 닫기
cpt ide close                           # IDE pane 닫기
```

파일 내용 자체는 디스크가 정본이고 모든 기기가 실시간으로 같은 파일을 본다. `ide open` 은
"어느 파일의 어느 줄을 보여줄지"를 활성 기기(또는 --on 지정 기기)에 맞춘다.

### 변경사항(diff) 보여주기

사용자가 "변경사항 보여줘 / diff 보여줘"라고 하면:

```
cpt ide diff src/App.tsx               # 이 파일의 git diff 를 IDE 에 읽기 전용 문서로 표시
cpt ide diff src/App.tsx --staged      # 스테이징된 변경만
cpt ide open-changed                    # 변경된 파일 전부(기본 diff 로, --max 10)
cpt ide open-changed --mode both        # 파일 열기 + diff 같이
cpt ide open-changed --mode edit        # diff 없이 파일만 열기
```

정직성 계약(ide diff): diff 는 명령 실행 시점의 **스냅샷**이다 — 이후 파일을 더 편집해도 열린
diff 문서에는 반영되지 않는다(최신을 보려면 다시 `ide diff`). 변경이 없으면 화면에 아무것도
띄우지 않고 "변경 없음"을 돌려준다. 큰 diff 는 256KB 에서 잘리고(truncated), git 저장소가
아니거나 워크스페이스 밖 경로면 에러다.

### 사용자에게 리뷰받기 (review)

```
cpt review                              # 지금 변경한 파일 전부를 사용자에게 리뷰 요청
cpt review src/a.ts src/b.ts            # 특정 파일만
cpt review --staged                     # 스테이징된 변경만
cpt review --title "인증 리팩터링"        # 리뷰 제목(화면 상단)
cpt review --timeout 600                # 기다릴 시간(초, 기본 1800)
```

사용자 화면(PC/폰)의 IDE 가 리뷰 모드로 바뀐다. 사용자는 **덩어리마다 승인/거절**하고 바뀐 줄에
코멘트를 달 수 있고, 다 되면 [보내기]를 누른다. 그때까지 이 명령은 **블록**된다.

결과(stdout, JSON):

```json
{ "reviewId": "rv_...", "status": "submitted",
  "files": [{ "path": "src/a.ts", "verdict": "rejected",
              "hunks": [{ "index": 0, "decision": "approve" },
                        { "index": 1, "decision": "reject" }],
              "comments": [{ "hunk": 1, "side": "new", "line": 42, "text": "여기 상수로 빼줘" }] }],
  "note": "전체적으로 좋아요" }
```

- `status`: `submitted`(사용자가 보냄) / `cancelled`(사용자가 취소) / `timeout`(시간 초과).
  **`cancelled` 는 승인이 아니다** — 안 본 변경을 통과시키지 말 것.
- `verdict`: 덩어리 판정에서 파생 — `approved`(전부 승인) / `rejected`(하나라도 거절) /
  `partial`(안 정한 것이 있음). `decision: "skipped"` = 사용자가 그 덩어리를 안 정했다.
- `side`/`line`: 코멘트 좌표. `new` = 지금 파일의 줄 번호, `old` = 고치기 전 파일의 줄 번호.
- 코멘트는 **모아서 한 번에** 온다(한 줄 달 때마다 깨우지 않는다). 되돌리기는 없다 — 거절과
  코멘트를 읽고 **네가 고친다**.

정직성 계약: 이 도구는 **네가 판단해서 쓰는 것**이지 강제 관문이 아니다. 사용자가 다 보고 싶어
할 만한 변경일 때 쓰면 되고, 자잘한 수정까지 매번 부르면 방해가 된다. 화면이 하나도 안 켜져
있으면 리뷰를 띄우지 못하고 에러가 난다(그때는 그냥 평소대로 진행하면 된다). 변경이 없으면
"변경 없음"을 돌려준다.

## 4. 화면 배치 (layout)

```
cpt layout tree                         # 현재 레이아웃(보고 있는 기기 기준)
cpt layout split right --type preview --url :5173
cpt layout focus <paneId>
cpt layout close <paneId>
```

## 5. 다른 터미널 조작

```
cpt terminal list
cpt terminal new --name build
cpt read-screen 2 --lines 100          # 2번 터미널 화면 읽기
cpt send 2 "npm test" --enter          # 2번 터미널에 명령 입력
cpt terminal wait 2                     # 2번 터미널의 에이전트가 유휴가 될 때까지 대기(기본 600s)
cpt terminal wait 2 --for permission    # 승인 대기 상태가 될 때까지 (any = idle 또는 permission)
```

주의: **자기 자신 터미널**에 `send`/`send-key`/`terminal wait` 하려면 `--force` 가 필요하다(자기루프 방지).

정직성 계약(terminal wait): 대기는 tmux 관찰(agent-watch) 기반이라 실제 상태보다 최대 2초쯤
늦게 감지된다. 에이전트가 아직 시작 전이면 즉시 idle 로 판정될 수 있으니, `send` 직후라면 한두 초
띄우고 걸어라. 타임아웃이면 `{ timeout: true, state }` 를 돌려준다(에러 아님).

## 6. 워크스페이스 관리

```
cpt ws list                            # 워크스페이스 목록(id/이름/경로)
cpt ws new <이름> [--parent <경로>]     # 새 워크스페이스 생성(git init)
cpt ws clone <git-url> [--name <이름>]  # 레포 클론
cpt ws delete <id>                      # 목록에서 삭제 — 로컬 폴더/파일은 절대 지우지 않는다
```

정직성 계약(ws delete): 삭제는 **서버 목록(메타)에서만** 이뤄진다 — PC 의 폴더와 파일은 그대로
남는다. 디스크에서 파일을 지우고 싶으면 사용자에게 확인받고 셸에서 직접 지워라.

## 7. 모바일 화면 직접 확인·조작 (emulator)

이 PC 에 붙어 있는 **안드로이드 에뮬레이터/실기기와 iOS 시뮬레이터**를 직접 보고 조작한다.
앱을 고쳤으면 **사용자에게 묻지 말고 네가 직접 열어서 확인하라** — 그게 이 명령의 값이다.

```
cpt emulator list                       # 붙어 있는 기기(꺼진 AVD 포함). id 는 android:… / ios:… / avd:…
cpt emulator boot --device avd:Pixel_9a # 꺼진 기기 켜기(켜지면 id 가 android:emulator-5554 로 바뀐다)
cpt emulator screenshot --device <id>   # 지금 화면을 파일로 저장(경로를 돌려준다)
cpt emulator ax --device <id>           # ★ 화면을 글자로 읽기(라벨 + 0~1 좌표)
cpt emulator ax --device <id> 설정        # 검색어로 거르기
cpt emulator tap-label --device <id> "설정"   # ★ 라벨로 누르기(후보가 여럿이면 안 누르고 알려 준다)
cpt emulator tap --device <id> 0.5 0.5  # 좌표로 누르기(0~1 정규화)
cpt emulator swipe --device <id> 0.5 0.8 0.5 0.2 --ms 250
cpt emulator key --device <id> home     # back|home|recents|volumeUp|volumeDown|lock
cpt emulator rotate --device <id> landscape   # 세로/가로(portrait|landscape). 반응형 확인용
cpt emulator text --device <id> "안녕"
cpt emulator open --device <id> https://…   # 주소/딥링크 열기
cpt emulator show                       # ★ 사용자 화면에 모바일 화면 탭을 띄운다(생략 시 켜진 기기)
cpt emulator show --device <id> --on 폰   # 어느 기기에 띄울지 지정(--on 생략 = 지금 보고 있는 기기)
cpt emulator hide                       # 띄운 탭 닫기
```

★ **네가 본 것을 사용자도 보게 하라.** `screenshot`/`ax` 는 **너만** 보는 것이다. 화면 동작을
보여 줘야 하는 일(애니메이션·스크롤·입력 반응처럼 정지 화면으로는 설명이 안 되는 것)이면
`cpt emulator show` 로 사용자가 **지금 보고 있는 기기**(PC·폰·태블릿 무엇이든)에 라이브 화면을
띄워라. 사용자는 그 탭에서 직접 만져 볼 수도 있다. 프리뷰(`cpt preview open`)를 여는 것과 같은 급이다.

**좌표는 전부 0~1 정규화다**(왼쪽 위 0,0 / 오른쪽 아래 1,1). 화면 픽셀을 알 필요가 없고 회전·배율이
달라도 어긋나지 않는다.

★ **스크린샷을 눈으로 보고 좌표를 찍지 마라.** 어긋나도 성공으로 보이고(기기는 화면 밖 탭에
아무 반응이 없다) 왜 안 됐는지 알 방법이 없다. 순서는 항상:

1. `cpt emulator ax` 로 지금 화면에 **무엇이 있는지** 읽는다
2. `cpt emulator tap-label "…"` 로 누른다 — 못 찾으면 **오류로** 알려 준다
3. 확인이 필요하면 `cpt emulator screenshot` 으로 눈으로도 본다

★ **회전은 "요청"이다.** 홈 화면(아이폰·안드로이드 런처)이나 세로 고정 앱은 OS 가 회전을 거부한다 —
`rotate` 는 성공을 돌려주지만 기기 화면은 그대로다. 반응형 레이아웃을 확인하려면 **가로를 지원하는
앱을 앞에 띄운 뒤** 돌리고, `ax` 또는 스크린샷으로 **실제로 바뀌었는지 확인**하라.

정직성 계약: `ax` 는 그 순간 화면의 접근성 트리다. 애니메이션 중이거나 커스텀 렌더링(캔버스·게임)
이면 요소가 비어 있을 수 있다 — 그때는 스크린샷 + 좌표로 가라. 어떤 키를 받는지는 기기마다 다르니
`cpt emulator list` 의 `caps.keys` 를 보라(없는 키는 오류를 돌려준다).

## 7-2. 에이전트 PC — 네이티브 앱·창을 다뤄야 할 때 (desktop)

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

## 6-2. 작업(Agent Tasks) — 전용 작업 폴더에서 다른 에이전트가 맡는 일

**작업**은 저장소의 git worktree(`~/.codingpt/worktrees/…`)마다 에이전트 1개를 돌린다. 사용자가 폰/PC 에서
만들 수도 있고, 네가 **인계**로 만들 수도 있다("다른 에이전트한테 넘겨", "따로 해 줘").

```
cpt task get                 # 이 터미널이 속한 작업(프롬프트 전문 포함)
cpt task list [--all]        # 이 PC 의 작업 목록(* = 이 터미널의 실행)
cpt task create --prompt "<맡길 일>" [--agent claude|codex|gemini] [--model <id>] [--base <branch>]
cpt task commit <taskId> --message "…"      # 작업 폴더의 변경을 커밋
cpt task merge <taskId> [--message "…"]     # base 브랜치로 머지하고 작업 폴더 정리(미커밋 변경은 --message 로 커밋 후)
cpt task discard <taskId> [--force]         # 머지하지 않고 폐기(30일 복구 가능)
```

규율: 인계는 **결과를 기다리지 않는다** — 작업 ID 를 사용자에게 알리고 끝낸다. 결과를 받아서 이어 가야 하면
인계가 아니라 오케스트레이션이다(아래 6-3). 네가 작업 터미널 안의 에이전트라면 작업 브랜치(`cpt/…`)에서
평소처럼 고치고 커밋한 뒤 멈춘다 — 자기 작업을 스스로 머지하거나 worktree 를 지우지 마라(맡긴 쪽이 한다).

## 6-3. 오케스트레이션 (cpt orch) — 여러 에이전트에게 나눠 맡기고 결과 받기

사용자가 "나눠서 시켜 / 병렬로 / 여러 에이전트로 / 지켜보다가 모아 줘" 라고 하면 네가 **코디네이터**가 되어
워커를 띄우고, 수신함으로 결과·질문을 받고, 끝난 워커를 정리한다. 프롬프트 맨 위에 워커 안내문이 있으면
너는 **워커**다 — 그 안내문의 명령을 그대로 따른다.

```
cpt skills get cpt-orch      # 전체 가이드(먼저 읽어라)
cpt orch status              # 내 역할·상한
cpt orch worker-start --spec "<일>" --agent claude
cpt orch check --wait --types worker_done,escalation,question
```

내장 서브에이전트로 대신하지 마라 — 사용자가 사이드바에서 보고 조종할 수 없다.

## 6-4. 사이드바에 진행 상황 남기기

```
cpt ws set --comment "수정 완료, 통합 테스트 돌리는 중" --status in-progress
cpt ws set --status in-review       # todo · in-progress · in-review · completed
```

워크스페이스 카드에 한 줄로 보인다. 재현·수정·검증·막힘 같은 의미 있는 지점마다 짧게 갱신하라.

## 7-3. 자동화 (cpt auto)

**언제 만드나**: 사용자가 "매일 / 매주 / …마다 / …하면 / 자동으로 / 알림 설정" 처럼 **반복·조건**을 말하면
작업 대신(또는 작업과 함께) 자동화를 만든다. 만든 뒤 사용자에게 **id 와 요약을 한 줄로** 알린다.
확신이 없으면 만들지 말고 물어라. 자동화는 이 PC 에 산다(PC 가 꺼져 있거나 잠들면 돌지 않는다).

```
cpt auto schema                         # 이 절(스키마·변수·예시) 출력
cpt auto create --file spec.json        # 또는: cat spec.json | cpt auto create -   → id 출력
cpt auto create --file spec.json --dry-run   # 검증만(정규화 결과·다음 실행·경고)
cpt auto list | get <id> | log [<id>] [--limit n]
cpt auto update <id> --file patch.json  # patch = {name?, trigger?, actions?, guards?, enabled?}
cpt auto pause|resume|run|remove <id>
```

**Draft 스키마** (`auto.create` 입력 — JSON 하나):

```
{ "name": "매일 bug 이슈 정리",                    // ≤ 80자(생략 시 트리거 라벨)
  "trigger": <Trigger>,                             // 정확히 1개
  "actions": [<Action>, …],                         // 1~5개, 순서대로 실행(= 매크로). 한 단계 실패 시 중단
  "guards": { "maxRunsPerDay": 10, "maxConcurrent": 1, "cooldownMs": 300000 } }   // 생략 가능(기본값)

Trigger
  {"type":"schedule","cron":"0 9 * * 1-5","tz":"Asia/Seoul","missed":"once"}   // 5필드 cron, 최소 간격 15분
  {"type":"schedule","at":<ms epoch>,"tz":"Asia/Seoul"}                         // 일회 — 실행 후 꺼짐
  {"type":"git.commits","repo":"work/app","branch":"main","remote":"origin"}   // 원격 새 커밋(5분 폴링)
  {"type":"github.issues","repo":"work/app","labels":["bug"],"state":"open"}   // 새 이슈 1건당 1회(5분 폴링, gh 로그인 필요)
  {"type":"pr.ci_failed","repo":"work/app"|null}                                // 작업 PR 의 CI 실패(null = 이 PC 전체)
  {"type":"pr.review_comments","repo":…}                                        // 작업 PR 에 새 리뷰 코멘트
  {"type":"task.event","event":"review_ready"|"merged"|"failed","repo":…}      // 작업 상태 변화

Action
  {"type":"task.create","repo":"work/app","subdir":"","base":null,"agents":[{"id":"claude","count":1}],
   "title":"{issue.title}","prompt":"…","copyEnv":true}          // 새 worktree 작업(메인 체크아웃은 안 건드린다)
  {"type":"terminal.prompt","target":{"event":true}|{"taskId":"t_…","runId":"r_…"}|{"cwd":"work/app","tid":1000123},
   "text":"…"}                                                    // 에이전트가 붙어 있고 쉬고 있을 때만 지시(작업 중이면 건너뜀)
  {"type":"notify","title":"…","subtitle":"…"}                   // 사용자 폰/PC 알림
```

`repo` 는 홈 기준 상대 경로(`cpt identify` 의 ws 와 같은 형식)이고 git 저장소여야 한다. `base:null` = 저장소의 현재 브랜치.

**템플릿 변수** (`{a.b}` 정확 치환만 — 없는 변수는 빈 문자열):

| 변수 | 언제 |
|---|---|
| `{now}` `{auto.name}` `{repo.name}` `{repo.path}` `{branch}` | 항상(가능하면) |
| `{issue.number}` `{issue.title}` `{issue.body}` `{issue.url}` `{issue.labels}` `{issue.author}` | github.issues |
| `{commits.count}` `{commits.range}` `{commits.subjects}` `{commits.authors}` | git.commits |
| `{pr.number}` `{pr.url}` `{ci.failedChecks}` `{ci.failedLogs}` `{review.comments}` | pr.* |
| `{task.id}` `{task.title}` `{run.id}` `{run.branch}` `{run.agent}` | pr.* / task.event |
| `{prev.taskId}` `{prev.runId}` | 앞 단계가 만든 작업 |

**예시 1 — 매일 아침 이슈 정리** (평일 09:00, 작업 1개):

```
{"name":"평일 아침 bug 이슈 정리",
 "trigger":{"type":"schedule","cron":"0 9 * * 1-5","tz":"Asia/Seoul"},
 "actions":[{"type":"task.create","repo":"work/app","agents":[{"id":"claude","count":1}],
             "title":"bug 이슈 정리","prompt":"gh 로 열린 bug 라벨 이슈를 훑고 중복·해결된 것을 정리해 보고해라."}]}
```

**예시 2 — main 에 커밋될 때마다 테스트 작업**:

```
{"name":"main 커밋마다 테스트",
 "trigger":{"type":"git.commits","repo":"work/app","branch":"main"},
 "actions":[{"type":"task.create","repo":"work/app","base":"main","title":"테스트 {commits.range}",
             "prompt":"새 커밋 {commits.count}개를 받았다:\n{commits.subjects}\n\n테스트를 돌리고 깨진 게 있으면 고쳐라."}]}
```

**예시 3 — CI 가 깨지면 알림만**:

```
{"name":"CI 실패 알림",
 "trigger":{"type":"pr.ci_failed","repo":null},
 "actions":[{"type":"notify","title":"PR #{pr.number} 검사 실패","subtitle":"{ci.failedChecks}"}]}
```

**금지·한계**:
- **자동화 안에서 자동화를 만들지 않는다.** 자동화가 만든 작업의 터미널에서 `cpt auto create` 는 거부된다(`AUTO_LOOP`).
  연쇄는 깊이 2 까지(`AUTO_DEPTH`).
- 하루 실행 상한 기본 10회(최대 50) · 동시 1개 · PC 당 30개. 셸 명령·파일 쓰기·push·merge 액션은 **없다** —
  필요한 일은 `task.create` 로 작업을 만들어 에이전트가 승인 흐름 안에서 하게 표현하라.
- 자동화는 CodingPT 터미널 안에서만 만들 수 있다(`AUTO_OUT_OF_TERMINAL`). 만들면 사용자에게 알림이 간다.
- 사용자가 멈추라고 하면 `cpt auto pause <id>` 또는 `remove <id>`. 전체 일시정지는 사용자만 켜고 끈다.

## 8. 알림·진행 상태

장시간 작업이나 완료를 사용자에게 알리려면:

```
cpt notify --title "빌드 완료" --body "테스트 42개 통과"
cpt set-progress 0.6 --label "빌드 중"
cpt set-status build "passing" --color "#22c55e"
```

## 규율

- 지원하지 않는 명령이면 **추측하지 말고** `cpt capabilities` 로 확인하라.
- 파괴적이지 않은 조회(`identify`/`list`/`snapshot`/`info`)를 먼저 써서 상태를 파악한 뒤 행동하라.
- 에이전트 호출은 `--json` 을 붙여 출력을 파싱하라.
