import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';

const AudioPlayer = React.memo(({ audioUrl, currentTime, duration: externalDuration, isPlaying: externalIsPlaying, onDurationChange, onTimeUpdate, onPlayStateChange, onSeek }) => {
  const audioRef = useRef(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [displayTime, setDisplayTime] = useState(currentTime);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      if (audio.duration && onDurationChange) {
        onDurationChange(audio.duration);
      }
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [onDurationChange]);

  const isPlayingRef = useRef(externalIsPlaying);
  
  useEffect(() => {
    isPlayingRef.current = externalIsPlaying;
  }, [externalIsPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // 재생 상태가 실제로 변경되었을 때만 처리
    if (externalIsPlaying && audio.paused) {
      audio.play().catch(console.error);
    } else if (!externalIsPlaying && !audio.paused) {
      audio.pause();
    }
  }, [externalIsPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let lastUpdateTime = 0;
    const handleTimeUpdate = () => {
      if (!isSeekingRef.current && onTimeUpdate) {
        const now = Date.now();
        // 부모에게는 100ms마다만 업데이트 (재렌더링 최소화)
        if (now - lastUpdateTime > 100) {
          onTimeUpdate(audio.currentTime);
          lastUpdateTime = now;
        }
      }
    };

    let animationFrameId = null;
    const updateTime = () => {
      if (!isSeekingRef.current && externalIsPlaying && !audio.paused) {
        // 로컬 표시 시간은 매 프레임마다 업데이트 (부드러운 표시)
        setDisplayTime(audio.currentTime);
        
        // 부모에게는 덜 자주 업데이트
        if (onTimeUpdate) {
          const now = Date.now();
          if (now - lastUpdateTime > 100) {
            onTimeUpdate(audio.currentTime);
            lastUpdateTime = now;
          }
        }
        
        animationFrameId = requestAnimationFrame(updateTime);
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    
    // 재생 중일 때 requestAnimationFrame으로 더 부드럽게 업데이트
    if (externalIsPlaying && !audio.paused) {
      animationFrameId = requestAnimationFrame(updateTime);
    }

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [onTimeUpdate, externalIsPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !onPlayStateChange) return;

    const handlePlay = () => {
      // 이미 재생 중이면 중복 호출 방지
      if (!isPlayingRef.current) {
        onPlayStateChange(true);
      }
    };
    
    const handlePause = () => {
      // 이미 일시정지 상태면 중복 호출 방지
      if (isPlayingRef.current) {
        onPlayStateChange(false);
      }
    };
    
    const handleEnded = () => {
      if (isPlayingRef.current) {
        onPlayStateChange(false);
      }
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [onPlayStateChange]);

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      audio.play().catch(console.error);
    } else {
      audio.pause();
    }
  }, []);

  const seekToTime = useCallback((time) => {
    const audio = audioRef.current;
    if (!audio) return;

    setIsSeeking(true);
    audio.currentTime = time;
    
    if (onSeek) {
      onSeek(time);
    }

    setTimeout(() => {
      setIsSeeking(false);
    }, 100);
  }, [onSeek]);

  // 단어 클릭 등 큰 폭의 시간 변경 시 오디오 엘리먼트 업데이트
  const prevCurrentTimeRef = useRef(currentTime);
  const isSeekingRef = useRef(isSeeking);
  
  useEffect(() => {
    isSeekingRef.current = isSeeking;
  }, [isSeeking]);
  
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      prevCurrentTimeRef.current = currentTime;
      return;
    }

    if (isSeeking) {
      prevCurrentTimeRef.current = currentTime;
      return;
    }

    // 재생 중일 때는 동기화하지 않음 (자연스러운 재생 유지)
    if (externalIsPlaying && !audio.paused) {
      prevCurrentTimeRef.current = currentTime;
      return;
    }

    const prevTime = prevCurrentTimeRef.current;
    const diff = Math.abs(currentTime - prevTime);
    
    // 큰 폭의 변경만 처리 (단어 클릭 등)
    if (diff > 0.5) {
      setIsSeeking(true);
      audio.currentTime = currentTime;
      setDisplayTime(currentTime);
      
      setTimeout(() => {
        setIsSeeking(false);
      }, 200);
    }
    
    prevCurrentTimeRef.current = currentTime;
  }, [currentTime, isSeeking, externalIsPlaying]);

  const handleSeekBarClick = useCallback((e) => {
    const audio = audioRef.current;
    if (!audio || !externalDuration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const newTime = percentage * externalDuration;

    seekToTime(newTime);
  }, [externalDuration, seekToTime]);

  const formatTime = useCallback((seconds) => {
    if (isNaN(seconds) || seconds === undefined || seconds === null) return '00:00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const centiseconds = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${centiseconds.toString().padStart(2, '0')}`;
  }, []);

  // 외부 currentTime이 변경되면 displayTime도 동기화
  useEffect(() => {
    setDisplayTime(currentTime);
  }, [currentTime]);

  const timeDisplay = useMemo(() => {
    return `${formatTime(displayTime)} / ${formatTime(externalDuration)}`;
  }, [displayTime, externalDuration, formatTime]);

  const progressPercentage = useMemo(() => {
    if (!externalDuration || externalDuration === 0) return 0;
    return (displayTime / externalDuration) * 100;
  }, [displayTime, externalDuration]);

  if (!audioUrl) {
    return (
      <div className="p-4 text-center text-gray-500">
        오디오 파일이 없습니다.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
      
      <div className="flex items-center gap-2">
        <button
          onClick={togglePlayPause}
          className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {externalIsPlaying ? (
            <>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>일시정지</span>
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
              <span>재생</span>
            </>
          )}
        </button>
        
        <div className="text-sm text-gray-600 min-w-[80px] text-right">
          {timeDisplay}
        </div>
      </div>

    </div>
  );
}, (prevProps, nextProps) => {
  if (prevProps.audioUrl !== nextProps.audioUrl) return false;
  if (prevProps.isPlaying !== nextProps.isPlaying) return false;
  if (prevProps.onDurationChange !== nextProps.onDurationChange) return false;
  if (prevProps.onTimeUpdate !== nextProps.onTimeUpdate) return false;
  if (prevProps.onPlayStateChange !== nextProps.onPlayStateChange) return false;
  if (prevProps.onSeek !== nextProps.onSeek) return false;
  
  const prevTimeRounded = Math.round(prevProps.currentTime * 100) / 100;
  const nextTimeRounded = Math.round(nextProps.currentTime * 100) / 100;
  if (prevTimeRounded !== nextTimeRounded) return false;
  
  const prevDurationRounded = Math.round(prevProps.duration * 100) / 100;
  const nextDurationRounded = Math.round(nextProps.duration * 100) / 100;
  if (prevDurationRounded !== nextDurationRounded) return false;
  
  return true;
});

AudioPlayer.displayName = 'AudioPlayer';

export default AudioPlayer;
