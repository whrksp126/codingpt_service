const svc = require('../services/githubRepoService');
const { successResponse, errorResponse } = require('../utils/response');

const list = async (req, res) => {
  try {
    successResponse(res, await svc.list());
  } catch (e) {
    errorResponse(res, e, e.statusCode || 500);
  }
};

const create = async (req, res) => {
  try {
    const { name, description, visibility } = req.body || {};
    successResponse(res, await svc.create({ name, description, visibility }), '레포 정의가 생성되었습니다.');
  } catch (e) {
    errorResponse(res, e, e.statusCode || 400);
  }
};

const update = async (req, res) => {
  try {
    const data = await svc.update(parseInt(req.params.id, 10), req.body || {});
    successResponse(res, data, '레포 정의가 수정되었습니다.');
  } catch (e) {
    errorResponse(res, e, e.statusCode || 400);
  }
};

const remove = async (req, res) => {
  try {
    const data = await svc.remove(parseInt(req.params.id, 10));
    successResponse(res, data, '레포 정의가 삭제되었습니다.');
  } catch (e) {
    errorResponse(res, e, e.statusCode || 400);
  }
};

// GET /api/lesson/:lessonId/github/previous-files?repoId=
const previousLessonFiles = async (req, res) => {
  try {
    const lessonId = parseInt(req.params.lessonId || req.params.id, 10);
    const repoId = parseInt(req.query.repoId, 10);
    if (!lessonId || !repoId) {
      const err = new Error('lessonId, repoId 가 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    const data = await svc.getPreviousLessonFiles(lessonId, repoId);
    successResponse(res, data);
  } catch (e) {
    errorResponse(res, e, e.statusCode || 500);
  }
};

module.exports = { list, create, update, remove, previousLessonFiles };
