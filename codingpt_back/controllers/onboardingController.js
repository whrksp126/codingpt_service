const { OnboardingResponse } = require('../models');
const { successResponse, errorResponse } = require('../utils/response');

// POST /api/onboarding — 온보딩 설문 응답 제출(익명). anon_id 기준 upsert.
const submit = async (req, res) => {
  try {
    const { anonId, job, referralSource, aiExperience, purposes } = req.body || {};
    if (!anonId || typeof anonId !== 'string') {
      return errorResponse(res, new Error('익명 식별자(anonId)가 필요합니다.'), 400);
    }

    const values = {
      anon_id: anonId,
      job: job ?? null,
      referral_source: referralSource ?? null,
      ai_experience: aiExperience ?? null,
      purposes: Array.isArray(purposes) ? purposes : [],
      updated_at: new Date(),
    };

    // 같은 기기(anon_id) 재제출이면 갱신, 아니면 생성
    const [row, created] = await OnboardingResponse.findOrCreate({
      where: { anon_id: anonId },
      defaults: values,
    });
    if (!created) await row.update(values);

    return successResponse(res, { id: row.id, anonId: row.anon_id });
  } catch (err) {
    return errorResponse(res, err, 500);
  }
};

module.exports = { submit };
