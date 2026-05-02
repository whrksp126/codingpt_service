const http = require('http');
const { URL } = require('url');

class ExecuteService {
  constructor() {
    // 코드 실행 서버 URL (환경 변수 또는 기본값)
    this.executorUrl = process.env.CODE_EXECUTOR_URL || 'http://code-executor:5200';
  }

  /**
   * 코드 실행 서버에 HTTP 요청을 보내고 SSE 스트림을 프록시
   * @param {string} code - 실행할 코드
   * @param {string} language - 프로그래밍 언어 (javascript, python)
   * @param {Function} onLog - 로그 콜백 (시작/종료 메시지)
   * @param {Function} onOutput - 출력 콜백 (stdout - 터미널 출력)
   * @param {Function} onError - 에러 콜백 (stderr - 터미널 출력)
   * @param {Function} onClose - 종료 콜백
   */
  async executeCode(code, language, onLog, onOutput, onError, onClose) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.executorUrl}/execute`);
      
      const postData = JSON.stringify({
        code,
        language
      });

      const options = {
        hostname: url.hostname,
        port: url.port || 5200,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        
        // 응답 상태 확인
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', (chunk) => {
            errorBody += chunk.toString();
          });
          res.on('end', () => {
            const errorMsg = `코드 실행 서버 오류 (${res.statusCode}): ${errorBody}`;
            console.error(`[ExecuteService] ${errorMsg}`);
            onError(`${errorMsg}\n`);
            onClose({
              exitCode: -1,
              hasError: true,
              output: '',
              error: errorMsg
            });
            reject(new Error(errorMsg));
          });
          return;
        }

        // SSE 스트림 처리
        let buffer = '';

        res.on('data', (chunk) => {
          const dataStr = chunk.toString();
          buffer += dataStr;
          
          // SSE 메시지 파싱 (data: 로 시작하는 라인)
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 마지막 불완전한 라인은 버퍼에 보관

          for (const line of lines) {
            if (line.trim() === '') continue; // 빈 라인 무시
            
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.substring(6)); // 'data: ' 제거
                
                switch (data.type) {
                  case 'start':
                  case 'log':
                    // 로그 메시지는 onLog로 전달 (터미널 출력 아님)
                    if (data.message && onLog) {
                      onLog(data.message);
                    }
                    break;
                  case 'output':
                    onOutput(data.data);
                    break;
                  case 'error':
                    onError(data.data);
                    break;
                  case 'close':
                    onClose({
                      exitCode: data.exitCode,
                      hasError: data.hasError,
                      output: '',
                      error: '',
                      message: data.message
                    });
                    resolve();
                    return;
                }
              } catch (err) {
                // JSON 파싱 실패는 무시
                console.error(`[ExecuteService] SSE 메시지 파싱 오류:`, err, '원본 라인:', line);
              }
            }
          }
        });

        res.on('end', () => {
          // 스트림 종료 시 버퍼에 남은 데이터 처리
          if (buffer.trim()) {
            const lines = buffer.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));
                  if (data.type === 'close') {
                    onClose({
                      exitCode: data.exitCode,
                      hasError: data.hasError,
                      output: '',
                      error: '',
                      message: data.message
                    });
                  } else if (data.type === 'log') {
                    if (data.message && onLog) {
                      onLog(data.message);
                    }
                  } else if (data.type === 'output') {
                    onOutput(data.data);
                  } else if (data.type === 'error') {
                    onError(data.data);
                  }
                } catch (err) {
                  // 무시
                }
              }
            }
          }
        });

        res.on('error', (err) => {
          console.error(`[ExecuteService] 응답 스트림 오류:`, err);
          onError(`연결 오류: ${err.message}\n`);
          onClose({
            exitCode: -1,
            hasError: true,
            output: '',
            error: err.message
          });
          reject(err);
        });
      });

      req.on('error', (err) => {
        const errorMsg = `코드 실행 서버 연결 실패: ${err.message}. 서버가 실행 중인지 확인하세요. (${this.executorUrl})`;
        console.error(`[ExecuteService] ${errorMsg}`, err);
        onError(`${errorMsg}\n`);
        onClose({
          exitCode: -1,
          hasError: true,
          output: '',
          error: err.message
        });
        reject(err);
      });

      // 요청 전송
      req.write(postData);
      req.end();
    });
  }
}

module.exports = new ExecuteService();
