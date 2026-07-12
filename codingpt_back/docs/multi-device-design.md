# 계정 중심 멀티 기기 설계 (Account-centric Multi-Device)

> 상태: **설계 합의 단계 (미구현)** · 2026-07-12
> 관련: `byo-pc-design.md`(와이어/데몬), PC 앱 `codingpt_pc`, 모바일 `codingpt_app`

## 0. 왜 바꾸나 (문제)

지금 UI/개념은 **"이 PC ↔ 내 모바일" 1:1 페어링**이다. QR 스캔·페어링 코드 세리모니가 있고,
"모바일 앱과 이 PC를 연결" 같은 문구가 그 사고를 드러낸다.

**실제 사용자**는 한 기기에만 묶이지 않는다:
- 작업하는 곳(**호스트**)이 여럿: 개인 노트북 · 회사 PC · 집 공용 PC.
- 조작하는 곳(**컨트롤러**)도 여럿: 폰 · 태블릿. 주로 태블릿, 이동 중엔 폰으로 **잠깐 이어받기**.

원하는 경험: **"기기에서 로그인만 하면 자동 등록"**, 그리고 **어디서든 내 워크스페이스를 골라 이어서 작업.**
QR·수동 페어링 없이.

## 1. 개념 모델

```
계정(Account = 사람, 구글 로그인)
 ├─ 기기(Device) 여럿  ← 로그인하면 자동 등록
 │    ├─ 호스트 역량: 터미널/IDE/프리뷰를 실제로 실행 (데스크톱 앱 = 데몬)
 │    └─ 컨트롤러 역량: 원격 호스트를 보고 조작 (모바일 앱 / 다른 데스크톱)
 ├─ 워크스페이스(Workspace) 여럿  ← 계정 전역 목록
 │    ├─ local : 실제 파일이 특정 호스트에 존재 → hostDeviceId + localPath
 │    └─ cloud : 클라우드 러너에서 실행 → 아무 컨트롤러에서나 접근
 └─ 세션(Session) : 워크스페이스별 "열린 표면 + 레이아웃" → 이어받기 (이미 구현: session.json)
```

- **데스크톱 앱 = 호스트 + 컨트롤러 겸용.** 내 Mac에서 직접 작업도 하고, 다른 호스트로 이어받기도 가능.
- **모바일 앱 = 주로 컨트롤러.** 폰·태블릿 여러 대 각각 로그인 → 전부 같은 계정의 컨트롤러.
- **로컬 워크스페이스는 계정 전역 목록에 뜨되, "어느 호스트에 사는지"(hostDeviceId)를 안다.**
  칸막이가 아니라 — 열면 알아서 그 호스트로 라우팅한다.
- **클라우드 호스트 = 항상 켜진 우리 제공 기기.** ghmate 홈서버의 **사용자별 가상화 서버(M5 클라우드 러너)를
  기기 목록에 "하나의 PC(항상 켜짐)"로 노출**한다. 로컬 PC가 꺼져 있어도 언제나 쓸 수 있는 기본 호스트.
  → 클라우드 워크스페이스 = "클라우드 호스트"에 사는 워크스페이스. (별도 개념이 아니라 기기 하나로 통일)

## 2. 로그인 = 자동 등록 (QR 폐기)

- 기기에서 **구글 로그인** → `deviceToken` 발급 + `DaemonDevice` 자동 생성/갱신.
- 데스크톱: 이미 만든 **웹 로그인**(브라우저 승인) 그대로 사용. 등록 시 `kind`, `platform`, `name`(hostname).
- 모바일: 앱 로그인 시 컨트롤러 기기로 자동 등록.
- **QR / 페어링 코드는 폐기** (레거시 엔드포인트만 남겨 하위호환). "이 PC를 폰과 연결"이라는 개념 자체가 사라짐.

## 3. 기기 목록 & 자동 라우팅

