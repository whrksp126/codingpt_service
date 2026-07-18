const {
  User,
  StudyHeatmapLog,
  MyClass,
  MyClassStatus,
  Review,
  ProductReviewMap,
  TTSRequest,
  TTSSavedFile,
  Product,
  Class,
  Section,
  Lesson,
  ProductClassMap,
  ClassSectionMap,
  SectionLessonMap,
  RefreshSession,
  sequelize,
} = require('../models');
const { fn, col, Op } = require('sequelize');
const crypto = require('crypto');

const ACHIEVEMENT_CATEGORIES = ['HTML', 'CSS', 'JS', 'Python', 'Java', 'Nodejs'];
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const appleAuthService = require('./appleAuthService');
require('dotenv').config();

// 시크릿은 fail-closed — 미설정 시 하드코딩 폴백으로 토큰을 서명하면 누구나 위조 가능하므로 기동 중단.
const ACCESS_SECRET = process.env.ACCESS_SECRET;
const REFRESH_SECRET = process.env.REFRESH_SECRET;
if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error('보안: ACCESS_SECRET / REFRESH_SECRET 환경변수가 설정되지 않았습니다. 서버를 기동하지 않습니다.');
}
// 대칭키(HS256) 고정 — alg=none / RS↔HS 혼동 공격 방지(모든 jwt.verify 에 적용).
const JWT_VERIFY_OPTS = { algorithms: ['HS256'] };
// 액세스 토큰 수명 — env 로 조정(기본 15분). 웹 결제 세션은 짧은 만료로는 끊기므로 정상화.
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const { hashPassword, verifyPassword } = require('../utils/password');
// 로그인 실패(계정 없음) 시에도 동일한 scrypt 비용을 치르기 위한 더미 해시(타이밍 균일화용).
const _DUMMY_HASH = hashPassword('cpt-timing-equalizer-not-a-real-password');

// 모바일 앱↔웹 로그인 핸드오프 — 웹에서 로그인/가입을 마친 뒤 앱으로 토큰을 안전하게 넘기는
//  일회용 코드(메모리, 90초 TTL). 토큰을 URL 에 직접 싣지 않기 위해 코드만 딥링크로 전달한다.
const _handoff = new Map(); // code -> { tokens, exp }
function _handoffPrune() {
  const now = Date.now();
  for (const [c, v] of _handoff) if (v.exp <= now) _handoff.delete(c);
}

// ── 기기별 refresh 세션(폐기 가능·해시 저장) ──────────────────────────────
function _sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// 발급된 refresh 토큰을 세션 테이블에 기록 — 원문 대신 sha256, exp 는 디코드로 채움. best-effort(실패해도 로그인 진행).
async function _recordRefreshSession(userId, refreshToken) {
  try {
    const decoded = jwt.decode(refreshToken);
    const expires_at = decoded && decoded.exp ? new Date(decoded.exp * 1000) : null;
    await RefreshSession.create({ user_id: userId, token_hash: _sha256(refreshToken), expires_at, created_at: new Date() });
  } catch (_) { /* 테이블 부재/중복 등 — 인증 흐름은 막지 않음 */ }
}
// 특정 refresh 토큰의 세션을 폐기(로그아웃/회전 시 구 토큰).
async function _revokeRefreshSession(refreshToken) {
  try { await RefreshSession.update({ revoked_at: new Date() }, { where: { token_hash: _sha256(refreshToken), revoked_at: null } }); } catch (_) { /* noop */ }
}
const GOOGLE_ANDROID_CLIENT_ID = process.env.GOOGLE_ANDROID_CLIENT_ID || 'ENV_NOT_FOUND_GOOGLE_ANDROID_CLIENT_ID';
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || 'ENV_NOT_FOUND_GOOGLE_WEB_CLIENT_ID';

// Google OAuth 클라이언트 생성
const client = new OAuth2Client();

