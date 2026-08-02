// commands.js — TUI 의 `/` 명령 목록을 채팅 UI 에 그대로 내주는 카탈로그.
//
// 왜 화면을 긁지 않는가(2026-08-02 실측): 두 CLI 모두 `/` 팝업이 **스크롤 목록**이라 한 번에
//  2~8줄만 보인다(claude 2.1.220 = 95개 · codex 0.146.0 = 46개). 전체를 보려면 TUI 를 수십 번
//  조작해야 하고, 그 사이 사용자의 컴포저를 점유한다 → 화면 미러는 불가능. 그래서:
//   ① 빌트인 = **실측 스냅샷 표**(아래). CLI 가 올라가면 우리가 다시 측정해 갱신한다.
//      표에 없는 명령도 사용자가 직접 타이핑하면 그대로 실행되므로 목록은 '도움'이지 '관문'이 아니다.
//   ② 커스텀(스킬/명령) = **디스크에서 발견**. 프로젝트마다 다르고 자주 바뀌므로 표에 박으면 안 된다.
//
// chat 분류(목록 배지 + 실행 가드):
//   'ok'     = 채팅에서 실행해도 결과가 대화에 남는다(기본)
//   'dialog' = 선택 화면이 뜬다 → 우리 다이얼로그 카드가 그 화면을 미러한다(힌트일 뿐, 판정은 화면이 한다)
//   'tui'    = 채팅에서 실행하면 곤란하다(편집기 열림·세션 종료/이탈·로컬 터미널 전용) → 실행 대신 안내
//
// ★ codex 실측 결론: codex 는 스킬을 슬래시 명령으로 노출하지 않고(`~/.codex/skills/cpt-cli` 가 있어도
//   `/` 목록에 없다), `~/.codex/prompts/*.md` 도 0.146.0 에서는 읽지 않는다(빈 디렉터리 실험).
//   그래서 codex 는 빌트인만 나온다 — 나중에 지원되면 discoverCodex 에 붙이면 된다.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_BUILTIN = [
  { name: '/add-dir', desc: 'Add a new working directory' },
  { name: '/advisor', desc: 'Let Claude consult a stronger model at key moments' },
  { name: '/agents', desc: '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/', chat: 'dialog' },
  { name: '/artifact-capabilities', desc: 'Runtime capabilities a published Artifact page can be granted — behavior static HTML cannot provide on its own, such as the page reading live or connected da…' },
  { name: '/artifact-design', desc: 'Design guidance and fundamentals for Artifacts.' },
  { name: '/artifacts', desc: 'Browse your published and shared artifacts', chat: 'dialog' },
  { name: '/autofix-pr', desc: 'Monitor and autofix any issues with the current PR' },
  { name: '/background', desc: 'Send this session to the background and free the terminal', chat: 'tui' },
  { name: '/batch', desc: 'Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.' },
  { name: '/branch', desc: 'Create a branch of the current conversation at this point', chat: 'dialog' },
  { name: '/btw', desc: 'Ask a quick side question without interrupting the main conversation' },
  { name: '/bug', desc: 'Report a bug or share your conversation' },
  { name: '/cd', desc: 'Move this session to a new working directory' },
  { name: '/chrome', desc: 'Open Claude in Chrome settings', chat: 'tui' },
  { name: '/claude-api', desc: 'Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration. TRIGG…' },
  { name: '/claude-in-chrome', desc: 'Automates your Chrome browser to interact with web pages - clicking elements, filling forms, capturing screenshots, reading console logs, and navigating sites.…' },
  { name: '/clear', desc: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)' },
  { name: '/code-review', desc: 'Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups at the given effort level (low/medium: fewer, high-confidence findi…' },
  { name: '/color', desc: 'Set the prompt bar color for this session' },
  { name: '/compact', desc: 'Free up context by summarizing the conversation so far' },
  { name: '/config', desc: 'Open settings', chat: 'dialog' },
  { name: '/context', desc: 'Visualize current context usage as a colored grid' },
  { name: '/copy', desc: 'Copy Claude\'s last response to clipboard (or /copy N for the Nth-latest)', chat: 'tui' },
  { name: '/cpt-cli', desc: 'ONLY for terminals launched by the CodingPT app, where the CPT_WS environment variable is set. First check `$CPT_WS`: if it is empty or unset, this skill does …' },
  { name: '/dataviz', desc: 'Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact, i…' },
  { name: '/debug', desc: 'Enable debug logging for this session and help diagnose issues' },
  { name: '/deep-research', desc: '[dynamic workflow] Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.' },
  { name: '/design', desc: 'Grant or revoke Claude agent access to your Design projects', chat: 'dialog' },
  { name: '/design-login', desc: 'Authorize design-system access for /design-sync with your claude.ai account' },
  { name: '/design-sync', desc: 'Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it.…' },
  { name: '/desktop', desc: 'Continue the current session in Claude Desktop', chat: 'tui' },
  { name: '/diff', desc: 'View uncommitted changes and per-turn diffs' },
  { name: '/doctor', desc: 'Health-check the user\'s Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local dat…' },
  { name: '/effort', desc: 'Set effort level for model usage', chat: 'dialog' },
  { name: '/exit', desc: 'Exit the CLI', chat: 'tui' },
  { name: '/export', desc: 'Export the current conversation to a file or clipboard' },
  { name: '/fast', desc: 'Toggle fast mode (Opus 5)' },
  { name: '/feedback', desc: 'Send feedback to Anthropic or report a bug' },
  { name: '/fewer-permission-prompts', desc: 'Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission pr…' },
  { name: '/figma:figma-code-connect', desc: '(figma) Creates and maintains Figma Code Connect template files that map Figma components to code snippets. Use when the user mentions Code Connect, Figma co…' },
  { name: '/figma:figma-create-new-file', desc: '(figma) **MANDATORY prerequisite** — you MUST invoke this skill BEFORE every `create_new_file` tool call. NEVER call `create_new_file` directly without loadin…' },
  { name: '/figma:figma-design-to-code', desc: '(figma) **MANDATORY prerequisite** — you MUST invoke this skill BEFORE calling the `get_design_context` Figma MCP tool. You MUST trigger this skill whenever …' },
  { name: '/figma:figma-generate-design', desc: '(figma) Use this skill alongside figma-use when the task involves translating an application page, view, or multi-section layout into Figma. Triggers: \'write…' },
  { name: '/focus', desc: 'Toggle focus view: just your prompt, summary, and response' },
  { name: '/fork', desc: 'Copy this conversation into a new background session and keep working here', chat: 'dialog' },
  { name: '/goal', desc: 'Set a goal Claude checks before stopping' },
  { name: '/help', desc: 'Show help and available commands' },
  { name: '/hooks', desc: 'View hook configurations for tool events', chat: 'dialog' },
  { name: '/ide', desc: 'Manage IDE integrations and show status', chat: 'tui' },
  { name: '/install-github-app', desc: 'Set up Claude GitHub Actions for a repository' },
  { name: '/install-slack-app', desc: 'Install the Claude Slack app' },
  { name: '/keybindings', desc: 'Open your keyboard shortcuts file', chat: 'tui' },
  { name: '/login', desc: 'Sign in with your Anthropic account', chat: 'tui' },
  { name: '/logout', desc: 'Sign out from your Anthropic account', chat: 'tui' },
  { name: '/loop', desc: 'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.' },
  { name: '/mcp', desc: 'Manage MCP servers', chat: 'dialog' },
  { name: '/memory', desc: 'Open a memory file in your editor', chat: 'tui' },
  { name: '/mobile', desc: 'Show QR code to download the Claude mobile app', chat: 'tui' },
  { name: '/model', desc: 'Set the AI model for Claude Code (currently Opus 5 (1M context))', chat: 'dialog' },
  { name: '/objectstore', desc: '사용자의 ghmate 홈서버에서 운영되는 자체 호스팅 S3 호환 오브젝트 스토리지(MinIO 기반). 파일/이미지/사용자 업로드/덤프/백업/큰 바이너리를 저장하거나, 다운로드 URL…' },
  { name: '/permissions', desc: 'Manage allow and deny tool permission rules', chat: 'dialog' },
  { name: '/plan', desc: 'Enable plan mode or view the current session plan' },
  { name: '/plugin', desc: 'Manage Claude Code plugins', chat: 'dialog' },
  { name: '/powerup', desc: 'Discover Claude Code features through quick interactive lessons' },
  { name: '/privacy-settings', desc: 'View and update your privacy settings' },
  { name: '/radio', desc: 'Listen to Claude FM lo-fi radio', chat: 'tui' },
  { name: '/recap', desc: 'Generate a one-line session recap now' },
  { name: '/release-notes', desc: 'View release notes' },
  { name: '/reload-plugins', desc: 'Activate pending plugin changes in the current session' },
  { name: '/reload-skills', desc: 'Pick up skills added or changed on disk during this session' },
  { name: '/remote-control', desc: 'Control this session from your phone or claude.ai/code' },
  { name: '/remote-env', desc: 'Choose the default environment for cloud agents', chat: 'dialog' },
  { name: '/rename', desc: 'Rename the current conversation' },
  { name: '/resume', desc: 'Resume a previous conversation', chat: 'dialog' },
  { name: '/rewind', desc: 'Restore the code and/or conversation to a previous point', chat: 'dialog' },
  { name: '/sandbox', desc: '◯ sandbox disabled (⏎ to configure)', chat: 'dialog' },
  { name: '/scroll-speed', desc: 'Adjust mouse wheel scroll speed', chat: 'tui' },
  { name: '/skills', desc: 'List available skills', chat: 'dialog' },
  { name: '/status', desc: 'Show Claude Code status including version, model, account, API connectivity, and tool statuses' },
  { name: '/stickers', desc: 'Order Claude Code stickers', chat: 'tui' },
  { name: '/subtask', desc: 'Send a subagent off with your full context; its result comes back here' },
  { name: '/tasks', desc: 'View and manage everything running in the background', chat: 'dialog' },
  { name: '/teleport', desc: 'Resume a Claude Code session from claude.ai', chat: 'tui' },
  { name: '/terminal-setup', desc: 'Install Shift+Enter key binding for newlines', chat: 'tui' },
  { name: '/theme', desc: 'Change the theme', chat: 'dialog' },
  { name: '/tui', desc: 'Set the terminal UI renderer (default | fullscreen)', chat: 'tui' },
  { name: '/ultraplan', desc: 'Draft an editable plan in Claude Code on the web (a few minutes) · See https://code.claude.com/docs/en/claude-code-on-the-web' },
  { name: '/ultrareview', desc: 'Start a cloud agent that finds and verifies bugs in your branch (~5-10 min, $5-$25 USD) · Runs in Claude Code on the web. See https://code.claude.com/docs/en…' },
  { name: '/update-config', desc: 'Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after …' },
  { name: '/upgrade', desc: 'Upgrade to Max for higher rate limits and more Opus', chat: 'tui' },
  { name: '/usage', desc: 'Show session cost, plan usage, and activity stats' },
  { name: '/usage-credits', desc: 'Configure usage credits or request them from your admin when you hit a limit' },
  { name: '/voice', desc: 'Toggle voice mode', chat: 'tui' },
  { name: '/web-setup', desc: 'Set up Claude Code on the web with your GitHub account', chat: 'tui' },
  { name: '/workflows', desc: 'Browse running and completed workflows', chat: 'dialog' },
];