- `GET /api/daemon/devices` — 내 계정의 모든 기기 + 온라인 상태(제어 WS 연결 / `last_seen_at`).
- 워크스페이스 목록(`GET /api/daemon/workspaces`)은 **전역**이되, local 워크스페이스마다:
  - `hostDeviceId` (어느 호스트)
  - 그 호스트 `online` 여부
- 컨트롤러가 local 워크스페이스를 열면 → 그 `hostDeviceId`의 데몬으로 릴레이 연결
  (기존 control WS `/api/daemon/connect` + terminal relay 재사용).
  호스트가 오프라인이면 "이 워크스페이스가 있는 기기가 꺼져 있어요" 안내.

## 4. UI

### 모바일 (컨트롤러)
- 기본 화면 = **워크스페이스 전역 목록.** 각 항목에 **호스트 배지**(예: `MacBook Pro` / `클라우드`) + 온라인 점.
- (선택) "기기별 보기" 토글 → 기기 목록 → 그 기기의 워크스페이스. (device-first 도 지원, 기본은 전역)
- 워크스페이스 열기 → `session.json` 읽어 **열린 표면(터미널/IDE/프리뷰) 복원** → 해당 호스트에 연결 → 이어서 작업.
- 순차 핸드오프: 태블릿에서 하다 폰에서 열면 같은 세션을 이어받음. 동시 편집은 last-writer-wins (사용자 주의).

### 데스크톱 (PC) — 리프레이밍
- 설정 "연결" → **"계정"**: "이 기기가 내 계정에 로그인됨" + 계정 카드 + 이 기기 이름/역할 + 로그아웃.
- "웹으로 로그인" = **이 기기 등록**. QR 섹션 제거(또는 깊이 숨김).
- (선택) "내 다른 기기" 목록 → 데스크톱에서도 다른 호스트로 이어가기(데스크톱도 컨트롤러라서).

## 5. 스키마 / 마이그레이션

- `DaemonDevice`: `kind`(host | controller | both, 기본 both) 컬럼 추가. `last_seen_at` 은 이미 있음.
  - 온라인 판정: control WS `hello` 수신 시 `last_seen_at` 갱신 + 연결 세트 관리.
- 워크스페이스 메타(objectstore `project.json`): local 에 `hostDeviceId` 추가.
  - 기존 로컬 워크스페이스(무 hostDeviceId) 백필: 단일 데몬 시절 기기로 귀속하거나, 첫 접속 호스트가 클레임.
- 인증/데이터 계층은 그대로 (`resolveDeviceUser` = deviceToken→user, 이미 계정당 N기기).

## 6. 재사용 / 영향

| 항목 | 상태 |
|------|------|
| 웹 로그인(브라우저 승인) | **재사용** — 프레이밍만 "기기 등록"으로 |
| 세션 싱크 `session.json` | **재사용** — 이미 워크스페이스 스코프·컨트롤러 무관 → 이 모델에 딱 맞음 |
| deviceToken 인증 · workspace objectstore | **재사용** |
| QR/페어링 프레이밍 | **폐기**(레거시 보존) |
| `GET /devices` · online 상태 | **신규** |
| workspace `hostDeviceId` · 라우팅 | **신규/변경** |
| 모바일 기기·워크스페이스 UI | **신규**(별도 코드베이스, 후속) |

## 7. 단계 (제안)

1. ~~**설계 합의**~~ ✅ (2026-07-12)
2. **백엔드** ✅ (2026-07-12, 로컬 DB 검증 완료)
   - `DaemonDevice.role`(host|controller) 마이그레이션 `20260712000306-add-role-to-daemon-device.js` + 모델
   - `GET /api/daemon/devices` — 계정 전 기기 + online(relay `listRunners`) + **논리 클라우드 호스트(항상 online)** + `isCurrent`
   - workspace 메타 `hostDeviceId`(local) — 생성 시 자동 태깅, 목록 응답에 `hostName`/`hostOnline` 인리치
   - `POST /api/daemon/workspaces/:wsId/claim` — 기존 무귀속 로컬 워크스페이스를 호스트가 클레임(백필)
   - (미구현) 모바일 controller 등록(role=controller, deviceToken) = Step 4 에서
