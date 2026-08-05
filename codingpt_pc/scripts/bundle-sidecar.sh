#!/usr/bin/env bash
# CodingPT PC — 데몬 사이드카 번들 조립
#
# Tauri 앱이 실사용자 PC에서 Node 없이 데몬을 돌리도록, portable Node 런타임 + 데몬 소스 +
# 런타임 node_modules(node-pty 타깃 prebuild만)을 src-tauri/resources/daemon/ 에 조립한다.
#
# 사용법: bundle-sidecar.sh [target]
#   target = darwin-arm64(기본) | darwin-x64 | win32-x64
#
# node-pty 는 prebuildify 방식이라 재컴파일 불필요 — 타깃 prebuild 만 남기면 된다.
set -euo pipefail

TARGET="${1:-darwin-arm64}"
NODE_VERSION="${NODE_VERSION:-22.18.0}"

# ── 릴리스 서명 필수화 ──
#  CPT_RELEASE=1(= tauri build 경로)이면 Developer ID 서명이 필수다. ad-hoc 릴리스 배포물은
#  Gatekeeper/업데이터 서명 검증에서 깨지고, 과거 "서명키 없으면 조용히 ad-hoc" 이 사고 원인.
#  CODESIGN_IDENTITY 미지정 시 키체인의 Developer ID Application 을 자동 탐지, 그래도 없으면 중단.
#  dev(tauri dev)는 기존대로 ad-hoc 허용(오프라인/속도 — --timestamp 는 네트워크 필요).
if [ "${CPT_RELEASE:-}" = "1" ] && [ -z "${CODESIGN_IDENTITY:-}" ]; then
  CODESIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  if [ -n "$CODESIGN_IDENTITY" ]; then
    export CODESIGN_IDENTITY
    echo "▸ 릴리스 서명 ID 자동 탐지: $CODESIGN_IDENTITY"
  else
    echo "✗ 릴리스 빌드에 코드서명 ID가 없습니다 — 키체인에 'Developer ID Application' 인증서가 필요합니다(ad-hoc 릴리스 금지)." >&2
    exit 1
  fi
fi

PC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_SRC="$(cd "$PC_DIR/../codingpt_daemon" && pwd)"
OUT="$PC_DIR/src-tauri/resources/daemon"
CACHE="$PC_DIR/.node-cache"

echo "▸ target=$TARGET  node=v$NODE_VERSION"
echo "▸ daemon src: $DAEMON_SRC"
echo "▸ out:        $OUT"

# ── 1) portable Node 런타임 확보(캐시) ─────────────────────────────
mkdir -p "$CACHE"
case "$TARGET" in
  darwin-arm64) NODE_PKG="node-v${NODE_VERSION}-darwin-arm64"; NODE_ARC="$NODE_PKG.tar.gz";  NODE_BIN_REL="bin/node";     NODE_OUT="node" ;;
  darwin-x64)   NODE_PKG="node-v${NODE_VERSION}-darwin-x64";   NODE_ARC="$NODE_PKG.tar.gz";  NODE_BIN_REL="bin/node";     NODE_OUT="node" ;;
  win32-x64)    NODE_PKG="node-v${NODE_VERSION}-win-x64";      NODE_ARC="$NODE_PKG.zip";     NODE_BIN_REL="node.exe";     NODE_OUT="node.exe" ;;
  *) echo "✗ 지원하지 않는 target: $TARGET" >&2; exit 1 ;;
esac

if [ ! -f "$CACHE/$NODE_ARC" ]; then
  echo "▸ Node 다운로드: $NODE_ARC"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$NODE_ARC" -o "$CACHE/$NODE_ARC"
fi
rm -rf "$CACHE/$NODE_PKG"
if [[ "$NODE_ARC" == *.zip ]]; then
  ( cd "$CACHE" && unzip -q "$NODE_ARC" )
else
  ( cd "$CACHE" && tar xzf "$NODE_ARC" )
fi

# ── 2) 출력 디렉토리 초기화 + node_modules(런타임 deps) 복사 ────────
# 루트 node_modules 에 dev deps 없음(ws/node-pty/chokidar + transitive) → 통째 복사 후 node-pty 슬림.
rm -rf "$OUT"
mkdir -p "$OUT/app"
cp -R "$DAEMON_SRC/node_modules" "$OUT/app/node_modules"