const CODEX_BUILTIN = [
  { name: '/agent', desc: 'switch the active agent thread', chat: 'dialog' },
  { name: '/app', desc: 'continue this session in the Desktop app', chat: 'tui' },
  { name: '/approve', desc: 'approve one retry of a recent auto-review denial' },
  { name: '/archive', desc: 'archive this session and exit', chat: 'tui' },
  { name: '/clear', desc: 'clear the terminal and start a new chat' },
  { name: '/compact', desc: 'summarize conversation to prevent hitting the context limit' },
  { name: '/copy', desc: 'copy last response as markdown', chat: 'tui' },
  { name: '/delete', desc: 'permanently delete this session and exit', chat: 'tui' },
  { name: '/diff', desc: 'show git diff (including untracked files)' },
  { name: '/exit', desc: 'exit Codex', chat: 'tui' },
  { name: '/experimental', desc: 'toggle experimental features', chat: 'dialog' },
  { name: '/fast', desc: '1.5x speed, increased usage' },
  { name: '/feedback', desc: 'send logs to maintainers' },
  { name: '/fork', desc: 'fork the current chat', chat: 'dialog' },
  { name: '/goal', desc: 'set or view the goal for a long-running task', chat: 'dialog' },
  { name: '/hooks', desc: 'view and manage lifecycle hooks', chat: 'dialog' },
  { name: '/ide', desc: 'include current selection, open files, and other context from your IDE', chat: 'tui' },
  { name: '/import', desc: 'import setup, this project, and recent chats from Claude Code' },
  { name: '/init', desc: 'create an AGENTS.md file with instructions for Codex' },
  { name: '/keymap', desc: 'remap TUI shortcuts', chat: 'tui' },
  { name: '/logout', desc: 'log out of Codex', chat: 'tui' },
  { name: '/mcp', desc: 'list configured MCP tools; use /mcp verbose for details', chat: 'dialog' },
  { name: '/memories', desc: 'configure memory use and generation', chat: 'dialog' },
  { name: '/mention', desc: 'mention a file' },
  { name: '/model', desc: 'choose what model and reasoning effort to use', chat: 'dialog' },
  { name: '/new', desc: 'start a new chat during a conversation' },
  { name: '/permissions', desc: 'choose what Codex is allowed to do', chat: 'dialog' },
  { name: '/personality', desc: 'choose a communication style for Codex', chat: 'dialog' },
  { name: '/pets', desc: 'choose or hide the terminal pet', chat: 'dialog' },
  { name: '/plan', desc: 'switch to Plan mode', chat: 'dialog' },
  { name: '/plugins', desc: 'browse plugins', chat: 'dialog' },
  { name: '/ps', desc: 'list background terminals' },
  { name: '/raw', desc: 'toggle raw scrollback mode for copy-friendly terminal selection', chat: 'tui' },
  { name: '/rename', desc: 'rename the current thread' },
  { name: '/resume', desc: 'resume a saved chat', chat: 'dialog' },
  { name: '/review', desc: 'review my current changes and find issues' },
  { name: '/side', desc: 'start a side conversation in an ephemeral fork' },
  { name: '/skills', desc: 'use skills to improve how Codex performs specific tasks', chat: 'dialog' },
  { name: '/status', desc: 'show current session configuration and token usage' },
  { name: '/statusline', desc: 'configure which items appear in the status line', chat: 'dialog' },
  { name: '/stop', desc: 'stop all background terminals' },
  { name: '/subagents', desc: 'switch the active agent thread', chat: 'dialog' },
  { name: '/theme', desc: 'choose a syntax highlighting theme', chat: 'dialog' },
  { name: '/title', desc: 'configure which items appear in the terminal title', chat: 'dialog' },
  { name: '/usage', desc: 'view account usage or use a usage limit reset', chat: 'dialog' },
  { name: '/vim', desc: 'toggle Vim mode for the composer', chat: 'tui' },
];

