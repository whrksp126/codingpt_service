const lessonEditorService = require('../services/lessonEditorService');
const { successResponse, errorResponse } = require('../utils/response');

const handleError = (res, error) => {
  const statusCode = error.statusCode || 500;
  if (error.name === 'ValidationError' && error.issues) {
    return res.status(statusCode).json({
      success: false,
      message: error.message,
      issues: error.issues,
      timestamp: new Date().toISOString(),
    });
  }
  console.error('[lessonEditor] error:', error);
  return errorResponse(res, error, statusCode);
};

const listLessons = async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const data = await lessonEditorService.listLessons({
      search,
      page: parseInt(page, 10) || 1,
      limit: Math.min(parseInt(limit, 10) || 20, 100),
    });
    successResponse(res, data);
  } catch (error) {
    handleError(res, error);
  }
};

const createLesson = async (req, res) => {
  try {
    const data = await lessonEditorService.createLesson(req.body || {});
    successResponse(res, data, '레슨이 생성되었습니다.', 201);
  } catch (error) {
    handleError(res, error);
  }
};

const getLesson = async (req, res) => {
  try {
    const data = await lessonEditorService.getLesson(parseInt(req.params.id, 10));
    successResponse(res, data);
  } catch (error) {
    handleError(res, error);
  }
};

const updateLessonMeta = async (req, res) => {
  try {
    const data = await lessonEditorService.updateLessonMeta(
      parseInt(req.params.id, 10),
      req.body || {},
    );
    successResponse(res, data);
  } catch (error) {
    handleError(res, error);
  }
};

const deleteLesson = async (req, res) => {
  try {
    const data = await lessonEditorService.deleteLesson(parseInt(req.params.id, 10));
    successResponse(res, data, '삭제되었습니다.');
  } catch (error) {
    handleError(res, error);
  }
};

const addSlide = async (req, res) => {
  try {
    const data = await lessonEditorService.addSlide(
      parseInt(req.params.id, 10),
      req.body || {},
    );
    successResponse(res, data, '슬라이드가 추가되었습니다.', 201);
  } catch (error) {
    handleError(res, error);
  }
};

const updateSlideContents = async (req, res) => {
  try {
    const { contents } = req.body || {};
    if (!contents) {
      return res.status(400).json({
        success: false,
        message: 'contents 필드가 필요합니다.',
        timestamp: new Date().toISOString(),
      });
    }
    const data = await lessonEditorService.updateSlideContents(
      parseInt(req.params.id, 10),
      parseInt(req.params.slideId, 10),
      contents,
    );
    successResponse(res, data);
  } catch (error) {
    handleError(res, error);
  }
};

const deleteSlide = async (req, res) => {
  try {
    const data = await lessonEditorService.deleteSlide(
      parseInt(req.params.id, 10),
      parseInt(req.params.slideId, 10),
    );
    successResponse(res, data, '슬라이드가 삭제되었습니다.');
  } catch (error) {
    handleError(res, error);
  }
};

const reorderSlides = async (req, res) => {
  try {
    const { orderedSlideIds } = req.body || {};
    const data = await lessonEditorService.reorderSlides(
      parseInt(req.params.id, 10),
      orderedSlideIds,
    );
    successResponse(res, data);
  } catch (error) {
    handleError(res, error);
  }
};

const listCharacters = async (req, res) => {
  try {
    const data = await lessonEditorService.listCharacters();
    successResponse(res, { characters: data });
  } catch (error) {
    handleError(res, error);
  }
};

const getCodeFillGap = async (req, res) => {
  try {
    const data = await lessonEditorService.getCodeFillGap(parseInt(req.params.slideId, 10));
    successResponse(res, data);
  } catch (error) {
    handleError(res, error);
  }
};

const upsertCodeFillGap = async (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'content (string) 필드가 필요합니다.',
        timestamp: new Date().toISOString(),
      });
    }
    const data = await lessonEditorService.upsertCodeFillGap(
      parseInt(req.params.slideId, 10),
      content,
    );
    successResponse(res, data);
  } catch (error) {
    handleError(res, error);
  }
};

const deleteCodeFillGap = async (req, res) => {
  try {
    const data = await lessonEditorService.deleteCodeFillGap(parseInt(req.params.slideId, 10));
    successResponse(res, data, '삭제되었습니다.');
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  listLessons,
  createLesson,
  getLesson,
  updateLessonMeta,
  deleteLesson,
  addSlide,
  updateSlideContents,
  deleteSlide,
  reorderSlides,
  listCharacters,
  getCodeFillGap,
  upsertCodeFillGap,
  deleteCodeFillGap,
};
