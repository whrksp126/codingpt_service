# cpt — 모바일 화면 확인·조작(에뮬레이터·시뮬레이터)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 모바일 화면 직접 확인·조작 (emulator)

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
