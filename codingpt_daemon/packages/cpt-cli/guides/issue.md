# cpt — 이슈(Tasks)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 이슈 (`cpt issue`)

사용자는 PC·폰의 **이슈** 화면에서 할 일을 관리한다. CodingPT 자체 이슈와 이 폴더의 GitHub 이슈가 한 목록으로 보인다.

```sh
cpt issue list --json                 # 이 워크스페이스의 열린 이슈(자체 + GitHub)
cpt issue show "#12"                  # 본문
cpt issue create --title "로그인 리다이렉트가 두 번 일어남" --body "<재현 방법·기대 동작>" --priority high
cpt issue update "#12" --status in_review      # todo | in_progress | in_review | done
```

- 사용자가 "이슈로 남겨줘", "할 일에 추가해줘", "나중에 하자" 라고 하면 `issue create` 로 남긴다(본문은 혼자서 읽히게).
- 이슈에서 시작된 일이면(프롬프트에 이슈 ID 가 있다) 끝낼 때 `issue update "<id>" --status in_review` 로 알린다. `done` 은 사용자가 확인한 뒤에.
- 일하다가 범위 밖 문제를 찾았으면 지금 고치지 말고 이슈로 남기고 사용자에게 한 줄로 알린다.
- GitHub 에 만들려면 `--github`(사용자가 그렇게 말했을 때만). ID 는 `gh:<소유자>/<저장소>#<번호>` 꼴이다 — 따옴표로 감싼다.
