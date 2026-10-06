# cpt — 코드·diff 보여주기와 리뷰(IDE)

> CodingPT 터미널 전용(`$CPT_WS` 가 있을 때만). 명령·플래그의 정본은 `cpt capabilities` · `cpt help` 다. 다른 주제: `cpt skills list`

## 코드 보여주기·이동 (IDE)

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
