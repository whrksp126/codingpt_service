---
paths:
  - "**/codingpt_back/migrations/**"
  - "**/codingpt_back/models/**"
  - "**/codingpt_back/scripts/db-backup.sh"
---

# DB 마이그레이션 규칙

Sequelize-CLI로 스키마 버전 관리. `db/backups/full_YYYYMMDD.sql`이 베이스라인.
(아래 경로는 `codingpt_back/` 기준.)

## 스키마 변경 시 필수 절차

1. `models/` 수정 (모델 정의 변경)
2. 마이그레이션 파일 생성:
   ```bash
   cd codingpt_back
   npm run db:migration:create -- 변경-내용-한-줄-설명
   ```
3. 생성된 파일의 `up`/`down`을 `queryInterface` API로 작성
   (데이터 마이그레이션은 `queryInterface.sequelize.query('...')` raw SQL)
4. 로컬 적용:
   ```bash
   set -a && source .env.local && set +a
   npm run db:migrate
   ```
5. **git commit에 `migrations/` 반드시 포함**
6. 배포: `./deploy.sh dev` → 컨테이너 시작 시 `docker-entrypoint.sh`가 `db:migrate` 자동 실행
   (`SKIP_MIGRATIONS=1`이면 건너뜀 — code-executor 등 DB 무관 컨테이너)

## 팀 공유 DB 백업 (objectstore)

`codingpt_back/scripts/db-backup.sh` — MinIO `s3://codingpt/db-backups/`.

```bash
bash scripts/db-backup.sh list                 # 원격 백업 목록
bash scripts/db-backup.sh upload [suffix]      # 현재 DB → 업로드 (pre-<주제> 스냅샷 권장)
bash scripts/db-backup.sh restore [파일명]      # 다운로드 + DROP/CREATE/복원 + stamp + migrate
```

큰 스키마/데이터 변경 전엔 `upload pre-<주제>` 스냅샷 필수 권장.

## 자주 쓰는 명령어

```bash
npm run db:migrate:status   # 적용 상태
npm run db:migrate:undo     # 1단계 롤백
```

## 주의사항

- `migrations/`는 git 포함 필수, `db/backups/`는 gitignore(개인정보)
- 한 번 push된 마이그레이션 파일 수정 금지 — 새 파일로 추가
- `sequelize.sync()` 금지 — 반드시 마이그레이션으로
