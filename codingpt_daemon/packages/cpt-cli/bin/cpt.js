#!/usr/bin/env node
/**
 * cpt — CodingPT 컨트롤 CLI (cmux CLI 의 CodingPT 판)
 *
 * 터미널(tmux -L codingpt) 안에서 실행되는 AI(claude/codex)나 사용자가 서비스 전체를 조작한다.
 * 데몬의 로컬 유닉스 소켓(<stateDir>/cpt.sock)으로 NDJSON one-shot 요청을 보낸다.
 *
 * 자기 좌표: TMUX_PANE 으로 tmux 에 자기 세션/window 를 조회(ctx.tmux)하고, 워크스페이스는
 * CPT_WS env(풀 세션 환경으로 주입) → tmux show-environment → 프로세스 CWD 순으로 해석한다.
 *
 * 의존성 0(순수 node) — 셸 shim 이 어디서든 exec 할 수 있게 가볍게 유지한다.
 */
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TMUX_SOCKET = 'codingpt';

// ── 인자 파서(선언적 미니멀) — --flag value / --flag / 위치 인자 ──
function parseArgv(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

// ── tmux 자기조회 — 이 CLI 가 어느 세션/window 에서 실행됐는지 ──
function findTmuxBin() {
  const candidates = [];
  if (process.env.CPT_TMUX) candidates.push(process.env.CPT_TMUX);
  if (process.env.CODINGPT_TMUX) candidates.push(process.env.CODINGPT_TMUX);
  try {
    const p = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
    if (p) candidates.push(p);
  } catch (_) { /* noop */ }
  candidates.push('/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux');
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) { /* noop */ } }
  return null;
}

// env 패스트패스 — 데몬이 터미널 세션에 CPT_TID/CPT_TSESSION(안정 ID + 세션명 전체)을 주입한다.
//  둘 다 있으면 tmux display-message 서브프로세스를 통째로 생략한다: 훅은 한 턴에 여러 번(최대 7종)
//  실행되므로 매번 tmux 를 띄우는 비용이 그대로 claude 의 체감 지연이 된다. 세션명이 전용 세션
//  규칙("<ns>--t-<tid>")과 일치할 때만 채택 — 어긋나면 데몬 resolveCtx 의 레거시 분기가 windowId 를
//  필요로 하므로 기존 조회 경로로 폴백한다(구 세션/마이그레이션 중 호환).
function tmuxSelfFromEnv() {
  const tid = parseInt(process.env.CPT_TID || '', 10);
  const session = process.env.CPT_TSESSION || '';
  if (!Number.isFinite(tid) || tid <= 0 || !session) return null;
  const m = /^(.*)--t-(\d+)$/.exec(session);
  if (!m || parseInt(m[2], 10) !== tid) return null;
  return { session, windowIndex: tid };
}

function tmuxSelf() {
  const fast = tmuxSelfFromEnv();
  if (fast) return fast;
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  const bin = findTmuxBin();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', pane,
      '#{session_name}\t#{window_id}\t#{window_index}\t#{pane_id}'], { encoding: 'utf8', timeout: 3000 }).trim();
    const [session, windowId, windowIndex, paneId] = out.split('\t');
    return { session, windowId, windowIndex: parseInt(windowIndex, 10), pane: paneId };
  } catch (_) { return null; }
}

// 워크스페이스(cwdRel) — env → tmux 세션 환경 → 세션명 역산 불가 시 null(데몬이 CWD 로 해석).
function resolveWs(tmuxInfo) {
  if (process.env.CPT_WS != null) return process.env.CPT_WS;
  if (tmuxInfo && tmuxInfo.session) {
    const bin = findTmuxBin();
    if (bin) {
      try {
        // 전용 세션(--t-<id>)엔 세션 자체에 CPT_WS 가 주입돼 있어 그대로 조회 가능. 레거시 뷰
        //  세션(--p-)만 풀 세션명으로 역산한다.
        const pool = tmuxInfo.session.includes('--p-') ? tmuxInfo.session.split('--p-')[0] : tmuxInfo.session;
        const out = execFileSync(bin, ['-L', TMUX_SOCKET, 'show-environment', '-t', '=' + pool, 'CPT_WS'],
          { encoding: 'utf8', timeout: 3000 }).trim();
        const m = /^CPT_WS=(.*)$/.exec(out);
        if (m) return m[1];
      } catch (_) { /* noop */ }
    }
  }
  return null;
}

function sockPath() {
  if (process.env.CPT_SOCK) return process.env.CPT_SOCK;
  return path.join(os.homedir(), '.codingpt', 'cpt.sock');
}

// 소켓 요청(one-shot) — 응답 한 줄 수신 후 종료.
// 전역 --on <기기> — 화면 조작/브라우저 명령을 지정 기기로 라우팅(미지정=활성 기기). run() 에서 채움.
let GLOBAL_ON = null;

function request(cmd, args, { timeoutMs = 65000 } = {}) {
  return new Promise((resolve, reject) => {
    const tmuxInfo = tmuxSelf();
    const ctx = {
      cwd: process.cwd(),
      ws: resolveWs(tmuxInfo),
      tmux: tmuxInfo || undefined,
    };
    // --on 은 ui.*/browser.* 계열에만 의미 있음(기기 타겟팅) — 데몬 dispatch 가 args.on 으로 해석.
    if (GLOBAL_ON && (cmd.startsWith('ui.') || cmd.startsWith('browser.'))) {
      args = { ...(args || {}), on: GLOBAL_ON };
    }
    const sock = sockPath();
    const conn = net.createConnection(sock);
    let buf = '';
    // settled 가드 — 아래 close 핸들러가 정상 응답 후의 종료를 오류로 오해하지 않게(그리고 승인 경로에서
    //  "응답 전 소켓 끊김"을 타임아웃까지 기다리지 않고 즉시 알리게) 한다.
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      try { conn.destroy(); } catch (_) { /* noop */ }
      done(reject, new Error('데몬 응답 시간 초과'));
    }, timeoutMs);
    conn.on('connect', () => {
      conn.write(JSON.stringify({ id: 'c' + Date.now(), cmd, args, ctx }) + '\n');
    });
    conn.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        const res = JSON.parse(buf.slice(0, i));
        if (res.ok) done(resolve, res.result);
        else done(reject, Object.assign(new Error(res.error || '실패'), { code: res.code }));
      } catch (e) { done(reject, e); }
      try { conn.end(); } catch (_) { /* noop */ }
    });
    conn.on('error', (e) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        done(reject, new Error(`CodingPT 데몬에 연결할 수 없습니다 (${sock}) — 데몬/데스크톱 앱이 실행 중인지 확인하세요.`));
      } else done(reject, e);
    });
    // 응답 없이 닫힘(데몬 재시작·인수·크래시) — 타이머까지 매달리면 승인 훅이 그만큼 claude 를 세운다.
    conn.on('close', () => {
      done(reject, Object.assign(new Error('데몬 연결이 응답 전에 끊겼습니다'), { code: 'DAEMON_GONE' }));
    });
  });
}