const CACHE_MS = 20_000;              // 디스크 재스캔 주기 — 목록을 열 때마다 훑지 않는다
const MAX_ITEMS = 400;                // 폭주 방어(스킬 디렉터리가 이상하게 큰 경우)
const cache = new Map();              // `${agent}|${cwdAbs}` → { at, items }

/** md 프론트매터에서 name/description 만 뽑는다(YAML 파서 없이 — 의존성 0 규율). */
function frontMatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---')) return {};
  const end = s.indexOf('\n---', 3);
  if (end < 0) return {};
  const out = {};
  const lines = s.slice(3, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    // 블록 스칼라(`description: >-` / `|`) — 실제 스킬 파일이 이 형태를 쓴다(cpt-cli). 값이 다음
    //  들여쓴 줄들에 있으므로 여기서 이어 붙이지 않으면 설명이 ">-" 로 보인다(실사고).
    if (val === '>' || val === '>-' || val === '|' || val === '|-') {
      const parts = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) { parts.push(lines[j].trim()); i = j; }
      val = parts.join(' ');
    }
    out[key] = val.replace(/^["']|["']$/g, '');
  }
  return out;
}

function readMeta(file, fallbackName) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch (_) { return null; }
  const fm = frontMatter(text);
  const name = String(fm.name || fallbackName || '').trim();
  if (!name || !/^[A-Za-z0-9:_-]+$/.test(name)) return null;
  let desc = String(fm.description || '').replace(/\s+/g, ' ').trim();
  if (!desc) {
    // 프론트매터가 없으면 첫 산문 줄을 설명으로 쓴다(제목 `#` 은 건너뛴다).
    const body = text.replace(/^---[\s\S]*?\n---\n?/, '');
    desc = (body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '');
  }
  if (desc.length > 160) desc = desc.slice(0, 157) + '…';
  return { name: '/' + name, desc };
}

