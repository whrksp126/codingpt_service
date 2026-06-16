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
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL \
    NEXT_PUBLIC_PORTONE_STORE_ID=$NEXT_PUBLIC_PORTONE_STORE_ID \
    NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CHARGE=$NEXT_PUBLIC_PORTONE_CHANNEL_KEY_CHARGE \
    NEXT_PUBLIC_PORTONE_CHANNEL_KEY_BILLING=$NEXT_PUBLIC_PORTONE_CHANNEL_KEY_BILLING
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3400
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3400
CMD ["node", "server.js"]