function printJson(v) { process.stdout.write(JSON.stringify(v, null, 2) + '\n'); }

function out(v, flags, human) {
  if (flags.json || human == null) printJson(v);
  else process.stdout.write(human + '\n');
}

// ChatMsg(정규화 트랜스크립트 메시지) 1건 → 사람이 읽는 한 줄(+본문). --json 이면 원본이 나간다.
//  seq 를 항상 앞에 찍는다 — `cpt transcript --since <seq>` 로 이어 읽을 때 그 값이 필요하다.
function renderChatMsg(m) {
  const role = { user: '사용자', assistant: '에이전트', system: '시스템' }[m.role] || m.role || '?';
  const head = `[${m.seq}] ${role}/${m.kind}${m.hidden ? ' (접힘)' : ''}`;
  if (m.kind === 'tool_use' && m.tool) {
    return `${head} ${m.tool.title || m.tool.name}${m.tool.path ? ` — ${m.tool.path}` : ''}`
      + `${m.tool.argsPreview ? `\n    ${String(m.tool.argsPreview).replace(/\n/g, '\n    ')}` : ''}`;
  }
  if (m.kind === 'tool_result' && m.result) {
    return `${head} ${m.result.ok ? 'ok' : '실패'} ${m.result.bytes != null ? `${m.result.bytes}B` : ''}`
      + `${m.result.preview ? `\n    ${String(m.result.preview).replace(/\n/g, '\n    ')}` : ''}`;
  }
  if (m.kind === 'question' && m.question) {
    const opts = (m.question.options || []).map((o) => `- ${o.label}`).join('\n    ');
    return `${head} ${m.question.header || ''} ${m.question.question || ''}${opts ? `\n    ${opts}` : ''}`;
  }
  const text = m.text ? String(m.text) : '';
  return `${head}${text ? `\n    ${text.replace(/\n/g, '\n    ')}${m.truncated ? ' …(잘림)' : ''}` : ''}`;
}

