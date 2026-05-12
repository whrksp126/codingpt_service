const { sequelize, MyClass, MyClassStatus, Product, ProductClassMap, Class, ClassSectionMap, Section, SectionLessonMap, Lesson, Slide, LessonSlideMap, User } = require('../models');
const { SLIDE_TYPE_PRESETS } = require('./lessonSchema');

const XP_PER_LESSON_MAX = 10;

// 슬라이드 타입(role)별 기본 배경을 누락된 슬라이더에 주입
const ensureSliderBackground = (slider) => {
  if (!slider || typeof slider !== 'object') return slider;
  if (slider.background && Array.isArray(slider.background.colors) && slider.background.colors.length > 0) {
    return slider;
  }
  const role = slider.role || 'custom';
  const preset = SLIDE_TYPE_PRESETS[role] || SLIDE_TYPE_PRESETS.custom;
  return { ...slider, background: preset.background };
};

const normalizeSlideContents = (contents) => {
  if (!contents || typeof contents !== 'object') return contents;
  if (Array.isArray(contents.sliders)) {
    return { ...contents, sliders: contents.sliders.map(ensureSliderBackground) };
  }
  return ensureSliderBackground(contents);
};

// 슬라이드 결과에서 채점 대상 모듈의 정답률 계산
function computeCorrectRate(result) {
  if (!Array.isArray(result)) return 1;
  let total = 0;
  let correct = 0;
  for (const slide of result) {
    const modules = slide?.modules;
    if (!Array.isArray(modules)) continue;
    for (const m of modules) {
      if (m && typeof m.isCorrect === 'boolean') {
        total += 1;
        if (m.isCorrect) correct += 1;
      }
    }
  }
  if (total === 0) return 1;
  return correct / total;
}

