# cpt — 웹 페이지를 사용자에게 보여주기(프리뷰)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 사용자에게 URL/실행 결과 보여주기 (프리뷰)

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
