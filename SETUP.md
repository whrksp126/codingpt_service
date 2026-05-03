# CodingPT 로컬 개발환경 가이드

## 사전 준비

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) 설치 및 실행 중
- Node.js 18+ (호스트에서 nodemon 실행 — 컨테이너 안에서 실행하지 않음)
- Mac 기준 (Windows 미지원)
- 모바일 앱 빌드 시 추가: Xcode (iOS), Android Studio (Android)
- (선택) [cmux](https://cmux.io) — 통합 개발환경 자동 세팅용

---

## 1. 레포 클론

CodingPT는 **2개의 레포**를 같은 부모 폴더에 클론해야 합니다.

```bash
mkdir codingpt && cd codingpt

# 백엔드 + 웹 프론트 (모노레포)
git clone https://github.com/whrksp126/codingpt_service.git

# 모바일 앱 (React Native)
git clone https://github.com/whrksp126/codingpt_app.git
```

결과:

```
codingpt/
├── codingpt_service/    ← 백엔드 + 웹 프론트
└── codingpt_app/        ← 모바일 앱
```

---

## 2. 환경 파일 준비

아래 파일들은 git에 포함되지 않으므로 **별도 채널(메신저/공유 드라이브)로 받아** 직접 배치합니다.

| 파일 경로 | 용도 |
|-----------|------|
| `codingpt_service/codingpt_back/.env.local` | 백엔드 환경변수 (DB, JWT, OAuth, ObjectStore, ElevenLabs 등) |
| `codingpt_service/codingpt_back/.env.dev` | 백엔드 dev 환경변수 (배포할 때만 필요) |
| `codingpt_service/codingpt_back/.env` | 백엔드 production 환경변수 (직접 운영 안 하면 불필요) |
| `codingpt_service/codingpt_front/.env.local` | 프론트 환경변수 (`VITE_BACKEND_URL` 등) |
| `codingpt_app/.env.local` | 앱 환경변수 (`BACK_URL`, `ANDROID_BACK_URL`, `IOS_BACK_URL`) |

> ⚠️ `.env`에는 production 설정이 들어있어 호스트 nodemon이 잘못 로드하면 staging/prod DB에 연결 시도 → 인증 실패. `local-setup.sh`가 셸에 `.env.local`을 명시 export해서 우선순위를 보장하므로 문제없지만, **수동으로 `npm run dev`를 실행할 때는 반드시 `.env.local`을 먼저 source** 해야 합니다 (아래 "수동 실행" 참조).

---

## 3. DB 베이스라인 받기

`codingpt_service/db/backups/full_YYYYMMDD.sql` 풀 덤프(스키마 + 운영 데이터)를 별도 채널로 받아 아래 경로에 둡니다.

```
codingpt_service/
└── db/
    └── backups/
        └── full_20260504.sql   ← 여기 (날짜는 받은 파일 그대로)
```

> `db/backups/`는 `.gitignore`에 등록되어 있습니다 (개인정보 포함).

---

## 4. 첫 실행 (최초 1회)

### 4-1. PostgreSQL 컨테이너 실행

```bash
cd codingpt_service
docker compose -f docker-compose.local.yml up -d postgres
```

healthcheck 통과까지 약 10초 대기.

### 4-2. 베이스라인 SQL 복원

```bash
docker exec -i codingpt_postgres_local \
  psql -U codingpt -d codingpt_db \
  < db/backups/full_20260504.sql
```

### 4-3. 마이그레이션 베이스라인 stamp

이미 스키마가 존재하므로 `db:migrate`가 초기 마이그레이션을 다시 실행하지 않도록 마킹:

```bash
cd codingpt_back
set -a && source .env.local && set +a
bash scripts/db-stamp-baseline.sh
```

`>>> Stamp 완료: 20260504000000-initial-schema.js 표시됨.` 출력되면 성공.

### 4-4. 의존성 설치

```bash
# 백엔드
cd codingpt_service/codingpt_back && npm install

# 웹 프론트
cd ../codingpt_front && npm install

# 모바일 앱
cd ../../codingpt_app && npm install
# iOS만: cd ios && pod install && cd ..
```

---

## 5. 일상 개발 (cmux 통합 실행)

cmux가 설치되어 있다면 한 줄로 모든 탭(metro / android / front / back) 자동 세팅:

```bash
bash /path/to/codingpt/scripts/local-setup.sh
```

레이아웃:
```
[claude              ]
[metro 8081][android ]
[front 3300][back 5300]
```

스크립트가 자동으로:
1. 내부망 IP 감지 + 모든 `.env.local`의 BACKEND_URL 갱신 (Wi-Fi 바뀐 경우 대응)
2. 기존 탭 정리 후 새 4분할 레이아웃
3. 각 서비스 실행 (back은 셸에 `.env.local` export 후 실행 → 환경 충돌 방지)

### 수동 실행 (cmux 없이)

각 서비스를 별도 터미널에서:

```bash
# 백엔드 (포트 5300) — .env.local 명시 export 필수
cd codingpt_service/codingpt_back
set -a && source .env.local && set +a
npm run dev   # → sequelize-cli db:migrate && nodemon app.js

# 웹 프론트 (포트 3300)
cd codingpt_service/codingpt_front
npm run dev

# 모바일 앱 — metro
cd codingpt_app && npm start

# 모바일 앱 — Android
cd codingpt_app && npm run android:local
```

---

## 6. 접속 확인

| 서비스 | 주소 |
|--------|------|
| 웹 프론트 | `http://localhost:3300` |
| 백엔드 API | `http://localhost:5300` |
| Metro | `http://localhost:8081` |
| PostgreSQL | `localhost:5432` (user: codingpt / pw: codingpt123 / db: codingpt_db) |

---

## DB 스키마 변경이 생겼을 때 (git pull 후)

다른 사람이 `models/`와 `migrations/`를 수정해서 push했다면:

```bash
git pull
# back 탭에서 nodemon이 재시작되면서 `npm run dev`의 db:migrate가 자동 실행됨
# (또는 수동: cd codingpt_back && set -a && source .env.local && set +a && npm run db:migrate)
```

> **주의**: `nodemon`은 파일 변경 시 `node app.js`만 재시작하고 `npm run dev` 자체는 재실행하지 않습니다. 그래서 새 마이그레이션을 받으면 back 탭을 **Ctrl+C 후 다시 `npm run dev`** 또는 수동 `npm run db:migrate`가 필요합니다.

---

## 내가 DB 스키마를 변경할 때

```bash
cd codingpt_service/codingpt_back
set -a && source .env.local && set +a

# 1. models/ 수정

# 2. 마이그레이션 파일 생성
npm run db:migration:create -- 변경-내용-한-줄-설명
# → migrations/{timestamp}-변경-내용-한-줄-설명.js

# 3. 생성된 파일의 up/down 작성 (queryInterface API 또는 raw SQL)

# 4. 로컬 적용
npm run db:migrate

# 5. 커밋 (migrations/ 폴더 반드시 포함)
cd ..
git add codingpt_back/migrations/ codingpt_back/models/
git commit -m "db: 변경 내용 설명"
git push
```

자세한 규칙: `.claude/rules/db-migration.md`

---

## dev 환경 배포

```bash
cd codingpt_service
./deploy.sh dev
```

스크립트가:
1. SSH로 dev 서버 접속
2. `git pull`
3. `docker compose -f docker-compose.dev.yml up --build -d back front code-executor`
4. 컨테이너 시작 → `docker-entrypoint.sh`가 `npm run db:migrate` 자동 실행 → 신규 마이그레이션 적용
5. nginx reload

**dev DB 최초 1회**는 stamp 필요 (이미 스키마가 존재하는 경우). SSH로 접속해서:

```bash
docker exec codingpt_postgres_dev psql -U codingpt -d codingpt_db -c "
CREATE TABLE IF NOT EXISTS \"SequelizeMeta\" (\"name\" VARCHAR(255) NOT NULL PRIMARY KEY);
INSERT INTO \"SequelizeMeta\" (name) VALUES ('20260504000000-initial-schema.js') ON CONFLICT DO NOTHING;
"
```

---

## 베이스라인 SQL 갱신 (운영자만)

DB가 충분히 진화하면 새 베이스라인을 만들어 마이그레이션 히스토리를 압축:

```bash
docker exec codingpt_postgres_local pg_dump \
  -U codingpt -d codingpt_db \
  --no-owner --no-privileges \
  > codingpt_service/db/backups/full_$(date +%Y%m%d).sql
```

이후 팀원에게 새 SQL 파일 전달 + `db-stamp-baseline.sh`의 INITIAL_MIGRATION 변수 갱신 (선택).