class UserService {
  // Google OAuth 로그인 (자동 회원가입 포함)
  async login(idToken) {
    if(!idToken) {
      throw new Error('idToken이 필요합니다.');
    }

    try {
      // 1. Google ID 토큰 검증
      const ticket = await client.verifyIdToken({
        idToken,
        audience: GOOGLE_WEB_CLIENT_ID,
      });
      console.log('✅ Google 토큰 검증 성공');

      // 2. 토큰 페이로드 추출
      const payload = ticket.getPayload();
      const { sub: google_id, email, name, email_verified } = payload;

      if(!email || !google_id) {
        throw new Error('Google 토큰에서 이메일 또는 Google ID를 찾을 수 없습니다.');
      }
      // 이메일이 검증되지 않은 Google 계정은 이메일 기반 계정 병합에 신뢰하지 않는다(계정 탈취 방지).
      if (email_verified === false) {
        throw new Error('이메일이 확인되지 않은 Google 계정입니다.');
      }
      console.log('✅ Google 토큰 페이로드 추출 성공');

      // 3. 사용자 조회 또는 생성
      let foundUser = await User.findOne({ where: { email } });
      console.log('✅ 사용자 조회 완료:', foundUser ? '기존 사용자' : '새 사용자');
      
      if(!foundUser) {        
        foundUser = await User.create({
          email,
          nickname: name,
          google_id,
          created_at: new Date(),
        });
        console.log('✅ 새 사용자 생성 성공:', foundUser.id);
      }

      // 4. JWT 토큰 생성
      const accessToken = jwt.sign(
        { id: foundUser.id, email: foundUser.email, role: foundUser.role },
        ACCESS_SECRET,
        { expiresIn: ACCESS_TTL }
      );
      const refreshToken = jwt.sign(
        { id: foundUser.id, email: foundUser.email, role: foundUser.role },
        REFRESH_SECRET,
        { expiresIn: '30d' }
      );
      console.log('✅ JWT 토큰 생성 성공');

      // 5. Refresh Token 업데이트
      await User.update({ refresh_token: refreshToken }, { where: { id: foundUser.id } });
      await _recordRefreshSession(foundUser.id, refreshToken);
      console.log('✅ Refresh Token 업데이트 성공');

      return { accessToken, refreshToken };

    } catch (error) {
      // 구체적인 에러 메시지 제공
      if (error.message.includes('Wrong recipient')) {
        throw new Error('Google 클라이언트 ID가 일치하지 않습니다. 토큰 검증 실패.');
      } else if (error.message.includes('Token used too late')) {
        throw new Error('Google 토큰이 만료되었습니다. 다시 로그인해주세요.');
      } else if (error.message.includes('Invalid token')) {
        throw new Error('유효하지 않은 Google 토큰입니다.');
      } else if (error.name === 'SequelizeValidationError') {
        throw new Error('사용자 데이터 생성 중 유효성 검사 실패: ' + error.message);
      } else if (error.name === 'SequelizeUniqueConstraintError') {
        throw new Error('이미 존재하는 사용자입니다.');
      } else if (error.name === 'SequelizeConnectionError') {
        throw new Error('데이터베이스 연결 오류가 발생했습니다.');
      } else {
        console.error('🔍 상세 에러 정보:', {
          name: error.name,
          message: error.message,
          stack: error.stack
        });
        throw new Error(`로그인 처리 중 오류가 발생했습니다: ${error.message}`);
      }
    }
  }