// 디렉터리의 md 파일과 하위 폴더의 SKILL.md 를 항목으로 — claude 스킬/명령 레이아웃 둘 다 이 모양이다.
function scanDir(dir, source, out, seen) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (out.length >= MAX_ITEMS) return;
    const full = path.join(dir, e.name);
    let meta = null;
    if (e.isFile() && e.name.endsWith('.md')) meta = readMeta(full, e.name.replace(/\.md$/, ''));
    else if (e.isDirectory()) meta = readMeta(path.join(full, 'SKILL.md'), e.name);
    if (!meta || seen.has(meta.name)) continue;
    seen.add(meta.name);
    out.push({ ...meta, chat: 'ok', source });
  }
}

/** claude: 프로젝트(.claude) → 개인(~/.claude) 순으로 발견. 앞선 것이 이긴다(더 가까운 정의). */
function discoverClaude(cwdAbs) {
  const out = [];
  const seen = new Set();
  if (cwdAbs) {
    scanDir(path.join(cwdAbs, '.claude', 'commands'), 'project', out, seen);
    scanDir(path.join(cwdAbs, '.claude', 'skills'), 'project', out, seen);
  }
  const home = os.homedir();
  scanDir(path.join(home, '.claude', 'commands'), 'user', out, seen);
  scanDir(path.join(home, '.claude', 'skills'), 'user', out, seen);
  return out;
}

