const { OnboardingResponse } = require('../models');

class OnboardingService {
  // 익명 온보딩 설문 응답 저장(upsert). anon_id 기준으로 1행 유지.
  // 개인화 완료 시점에 호출되므로 completed_at 을 항상 갱신한다.
  async upsertByAnonId({ anonId, job, referralSource, aiExperience, purposes }) {
    if (!anonId) {
      throw new Error('anonId가 필요합니다.');
    }

    const payload = {
      job: job ?? null,
      referral_source: referralSource ?? null,
      ai_experience: aiExperience ?? null,
      purposes: Array.isArray(purposes) ? purposes : null,
      completed_at: new Date(),
    };

    const [record, created] = await OnboardingResponse.findOrCreate({
      where: { anon_id: anonId },
      defaults: { anon_id: anonId, ...payload },
    });

    if (!created) {
      await record.update(payload);
    }

    return record;
  }

  // 로그인 성공 시 익명 응답을 유저에 연결. 해당 anon_id 레코드가 없으면 조용히 무시.
  async linkToUser(anonId, userId) {
    if (!anonId || !userId) return null;

    const record = await OnboardingResponse.findOne({ where: { anon_id: anonId } });
    if (!record) return null;

    // 이미 다른 유저에 연결돼 있으면 덮어쓰지 않음
    if (record.user_id && record.user_id !== userId) return record;

    await record.update({ user_id: userId });
    return record;
  }
}

module.exports = new OnboardingService();
