# codingpt_service 모노레포

백엔드 + 프론트엔드 통합 모노레포. GitHub: `whrksp126/codingpt_service`

## 구조

```
codingpt_service/
├── codingpt_back/           — Express.js API (port 5100 dev / 5300 local)
├── codingpt_front/          — Next.js SSR 공개 사이트 (랜딩+구독결제+약관+웹 바이브코딩, port 3400) → codingpt.ghmate.com
├── docker-compose.{local,dev,stg,prod}.yml
└── deploy.sh                — back+front 배포 스크립트
```

> **정식 공개 도메인 = `codingpt.ghmate.com`**(PG 계약 URL). `codingpt-front.ghmate.com`은 같은 컨테이너 별칭(유지). `codingpt_front`(Next.js SSR)이 랜딩+구독결제+약관(PG 심사 = 정적 HTML 노출)+**웹 바이브코딩**(`/app`)을 서빙.
>
> **어드민 분리(2026-06)**: 기존 Vite 어드민은 최상위 **독립 프로젝트 `../codingpt_admin`**(자체 repo/compose/deploy)으로 분리됨 → `codingpt-admin.ghmate.com`. 백엔드와는 공개 HTTPS로만 통신.

## 환경별 DB

| 환경 | DB | SSL |
|------|----|-----|
| local | Docker PostgreSQL (localhost:5432) | 없음 |
| development | Docker PostgreSQL (container: postgres) | 없음 |
| staging/production | 외부 PostgreSQL | 필요 |

## DB 마이그레이션

- Sequelize-CLI 기반. 컨테이너 시작 시 `docker-entrypoint.sh`가 `db:migrate` 자동 실행
- 마이그레이션 파일: `codingpt_back/migrations/` (git 추적)
- 베이스라인 풀 덤프: `db/backups/full_YYYYMMDD.sql` (**gitignore**, 개인정보 포함)
- 절차/명령어 상세: `.claude/rules/db-migration.md`

## ObjectStore (MinIO)

AWS S3 대신 홈서버 MinIO 사용. env var prefix: `OBJECTSTORE_*`

```
OBJECTSTORE_ENDPOINT=https://objectstore.ghmate.com
OBJECTSTORE_BUCKET=codingpt
OBJECTSTORE_PUBLIC_BASE_URL=https://objectstore.ghmate.com/codingpt
```

## Git

`.env` / `.env.*` 는 `.gitignore`에 포함 — 커밋 금지.  
서버 배포 시 `.env.dev`는 `scp`로 별도 전송.
