/**
 * approvals — 원격 승인 왕복(기능1)의 **데몬측 정본**.
 *
 * claude 의 PermissionRequest 훅(`cpt approval-hook`)이 cpt.sock 으로 이 모듈에 요청을 걸고
 * 응답까지 블로킹한다. 사용자가 폰/PC 카드에서 누른 결정은 back → control WS rpc(approval.resolve)
 * 로 돌아와 여기서 **단 한 번만** 소비되고, 훅 stdout 계약 JSON 으로 변환돼 claude 를 재개시킨다.
 *
 * 왜 데몬이 정본인가:
 *  · pending 슬롯을 들고 있는 곳이 곧 "결정을 소비하는 곳"이다. back 인메모리 인덱스는 재시작으로
 *    갈라질 수 있지만, 데몬에서 delete 가 먼저 일어나므로 이중 소비가 구조적으로 불가능하다.
 *  · 로컬 TUI 다이얼로그가 훅 대기 중에도 함께 뜬다(실측). 즉 로컬/원격이 동시에 답할 수 있어
 *    "먼저 응답한 쪽 승리"를 한 곳에서 판정해야 한다. 로컬이 먼저 답하면 claude 가 훅을 정리하며
 *    소켓이 끊기고(hook_gone), 폰이 먼저 답하면 TUI 가 스스로 닫힌다(실측).
 *
 * 절대 불변식(위반 시 사용자 신뢰 붕괴):
 *  · 어떤 실패 경로에서도 `allow` 를 만들어내지 않는다. 실패 = `defer`(= 훅 무출력 = 평소처럼 TUI 가 물어봄).
 *  · 킬스위치 CPT_APPROVAL=0 이면 즉시 defer(= 기능 도입 전과 100% 동일 동작).
 *  · 서버 capability(approval.v1) 미선언 = 기능 OFF. 처리 코드 없는 서버에 카드를 던지지 않는다.
 */
const crypto = require('crypto');
const path = require('path');
const configLib = require('./config');
const fsLib = require('./fs'); // safeResolve/relOf — 파일 대상 도구의 경로를 워크스페이스 상대로 접기 위함

const CAP = 'approval.v1';               // 서버 caps 교집합 게이트 키(통합 §2 공통계약)
// 하드 타임아웃 기본 — daemon.json approval.timeoutSec 로 조정.
//  180s 인 이유: 훅이 대기하는 동안에도 PC 터미널에는 다이얼로그가 그대로 떠 있다(실측 확인). 즉 이 시간은
//  "PC 앞의 사용자를 붙잡는 시간"이 아니라 "원격 응답을 기다려주는 여유"일 뿐이라 길게 잡는 비용이 거의 없다.
//  back 의 폰 에스컬레이션(25s) 이후 사용자가 잠금 해제→앱 진입→선택하기에 충분한 여유를 남긴다.
// ★ 원격 응답에는 **마감을 두지 않는다**(2026-07-28 사용자 확정).
//  근거: 에이전트가 물었고 사람이 아직 답하지 않았으면 TUI 다이얼로그는 **무한정** 그대로 떠 있다.
//  같은 질문인데 원격 카드만 9분 만에 사라질 이유가 없다 — '기다리는 중' 이라는 사실은 한쪽에서만
//  참일 수 없다. 예전 180초/540초는 'claude 훅 timeout 상한이 600초' 라는 **잘못된 전제**에서 나왔다.
//  실측(claude 2.1.220 번들): 훅 실행은 `timeout ? timeout*1000 : 600000` 이고 **상한 클램프가 없다**
//  (600초는 기본값일 뿐). 설정 스키마도 `timeout: number().optional()` 로 최대값이 없다.
//
//  안전판은 마감이 아니라 **연결**이다: 훅 프로세스가 죽거나(Esc·Ctrl-C·세션 종료) 데몬이 내려가면
//  소켓이 닫혀 즉시 defer 되고 그때 TUI 다이얼로그가 뜬다. 한 pane 에 3건이 밀리면 그 다음은
//  MAX_PENDING_PER_PANE 가 즉시 defer 시킨다. 즉 '영영 응답 못 하는 상태' 로는 갇히지 않는다.
const DEFAULT_TIMEOUT_SEC = 24 * 3600;
const MIN_TIMEOUT_SEC = 1;               // 하한 1s — 회귀 테스트가 만료 경로를 실제로 통과할 수 있게
const MAX_TIMEOUT_SEC = 24 * 3600;       // 상한은 claude 가 아니라 우리 안전장치일 뿐(24h)
const MAX_PENDING_PER_PANE = 3;          // 같은 (cwd,tid) 동시 대기 상한 — 4번째부터 즉시 defer(폭주 가드)
const PREVIEW_MAX_BYTES = 4 * 1024;      // inputPreview 상한(민감내용·용량)
const DIFF_SIDE_MAX = 16 * 1024;         // diff 한쪽(old/new) 상한 — back 캡(32KB)보다 먼저 데몬이 자른다
const SUMMARY_MAX = 200;
const MESSAGE_MAX = 4000;
const LABEL_MAX = 200;

// 원격 응답임을 사람이 오해하지 않게 하는 고정 접두어. 선택형 도구는 deny.message 로 답이 전달되므로
//  TUI/트랜스크립트에 "Error:" 로 표시된다 — 이 접두어가 그게 실패가 아님을 알리는 유일한 단서다.
const ANSWER_PREFIX = '[CodingPT 원격응답] ';

// 선택형 도구 = "허용/거절"이 아니라 **답을 골라야** 하는 도구. allow 로는 답을 전달할 수 없어
//  deny + message 로 선택 내용을 실어 보낸다(실측: claude 가 도구 결과로 정확히 해석).
const DEFAULT_CHOICE_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
const MASK = '«숨김»';
const SECRET_KEY_RE = /secret|token|password|passwd|credential|api[_-]?key|apikey|authorization|cookie|private[_-]?key|access[_-]?key/i;

// id → slot. slot = { id, cwdRel, tid, meta, createdAt, deadlineAt, advertised, done, resolve, conn, onClose, timer, payload }
const pending = new Map();

// 주입 가능한 외부 의존 — 테스트는 back/control 없이 이 모듈만으로 전 경로를 돈다.
const defaults = {
  // 승인 카드 광고(back). 실패 = 즉시 defer(서버 장애로 에이전트를 세우지 않는다).
  advertise: (payload) => require('./cpt-server').backFetch('POST', '/api/daemon/approvals', payload),
  // 카드 회수(만료·훅 사망·세션 소멸). 실패는 무해(back TTL 스위퍼가 수습).
  retract: (id, reason) => require('./cpt-server').backFetch('POST', `/api/daemon/approvals/${encodeURIComponent(id)}/cancel`, { reason }),
  // 서버가 처리 코드를 가졌는지(hello_ack serverCaps). 구 서버 = false = 기능 OFF.
  capCheck: () => require('./control').hasServerCap(CAP),
  // 폴백 감지(agent-watch)에 훅 생존 신고 — 같은 승인을 title 관찰이 중복 알림하지 않게.
  noteHook: (cwdRel, tid) => require('./agent-watch').noteHook(cwdRel, tid),
  log: (msg) => console.log(`[approval] ${msg}`),
};
let deps = { ...defaults };

