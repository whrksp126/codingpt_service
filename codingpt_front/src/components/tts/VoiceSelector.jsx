import React, { useState, useEffect } from 'react';
import { getVoices } from '../../utils/ttsApi';

const VoiceSelector = ({ selectedVoiceId, onVoiceChange }) => {
  const [voices, setVoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewingVoiceId, setPreviewingVoiceId] = useState(null);

  useEffect(() => {
    loadVoices();
  }, []);

  const loadVoices = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await getVoices();
      if (response.success && response.data?.voices) {
        const voicesList = response.data.voices;
        setVoices(voicesList);
        // 첫 번째 목소리를 기본값으로 설정 (부모 컴포넌트에서 선택된 값이 없을 경우)
        if (!selectedVoiceId && voicesList.length > 0) {
          onVoiceChange(voicesList[0].voice_id);
        }
      }
    } catch (err) {
      setError('목소리 목록을 불러오는데 실패했습니다.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = (voice) => {
    if (previewingVoiceId === voice.voice_id) {
      // 이미 재생 중이면 중지
      setPreviewingVoiceId(null);
      return;
    }

    if (voice.preview_url) {
      setPreviewingVoiceId(voice.voice_id);
      const audio = new Audio(voice.preview_url);
      audio.play();
      audio.onended = () => setPreviewingVoiceId(null);
      audio.onerror = () => {
        setPreviewingVoiceId(null);
        alert('미리보기 재생에 실패했습니다.');
      };
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-4">
        <div className="text-gray-500">목소리 목록을 불러오는 중...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded">
        <p className="text-red-600">{error}</p>
        <button
          onClick={loadVoices}
          className="mt-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
        >
          다시 시도
        </button>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        목소리 선택
      </label>
      <div className="flex flex-wrap gap-2">
        {voices.map((voice) => (
          <label
            key={voice.voice_id}
            className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-md cursor-pointer transition-colors whitespace-nowrap ${
              selectedVoiceId === voice.voice_id
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
            }`}
          >
            <input
              type="radio"
              name="voice"
              value={voice.voice_id}
              checked={selectedVoiceId === voice.voice_id}
              onChange={(e) => onVoiceChange(e.target.value)}
              className="w-3.5 h-3.5 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
            <span className="text-xs font-medium text-gray-700">
              {voice.name}
              {voice.category === 'premade' && (
                <span className="ml-1 text-gray-500">(기본)</span>
              )}
            </span>
            {voice.preview_url && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handlePreview(voice);
                }}
                className="ml-1 px-1.5 py-0.5 text-[10px] bg-blue-100 text-blue-700 rounded hover:bg-blue-200 whitespace-nowrap"
              >
                {previewingVoiceId === voice.voice_id ? '재생 중...' : '미리보기'}
              </button>
            )}
          </label>
        ))}
      </div>
    </div>
  );
};

export default VoiceSelector;

