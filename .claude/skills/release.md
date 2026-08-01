---
name: release
description: CodingPT 배포 오케스트레이션. "배포해줘"/"릴리스해줘"/"prod 배포" 요청 시 상황을 진단해 필요한 표면(back·front / PC 앱 / 모바일 스토어 / 버전 안내값)만 골라 순서대로 처리하고 실호출로 검증한다.
---

# 배포 — 상황을 읽고 필요한 것만

배포 표면이 5개이고 각자 절차·소요·되돌리기 난이도가 다르다. **매번 전부 하지 않는다.**
`scripts/release-status.sh` 로 진단해서 **필요한 것만** 한다.

```bash
bash codingpt_service/scripts/release-status.sh          # 사람이 읽는 진단
bash codingpt_service/scripts/release-status.sh --json   # 기계가 읽는 진단
```

## 0. 먼저 판단 (진단 결과 → 할 일)

| 진단이 말하는 것 | 해야 할 일 | 사용자 확인 |
|---|---|---|
| service 미커밋/미푸시 | 커밋 후 push (**deploy.sh 는 서버에서 git pull** — push 없이는 옛 코드가 배포됨) | 불필요 |
| back/front 코드가 바뀜 | `./deploy.sh prod` | **필요**(prod는 명시 요청 시만) |
| PC 리포 버전 ≠ 발행됨 | `bash codingpt_pc/scripts/release-pc.sh` | 필요(공증 수 분 + 사용자 계정 사용) |
| 앱 코드가 바뀜 | 버전 범프 → 빌드 → 스토어 제출 | 필요 |
| 스토어 게시 완료됨 | `APP_LATEST_ANDROID` 갱신 → prod 재배포 | 불필요(게시 확인 후 자동 진행 가능) |

**아무것도 안 바뀐 표면은 건드리지 않는다.** 예: 데몬/PC 만 고쳤으면 back 배포는 불필요하고,
back 만 고쳤으면 PC 릴리스는 불필요하다(데몬은 PC 앱 사이드카라 PC 릴리스에 실린다).

## 1. 서버(back + front)

> ⚠ **`./deploy.sh prod` 는 어시스턴트가 실행할 수 없다** — 권한 분류기가 차단한다(2026-08-01 실측:
> `Blocked by classifier`). 우회하지 말고 **사용자에게 아래 한 줄을 `!` 로 실행**해 달라고 요청한다.
> 그 전까지 할 수 있는 건 다 해 두고(커밋·푸시·버전·앱 빌드), 실행 후 검증부터 이어받는다.

```bash
!cd codingpt_service && ./deploy.sh prod     # ← 사용자가 실행
bash codingpt_service/scripts/verify-deploy.sh prod           # ← 어시스턴트가 실행(이게 통과해야 배포 완료)
```

dev 는 같은 차단이 걸리는지 그때 확인한다(걸리면 동일하게 요청).

- `deploy.sh` = SSH → `git pull` → `docker compose up --build -d` → nginx reload. **push 선행 필수.**
- compose `environment`/`env_file` 을 바꿨으면 restart 로는 안 먹는다 → `up -d --force-recreate <svc>`.
- 마이그레이션은 컨테이너 시작 시 자동(`db:migrate`). 스키마를 바꿨다면 배포 후 로그로 확인.

## 2. PC 앱

```bash
bash codingpt_service/scripts/bump-version.sh pc 0.1.209                     # 필요할 때만(버전이 이미 올라 있으면 생략)
cd codingpt_service/codingpt_pc && bash scripts/release-pc.sh --notes "한 줄 요약"
```

- 사전조건: 키체인 Developer ID + 공증 프로필 `codingpt-notary` + `~/.codingpt-release/pc-updater.key`.
- 공증에 수 분 걸린다. 실패 지점마다 중단하므로 중간 성공 상태가 남지 않는다.
- **발행까지만 한다. 설치는 사용자가 앱의 업데이트 버튼으로** — 강제 설치·재실행 금지.
  (0.1.208 부터는 조용한 순간에 앱이 스스로 적용하므로, 사용자가 아무것도 안 해도 결국 최신이 된다.)
- 검증: `curl -s "https://codingpt-back.ghmate.com/api/pc/update/darwin/aarch64/0.0.1"` 의 version.

## 3. 모바일(스토어)

```bash
bash codingpt_service/scripts/bump-version.sh app 0.3.0        # versionName+versionCode+MARKETING+BUILD 를 한 번에
cd codingpt_app && npm run build:android-aab  # 서명된 AAB (prod env)
```

자동화 범위는 `scripts/store/README.md` 참조(자격증명이 갖춰진 만큼만 자동화된다).
자격증명이 없으면 사용자가 Play Console / Xcode Organizer 로 올린다.

**순서 불변식**: 스토어에 **게시가 끝난 뒤에** `APP_LATEST_*` 를 올린다. 먼저 올리면 사용자가
"업데이트하세요" 를 보고 스토어에 갔을 때 아직 이전 버전만 있다.

- iOS 는 back 이 App Store 를 실조회해 자동 반영되므로 손댈 필요 없다.
- **Android 만** `docker-compose.prod.yml` 의 `APP_LATEST_ANDROID` 를 올리고 재배포한다.

## 4. 완료 보고 전 필수

- `bash codingpt_service/scripts/verify-deploy.sh prod` 통과(back 401 · front 200 · 안내 API · PC 채널).
- 무엇을 배포했고 무엇을 **안** 했는지 명시한다("앱은 심사 대기라 안내값은 아직 올리지 않음" 식).
- 실패한 단계가 있으면 성공한 것처럼 요약하지 않는다.

## 함정

- `deploy.sh` 는 **데몬을 배포하지 않는다**(back/front/executor/agent-worker 컨테이너만).
  데몬 수정은 PC 릴리스에만 실린다 — 데몬을 고쳤는데 PC 릴리스를 안 하면 사용자에게 도달 0.
- `.env*` 는 절대 커밋 금지(훅이 차단). 서버 env 반영은 scp 절차.
- 커밋 메시지에 Claude/AI 언급 금지(훅이 차단).
- 원격 `.env` 직접 편집·`deploy.sh prod` 는 승인 프롬프트가 뜬다 — 막히면 사용자에게 `!` 실행을 요청.
- 스토어 라이브 버전은 iOS 만 공개 조회 가능하다(Play 는 API 자격증명 필요).
