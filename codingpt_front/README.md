### 로컬(local) 개발 환경

## 컨테이너 중지(필요시)
docker stop codingpt_front_local

## 컨테이너 삭제(필요시)
docker rm codingpt_front_local

## 이미지 삭제(필요시)
docker rmi whrksp126/codingpt_front:local

## 로컬 환경 실행
docker compose -f docker-compose.local.yml up --build

## 로컬 환경 실행 (백그라운드)
docker compose -f docker-compose.local.yml up --build -d

## 로컬 환경의 이미지 확인
docker images | grep codingpt_front

## 도커 허브에 local 태그로 푸쉬
docker push whrksp126/codingpt_front:local

---

### 데브(dev) 개발 환경

## 컨테이너 중지(필요시)
docker stop codingpt_front_dev

## 컨테이너 삭제(필요시)
docker rm codingpt_front_dev

## 이미지 삭제(필요시)
docker rmi whrksp126/codingpt_front:dev

## 데브 환경 실행
docker compose -f docker-compose.dev.yml up --build

## 데브 환경 실행 (백그라운드)
docker compose -f docker-compose.dev.yml up --build -d

## 데브 환경 실행 컨테이너 중지
docker compose -f docker-compose.dev.yml down

## dev 환경의 이미지 확인
docker images | grep codingpt_front

## 도커 허브에 dev 태그로 푸쉬
docker push whrksp126/codingpt_front:dev

## 서버 적용
sudo systemctl restart codingpt_front_dev

---

### 스테이징(stg) 개발 환경

## 컨테이너 중지(필요시)
docker stop codingpt_front_stg

## 컨테이너 삭제(필요시)
docker rm codingpt_front_stg

## 이미지 삭제(필요시)
docker rmi whrksp126/codingpt_front:stg

## 데브 환경 실행
docker compose -f docker-compose.stg.yml up --build

## 데브 환경 실행 (백그라운드)
docker compose -f docker-compose.stg.yml up --build -d

## 데브 환경 실행 컨테이너 중지
docker compose -f docker-compose.stg.yml down

## stg 환경의 이미지 확인
docker images | grep codingpt_front

## 도커 허브에 local 태그로 푸쉬
docker push whrksp126/codingpt_front:stg

## 서버 적용
sudo systemctl restart codingpt_front_stg

---

## 🚀 CI/CD 테스트

**테스트 시간**: 2025-11-24 12:00:00  
**목적**: GitHub Actions CI/CD 파이프라인 테스트  
**예상 동작**: 코드 푸시 → 자동 빌드 → Docker Hub 푸시 → 서버 자동 배포