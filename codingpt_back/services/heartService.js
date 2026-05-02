// - 30분 충전 규칙을 계산으로만 처리

const { sequelize, User } = require('../models');

const HEART_MAX = 5;
const REFILL_MINUTES = 30;

class heartService {
    async computeCurrentMissing(hearts_missing, refill_started_at) {
        if (!refill_started_at || hearts_missing === 0) return 0;
        const now = new Date();
        const elapsedMs = now - new Date(refill_started_at);
        const refilled = Math.floor(elapsedMs / (REFILL_MINUTES * 60 * 1000));
        return Math.max(0, hearts_missing - refilled);
    }
    
    async computeNextRefillAt(currentMissing, refill_started_at) {
        if (currentMissing <= 0 || !refill_started_at) return null;
        const now = new Date();
        const elapsedMs = now - new Date(refill_started_at);
        const doneSteps = Math.floor(elapsedMs / (REFILL_MINUTES * 60 * 1000));
        const nextStep = doneSteps + 1;
        const next = new Date(new Date(refill_started_at).getTime() + nextStep * REFILL_MINUTES * 60 * 1000);
        return next;
    }
    
    // 내 하트 조회
    async getHearts(userId) {
        const user = await User.findByPk(userId);
        const currentMissing = await this.computeCurrentMissing(user.heart_missing, user.hearts_refill_started_at);
        const currentHearts = HEART_MAX - currentMissing;

        // 자동 충전이 발생했다면 데이터베이스 업데이트
        if (currentMissing !== user.heart_missing) {
            user.heart_missing = currentMissing;
            user.heart = currentHearts;
            
            // 하트가 완전히 충전되면 타이머 리셋
            if (currentMissing === 0) {
                user.hearts_refill_started_at = null;
            }
            
            await user.save();
        }
        
        const nextRefillAt = await this.computeNextRefillAt(currentMissing, user.hearts_refill_started_at);
        return { 
            currentHearts, // 계산된 값 사용 (시간 경과에 따른 자동 충전 반영)
            nextRefillAt 
        };
    }
    
    // 내 하트 차감 (1개)
    async spendOneHeart(userId) {
        return await sequelize.transaction(async (t) => {
            const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE }); // FOR UPDATE
            // 최신 상태 재계산
            const currentMissing = await this.computeCurrentMissing(user.heart_missing, user.hearts_refill_started_at);
            const currentHearts = HEART_MAX - currentMissing;
            if (currentHearts <= 0) {
            return { ok: false, currentHearts: 0 }; // 이미 0
            }
    
            // 차감 → 부족분 +1
            const newMissing = Math.min(HEART_MAX, currentMissing + 1);
            // 충전 타이머 시작점 결정:
            // - 원래 5개였으면(= currentMissing == 0) 지금부터 타이머 시작
            // - 이미 충전 중이면 기존 시작 시점 유지(부분 충전 진행률 보존)
            const refillStartedAt = (currentMissing === 0) ? new Date() : user.hearts_refill_started_at;
            user.heart_missing = newMissing;
            user.heart = HEART_MAX - newMissing; // heart 필드도 함께 업데이트
            user.hearts_refill_started_at = refillStartedAt;
            await user.save({ transaction: t });
            const afterMissing = await this.computeCurrentMissing(user.heart_missing, user.hearts_refill_started_at);
            const nextRefillAt = await this.computeNextRefillAt(afterMissing, user.hearts_refill_started_at);
            return { ok: true, currentHearts: user.heart, nextRefillAt }; // 업데이트된 heart 필드 값 사용
        });
    }
}
  
module.exports = new heartService();