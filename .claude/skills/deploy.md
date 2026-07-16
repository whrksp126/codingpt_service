---
name: deploy
description: codingpt_service를 dev/stg/prod 홈서버에 배포한다(git push + deploy.sh + 헬스체크). prod는 사용자가 명시적으로 요청했을 때만.
disable-model-invocation: true
---

# 배포 절차

## 전제

- **prod 배포는 사용자가 이번 대화에서 명시적으로 "prod 배포"를 요청했을 때만** 실행한다. dev는 작업 흐름상 자연스러우면 진행 가능.
- 배포 대상 커밋이 push되어 있어야 한다(`git status -sb`로 확인 — deploy.sh가 서버에서 git pull).

## 실행

```bash
cd codingpt_service        # 리포 루트
./deploy.sh dev            # 또는 stg / prod
```

내부 동작: 홈서버 SSH → git pull → `docker compose -f docker-compose.<env>.yml up -d --build`
→ 컨테이너 시작 시 docker-entrypoint.sh가 `db:migrate` 자동 실행.

## 배포 후 헬스체크 (필수 — 완료 보고 전에)

```bash
# back 살아있음(401 = 인증 요구 = 정상 기동)
curl -s -o /dev/null -w '%{http_code}\n' https://codingpt-back.ghmate.com/api/daemon/status        # prod
curl -s -o /dev/null -w '%{http_code}\n' https://dev-codingpt-back.ghmate.com/api/daemon/status    # dev

# front
curl -s -o /dev/null -w '%{http_code}\n' https://codingpt.ghmate.com/
```

컨테이너 로그가 필요하면 cmux의 해당 로그 탭을 `cmux capture-pane`으로 가져온다(SSH 재실행 금지).

## 함정

- compose `env_file`/volume 변경은 restart로 반영 안 됨 → `up -d --force-recreate <svc>`
- 데몬 러너 RPC를 추가했다면 러너 이미지 서버 재빌드 필요
- `.env*`는 절대 git에 올리지 않는다 — 서버 반영은 scp 절차(글로벌 가이드 참조)
