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

function tmuxSelf() {
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
function request(cmd, args, { timeoutMs = 65000 } = {}) {
  return new Promise((resolve, reject) => {
    const tmuxInfo = tmuxSelf();
    const ctx = {
      cwd: process.cwd(),
      ws: resolveWs(tmuxInfo),
      tmux: tmuxInfo || undefined,
    };
    const sock = sockPath();
    const conn = net.createConnection(sock);
    let buf = '';
    const timer = setTimeout(() => {
      try { conn.destroy(); } catch (_) { /* noop */ }
      reject(new Error('데몬 응답 시간 초과'));
    }, timeoutMs);
    conn.on('connect', () => {
      conn.write(JSON.stringify({ id: 'c' + Date.now(), cmd, args, ctx }) + '\n');
    });
    conn.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      try {
        const res = JSON.parse(buf.slice(0, i));
        if (res.ok) resolve(res.result);
        else reject(Object.assign(new Error(res.error || '실패'), { code: res.code }));
      } catch (e) { reject(e); }
      try { conn.end(); } catch (_) { /* noop */ }
    });
    conn.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        reject(new Error(`CodingPT 데몬에 연결할 수 없습니다 (${sock}) — 데몬/데스크톱 앱이 실행 중인지 확인하세요.`));
      } else reject(e);
    });
  });
}

function printJson(v) { process.stdout.write(JSON.stringify(v, null, 2) + '\n'); }

function out(v, flags, human) {
  if (flags.json || human == null) printJson(v);
  else process.stdout.write(human + '\n');
}