  // Apple 로그인 (자동 회원가입 포함) — 구글 login 과 대칭.
  //  clientName: 첫 로그인 시에만 Apple 이 이름을 주므로 클라이언트가 함께 넘긴다(선택).
  async appleLogin(identityToken, clientName, authorizationCode) {
    if (!identityToken) throw new Error('identityToken이 필요합니다.');

    // 1. Apple 토큰 검증(JWKS) → sub(안정 식별자) + email(비공개 릴레이일 수 있음) + aud(client_id)
    const { sub: apple_id, email, aud: appleClientId } = await appleAuthService.verifyIdentityToken(identityToken);

    // 1-b. authorizationCode 가 오면 refresh_token 으로 교환해 둔다(탈퇴 시 revoke 에 필요 — 5.1.1(v)).
    //  최초 로그인에만 code 가 오므로, 얻은 값이 있을 때만 저장한다.
    const appleRefreshToken = authorizationCode
      ? await appleAuthService.exchangeAuthCode(authorizationCode, appleClientId)
      : null;

    // 2. 사용자 조회: apple_id(정본) 우선 → 이메일(기존 구글 계정과 자동 연결)
    let foundUser = await User.findOne({ where: { apple_id } });
    if (!foundUser && email) {
      foundUser = await User.findOne({ where: { email } });
      if (foundUser && !foundUser.apple_id) {
        // 같은 이메일의 기존 계정에 Apple 식별자 연결(구글↔애플 통합).
        await User.update({ apple_id }, { where: { id: foundUser.id } });
      }
    }

    // 3. 없으면 생성. 이메일 비공개 릴레이일 수도 있고, 이름은 첫 로그인에만 오므로 폴백 처리.
    if (!foundUser) {
      const nickname = (clientName && String(clientName).trim())
        || (email ? String(email).split('@')[0] : '사용자');
      foundUser = await User.create({
        email: email || `${apple_id}@privaterelay.appleid.com`,
        nickname,
        apple_id,
        login_type: 'apple',
        created_at: new Date(),
      });
    }

    // 3-b. Apple refresh_token 교환에 성공했으면 저장(탈퇴 시 revoke 용). client_id 도 함께.
    if (appleRefreshToken) {
      await User.update(
        { apple_refresh_token: appleRefreshToken, apple_client_id: appleClientId },
        { where: { id: foundUser.id } }
      );
    }

    // 4. JWT 발급 + refresh 저장 (구글 경로와 동일 규칙)
    const accessToken = jwt.sign(
      { id: foundUser.id, email: foundUser.email, role: foundUser.role },
      ACCESS_SECRET,
      { expiresIn: ACCESS_TTL }
    );
    const refreshToken = jwt.sign(
      { id: foundUser.id, email: foundUser.email, role: foundUser.role },
      REFRESH_SECRET,
      { expiresIn: '30d' }
    );
    await User.update({ refresh_token: refreshToken }, { where: { id: foundUser.id } });
    await _recordRefreshSession(foundUser.id, refreshToken);

    return { accessToken, refreshToken };
  }