# 워크스페이스 패키지를 node_modules/@codingpt/ 안에 실제 디렉토리로 배치(심링크 X — 배포 안전).
#  require('@codingpt/runner-core') 는 daemon 위치에서 위로 걸어 app/node_modules/@codingpt/runner-core 로 해석되고,
#  runner-core 의 deps(ws/node-pty/chokidar)는 app/node_modules/ 에서 해석된다.
rm -rf "$OUT/app/node_modules/@codingpt"
mkdir -p "$OUT/app/node_modules/@codingpt"
cp -R "$DAEMON_SRC/packages/daemon"       "$OUT/app/node_modules/@codingpt/daemon"
cp -R "$DAEMON_SRC/packages/runner-core"  "$OUT/app/node_modules/@codingpt/runner-core"
# cpt-cli — runner-core/shim.js 가 형제 디렉토리(../cpt-cli/bin/cpt.js)로 해석하므로 반드시 동봉
cp -R "$DAEMON_SRC/packages/cpt-cli"      "$OUT/app/node_modules/@codingpt/cpt-cli"
# 각 패키지 내부의 중첩 node_modules(있으면) 제거 — 루트로 통일
rm -rf "$OUT/app/node_modules/@codingpt/daemon/node_modules" "$OUT/app/node_modules/@codingpt/runner-core/node_modules" "$OUT/app/node_modules/@codingpt/cpt-cli/node_modules" 2>/dev/null || true

# .bin 워크스페이스 심링크 제거 — cloud-runner 등 미번들 대상을 가리키는 깨진 심링크가
#  Tauri 리소스 수집을 실패시킨다(런타임엔 node index.js 로 직접 실행하므로 불필요).
rm -rf "$OUT/app/node_modules/.bin"
# 그 밖의 깨진 심링크가 남아있으면 정리(리소스 수집 안전).
find "$OUT/app/node_modules" -type l ! -exec test -e {} \; -delete 2>/dev/null || true

