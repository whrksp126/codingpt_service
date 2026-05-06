const { StoreCategory, StoreCategoryProductMap, Product, ProductClassMap, Class, ClassSectionMap, Section, SectionLessonMap, Lesson } = require('../models');


class StoreService {
    // 상점 카테고리 및 상품 조회(ALL)
    async getAllCategoriesWithProducts() {
        const categories = await StoreCategory.findAll({
            attributes: ['id', 'name', 'description'],
            include: [
            {
                association: 'Products',
                attributes: ['id', 'name', 'description', 'type', 'price', 'lecture_intro'],
                through: { attributes: [] }, // 매핑 테이블 정보 생략
                where: { is_active: true },
                required: false,
            },
            ],
        });
        return categories;
    }

    /**
     * 스토어 전체 카탈로그 조회
     * - StoreCategory → Products → Classes → Sections → Lessons
     * - 조인 테이블 필드 제거
     * - order_no 기준 정렬(있는 곳만)
     * - 섹션/레슨 개수 집계해서 product 레벨에 추가(sectionCount, lessonCount)
     */
    async getAllProducts() {
        const categories = await StoreCategory.findAll({
            attributes: ['id', 'name', 'description'],
            include: [
              {
                model: Product,
                as: 'Products',
                through: { model: StoreCategoryProductMap, attributes: [] },
                attributes: ['id', 'name', 'description', 'type', 'price', 'lecture_intro'],
                where: { is_active: true },
                required: false,
                include: [
                  {
                    model: Class,
                    as: 'Classes',
                    through: { model: ProductClassMap, attributes: [] },
                    attributes: ['id', 'name', 'description'],
                    include: [
                      {
                        model: Section,
                        as: 'Sections',
                        through: { model: ClassSectionMap, attributes: [] },
                        attributes: ['id', 'order_no', 'name', 'doc_concept'],
                        include: [
                          {
                            model: Lesson,
                            as: 'Lessons',
                            through: { model: SectionLessonMap, attributes: [] },
                            attributes: ['id', 'order_no', 'name', 'type', 'description'],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
        });

        // 🔢 섹션/레슨 개수 집계 (프론트 중복계산 제거)
        const result = categories.map((cat) => {
            const json = cat.toJSON();
        
            json.Products = (json.Products || []).map((prod) => {
              let sectionCount = 0;
              let lessonCount = 0;
        
              (prod.Classes || []).forEach((cls) => {
                (cls.Sections || []).forEach((sec) => {
                  sectionCount += 1;
                  lessonCount += (sec.Lessons || []).length;
                });
              });
        
              return { ...prod, sectionCount, lessonCount };
            });
            return json;
        });

        return result;
    }
}
  
module.exports = new StoreService(); 