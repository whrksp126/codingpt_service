const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { computeCodeHash } = require('../utils/codeHash');

// executorService 의 spawn 로직을 buffer 모드로 재구현.
// SSE 객체에 직접 write 하지 않고, 종료 시 { stdout, stderr, exitCode, durationMs, codeHash, language, executedAt } 를 resolve.
//
// 사용처: 어드민이 어떤 모듈의 결과를 "미리 실행해 캐싱" 할 때.
// 학생용 라이브 실행은 그대로 /api/executor/execute SSE 사용.

const TEMP_DIR = path.join(os.tmpdir(), 'code-precompute');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const LANGUAGE_CONFIGS = {
  javascript: { extension: '.js', command: 'node' },
  python: { extension: '.py', command: 'python3', fallbackCommand: 'python' },
};

const DEFAULT_TIMEOUT_MS = 30000;

const cleanupFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) { /* ignore */ }
};

// Node.js stderr 의 스택 트레이스 노이즈 제거 — executorService.parseNodeError 와 동일 정책.
const cleanStderr = (stderr) => {
  if (!stderr) return '';
  const lines = stderr.split('\n');
  const errorLine = lines.find((l) => /\w*Error:/.test(l));
  return (errorLine ? errorLine.trim() : stderr.trim());
};

const spawnOnce = (command, args, options = {}) => new Promise((resolve) => {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let finished = false;

  let proc;
  try {
    proc = spawn(command, args, {
      cwd: '/tmp',
      env: { PATH: process.env.PATH },
      shell: false,
    });
  } catch (err) {
    resolve({ stdout: '', stderr: `프로세스 실행 오류: ${err.message}`, exitCode: -1, durationMs: 0, spawnError: true });
    return;
  }

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    try { proc.kill('SIGTERM'); } catch (_) {}
    resolve({
      stdout,
      stderr: stderr + `\n⏱️ 실행 시간이 ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms 를 초과하여 종료되었습니다.`,
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      timedOut: true,
    });
  }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

  proc.stdout?.on('data', (d) => { stdout += d.toString(); });
  proc.stderr?.on('data', (d) => { stderr += d.toString(); });

  proc.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolve({
      stdout,
      stderr: stderr + `\n프로세스 실행 오류: ${err.message}`,
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      spawnError: err.code === 'ENOENT' ? 'ENOENT' : true,
    });
  });

  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolve({
      stdout,
      stderr: cleanStderr(stderr),
      exitCode: code,
      durationMs: Date.now() - startedAt,
    });
  });
});

const runOnce = async (code, language, options = {}) => {
  const lang = String(language || '').toLowerCase();
  const config = LANGUAGE_CONFIGS[lang];
  if (!config) {
    const err = new Error(`캐시 실행 미지원 언어: ${language}`);
    err.statusCode = 400;
    throw err;
  }

  const tempFile = path.join(
    TEMP_DIR,
    `precompute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${config.extension}`,
  );
  fs.writeFileSync(tempFile, code, 'utf8');

  try {
    let result = await spawnOnce(config.command, [tempFile], options);
    // python3 → python fallback (executorService 와 동일 정책)
    if (result.spawnError === 'ENOENT' && config.fallbackCommand) {
      result = await spawnOnce(config.fallbackCommand, [tempFile], options);
    }
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      codeHash: computeCodeHash(lang, code),
      language: lang,
      executedAt: new Date().toISOString(),
    };
  } finally {
    cleanupFile(tempFile);
  }
};

// 빈칸채우기 순열 실행. concurrency 로 executor 컨테이너 동시 부하 제한.
const runMany = async (jobs, { concurrency = 2, onProgress } = {}) => {
  const results = new Array(jobs.length);
  let done = 0;
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= jobs.length) return;
      const { code, language, key } = jobs[idx];
      try {
        const r = await runOnce(code, language);
        results[idx] = { key, result: r };
      } catch (err) {
        results[idx] = { key, error: err.message || String(err) };
      }
      done += 1;
      if (typeof onProgress === 'function') {
        try { onProgress({ done, total: jobs.length }); } catch (_) {}
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, () => worker());
  await Promise.all(workers);
  return results;
};

module.exports = { runOnce, runMany };
