---
name: db-backup
description: objectstore(MinIO) 팀 공유 DB 백업을 생성/조회/복원한다. 큰 스키마·데이터 변경 전 스냅샷 용도.
disable-model-invocation: true
---

# DB 백업/복원

```bash
cd codingpt_back
set -a && source .env.local && set +a     # OBJECTSTORE_*/DB_* 로드

bash scripts/db-backup.sh list                  # 원격 백업 목록
bash scripts/db-backup.sh upload                # 현재 로컬 DB → full_YYYYMMDD.sql 업로드
bash scripts/db-backup.sh upload pre-<주제>      # 작업 전 스냅샷(권장 네이밍)
bash scripts/db-backup.sh pull                  # 최신 백업 다운로드만
bash scripts/db-backup.sh restore [파일명]       # DROP/CREATE/복원 + stamp + migrate
```

- restore는 파괴적(DROP) — 사용자 확인 없이는 로컬 DB에만 사용.
- 백업 파일은 개인정보 포함 → `db/backups/` gitignore 유지, 외부 전송 금지.