PTY="$OUT/app/node_modules/node-pty"
if [ -d "$PTY" ]; then
  # 빌드타임/타 플랫폼 잔재 제거 — 런타임에 불필요
  rm -rf "$PTY/deps" "$PTY/third_party" "$PTY/src" "$PTY/scripts" "$PTY/build" 2>/dev/null || true
  # 타깃 platform-arch prebuild 만 남긴다(다른 arch 는 서명 대상이 되고 dmg 는 arch 전용이므로 제거).
  KEEP="$TARGET"
  if [ -d "$PTY/prebuilds" ]; then
    for d in "$PTY/prebuilds"/*; do
      name="$(basename "$d")"
      keep=0
      for k in $KEEP; do [ "$name" = "$k" ] && keep=1; done
      [ "$keep" -eq 0 ] && rm -rf "$d"
    done
  fi
fi

# serve-sim(iOS 시뮬레이터 라이브 화면·조작) 슬림.
#  · Sources/ 는 Swift 원본이라 런타임에 필요 없다.
#  · simcam(카메라 주입 dylib)은 **일부러 뺀다.** 우리는 카메라를 안 쓰는데, 서명된 채 공증 티켓이
#    없는 dylib 을 앱 번들에 넣으면 Gatekeeper(syspolicyd)를 건드릴 수 있다 — Orca 가 런타임을
#    통째로 밖에 복사하는 이유가 바로 이 파일이다. 안 쓰는 위험은 아예 들이지 않는다.
SS="$OUT/app/node_modules/serve-sim"
if [ -d "$SS" ]; then
  rm -rf "$SS/Sources" "$SS/Package.swift" "$SS/dist/simcam" "$SS/README.md" 2>/dev/null || true
fi

# ── 4) Node 바이너리 배치 ──────────────────────────────────────────
rm -f "$OUT/$NODE_OUT" # in-place 덮어쓰기 금지 — vnode 서명 캐시 불일치로 exec 시 SIGKILL(재빌드 반복 시 재현)
cp "$CACHE/$NODE_PKG/$NODE_BIN_REL" "$OUT/$NODE_OUT"
chmod +x "$OUT/$NODE_OUT" 2>/dev/null || true

# ── 4b) tmux 번들 (darwin) — 사용자 무설치. tmux + 의존 dylib 을 자립화(@loader_path) ──
#  데몬 터미널은 tmux 기반(지속성/미러/다중탭)인데 macOS 는 tmux 미탑재 → 앱에 동봉한다.
#  빌드머신의 tmux(+libevent/ncurses/utf8proc)를 복사·경로상대화해 homebrew 없이 실행되게 만든다.
#  데몬은 lib.rs 가 주입하는 CODINGPT_TMUX(=이 경로)로 이 tmux 를 우선 사용한다.
if [[ "$TARGET" == darwin-* ]]; then
  HOST_TMUX="$(command -v tmux || true)"
  if [ -z "$HOST_TMUX" ]; then
    echo "⚠ 빌드머신에 tmux 미설치 — tmux 번들 건너뜀(사용자 PC 에서 tmux 필요). 'brew install tmux' 후 재빌드 권장." >&2
  else
    echo "▸ tmux 번들: $HOST_TMUX ($("$HOST_TMUX" -V))"
    TMUX_OUT="$OUT/tmux"
    rm -rf "$TMUX_OUT"; mkdir -p "$TMUX_OUT/bin" "$TMUX_OUT/lib"
    rm -f "$TMUX_OUT/bin/tmux" # 새 inode 보장(서명 캐시)
    cp "$HOST_TMUX" "$TMUX_OUT/bin/tmux"; chmod +w "$TMUX_OUT/bin/tmux"
    # non-system 의존 dylib 재귀 수집
    collect_dylibs() {
      local f="$1"
      otool -L "$f" 2>/dev/null | sed '1d' | awk '{print $1}' | grep -vE '^/usr/lib|^/System' | while IFS= read -r dep; do
        local real="${dep/@@HOMEBREW_PREFIX@@//opt/homebrew}"
        [ -f "$real" ] || real="$dep"
        local base; base="$(basename "$real")"
        if [ -f "$real" ] && [ ! -f "$TMUX_OUT/lib/$base" ]; then
          rm -f "$TMUX_OUT/lib/$base" # 새 inode 보장(서명 캐시)
          cp "$real" "$TMUX_OUT/lib/$base"; chmod +w "$TMUX_OUT/lib/$base"
          collect_dylibs "$TMUX_OUT/lib/$base"
        fi
      done
    }
    collect_dylibs "$TMUX_OUT/bin/tmux"
    # 번들된 dylib basename 목록(배열) — 리터럴 반복으로 재배치(pipefail/set-e 안전).
    LIBS=()
    for f in "$TMUX_OUT/lib/"*.dylib; do [ -e "$f" ] && LIBS+=("$(basename "$f")"); done
    # dylib: id=@loader_path/<base>, 상호의존 상대화
    for base in "${LIBS[@]}"; do
      install_name_tool -id "@loader_path/$base" "$TMUX_OUT/lib/$base" 2>/dev/null || true
      for dep in "${LIBS[@]}"; do
        old="$(otool -L "$TMUX_OUT/lib/$base" | awk '{print $1}' | grep "/$dep$" | head -1 || true)"
        [ -n "$old" ] && install_name_tool -change "$old" "@loader_path/$dep" "$TMUX_OUT/lib/$base" 2>/dev/null || true
      done
    done
    # tmux: dep=@executable_path/../lib/<base>
    for dep in "${LIBS[@]}"; do
      old="$(otool -L "$TMUX_OUT/bin/tmux" | awk '{print $1}' | grep "/$dep$" | head -1 || true)"
      [ -n "$old" ] && install_name_tool -change "$old" "@executable_path/../lib/$dep" "$TMUX_OUT/bin/tmux" 2>/dev/null || true
    done
    # 자립성 검증 — homebrew 참조가 남으면 중단(사용자 PC 에서 깨짐).
    if otool -L "$TMUX_OUT/bin/tmux" "$TMUX_OUT/lib/"*.dylib 2>/dev/null | grep -q '/opt/homebrew\|@@HOMEBREW'; then
      echo "✗ tmux 번들에 homebrew 참조 잔존 — 중단" >&2; exit 1
    fi
    # 서명(하드닝) — dylib 무권한, tmux 실행권한(entitlements). CODESIGN_IDENTITY 없으면 ad-hoc.
    if [ -n "${CODESIGN_IDENTITY:-}" ]; then
      ENT="$PC_DIR/src-tauri/entitlements.sidecar.plist"
      for lib in "$TMUX_OUT/lib/"*.dylib; do
        codesign --force --timestamp --options runtime --sign "$CODESIGN_IDENTITY" "$lib"
      done
      codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$CODESIGN_IDENTITY" "$TMUX_OUT/bin/tmux"
      codesign --verify --verbose=1 "$TMUX_OUT/bin/tmux"
    else
      codesign -f -s - "$TMUX_OUT/lib/"*.dylib "$TMUX_OUT/bin/tmux" >/dev/null 2>&1 || true
    fi
    # tmux.conf 동봉 — 데몬·Mac GUI 가 같은 서버 설정(alt-screen off/status off/aggressive-resize)을
    #  공유하도록. lib.rs(tmux.rs resolve_ctx)가 이 경로(<base>/tmux/tmux.conf)를 -f 로 로드한다.
    if [ -f "$DAEMON_SRC/tmux.conf" ]; then
      cp "$DAEMON_SRC/tmux.conf" "$TMUX_OUT/tmux.conf"
      echo "▸ tmux.conf 동봉 → $TMUX_OUT/tmux.conf"
    fi
    echo "▸ tmux 번들 완료 → $TMUX_OUT ($("$TMUX_OUT/bin/tmux" -V), dylib: $(ls "$TMUX_OUT/lib" | tr '\n' ' '))"
  fi
fi

# ── 5) 사이드카 코드 서명(mac, CODESIGN_IDENTITY 설정 시) ───────────
# 공증 통과를 위해 중첩된 실행/네이티브 코드(node 바이너리 + *.node)를 모두 하드닝 런타임으로 서명.
#  Tauri 는 바깥 .app 만 서명하므로 Resources 안의 node/.node 는 여기서 미리 서명한다(복사돼도 서명 유지).
if [[ "$TARGET" == darwin-* && -n "${CODESIGN_IDENTITY:-}" ]]; then
  ENT="$PC_DIR/src-tauri/entitlements.sidecar.plist"
  echo "▸ 사이드카 서명: $CODESIGN_IDENTITY"
  # 번들 안의 모든 Mach-O(실행/라이브러리)를 하드닝 런타임+timestamp 로 서명.
  #  node-pty 는 .node 외에 spawn-helper(실행 바이너리)도 포함하므로 확장자 필터로는 부족 → file 로 Mach-O 판별.
  #  실행 바이너리엔 entitlements(JIT 등) 부여, 라이브러리(.node/.dylib)엔 미부여.
  while IFS= read -r -d '' f; do
    [ "$f" = "$OUT/$NODE_OUT" ] && continue   # node 는 아래에서 별도(entitlements) 서명
    if file "$f" | grep -q 'Mach-O'; then
      case "$f" in
        *.node|*.dylib) codesign --force --timestamp --options runtime --sign "$CODESIGN_IDENTITY" "$f" ;;
        *)              codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$CODESIGN_IDENTITY" "$f" ;;  # 실행 헬퍼(spawn-helper 등)
      esac
    fi
  done < <(find "$OUT/app" -type f -print0)
  # node 실행 바이너리 — JIT 등 entitlements 부여(마지막에 서명).
  codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$CODESIGN_IDENTITY" "$OUT/$NODE_OUT"
  # 검증(실패 시 빌드 중단).
  codesign --verify --verbose=1 "$OUT/$NODE_OUT"
fi

# ── 5.5) dev target 스테일 사본 제거 ─────────────────────────────
# tauri dev 는 resources 를 target/debug/resources 로 "덮어쓰기" 복사한다 — 같은 inode 에
# 덮어쓰면 macOS vnode 서명 캐시 불일치로 node exec 즉시 SIGKILL(137, 실측 재발).
# 미리 지워 두면 tauri 가 새로 만들어 안전하다(릴리스 번들 경로엔 영향 없음).
rm -rf "$PC_DIR/src-tauri/target/debug/resources/daemon" 2>/dev/null || true

# ── 6) 요약 ────────────────────────────────────────────────────────
echo "▸ 번들 크기:"; du -sh "$OUT" | sed 's/^/    /'
echo "▸ node-pty prebuilds:"; ls "$PTY/prebuilds" 2>/dev/null | sed 's/^/    /' || true
echo "✅ 사이드카 조립 완료 → $OUT"