function configure(overrides) { deps = { ...deps, ...(overrides || {}) }; }
function log(msg) { try { if (deps.log) deps.log(msg); } catch (_) { /* 로깅 실패는 무해 */ } }

// ── 예산 — 홉별 타임아웃의 단일 출처(shim 이 훅 config timeout 을 여기서 파생한다) ──
//  하드 타임아웃(데몬) < CLI 소켓 대기 < claude 훅 timeout 순서를 반드시 유지한다.
//  이 순서가 깨지면 우리가 아닌 claude 가 먼저 훅을 잘라 "defer 를 우리가 제어"하지 못한다.
function timeoutSec() {
  const envSec = parseInt(process.env.CPT_APPROVAL_TIMEOUT_SEC || '', 10);
  let sec = Number.isFinite(envSec) && envSec > 0 ? envSec : null;
  if (sec == null) {
    const cfg = configLib.load() || {};
    const v = cfg.approval && Number(cfg.approval.timeoutSec);
    if (Number.isFinite(v) && v > 0) sec = v;
  }
  if (sec == null) sec = DEFAULT_TIMEOUT_SEC;
  return Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, Math.round(sec)));
}

function budget() {
  const hardMs = timeoutSec() * 1000;
  return {
    hardMs,
    cliWaitMs: hardMs + 10000,                          // 데몬 defer 가 먼저 도착하는 게 정상 경로
    hookTimeoutSec: Math.ceil((hardMs + 25000) / 1000), // claude 가 마지막에 자른다(최후 안전망)
  };
}

// ── 게이트 — 하나라도 막히면 defer(기존 동작) ──
function gateReason() {
  if (process.env.CPT_APPROVAL === '0') return 'killswitch';
  const cfg = configLib.load() || {};
  const ap = (cfg && cfg.approval) || {};
  if (ap.remote === false) return 'disabled';
  // cap 게이트 — back 이 approval.v1 을 선언하기 전에는 카드를 만들 곳이 없다. S1 로컬 검증용 우회만 허용.
  if (process.env.CPT_APPROVAL_CAP_GATE !== '0') {
    let ok = false;
    try { ok = !!deps.capCheck(); } catch (_) { ok = false; }
    if (!ok) return 'no_server';
  }
  return null;
}

// ── 도구 분류 / 요약 / 마스킹 ──
function choiceTools() {
  const raw = process.env.CPT_APPROVAL_CHOICE_TOOLS;
  if (typeof raw === 'string' && raw.trim()) return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return new Set(DEFAULT_CHOICE_TOOLS);
}

// 선택형 판정 — 명시 목록 + "questions[] 를 들고 오는 도구"(미래 도구 대비 휴리스틱).
function isChoiceTool(toolName, toolInput) {
  if (choiceTools().has(String(toolName || ''))) return true;
  const qs = toolInput && toolInput.questions;
  return Array.isArray(qs) && qs.length > 0 && qs.some((q) => q && Array.isArray(q.options));
}

function clip(v, n) { return v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }

// 민감 키 마스킹 — toolInput 에는 .env 내용·토큰·비밀번호가 실릴 수 있고 이 값은 서버/푸시로 나간다.
function maskDeep(v, depth = 0) {
  if (v == null || depth > 6) return v == null ? v : (typeof v === 'object' ? undefined : v);
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => maskDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 40)) out[k] = SECRET_KEY_RE.test(k) ? MASK : maskDeep(v[k], depth + 1);
    return out;
  }
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…' : v;
  return v;
}

