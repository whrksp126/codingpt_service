const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class ExecutorService {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'code-execute');

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // 컴파일러/런타임이 쓰는 임시 캐시·홈 디렉토리(go/kotlin 등은 HOME/캐시 쓰기 권한 필요)
    const RT_HOME = path.join(os.tmpdir(), 'cpt-runtime');

    // 언어별 실행 설정.
    //  - exts: 확장자(첫 번째가 임시파일 확장자)
    //  - run(srcFile, outBase): 실행 [cmd, args]  (인터프리터/컴파일 후 실행 공통)
    //  - compile(srcFile, outBase): 있으면 먼저 컴파일 [cmd, args] → 성공 시 run 실행
    //  - fallbackCmd: run 의 cmd 가 ENOENT 일 때 대체 (python3→python)
    //  - env: 추가 환경변수
    this.languageConfigs = {
      python:     { name: 'Python',     exts: ['.py'],                run: (f) => ['python3', ['-u', f]], fallbackCmd: 'python' },
      javascript: { name: 'JavaScript', exts: ['.js', '.mjs', '.cjs'], run: (f) => ['node', [f]] },
      typescript: { name: 'TypeScript', exts: ['.ts'],                run: (f) => ['tsx', [f]] }, // 전역 tsx 필요
      ruby:       { name: 'Ruby',       exts: ['.rb'],                run: (f) => ['ruby', [f]] },
      php:        { name: 'PHP',        exts: ['.php'],               run: (f) => ['php', [f]] },
      bash:       { name: 'Bash',       exts: ['.sh', '.bash'],       run: (f) => ['bash', [f]] },
      go:         { name: 'Go',         exts: ['.go'],                run: (f) => ['go', ['run', f]], env: { HOME: RT_HOME, GOCACHE: path.join(RT_HOME, 'go-build'), GOPATH: path.join(RT_HOME, 'go'), GOFLAGS: '-mod=mod' } },
      c:          { name: 'C',          exts: ['.c'],                 compile: (f, o) => ['gcc', [f, '-O0', '-o', o]], run: (f, o) => [o, []] },
      cpp:        { name: 'C++',        exts: ['.cpp', '.cc', '.cxx'], compile: (f, o) => ['g++', [f, '-O0', '-std=c++17', '-o', o]], run: (f, o) => [o, []] },
      rust:       { name: 'Rust',       exts: ['.rs'],                compile: (f, o) => ['rustc', ['-O', f, '-o', o]], run: (f, o) => [o, []] },
      // Java 11+ 단일 파일 소스 실행(JEP 330) — public class 명이 파일명과 달라도 됨.
      java:       { name: 'Java',       exts: ['.java'],              run: (f) => ['java', [f]] },
      // Kotlin: jar 로 컴파일 후 실행(느림, kotlinc JVM 기동). HOME 쓰기 권한 필요.
      kotlin:     { name: 'Kotlin',     exts: ['.kt', '.kts'],        compile: (f, o) => ['kotlinc', [f, '-include-runtime', '-d', `${o}.jar`]], run: (f, o) => ['java', ['-jar', `${o}.jar`]], env: { HOME: RT_HOME } },
      // C#: mono(mcs 컴파일 → mono 실행)
      csharp:     { name: 'C#',         exts: ['.cs'],                compile: (f, o) => ['mcs', [`-out:${o}.exe`, f]], run: (f, o) => ['mono', [`${o}.exe`]] },
    };

    // 디버그(라인 트레이스) 지원 언어 — 트레이스 API 가 있는 인터프리터.
    // (PHP 는 xdebug 없이는 라인 추적이 어려워 run-only)
    this.debuggableLangs = new Set(['python', 'javascript', 'ruby', 'bash']);

    // 확장자 -> 언어 매핑 (languageConfigs.exts 에서 자동 생성)
    this.extensionToLanguage = {};
    for (const [langKey, cfg] of Object.entries(this.languageConfigs)) {
      for (const e of cfg.exts) this.extensionToLanguage[e] = langKey;
    }
  }

  /**
   * 코드 실행 (SSE 스트림)
   * @param {object} [options]
   * @param {boolean} [options.debug] - true 면 라인 트레이스(디버그) 모드로 실행
   */
  async executeCode(code, language, res, options = {}) {
    const lang = language.toLowerCase();
    const langConfig = this.languageConfigs[lang];

    if (!langConfig) {
      throw new Error(`지원하지 않는 언어입니다: ${language}`);
    }

    // 디버그 모드: 한 줄씩 실행되며 현재 라인 번호를 trace 이벤트로 흘린다.
    if (options.debug && this.debuggableLangs.has(lang)) {
      return this.executeDebug(code, lang, res);
    }

    // SSE 헤더 설정
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch (_) { /* noop */ } };
    send({ type: 'log', message: `${langConfig.name} 코드 실행을 시작합니다...\n` });

    const stamp = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const srcFile = path.join(this.tempDir, `code-${stamp}${langConfig.exts[0]}`);
    const outBase = path.join(this.tempDir, `out-${stamp}`);
    // 컴파일 산출물까지 정리(언어별로 out / out.jar / out.exe 중 하나)
    const cleanupPaths = [srcFile, outBase, `${outBase}.jar`, `${outBase}.exe`];
    const env = { PATH: process.env.PATH, ...(langConfig.env || {}) };

    let finished = false;
    let cur = null;
    const done = (closeMsg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanupPaths.forEach((p) => this.cleanupFile(p));
      try { if (closeMsg) send(closeMsg); res.end(); } catch (_) { /* noop */ }
    };
    const timer = setTimeout(() => {
      if (finished) return;
      try { cur && cur.kill('SIGTERM'); } catch (_) { /* noop */ }
      send({ type: 'error', data: '\n⏱️ 실행 시간이 30초를 초과하여 종료되었습니다.\n' });
      done({ type: 'close', exitCode: -1, hasError: true, message: '실행 시간 초과' });
    }, 30000);

    // 실행 단계 — stdout 스트리밍, stderr 버퍼링 후 종료 시 전송
    const runStep = (useFallback) => {
      let [cmd, args] = langConfig.run(srcFile, outBase);
      if (useFallback && langConfig.fallbackCmd) cmd = langConfig.fallbackCmd;
      const proc = spawn(cmd, args, { cwd: '/tmp', env, shell: false });
      cur = proc;
      let stderr = '';
      let hasError = false;
      if (!proc.stdout) {
        send({ type: 'error', data: '프로세스 stdout을 열 수 없습니다.\n' });
        return done({ type: 'close', exitCode: -1, hasError: true });
      }
      proc.stdout.on('data', (data) => {
        const out = data.toString();
        const lines = out.split('\n');
        lines.forEach((line, i) => {
          if (line || i < lines.length - 1) send({ type: 'output', data: line + (i < lines.length - 1 ? '\n' : '') });
        });
      });
      proc.stderr.on('data', (data) => { stderr += data.toString(); hasError = true; });
      proc.on('error', (err) => {
        if (finished) return;
        if (err.code === 'ENOENT' && langConfig.fallbackCmd && !useFallback) return runStep(true);
        if (err.code === 'ENOENT') {
          send({ type: 'error', data: `'${cmd}' 런타임이 설치되어 있지 않습니다. (${langConfig.name})\n` });
          return done({ type: 'close', exitCode: -1, hasError: true });
        }
        send({ type: 'error', data: `프로세스 실행 오류: ${err.message}\n` });
        done({ type: 'close', exitCode: -1, hasError: true });
      });
      proc.on('close', (codeNum) => {
        if (finished) return;
        // JS/TS 는 스택 노이즈 제거, 그 외 언어는 stderr 원문 표시
        const cleaned = (lang === 'javascript' || lang === 'typescript')
          ? this.parseNodeError(stderr)
          : (stderr || '').trim();
        if (cleaned) send({ type: 'error', data: cleaned + '\n' });
        send({ type: 'log', message: `프로세스가 종료되었습니다. (종료 코드: ${codeNum})\n` });
        done({ type: 'close', exitCode: codeNum, hasError: hasError || codeNum !== 0 });
      });
    };

    // 컴파일 단계 — 출력은 모아서 실패 시에만 에러로 전송
    const compileStep = () => {
      const [cmd, args] = langConfig.compile(srcFile, outBase);
      const proc = spawn(cmd, args, { cwd: '/tmp', env, shell: false });
      cur = proc;
      let buf = '';
      if (proc.stderr) proc.stderr.on('data', (d) => { buf += d.toString(); });
      if (proc.stdout) proc.stdout.on('data', (d) => { buf += d.toString(); });
      proc.on('error', (err) => {
        if (finished) return;
        if (err.code === 'ENOENT') {
          send({ type: 'error', data: `'${cmd}' 컴파일러가 설치되어 있지 않습니다. (${langConfig.name})\n` });
          return done({ type: 'close', exitCode: -1, hasError: true });
        }
        send({ type: 'error', data: `컴파일 오류: ${err.message}\n` });
        done({ type: 'close', exitCode: -1, hasError: true });
      });
      proc.on('close', (codeNum) => {
        if (finished) return;
        if (codeNum !== 0) {
          if (buf.trim()) send({ type: 'error', data: buf.trim() + '\n' });
          send({ type: 'log', message: `컴파일 실패 (종료 코드: ${codeNum})\n` });
          return done({ type: 'close', exitCode: codeNum, hasError: true });
        }
        runStep(false); // 컴파일 성공 → 실행
      });
    };

    try {
      // go/kotlin 등 HOME/캐시 디렉토리 보장
      if (langConfig.env && langConfig.env.HOME && !fs.existsSync(langConfig.env.HOME)) {
        fs.mkdirSync(langConfig.env.HOME, { recursive: true });
      }
      fs.writeFileSync(srcFile, code, 'utf8');
    } catch (err) {
      send({ type: 'error', data: `파일 생성 오류: ${err.message}\n` });
      return done({ type: 'close', exitCode: -1, hasError: true });
    }

    if (langConfig.compile) compileStep();
    else runStep(false);
  }

  // ──────────────────────────────────────────────────────────────────────
  // 디버그(라인 트레이스) 실행
  //   - 코드를 트레이서로 감싸 실행하고, 각 줄 실행 시 stdout 에 센티넬을 흘린다.
  //   - 센티넬: `\x01CPT_LINE:<원본줄번호>\x01` (제어문자 SOH 로 일반 출력과 충돌 최소화)
  //   - 프론트는 trace/output 이벤트를 타임라인으로 모아 재생(하이라이트/출력)한다.
  // ──────────────────────────────────────────────────────────────────────
  static get TRACE_SENTINEL() { return '\x01CPT_LINE:'; }
  static get MAX_TRACE_STEPS() { return 5000; }

  /** Python 디버그 러너 소스 — settrace 로 user 파일의 'line' 이벤트만 센티넬로 emit */
  buildPythonRunner() {
    const SENTINEL = ExecutorService.TRACE_SENTINEL;
    const MAX = ExecutorService.MAX_TRACE_STEPS;
    return [
      'import sys, runpy',
      'USER_FILE = sys.argv[1]',
      `MAX_STEPS = ${MAX}`,
      '_steps = [0]',
      'def _cpt_trace(frame, event, arg):',
      "    if event == 'line' and frame.f_code.co_filename == USER_FILE:",
      '        _steps[0] += 1',
      '        if _steps[0] > MAX_STEPS:',
      `            sys.stdout.write('${SENTINEL}-1\\x01\\n'); sys.stdout.flush()`,
      '            sys.settrace(None)',
      '            raise SystemExit',
      `        sys.stdout.write('${SENTINEL}%d\\x01\\n' % frame.f_lineno); sys.stdout.flush()`,
      '    return _cpt_trace',
      'sys.settrace(_cpt_trace)',
      'try:',
      "    runpy.run_path(USER_FILE, run_name='__main__')",
      'finally:',
      '    sys.settrace(None)',
      '',
    ].join('\n');
  }

  /** Ruby 디버그 러너 — TracePoint(:line) 로 user 파일의 줄 이벤트만 센티넬로 emit */
  buildRubyRunner() {
    const S = ExecutorService.TRACE_SENTINEL;
    const MAX = ExecutorService.MAX_TRACE_STEPS;
    return [
      '$stdout.sync = true',
      'user_file = File.expand_path(ARGV[0])',
      `max_steps = ${MAX}`,
      'steps = 0',
      'tp = TracePoint.new(:line) do |t|',
      '  if File.expand_path(t.path) == user_file',
      '    steps += 1',
      '    if steps > max_steps',
      `      $stdout.write("${S}-1\\x01\\n"); tp.disable; exit`,
      '    end',
      `    $stdout.write("${S}#{t.lineno}\\x01\\n")`,
      '  end',
      'end',
      'tp.enable',
      'begin',
      '  load user_file',
      'ensure',
      '  tp.disable',
      'end',
      '',
    ].join('\n');
  }

  /** Bash 디버그 러너 — set -T(functrace)로 source 된 파일 안에서도 DEBUG trap 발동.
   *  BASH_SOURCE 필터로 러너 자신의 줄은 제외, 트랩 본문은 인라인(함수 호출 시 재귀 회피). */
  buildBashRunner() {
    const S = ExecutorService.TRACE_SENTINEL;
    const MAX = ExecutorService.MAX_TRACE_STEPS;
    return [
      'set -T',
      '__cpt_user="$1"',
      '__cpt_steps=0',
      `trap 'if [ "\${BASH_SOURCE[0]}" = "$__cpt_user" ]; then __cpt_steps=$((__cpt_steps+1)); if [ "$__cpt_steps" -gt ${MAX} ]; then printf "${S}-1\\x01\\n"; trap - DEBUG; else printf "${S}%s\\x01\\n" "$LINENO"; fi; fi' DEBUG`,
      'source "$__cpt_user"',
      '',
    ].join('\n');
  }

  /** JavaScript 코드를 acorn 으로 파싱해 각 statement 앞에 __cptLine(원본줄) 주입 */
  instrumentJavaScript(code) {
    // acorn 미설치 시 명확한 에러 (디버그 모드만 영향, 일반 실행은 무관)
    const acorn = require('acorn');
    const ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true });

    // 소스에 삽입할 코드 조각들. pos(삽입 위치) 기준 뒤에서부터 적용해 offset 보존.
    const inserts = [];
    let seq = 0;
    const add = (pos, text) => inserts.push({ pos, text, seq: seq++ });
    const LOOP = new Set(['ForStatement', 'WhileStatement', 'DoWhileStatement']);

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node.type !== 'string') return;

      // 1) body/consequent 배열의 각 문장 앞에 라인 emit
      for (const key of ['body', 'consequent']) {
        const arr = node[key];
        if (Array.isArray(arr)) {
          for (const stmt of arr) {
            if (stmt && stmt.type && stmt.loc && typeof stmt.start === 'number') {
              add(stmt.start, `__cptLine(${stmt.loc.start.line});`);
            }
          }
        }
      }

      // 2) 반복문: 매 반복마다 헤더 줄을 다시 emit (settrace 수준 디테일).
      //    test 가 있으면 `(test)` → `(__cptLine(L), test)` 로 감싸 조건 평가 직전에 emit.
      //    test 가 없거나(for(;;)) for-in/of 면 블록 본문 진입 시 emit.
      if (LOOP.has(node.type)) {
        const L = node.loc.start.line;
        if (node.test && typeof node.test.start === 'number') {
          add(node.test.start, `(__cptLine(${L}),`);
          add(node.test.end, ')');
        } else if (node.body && node.body.type === 'BlockStatement' && typeof node.body.start === 'number') {
          add(node.body.start + 1, `__cptLine(${L});`);
        }
      } else if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement')
        && node.body && node.body.type === 'BlockStatement' && typeof node.body.start === 'number') {
        add(node.body.start + 1, `__cptLine(${node.loc.start.line});`);
      }

      for (const key in node) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
        const child = node[key];
        if (child && typeof child === 'object') walk(child);
      }
    };
    walk(ast);

    // 뒤에서부터 삽입(앞 offset 보존). 같은 위치면 나중에 추가된 것을 먼저 넣어 안쪽에 위치.
    inserts.sort((a, b) => (b.pos - a.pos) || (b.seq - a.seq));
    let out = code;
    for (const ins of inserts) {
      out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
    }

    const SENTINEL = ExecutorService.TRACE_SENTINEL;
    const MAX = ExecutorService.MAX_TRACE_STEPS;
    const prelude =
      'globalThis.__cptStep=0;' +
      'globalThis.__cptLine=function(n){' +
      `if(++globalThis.__cptStep>${MAX}){process.stdout.write('${SENTINEL}-1\\x01\\n');throw new Error('__CPT_MAX_STEPS__');}` +
      `process.stdout.write('${SENTINEL}'+n+'\\x01\\n');` +
      '};\n';
    return prelude + out;
  }

  /**
   * 디버그 실행 (SSE 스트림) — trace/output/error/close 이벤트 emit
   */
  async executeDebug(code, lang, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { /* noop */ }
    };

    send({ type: 'log', message: `${this.languageConfigs[lang].name} 디버그 실행을 시작합니다...\n` });

    const stamp = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const tempFiles = [];
    let command;
    let args;

    try {
      if (lang === 'python') {
        const userFile = path.join(this.tempDir, `dbg-user-${stamp}.py`);
        const runnerFile = path.join(this.tempDir, `dbg-runner-${stamp}.py`);
        fs.writeFileSync(userFile, code, 'utf8');
        fs.writeFileSync(runnerFile, this.buildPythonRunner(), 'utf8');
        tempFiles.push(userFile, runnerFile);
        command = 'python3';
        args = ['-u', runnerFile, userFile]; // -u: unbuffered → 출력/센티넬 순서 보존
      } else if (lang === 'ruby') {
        const userFile = path.join(this.tempDir, `dbg-user-${stamp}.rb`);
        const runnerFile = path.join(this.tempDir, `dbg-runner-${stamp}.rb`);
        fs.writeFileSync(userFile, code, 'utf8');
        fs.writeFileSync(runnerFile, this.buildRubyRunner(), 'utf8');
        tempFiles.push(userFile, runnerFile);
        command = 'ruby';
        args = [runnerFile, userFile];
      } else if (lang === 'bash') {
        const userFile = path.join(this.tempDir, `dbg-user-${stamp}.sh`);
        const runnerFile = path.join(this.tempDir, `dbg-runner-${stamp}.sh`);
        fs.writeFileSync(userFile, code, 'utf8');
        fs.writeFileSync(runnerFile, this.buildBashRunner(), 'utf8');
        tempFiles.push(userFile, runnerFile);
        command = 'bash';
        args = [runnerFile, userFile];
      } else if (lang === 'javascript') {
        let instrumented;
        try {
          instrumented = this.instrumentJavaScript(code);
        } catch (e) {
          // 파싱 실패(문법 오류 등) → 일반 실행으로 폴백해 에러를 그대로 노출
          if (/Cannot find module 'acorn'/.test(String(e && e.message))) {
            send({ type: 'error', data: '디버그 모듈(acorn)이 설치되지 않았습니다.\n' });
            send({ type: 'close', exitCode: -1, hasError: true });
            return res.end();
          }
          send({ type: 'error', data: `코드를 분석할 수 없습니다: ${e.message}\n` });
          send({ type: 'close', exitCode: -1, hasError: true });
          return res.end();
        }
        const userFile = path.join(this.tempDir, `dbg-${stamp}.js`);
        fs.writeFileSync(userFile, instrumented, 'utf8');
        tempFiles.push(userFile);
        command = 'node';
        args = [userFile];
      } else {
        send({ type: 'error', data: `디버그를 지원하지 않는 언어입니다: ${lang}\n` });
        send({ type: 'close', exitCode: -1, hasError: true });
        return res.end();
      }
    } catch (err) {
      tempFiles.forEach((f) => this.cleanupFile(f));
      send({ type: 'error', data: `파일 생성 오류: ${err.message}\n` });
      send({ type: 'close', exitCode: -1, hasError: true });
      return res.end();
    }

    const SENTINEL_RE = /^\x01CPT_LINE:(-?\d+)\x01$/;
    let finished = false;
    let triedFallback = false;

    const start = (cmd) => {
      const proc = spawn(cmd, args, { cwd: '/tmp', env: { PATH: process.env.PATH }, shell: false });
      let stdoutBuf = '';
      let errorBuffer = '';
      let hasError = false;

      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        proc.kill('SIGTERM');
        send({ type: 'error', data: '\n⏱️ 실행 시간이 30초를 초과하여 종료되었습니다.\n' });
        send({ type: 'close', exitCode: -1, hasError: true, message: '실행 시간 초과' });
        res.end();
        tempFiles.forEach((f) => this.cleanupFile(f));
      }, 30000);

      // stdout 라인 버퍼링 → 센티넬은 trace, 그 외는 output
      const flushLine = (line) => {
        const m = SENTINEL_RE.exec(line);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n === -1) {
            send({ type: 'error', data: `\n⛔ 최대 실행 스텝(${ExecutorService.MAX_TRACE_STEPS})을 초과했습니다.\n` });
          } else {
            send({ type: 'trace', line: n });
          }
        } else {
          send({ type: 'output', data: line + '\n' });
        }
      };

      proc.stdout.on('data', (data) => {
        stdoutBuf += data.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          flushLine(line);
        }
      });

      proc.stderr.on('data', (data) => {
        errorBuffer += data.toString();
        hasError = true;
      });

      proc.on('close', (exitCode) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        tempFiles.forEach((f) => this.cleanupFile(f));
        if (stdoutBuf) flushLine(stdoutBuf); // 마지막 미완 라인
        if (errorBuffer) {
          const cleaned = this.parseNodeError(errorBuffer);
          // 스텝 초과 시 던진 내부 마커는 사용자에게 노출하지 않음
          if (cleaned && !/__CPT_MAX_STEPS__/.test(cleaned)) {
            send({ type: 'error', data: cleaned + '\n' });
          }
        }
        send({ type: 'log', message: `프로세스가 종료되었습니다. (종료 코드: ${exitCode})\n` });
        send({ type: 'close', exitCode, hasError: hasError || exitCode !== 0 });
        res.end();
      });

      proc.on('error', (err) => {
        if (finished) return;
        // Python: python3 없으면 python 으로 폴백
        if (lang === 'python' && !triedFallback && err.code === 'ENOENT') {
          triedFallback = true;
          clearTimeout(timeout);
          start('python');
          return;
        }
        finished = true;
        clearTimeout(timeout);
        tempFiles.forEach((f) => this.cleanupFile(f));
        send({ type: 'error', data: `프로세스 실행 오류: ${err.message}\n` });
        send({ type: 'close', exitCode: -1, hasError: true });
        res.end();
      });
    };

    start(command);
  }

  /**
   * 파일 확장자로 언어 판단
   * @param {string} filePath - 파일 경로
   * @returns {string|null} - 언어 이름 또는 null
   */
  detectLanguageFromFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensionToLanguage[ext] || null;
  }

  /**
   * S3 파일 기반 코드 실행 (SSE 스트림)
   * @param {string} code - 코드 내용
   * @param {string} filePath - 파일 경로 (언어 자동 판단용)
   * @param {string} language - 언어 (선택, 없으면 파일 확장자로 판단)
   * @param {object} res - Express 응답 객체
   */
  async executeCodeFromFile(code, filePath, language, res) {
    // 언어 자동 판단
    let detectedLanguage = language;
    if (!detectedLanguage && filePath) {
      detectedLanguage = this.detectLanguageFromFile(filePath);
      if (!detectedLanguage) {
        res.write(`data: ${JSON.stringify({ type: 'error', data: `파일 확장자로 언어를 판단할 수 없습니다: ${filePath}\n` })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'close', exitCode: -1, hasError: true, message: '언어 판단 실패' })}\n\n`);
        res.end();
        return;
      }
    }

    // 기존 executeCode 메서드 재사용
    await this.executeCode(code, detectedLanguage, res);
  }

  /**
   * Node.js stderr에서 순수 JS 에러 메시지만 추출
   * (스택 트레이스, 내부 파일 경로, Node.js 버전 등 노이즈 제거)
   */
  parseNodeError(stderr) {
    const lines = stderr.split('\n');
    // "Error:" 키워드가 처음 등장하는 라인만 추출
    // (ReferenceError, SyntaxError, TypeError 등 모든 에러 타입 포함)
    const errorLine = lines.find(line => /\w*Error:/.test(line));
    return errorLine ? errorLine.trim() : stderr.trim();
  }

  /**
   * 임시 파일 정리
   */
  cleanupFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error('[ExecutorService] 임시 파일 삭제 실패:', err);
    }
  }
}

module.exports = new ExecutorService();

