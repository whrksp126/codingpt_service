const myclassService = require('../services/myclassService');
const githubPushService = require('../services/githubPushService');
const { successResponse, errorResponse } = require('../utils/response');

// 모든 내강의 조회
const getAllMyclass = async (req, res) => {
  const { userId } = req.params;
  try {
    const myclasses = await myclassService.getAllMyclass(userId);
    successResponse(res, myclasses, '내강의 목록을 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('내강의 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

// 특정 상품 수강 여부 조회
const getMyClasstById = async (req, res) => {
  try {
    const { user_id, product_id } = req.query;
    const checkMyclass = await myclassService.getMyClasstById(user_id, product_id);
    successResponse(res, checkMyclass, '내강의 등록 여부를 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('수강 여부 확인 오류:', error);
    errorResponse(res, { message: error.message }, 404);
  }
};

// 내강의 등록
const createMyclass = async (req, res) => {
  try {
    const { user_id, product_id } = req.body;
    const result = await myclassService.createMyclass(user_id, product_id);
    successResponse(res, result, '수강 등록이 완료되었습니다.');
  } catch (error) {
    errorResponse(res, { message: error.message }, 400);
  }
};

// 레슨별 슬라이드 결과값 업데이트
const completeLessonWithResult = async (req, res) => {
  try {
    const { user_id, myclass_id, lesson_id, result } = req.body;
    const data = await myclassService.completeLessonWithResult(user_id, myclass_id, lesson_id, result);

    // 완료 처리(트랜잭션 커밋) 직후, 학습자 GitHub 레포에 산출물 자동 푸시.
    // 결과 화면에 "GitHub 저장됨" 표시를 위해 결과를 응답에 포함하되,
    // 푸시 실패가 완료 응답을 막지 않도록 try/catch 로 감싼다.
    let github = null;
    try {
      const r = await githubPushService.pushLessonForUser(user_id, myclass_id, lesson_id);
      if (r && !r.skipped) {
        console.log(`[github] 산출물 푸시 완료: ${r.repoFullName}/${r.path} (${r.fileCount} files)`);
        github = {
          pushed: true,
          repoFullName: r.repoFullName,
          repoUrl: r.htmlUrl,
          folderUrl: r.folderUrl,
          path: r.path,
          fileCount: r.fileCount,
        };
      }
    } catch (err) {
      console.error('[github] 산출물 자동 푸시 실패:', err.message);
    }

    const payload = data ? { ...data, github } : data;
    successResponse(res, payload, '레슨별 슬라이드 결과값을 성공적으로 업데이트했습니다.');
  }
  catch (error) {
    console.error('레슨별 슬라이드 결과값 업데이트 오류:', error);
    errorResponse(res, error, 500);
  }
};

// 특정 레슨 결과 조회
const getLessonResult = async (req, res) => {
  try {
    const { userId, lessonId } = req.params;
    const result = await myclassService.getLessonResult(userId, lessonId);
    successResponse(res, result, '특정 레슨 결과를 성공적으로 조회했습니다.');
  }
  catch (error) {
    console.error('특정 레슨 결과 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

module.exports = {
    getAllMyclass,
    getMyClasstById,
    createMyclass,
    completeLessonWithResult,
    getLessonResult
  }; 