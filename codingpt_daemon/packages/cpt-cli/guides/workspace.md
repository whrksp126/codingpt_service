# cpt — 워크스페이스 관리·진행 상황·알림

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 워크스페이스 관리

```
cpt ws list                            # 워크스페이스 목록(id/이름/경로)
cpt ws new <이름> [--parent <경로>]     # 새 워크스페이스 생성(git init)
cpt ws clone <git-url> [--name <이름>]  # 레포 클론
cpt ws delete <id>                      # 목록에서 삭제 — 로컬 폴더/파일은 절대 지우지 않는다
```

정직성 계약(ws delete): 삭제는 **서버 목록(메타)에서만** 이뤄진다 — PC 의 폴더와 파일은 그대로
남는다. 디스크에서 파일을 지우고 싶으면 사용자에게 확인받고 셸에서 직접 지워라.

## 사이드바에 진행 상황 남기기

```
cpt ws set --comment "수정 완료, 통합 테스트 돌리는 중" --status in-progress
cpt ws set --status in-review       # todo · in-progress · in-review · completed
```

워크스페이스 카드에 한 줄로 보인다. 재현·수정·검증·막힘 같은 의미 있는 지점마다 짧게 갱신하라.

- 이 줄은 **지금 상태**다(기록이 아니다). `completed` 로 적은 줄은 네 세션이 끝나면(종료·`/clear`) 자동으로 지워지고, 이슈에서 시작한 터미널이 적은 줄은 그 이슈가 완료되면 지워진다. 직접 지우려면 `cpt ws set --clear`.

## 알림·진행 상태

장시간 작업이나 완료를 사용자에게 알리려면:

```
cpt notify --title "빌드 완료" --body "테스트 42개 통과"
cpt set-progress 0.6 --label "빌드 중"
cpt set-status build "passing" --color "#22c55e"
```
