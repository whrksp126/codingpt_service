# Node.js 환경에서 빌드 (운영)
FROM node:20-alpine AS builder
WORKDIR /app

# npm 기본 레지스트리 설정
RUN npm config set registry https://registry.npmjs.org/

# package.json과 package-lock.json 복사
COPY package.json package-lock.json ./

# 패키지 설치 (버전 차이 방지)
RUN npm ci

# 소스 코드 복사
COPY . .

# 빌드 실행 (운영 환경)
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
RUN npm run build

# Nginx를 사용하여 서비스
FROM nginx:stable-alpine AS production
COPY nginx.prod.conf /etc/nginx/nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
