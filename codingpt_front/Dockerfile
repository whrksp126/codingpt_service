# CodingPT 결제 웹 (Next.js standalone)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 빌드시 클라이언트에 인라인되는 NEXT_PUBLIC_* 는 build arg 로 주입
ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_PORTONE_STORE_ID
ARG NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CHARGE
ARG NEXT_PUBLIC_PORTONE_CHANNEL_KEY_BILLING
ARG NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL \
    NEXT_PUBLIC_PORTONE_STORE_ID=$NEXT_PUBLIC_PORTONE_STORE_ID \
    NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CHARGE=$NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CHARGE \
    NEXT_PUBLIC_PORTONE_CHANNEL_KEY_BILLING=$NEXT_PUBLIC_PORTONE_CHANNEL_KEY_BILLING \
    NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
# HOSTNAME=0.0.0.0 — standalone server.js 가 Docker 자동 HOSTNAME(컨테이너ID→단일 IP)에만
# 바인딩되어 nginx_proxy 네트워크에서 도달 불가(502)해지는 문제 방지(모든 인터페이스 바인딩).
ENV NODE_ENV=production PORT=3400 HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3400
CMD ["node", "server.js"]
