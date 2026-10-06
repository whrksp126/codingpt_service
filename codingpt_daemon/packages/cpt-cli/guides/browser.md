# cpt — 웹 페이지 확인·조작·검사(CodingPT 브라우저)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 프리뷰 내부 확인·조작·검사 (browser)

웹 페이지를 확인하거나 조작할 때 쓴다. 순서는 `cpt preview open <url>` 로 열고 → `cpt browser snapshot` 으로 읽고 → `click`/`fill`/`press` 로 조작 → `screenshot`·`console`·`network` 로 확인.

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
