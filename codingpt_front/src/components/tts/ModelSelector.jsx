import React, { useState, useEffect } from 'react';
import { getModels } from '../../utils/ttsApi';

const ModelSelector = ({ selectedModelId, onModelChange, onModelSelect }) => {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadModels();
  }, []);

  const loadModels = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await getModels();
      if (response.success && response.data?.models) {
        const modelsList = response.data.models;
        setModels(modelsList);
        // 첫 번째 모델을 기본값으로 설정 (부모 컴포넌트에서 선택된 값이 없을 경우)
        if (!selectedModelId && modelsList.length > 0) {
          const firstModel = modelsList[0];
          onModelChange(firstModel.model_id);
          if (onModelSelect) {
            onModelSelect(firstModel);
          }
        } else if (selectedModelId) {
          // 이미 선택된 모델이 있으면 해당 모델 정보 전달
          const selectedModel = modelsList.find((m) => m.model_id === selectedModelId);
          if (selectedModel && onModelSelect) {
            onModelSelect(selectedModel);
          }
        }
      }
    } catch (err) {
      setError('모델 목록을 불러오는데 실패했습니다.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          모델 선택
        </label>
        <div className="flex items-center justify-center p-4">
          <div className="text-gray-500">모델 목록을 불러오는 중...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          모델 선택
        </label>
        <div className="p-4 bg-red-50 border border-red-200 rounded">
          <p className="text-red-600">{error}</p>
          <button
            onClick={loadModels}
            className="mt-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        모델 선택
      </label>
      <div className="flex flex-wrap gap-3">
        {models.map((model) => (
          <label
            key={model.model_id}
            className={`flex items-start gap-2 px-3 py-2 border rounded-md cursor-pointer transition-colors ${
              selectedModelId === model.model_id
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
            }`}
          >
            <input
              type="radio"
              name="model"
              value={model.model_id}
              checked={selectedModelId === model.model_id}
              onChange={(e) => {
                const modelId = e.target.value;
                onModelChange(modelId);
                // 선택된 모델 정보를 부모로 전달
                const selectedModel = models.find((m) => m.model_id === modelId);
                if (selectedModel && onModelSelect) {
                  onModelSelect(selectedModel);
                }
              }}
              className="mt-1 w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-700">
                {model.name}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 mb-1">
                {model.description}
              </div>
              {selectedModelId === model.model_id && (
                <div className="flex flex-wrap gap-2 text-xs text-gray-500 mt-1">
                  {model.language_support && (
                    <span><span className="font-medium">언어:</span> {model.language_support}</span>
                  )}
                  {model.quality && (
                    <span><span className="font-medium">품질:</span> {model.quality}</span>
                  )}
                  {model.speed && (
                    <span><span className="font-medium">속도:</span> {model.speed}</span>
                  )}
                </div>
              )}
            </div>
          </label>
        ))}
      </div>
    </div>
  );
};

export default ModelSelector;

