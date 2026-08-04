// 팔레트·단축키 설정의 화면 문구. text/index.js 의 규율을 따른다.
//  ⚠ 앱(codingpt_app/src/text/palette.ts)에 같은 키·같은 뜻의 사전이 있다(대조 테스트).
//
// `cmd` 는 commands.js 의 id 와 **키 집합이 정확히 같아야 한다** — 표에 명령을 더하고 문구를
//  안 넣으면 팔레트에 빈 줄이 생긴다(대조 테스트가 이것도 잡는다).

export const PALETTE_TEXT = {
  ko: {
    open: "명령 팔레트",
    placeholder: "파일 이름을 치거나, > 로 명령을 찾으세요",
    placeholderCommand: "명령 검색",
    empty: "찾는 것이 없어요",
    emptyFiles: "이 워크스페이스에 맞는 파일이 없어요",
    loading: "파일 목록을 읽는 중…",
    truncated: "파일이 많아 일부만 검색했어요",
    needWorkspace: "워크스페이스를 먼저 열어 주세요",
    hintCommand: "> 를 치면 명령",
    secOpenTabs: "열린 탭",
    secFiles: "파일",
    secCommands: "명령",
    secQuickCommands: "저장한 명령",
    unavailable: "지금은 쓸 수 없어요",

    // 명령 묶음 이름
    group: {
      open: "열기",
      add: "추가",
      run: "실행",
      pane: "영역",
      view: "보기",
      settings: "설정",
      goto: "이동",
    },

    // 명령 이름 — commands.js 의 id 와 같은 키
    cmd: {
      "palette.open": "명령 팔레트 열기",
      "find.open": "현재 영역에서 찾기",
      "ws.addTerminal": "터미널 추가",
      "ws.addIde": "IDE 추가",
      "ws.addPreview": "웹뷰 추가",
      "ws.addEmulator": "모바일 화면 추가",
      "ws.quickCommands": "저장한 명령 실행",
      "ws.ports": "열린 포트 보기",
      "pane.splitRight": "오른쪽으로 나누기",
      "pane.splitDown": "아래로 나누기",
      "pane.close": "현재 영역 닫기",
      "pane.focusLeft": "왼쪽 영역으로",
      "pane.focusRight": "오른쪽 영역으로",
      "pane.focusUp": "위쪽 영역으로",
      "pane.focusDown": "아래쪽 영역으로",
      "sidebar.toggle": "사이드바 접기/펼치기",
      "notif.panel": "알림 열기",
      "notif.latestUnread": "최근 알림으로 이동",
      "app.settings": "설정 열기",
      "settings.commands": "저장한 명령 관리",
      "settings.shortcuts": "단축키 설정",
      "ws.select1": "1번 워크스페이스로",
      "ws.select2": "2번 워크스페이스로",
      "ws.select3": "3번 워크스페이스로",
      "ws.select4": "4번 워크스페이스로",
      "ws.select5": "5번 워크스페이스로",
      "ws.select6": "6번 워크스페이스로",
      "ws.select7": "7번 워크스페이스로",
      "ws.select8": "8번 워크스페이스로",
    },

    // 단축키 설정
    sc: {
      title: "단축키",
      note: "행을 누르고 새 조합을 누르면 바뀌어요. 되돌리려면 기본값으로를 누르세요.",
      recording: "새 조합을 누르세요…",
      recordingHint: "Esc 로 취소 · Backspace 로 지우기",
      none: "없음",
      reset: "기본값으로",
      resetAll: "전부 기본값으로",
      conflict: "겹침",
      conflictNote: "같은 조합이 두 곳에 걸리면 하나는 동작하지 않아요.",
      search: "단축키 검색",
      modHint: "Mod = macOS 는 ⌘, 그 외는 Ctrl",
      modHintApp: "Mod = ⌘ (안드로이드는 Meta·검색 키) — Ctrl·Alt 조합은 터미널이 받습니다",
      unassigned: "단축키 없음",
      unbind: "지우기",
    },
  },

};
