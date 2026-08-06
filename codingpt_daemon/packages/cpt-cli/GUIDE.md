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
