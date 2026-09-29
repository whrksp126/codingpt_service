import * as i18n from '../i18n/index.js';
// 자동화 번들(한 줄 지시 · PR 후속 · 자동화 · PC 깨어 있기)의 화면 문구. text/index.js 의 규율을 따른다.
//  ⚠ 원문 정본 = codingpt_daemon/docs/automation-design.md §11. 앱(codingpt_app/src/text/automations.ts)에
//   **같은 필드명·같은 원문**의 사전이 있다 — 번역은 i18n 카탈로그(master.json → 직접 삽입) 한 벌이 갖는다.
//  · 값에 문장 조립 금지. 자리표시자는 `{n} {d} {name} {t} {agent} {cron} {tz} {branch} {repo} {labels} {event} {id}` 뿐이다.
//  · 원문을 바꾸려면 §11 표를 먼저 고친다(§13 변경 규칙).

export const AUTO_TEXT = {
  ko: {
    automations: "자동화",
    autoTitle: "자동화 · {name}",
    autoEmpty: "아직 자동화가 없어요",
    autoEmptyHint: "한 줄 지시에서 '매일 …' 처럼 말하거나, 에이전트에게 부탁하면 만들어져요",
    pauseAll: "전체 일시정지",
    autoPausedAll: "모든 자동화가 일시정지돼 있어요",
    groupActive: "활성",
    groupPaused: "일시정지됨",
    runNow: "지금 실행",
    pause: "일시정지",
    resume: "재개",
    deleteAuto: "삭제",
    deleteAutoConfirm: "이 자동화를 삭제할까요? 만든 작업은 남아요",
    rename: "이름 변경",
    madeByAgent: "{agent} 가 만듦",
    madeByDispatch: "한 줄 지시로 만듦",
    madeByUser: "직접 만듦",
    nextRun: "다음 실행 {t}",
    noNextRun: "예정 없음",
    lastOk: "마지막: 성공 · {t}",
    lastFailed: "마지막: 실패 · {t}",
    lastCreatedTasks: "작업 {n}개 생성",
    runsToday: "오늘 {n}/{d}회",
    trigSchedule: "{cron} ({tz})",
    trigOnce: "{t} 한 번",
    trigCommits: "새 커밋 · {branch}",
    trigIssues: "새 이슈 · {labels}",
    trigCi: "검사 실패",
    trigReviews: "리뷰 코멘트",
    trigTaskEvent: "작업 이벤트 · {event}",
    actTaskCreate: "작업 만들기",
    actPrompt: "에이전트에게 지시",
    actNotify: "알림 보내기",
    stepN: "{n}단계",
    guards: "제한",
    auditLog: "실행 기록",
    autoBadge: "자동",
    pausedByError: "연속 실패로 일시정지됨",
    pausedByLimit: "하루 실행 상한에 도달했어요",
    pausedByServer: "서버에서 자동화가 꺼져 있어요",
    errAutoDisabled: "이 PC 에서는 자동화를 쓸 수 없어요",
    errAutoNotFound: "자동화를 찾을 수 없어요",
    errAutoLimit: "자동화 개수 상한을 넘었어요",
    errAutoLoop: "자동화가 만든 작업에서는 자동화를 만들 수 없어요",
    errAutoDepth: "자동화 연쇄가 너무 깊어요",
    errAutoBad: "자동화 정의가 올바르지 않아요",
    errAutoBusy: "실행 중이라 바꿀 수 없어요",
    dispatch: "한 줄 지시",
    dispatchPlaceholder: "무엇을 어디에 시킬까요?",
    plan: "계획",
    planning: "계획 중 · {agent}",
    collecting: "PC 정보 수집 중 ({n}/{d})",
    replan: "다시 계획",
    planSummary: "요약",
    planTasks: "작업",
    planAutomations: "자동화",
    planQuestions: "확인이 필요해요",
    simpleMatch: "간단 매칭",
    fallbackNoAgent: "로그인된 에이전트 CLI 가 없어 이름으로 골랐어요",
    fallbackTimeout: "계획이 늦어져 이름으로 골랐어요",
    fallbackFailed: "계획에 실패해 이름으로 골랐어요",
    catalogFailed: "{name} 정보를 가져오지 못했어요",
    pickRepo: "저장소를 골라 주세요",
    include: "포함",
    why: "이유",
    keepAwake: "PC 깨어 있기",
    keepAwakeWork: "작업 중에는 잠자기 방지",
    keepAwakeWorkDesc: "에이전트가 작업하는 동안 PC 가 잠들지 않아요",
    lidClosed: "덮개를 닫아도 계속 작업",
    lidClosedDesc: "관리자 암호로 1회 설정이 필요해요",
    setUp: "설정하기",
    setUpDone: "설정됨",
    removeSetup: "해제",
    setupPending: "PC 화면의 암호 창을 확인하세요",
    setupRemoteHint: "암호 입력 창은 그 PC 화면에 떠요. PC 앞에서 진행하세요",
    setupCancelled: "설정이 취소됐어요",
    setupFailed: "설정에 실패했어요",
    awakeNow: "깨어 있음",
    awakeStatus: "지금: 깨어 있음 · 작업 {n}개",
    asleepAllowed: "지금: 잠자기 허용",
    onBattery: "배터리 전원에서는 덮개 닫힘 유지가 꺼져요",
    powerCaveat: "덮개를 닫은 채 계속 실행하면 발열이 늘고 배터리가 빨리 닳아요. 전원 어댑터를 연결하고 통풍이 되는 곳에 두세요",
    powerUnsupported: "이 PC 에서는 지원되지 않아요",
    pcSettings: "PC 설정",
  },
};

/** 필드명 → 지금 언어의 문구. 모르는 필드는 null(호출부가 고른다 — text/tasks.js tt 가 여기로 떨어진다). */
export function autoSrc(key) {
  const v = AUTO_TEXT.ko[key];
  return v == null ? null : v;
}

/** 필드명 → 지금 언어의 문구(자리표시자 치환 포함). 모르는 필드는 필드명 그대로(개발 중 누락이 눈에 띄게). */
export function at(key, vars) {
  const src = AUTO_TEXT.ko[key];
  return i18n.t(src == null ? String(key) : src, vars);
}
