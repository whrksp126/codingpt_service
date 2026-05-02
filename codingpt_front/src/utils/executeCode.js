import { backendUrl } from './common.js';

/**
 * 코드 실행 함수
 * @param {string} code - 실행할 코드
 * @param {string} language - 언어 ("javascript" | "python")
 * @param {Object} callbacks - 콜백 함수들
 * @param {Function} callbacks.onLog - 로그 이벤트 콜백 (서버 통신 로그)
 * @param {Function} callbacks.onOutput - 출력 이벤트 콜백 (터미널 출력)
 * @param {Function} callbacks.onError - 에러 이벤트 콜백 (터미널 에러 출력)
 * @param {Function} callbacks.onClose - 종료 이벤트 콜백
 * @returns {Function} 중단 함수
 */
export const executeCode = async (code, language, { onLog, onOutput, onError, onClose }) => {
  const apiUrl = `${backendUrl}/api/executor/execute`;
  
  let reader = null;
  let isAborted = false;
  let isStreamActive = false;

  const abort = () => {
    isAborted = true;
    if (reader) {
      reader.cancel().catch(() => {
        // 취소 중 에러는 무시
      });
    }
  };

  try {
    console.log('Starting SSE connection to:', apiUrl);
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        code,
        language,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Content-Type 확인
    const contentType = response.headers.get('Content-Type');
    console.log('Response Content-Type:', contentType);
    
    if (!contentType || !contentType.includes('text/event-stream')) {
      console.warn('Unexpected Content-Type:', contentType, '- proceeding anyway');
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processStream = async () => {
      isStreamActive = true;
      console.log('Stream processing started');
      
      try {
        while (!isAborted && isStreamActive) {
          let readResult;
          try {
            readResult = await reader.read();
          } catch (readError) {
            if (!isAborted) {
              console.error('Error reading stream:', readError);
              onError?.({ type: 'error', data: `Stream read error: ${readError.message}` });
            }
            break;
          }

          const { done, value } = readResult;
          
          if (done) {
            console.log('Stream ended (done=true)');
            // 스트림 종료 시 남은 버퍼 처리
            if (buffer.trim()) {
              processBuffer(buffer);
            }
            break;
          }

          if (isAborted) {
            console.log('Stream aborted');
            break;
          }

          // 청크를 디코딩하고 버퍼에 추가
          try {
            buffer += decoder.decode(value, { stream: true });
          } catch (decodeError) {
            console.error('Error decoding chunk:', decodeError);
            continue;
          }
          
          // 완전한 SSE 메시지들을 처리
          const messages = buffer.split('\n\n');
          // 마지막 메시지는 아직 완성되지 않았을 수 있으므로 버퍼에 유지
          buffer = messages.pop() || '';

          for (const message of messages) {
            if (isAborted) break;
            if (message.trim() === '') continue;
            
            processSSEMessage(message);
          }
        }
      } catch (error) {
        if (!isAborted) {
          console.error('Stream processing error:', error);
          onError?.({ type: 'error', data: `Stream processing error: ${error.message}` });
        }
      } finally {
        isStreamActive = false;
        console.log('Stream processing finished');
        
        // 스트림이 종료되었지만 close 이벤트가 없었다면 명시적으로 호출하지 않음
        // (서버에서 close 이벤트를 보내야 함)
      }
    };

    // SSE 메시지 파싱 및 처리
    const processSSEMessage = (message) => {
      const lines = message.split('\n');
      let eventType = null;
      let data = null;

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          try {
            data = JSON.parse(dataStr);
          } catch (e) {
            console.error('Failed to parse SSE data:', dataStr, e);
            return;
          }
        } else if (line.trim() === '') {
          // 빈 줄은 메시지 구분자
          continue;
        }
      }

      if (!data) {
        return;
      }

      // event 타입이 있으면 사용, 없으면 data.type 사용
      const type = eventType || data.type;

      switch (type) {
        case 'log':
          onLog?.(data);
          break;
        case 'output':
          onOutput?.(data);
          break;
        case 'error':
          onError?.(data);
          break;
        case 'close':
          onClose?.(data);
          break;
        default:
          // data.type으로 폴백
          if (data.type) {
            switch (data.type) {
              case 'log':
                onLog?.(data);
                break;
              case 'output':
                onOutput?.(data);
                break;
              case 'error':
                onError?.(data);
                break;
              case 'close':
                onClose?.(data);
                break;
              default:
                console.warn('Unknown event type:', data.type, data);
            }
          } else {
            console.warn('Unknown SSE message format:', message);
          }
      }
    };

    // 단일 라인 버퍼 처리 (data: 형식)
    const processBuffer = (buffer) => {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const type = data.type;
            switch (type) {
              case 'log':
                onLog?.(data);
                break;
              case 'output':
                onOutput?.(data);
                break;
              case 'error':
                onError?.(data);
                break;
              case 'close':
                onClose?.(data);
                break;
            }
          } catch (e) {
            console.error('Failed to parse buffer data:', line, e);
          }
        }
      }
    };

    // 스트림 처리 시작 - 연결을 유지하기 위해 비동기로 실행
    // await하지 않아도 연결은 유지되지만, 에러 처리를 위해 catch 추가
    const streamPromise = processStream();
    
    streamPromise.catch((error) => {
      if (!isAborted) {
        console.error('Stream processing failed:', error);
        onError?.({ type: 'error', data: `Stream failed: ${error.message}` });
      }
    });

    // 연결 상태 모니터링 (디버깅용)
    console.log('SSE connection established, waiting for events...');

    // 중단 함수 반환
    return abort;
  } catch (error) {
    console.error('Fetch error:', error);
    onError?.({ type: 'error', data: error.message });
    return () => {}; // 빈 중단 함수 반환
  }
};