  // 로컬 ID/PW 로그인 — 카드사 심사용 계정 전용(password_hash 있는 계정만).
  async loginLocal(email, password) {
    if (!email || !password) throw new Error('이메일과 비밀번호가 필요합니다.');
    const user = await User.findOne({ where: { email } });
    // 타이밍 사이드채널 방지 — 계정이 없어도 동일하게 scrypt 를 한 번 돌려 응답 시간을 균일화(이메일 존재 노출 차단).
    if (!user || !user.password_hash) {
      verifyPassword(password, _DUMMY_HASH);
      throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    if (!verifyPassword(password, user.password_hash)) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');

    const accessToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      ACCESS_SECRET,
      { expiresIn: ACCESS_TTL },
    );
    const refreshToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      REFRESH_SECRET,
      { expiresIn: '30d' },
    );
    await User.update({ refresh_token: refreshToken }, { where: { id: user.id } });
    await _recordRefreshSession(user.id, refreshToken);
    return { accessToken, refreshToken };
  }

  // 유저에게 새 토큰 쌍을 발급하고 refresh_token 저장 (공용 헬퍼).
  _issueTokens(user) {
    const payload = { id: user.id, email: user.email, role: user.role };
    const accessToken = jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
    const refreshToken = jwt.sign(payload, REFRESH_SECRET, { expiresIn: '30d' });
    return { accessToken, refreshToken };
  }

  // 이메일/비밀번호 회원가입 — 일반 사용자용. login_type='local', scrypt 해시 저장.
  async registerLocal(email, password, nickname) {
    const em = String(email || '').trim().toLowerCase();
    const pw = String(password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error('올바른 이메일 형식이 아니에요.');
    if (pw.length < 8) throw new Error('비밀번호는 8자 이상이어야 해요.');
    const existing = await User.findOne({ where: { email: em } });
    if (existing) throw new Error('이미 가입된 이메일이에요. 로그인해 주세요.');
    const nick = String(nickname || '').trim().slice(0, 40) || em.split('@')[0];
    const user = await User.create({
      email: em,
      password_hash: hashPassword(pw),
      login_type: 'local',
      nickname: nick,
      role: 'user',
      created_at: new Date(),
    });
    const tokens = this._issueTokens(user);
    await User.update({ refresh_token: tokens.refreshToken }, { where: { id: user.id } });
    await _recordRefreshSession(user.id, tokens.refreshToken);
    return tokens;
  }

  // 핸드오프 코드 발급 — 로그인된 유저(req.user)에게 새 토큰 쌍을 만들어 일회용 코드로 보관.
  async issueHandoff(userId) {
    const user = await User.findByPk(userId);
    if (!user) throw new Error('사용자를 찾을 수 없어요.');
    const tokens = this._issueTokens(user);
    await User.update({ refresh_token: tokens.refreshToken }, { where: { id: user.id } });
    await _recordRefreshSession(user.id, tokens.refreshToken);
    _handoffPrune();
    const code = require('crypto').randomBytes(24).toString('hex');
    _handoff.set(code, { tokens, exp: Date.now() + 90 * 1000 });
    return { code };
  }

  // 핸드오프 코드 교환 — 앱이 딥링크로 받은 코드를 토큰으로 교환(1회용, 소진 시 삭제).
  async redeemHandoff(code) {
    _handoffPrune();
    const entry = _handoff.get(String(code || ''));
    if (!entry) throw new Error('만료되었거나 잘못된 코드예요. 다시 시도해 주세요.');
    _handoff.delete(code);
    return entry.tokens;
  }

  // 비밀번호 찾기(재설정 요청) — 스캐폴드.
  //  · 계정 존재 여부를 노출하지 않도록 항상 동일 응답(user enumeration 방지).
  //  · 메일 발송 인프라는 아직 미구축 → pending:true 로 "준비 중" 안내. 발송 연동 시
  //    여기서 재설정 토큰 생성 + 메일 발송(예: 재설정 링크 codingpt.ghmate.com/reset-password?token=)만 추가하면 됨.
  async forgotPassword(email) {
    const em = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error('올바른 이메일 형식이 아니에요.');
    // TODO(email): 가입된 local 계정이면 재설정 토큰 발급 후 메일 발송.
    //   const user = await User.findOne({ where: { email: em, login_type: 'local' } });
    //   if (user) { const token = ...; await sendResetEmail(em, token); }
    return { pending: true };
  }

  // 로그아웃 — refreshToken 을 함께 받으면 그 기기 세션만 폐기(다기기 유지). 없으면 레거시 동작(만료 대기).
  async logout(authHeader, refreshToken) {
    try {
      if (!authHeader) {
        throw new Error('토큰이 필요합니다.');
      }

      const token = authHeader.split(' ')[1];
      if (!token) {
        throw new Error('토큰 형식이 잘못되었습니다.');
      }

      // Access Token 검증
      const decoded = jwt.verify(token, ACCESS_SECRET, JWT_VERIFY_OPTS);
      console.log('✅ 토큰 검증 성공:', decoded.id);

      // 이 기기의 refresh 세션만 폐기(제공된 경우) — 다른 기기 로그인은 유지.
      if (refreshToken) await _revokeRefreshSession(refreshToken);
      console.log('✅ 로그아웃 성공:', decoded.id);

      return { message: '로그아웃이 완료되었습니다.' };
    } catch (error) {
      console.error('로그아웃 오류:', error);
      throw new Error('토큰이 유효하지 않습니다.');
    }
  }

  // 엑세스 토큰 검증
  async verifyAccessToken(token) {
    let decoded;
    try {
      decoded = jwt.verify(token, ACCESS_SECRET, JWT_VERIFY_OPTS);
    } catch (err) {
      console.error('JWT 검증 오류:', err.message);
      throw new Error('토큰이 유효하지 않습니다.');
    }
    // 서명만 믿으면 탈퇴한 계정의 토큰이 만료 전까지 "유효"로 남는다 — 유저 실존까지 확인
    //  (앱이 시작 시 verify 로 세션을 판정하므로, 탈퇴 후 재시작하면 여기서 로그인 화면으로 떨어진다).
    const dbUser = await User.findByPk(decoded.id, { attributes: ['id'] });
    if (!dbUser) throw new Error('존재하지 않는 계정입니다.');
    return decoded;
  }
  
  // 엑세스 토큰 재발급
  // 기한 임박 시 리프레시 토큰 재발급
  async refreshAccessToken(refreshToken) {
    if(!refreshToken || refreshToken === '') {
      throw new Error('refreshToken 없음');
    }
    try {
      // 실제 리프레시 토큰의 exp 값 확인
      //const decoded = jwt.decode(refreshToken, { complete: true });
      //console.log('refreshToken payload:', decoded.payload);

      const decoded = jwt.verify(refreshToken, REFRESH_SECRET, JWT_VERIFY_OPTS);
      const now = Math.floor(Date.now() / 1000); // 현재 시간 (초)

      // 어드민 임명/박탈을 즉시 반영하기 위해 role 은 항상 DB 최신값으로 갱신.
      const dbUser = await User.findByPk(decoded.id, { attributes: ['id', 'email', 'role'] });
      // 탈퇴한 계정의 refreshToken 으로 새 토큰을 발급하면 유령 세션이 영속된다 — 재발급 거부.
      if (!dbUser) throw new Error('존재하지 않는 계정입니다.');
      const role = dbUser.role || 'user';

      // 세션 검증 — 폐기된 refresh 토큰(로그아웃/기기 해제/재사용 감지)은 거부.
      //  테이블 도입 전에 발급된 토큰은 세션이 없으므로 lazy 로 등록(기존 로그인 사용자 대량 로그아웃 방지).
      const session = await RefreshSession.findOne({ where: { token_hash: _sha256(refreshToken) } }).catch(() => null);
      if (session) {
        if (session.revoked_at) throw new Error('로그아웃되었거나 폐기된 세션입니다. 다시 로그인해 주세요.');
        await RefreshSession.update({ last_used_at: new Date() }, { where: { id: session.id } }).catch(() => {});
      } else {
        await _recordRefreshSession(decoded.id, refreshToken);
      }

      const newAccessToken = jwt.sign(
        { id: decoded.id, email: decoded.email, role },
        ACCESS_SECRET,
        { expiresIn: ACCESS_TTL }
      );

      const timeRemaining = decoded.exp - now;

      // refreshToken 남은 시간이 1일 미만이면 새로 발급 (테스트)
      let newRefreshToken = null;
      if (timeRemaining < 60 * 60 * 24) {
        newRefreshToken = jwt.sign(
          { id: decoded.id, email: decoded.email, role },
          REFRESH_SECRET,
          { expiresIn: '30d' }
          );
        // DB에 업데이트 + 세션 회전(구 토큰 폐기, 새 토큰 등록 — 단일 사용/재사용 감지).
        await User.update({ refresh_token: newRefreshToken }, { where: { id: decoded.id } });
        await _revokeRefreshSession(refreshToken);
        await _recordRefreshSession(decoded.id, newRefreshToken);
      }

      const response = { accessToken: newAccessToken };
      if (newRefreshToken) response.refreshToken = newRefreshToken;
      return response;
    } catch (err) {
      console.error('Refresh Token 검증 실패:', err);
      if (err.name === 'TokenExpiredError') {
        throw new Error('만료된 refreshToken입니다. 재로그인이 필요합니다.');
      } else if (err.name === 'JsonWebTokenError') {
        throw new Error('위조되었거나 유효하지 않은 refreshToken입니다.');
      } else {
        throw new Error('refreshToken 검증 중 알 수 없는 오류가 발생했습니다.');
      }
    }
  }














  // 사용자 정보 수정 (복잡한 검증 로직 포함)
  async updateUser(id, updateData) {
    const { email, nickname, profile_img } = updateData;
    
    // 1. 사용자 존재 확인
    const user = await User.findByPk(id);
    if (!user) {
      throw new Error('해당 사용자를 찾을 수 없습니다.');
    }
    
    // 2. 이메일 변경 시 중복 확인
    if (email && email !== user.email) {
      const existingUser = await User.findOne({ where: { email } });
      if (existingUser) {
        throw new Error('이미 존재하는 이메일입니다.');
      }
    }
    
    // 3. 업데이트할 필드만 수정
    if (email) user.email = email;
    if (nickname) user.nickname = nickname;
    if (profile_img !== undefined) user.profile_img = profile_img;
    
    await user.save();
    return user;
  }
  
  // 사용자 삭제 (학습 기록 등 사용자 종속 데이터 일괄 정리)
  async deleteUser(id) {
    const user = await User.findByPk(id);
    if (!user) {
      throw new Error('해당 사용자를 찾을 수 없습니다.');
    }

    // Apple 로그인 계정이면 연동 해제(App Store 5.1.1(v) 의무). refresh_token 이 있을 때만 시도하며,
    //  실패해도 탈퇴 자체는 진행한다(revoke 실패로 탈퇴를 막지 않음).
    if (user.apple_refresh_token && user.apple_client_id) {
      await appleAuthService.revokeToken(user.apple_refresh_token, user.apple_client_id);
    }

    await sequelize.transaction(async (t) => {
      // 1. myclass → myclass_status 정리
      const myclasses = await MyClass.findAll({
        where: { user_id: id },
        attributes: ['id'],
        transaction: t,
      });
      const myclassIds = myclasses.map((m) => m.id);
      if (myclassIds.length > 0) {
        await MyClassStatus.destroy({
          where: { myclass_id: myclassIds },
          transaction: t,
        });
        await MyClass.destroy({
          where: { user_id: id },
          transaction: t,
        });
      }

      // 2. review → product_review_map 정리
      const reviews = await Review.findAll({
        where: { user_id: id },
        attributes: ['id'],
        transaction: t,
      });
      const reviewIds = reviews.map((r) => r.id);
      if (reviewIds.length > 0) {
        await ProductReviewMap.destroy({
          where: { review_id: reviewIds },
          transaction: t,
        });
        await Review.destroy({
          where: { user_id: id },
          transaction: t,
        });
      }

      // 3. 학습 히트맵 로그
      await StudyHeatmapLog.destroy({
        where: { user_id: id },
        transaction: t,
      });

      // 4. TTS 데이터 (있을 경우)
      if (TTSSavedFile) {
        await TTSSavedFile.destroy({
          where: { user_id: id },
          transaction: t,
        });
      }
      if (TTSRequest) {
        await TTSRequest.destroy({
          where: { user_id: id },
          transaction: t,
        });
      }

      // 5. 사용자 삭제
      await user.destroy({ transaction: t });
    });

    return true;
  }
  
  // 모든 사용자 조회
  async getAllUsers() {
    return await User.findAll({
      attributes: ['id', 'email', 'nickname', 'profile_img', 'xp', 'created_at']
    });
  }

  // 특정 사용자 조회
  async getUserById(id) {
    const user = await User.findByPk(id, {
      attributes: ['id', 'email', 'nickname', 'profile_img', 'xp', 'created_at']
    });

    if (!user) {
      throw new Error('해당 사용자를 찾을 수 없습니다.');
    }

    return user;
  }

  // XP 업데이트
  async updateUserXp(id, xp) {
    const user = await User.findByPk(id);
    if (!user) {
      throw new Error('해당 사용자를 찾을 수 없습니다.');
    }

    user.xp += xp;
    await user.save();

    return { xp: user.xp };
  }

  // 업적 조회: 카테고리별 심화 레슨 1개라도 완료 시 unlocked
  async getAchievements(userId) {
    const advancedProducts = await Product.findAll({
      where: { difficulty: '심화', category: { [Op.in]: ACHIEVEMENT_CATEGORIES } },
      attributes: ['id', 'category'],
      include: [{
        model: Class,
        as: 'Classes',
        through: { model: ProductClassMap, attributes: [] },
        attributes: ['id'],
        include: [{
          model: Section,
          as: 'Sections',
          through: { model: ClassSectionMap, attributes: [] },
          attributes: ['id'],
          include: [{
            model: Lesson,
            as: 'Lessons',
            through: { model: SectionLessonMap, attributes: [] },
            attributes: ['id'],
          }],
        }],
      }],
    });

    const lessonIdsByCategory = new Map();
    for (const category of ACHIEVEMENT_CATEGORIES) {
      lessonIdsByCategory.set(category, new Set());
    }
    for (const product of advancedProducts) {
      const set = lessonIdsByCategory.get(product.category);
      if (!set) continue;
      for (const cls of product.Classes || []) {
        for (const section of cls.Sections || []) {
          for (const lesson of section.Lessons || []) {
            set.add(lesson.id);
          }
        }
      }
    }

    const allLessonIds = new Set();
    for (const set of lessonIdsByCategory.values()) {
      for (const id of set) allLessonIds.add(id);
    }

    let completedLessonIds = new Set();
    if (allLessonIds.size > 0) {
      const completed = await MyClassStatus.findAll({
        attributes: ['lesson_id'],
        where: {
          status: 2,
          lesson_id: { [Op.in]: Array.from(allLessonIds) },
        },
        include: [{
          model: MyClass,
          attributes: [],
          where: { user_id: userId },
          required: true,
        }],
        raw: true,
      });
      completedLessonIds = new Set(completed.map((r) => r.lesson_id));
    }

    return ACHIEVEMENT_CATEGORIES.map((code) => {
      const categoryLessons = lessonIdsByCategory.get(code) || new Set();
      let unlocked = false;
      for (const id of categoryLessons) {
        if (completedLessonIds.has(id)) {
          unlocked = true;
          break;
        }
      }
      return { code, unlocked };
    });
  }

  // 학습 히트맵 데이터 조회 함수
  async getStudyHeatmap(userId) {
    // 현재 날짜 기준으로 6개월 전 1일 ~ 이번 달 말일까지 범위 계산
    const today = new Date();
    const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); // 이번 달 마지막 날
    const startDate = new Date(today.getFullYear(), today.getMonth() - 5, 1); // 6개월 전 1일
  
    const results = await StudyHeatmapLog.findAll({
      attributes: [
        [fn('DATE', col('created_at')), 'date'],
        [fn('COUNT', col('id')), 'count'],
      ],
      where: {
        user_id: userId,
        created_at: {
          [Op.between]: [startDate, endDate],
        },
      },
      group: [fn('DATE', col('created_at'))],
      order: [[fn('DATE', col('created_at')), 'ASC']],
      raw: true,
    });
    //console.log('userService : ', results);
    // count를 숫자형으로 변환해서 반환
    const parsed = results.map(item => ({
      date: item.date,
      count: Number(item.count),
    }));
    return parsed; // [{ date: '2025-04-02', count: 2 }, ...]
  };

  // 누적 학습일수 조회 (전체 기간, distinct date 카운트)
  async getTotalStudyDays(userId) {
    const result = await StudyHeatmapLog.findOne({
      attributes: [
        [fn('COUNT', fn('DISTINCT', fn('DATE', col('created_at')))), 'studyDays'],
      ],
      where: { user_id: userId },
      raw: true,
    });
    return Number(result?.studyDays ?? 0);
  };

  // 학습 히트맵 로그 생성
  async createStudyHeatmap(user_id, product_id, section_id, lesson_id, created_at) {
    try {
      const data = await StudyHeatmapLog.create({ user_id, product_id, section_id, lesson_id, created_at });
      if (data) {
        return data;
      } else {
        throw new Error('학습 히트맵 로그 생성 실패');
      }
    } catch (error) {
      console.error('학습 히트맵 로그 생성 오류:', error);
      throw new Error('학습 히트맵 로그 생성 오류');
    }
  }
}


module.exports = new UserService(); 