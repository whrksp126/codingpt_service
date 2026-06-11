FROM node:18-alpine as builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

FROM node:18-alpine

WORKDIR /app

# TTS PCM→mp3 변환(ttsService._pcmToMp3)에서 ffmpeg 사용
RUN apk add --no-cache ffmpeg

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
