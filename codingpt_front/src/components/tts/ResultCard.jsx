import React, { useState, useCallback, useRef, useEffect } from 'react';
import * as monaco from 'monaco-editor';
import { DownloadSimple, Copy, Check } from '@phosphor-icons/react';
import AudioPlayer from './AudioPlayer';
import WordHighlighting from './WordHighlighting';
import { deleteRequest, saveTTS } from '../../utils/ttsApi';

const ResultCard = ({ request, onDelete, onSave }) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [s3Path, setS3Path] = useState('');
  const [customFileName, setCustomFileName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [editedTimestamps, setEditedTimestamps] = useState(
    request.timestamps ? JSON.stringify(request.timestamps, null, 2) : ''
  );
  const [isCopied, setIsCopied] = useState(false);
  const editorRef = useRef(null);
  const monacoEditorRef = useRef(null);

  useEffect(() => {
    if (editorRef.current) {
      monacoEditorRef.current = monaco.editor.create(editorRef.current, {
        value: editedTimestamps,
        language: 'json',
        theme: 'vs-dark',
        minimap: { enabled: false },
        stickyScroll: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 12,
        lineNumbers: 'on',
        renderWhitespace: 'all',
        tabSize: 2,
        fixedOverflowWidgets: true,
      });

      monacoEditorRef.current.onDidChangeModelContent(() => {
        setEditedTimestamps(monacoEditorRef.current.getValue());
      });

      return () => {
        if (monacoEditorRef.current) {
          monacoEditorRef.current.dispose();
        }
      };
    }
  }, []);

  const handleTimeUpdate = useCallback((time) => {
    if (time !== undefined && time !== null && time >= 0) {
      setCurrentTime(time);
    }
  }, []);

  const handlePlayStateChange = useCallback((playing) => {
    setIsPlaying(playing);
  }, []);

  const handleSeek = useCallback((time) => {
    setCurrentTime(time);
  }, []);

  const handleWordClick = useCallback((startTime) => {
    handleSeek(startTime);
  }, [handleSeek]);

  const handleSave = async () => {
    if (!s3Path.trim()) {
      setSaveError('S3 경로를 입력해주세요.');
      return;
    }

    try {
      setIsSaving(true);
      setSaveError(null);
      const response = await saveTTS(
        request.requestId,
        s3Path.trim(),
        customFileName.trim() || null
      );

      if (response.success) {
        setSaveSuccess(true);
        if (onSave) {
          onSave(request.requestId, response.data);
        }
        setTimeout(() => setSaveSuccess(false), 3000);
      }
    } catch (error) {
      setSaveError(error.message || '저장에 실패했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('정말 이 생성 결과를 삭제하시겠습니까?')) {
      return;
    }

    try {
      setIsDeleting(true);
      await deleteRequest(request.requestId);
      if (onDelete) {
        onDelete(request.requestId);
      }
    } catch (error) {
      alert(error.message || '삭제에 실패했습니다.');
      setIsDeleting(false);
    }
  };

  const handleDownload = async () => {
    try {
      const response = await fetch(request.audioUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = request.fileName || `tts-${request.requestId}.mp3`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('다운로드 실패:', error);
      alert('파일 다운로드에 실패했습니다.');
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(editedTimestamps).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  };

  return (
    <div className="flex flex-col md:flex-row gap-6 border-b border-gray-200 pb-8">
      {/* 좌측 컬럼: 메타데이터, 플레이어, 가사, 컨트롤 */}
      <div className="flex-1 space-y-4 min-w-0">
        <div className="border-b border-gray-100 pb-2">
          <div className="flex justify-between items-start">
            <div className="min-w-0 flex-1">
              <h4 className="font-semibold text-gray-900 truncate pr-2">
                {request.fileName || `생성 결과 #${request.requestId}`}
              </h4>
              <p className="text-xs text-gray-500 mt-1">
                목소리: {request.voiceId} | 모델: {request.modelId}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">
                {new Date(request.createdAt).toLocaleString('ko-KR')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleDownload}
                className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-gray-200"
                title="음성 다운로드"
              >
                <DownloadSimple size={18} weight="bold" />
              </button>
              {request.isSaved && (
                <span className="px-2 py-0.5 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full font-medium">
                  저장됨
                </span>
              )}
            </div>
          </div>
        </div>

        <AudioPlayer
          audioUrl={request.audioUrl}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          onDurationChange={setDuration}
          onTimeUpdate={handleTimeUpdate}
          onPlayStateChange={handlePlayStateChange}
          onSeek={handleSeek}
        />

        {/* 워드 하이라이팅 (노래방 가사) */}
        <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
          <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">노래방 가사</label>
          <WordHighlighting
            text={request.text}
            timestamps={request.timestamps}
            currentTime={currentTime}
            isPlaying={isPlaying}
            onWordClick={handleWordClick}
          />
        </div>

        {/* 저장/삭제 컨트롤 (좌측 하단으로 이동) */}
        <div className="pt-2">
          {!request.isSaved ? (
            <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-3">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-gray-700 mb-1">S3 경로</label>
                  <input
                    type="text"
                    value={s3Path}
                    onChange={(e) => setS3Path(e.target.value)}
                    placeholder="user-123/audio/"
                    className="w-full px-2 py-1.5 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block font-medium text-gray-700 mb-1">파일명</label>
                  <input
                    type="text"
                    value={customFileName}
                    onChange={(e) => setCustomFileName(e.target.value)}
                    placeholder="선택사항"
                    className="w-full px-2 py-1.5 border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex-1 py-1.5 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:bg-gray-300"
                >
                  {isSaving ? '저장 중...' : '저장하기'}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="px-4 py-1.5 border border-red-200 text-red-600 rounded text-xs font-medium hover:bg-red-50 disabled:bg-gray-100"
                >
                  {isDeleting ? '...' : '삭제'}
                </button>
              </div>
              {saveError && <p className="text-[10px] text-red-500">{saveError}</p>}
              {saveSuccess && <p className="text-[10px] text-green-500">성공적으로 저장되었습니다.</p>}
            </div>
          ) : (
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="w-full py-1.5 border border-red-100 text-red-500 rounded text-xs font-medium hover:bg-red-50 transition-colors"
            >
              {isDeleting ? '삭제 중...' : '생성 결과 삭제'}
            </button>
          )}
        </div>
      </div>

      {/* 우측 컬럼: Monaco Editor */}
      <div className="flex-1 flex flex-col min-h-[400px] md:min-h-0 min-w-0">
        <div className="flex justify-between items-center mb-2">
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">타임스탬프 JSON 에디터</label>
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold rounded transition-colors uppercase ${isCopied ? 'text-green-600 bg-green-50 border border-green-200' : 'text-gray-500 hover:bg-gray-100 border border-gray-200 shadow-sm'
              }`}
          >
            {isCopied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
            {isCopied ? 'Copied' : 'Copy JSON'}
          </button>
        </div>
        <div
          ref={editorRef}
          className="flex-1 min-h-[400px] border border-gray-300 rounded-lg overflow-hidden shadow-sm"
        />
      </div>
    </div>
  );
};

export default ResultCard;
