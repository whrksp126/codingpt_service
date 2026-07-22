# cpt CLI — 전체 가이드 (AI 용, 태스크 중심)

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
cpt browser screenshot --out /tmp/shot.png   # 캡처(파일로 저장)
cpt preview devtools on                # 개발자도구 열기(네가 보는 기기 기준)
```

정직성 계약(press): `press` 의 키 이벤트는 합성(isTrusted:false)이라 앱 JS 리스너엔 통하지만
브라우저 기본동작(폼 submit·단축키 등)은 발화 안 될 수 있다. 폼 제출은 `click` 으로 버튼을 누르거나
`fill`+`click` 을 병용하라.

정직성 계약: `screenshot` 은 **명령을 실행한 기기의 현재 뷰포트 실렌더**다(전체 페이지 아님).
결과 메타의 `{device, viewport}` 를 보고 해석하라. 어느 기기가 실행할지 네가 통제할 수 없으므로,
특정 화면 크기 검증이 목적이면 그 전제를 밝혀라. 요소를 다룰 때는 좌표보다 `snapshot` 의 ref 를
쓰고, ref 가 낡으면 다시 `snapshot` 을 떠라.

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
```

주의: **자기 자신 터미널**에 `send`/`send-key` 하려면 `--force` 가 필요하다(자기루프 방지).

## 6. 알림·진행 상태

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
