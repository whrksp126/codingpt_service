import * as i18n from '../i18n/index.js';
// 오케스트레이션(묶음·워커·질문·결정) 화면 문구. text/index.js 의 규율을 따른다.
//  앱(codingpt_app/src/text/orch.ts)에 **같은 필드명·같은 원문**의 사전이 있다 — 번역은 i18n 카탈로그 한 벌.
//  값에 문장 조립 금지. 자리표시자는 `{n}` `{name}` 뿐이다.

export const ORCH_TEXT = {
  ko: {
    orchestration: "오케스트레이션",
    coordinator: "코디네이터",
    worker: "워커",
    workersN: "워커 {n}개",
    liveN: "진행 {n}",
    attentionN: "확인 필요 {n}",
    okN: "완료 {n}",
    failedN: "실패 {n}",
    wStarting: "시작하는 중",
    wWorking: "작업 중",
    wAsking: "질문 중",
    wBlocked: "막힘",
    wNeedsInput: "입력 대기",
    wIdleNoReport: "보고 없이 멈춤",
    wExited: "종료됨(보고 없음)",
    wSucceeded: "완료",
    wFailed: "실패",
    wStopped: "멈춤",
    wAbandoned: "포기함",
    wUnknown: "알 수 없음",
    placeCurrent: "같은 폴더",
    placeWorktree: "전용 작업 폴더",
    openTerminal: "터미널 열기",
    openCoordinator: "코디네이터 터미널 열기",
    stop: "멈추기",
    release: "정리",
    releaseMerge: "머지하고 정리",
    retain: "남겨 두기",
    closeRun: "묶음 닫기",
    closeRunForce: "워커를 멈추고 닫기",
    closeRunConfirm: "아직 일하는 워커가 {n}개 있어요. 멈추고 닫을까요?",
    reply: "답하기",
    replyPlaceholder: "워커에게 보낼 답",
    question: "질문",
    decision: "결정이 필요해요",
    result: "결과",
    tasks: "일",
    tPending: "대기",
    tReady: "시작 가능",
    tDispatched: "진행 중",
    tCompleted: "완료",
    tFailed: "실패",
    tBlocked: "막힘",
    noWorkers: "아직 워커가 없어요",
    hostNeedsUpdate: "이 PC 앱을 업데이트해야 볼 수 있어요",
    sent: "보냈어요",
    released: "정리했어요",
    stopped: "멈췄어요",
    closed: "묶음을 닫았어요",
    errGeneric: "문제가 생겼어요. 다시 시도해 주세요",
    errMerge: "머지하지 못했어요. 충돌이 있는지 확인해 주세요",
    errActive: "아직 일하는 워커예요",
    errOffline: "PC 가 연결되어 있지 않아요",
    stTodo: "할 일",
    stInProgress: "진행 중",
    stInReview: "리뷰 중",
    stCompleted: "완료",
    roleWorkerTip: "워커 · {name}",
    roleCoordinatorTip: "코디네이터 · {name}",
  },
};

export function ot(key, vars) {
  const src = ORCH_TEXT.ko[key];
  return i18n.t(src == null ? ORCH_TEXT.ko.errGeneric : src, vars);
}

const ERR = { MERGE_FAILED: "errMerge", DISPATCH_ACTIVE: "errActive", DAEMON_OFFLINE: "errOffline" };
export function orchErrText(code) { return ot(ERR[String(code || "")] || "errGeneric"); }

const WS_STATUS = { todo: "stTodo", "in-progress": "stInProgress", "in-review": "stInReview", completed: "stCompleted" };
export function wsStatusText(status) { return WS_STATUS[status] ? ot(WS_STATUS[status]) : ""; }
