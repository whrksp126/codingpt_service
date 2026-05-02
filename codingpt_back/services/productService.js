const { Product, Review, Class, User } = require('../models');

class ProductService {
  // 모든 제품 조회
  async getAllProducts() {
    return await Product.findAll({
      attributes: ['id', 'name', 'description', 'type', 'price', 'lecture_intro']
    });
  }
  
  // 특정 제품 조회 (리뷰 포함)
  async getProductById(id) {
    const product = await Product.findByPk(id, {
      attributes: ['id', 'name', 'description', 'type', 'price', 'lecture_intro'],
      include: [
        {
          model: Review,
          attributes: ['id', 'score', 'review_text', 'created_at'],
          include: [
            {
              model: User,
              attributes: ['id', 'nickname', 'profile_img']
            }
          ]
        }
      ]
    });
    
    if (!product) {
      throw new Error('해당 제품을 찾을 수 없습니다.');
    }
    
    return product;
  }
  
  // 제품별 클래스 조회
  async getProductClasses(id) {
    const product = await Product.findByPk(id, {
      include: [
        {
          model: Class,
          attributes: ['id', 'name', 'description'],
          through: { attributes: [] }
        }
      ]
    });
    
    if (!product) {
      throw new Error('해당 제품을 찾을 수 없습니다.');
    }
    
    return product.Classes;
  }
  
  // 제품 타입별 조회
  async getProductsByType(type) {
    return await Product.findAll({
      where: { type },
      attributes: ['id', 'name', 'description', 'type', 'price', 'lecture_intro']
    });
  }
  
  // 제품 생성
  async createProduct(productData) {
    const { name, description, type, price, lecture_intro } = productData;
    
    // 필수 필드 검증
    if (!name || !description || !type || !price) {
      throw new Error('필수 필드가 누락되었습니다.');
    }
    
    // 가격 검증
    if (price < 0) {
      throw new Error('가격은 0 이상이어야 합니다.');
    }
    
    return await Product.create({
      name,
      description,
      type,
      price,
      lecture_intro: lecture_intro || null
    });
  }
  
  // 제품 수정
  async updateProduct(id, updateData) {
    const product = await Product.findByPk(id);
    if (!product) {
      throw new Error('해당 제품을 찾을 수 없습니다.');
    }
    
    const { name, description, type, price, lecture_intro } = updateData;
    
    // 업데이트할 필드만 수정
    if (name) product.name = name;
    if (description) product.description = description;
    if (type) product.type = type;
    if (price !== undefined) {
      if (price < 0) {
        throw new Error('가격은 0 이상이어야 합니다.');
      }
      product.price = price;
    }
    if (lecture_intro !== undefined) product.lecture_intro = lecture_intro;
    
    await product.save();
    return product;
  }
  
  // 제품 삭제
  async deleteProduct(id) {
    const product = await Product.findByPk(id);
    if (!product) {
      throw new Error('해당 제품을 찾을 수 없습니다.');
    }
    
    await product.destroy();
    return true;
  }
}

module.exports = new ProductService(); 