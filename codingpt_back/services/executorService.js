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

    this.languageConfigs = {
      javascript: {
        extension: '.js',
        command: 'node',
        name: 'JavaScript'
      },
      python: {
        extension: '.py',
        command: 'python3',
        fallbackCommand: 'python',
        name: 'Python'
      },
      c: {
        extension: '.c',
        command: 'gcc',
        compileArgs: ['-o'],
        runCommand: './',
        name: 'C'
      },
      cpp: {
        extension: '.cpp',
        command: 'g++',
        compileArgs: ['-o'],
        runCommand: './',
        name: 'C++'
      },
      java: {
        extension: '.java',
        command: 'javac',
        runCommand: 'java',
        name: 'Java'
      }
    };

    // 확장자 -> 언어 매핑
    this.extensionToLanguage = {
      '.js': 'javascript',
      '.py': 'python',
      '.c': 'c',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.java': 'java'
    };
  }

  /**
   * 코드 실행 (SSE 스트림)
   */
  async executeCode(code, language, res) {
    const lang = language.toLowerCase();
    const langConfig = this.languageConfigs[lang];

    if (!langConfig) {
      throw new Error(`지원하지 않는 언어입니다: ${language}`);
    }

    // SSE 헤더 설정
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 시작 메시지
    res.write(`data: ${JSON.stringify({ type: 'log', message: `${langConfig.name} 코드 실행을 시작합니다...\n` })}\n\n`);

    // 임시 파일 생성
    const tempFile = path.join(
      this.tempDir,
      `code-${Date.now()}-${Math.random().toString(36).substring(7)}${langConfig.extension}`
    );

    try {
      fs.writeFileSync(tempFile, code, 'utf8');

      let command = langConfig.command;
      let args = [tempFile];

      // 프로세스 실행
      const process = spawn(command, args, {
        cwd: '/tmp',
        env: {},
        shell: false
      });

      let outputBuffer = '';
      let errorBuffer = '';
      let hasError = false;
      let isFinished = false;

      if (!process.stdout) {
        res.write(`data: ${JSON.stringify({ type: 'error', data: '프로세스 stdout을 열 수 없습니다.\n' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'close', exitCode: -1, hasError: true, message: '프로세스 실행 실패' })}\n\n`);
        res.end();
        return;
      }

      // 타임아웃 설정 (30초)
      const timeout = setTimeout(() => {
        if (!isFinished) {
          isFinished = true;
          process.kill('SIGTERM');
          res.write(`data: ${JSON.stringify({ type: 'error', data: '\n⏱️ 실행 시간이 30초를 초과하여 종료되었습니다.\n' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'close', exitCode: -1, hasError: true, message: '실행 시간 초과' })}\n\n`);
          res.end();
          this.cleanupFile(tempFile);
        }
      }, 30000);

      // stdout 처리
      process.stdout.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        const lines = output.split('\n');
        lines.forEach((line, index) => {
          if (line || index < lines.length - 1) {
            try {
              res.write(`data: ${JSON.stringify({ type: 'output', data: line + (index < lines.length - 1 ? '\n' : '') })}\n\n`);
            } catch (err) { }
          }
        });
      });

      // stderr 처리 - 버퍼에만 쌓기 (종료 후 정제해서 전송)
      process.stderr.on('data', (data) => {
        const error = data.toString();
        errorBuffer += error;
        hasError = true;
      });

      // 프로세스 종료 처리
      process.on('close', (code, signal) => {
        if (isFinished) return;
        isFinished = true;
        clearTimeout(timeout);
        this.cleanupFile(tempFile);

        try {
          if (errorBuffer) {
            const cleanedError = this.parseNodeError(errorBuffer);
            if (cleanedError) {
              res.write(`data: ${JSON.stringify({ type: 'error', data: cleanedError + '\n' })}\n\n`);
            }
          }
          res.write(`data: ${JSON.stringify({ type: 'log', message: `프로세스가 종료되었습니다. (종료 코드: ${code})\n` })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'close', exitCode: code, hasError: hasError || code !== 0 })}\n\n`);
          res.end();
        } catch (err) { }
      });

      // 프로세스 에러 처리
      process.on('error', (err) => {
        if (isFinished) return;

        // Python fallback 시도
        if (lang === 'python' && langConfig.fallbackCommand && err.code === 'ENOENT') {
          this.runFallbackProcess(langConfig.fallbackCommand, args, tempFile, res);
          return;
        }

        isFinished = true;
        clearTimeout(timeout);
        this.cleanupFile(tempFile);

        try {
          res.write(`data: ${JSON.stringify({ type: 'error', data: `프로세스 실행 오류: ${err.message}\n` })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'close', exitCode: -1, hasError: true, message: '실행 실패' })}\n\n`);
          res.end();
        } catch (writeErr) { }
      });

    } catch (err) {
      this.cleanupFile(tempFile);
      res.write(`data: ${JSON.stringify({ type: 'error', data: `파일 생성 오류: ${err.message}\n` })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'close', exitCode: -1, hasError: true, message: '실행 실패' })}\n\n`);
      res.end();
    }
  }

  /**
   * Python fallback 프로세스 실행
   */
  runFallbackProcess(fallbackCommand, args, tempFile, res) {
    const fallbackProcess = spawn(fallbackCommand, args, {
      cwd: '/tmp',
      env: {},
      shell: false
    });

    let fallbackHasError = false;
    let fallbackFinished = false;

    const fallbackTimeout = setTimeout(() => {
      if (!fallbackFinished) {
        fallbackFinished = true;
        fallbackProcess.kill('SIGTERM');
        res.write(`data: ${JSON.stringify({ type: 'error', data: '\n⏱️ 실행 시간이 30초를 초과하여 종료되었습니다.\n' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'close', exitCode: -1, hasError: true, message: '실행 시간 초과' })}\n\n`);
        res.end();
        this.cleanupFile(tempFile);
      }
    }, 30000);

    fallbackProcess.stdout.on('data', (data) => {
      const output = data.toString();
      const lines = output.split('\n');
      lines.forEach((line, index) => {
        if (line || index < lines.length - 1) {
          try {
            res.write(`data: ${JSON.stringify({ type: 'output', data: line + (index < lines.length - 1 ? '\n' : '') })}\n\n`);
          } catch (err) { }
        }
      });
    });

    let fallbackErrorBuffer = '';
    fallbackProcess.stderr.on('data', (data) => {
      fallbackErrorBuffer += data.toString();
      fallbackHasError = true;
    });

    fallbackProcess.on('close', (fallbackCode) => {
      if (fallbackFinished) return;
      fallbackFinished = true;
      clearTimeout(fallbackTimeout);
      this.cleanupFile(tempFile);

      try {
        if (fallbackErrorBuffer) {
          const cleanedError = this.parseNodeError(fallbackErrorBuffer);
          if (cleanedError) {
            res.write(`data: ${JSON.stringify({ type: 'error', data: cleanedError + '\n' })}\n\n`);
          }
        }
        res.write(`data: ${JSON.stringify({ type: 'close', exitCode: fallbackCode, hasError: fallbackHasError || fallbackCode !== 0 })}\n\n`);
        res.end();
      } catch (err) { }
    });
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

