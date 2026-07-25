# 훅 실측 결과 (2026-07-25) — 기능1 전제 검증

claude 2.1.220 실기기 실측. 격리 tmux 소켓(`-L cptprobe`) + `--settings` 프로브로 확인, 사용자 설정·세션 무접촉.
설계서의 추정을 **실측으로 대체**한 항목만 기록한다. 프로브 산출물은 세션 스크래치패드(비영속).

---

## 1. ★ auto 모드에서 PermissionRequest 가 발화한다 (기능1 전제 성립)

사용자 실사용 모드는 `auto` 99%인데, auto 모드는 도구 승인을 자동 허용하므로
"승인 요청 훅이 아예 안 오는 것 아니냐"가 최대 미확정 리스크였다. **발화한다.**

`--permission-mode auto` 에서 `AskUserQuestion` 호출 시 관측된 훅 순서:

```
1  SessionStart        source=startup, model=claude-opus-5[1m]
2  UserPromptSubmit    permission_mode=auto, prompt=<본문>
3  PreToolUse          tool_name=AskUserQuestion
4  PermissionRequest   tool_name=AskUserQuestion, permission_mode=auto   ← 채택 대상
5  Notification        notification_type=permission_prompt, message="Claude needs your permission"
```

즉 auto 모드에서도 **사용자를 멈춰 세우는 도구**(AskUserQuestion 426회 / ExitPlanMode 58회, 전 세션 누적)는
그대로 `PermissionRequest` 로 온다. auto 모드가 자동 허용하는 것은 Bash/Edit 같은 실행 도구뿐이다.

## 2. tool_input 에 선택지 구조가 전부 담겨 온다

폰에서 네이티브 선택 버튼을 그리는 데 필요한 정보가 전부 있다(요약·재구성 불필요):

```jsonc
{
  "session_id": "6615f2cf-…",
  "transcript_path": "/Users/…/.claude/projects/<slug>/<session_id>.jsonl",
  "cwd": "/…/ws",
  "prompt_id": "e5508126-…",
  "permission_mode": "auto",
  "effort": { "level": "high" },
  "hook_event_name": "PermissionRequest",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [{
      "question": "Do you prefer apple or banana?",
      "header": "Fruit",
      "options": [
        { "label": "Apple",  "description": "Crisp, tart, and refreshing." },
        { "label": "Banana", "description": "Soft, sweet, and portable." }
      ],
      "multiSelect": false
    }]
  }
}
```

## 3. ★ 훅이 원격 답변을 실제로 전달할 수 있다 (왕복 성립)

`PermissionRequest` 훅이 stdout 으로 결정 JSON 을 내면 claude 가 그것을 도구 결과로 받아 진행한다.
`AskUserQuestion` 처럼 "허용/거절"이 아니라 **답을 골라야 하는** 도구는 `deny.message` 에 선택을 실어 보낸다:

```jsonc
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
    "decision": { "behavior": "deny", "message": "[원격응답] 사용자가 Banana 를 선택했습니다." } } }
```

실측 TUI 결과 — claude 가 메시지를 정확히 해석했다:

```
❯ Use the AskUserQuestion tool to ask me whether I prefer apple or banana.
  ⎿  Error: [원격응답] 사용자가 Banana 를 선택했습니다.
  ⎿  Denied by PermissionRequest hook
⏺ You picked Banana 🍌 — noted.
```

**설계 반영**
- Bash/Write 등 진짜 권한 요청 → `behavior:'allow'|'deny'` (의미 정확, 표시도 자연스러움)
- AskUserQuestion / ExitPlanMode 등 선택형 → `deny` + `message` 에 선택 내용
- 부작용(수용): TUI 에 `Error:` / `Denied by PermissionRequest hook` 로 표시된다. 실제로 거절이 아니므로
  문구를 `[CodingPT 원격응답] …` 로 시작해 사람이 오해하지 않게 한다. 트랜스크립트에도 이 형태로 남는다.

## 4. ★ 훅 블로킹 시간 = config `timeout` 이 실제 상한이다

`timeout: 60` 설정에 18초 대기 후 결정 반환 → **정상 수락**(`waitedMs: 18003`).
claude 내부에 더 짧은 하드 상한은 관측되지 않았다. 즉 "폰 응답을 기다리는" 모델이 성립한다.

- 블로킹은 `PermissionRequest` 훅 하나로 한정하고, 나머지 6종은 계속 비블로킹(fire-and-forget)이어야 한다.
- 마감 정책은 `defer`: 훅이 빈 stdout + exit 0 으로 끝나면 **평소처럼 TUI 다이얼로그로 폴백**한다
  (= 자동 허용이 절대 발생하지 않음). 기능1 은 이 fail-safe 위에 얹는다.

## 5. ⚠ 설계서 정정 — 훅 대기 중에도 TUI 다이얼로그가 함께 보인다

설계서(`기능1-승인인박스.md` §6-(a))는 *"훅이 도는 동안 TUI 다이얼로그는 뜨지 않고 스피너만 보인다 →
동시 노출이 없어 경합이 원천적으로 발생하지 않는다"* 고 서술했다. **실측은 반대다.**

훅이 18초 블로킹하는 동안 TUI 에는 선택 대화상자가 **정상 표시**됐다:

```
❯ 1. Apple      You prefer apples.
  2. Banana     You prefer bananas.
  3. Type something.
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

따라서 **로컬(PC 터미널)과 원격(폰)이 동시에 답할 수 있다.** 기능1 구현 시 반드시 처리할 것:

1. 로컬 사용자가 먼저 고르면 → 대기 중인 폰 카드를 회수해야 한다. 이때 훅 프로세스에 무슨 일이
   생기는지(kill 되는지, 그대로 살아 결정이 무시되는지) **미확인** → 기능1 S0 단계에서 실측 필요.
2. 폰이 먼저 응답하면 → TUI 다이얼로그가 스스로 닫히는 것을 실측으로 확인했다(위 §3 결과).
3. 따라서 "먼저 응답한 쪽 승리 + 나머지 회수"를 양방향으로 구현해야 한다(한쪽만으론 부족).

## 6. 부수 관측

- pane_title 이 `✳ Claude Code` 로 유지된다 — 폴백(agent-watch)이 읽는 글리프가 여전히 유효하므로
  훅 미도착 환경의 안전망은 그대로 동작한다.
- SessionStart payload 에 `model` 필드가 있다(설계서 미기재). 진단·표시에 쓸 수 있다.
- `effort: { level }` 은 tool-use 컨텍스트 훅에만 실린다(설계서 기술과 일치).
- 훅 stdin 은 즉시 close 된다 — CLI 의 stdin 읽기 상한을 1500ms → 300ms 로 줄인 변경이 안전함을 확인.
- zsh 에서 tmux 타겟 `=name` 은 **따옴표 필수**(`=` 확장이 경로로 치환됨). 검증 스크립트 작성 시 함정.