// 값 단위 시크릿 리댁션 — 키 이름이 없는 자유 문자열(주로 Bash 명령)에서 비밀을 지운다.
//  이 값은 서버 DB·FCM/APNs 인프라·잠금화면까지 나가므로, 놓치는 것보다 과하게 지우는 쪽이 낫다.
//  ① KEY=값 / KEY: 값 형태에서 키가 시크릿류면 값을 마스킹
//  ② 알려진 토큰 접두사(sk-, ghp_, xoxb- 등)와 긴 base64/hex 덩어리를 마스킹
//  ③ URL 의 basic-auth 자격증명(user:pass@host)
function redactValues(s) {
  let out = String(s == null ? '' : s);
  if (!out) return out;
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)[A-Za-z0-9_]*)\s*([=:])\s*("[^"]*"|'[^']*'|\S+)/gi,
    (_m, k, sep) => `${k}${sep}${MASK}`);
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abposr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|ya29\.[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/g, MASK);
  out = out.replace(/\b[0-9a-f]{40,}\b/gi, MASK);                       // 긴 hex(토큰·해시)
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`); // URL basic-auth
  return out;
}

// 파일 대상 도구의 경로(워크스페이스 상대) — 푸시 본문이 이걸 우선 쓰면 명령 원문 노출을 피할 수 있다.
function relPathOf(toolInput, cwdRel) {
  const d = toolInput || {};
  const abs = d.file_path || d.path || d.notebook_path;
  if (typeof abs !== 'string' || !abs) return undefined;
  try {
    // 워크스페이스 안이면 상대경로, 밖이면 basename 만(홈 경로 전체를 서버로 흘리지 않는다).
    const rel = fsLib.relOf(fsLib.safeResolve(abs));
    if (rel != null && cwdRel && rel.startsWith(cwdRel + '/')) return rel.slice(cwdRel.length + 1);
    if (rel != null) return rel;
  } catch (_) { /* jail 밖 등 */ }
  return path.basename(abs);
}

// 프리뷰 — 마스킹 후 4KB 캡(초과 시 잘린 표식만 남긴다).
function inputPreviewOf(toolInput) {
  let masked;
  try { masked = maskDeep(toolInput); } catch (_) { return null; }
  let s;
  try { s = JSON.stringify(masked); } catch (_) { return null; }
  if (s == null) return null;
  if (Buffer.byteLength(s, 'utf8') <= PREVIEW_MAX_BYTES) return masked;
  return { _truncated: true, preview: Buffer.from(s, 'utf8').subarray(0, PREVIEW_MAX_BYTES).toString('utf8').replace(/�+$/, '') };
}

// 부가 설명(≤200자) — "요청 상세를 펼치지 않아도 바로 이해되게" 하는 한 줄(2026-07-29).
//  TUI 는 명령 아래에 회색으로 description 을 같이 보여주는데, 우리 카드는 그걸 접힌 JSON 안에만
//  두고 있어서 사용자가 매번 펼쳐야 했다. summary 와 같은 값이면 중복이므로 내보내지 않는다.
function detailOf(tool, input) {
  const d = input || {};
  switch (String(tool)) {
    case 'Bash': return clip(redactValues(d.description), SUMMARY_MAX);
    // 파일 도구는 summary 가 경로다 → 내용/변경의 규모를 한 줄로(무엇이 바뀌는지 감이 오게).
    case 'Write': {
      const body = typeof d.content === 'string' ? d.content : '';
      return body ? clip(`${body.split('\n').length}줄 쓰기`, SUMMARY_MAX) : undefined;
    }
    case 'Edit': {
      const from = typeof d.old_string === 'string' ? d.old_string : '';
      const to = typeof d.new_string === 'string' ? d.new_string : '';
      if (!from && !to) return undefined;
      return clip(`${from.split('\n').length}줄 → ${to.split('\n').length}줄${d.replace_all ? ' (전체 치환)' : ''}`, SUMMARY_MAX);
    }
    case 'MultiEdit': {
      const n = Array.isArray(d.edits) ? d.edits.length : 0;
      return n ? clip(`${n}곳 수정`, SUMMARY_MAX) : undefined;
    }
    case 'WebFetch': return clip(redactValues(d.prompt), SUMMARY_MAX);
    default: return undefined;
  }
}

// 파일 수정 도구의 변경 내용 — 카드의 '변경 내용' 접기가 그린다(back normalizeDiff 계약:
//  {kind, oldContent?, newContent?, truncated?}). "무엇이 쓰이는지 원문을 못 보고 승인"을 없애는 경로라
//  요약(detailOf)과 별개로 **원문**을 싣되, 값 단위 리댁션(redactValues)을 반드시 거친다 —
//  Write 로 .env 를 쓰는 경우 content 에 시크릿 원문이 그대로 있다.
function diffOf(tool, input) {
  const d = input || {};
  let truncated = false;
  const side = (s) => {
    const red = redactValues(String(s));
    if (red.length > DIFF_SIDE_MAX) { truncated = true; return red.slice(0, DIFF_SIDE_MAX); }
    return red;
  };
  switch (String(tool)) {
    case 'Write': {
      if (typeof d.content !== 'string' || !d.content) return undefined;
      const out = { kind: 'write', newContent: side(d.content) };
      if (truncated) out.truncated = true;
      return out;
    }
    case 'Edit': {
      const from = typeof d.old_string === 'string' ? d.old_string : '';
      const to = typeof d.new_string === 'string' ? d.new_string : '';
      if (!from && !to) return undefined;
      const out = { kind: 'edit', oldContent: side(from), newContent: side(to) };
      if (truncated) out.truncated = true;
      return out;
    }
    case 'MultiEdit': {
      const edits = Array.isArray(d.edits) ? d.edits.slice(0, 8) : [];
      if (!edits.length) return undefined;
      const SEP = '\n⋯\n';
      const out = {
        kind: 'multiedit',
        oldContent: side(edits.map((e) => (e && e.old_string) || '').join(SEP)),
        newContent: side(edits.map((e) => (e && e.new_string) || '').join(SEP)),
      };
      if (Array.isArray(d.edits) && d.edits.length > 8) truncated = true;
      if (truncated) out.truncated = true;
      return out;
    }
    case 'NotebookEdit': {
      if (typeof d.new_source !== 'string' || !d.new_source) return undefined;
      const out = { kind: 'notebook', newContent: side(d.new_source) };
      if (truncated) out.truncated = true;
      return out;
    }
    default: return undefined;
  }
}

// 3번째 선택지("허용하고 다음부터 묻지 않기") 재료 — claude 가 준 addRules 제안만 추린다.
//  ⚠ 제안이 없으면 undefined 를 돌려 **선택지 자체를 만들지 않는다**. claude TUI 도 addRules 제안이
//   있을 때만 그 옵션을 띄우므로(바이너리 실측) 이 조건이 TUI 와의 동치성을 만든다. 없는데 만들면
//   "다시 안 묻겠지" 하고 눌렀는데 계속 묻는 신뢰 붕괴가 된다(이 파일의 옛 주석이 경계하던 바로 그것).
function alwaysRuleOf(suggestions) {
  if (!Array.isArray(suggestions)) return undefined;
  const updates = suggestions.filter((s) => s && s.type === 'addRules' && Array.isArray(s.rules) && s.rules.length);
  if (!updates.length) return undefined;
  const flat = updates.flatMap((u) => u.rules).filter((r) => r && typeof r.ruleContent === 'string' && r.ruleContent);
  if (!flat.length) return undefined;
  // 라벨 = TUI 와 같은 문구를 만들 재료. 규칙이 하나면 그 내용을 그대로 보여준다.
  const label = flat.length === 1 ? flat[0].ruleContent : `규칙 ${flat.length}개`;
  return { label: clip(redactValues(label), SUMMARY_MAX), updates };
}

// 1줄 요약(≤200자) — 카드 제목/푸시 본문 재료. 도구별로 사람이 읽을 핵심만.
function summaryOf(tool, input) {
  const d = input || {};
  switch (String(tool)) {
    // ⚠ Bash 명령 원문은 그대로 FCM/APNs 본문·notification.body 컬럼·잠금화면 배너로 나간다.
    //  maskDeep 은 **키 이름** 기준이라 `export API_KEY=sk-…` 같은 문자열엔 걸리지 않는다 → 값 단위 리댁션 필수.
    case 'Bash': return clip(redactValues(d.command), SUMMARY_MAX);
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'Read':
      return clip(d.file_path || d.path || d.notebook_path, SUMMARY_MAX);
    case 'AskUserQuestion': {
      const q = Array.isArray(d.questions) ? d.questions[0] : null;
      return clip(q && (q.question || q.header), SUMMARY_MAX);
    }
    case 'ExitPlanMode': return clip(d.plan, SUMMARY_MAX) || '계획 승인 요청';
    case 'WebFetch': return clip(d.url, SUMMARY_MAX);
    default: {
      try { return clip(JSON.stringify(maskDeep(d)), SUMMARY_MAX); } catch (_) { return ''; }
    }
  }
}

// 선택지 구조 — 폰이 네이티브 선택 버튼을 그리는 재료(실측: tool_input 에 전부 온다 → 재구성 불필요).
function questionsOf(toolInput) {
  const qs = toolInput && toolInput.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  return qs.slice(0, 5).map((q) => ({
    question: clip(q && q.question, 500),
    header: clip(q && q.header, 60),
    multiSelect: !!(q && q.multiSelect),
    options: Array.isArray(q && q.options)
      ? q.options.slice(0, 12).map((o) => ({ label: clip(o && o.label, LABEL_MAX), description: clip(o && o.description, 300) }))
      : [],
  }));
}

// ── 훅 stdout 계약 조립 ─────────────────────────────────────────────────────
//  · 권한형(Bash/Write/…)     → { behavior:'allow' } | { behavior:'deny', message }
//  · 선택형(AskUserQuestion/ExitPlanMode) → 항상 { behavior:'deny', message:'[CodingPT 원격응답] …' }
//    (allow 로는 "무엇을 골랐는지"를 전달할 수 없다. deny.message 가 도구 결과로 전달된다 — 실측)
//  · defer/canceled           → null(= 훅 무출력 = TUI 폴백). 어떤 오류 경로도 allow 를 만들지 않는다.
function buildHookOutput(meta, outcome) {
  const decision = outcome && outcome.decision;
  if (decision !== 'allow' && decision !== 'deny') return null;
  const m = meta || {};
  if (m.choice) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: composeAnswerMessage(m, outcome) },
      },
    };
  }
  if (decision === 'allow') {
    // "허용하고 다음부터 묻지 않기" — claude 가 이 요청에 대해 제안한 addRules 를 **그대로** 되돌린다.
    //  실측(2026-07-29, claude 2.1.220): destination 이 localSettings 면 프로젝트의
    //  .claude/settings.local.json 에 "Bash(ls:*)" 형태로 실제 기록되고, session 이면 그 세션에만 산다.
    //  destination 은 claude 가 정해서 보낸 값을 유지한다(우리가 범위를 넓히지 않는다 = 과대 허용 방지).
    //  ⚠ codex 는 updatedPermissions 가 예약 필드라 **넣는 순간 fail-closed**(2026-07-29 바이너리 실측:
    //   "PermissionRequest hook returned unsupported updatedPermissions") — claude 외에는 절대 싣지 않는다.
    const updates = (m.agent || 'claude') === 'claude'
      && outcome.always && Array.isArray(m.alwaysUpdates) && m.alwaysUpdates.length
      ? { updatedPermissions: m.alwaysUpdates } : {};
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...updates } } };
  }
  const why = clip(outcome.message, 500);
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: ANSWER_PREFIX + (why ? `사용자가 원격 기기에서 거절했습니다: ${why}` : '사용자가 원격 기기에서 거절했습니다.') },
    },
  };
}

// 선택형 응답 문구 조립 — 사용자가 고른 label(multiSelect 면 복수) 또는 자유 입력 텍스트.
function composeAnswerMessage(meta, outcome) {
  const msg = clip(outcome.message, MESSAGE_MAX);
  if (outcome.decision === 'deny') {
    return ANSWER_PREFIX + (msg
      ? `사용자가 원격 기기에서 이 요청을 거절했습니다: ${msg}`
      : '사용자가 원격 기기에서 이 요청을 거절했습니다.');
  }
  const answers = normalizeAnswers(outcome.answers);
  if (answers.length) {
    const head = ANSWER_PREFIX + '사용자가 원격 기기에서 다음과 같이 답했습니다.';
    const lines = answers.map((a) => {
      const label = a.header || a.question || '답';
      const value = a.labels.length ? a.labels.join(', ') : a.text;
      return `- ${label}: ${value}`;
    });
    return clip0([head, ...lines].join('\n'), MESSAGE_MAX);
  }
  if (msg) return clip0(`${ANSWER_PREFIX}사용자가 원격 기기에서 다음과 같이 답했습니다.\n${msg}`, MESSAGE_MAX);
  if (String(meta.tool) === 'ExitPlanMode') return ANSWER_PREFIX + '사용자가 원격 기기에서 계획을 승인했습니다. 계획대로 진행하세요.';
  return ANSWER_PREFIX + '사용자가 원격 기기에서 승인했습니다. 계속 진행하세요.';
}

// 여러 줄을 살리는 clip(개행 보존 — 선택 목록의 가독성).
function clip0(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').slice(0, n); }

// 응답 정규화 — 문자열(라벨 하나) / {labels|label|text} 객체 모두 수용.
function normalizeAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  const out = [];
  for (const a of answers.slice(0, 5)) {
    if (a == null) continue;
    if (typeof a === 'string') { const s = clip(a, LABEL_MAX); if (s) out.push({ header: '', question: '', labels: [s], text: '' }); continue; }
    const labels = []
      .concat(Array.isArray(a.labels) ? a.labels : [], a.label != null ? [a.label] : [])
      .map((l) => clip(l, LABEL_MAX)).filter(Boolean).slice(0, 12);
    const text = clip(a.text, LABEL_MAX * 4);
    if (!labels.length && !text) continue;
    out.push({ header: clip(a.header, 60), question: clip(a.question, 300), labels, text });
  }
  return out;
}

// ── pending 슬롯 관리 ──
function paneCount(cwdRel, tid) {
  let n = 0;
  for (const s of pending.values()) if (s.cwdRel === cwdRel && s.tid === tid) n++;
  return n;
}

function deferNow(reason, t0, meta) {
  log(`defer(${reason})`);
  return { approvalId: null, decision: 'defer', reason, message: null, by: null, answers: null, hookOutput: null, waitedMs: Date.now() - t0, choice: !!(meta && meta.choice) };
}

/**
 * 훅 요청 등록 + 결정까지 대기(핵심 진입점 — cpt-server 의 `approval.request` 가 호출).
 *
 * @param {object} args     CLI 가 보낸 훅 페이로드(정규화 전 raw 필드 허용)
 * @param {object} resolved cpt-server resolveCtx() 결과 { cwdRel, windowIndex, ... }
 * @param {object} [conn]   요청 소켓 — close/error = 훅 프로세스 사망 → 즉시 취소(무한 대기 방지)
 * @returns {Promise<{decision:'allow'|'deny'|'defer', hookOutput:object|null, …}>} 절대 reject 하지 않는다
 */
function request(args, resolved, conn) {
  const t0 = Date.now();
  const a = args || {};
  const r = resolved || {};
  const toolName = String(a.toolName || a.tool_name || '');
  const toolInput = (a.toolInput || a.tool_input || {}) || {};
  // 에이전트 구분 — codex 도 같은 왕복을 탄다(2026-07-29 실측: codex 0.145 의 PermissionRequest 훅은
  //  입력이 claude 와 동형(tool_name:"Bash"/tool_input.command)이고 출력 계약도 같은 hookSpecificOutput).
  //  단 codex 는 permission_suggestions 를 주지 않고 updatedPermissions 는 예약 필드(넣으면 fail-closed)라
  //  "다음부터 묻지 않기"가 없다 — alwaysRule 이 자연히 비어 카드도 2버튼이 된다.
  const agent = String(a.agent || 'claude');
  const alwaysRule = agent === 'claude'
    ? alwaysRuleOf(a.permissionSuggestions || a.permission_suggestions) : undefined;
  const meta = {
    tool: toolName,
    agent,
    choice: isChoiceTool(toolName, toolInput),
    sessionId: a.sessionId || a.session_id || null,
    toolUseId: a.toolUseId || a.tool_use_id || null,
    // 사용자가 3번째 선택지를 고르면 이 값을 그대로 decision.updatedPermissions 로 되돌린다.
    //  ⚠ 서버/클라이언트가 보낸 값을 쓰지 않는다 — claude 가 준 제안만 돌려줘야 과대 허용이 안 생긴다.
    alwaysUpdates: alwaysRule ? alwaysRule.updates : null,
  };

  const off = gateReason();
  if (off) return Promise.resolve(deferNow(off, t0, meta));

  const cwdRel = typeof r.cwdRel === 'string' ? r.cwdRel : '';
  const tid = Number.isInteger(r.windowIndex) ? r.windowIndex : null;
  // 폭주 가드 — 파일 20개 Edit 처럼 한 턴이 승인을 쏟아내면 알림/푸시가 폭주한다. 초과분은 터미널에서 답한다.
  if (paneCount(cwdRel, tid) >= MAX_PENDING_PER_PANE) return Promise.resolve(deferNow('flood', t0, meta));
  // 이미 끊긴 소켓(훅 프로세스 사망) — 카드를 만들지 않는다.
  if (conn && (conn.destroyed === true || conn.writable === false)) return Promise.resolve(deferNow('hook_gone', t0, meta));

  const id = 'apr_' + crypto.randomUUID();
  const { hardMs } = budget();
  const deadlineAt = t0 + hardMs;
  const payload = {
    id,
    agent,
    hookEventName: 'PermissionRequest',
    sessionId: meta.sessionId,
    promptId: a.promptId || a.prompt_id || null,
    toolUseId: meta.toolUseId,
    tool: toolName,
    kind: meta.choice ? 'choice' : 'permission',
    summary: summaryOf(toolName, toolInput),
    // 카드가 접기 없이 그릴 부가 설명(Bash description 등) + 3번째 선택지 라벨. 둘 다 없으면 미전송.
    detail: detailOf(toolName, toolInput),
    alwaysLabel: alwaysRule ? alwaysRule.label : undefined,
    // 파일 수정 도구의 변경 원문(리댁션·캡 적용) — 카드 '변경 내용' 접기의 재료.
    diff: diffOf(toolName, toolInput),
    inputPreview: inputPreviewOf(toolInput),
    questions: questionsOf(toolInput),
    // back 의 화이트리스트(normalizeCreate)가 통과시키는 정규화 프롬프트. 최상위 questions 는
    //  통과하지 않으므로 이걸 안 채우면 클라이언트가 선택 UI 를 그릴 근거가 사라져 inputPreview
    //  파싱 폴백으로 굳어버린다. plan 은 ExitPlanMode 본문(계획 승인 화면에 그대로 표시).
    prompt: {
      kind: meta.choice ? 'choice' : 'permission',
      questions: questionsOf(toolInput) || undefined,
      plan: toolName === 'ExitPlanMode' ? clip0(toolInput && toolInput.plan, 8000) || undefined : undefined,
    },
    // 파일 대상 도구는 경로를 별도로 — back 의 푸시 본문이 summary 대신 이걸 우선 쓰므로
    //  잠금화면에 Bash 명령 원문 대신 파일명이 보인다(프라이버시).
    relPath: relPathOf(toolInput, cwdRel),
    permissionMode: a.permissionMode || a.permission_mode || null,
    transcriptPath: a.transcriptPath || a.transcript_path || null,
    cwd: cwdRel || undefined,
    wsName: cwdRel ? path.basename(cwdRel) : undefined,
    win: tid != null ? tid : undefined,
    requestedAt: t0,
    deadlineAt,
    waitMs: hardMs,
  };

  // 폴백 감지 침묵(훅 생존 신고) — hook.event 와 동일 규율.
  try { deps.noteHook(cwdRel, tid); } catch (_) { /* noop */ }

  return new Promise((resolvePromise) => {
    const slot = {
      id, cwdRel, tid, meta, payload,
      createdAt: t0, deadlineAt,
      advertised: false, done: false,
      resolve: resolvePromise,
      conn: conn || null, onClose: null, timer: null,
    };
    pending.set(id, slot);

    // ① 소켓 close/error = 훅 프로세스 사망(claude Esc·세션 kill·로컬 TUI 응답 후 훅 정리) → 즉시 취소.
    if (conn && typeof conn.on === 'function') {
      slot.onClose = () => { settle(id, { decision: 'defer', reason: 'hook_gone' }); };
      conn.on('close', slot.onClose);
      conn.on('error', slot.onClose);
    }
    // ② 하드 타임아웃 — 로컬이 먼저 답했는데 훅 프로세스가 살아있는 경우까지 덮는 두 번째 방어선.
    //  unref 하지 않는다 — 대기 중 승인은 훅 프로세스를 붙잡고 있는 상태이므로 이 타이머가 살아 있어야
    //  "만료 → 카드 회수 → TUI 폴백"이 반드시 일어난다(unref 하면 이벤트 루프가 비는 순간 유실된다).
    slot.timer = setTimeout(() => { settle(id, { decision: 'defer', reason: 'timeout' }); }, hardMs);

    // ③ back 광고 — 실패는 곧 defer(서버 장애로 에이전트를 세우지 않는다).
    Promise.resolve()
      .then(() => deps.advertise(payload))
      .then((res) => {
        if (!pending.has(id)) {
          // 광고 왕복 중에 이미 해소(훅 사망 등) → 방금 만들어진 카드를 회수한다.
          retractRemote(id, 'hook_gone');
          return;
        }
        slot.advertised = true;
        // back 이 유저당 pending 상한을 넘겼다고 알리면 즉시 defer(터미널에서 처리).
        if (res && (res.defer === true || (res.data && res.data.defer === true))) {
          settle(id, { decision: 'defer', reason: 'server_defer' }, { retract: false });
          return;
        }
        // 훅 대기 중 TUI 가 같은 다이얼로그를 그리고 있다(기실측) — 화면을 파싱해 카드 내용을
        //  TUI 원문으로 갱신한다(멱등 재광고 = back 이 내용 갱신 후 pending 재팬아웃).
        if (!meta.choice) scheduleScreenEnrich(slot);
        log(`대기 시작 ${id} tool=${toolName || '?'} ws=${cwdRel || '-'} tid=${tid != null ? tid : '-'} ${Math.round(hardMs / 1000)}s`);
      })
      .catch((e) => {
        log(`광고 실패 — defer: ${(e && e.message) || e}`);
        settle(id, { decision: 'defer', reason: 'advertise_failed' }, { retract: false });
      });
  });
}

// ── 훅 카드 화면 보강(2026-07-29 사용자 확정: "TUI 에 나오는 건 다 채팅에도") ──────
// 훅 대기 중 TUI 가 그린 다이얼로그를 파싱해 payload.prompt.screen 에 **TUI 원문**(제목/본문/질문
//  줄/선택지 문구 + 옵션별 입력 가능 표식)을 싣고 재광고한다. 도구별 문구 템플릿을 흉내내지
//  않는다 — 버전이 바뀌면 같이 틀린다. 화면이 정본이다.
//  안전장치: 파싱된 다이얼로그가 **이 승인의 것**인지 summary(명령/URL 원문) 조각으로 검증하고,
//  선택지 라벨이 전부 응답 어휘(allow/always/deny)로 짝지어질 때만 싣는다.
const ENRICH_TRY_MS = [1200, 3000]; // TUI 가 다이얼로그를 그리는 지연 흡수(2회 시도)
function scheduleScreenEnrich(slot) {
  if (!Number.isInteger(slot.tid)) return;
  for (const ms of ENRICH_TRY_MS) {
    const t = setTimeout(() => {
      enrichFromScreen(slot).catch(() => { /* 보강 실패 = 기존 카드 유지(무해) */ });
    }, ms);
    if (t.unref) t.unref(); // 보강은 보조 — 이벤트 루프를 붙잡지 않는다
  }
}

async function enrichFromScreen(slot) {
  if (slot.done || !pending.has(slot.id)) return;
  if (slot.payload.prompt && slot.payload.prompt.screen) return; // 이미 보강됨
  const parsed = await require('./cpt-server').captureDialog({ cwd: slot.cwdRel, tid: slot.tid });
  if (!parsed) return;
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const frag = norm(slot.payload.summary).slice(0, 40);
  if (frag && !norm(parsed.question.question + parsed.title).includes(frag)) return; // 다른 요청의 다이얼로그
  const options = (parsed.question.options || []).map((o, i) => ({
    n: (parsed.options[i] || {}).n || i + 1,
    label: o.label,
    act: screenActOf(o.label),
    ...(o.input ? { input: true } : {}),
  }));
  if (options.length < 2 || options.some((o) => !o.act)) return; // 응답 어휘로 못 짝지으면 보류
  slot.payload.prompt = {
    ...(slot.payload.prompt || {}),
    screen: {
      title: parsed.title,
      body: parsed.question.question,     // 본문(줄 구조 보존 — 명령/설명 줄)
      ask: parsed.question.ask,           // 질문 줄("Do you want to …?") — 카드가 다른 스타일로 구분해 그린다
      askFirst: !!parsed.question.askFirst, // 화면에서 질문 줄이 본문보다 먼저 오는 배치(codex)
      flow: parsed.flow,
      expect: parsed.expect,
      options,
    },
  };
  if (slot.done || !pending.has(slot.id)) return;
  await deps.advertise(slot.payload);   // 멱등 재광고 — back 이 내용 갱신 + pending 재팬아웃
  log(`카드 화면 보강 ${slot.id} (${parsed.title}, 옵션 ${options.length}개)`);
}

// 화면 선택지 라벨 → 훅 응답 어휘. 못 알아보면 null(보강 보류 — 카드가 거짓말하면 안 된다).
function screenActOf(label) {
  const l = String(label || '');
  if (/^Yes, and (don.?t ask again|always allow)/i.test(l)) return 'always';
  if (/^Yes\b/i.test(l)) return 'allow';
  if (/^No\b/i.test(l)) return 'deny';
  return null;
}

/**
 * TUI 폴백 질문 재광고 — **훅 없이** 등록되는 슬롯(question-revive 리컨실러가 호출).
 *
 * 왜 필요한가(2026-07-28 사용자 확정): 데몬 재시작(PC 앱 업데이트)이 대기 승인을 전부 취소하면
 *  폰 배너까지 회수되는데, 질문 자체는 TUI 다이얼로그로 살아 있다. 사용자 관점에선 "답 안 한
 *  질문이 있는데 알림이 소리소문없이 사라진" 상태 → 미응답 질문을 다시 광고해 배너를 되살린다.
 *
 * 훅 슬롯과의 차이:
 *  · resolve 대기자가 없다(promise 소비자 없음) — 응답은 `tuiDrive`(다이얼로그 키 조작)로 전달된다.
 *  · id 가 결정적(cwd|tid|toolUseId 해시) — 리컨실러가 몇 번을 돌아도, back 재광고가 겹쳐도 1건이다.
 *  · 응답 전달이 실패하면(다이얼로그 소멸 등) 슬롯을 **유지**한다 — 폰 카드가 남아 재시도할 수 있고,
 *    다이얼로그가 정말 사라졌다면 리컨실러가 다음 틱에 cancelTui 로 회수한다.
 */
function requestTui({ cwdRel, tid, sessionId, toolUseId, questions, drive, tool, summary, dedupeKey, revKind }) {
  if (gateReason()) return null;
  const cwd = typeof cwdRel === 'string' ? cwdRel : '';
  if (!Number.isInteger(tid) || !Array.isArray(questions) || !questions.length || typeof drive !== 'function') return null;
  // dedupeKey: 권한 다이얼로그 재광고처럼 toolUseId 가 없는 슬롯의 결정적 id 재료(다이얼로그 내용 해시).
  //  내용이 바뀌면 id 도 바뀌어, 리컨실러가 옛 슬롯을 걷고 새로 광고한다.
  const id = 'aprt_' + crypto.createHash('sha256')
    .update([cwd, tid, dedupeKey || toolUseId || sessionId || ''].join('|')).digest('hex').slice(0, 24);
  if (pending.has(id)) return id;                                  // 이미 광고됨(멱등)
  if (paneCount(cwd, tid) >= MAX_PENDING_PER_PANE) return null;    // 훅 승인이 이미 차 있으면 양보
  const t0 = Date.now();
  const { hardMs } = budget();
  const deadlineAt = t0 + hardMs;
  const qs = questions.slice(0, 8);
  const toolName = tool || 'AskUserQuestion';
  const payload = {
    id, agent: 'claude', hookEventName: 'PermissionRequest',
    sessionId: sessionId || null, promptId: null, toolUseId: toolUseId || null,
    tool: toolName, kind: 'choice',
    summary: clip(summary, SUMMARY_MAX) || (qs[0] && (qs[0].question || qs[0].header)) || `질문 ${qs.length}개`,
    inputPreview: null, questions: qs,
    // mirror = TUI 권한 다이얼로그의 화면 미러(2026-07-29). 클라이언트는 이 표식이 있으면 질문 카드
    //  부속(기타/건너뛰기/보내기) 없이 **선택지만, 누르면 즉시 전송**으로 그린다 — TUI 의 숫자키
    //  한 번과 동일한 상호작용(TUI 에 없는 것은 카드에도 없다).
    prompt: { kind: 'choice', questions: qs, ...(revKind === 'perm' ? { mirror: true } : {}) },
    relPath: null, permissionMode: null, transcriptPath: null,
    cwd: cwd || undefined, wsName: cwd ? path.basename(cwd) : undefined,
    win: tid, requestedAt: t0, deadlineAt, waitMs: hardMs,
  };
  const slot = {
    id, cwdRel: cwd, tid,
    meta: {
      tool: toolName, choice: true, sessionId: sessionId || null, toolUseId: toolUseId || null,
      questions: qs, dedupeKey: dedupeKey || null, revKind: revKind || 'question',
    },
    payload, createdAt: t0, deadlineAt, advertised: false, done: false,
    resolve: () => { /* 훅 대기자 없음 */ }, conn: null, onClose: null, timer: null,
    tuiDrive: drive,
  };
  pending.set(id, slot);
  slot.timer = setTimeout(() => { settle(id, { decision: 'defer', reason: 'timeout' }); }, hardMs);
  Promise.resolve()
    .then(() => deps.advertise(payload))
    .then((res) => {
      if (!pending.has(id)) { retractRemote(id, 'canceled'); return; }
      slot.advertised = true;
      if (res && (res.defer === true || (res.data && res.data.defer === true))) {
        settle(id, { decision: 'defer', reason: 'server_defer' }, { retract: false });
        return;
      }
      log(`TUI 질문 재광고 ${id} ws=${cwd || '-'} tid=${tid} 질문 ${qs.length}개`);
    })
    .catch((e) => {
      log(`TUI 재광고 실패: ${(e && e.message) || e}`);
      settle(id, { decision: 'defer', reason: 'advertise_failed' }, { retract: false });
    });
  return id;
}

/** 이 터미널의 TUI 재광고 슬롯(있으면). 리컨실러가 "다이얼로그 소멸 → 회수" 판정에 쓴다. */
function tuiSlotFor(cwdRel, tid) {
  for (const s of pending.values()) {
    if (s.tuiDrive && s.cwdRel === (cwdRel || '') && s.tid === tid) return s;
  }
  return null;
}

/** 모든 TUI 재광고 슬롯 — 리컨실러의 틱 끝 화해("화면에 없으면 카드도 없다")용. */
function tuiSlots() {
  return [...pending.values()].filter((s) => s.tuiDrive);
}

/** TUI 재광고 회수 — 다이얼로그가 사라졌다(로컬에서 답함/세션 종료). retract=true 로 배너까지 걷는다. */
function cancelTui(id, reason = 'dialog_gone') {
  return settle(id, { decision: 'defer', reason });
}

/** 훅 대기 중인 선택형(AskUserQuestion 계열) 슬롯 — 리컨실러의 화면 화해용.
 *  실사고(2026-07-30): TUI 다이얼로그에서 직접 답하면 claude 가 (Bash 승인의 hook_gone 실측과
 *  달리) PermissionRequest 훅을 정리하지 않는다 — 훅 프로세스가 waitMs(24h) 내내 살아 있어
 *  hook_gone 이 영영 안 오고, 카드가 전 기기에 유령으로 남는다. 그래서 이 슬롯들도 TUI 재광고
 *  슬롯과 같은 "화면이 정본" 화해가 필요하다(question-revive 가 소비). */
function hookChoiceSlots() {
  return [...pending.values()]
    .filter((s) => !s.tuiDrive && s.meta && s.meta.choice)
    .map((s) => ({ id: s.id, cwdRel: s.cwdRel, tid: s.tid, createdAt: s.createdAt }));
}

/** 훅 선택형 슬롯 회수 — 질문 다이얼로그가 화면에서 사라졌다(로컬에서 답함/Esc).
 *  훅 대기자는 무출력 defer 로 풀린다 — 다이얼로그가 이미 처리됐으므로 claude 는 훅 출력을 무시한다. */
function cancelHookChoice(id, reason = 'dialog_gone') {
  return settle(id, { decision: 'defer', reason });
}

// 단일 소비 지점 — pending.delete 를 **먼저** 한다. 두 번째 응답은 여기서 false 로 튕긴다.
function settle(id, outcome, { retract = true } = {}) {
  const slot = pending.get(id);
  if (!slot) return false;
  pending.delete(id);
  slot.done = true;
  if (slot.timer) clearTimeout(slot.timer);
  if (slot.conn && slot.onClose) {
    try { slot.conn.removeListener('close', slot.onClose); } catch (_) { /* noop */ }
    try { slot.conn.removeListener('error', slot.onClose); } catch (_) { /* noop */ }
  }
  const result = {
    approvalId: id,
    decision: outcome.decision,
    reason: outcome.reason || null,
    message: outcome.message != null ? clip0(outcome.message, MESSAGE_MAX) : null,
    answers: normalizeAnswers(outcome.answers),
    by: outcome.by || null,
    choice: !!slot.meta.choice,
    waitedMs: Date.now() - slot.createdAt,
    hookOutput: buildHookOutput(slot.meta, outcome),
  };
  // 데몬이 스스로 끝낸 경우(만료·훅 사망·세션 소멸)만 카드를 회수한다 — back 발신 resolve 는 back 이 이미 안다.
  if (retract && slot.advertised) retractRemote(id, result.reason || result.decision);
  log(`해소 ${id} → ${result.decision}${result.reason ? `(${result.reason})` : ''} ${result.waitedMs}ms`);
  slot.resolve(result);
  // 훅이 죽거나 마감돼 defer 로 끝났다 = claude 가 곧(1~2초) TUI 다이얼로그를 띄운다 →
  //  미러 리컨실러를 즉시 당겨 채팅 카드가 주기(4s)를 기다리지 않게 한다(채팅=TUI 원칙).
  if (result.decision === 'defer' && (result.reason === 'hook_gone' || result.reason === 'timeout')) {
    try { require('./question-revive').pokeSoon(); } catch (_) { /* 리컨실러 미기동 — 무해 */ }
  }
  return true;
}

function retractRemote(id, reason) {
  try {
    const p = deps.retract(id, String(reason || 'canceled'));
    if (p && typeof p.catch === 'function') p.catch(() => { /* back TTL 스위퍼가 수습 */ });
  } catch (_) { /* noop */ }
}

// ── back → 데몬 RPC(control.js 의 rpc 디스패치가 위임) ──
async function handle(method, params) {
  const p = params || {};
  switch (String(method)) {
    case 'approval.resolve': return resolveRemote(p);
    case 'approval.list': return { approvals: list() };
    case 'approval.cancel': {
      const ok = settle(String(p.id || ''), { decision: 'defer', reason: String(p.reason || 'canceled') }, { retract: false });
      if (!ok) throw notPending();
      return { canceled: true };
    }
    default: throw new Error(`알 수 없는 승인 메서드: ${method}`);
  }
}

function resolveRemote(p) {
  const id = String(p.id || '');
  if (!id) throw Object.assign(new Error('승인 id 가 필요합니다'), { code: 'BAD_REQUEST' });
  const raw = String(p.decision || '');
  // back 이 보내는 결정 어휘는 3종이다: allow | deny | **answer**(선택형에서 사용자가 항목을 골랐다).
  //  'answer' 를 defer 로 접으면 폰은 200 을 받아 "답했다"고 믿는데 훅은 무출력으로 끝나 PC 터미널이
  //  다시 묻는다 — AskUserQuestion/ExitPlanMode 전량, 즉 원격 승인의 절반이 조용히 죽는다.
  //  선택형의 실제 훅 출력은 buildHookOutput 이 meta.choice 로 deny+message 를 만들므로 여기서는
  //  'allow'(=결정됨) 로 승격하는 것이 맞다.
  //  그 외 값('canceled' = 만료/철회 통보 등)은 절대 결정으로 승격하지 않는다.
  const decision = (raw === 'allow' || raw === 'answer') ? 'allow' : raw === 'deny' ? 'deny' : 'defer';
  const reason = decision === 'defer' ? (raw || 'canceled') : null;
  // back 은 단수 `answer`(={questionIndex,labels,text}) 로 보내고, 로컬/테스트 경로는 복수 `answers` 를 쓴다.
  //  둘 다 수용하고, questionIndex 로 원 질문의 header/question 을 채운다 — 안 채우면 claude 가 받는
  //  메시지가 "- 답: Banana" 가 되어 어느 질문에 대한 답인지 알 수 없다(질문이 여러 개면 특히).
  const answers = hydrateAnswers(
    Array.isArray(p.answers) ? p.answers : (p.answer ? [p.answer] : null),
    pending.get(id),
  );
  // ── TUI 재광고 슬롯 — 훅이 없으므로 응답을 **다이얼로그 조작**으로 전달한 뒤에야 해소한다. ──
  //  순서가 생명이다: settle 을 먼저 하면 back 이 폰에 200 을 주는데 조작이 실패하면(다이얼로그가
  //  그새 사라짐 등) 답이 조용히 증발한다. 실패는 throw → back 이 오류로 회신 → 폰 카드가 남아
  //  재시도한다(다이얼로그가 정말 사라졌다면 리컨실러가 다음 틱에 회수한다).
  // "허용하고 다음부터 묻지 않기" — allow 일 때만 의미가 있다. 실제로 되돌릴 규칙은 요청 시점에
  //  claude 가 준 제안(meta.alwaysUpdates)이고, 여기서는 "사용자가 그걸 원했다"는 사실만 전달한다.
  //  TUI 재광고(훅 없는) 슬롯에는 규칙을 세울 경로가 없으므로 무시된다(카드도 그 선택지를 안 띄운다).
  const always = decision === 'allow' && !!p.always;
  const slot = pending.get(id);
  if (slot && slot.tuiDrive && decision !== 'defer') {
    return Promise.resolve(slot.tuiDrive({ decision, answers }))
      .then(() => {
        const ok = settle(id, { decision, reason, message: p.message, answers, always, by: p.by }, { retract: false });
        if (!ok) throw notPending();
        return { resolved: true, id, decision };
      });
  }
  // ── 화면 보강된 훅 카드 — **TUI 다이얼로그 조작을 우선**한다(2026-07-29). ──
  //  이유: 카드가 TUI 선택지 문구 그대로를 보여주므로 응답도 TUI 자신이 처리하는 게 정확하다 —
  //  특히 "don't ask again" 은 TUI 가 직접 규칙을 기록해 **codex 도 완전 동작**한다(훅 출력의
  //  updatedPermissions 는 codex 에서 fail-closed). 로컬에서 다이얼로그가 답해지면 에이전트가 훅을
  //  정리하므로(hook_gone 기실측) 훅 출력 없이 defer 로 해소해도 이중 응답이 없다.
  //  조작 실패(다이얼로그 소멸/불일치)면 기존 훅 출력 경로로 폴백한다.
  const scr = slot && !slot.tuiDrive && decision !== 'defer'
    && slot.payload && slot.payload.prompt && slot.payload.prompt.screen ? slot.payload.prompt.screen : null;
  const hookPathResolve = () => {
    const ok = settle(id, { decision, reason, message: p.message, answers, always, by: p.by }, { retract: false });
    if (!ok) throw notPending();
    if (decision === 'allow' && p.message && String(p.message).trim()
      && slot && !slot.meta.choice && (slot.meta.agent || 'claude') === 'claude'
      && Number.isInteger(slot.tid)) {
      try {
        const inj = require('./cpt-server').composerInject({ cwd: slot.cwdRel, tid: slot.tid, text: p.message });
        if (inj && typeof inj.catch === 'function') inj.catch((e) => log(`허용+지시 주입 실패(무해 — 지시만 유실): ${(e && e.message) || e}`));
      } catch (e) { log(`허용+지시 주입 실패(무해 — 지시만 유실): ${(e && e.message) || e}`); }
    }
    return { resolved: true, id, decision };
  };
  if (scr) {
    const wantAct = decision === 'deny' ? 'deny' : always ? 'always' : 'allow';
    const opt = (scr.options || []).find((o) => o && o.act === wantAct);
    if (opt) {
      const text = opt.input && p.message && String(p.message).trim() ? String(p.message).trim() : null;
      return Promise.resolve(require('./cpt-server').permissionAnswer({
        cwd: slot.cwdRel, tid: slot.tid, pick: opt.n, expect: scr.expect, text, flow: scr.flow,
      }))
        .then(() => {
          // 훅 무출력 defer — TUI 가 이미 답을 처리했다. 에이전트가 훅을 곧 정리한다(hook_gone).
          const ok = settle(id, { decision: 'defer', reason: 'tui_driven' }, { retract: false });
          if (!ok) throw notPending();
          return { resolved: true, id, decision };
        })
        .catch((e) => {
          if (e && e.code === 'ALREADY_RESOLVED') throw e;
          log(`화면 조작 실패(${(e && e.code) || (e && e.message) || e}) — 훅 출력 경로로 폴백`);
          return hookPathResolve();
        });
    }
  }
  // 훅 출력 경로(비보강 카드/보강 조작 실패 폴백) — "허용+추가 지시"(claude)는 TUI 의
  //  "Yes, and tell Claude what to do next" 동치로 허용 직후 컴포저에 지시를 주입한다(훅 allow
  //  출력엔 메시지 채널이 없다). 거절+메시지는 hookOutput 의 deny.message 로 전달된다(양 에이전트).
  return hookPathResolve();
}

// 응답에 원 질문의 라벨을 채운다 — back 은 대역폭을 아끼려 questionIndex 만 보낸다.
function hydrateAnswers(answers, slot) {
  if (!Array.isArray(answers) || !answers.length) return answers;
  const questions = (slot && slot.meta && Array.isArray(slot.meta.questions)) ? slot.meta.questions
    : (slot && slot.payload && slot.payload.prompt && Array.isArray(slot.payload.prompt.questions)) ? slot.payload.prompt.questions
      : (slot && slot.payload && Array.isArray(slot.payload.questions)) ? slot.payload.questions : [];
  return answers.map((a) => {
    if (!a || typeof a !== 'object') return a;
    if (a.header || a.question) return a; // 이미 채워져 있으면 그대로(로컬 경로)
    const q = questions[Number.isInteger(a.questionIndex) ? a.questionIndex : 0];
    if (!q) return a;
    return { ...a, header: q.header || '', question: q.question || '' };
  });
}

function notPending() {
  // back 인덱스와 갈라졌거나 두 기기가 동시에 눌렀다 — 클라는 이 코드로 카드를 즉시 철수한다.
  return Object.assign(new Error('이미 해소된 승인 요청입니다'), { code: 'ALREADY_RESOLVED' });
}

function list() {
  return [...pending.values()].map((s) => ({ ...s.payload, advertised: s.advertised }));
}

/** back 재접속 시 pending 재광고(back 재시작으로 인덱스가 비었을 때 카드를 되살린다 — 같은 id = 멱등). */
async function resync() {
  const slots = [...pending.values()];
  let resynced = 0;
  let failed = 0;
  for (const s of slots) {
    if (!pending.has(s.id)) continue;               // 재광고 도중 해소됨
    try { await deps.advertise(s.payload); s.advertised = true; resynced++; } catch (_) { failed++; }
  }
  if (slots.length) log(`재광고 ${resynced}/${slots.length}건${failed ? ` (실패 ${failed})` : ''}`);
  return { resynced, failed, total: slots.length };
}

/** 세션 소멸(claude 종료·터미널 삭제) → 그 세션의 대기 전부 취소. */
function cancelBySession(sessionId, reason = 'session_gone') {
  const sid = String(sessionId || '');
  if (!sid) return 0;
  let n = 0;
  for (const s of [...pending.values()]) {
    if (String(s.meta.sessionId || '') !== sid) continue;
    if (settle(s.id, { decision: 'defer', reason })) n++;
  }
  return n;
}

/** 데몬 종료/인수 직전 정리 — 전부 defer(훅은 TUI 로 폴백, auto-allow 0). */
function cancelAll(reason = 'daemon_gone') {
  let n = 0;
  for (const s of [...pending.values()]) if (settle(s.id, { decision: 'defer', reason })) n++;
  return n;
}

/** agent-watch/agent-state 가 "승인 대기"를 title 글리프보다 정확히 판정하는 재료. */
function hasPending(cwdRel, tid) { return paneCount(typeof cwdRel === 'string' ? cwdRel : '', Number.isInteger(tid) ? tid : null) > 0; }
function pendingCount() { return pending.size; }

// 테스트 전용 — 슬롯/주입 초기화(대기 중 Promise 는 defer 로 종결).
function _reset() {
  for (const s of [...pending.values()]) settle(s.id, { decision: 'defer', reason: 'reset' }, { retract: false });
  pending.clear();
  deps = { ...defaults };
}

module.exports = {
  request, handle, resync, list,
  requestTui, tuiSlotFor, tuiSlots, cancelTui, // TUI 폴백 재광고(question-revive)
  hookChoiceSlots, cancelHookChoice, // 훅 선택형 슬롯의 화면 화해(question-revive)
  cancelBySession, cancelAll, hasPending, pendingCount,
  buildHookOutput, budget, timeoutSec, configure, diffOf,
  gateReason, // 기능 게이팅의 단일 출처 — cpt-server/PC 설정이 "왜 꺼졌는지" 물을 때 쓴다(null=켜짐)
  CAP, ANSWER_PREFIX, MAX_PENDING_PER_PANE,
  _reset, _settle: settle,
  _screenActOf: screenActOf, _enrichFromScreen: enrichFromScreen,
  _slot: (id) => pending.get(id),
};