const HELP = `cpt - CodingPT 를 유닉스 소켓으로 조작 (터미널 안의 AI/사용자용)

사용법: cpt [--json] <command> [args]

컨텍스트:
  CodingPT 터미널에서 실행하면 자기 워크스페이스/터미널을 자동 인지한다(CPT_WS/TMUX_PANE).
  터미널 인덱스를 받는 명령은 생략 시 "자기 자신"이 대상이다.

명령:
  identify                              내 좌표(워크스페이스/터미널) 확인
  devices                               접속 중인 화면(기기) 목록 (● = 지금 활성 기기)
  capabilities                          지원 명령 목록
  ping
  agent status                          이 워크스페이스 에이전트 상태(● 작업중 ○ 유휴 ✋ 승인대기)
  hooks doctor                          훅 배선 진단(상태·알림이 안 올 때 원인 확인)
  agents [rescan]                       이 PC 의 AI CLI 목록(● 연동 ○ 연동꺼짐 · 미설치)

  # 터미널 (전 기기 공유 풀)
  terminal list                         터미널 목록(이름/실행 중 명령)
  terminal new [--name <이름>]          새 터미널 생성(전 기기에 나타남)
  terminal close [<idx>]                터미널 삭제(전 기기)
  terminal rename <이름> [--index <n>]  터미널 이름 변경
  terminal wait [<idx>] [--for idle|permission|any] [--timeout-sec <n>=600]
                                        다른 터미널의 에이전트가 유휴/승인대기 될 때까지 대기(자기 자신은 --force)
  read-screen [<idx>] [--lines <n>]     터미널 화면/스크롤백 읽기
  send [<idx>] <text> [--enter]         터미널에 텍스트 입력(자기 자신은 --force)
  send-key [<idx>] <key>                특수키 입력 (C-c, Enter, Up ...)

  # 워크스페이스
  ws list                               워크스페이스 목록
  ws new <이름> [--parent <경로>]       새 워크스페이스 생성(git init)
  ws clone <git-url> [--name <이름>]    GitHub 레포 클론
  ws delete <id>                        워크스페이스를 목록에서 삭제(로컬 폴더/파일은 유지)
  ws select <id>                        전 기기에서 이 워크스페이스로 전환

  # 화면 배치 (사용자가 보고 있는 활성 기기에 반영 — --on <기기> 로 특정 기기 지정)
  layout tree                           현재 레이아웃 트리(활성 기기 기준)
  layout split <left|right|up|down> [--type terminal|preview|ide] [--url <u>] [--path <p>]
  layout focus <paneId>                 pane 포커스
  layout close <paneId>                 pane/surface 닫기
  preview open <url|:port>              프리뷰 열기(새 pane)
  preview navigate <url>                활성 프리뷰 이동
  preview reload                        활성 프리뷰 새로고침
  preview close                         프리뷰 닫기
  preview devtools [on|off]             개발자도구 토글(보고 있는 기기)
  preview info                          현재 URL/제목/뷰포트
  preview inspect [--off]               요소 선택(디자인) 모드 시작 — 사용자가 화면에서 클릭하면
                                        [디자인] 소스위치+크롭샷 줄이 터미널에 삽입됨(--off=취소)
  preview handoff --to <기기>           현재 프리뷰를 다른 기기로 이어주기(세션·쿠키·localStorage 포함)
  ide open <파일경로> [--line <n>]      IDE 로 파일 열기(해당 줄로 이동)
  ide diff <파일경로> [--staged]        git diff 를 IDE 에 읽기 전용 문서로 표시(변경 없으면 "변경 없음")
  ide open-changed [--mode edit|diff|both] [--staged] [--max <n>=10]
                                        변경된 파일 일괄 열기(기본 diff)
  ide close                             IDE pane 닫기
  ide close-file <파일경로>             열린 파일 탭 하나 닫기
  ide list                              지금 열린 파일 목록

  # 브라우저 자동화 (프리뷰 페이지 — 한 기기에서 실행해 결과 회신)
  browser snapshot                      인터랙티브 요소 트리(ref 포함)
  browser click <ref|selector>          또는 좌표: browser click --x <n> --y <n>
  browser scroll [--dy <n>] [--dx <n>] [--x <n>] [--y <n>] [<ref|selector>]
  browser press <key> [--target <sel>] [--mod ctrl,shift] [--text <t>]  (Enter/Escape/Tab/Arrow*/문자)
  browser type <ref|selector> <text>
  browser fill <ref|selector> <value>
  browser eval <js>
  browser wait [--selector <css>] [--text <t>] [--timeout-ms <ms>]
  browser get <url|title|text|html> [--selector <css>]
  browser screenshot [--out <path>]     캡처(--out 없으면 ~/.codingpt/tmp/shot-<ts>.jpg 저장)
  browser console [--limit <n>=100] [--level error|warn|info|log] [--pattern <regex>] [--clear]
                                        프리뷰 웹뷰 콘솔 로그 조회(--clear 는 버퍼 비움)
  browser network [--limit <n>=50] [--pattern <url정규식>] [--status 4xx|5xx|err|<숫자>] [--clear]
                                        프리뷰 웹뷰 네트워크 요청 조회(fetch/XHR — --clear 는 버퍼 비움)

  # 알림/상태 (전 기기 동기화)
  notify --title <t> [--subtitle <s>] [--body <b>]
  notifications [--limit <n>]           알림 목록
  notifications read-all                모두 읽음
  set-status <key> <value> [--icon <i>] [--color <#hex>]
  clear-status [<key>]
  set-progress <0.0-1.0> [--label <text>]
  clear-progress
  log [--level info|warn|error] <message>
  status                                이 워크스페이스의 상태/로그 보기

  # 원격 승인 / 대화 로그 (조회 전용 — 승인 응답과 프롬프트 입력은 앱/PC 화면에서 한다)
  approval list                         지금 원격 응답을 기다리는 승인 요청 목록
  transcript [--since <seq>] [--limit <n>=40] [--session <id>]
                                        이 터미널 에이전트의 대화 로그 읽기(--since = 그 seq 이후만)
  transcript sessions                   이 워크스페이스의 대화 세션 목록(● = 진행 중)

  # 스킬 가이드 (AI 용 전체 사용법 — 이 CLI 로 무엇을 할 수 있는지)
  skills get cpt-cli                    버전 일치 전체 가이드 출력(태스크 중심)

옵션: --json (원본 JSON 출력), --on <기기> (화면 조작/브라우저를 특정 기기로 — 이름 부분일치·#id·pc/mobile),
      --sid <표면id> (특정 프리뷰/IDE 대상 지정)

환경: CPT_WS(워크스페이스), CPT_SOCK(소켓 경로), CPT_TID/CPT_TSESSION(터미널 좌표 — 있으면 tmux 조회 생략), TMUX_PANE(자동)
      CPT_APPROVAL=0 (원격 승인 끄기 — 승인은 항상 이 PC 터미널에서만 답한다)
`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags, pos } = parseArgv(argv);
  const [c1, c2, ...rest] = pos;

  if (!c1 || c1 === 'help' || flags.help) { process.stdout.write(HELP); return; }

  // 전역 --on <기기> — 이후 ui.*/browser.* 요청에 자동 동봉(기기 타겟팅).
  GLOBAL_ON = typeof flags.on === 'string' ? flags.on : null;

  // 위치 인자에서 "터미널 인덱스(숫자)" 선택적 소비.
  const takeIdx = (arr) => (arr.length && /^\d+$/.test(arr[0]) ? { index: parseInt(arr.shift(), 10) } : {});

  const run = async () => {
    switch (c1) {
      case 'ping': return out(await request('ping', {}), flags, 'pong');
      case 'capabilities': return printJson(await request('capabilities', {}));
      // 에이전트 상태 — 이 워크스페이스 터미널들이 지금 무엇을 하고 있나(훅 1차 / 관찰 폴백).
      case 'agent': {
        if (c2 === 'status') {
          const r = await request('agent.status', {});
          const arr = (r && r.terminals) || [];
          const GLYPH = { working: '●', idle: '○', permission: '✋', needsInput: '?', ended: '×', launching: '·' };
          return out(r, flags, arr.map((t) =>
            `${GLYPH[t.state] || '?'} [${t.tid}] ${t.state}${t.hookGoverned ? '' : ' (관찰 폴백)'}`
            + `${t.agent ? ` ${t.agent}` : ''}${t.summary ? ` — ${String(t.summary).split('\n')[0].slice(0, 60)}` : ''}`
          ).join('\n') || '(에이전트 없음)');
        }
        process.stderr.write('사용법: cpt agent status\n');
        process.exitCode = 2;
        return;
      }
      // 훅 배선 진단 — "상태/알림이 안 온다" 의 원인(PATH 경쟁·구버전 shim·비활성)을 판별한다.
      case 'hooks': {
        if (c2 === 'doctor') {
          const r = await request('hooks.doctor', {});
          const lines = [
            `훅 설정: ${r.hooksFile}`,
            `등록 이벤트(${(r.hookEvents || []).length}): ${(r.hookEvents || []).join(', ') || '(없음)'}`,
            `claude 래퍼: ${r.wrapper && r.wrapper.exists ? '있음' : '없음'}${r.wrapper && r.wrapper.injectsSettings ? ' (--settings 주입)' : ' (주입 안 함)'}`,
            `훅 비활성(CPT_HOOKS_DISABLED): ${r.hooksDisabled ? '예' : '아니오'}`,
            '',
            '터미널:',
            ...(r.terminals || []).map((t) =>
              `  [${t.tid}] ${t.state} v${t.version} src=${t.source}`
              + ` 훅=${t.lastHookAt ? `${Math.round(t.hookAgeMs / 1000)}초 전` : '미도착'}`
              + `${t.hookGoverned ? ' (훅 지배)' : ''}`),
            '',
            r.ok ? '✓ 문제 없음' : '문제:',
            ...(r.problems || []).map((p) => `  · ${p}`),
          ];
          return out(r, flags, lines.join('\n'));
        }
        process.stderr.write('사용법: cpt hooks doctor\n');
        process.exitCode = 2;
        return;
      }
      case 'agents': {
        // 이 PC 에 설치된 AI 코딩 CLI 목록. 등급을 정직하게 찍는다(배선되는 것과 실행만 되는 것 구분).
        //  배선 토글(agents.wire)은 일부러 CLI 에 없다 — 터미널 안의 AI 가 자기 승인 훅을 스스로
        //  끄는 경로가 되기 때문(설정 화면에서 사람이 한다).
        const r = await request('agents.list', { refresh: c2 === 'rescan' });
        const TIER = { full: '완전 연동', partial: '알림만', launch: '실행 전용' };
        const lines = (r.agents || []).map((a) => {
          const mark = a.installed ? (a.wired ? '●' : '○') : '·';
          const tail = a.installed
            ? `${a.version ? 'v' + a.version + ' ' : ''}${TIER[a.tier] || a.tier}${a.wirable && !a.wired ? ' (연동 꺼짐)' : ''}`
            : '미설치';
          return `${mark} ${a.name} (${a.bin}) — ${tail}`;
        });
        return out(r, flags, lines.join('\n') || '(카탈로그 비어 있음)');
      }
      case 'devices': {
        // 접속 중인 화면(기기) 목록 — --on <기기> 타겟 지정 재료. ● = 지금 활성(executor).
        const r = await request('ui.devices', {});
        const arr = (r && r.devices) || [];
        return out(r, flags, arr.map((d) =>
          `${d.executor ? '●' : '○'} ${d.deviceName || '(이름없음)'} (${d.kind}${d.foreground ? '' : ', bg'})${d.deviceId != null ? ` [#${d.deviceId}]` : ''}`
        ).join('\n') || '(접속된 화면 없음)');
      }
      case 'identify': {
        const r = await request('identify', {});
        return out(r, flags, `workspace: ${r.ws || '(홈)'}\nterminal: ${r.windowIndex != null ? r.windowIndex : '-'} (${r.windowId || '-'})\nrunner: ${r.runner}`);
      }

      case 'terminal': {
        if (c2 === 'list') {
          const r = await request('terminal.list', {});
          const lines = (r.windows || []).map((w) => `${w.index}\t${w.name}${w.command && !/^(zsh|bash|sh|fish)$/.test(w.command) ? ' · ' + w.command : ''}`);
          return out(r, flags, lines.join('\n') || '(터미널 없음)');
        }
        if (c2 === 'new') {
          const r = await request('terminal.new', { name: flags.name });
          return out(r, flags, `터미널 ${r.index} 생성됨 (${r.name})`);
        }
        if (c2 === 'close') {
          const a = takeIdx(rest);
          const r = await request('terminal.close', a);
          return out(r, flags, 'ok');
        }
        if (c2 === 'rename') {
          const a = takeIdx(rest);
          const name = rest.join(' ');
          const r = await request('terminal.rename', { ...a, index: flags.index != null ? parseInt(flags.index, 10) : a.index, name });
          return out(r, flags, `터미널 ${r.index} → "${r.name}"`);
        }
        if (c2 === 'wait') {
          // 다른 터미널 에이전트가 idle/permission 이 될 때까지 대기 — 데몬이 폴링, CLI 는 그만큼 길게 기다린다.
          const a = takeIdx(rest);
          const timeoutSec = flags['timeout-sec'] ? parseInt(flags['timeout-sec'], 10) : 600;
          const r = await request('terminal.wait', { ...a, for: flags.for, timeoutSec, force: !!flags.force },
            { timeoutMs: (timeoutSec + 15) * 1000 });
          return out(r, flags, r.timeout ? `타임아웃 (state=${r.state})` : `${r.state} (${(r.waitedMs / 1000).toFixed(1)}s 대기)`);
        }
        break;
      }
      case 'read-screen': {
        const arr = [c2, ...rest].filter((v) => v !== undefined);
        const a = takeIdx(arr);
        const r = await request('terminal.read', { ...a, lines: flags.lines ? parseInt(flags.lines, 10) : undefined });
        return out(r, flags, r.text);
      }
      case 'send': {
        const arr = [c2, ...rest].filter((v) => v !== undefined);
        const a = takeIdx(arr);
        const text = arr.join(' ');
        const r = await request('terminal.send', { ...a, text, enter: !!flags.enter, force: !!flags.force });
        return out(r, flags, 'ok');
      }
      case 'send-key': {
        const arr = [c2, ...rest].filter((v) => v !== undefined);
        const a = takeIdx(arr);
        const key = arr[0];
        const r = await request('terminal.sendKey', { ...a, key, force: !!flags.force });
        return out(r, flags, 'ok');
      }

      case 'ws': {
        if (c2 === 'list') {
          const r = await request('ws.list', {});
          const arr = Array.isArray(r) ? r : (r && r.workspaces) || [];
          return out(r, flags, arr.map((w) => `${w.id}\t${w.name}\t${w.localPath || ''}`).join('\n') || '(없음)');
        }
        if (c2 === 'new') return printJson(await request('ws.create', { name: rest[0], parentPath: flags.parent }));
        if (c2 === 'clone') return printJson(await request('ws.clone', { url: rest[0], name: flags.name, parentPath: flags.parent }));
        if (c2 === 'delete') {
          // 서버 목록(메타)에서만 삭제 — 로컬 폴더/파일은 그대로 둔다.
          const r = await request('ws.delete', { id: rest[0] });
          return out(r, flags, '삭제됨 — 폴더/파일은 유지됩니다');
        }
        if (c2 === 'select') return out(await request('ui.wsSelect', { id: rest[0] }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.wsClose', { id: rest[0] }), flags, 'ok');
        break;
      }

      case 'layout': {
        if (c2 === 'tree') return printJson(await request('ui.layoutTree', {}));
        if (c2 === 'split') {
          return out(await request('ui.layoutSplit', {
            direction: rest[0] || 'right', type: flags.type || 'terminal', url: flags.url, path: flags.path, paneId: flags.pane,
          }), flags, 'ok');
        }
        if (c2 === 'focus') return out(await request('ui.focusPane', { paneId: rest[0] }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.closeSurface', { paneId: rest[0] }), flags, 'ok');
        if (c2 === 'ratio') return out(await request('ui.setRatio', { path: flags.path, ratio: parseFloat(rest[0]) }), flags, 'ok');
        break;
      }
      case 'preview': {
        const sid = flags.sid || undefined;
        // open 은 dev 서버가 fire-and-forget 으로 부를 수 있어 짧은 타임아웃(open shim 블록 방지).
        if (c2 === 'open') return out(await request('ui.previewOpen', { url: rest[0], sid, timeoutMs: 5000 }), flags, 'ok');
        if (c2 === 'navigate') return out(await request('ui.previewNavigate', { url: rest[0], sid }), flags, 'ok');
        if (c2 === 'reload') return out(await request('ui.previewReload', { sid }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.previewClose', { sid }), flags, 'ok');
        if (c2 === 'devtools') return out(await request('ui.previewDevtools', { sid, on: rest[0] === 'off' ? false : (rest[0] === 'on' ? true : undefined) }), flags, 'ok');
        if (c2 === 'info') return printJson(await request('ui.previewInfo', { sid }));
        if (c2 === 'inspect') {
          // 요소 선택(디자인) 모드 — 클라가 픽커를 켠다. 선택 결과는 비동기(사용자 클릭 시 터미널 삽입).
          const r = await request('ui.previewInspect', { off: !!flags.off, sid });
          return out(r, flags, r && r.on
            ? '요소 선택 모드 시작 — 사용자가 화면에서 요소를 클릭하면 [디자인] 줄이 터미널에 삽입됩니다'
            : '요소 선택 모드 해제');
        }
        // 이어받기: 현재(또는 --on) 기기의 프리뷰를 --to 기기로 세션·쿠키째 옮긴다.
        if (c2 === 'handoff') return out(await request('ui.previewHandoff', { to: flags.to, timeoutMs: 35000 }), flags, 'ok');
        break;
      }
      case 'ide': {
        const sid = flags.sid || undefined;
        if (c2 === 'open') return out(await request('ui.ideOpen', { path: rest[0], line: flags.line ? parseInt(flags.line, 10) : undefined, sid }), flags, 'ok');
        if (c2 === 'close') return out(await request('ui.ideClose', { sid }), flags, 'ok');
        if (c2 === 'close-file') return out(await request('ui.ideCloseFile', { path: rest[0], sid }), flags, 'ok');
        if (c2 === 'list') return printJson(await request('ui.ideList', { sid }));
        if (c2 === 'diff') {
          // 데몬이 git diff 를 계산해 IDE 에 읽기 전용 diff 문서로 띄운다. 변경 없으면 "변경 없음".
          const r = await request('ui.ideDiff', { path: rest[0], staged: !!flags.staged, sid });
          return out(r, flags, r && r.noChanges ? '변경 없음' : 'ok');
        }
        if (c2 === 'open-changed') {
          // 변경 파일 일괄 열기 — 파일당 최대 2회 ui 왕복 × 150ms 간격이라 CLI 타임아웃을 넉넉히.
          const r = await request('ui.ideOpenChanged', {
            mode: flags.mode, staged: !!flags.staged, max: flags.max ? parseInt(flags.max, 10) : undefined,
          }, { timeoutMs: 240000 });
          return out(r, flags, r && r.noChanges ? '변경 없음' : `${r.opened}/${(r.files || []).length}개 열림${r.skipped ? ` (${r.skipped}개 건너뜀)` : ''}`);
        }
        break;
      }
      case 'skills': {
        if (c2 === 'get') return printSkillGuide(rest[0]);
        if (c2 === 'list' || c2 == null) { process.stdout.write('cpt-cli\n'); return; }
        break;
      }

      case 'browser': {
        const sub = c2;
        const numF = (n) => (flags[n] != null && flags[n] !== true ? Number(flags[n]) : undefined);
        const m = {
          snapshot: () => request('browser.snapshot', { compact: !!flags.compact }),
          click: () => request('browser.click', { target: rest[0], x: numF('x'), y: numF('y') }),
          scroll: () => request('browser.scroll', { target: rest[0], x: numF('x'), y: numF('y'), dx: numF('dx'), dy: numF('dy') }),
          press: () => request('browser.press', { key: rest[0], target: flags.target, modifiers: flags.mod ? String(flags.mod).split(',') : undefined, text: flags.text }),
          type: () => request('browser.type', { target: rest[0], text: rest.slice(1).join(' ') }),
          fill: () => request('browser.fill', { target: rest[0], value: rest.slice(1).join(' ') }),
          eval: () => request('browser.eval', { js: rest.join(' ') }),
          wait: () => request('browser.wait', { selector: flags.selector, text: flags.text, timeoutMs: flags['timeout-ms'] ? parseInt(flags['timeout-ms'], 10) : undefined }),
          get: () => request('browser.get', { what: rest[0], selector: flags.selector }),
          screenshot: () => request('browser.screenshot', {}),
          console: () => request('browser.console', {
            limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
            level: typeof flags.level === 'string' ? flags.level : undefined,
            pattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
            clear: !!flags.clear,
          }),
          network: () => request('browser.network', {
            limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
            pattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
            status: flags.status != null && flags.status !== true ? String(flags.status) : undefined,
            clear: !!flags.clear,
          }),
        };
        if (!m[sub]) break;
        const r = await m[sub]();
        if (sub === 'screenshot' && r && r.base64) {
          // --out 미지정이면 ~/.codingpt/tmp/shot-<ts>.jpg 기본 저장(base64 는 출력하지 않는다).
          if (flags.out) { fs.writeFileSync(String(flags.out), Buffer.from(r.base64, 'base64')); return out({ saved: flags.out }, flags, `저장됨: ${flags.out}`); }
          const dir = path.join(os.homedir(), '.codingpt', 'tmp');
          fs.mkdirSync(dir, { recursive: true });
          const shotPath = path.join(dir, `shot-${Date.now()}.jpg`);
          fs.writeFileSync(shotPath, Buffer.from(r.base64, 'base64'));
          return printJson({ path: shotPath, device: r.device, viewport: r.viewport });
        }
        return printJson(r);
      }

      case 'notify': {
        const r = await request('notify', { title: flags.title || pos.slice(1).join(' '), subtitle: flags.subtitle, body: flags.body, kind: flags.kind });
        return out(r, flags, 'ok');
      }
      case 'notifications': {
        if (c2 === 'read-all') return out(await request('notification.readAll', {}), flags, 'ok');
        const r = await request('notification.list', { limit: flags.limit ? parseInt(flags.limit, 10) : undefined });
        const list = (r && r.notifications) || [];
        const human = list.map((n) => `${n.readAt ? ' ' : '●'} [${n.id}] ${n.title}${n.subtitle ? ' — ' + n.subtitle : ''}${n.body ? '\n    ' + String(n.body).slice(0, 120) : ''}`).join('\n');
        return out(r, flags, human || '(알림 없음)');
      }

      case 'set-status': return out(await request('status.set', { key: c2, value: rest.join(' '), icon: flags.icon, color: flags.color }), flags, 'ok');
      case 'clear-status': return out(await request('status.clear', { key: c2 }), flags, 'ok');
      case 'set-progress': return out(await request('status.progress', { value: parseFloat(c2), label: flags.label }), flags, 'ok');
      case 'clear-progress': return out(await request('status.progress', { value: null }), flags, 'ok');
      case 'log': return out(await request('status.log', { message: pos.slice(1).join(' '), level: flags.level, source: flags.source }), flags, 'ok');
      case 'status': return printJson(await request('status.list', {}));

      // ── 원격 승인(조회 전용) ──
      //  응답(허용/거절)은 여기서 하지 않는다: 이 CLI 는 터미널 안의 AI 도 부를 수 있어서, 응답 명령을
      //  노출하면 에이전트가 자기 승인 요청을 스스로 통과시킬 수 있다. 사람은 앱/PC 카드에서 답한다.
      case 'approval': {
        if (c2 === 'list' || c2 == null) {
          const r = await request('approval.list', {});
          const arr = (r && r.approvals) || [];
          const now = Date.now();
          const left = (d) => (d ? `남은 ${Math.max(0, Math.round((d - now) / 1000))}초` : '마감 미정');
          return out(r, flags, arr.map((a) =>
            `✋ ${a.id}  ${a.tool || '?'}${a.summary ? ' · ' + String(a.summary).split('\n')[0].slice(0, 80) : ''}`
            + `\n   ${a.wsName || a.cwd || '-'}${a.win != null ? `/${a.win}` : ''} · ${left(a.deadlineAt)}`
          ).join('\n') || (r && r.supported === false ? '(이 데몬은 원격 승인을 지원하지 않습니다 — PC 앱 업데이트 필요)' : '(대기 중 승인 없음)'));
        }
        process.stderr.write('사용법: cpt approval list\n');
        process.exitCode = 2;
        return;
      }

      // ── 트랜스크립트(에이전트 대화 로그 직독) ──
      //  기본 = 이 터미널이 보고 있는 세션의 최근 대화. --since <seq> 면 그 이후 증분만(폴링용).
      case 'transcript': {
        if (c2 === 'sessions') {
          const r = await request('chat.sessions', {});
          const arr = (r && r.sessions) || [];
          if (r && r.supported === false) return out(r, flags, `(${r.agent || '이 에이전트'}의 트랜스크립트는 아직 지원하지 않습니다)`);
          return out(r, flags, arr.map((s) =>
            `${s.live ? '●' : '○'} ${s.sessionId}  ${s.title || '(제목 없음)'}`
            + `\n   ${s.lines != null ? `${s.lines}줄 ` : ''}${s.bytes != null ? `${Math.round(s.bytes / 1024)}KB ` : ''}`
            + `${s.gitBranch ? `${s.gitBranch} ` : ''}${s.oversize ? '(대용량) ' : ''}${s.lastAt || ''}`
          ).join('\n') || '(세션 없음)');
        }
        const limit = flags.limit != null && flags.limit !== true ? parseInt(flags.limit, 10) : undefined;
        const sinceSeq = flags.since != null && flags.since !== true ? parseInt(flags.since, 10) : null;
        // 스냅샷을 먼저 연다(chatId/epoch 획득 — since 는 이 좌표계 위에서만 의미가 있다).
        const opened = await request('chat.open', {
          sessionId: typeof flags.session === 'string' ? flags.session : undefined,
          limit: sinceSeq != null ? 1 : (limit || 40), // --since 면 스냅샷 본문은 필요 없다
        });
        if (opened && opened.supported === false) {
          return out(opened, flags, `(${opened.agent || '이 에이전트'}의 트랜스크립트는 아직 지원하지 않습니다)`);
        }
        let messages = (opened && opened.messages) || [];
        let epoch = opened && opened.epoch;
        let headSeq = opened && opened.headSeq;
        if (sinceSeq != null) {
          const d = await request('chat.since', { chatId: opened.chatId, sinceSeq, epoch, limit });
          messages = (d && d.messages) || [];
          if (d && d.epoch) epoch = d.epoch;
          if (d && d.headSeq != null) headSeq = d.headSeq;
          if (d && d.epochChanged) process.stderr.write('알림: 세션 파일이 교체됐습니다(--since 무효) — 전체를 다시 읽으세요.\n');
        }
        // 구독을 남기지 않는다(CLI 는 one-shot 조회) — 실패는 무해(데몬 idle TTL 이 정리).
        await request('chat.close', { chatId: opened && opened.chatId }).catch(() => {});
        const payload = { chatId: opened && opened.chatId, sessionId: opened && opened.sessionId, epoch, headSeq, messages };
        return out(payload, flags, messages.map(renderChatMsg).join('\n') || '(내용 없음)');
      }

      // ── 훅(claude/codex 래퍼가 호출 — 사람이 직접 쓸 일 없음) ──
      case 'claude-hook': {
        // 이벤트 7종(session-start|prompt|permission|notification|stop|stop-failure|session-end)을
        //  hook.event v2 스키마로 매핑해 데몬에 자기보고한다. 데몬이 상태의 단일 소유자다.
        //  불변식: claude 를 절대 블록/오염하지 않는다 → 짧은 타임아웃 + 무조건 exit 0 + stdout 무출력.
        //  ⚠ permission(PermissionRequest) 도 1단계에선 무출력이다. 빈 stdout + exit 0 이면 claude 가
        //    평소처럼 TUI 승인 대화상자를 띄운다(실측). 여기서 결정 JSON 을 뱉으면 사용자 승인을
        //    우리가 대신 결정해버린다 — 절대 금지.
        try {
          const payload = await readStdinJson();
          const ev = mapClaudeHook(c2, payload);
          if (!ev) return;                       // 모르는 이벤트명 = 조용히 성공(구/신 버전 혼재 안전)
          await request('hook.event', ev, { timeoutMs: 3000 }).catch(() => {});
        } catch (_) { /* 훅은 실패해도 조용히 성공 처리 */ }
        return;
      }
      // ── 원격 승인(기능1) — PermissionRequest 훅 전용. 다른 훅과 달리 **응답까지 블로킹**한다 ──
      //  stdout 은 claude 와의 계약 JSON 전용이다(out()/printJson()/console.log 금지 — 한 글자라도
      //  섞이면 결정이 무효화되고 예측 불가 동작이 된다). 결정을 못 받으면 **무출력 + exit 0** →
      //  claude 가 평소처럼 TUI 승인 대화상자를 띄운다(= 자동 허용이 어떤 경로로도 발생하지 않는다).
      case 'approval-hook': {
        await approvalHook(flags);
        return;
      }
      case 'codex-notify': {
        let payload = null;
        try { payload = JSON.parse(rest[0] || c2 || '{}'); } catch (_) { /* noop */ }
        const summary = (payload && (payload['last-assistant-message'] || payload.message)) || '';
        const approval = !!(payload && /approval/i.test(String(payload.type || '')));
        // v2: codex 는 claude 처럼 notificationType 을 주지 않는다. 승인 여부를 여기서 판정해 명시적으로 실어
        //  보낸다 — 안 보내면 데몬(agent-state)이 notificationType 없는 notification 을 무변경 no-op 으로
        //  처리해 codex 승인 알림이 조용히 0건이 된다.
        await request('hook.event', {
          v: 2,
          agent: 'codex',
          event: approval ? 'notification' : 'stop',
          at: Date.now(),
          notificationType: approval ? 'permission_prompt' : null,
          backgroundTasks: 0,
          summary: String(summary),
        }, { timeoutMs: 3000 }).catch(() => {});
        return;
      }
    }
    process.stderr.write(`알 수 없는 명령: ${pos.join(' ')}\n\n`);
    process.stdout.write(HELP);
    process.exitCode = 2;
  };

  try {
    await run();
  } catch (e) {
    // 훅 경로는 어떤 오류에도 exit 0 + 무출력 — 훅이 0 아닌 코드로 끝나거나 stderr 를 뱉으면 claude 가
    //  사용자에게 훅 실패를 표시하고(2 는 모델을 깨우기까지 한다) 작업 흐름을 오염시킨다.
    if (c1 === 'claude-hook' || c1 === 'codex-notify' || c1 === 'approval-hook') return;
    process.stderr.write(`오류: ${e.message}\n`);
    process.exitCode = 1;
  }
}

// ── 원격 승인 훅(PermissionRequest) ────────────────────────────────────────
//  기본값 130s = 데몬 하드 타임아웃(120s) + 여유 10s. 실제 값은 shim 이 데몬 설정에서 파생해
//  `--wait-ms` 로 넘긴다(단일 출처=runner-core/approvals.js budget()). 순서 불변식:
//    데몬 하드 타임아웃 < CLI 대기(--wait-ms) < claude 훅 config timeout
//  이 순서가 깨지면 claude 가 먼저 훅을 잘라 우리가 defer 를 제어하지 못한다(카드 회수 누락).
const APPROVAL_WAIT_DEFAULT_MS = 130000;
const APPROVAL_WAIT_MIN_MS = 5000;
const APPROVAL_WAIT_MAX_MS = 570000;

async function approvalHook(flags) {
  let payload = null;
  try { payload = await readStdinJson({ waitMs: 2000 }); } catch (_) { return; }
  if (!payload || typeof payload !== 'object') return;      // 페이로드 파싱 실패 = 무출력(TUI 폴백)

  // 상태 보고(기능3)는 승인 기능과 독립이다 — 킬스위치/서버 미지원/오류와 무관하게 항상 자기보고한다.
  //  await 하지 않는다: 데몬이 느릴 때 그 지연이 곧 승인 대기(=claude 정지) 앞에 붙기 때문.
  try {
    const ev = mapClaudeHook('permission', payload);
    if (ev) request('hook.event', ev, { timeoutMs: 3000 }).catch(() => {});
  } catch (_) { /* noop */ }

  // 킬스위치 — 기능 도입 전과 100% 동일 동작(무출력 + exit 0 → TUI 대화상자).
  if (process.env.CPT_APPROVAL === '0') return;

  const raw = parseInt((flags && flags['wait-ms']) || process.env.CPT_APPROVAL_WAIT_MS || '', 10);
  const waitMs = Math.max(APPROVAL_WAIT_MIN_MS,
    Math.min(APPROVAL_WAIT_MAX_MS, Number.isFinite(raw) && raw > 0 ? raw : APPROVAL_WAIT_DEFAULT_MS));

  let res = null;
  try {
    res = await request('approval.request', {
      agent: 'claude',
      hookEventName: payload.hook_event_name || 'PermissionRequest',
      sessionId: payload.session_id || null,
      promptId: payload.prompt_id || null,
      toolUseId: payload.tool_use_id || null,
      toolName: payload.tool_name || null,
      toolInput: payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {},
      permissionMode: payload.permission_mode || null,
      transcriptPath: payload.transcript_path || null,
      hookCwd: payload.cwd || null,
      waitMs,
    }, { timeoutMs: waitMs });
  } catch (_) {
    return; // 데몬 오프라인/구버전(알 수 없는 명령)/타임아웃/연결 끊김 — 전부 무출력(TUI 폴백)
  }

  const out = res && res.hookOutput;
  if (!validApprovalOutput(out)) return;                    // defer 이거나 계약 위반 → 무출력
  process.stdout.write(JSON.stringify(out) + '\n');
}

// 계약 최종 검증 — 데몬이 뭘 보내든 CLI 가 "allow/deny 결정 JSON" 이외를 stdout 에 흘리지 않게 한다.
//  (데몬 버전이 앞서가거나 손상된 응답을 받아도 claude 에게 쓰레기를 주지 않는다)
function validApprovalOutput(out) {
  if (!out || typeof out !== 'object') return false;
  const h = out.hookSpecificOutput;
  if (!h || h.hookEventName !== 'PermissionRequest') return false;
  const d = h.decision;
  if (!d || (d.behavior !== 'allow' && d.behavior !== 'deny')) return false;
  if (d.behavior === 'deny' && typeof d.message !== 'string') return false;
  return true;
}

// stdin 전체를 JSON 으로(훅 페이로드). 비 TTY 일 때만 시도.
//  타임아웃 300ms — claude 는 훅 프로세스를 띄우고 페이로드를 즉시 써서 stdin 을 close 한다(end 이벤트로
//  바로 끝난다). 과거 1500ms 는 stdin 이 안 닫히는 예외 상황에서만 쓰이던 순수 손실이었다.
//  승인 훅만 상한을 늘린다(waitMs) — 조기 resolve = 페이로드 절단 = 파싱 실패 = 승인 요청 유실이고,
//  그 비용(사용자가 폰에서 못 받음)이 300ms 절약보다 크다.
function readStdinJson({ waitMs = 300 } = {}) {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(safeParse(buf)), waitMs);
    process.stdin.on('data', (d) => { buf += d.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(safeParse(buf)); });
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// 스킬 전체 가이드 — cpt-cli 패키지에 동봉된 GUIDE.md 를 그대로 출력(바이너리 버전과 항상 일치).
//  소켓 불필요(순수 파일 읽기) — 데몬이 죽어 있어도 동작해 에이전트가 명령을 학습할 수 있다.
function printSkillGuide(name) {
  if (name && name !== 'cpt-cli') {
    process.stderr.write(`알 수 없는 스킬: ${name} (사용 가능: cpt-cli)\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(fs.readFileSync(path.join(__dirname, '..', 'GUIDE.md'), 'utf8'));
  } catch (_) {
    process.stderr.write('가이드 파일(GUIDE.md)을 찾을 수 없습니다.\n');
    process.exitCode = 1;
  }
}

// ── claude 훅 페이로드 → hook.event v2 매핑 ─────────────────────────────────
//  래퍼 인자(케밥) → 와이어 event(스네이크). 모르는 값은 null 반환 → CLI 가 조용히 exit 0.
const CLAUDE_HOOK_EVENTS = {
  'session-start': 'session_start',
  prompt: 'prompt',
  permission: 'permission',
  notification: 'notification',
  stop: 'stop',
  'stop-failure': 'stop_failure',
  'session-end': 'session_end',
};

function clip(v, n) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n); }
function len(v) { return Array.isArray(v) ? v.length : 0; }

// 도구 정보 — 입력 전문은 보내지 않는다(민감 내용·용량). 상관용 digest + 짧은 프리뷰만.
function toolOf(d) {
  if (!d || !d.tool_name) return null;
  let digest = null;
  let preview = '';
  try {
    const s = typeof d.tool_input === 'string' ? d.tool_input : JSON.stringify(d.tool_input || {});
    digest = 'sha1:' + require('crypto').createHash('sha1').update(s).digest('hex');
    preview = clip(s, 200);
  } catch (_) { /* 직렬화 불가(순환 등) — digest 없이 이름만 */ }
  return { name: String(d.tool_name), useId: d.tool_use_id || null, inputDigest: digest, inputPreview: preview };
}

function mapClaudeHook(sub, payload) {
  const event = CLAUDE_HOOK_EVENTS[sub];
  if (!event) return null;
  const d = payload || {};
  const ev = {
    v: 2,
    agent: 'claude',
    event,
    at: Date.now(),                          // 데몬이 훅 도착 지연(at vs 수신시각)을 계측한다
    sessionId: d.session_id || null,
    promptId: d.prompt_id || null,
    permissionMode: d.permission_mode || null,
    agentCwd: d.cwd || null,                 // ctx.ws 와 다를 수 있다(진단용)
    transcriptPath: d.transcript_path || null, // 데몬은 읽지 않는다 — 포인터만
    summary: '',
    tool: null,
    notificationType: null,
    suggestions: null,
    stopHookActive: !!d.stop_hook_active,
    backgroundTasks: len(d.background_tasks), // >0 이면 "턴 종료"가 아니다(백그라운드 대기) → 데몬이 알림 억제
    sessionCrons: len(d.session_crons),
    sessionSource: null,
    endReason: null,
    // 서브에이전트에서 발화한 이벤트 표식 — 데몬이 상태/알림에서 제외한다(병렬 N건 오알림 방지).
    //  ⚠ 판정은 agent_id 단독으로만 한다. agent_type 은 메인 세션의 SessionStart 페이로드에도 실려 오므로
    //  (실측) 이걸 판정에 넣으면 메인 세션 session_start 가 통째로 서브에이전트로 오분류돼 버려지고,
    //  상태가 launching 에 영구 고착된다. agent_type 은 진단용으로만 함께 싣는다.
    subagent: d.agent_id ? { id: d.agent_id, type: d.agent_type || null } : null,
    agentType: d.agent_type || null, // 진단 전용(판정에 쓰지 말 것)
  };
  switch (event) {
    case 'session_start':
      ev.sessionSource = d.source || null;   // startup|resume|clear|compact|fork
      break;
    case 'prompt':
      // 프롬프트 본문(d.prompt)은 보내지 않는다 — 상태 전이(working)에 불필요하고 알림 본문도 아니다.
      break;
    case 'permission':
      ev.tool = toolOf(d);
      ev.suggestions = Array.isArray(d.permission_suggestions) ? d.permission_suggestions : null;
      break;
    case 'notification':
      ev.notificationType = d.notification_type || null; // permission_prompt|idle_prompt|…
      ev.summary = clip(d.message, 2000);
      break;
    case 'stop':
      ev.summary = stopSummary(d);
      break;
    case 'stop_failure':
      ev.summary = clip(d.error_details || d.error || d.last_assistant_message, 2000);
      break;
    case 'session_end':
      ev.endReason = d.reason || null;
      break;
  }
  if (!ev.tool && d.tool_name) ev.tool = toolOf(d);
  return ev;
}

// 턴 요약 — payload 의 last_assistant_message 가 정본(claude 가 "트랜스크립트를 읽고 파싱할 필요를
//  없애기 위해" 넣어준 필드). 없을 때(구버전 claude)만 트랜스크립트 tail 폴백.
function stopSummary(d) {
  const m = clip(d && d.last_assistant_message, 2000);
  if (m) return m;
  return tailAssistantSummary(d && d.transcript_path);
}

// 트랜스크립트 폴백 — 파일 "끝에서" 최대 4×256KB 만 역방향으로 읽는다.
//  ⚠ readFileSync 금지: 이 리포의 최대 트랜스크립트는 1.25GB 로, 전체 읽기는 ERR_STRING_TOO_LONG 으로
//    던지면서 RSS 3.3GB 를 튀긴다(실측) → 긴 세션의 완료 알림 본문이 항상 비어 있었다. 상한이 있는
//    tail 읽기만 허용한다(메모리 ≤ 약 1MB, 시간 ≤ 수 ms).
function tailAssistantSummary(p) {
  const CHUNK = 256 * 1024;
  const MAX_CHUNKS = 4;
  let fd = null;
  try {
    if (!p) return '';
    const size = fs.statSync(p).size;
    if (!size) return '';
    fd = fs.openSync(p, 'r');
    let pos = size;
    const parts = [];
    for (let n = 0; n < MAX_CHUNKS && pos > 0; n++) {
      const want = Math.min(CHUNK, pos);
      pos -= want;
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const r = fs.readSync(fd, buf, got, want - got, pos + got);
        if (!r) break;
        got += r;
      }
      parts.unshift(buf.subarray(0, got));
      // 청크 경계에서 멀티바이트 문자가 쪼개질 수 있어 매번 전체를 한 번에 디코드한다(≤1MB).
      const text = Buffer.concat(parts).toString('utf8');
      const lines = text.split('\n');
      if (pos > 0) lines.shift();            // 파일 시작이 아니면 첫 줄은 잘린 조각 — 버린다
      const hit = scanAssistant(lines);
      if (hit) return hit;
    }
  } catch (_) { /* 없음/권한/깨진 파일 — 요약 없이 진행 */ } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* noop */ } }
  }
  return '';
}

// jsonl 줄 배열을 뒤에서 최대 80줄 스캔해 마지막 assistant 텍스트를 찾는다.
function scanAssistant(lines) {
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 80; i--) {
    const line = lines[i];
    if (!line) continue;
    seen++;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const msg = j && (j.message || j);
    if ((j.type === 'assistant' || (msg && msg.role === 'assistant')) && msg && Array.isArray(msg.content)) {
      const texts = msg.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim();
      if (texts) return texts.replace(/\s+/g, ' ').slice(0, 300);
    }
  }
  return '';
}

// 직접 실행(셸 shim: node cpt.js …)일 때만 CLI 로 동작. require 로 불러오면 순수 함수만 노출해
//  훅 매핑/요약 추출을 소켓·tmux 없이 단위 검증할 수 있다.
if (require.main === module) main();

module.exports = { mapClaudeHook, tailAssistantSummary, scanAssistant, tmuxSelfFromEnv, validApprovalOutput };
