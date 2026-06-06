const ttsAssetService = require('../services/ttsAssetService');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response');

/**
 * TTS 자산 생성 (생성 + objectstore 영구저장 1단계)
 * POST /api/tts/assets
 * body: { text, voiceId, modelId, settings }
 */
const create = async (req, res) => {
  try {
    const { text, voiceId, modelId, settings, folder } = req.body || {};
    const asset = await ttsAssetService.create({ text, voiceId, modelId, settings, folder });
    return successResponse(res, { success: true, data: asset });
  } catch (error) {
    console.error('[TTSAssetController] 생성 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

/**
 * 파일 기반 TTS 생성 (ObjectStore 브라우저용) — 폴더에 .mp3 + .json 사이드카 작성
 * POST /api/tts/assets/generate-file
 * body: { text, voiceId, modelId, folder, fileName }
 */
const generateFile = async (req, res) => {
  try {
    const { text, voiceId, modelId, folder, fileName } = req.body || {};
    const out = await ttsAssetService.generateToFolder({ text, voiceId, modelId, folder, fileName });
    return successResponse(res, { success: true, data: out });
  } catch (error) {
    console.error('[TTSAssetController] 파일 생성 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

/**
 * 미리듣기 생성 (저장 안 함) — 오디오 base64 + 타임스탬프 반환
 * POST /api/tts/assets/preview  body: { text, voiceId, modelId }
 */
const preview = async (req, res) => {
  try {
    const { text, voiceId, modelId } = req.body || {};
    const out = await ttsAssetService.preview({ text, voiceId, modelId });
    return successResponse(res, { success: true, data: out });
  } catch (error) {
    console.error('[TTSAssetController] 미리듣기 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

/**
 * 미리듣기 결과 저장 (재생성 없이 파일로 기록)
 * POST /api/tts/assets/save-preview  body: { audioBase64, timestamps, duration, text, voiceId, modelId, folder, fileName }
 */
const savePreview = async (req, res) => {
  try {
    const out = await ttsAssetService.savePreview(req.body || {});
    return successResponse(res, { success: true, data: out });
  } catch (error) {
    console.error('[TTSAssetController] 미리듣기 저장 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

/**
 * TTS 자산 목록 (사용처 포함)
 * GET /api/tts/assets?search=&page=&limit=
 */
const list = async (req, res) => {
  try {
    const { search, page, limit } = req.query;
    const result = await ttsAssetService.list({ search, page, limit });
    return paginatedResponse(res, result.data, result.page, result.limit, result.total);
  } catch (error) {
    console.error('[TTSAssetController] 목록 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

/**
 * TTS 자산 단건 조회
 * GET /api/tts/assets/:id
 */
const getById = async (req, res) => {
  try {
    const asset = await ttsAssetService.getById(req.params.id);
    return successResponse(res, { success: true, data: asset });
  } catch (error) {
    console.error('[TTSAssetController] 조회 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

/**
 * TTS 자산 수정 (재생성 → 같은 키 덮어쓰기 → 참조 레슨 자동 반영)
 * PUT /api/tts/assets/:id
 * body: { text?, voiceId?, modelId?, settings? }
 */
const regenerate = async (req, res) => {
  try {
    const { text, voiceId, modelId, settings } = req.body || {};
    const asset = await ttsAssetService.regenerate(req.params.id, { text, voiceId, modelId, settings });
    return successResponse(res, { success: true, data: asset });
  } catch (error) {
    console.error('[TTSAssetController] 수정 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

/**
 * TTS 자산 삭제 (objectstore 객체 + 레코드). 사용 중이면 409 (force=1 로 강제).
 * DELETE /api/tts/assets/:id?force=1
 */
const remove = async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = await ttsAssetService.remove(req.params.id, { force });
    return successResponse(res, { success: true, data: result });
  } catch (error) {
    if (error.statusCode === 409) {
      console.warn('[TTSAssetController] 사용 중 삭제 차단:', error.message);
      return res.status(409).json({
        success: false,
        message: error.message,
        usage: error.usage || [],
        timestamp: new Date().toISOString(),
      });
    }
    console.error('[TTSAssetController] 삭제 오류:', error);
    return errorResponse(res, { message: error.message }, error.statusCode || 500);
  }
};

module.exports = { create, generateFile, preview, savePreview, list, getById, regenerate, remove };
