const onboardingService = require('../services/onboardingService');
const { successResponse, errorResponse } = require('../utils/response');

// 온보딩 설문 응답 제출(익명). 로그인 전 호출되며 anon_id 로 식별한다.
const submit = async (req, res) => {
  try {
    const { anonId, job, referralSource, aiExperience, purposes } = req.body;
    const record = await onboardingService.upsertByAnonId({
      anonId,
      job,
      referralSource,
      aiExperience,
      purposes,
    });
    successResponse(res, { id: record.id, anonId: record.anon_id }, '온보딩 응답이 저장되었습니다.');
  } catch (error) {
    console.error('온보딩 응답 저장 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

module.exports = { submit };
