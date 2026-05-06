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
    const { name, description, type, price, lecture_intro, category, difficulty, is_active } = productData;

    if (!name || !name.trim()) {
      throw new Error('이름은 필수입니다.');
    }
    if (price != null && price < 0) {
      throw new Error('가격은 0 이상이어야 합니다.');
    }

    return await Product.create({
      name: name.trim(),
      description: description || '',
      type: type || '클래스',
      price: price == null ? 0 : price,
      lecture_intro: lecture_intro || null,
      category: category || null,
      difficulty: difficulty || null,
      is_active: is_active == null ? true : !!is_active,
    });
  }

  // 제품 수정
  async updateProduct(id, updateData) {
    const product = await Product.findByPk(id);
    if (!product) {
      throw new Error('해당 제품을 찾을 수 없습니다.');
    }

    const { name, description, type, price, lecture_intro, category, difficulty, is_active } = updateData;

    if (name != null) product.name = name;
    if (description != null) product.description = description;
    if (type != null) product.type = type;
    if (price != null) {
      if (price < 0) throw new Error('가격은 0 이상이어야 합니다.');
      product.price = price;
    }
    if (lecture_intro !== undefined) product.lecture_intro = lecture_intro;
    if (category !== undefined) product.category = category;
    if (difficulty !== undefined) product.difficulty = difficulty;
    if (is_active !== undefined) product.is_active = !!is_active;

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