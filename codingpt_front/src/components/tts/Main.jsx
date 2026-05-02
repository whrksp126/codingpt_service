import React, { useState } from 'react';
import VoiceSelector from './VoiceSelector';
import ModelSelector from './ModelSelector';
import TextInput from './TextInput';
import SettingsPanel from './SettingsPanel';
import ResultCard from './ResultCard';
import { generateTTS } from '../../utils/ttsApi';

const Main = () => {
  const [voiceId, setVoiceId] = useState('');
  const [modelId, setModelId] = useState('');
  const [text, setText] = useState(`HTML은 햄버거와 같아요.
우리가 보여주고 싶은 내용을
태그(Tag) 라는 빵으로 감싸줘야 해요.`);
  const [settings, setSettings] = useState({});
  const [settingsSchema, setSettingsSchema] = useState({});
  const [requests, setRequests] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);

  // 문서 업데이트: 세션 관리 제거됨
  // 여러 생성 결과는 컴포넌트 상태로 관리

  // 음성 생성
  const handleGenerate = async () => {
    if (!voiceId) {
      setError('목소리를 선택해주세요.');
      return;
    }
    if (!modelId) {
      setError('모델을 선택해주세요.');
      return;
    }
    if (!text.trim()) {
      setError('텍스트를 입력해주세요.');
      return;
    }

    try {
      setIsGenerating(true);
      setError(null);

      // 모델이 지원하는 설정만 필터링 (프론트엔드에서도 필터링 권장)
      // 문서 권장사항: 모델이 지원하지 않는 설정은 자동으로 필터링
      // 문서: settings 객체에 포함된 설정 중 모델이 지원하지 않는 설정은 자동으로 필터링됨
      const filteredSettings = {};
      Object.keys(settings).forEach((key) => {
        const schema = settingsSchema[key];
        if (schema && schema.supported) {
          filteredSettings[key] = settings[key];
        }
      });

      // 문서 업데이트: sessionId 파라미터 제거됨
      const response = await generateTTS(voiceId, modelId, text, filteredSettings);

      if (response.success && response.data) {
        // 생성 결과를 리스트 맨 앞에 추가
        setRequests((prev) => [response.data, ...prev]);
        // 텍스트 초기화 (선택사항)
        // setText('');
      } else {
        throw new Error(response.message || '음성 생성에 실패했습니다.');
      }
    } catch (err) {
      setError(err.message || '음성 생성에 실패했습니다.');
      console.error('음성 생성 실패:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  // 생성 결과 삭제
  const handleDelete = (requestId) => {
    setRequests((prev) => prev.filter((req) => req.requestId !== requestId));
  };

  // 저장 완료 처리
  const handleSave = (requestId, savedData) => {
    setRequests((prev) =>
      prev.map((req) =>
        req.requestId === requestId
          ? { ...req, isSaved: true, ...savedData }
          : req
      )
    );
  };

  // 모델 선택 시 설정 초기화
  // 문서 권장사항: 모델 변경 시 해당 모델의 default_settings로 설정값 초기화
  // 문서 권장사항: 모델 변경 시 해당 모델의 supported_settings로 UI 스키마 업데이트
  const handleModelSelect = (model) => {
    if (model) {
      // 모델의 default_settings로 설정 초기화 (새 객체로 복사하여 참조 문제 방지)
      // 문서: 모델 목록 조회 시 각 모델에 default_settings가 포함됨
      setSettings({ ...(model.default_settings || {}) });
      // 모델의 supported_settings로 스키마 설정
      // 문서: 모델 목록 조회 시 각 모델에 supported_settings가 포함됨
      setSettingsSchema(model.supported_settings || {});
    }
  };

  return (
    <div className="w-full px-6 py-6 space-y-6">
      {/* 설정 영역 */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">설정</h2>
        
        <div className="space-y-4">
          <VoiceSelector selectedVoiceId={voiceId} onVoiceChange={setVoiceId} />
          <ModelSelector 
            selectedModelId={modelId} 
            onModelChange={setModelId}
            onModelSelect={handleModelSelect}
          />
          <SettingsPanel
            settings={settings}
            onSettingsChange={setSettings}
            settingsSchema={settingsSchema}
          />
          <TextInput value={text} onChange={setText} />
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-red-600">
            {error}
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={isGenerating || !voiceId || !text.trim()}
          className="w-full px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {isGenerating ? '생성 중...' : '음성 생성'}
        </button>
      </div>

      {/* 생성 결과 리스트 */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">
          생성 결과 ({requests.length})
        </h2>
        
        {requests.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            아직 생성된 결과가 없습니다. 위의 설정을 입력하고 생성 버튼을 클릭하세요.
          </div>
        ) : (
          <div className="space-y-6">
            {requests.map((request) => (
              <ResultCard
                key={request.requestId}
                request={request}
                onDelete={handleDelete}
                onSave={handleSave}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Main;

