const { Class, Section, Product, Curriculum } = require('../models');

class ClassService {
  // 모든 클래스 조회
  async getAllClasses() {
    return await Class.findAll({
      attributes: ['id', 'name', 'description']
    });
  }
  
  // 특정 클래스 조회 (섹션 포함)
  async getClassById(id) {
    const classData = await Class.findByPk(id, {
      attributes: ['id', 'name', 'description'],
      include: [
        {
          model: Section,
          attributes: ['id', 'name', 'description'],
          through: { attributes: [] }
        }
      ]
    });
    
    if (!classData) {
      throw new Error('해당 클래스를 찾을 수 없습니다.');
    }
    
    return classData;
  }
  
  // 클래스별 제품 조회
  async getClassProducts(id) {
    const classData = await Class.findByPk(id, {
      include: [
        {
          model: Product,
          attributes: ['id', 'name', 'description', 'type', 'price'],
          through: { attributes: [] }
        }
      ]
    });
    
    if (!classData) {
      throw new Error('해당 클래스를 찾을 수 없습니다.');
    }
    
    return classData.Products;
  }
  
  // 클래스별 커리큘럼 조회
  async getClassCurriculums(id) {
    const classData = await Class.findByPk(id, {
      include: [
        {
          model: Curriculum,
          attributes: ['id', 'name', 'description'],
          through: { attributes: [] }
        }
      ]
    });
    
    if (!classData) {
      throw new Error('해당 클래스를 찾을 수 없습니다.');
    }
    
    return classData.Curriculums;
  }
  
  // 클래스 생성
  async createClass(classData) {
    const { name, description } = classData;
    
    // 필수 필드 검증
    if (!name || !description) {
      throw new Error('필수 필드가 누락되었습니다.');
    }
    
    // 이름 중복 확인
    const existingClass = await Class.findOne({ where: { name } });
    if (existingClass) {
      throw new Error('이미 존재하는 클래스명입니다.');
    }
    
    return await Class.create({
      name,
      description
    });
  }
  
  // 클래스 수정
  async updateClass(id, updateData) {
    const classData = await Class.findByPk(id);
    if (!classData) {
      throw new Error('해당 클래스를 찾을 수 없습니다.');
    }
    
    const { name, description } = updateData;
    
    // 이름 변경 시 중복 확인
    if (name && name !== classData.name) {
      const existingClass = await Class.findOne({ where: { name } });
      if (existingClass) {
        throw new Error('이미 존재하는 클래스명입니다.');
      }
    }
    
    // 업데이트할 필드만 수정
    if (name) classData.name = name;
    if (description) classData.description = description;
    
    await classData.save();
    return classData;
  }
  
  // 클래스 삭제
  async deleteClass(id) {
    const classData = await Class.findByPk(id);
    if (!classData) {
      throw new Error('해당 클래스를 찾을 수 없습니다.');
    }
    
    await classData.destroy();
    return true;
  }
  
  // 클래스에 섹션 추가
  async addSectionToClass(classId, sectionId) {
    const classData = await Class.findByPk(classId);
    if (!classData) {
      throw new Error('해당 클래스를 찾을 수 없습니다.');
    }
    
    const section = await Section.findByPk(sectionId);
    if (!section) {
      throw new Error('해당 섹션을 찾을 수 없습니다.');
    }
    
    await classData.addSection(section);
    return true;
  }
  
  // 클래스에서 섹션 제거
  async removeSectionFromClass(classId, sectionId) {
    const classData = await Class.findByPk(classId);
    if (!classData) {
      throw new Error('해당 클래스를 찾을 수 없습니다.');
    }
    
    const section = await Section.findByPk(sectionId);
    if (!section) {
      throw new Error('해당 섹션을 찾을 수 없습니다.');
    }
    
    await classData.removeSection(section);
    return true;
  }
}

module.exports = new ClassService(); 