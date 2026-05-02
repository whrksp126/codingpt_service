import React, { useState, useEffect, useMemo } from 'react';

const WordHighlighting = React.memo(({ text, timestamps, currentTime, isPlaying, onWordClick }) => {
  // 이전 active 단어 인덱스를 추적하여 실제로 변경될 때만 재렌더링
  const prevActiveIndexRef = React.useRef(-1);
  const clickedWordIndexRef = React.useRef(-1);

  if (!timestamps || !timestamps.alignment || !timestamps.alignment.words) {
    // 타임스탬프가 없으면 원본 텍스트만 표시
    return (
      <div className="p-4 bg-gray-50 rounded border border-gray-200">
        <p className="text-base text-gray-800 leading-relaxed">{text}</p>
      </div>
    );
  }

  const words = timestamps.alignment.words;

  // 현재 재생 중인 단어 찾기 (useMemo로 최적화)
  const currentWordIndex = useMemo(() => {
    // 클릭된 단어가 있으면 우선적으로 사용
    if (clickedWordIndexRef.current !== -1) {
      const clickedWord = words[clickedWordIndexRef.current];
      if (clickedWord && Math.abs(currentTime - clickedWord.start) < 0.1) {
        return clickedWordIndexRef.current;
      } else {
        // 시간이 변경되었으면 클릭 상태 초기화
        clickedWordIndexRef.current = -1;
      }
    }
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      // 부동소수점 비교 오차를 고려하여 작은 허용 오차(0.01초) 사용
      const epsilon = 0.01;
      if (currentTime >= word.start - epsilon && currentTime <= word.end + epsilon) {
        return i;
      }
    }
    return -1;
  }, [words, currentTime]);

  // 단어들의 active/past 상태를 useMemo로 계산하여 불필요한 재렌더링 방지
  const wordStates = useMemo(() => {
    return words.map((word, index) => {
      const isActive = currentTime >= word.start && currentTime <= word.end;
      const isPast = currentTime > word.end;
      return { isActive, isPast, index };
    });
  }, [words, currentTime]);

  // 실제로 active 상태가 변경되었는지 확인
  const activeIndexChanged = prevActiveIndexRef.current !== currentWordIndex;
  if (activeIndexChanged) {
    prevActiveIndexRef.current = currentWordIndex;
  }

  return (
    <div className="space-y-4">
      {/* 가사 자막 형식 텍스트 표시 */}
      <div className="p-4 bg-gray-50 rounded border border-gray-200">
        {words.length === 0 ? (
          <p className="text-gray-400 italic">타임스탬프 정보가 없습니다.</p>
        ) : (
          <div className="text-lg leading-relaxed whitespace-pre-wrap">
            {(() => {
              // 원본 텍스트를 기준으로 단어들을 매칭하여 표시
              let textIndex = 0;
              let wordIndex = 0;
              const result = [];
              
              while (wordIndex < words.length) {
                const word = words[wordIndex];
                const wordPos = text.indexOf(word.word, textIndex);
                
                if (wordPos === -1) {
                  // 단어를 찾을 수 없으면 해당 단어를 건너뛰고 다음 단어로 진행
                  wordIndex++;
                  continue;
                }
                
                // 단어 앞의 텍스트 추가 (줄바꿈 포함)
                if (wordPos > textIndex) {
                  result.push({
                    type: 'text',
                    content: text.substring(textIndex, wordPos),
                    key: `text-${textIndex}`
                  });
                }
                
                // 단어 추가 - currentWordIndex를 사용하여 정확히 하나의 단어만 active로 표시
                const isActive = currentWordIndex === wordIndex;
                const isPast = currentWordIndex !== -1 && wordIndex < currentWordIndex;
                const isFuture = currentWordIndex === -1 || wordIndex > currentWordIndex;
                
                result.push({
                  type: 'word',
                  word: word,
                  wordIndex: wordIndex,
                  isActive,
                  isPast,
                  isFuture,
                  key: `word-${wordIndex}`
                });
                
                textIndex = wordPos + word.word.length;
                wordIndex++;
              }
              
              // 남은 텍스트 추가
              if (textIndex < text.length) {
                result.push({
                  type: 'text',
                  content: text.substring(textIndex),
                  key: `text-end`
                });
              }
              
              return result.map((item) => {
                if (item.type === 'text') {
                  return <span key={item.key}>{item.content}</span>;
                } else {
                  const handleWordClick = () => {
                    if (onWordClick && item.word.start !== undefined) {
                      clickedWordIndexRef.current = item.wordIndex;
                      onWordClick(item.word.start);
                    }
                  };
                  
                  let colorClass = 'text-gray-400';
                  if (item.isActive) {
                    colorClass = 'text-blue-600';
                  } else if (item.isPast) {
                    colorClass = 'text-blue-400';
                  }
                  
                  return (
                    <span
                      key={item.key}
                      onClick={handleWordClick}
                      className={`cursor-pointer transition-colors duration-200 font-bold ${colorClass}`}
                    >
                      {item.word.word}
                    </span>
                  );
                }
              });
            })()}
          </div>
        )}
      </div>

      {/* 타임스탬프 테이블 */}
      <div className="p-4 bg-gray-50 rounded border border-gray-200">
        <div className="mb-3 text-sm font-medium text-gray-700">단어 타임스탬프</div>
        {words.length === 0 ? (
          <p className="text-gray-400 italic">타임스탬프 정보가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-700">단어</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-700">시작 시간</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-700">종료 시간</th>
                </tr>
              </thead>
              <tbody>
                {words.map((word, index) => {
                  const isActive = currentWordIndex === index;
                  
                  const handleRowClick = () => {
                    if (onWordClick && word.start !== undefined) {
                      clickedWordIndexRef.current = index;
                      onWordClick(word.start);
                    }
                  };
                  
                  return (
                    <tr
                      key={index}
                      onClick={handleRowClick}
                      className={`border-b border-gray-200 cursor-pointer hover:bg-blue-50 transition-colors ${
                        isActive ? 'bg-yellow-200 font-semibold' : ''
                      }`}
                    >
                      <td className="py-2 px-3 text-sm text-gray-800">{word.word}</td>
                      <td className="py-2 px-3 text-sm text-gray-600">{word.start.toFixed(2)}s</td>
                      <td className="py-2 px-3 text-sm text-gray-600">{word.end.toFixed(2)}s</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // 커스텀 비교 함수: currentTime이 변경되어도 실제로 active 상태가 변경되지 않으면 재렌더링하지 않음
  if (prevProps.text !== nextProps.text) return false;
  if (prevProps.isPlaying !== nextProps.isPlaying) return false;
  if (prevProps.timestamps !== nextProps.timestamps) return false;
  if (prevProps.onWordClick !== nextProps.onWordClick) return false;
  
  // currentTime이 변경되었을 때, 실제로 active 단어가 변경되는지 확인
  if (prevProps.currentTime !== nextProps.currentTime) {
    const prevWords = prevProps.timestamps?.alignment?.words;
    const nextWords = nextProps.timestamps?.alignment?.words;
    
    if (!prevWords || !nextWords) return false;
    
    // 이전과 현재의 active 단어 인덱스 찾기
    let prevActiveIndex = -1;
    let nextActiveIndex = -1;
    
    for (let i = 0; i < prevWords.length; i++) {
      const word = prevWords[i];
      if (prevProps.currentTime >= word.start && prevProps.currentTime <= word.end) {
        prevActiveIndex = i;
        break;
      }
    }
    
    for (let i = 0; i < nextWords.length; i++) {
      const word = nextWords[i];
      if (nextProps.currentTime >= word.start && nextProps.currentTime <= word.end) {
        nextActiveIndex = i;
        break;
      }
    }
    
    // active 단어가 변경되지 않았으면 재렌더링하지 않음
    if (prevActiveIndex === nextActiveIndex) {
      return true; // 같으므로 재렌더링하지 않음
    }
  }
  
  return false; // 재렌더링 필요
});

WordHighlighting.displayName = 'WordHighlighting';

export default WordHighlighting;