class MyClassService {
  /**
   * 모든 내강의 조회
   */
  async getAllMyclass(userId) {
    const myclassList = await MyClass.findAll({
      where: { user_id: userId },
      include: [
        {
          model: Product,
          attributes: ['id', 'name', 'description', 'type', 'price', 'lecture_intro'],
          include: [
            {
              model: Class,
              as: 'Classes',
              through: { model: ProductClassMap, attributes: [] },
              include: [
                {
                  model: Section,
                  as: 'Sections',
                  through: { model: ClassSectionMap, attributes: [] },
                  include: [
                    {
                      model: Lesson,
                      as: 'Lessons',
                      through: { model: SectionLessonMap, attributes: [] },
                      include: [
                        {
                          model: Slide,
                          as: 'Slides',
                          through: { model: LessonSlideMap, attributes: ['order_no'] }
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          model: MyClassStatus,
          required: false
        }
      ],
      order: [
        [
          { model: Product },
          { model: Class, as: 'Classes' },
          { model: Section, as: 'Sections' },
          { model: Lesson, as: 'Lessons' },
          { model: Slide, as: 'Slides' },
          LessonSlideMap,
          'order_no',
          'ASC',
        ],
      ],
    });
    
    // 데이터 구조화 + 슬라이드 background 정규화
    return myclassList.map(myclass => {
      const product = myclass.Product.toJSON ? myclass.Product.toJSON() : { ...myclass.Product.dataValues };
      const classes = product.Classes || [];
      for (const cls of classes) {
        for (const section of cls.Sections || []) {
          for (const lesson of section.Lessons || []) {
            for (const slide of lesson.Slides || []) {
              slide.contents = normalizeSlideContents(slide.contents);
            }
          }
        }
      }
      return {
        ...product,
        myclass_id: myclass.id,
        status: myclass.MyClassStatuses || [],
      };
    });
  }
  
  // 특정 상품 수강 여부 조회
  async getMyClasstById(userId, productId) {
        const record = await MyClass.findOne({
            where: {
              user_id: userId,
              product_id: productId,
            },
        });
        return !!record; // true 또는 false 반환
    }

  /**
   * 수강 등록 함수
   * 내강의(myclass) 등록 + 학습상태(myclass_status) 초기화
   */
  async createMyclass(userId, productId) {
    const exists = await MyClass.findOne({
      where: { user_id: userId, product_id: productId }
    });
    if (exists) {
      throw new Error('이미 등록된 강의입니다.');
    }
    const t = await sequelize.transaction(); // 트랜잭션 시작
    try {
      // 1. myclass 생성
      const myclass = await MyClass.create({
        user_id: userId,
        product_id: productId
      }, { transaction: t });

      // 2. 연결된 lesson 전체 조회
      const product = await Product.findByPk(productId, {
        include: [{
          model: Class,
          as: 'Classes',
          through: { model: ProductClassMap, attributes: [] },
          include: [{
            model: Section,
            as: 'Sections',
            through: { model: ClassSectionMap, attributes: [] },
            include: [{
              model: Lesson,
              as: 'Lessons',
              through: { model: SectionLessonMap, attributes: [] }
            }]
          }]
        }],
        transaction: t
      });

      if (!product) {
        throw new Error('상품을 찾을 수 없습니다.');
      }

      const lessonIds = [];

      for (const cls of product.Classes) {
        for (const section of cls.Sections) {
          for (const lesson of section.Lessons) {
            lessonIds.push(lesson.id);
          }
        }
      }

      // 3. myclass_status에 lesson별 학습상태 추가
      const statusData = lessonIds.map(lessonId => ({
        myclass_id: myclass.id,
        lesson_id: lessonId,
        status: 1
      }));

      if (statusData.length > 0) {
        await MyClassStatus.bulkCreate(statusData, { transaction: t });
      }

      await t.commit(); // 성공 시 커밋
      return myclass;
    } catch (error) {
      await t.rollback(); // 실패 시 롤백
      throw error;
    }
  }

  // 레슨별 슬라이드 결과값 업데이트 + 신규 완료 시 XP 적립
  async completeLessonWithResult(user_id, myclass_id, lesson_id, result) {
    if (!user_id || !myclass_id || !lesson_id || !result) {
      throw new Error('필수 파라미터가 누락되었습니다.');
    }

    return await sequelize.transaction(async (t) => {
      const myclassStatus = await MyClassStatus.findOne({
        where: { myclass_id, lesson_id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!myclassStatus) {
        return null;
      }

      const wasCompleted = myclassStatus.status === 2;
      myclassStatus.status = 2;
      myclassStatus.results = result;
      await myclassStatus.save({ transaction: t });

      let addedXp = 0;
      let totalXp = null;

      if (!wasCompleted) {
        const correctRate = computeCorrectRate(result);
        addedXp = Math.round(XP_PER_LESSON_MAX * correctRate);

        if (addedXp > 0) {
          const user = await User.findByPk(user_id, {
            transaction: t,
            lock: t.LOCK.UPDATE,
          });
          if (user) {
            user.xp += addedXp;
            await user.save({ transaction: t });
            totalXp = user.xp;
          }
        }
      }

      if (totalXp === null) {
        const user = await User.findByPk(user_id, {
          attributes: ['xp'],
          transaction: t,
        });
        totalXp = user ? user.xp : 0;
      }

      return {
        status: myclassStatus.status,
        addedXp,
        totalXp,
      };
    });
  }

  // 특정 레슨 결과 조회
  async getLessonResult(userId, lessonId) {
    try {
      // 해당 사용자의 수강 묶음(MyClass)에 속한 lesson의 상태/결과 조회
      const myclassStatus = await MyClassStatus.findOne({
        include: [{
          model: MyClass,
          as: 'MyClass',
          where: { user_id: userId },
          attributes: ['id', 'user_id', 'product_id']
        }],
        where: { lesson_id: lessonId },
        attributes: ['status', 'results'] // result: DB에 저장된 curLesson(JSON)
      });

      if (!myclassStatus) {
        throw new Error('내강의상태가 존재하지 않습니다.');
      }
      console.log('복습 데이터 조회 : ', myclassStatus);
      return myclassStatus;
    } catch (error) {
      console.error('특정 레슨 결과 조회 오류:', error);
      throw error;
    }
  }
}

module.exports = new MyClassService(); 