/** codex: 현재(0.146.0) 슬래시로 노출되는 사용자 정의가 없다 — 실측 결론(파일 상단 주석). */
function discoverCodex() { return []; }

/**
 * 이 터미널에서 쓸 수 있는 슬래시 명령 목록.
 * @returns {{agent:string, items:Array<{name,desc,chat,source}>}}
 *  정렬 = 프로젝트 → 개인 → 빌트인, 각 구간 알파벳순(사용자가 만든 것이 위로 온다).
 */
function listCommands({ agent, cwdAbs } = {}) {
  const a = agent === 'codex' ? 'codex' : 'claude';
  const key = `${a}|${cwdAbs || ''}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return { agent: a, items: hit.items };

  const builtin = (a === 'codex' ? CODEX_BUILTIN : CLAUDE_BUILTIN)
    .map((x) => ({ name: x.name, desc: x.desc, chat: x.chat || 'ok', source: 'builtin' }));
  const found = a === 'codex' ? discoverCodex() : discoverClaude(cwdAbs);
  // 디스크에서 찾은 것이 표를 이긴다(설명이 최신이고, 덮어쓴 정의가 실제로 실행되는 쪽이다).
  const byName = new Map();
  for (const it of builtin) byName.set(it.name, it);
  for (const it of found) byName.set(it.name, it);
  const rank = { project: 0, user: 1, builtin: 2 };
  const items = [...byName.values()].sort((x, y) => (rank[x.source] - rank[y.source]) || x.name.localeCompare(y.name));
  cache.set(key, { at: now, items });
  return { agent: a, items };
}

/** 목록에서 이름으로 찾기 — 실행 가드(tui 분류)가 쓴다. */
function findCommand({ agent, cwdAbs, name }) {
  const n = String(name || '').trim().split(/\s+/)[0];
  if (!n.startsWith('/')) return null;
  return listCommands({ agent, cwdAbs }).items.find((x) => x.name === n) || null;
}

function _clearCache() { cache.clear(); }

module.exports = { listCommands, findCommand, _clearCache, _frontMatter: frontMatter };
