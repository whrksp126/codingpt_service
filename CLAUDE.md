# codingpt_service 모노레포

CodingPT 제품 모노레포. GitHub: `whrksp126/codingpt_service`

> **현재 제품 방향(2026-07 피벗)**: "내 PC 여러 대 ↔ 모바일/태블릿 원격 바이브코딩". AI는 항상
> 사용자 PC에서 사용자 자신의 CLI(BYO)로 실행. 클라우드 러너·과금은 코드 보존 상태로 게이팅 OFF
> (`codingpt_back/config/runner.js`, BILLING_ENFORCE). 교육(레슨) 기능은 레거시로 동결.

## 구조

```
codingpt_service/
├── codingpt_back/     — Express.js API + PostgreSQL (port 5100 dev / 5300 local)
│                        데몬 릴레이(WS)·워크스페이스 메타(objectstore)·알림·프리뷰 프록시 허브
├── codingpt_front/    — Next.js SSR 공개 사이트 (port 3400) → codingpt.ghmate.com
├── codingpt_daemon/   — 사용자 PC 데몬 (npm workspaces: runner-core/daemon/cpt-cli/cloud-runner)
├── codingpt_pc/       — PC 데스크톱 앱 (Tauri, 데몬을 사이드카로 번들 → .dmg)
├── docker-compose.{local,dev,stg,prod}.yml
└── deploy.sh          — back+front 배포 (사용법: .claude/skills/deploy.md)
```

각 패키지 상세 규칙은 해당 디렉토리의 `CLAUDE.md` 참조 (모바일 앱은 별도 리포 `../codingpt_app`,
어드민은 독립 프로젝트 `../codingpt_admin` → codingpt-admin.ghmate.com).

> 정식 공개 도메인 = `codingpt.ghmate.com`(PG 계약 URL). `codingpt-front.ghmate.com`은 별칭.

## 환경별 DB

| 환경 | DB | SSL |
|------|----|-----|
| local | Docker PostgreSQL (localhost:5432) | 없음 |
| development | Docker PostgreSQL (container: postgres) | 없음 |
| staging/production | 홈서버 Docker PostgreSQL | prod는 `codingpt_postgres_prod`, SSL 없음 |

## DB 마이그레이션

- Sequelize-CLI 기반, 컨테이너 시작 시 자동 `db:migrate`. **`sequelize.sync()` 금지.**
- 절차/백업 상세: `.claude/rules/db-migration.md`

## ObjectStore (MinIO)

홈서버 MinIO(objectstore.ghmate.com), env prefix `OBJECTSTORE_*`. 워크스페이스 메타(project.json)·
세션 매니페스트·TTS 자산·git bundle 체크포인트가 여기 저장됨.

## Git / 시크릿

- `.env*` 커밋 절대 금지(gitignore). 서버 반영은 scp 절차(글로벌 가이드).
- **커밋 메시지에 Claude/AI 언급 금지** — PreToolUse 훅(`.claude/hooks/git-guard.py`)이 강제.
- prod 배포는 사용자가 명시 요청했을 때만.

## 검증 규율

수정 후엔 반드시 재빌드/재시작해 실제 동작을 확인한 뒤에만 완료 보고. 실기기·실호출 검증은
`.claude/agents/verifier.md` 서브에이전트 사용.