3. **PC** ✅ (2026-07-12, 하네스 검증)
   - 설정 "연결"→"계정" 리네임 + 문구 리프레이밍(로그인=이 기기 등록), **QR/코드 페어링 UI 제거**
   - "내 기기" 목록(`fetch_devices` → 온라인 점 + "이 기기" 배지 + 클라우드 호스트)
   - 워크스페이스 host 백필: `path_exists`로 이 기기에 폴더 있으면 `claim_workspace`(init `reconcileWorkspaceHosts`)
   - Rust: `fetch_devices` · `claim_workspace` · `fsapi::path_exists`
4. **모바일**(`codingpt_app`)
   - **Step 4a** ✅ (2026-07-12, tsc 통과 · 에뮬 검증 대기): 백엔드 dual-auth(user JWT ↔ deviceToken) on
     `/devices`·`/workspaces`·session. `daemonService.listDevices/getWorkspaceSession/putWorkspaceSession/claimWorkspace`.
     ConnectionsContent 단일 PC → **"내 기기" 목록**(hosts + 클라우드, online). ProjectsScreen 로컬 워크스페이스
     **호스트 배지**(hostName + online, `hostDeviceId`→device map). `WorkspaceMeta` host 필드.
   - **Step 4b** (남음): ① 워크스페이스 열기 = 그 `hostDeviceId` 로 라우팅(`activateRunner(deviceId)` 후 연결) ②
     세션 이어받기(session.json 읽어 열린 표면 복원 + 앱이 상태 변화 시 PUT) ③ 모바일 controller 등록
     (role=controller → "내 기기"에 폰·태블릿 표시 + 원격 로그아웃) ④ 오프라인 호스트 안내 + 클라우드 대안.

## 8. 확정 결정 (2026-07-12 합의)

1. **모바일 기본 화면 = 워크스페이스 전역 목록.** 각 항목에 호스트 배지 + 온라인 점. 기기는 배지/필터.
2. **오프라인 로컬 호스트**: 목록엔 보이되(오프라인 표시), 열려고 하면 "이 워크스페이스가 있는 기기가 꺼져
   있어요" 안내. **단, 항상 켜진 클라우드 호스트를 기본 제공**하므로 사용자는 그 PC를 켜거나 클라우드 호스트를
   쓰면 됨. (오프라인 로컬 → 클라우드 자동 materialize 는 후속 옵션, 지금은 안내까지)
3. **모든 기기 노출 + 원격 로그아웃.** 호스트(PC)뿐 아니라 컨트롤러(폰·태블릿)까지 "내 기기" 목록에 표시,
   분실 기기 원격 로그아웃/해제 지원(보안).
4. **동시 편집 = last-writer-wins 만.** 별도 잠금 없음, 사용자 주의. 순차 핸드오프(태블릿→폰) 시나리오엔 충분.
5. **클라우드 = 기기 하나("항상 켜진 클라우드 호스트")로 통일.** 별도 "클라우드 워크스페이스" 개념 대신
   클라우드 호스트에 사는 워크스페이스로 표현(M5 러너 = 그 호스트의 실행 백엔드).

## 9. 기기 종류별 온라인/실행 정리

| 기기 | 호스트? | 온라인 판정 | 워크스페이스 실행 |
|------|--------|-----------|-----------------|
| 데스크톱 앱(내 PC) | ✅ | 제어 WS 연결 시 online | 로컬 tmux/데몬 |
| 클라우드 호스트(우리 제공) | ✅ | **항상 online**(콜드스타트) | M5 클라우드 러너 컨테이너 |
| 모바일 앱(폰·태블릿) | ❌(컨트롤러) | 앱 활성 시 | (없음 — 남의 호스트를 봄) |
