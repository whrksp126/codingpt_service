const { sequelize, MyClass, MyClassStatus, Product, ProductClassMap, Class, ClassSectionMap, Section, SectionLessonMap, Lesson, Slide, LessonSlideMap } = require('../models');

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
                          through: { model: LessonSlideMap, attributes: [] }
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
      ]
    });
    
    // 데이터 구조화
    return myclassList.map(myclass => ({
      ...myclass.Product.dataValues,
      myclass_id: myclass.id,
      status: myclass.MyClassStatuses || []
    }));
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

  // 레슨별 슬라이드 결과값 업데이트
  async completeLessonWithResult(user_id, myclass_id, lesson_id, result) {
    try {
      if (!user_id || !myclass_id || !lesson_id || !result) {
        throw new Error('필수 파라미터가 누락되었습니다.');
      }

      // 1) 내강의상태(myclass_status) 조회
      let myclassStatus = await MyClassStatus.findOne({ 
        where: { myclass_id: myclass_id, lesson_id } 
      });
      
      if (myclassStatus) {
        myclassStatus.status = 2;       // 학습 완료
        myclassStatus.results = result; // 슬라이드 결과값
        await myclassStatus.save();
        return myclassStatus;
      } else {
        return null;
      }
    } catch (error) {
      console.error('레슨별 슬라이드 결과값 DB 오류:', error);
      errorResponse(res, error, 500);
    }
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