const HELP = `cpt - CodingPT 를 유닉스 소켓으로 조작 (터미널 안의 AI/사용자용)

사용법: cpt [--json] <command> [args]

컨텍스트:
  CodingPT 터미널에서 실행하면 자기 워크스페이스/터미널을 자동 인지한다(CPT_WS/TMUX_PANE).
  터미널 인덱스를 받는 명령은 생략 시 "자기 자신"이 대상이다.

명령:
  identify                              내 좌표(워크스페이스/터미널) 확인
  capabilities                          지원 명령 목록
  ping

  # 터미널 (전 기기 공유 풀)
  terminal list                         터미널 목록(이름/실행 중 명령)
  terminal new [--name <이름>]          새 터미널 생성(전 기기에 나타남)
  terminal close [<idx>]                터미널 삭제(전 기기)
  terminal rename <이름> [--index <n>]  터미널 이름 변경
  read-screen [<idx>] [--lines <n>]     터미널 화면/스크롤백 읽기
  send [<idx>] <text> [--enter]         터미널에 텍스트 입력(자기 자신은 --force)
  send-key [<idx>] <key>                특수키 입력 (C-c, Enter, Up ...)

  # 워크스페이스
  ws list                               워크스페이스 목록
  ws new <이름> [--parent <경로>]       새 워크스페이스 생성(git init)
  ws clone <git-url> [--name <이름>]    GitHub 레포 클론
  ws select <id>                        전 기기에서 이 워크스페이스로 전환

  # 화면 배치 (접속 중인 모든 기기에 반영)
  layout tree                           현재 레이아웃 트리(최근 활동 기기 기준)
  layout split <left|right|up|down> [--type terminal|preview|ide] [--url <u>] [--path <p>]
  layout focus <paneId>                 pane 포커스
  layout close <paneId>                 pane/surface 닫기
  preview open <url|:port>              프리뷰 열기(새 pane)
  preview navigate <url>                활성 프리뷰 이동
  preview reload                        활성 프리뷰 새로고침
  ide open <파일경로> [--line <n>]      IDE 로 파일 열기

  # 브라우저 자동화 (프리뷰 페이지 — 한 기기에서 실행해 결과 회신)
  browser snapshot                      인터랙티브 요소 트리(ref 포함)
  browser click <ref|selector>
  browser type <ref|selector> <text>
  browser fill <ref|selector> <value>
  browser eval <js>
  browser wait [--selector <css>] [--text <t>] [--timeout-ms <ms>]
  browser get <url|title|text|html> [--selector <css>]
  browser screenshot [--out <path>]

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

옵션: --json (원본 JSON 출력)

환경: CPT_WS(워크스페이스), CPT_SOCK(소켓 경로), TMUX_PANE(자동)
`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags, pos } = parseArgv(argv);
  const [c1, c2, ...rest] = pos;

  if (!c1 || c1 === 'help' || flags.help) { process.stdout.write(HELP); return; }

  // 위치 인자에서 "터미널 인덱스(숫자)" 선택적 소비.
  const takeIdx = (arr) => (arr.length && /^\d+$/.test(arr[0]) ? { index: parseInt(arr.shift(), 10) } : {});

  const run = async () => {
    switch (c1) {
      case 'ping': return out(await request('ping', {}), flags, 'pong');
      case 'capabilities': return printJson(await request('capabilities', {}));
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
        if (c2 === 'open') return out(await request('ui.previewOpen', { url: rest[0] }), flags, 'ok');
        if (c2 === 'navigate') return out(await request('ui.previewNavigate', { url: rest[0] }), flags, 'ok');
        if (c2 === 'reload') return out(await request('ui.previewReload', {}), flags, 'ok');
        break;
      }
      case 'ide': {
        if (c2 === 'open') return out(await request('ui.ideOpen', { path: rest[0], line: flags.line ? parseInt(flags.line, 10) : undefined }), flags, 'ok');
        break;
      }

      case 'browser': {
        const sub = c2;
        const m = {
          snapshot: () => request('browser.snapshot', { compact: !!flags.compact }),
          click: () => request('browser.click', { target: rest[0] }),
          type: () => request('browser.type', { target: rest[0], text: rest.slice(1).join(' ') }),
          fill: () => request('browser.fill', { target: rest[0], value: rest.slice(1).join(' ') }),
          eval: () => request('browser.eval', { js: rest.join(' ') }),
          wait: () => request('browser.wait', { selector: flags.selector, text: flags.text, timeoutMs: flags['timeout-ms'] ? parseInt(flags['timeout-ms'], 10) : undefined }),
          get: () => request('browser.get', { what: rest[0], selector: flags.selector }),
          screenshot: () => request('browser.screenshot', {}),
        };
        if (!m[sub]) break;
        const r = await m[sub]();
        if (sub === 'screenshot' && r && r.base64) {
          if (flags.out) { fs.writeFileSync(String(flags.out), Buffer.from(r.base64, 'base64')); return out({ saved: flags.out }, flags, `저장됨: ${flags.out}`); }
          return printJson({ format: r.format || 'jpeg', base64Length: r.base64.length, note: '--out <path> 로 파일 저장' });
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

      // ── 훅(claude/codex 래퍼가 호출 — 사람이 직접 쓸 일 없음) ──
      case 'claude-hook': {
        const event = c2 === 'notification' ? 'notification' : 'stop';
        const payload = await readStdinJson();
        let summary = '';
        if (event === 'notification') summary = (payload && payload.message) || '';
        else summary = extractClaudeSummary(payload);
        // 데몬 오프라인이어도 claude 를 블록하지 않는다 — 짧은 타임아웃 + 무조건 exit 0.
        await request('hook.event', { agent: 'claude', event, summary, sessionId: payload && payload.session_id }, { timeoutMs: 3000 }).catch(() => {});
        return;
      }
      case 'codex-notify': {
        let payload = null;
        try { payload = JSON.parse(rest[0] || c2 || '{}'); } catch (_) { /* noop */ }
        const summary = (payload && (payload['last-assistant-message'] || payload.message)) || '';
        const event = payload && /approval/i.test(String(payload.type || '')) ? 'notification' : 'stop';
        await request('hook.event', { agent: 'codex', event, summary: String(summary) }, { timeoutMs: 3000 }).catch(() => {});
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
    process.stderr.write(`오류: ${e.message}\n`);
    process.exitCode = 1;
  }
}

// stdin 전체를 JSON 으로(훅 페이로드). 비 TTY 일 때만 시도, 1초 내 미도착 시 null.
function readStdinJson() {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(safeParse(buf)), 1500);
    process.stdin.on('data', (d) => { buf += d.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(safeParse(buf)); });
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// Claude Code Stop 훅 페이로드에서 마지막 assistant 응답 요약 추출 — transcript jsonl 을 뒤에서 스캔.
function extractClaudeSummary(payload) {
  try {
    const p = payload && payload.transcript_path;
    if (!p || !fs.existsSync(p)) return '';
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 80; i--) {
      let j;
      try { j = JSON.parse(lines[i]); } catch (_) { continue; }
      const msg = j && (j.message || j);
      if ((j.type === 'assistant' || (msg && msg.role === 'assistant')) && msg && Array.isArray(msg.content)) {
        const texts = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (texts) return texts.replace(/\s+/g, ' ').slice(0, 300);
      }
    }
  } catch (_) { /* noop */ }
  return '';
}

main();
