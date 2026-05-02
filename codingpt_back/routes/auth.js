const express = require('express');
const { user } = require('../models');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const router = express.Router();

const ACCESS_SECRET = process.env.ACCESS_SECRET;
const REFRESH_SECRET = process.env.REFRESH_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 구글 계정 로그인 API
router.post('/login', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ message: 'idToken이 필요합니다.' });

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });

    const { sub: google_id, email, name } = ticket.getPayload();

    if (!email || !google_id) {
      return res.status(400).json({ message: 'Invalid Google token' });
    }

    // 사용자 확인 or 생성 (DB 연동)
    let foundUser = await user.findOne({ where: { email } });
    if (!foundUser) {
      foundUser = await user.create({
        email,
        nickname: name,
        google_id,
        created_at: new Date(),
      });
    }
    console.log('신규회원 DB 추가 완료');

    // 🔹 JWT 발급
    const accessToken = jwt.sign(
      { id: foundUser.id, email: foundUser.email }, 
      ACCESS_SECRET, 
      { expiresIn: '60' } // 확인차 60초 설정
    );
    const refreshToken = jwt.sign(
      { id: foundUser.id, email: foundUser.email}, 
      REFRESH_SECRET, 
      { expiresIn: '30d' }
    );

    // (옵션) refreshToken DB 저장
    await user.update({ refresh_token: refreshToken }, { where: { id: foundUser.id } });
    console.log('리프레시토큰 DB 추가 완료');
    //console.log('백엔드 리프레시토큰', refreshToken);
    //console.log('백엔드 엑세스토큰', accessToken);

    res.json({ accessToken, refreshToken });
  } catch (err) {
    console.error('ID Token 검증 실패:', err);
    return res.status(401).json({ message: '유효하지 않은 idToken입니다.' });
  }
});

// accessToken 검증 API
router.get('/me', (req, res) => {
  console.log('[백엔드] 받은 accessToken:', req.headers.authorization);
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: '토큰 없음' });

  const token = authHeader.split(' ')[1];
  try {
    console.log('토큰은 제대로 받는데', token);
    const decoded = jwt.verify(token, ACCESS_SECRET);
    console.log('여기가 문제네 이제', decoded);
    return res.json({
      success: true,
      data: {
        id: decoded.id,
        email: decoded.email,
      },
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: '토큰 만료됨' });
    }

    console.error('JWT 검증 오류:', err.message);
    return res.status(401).json({ message: '토큰 유효하지 않음' });
  }
});

// accessToken 재발급 API
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ message: 'refreshToken 없음' });
  }

  try {
    console.log('재발급 받기 전에 확인할 토큰들');
    console.log(ACCESS_SECRET);
    console.log('----------------');
    console.log(REFRESH_SECRET);
    console.log('----------------');
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);

    const newAccessToken = jwt.sign(
      { id: payload.id, email: payload.email },
      ACCESS_SECRET,
      { expiresIn: '60' } // 확인차 60초 설정
    );
    const verified = jwt.verify(token, ACCESS_SECRET);
    console.log('발급도 검증이 안됨ㅠ', verified);

    console.log('엑세스 토큰 재발급 완료:', newAccessToken);

    return res.json({ accessToken: newAccessToken });
  } catch (err) {
    return res.status(403).json({ message: 'refreshToken이 만료되었거나 유효하지 않음' });
  }
});

module.exports = router;
