#!/bin/bash
# 스토어 심사 감시 → 승인되면 출시. launchd 가 주기적으로 한 번씩 부른다(세션·터미널과 무관, 재부팅 후에도 계속).
#
#   설치:  bash scripts/store/auto-release.sh install <ios 버전> <android 버전>   # 예: install 0.4.21 0.4.38
#   상태:  bash scripts/store/auto-release.sh status
#   해제:  bash scripts/store/auto-release.sh uninstall
#   (launchd 가 부르는 것) auto-release.sh check <ios 버전> <android 버전>
#
# check 한 번이 하는 일:
#   iOS     PENDING_DEVELOPER_RELEASE(승인·출시 대기) → asc.mjs release --yes
#           READY_FOR_DISTRIBUTION → 게시 완료
#           REJECTED 계열 → 알림 후 감시 종료(사유는 API 로 못 읽는다 — App Store Connect 에서 확인)
#   Android PUBLISHED → 게시 완료 / APPROVED_NOT_PUBLISHED → 알림(관리형 게시가 켜져 있으면 콘솔에서 게시)
#           NOT_APPROVED → 알림 후 감시 종료
#   두 스토어 모두 끝나면(게시 또는 거절) 스스로 launchd 에서 내린다.
# 기록: ~/Library/Logs/codingpt-auto-release.log · 상태가 바뀔 때마다 macOS 알림.
set -uo pipefail

LABEL="com.codingpt.auto-release"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/codingpt-auto-release.log"
STATE_DIR="$HOME/.codingpt/auto-release"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
STORE_DIR="$(cd "$(dirname "$0")" && pwd)"
INTERVAL="${AUTO_RELEASE_INTERVAL:-600}"

# 자격증명(키 파일 경로는 asc.mjs 기본값 ~/.appstoreconnect/private_keys). 키 ID·Issuer 는 비밀이 아니다.
export ASC_KEY_ID="${ASC_KEY_ID:-N5ZVQFND28}"
export ASC_ISSUER_ID="${ASC_ISSUER_ID:-f1908b5f-e631-41e0-b723-3b46c7c13041}"
unset NODE_OPTIONS   # 셸의 낡은 preload 가 남아 있으면 node 가 즉사한다(release_automation 함정)

log() { mkdir -p "$(dirname "$LOG")"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
notify() { /usr/bin/osascript -e "display notification \"${2}\" with title \"${1}\" sound name \"Glass\"" >/dev/null 2>&1 || true; log "알림: ${1} — ${2}"; }

find_node() {
  for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$n" ] && [ -x "$n" ] && { echo "$n"; return; }
  done
}

# 상태가 바뀌었을 때만 true(같은 알림 반복 방지)
changed() { mkdir -p "$STATE_DIR"; local f="$STATE_DIR/$1" v="$2"; [ "$(cat "$f" 2>/dev/null)" = "$v" ] && return 1; echo "$v" > "$f"; return 0; }

check() {
  local ios="$1" and="$2" node; node="$(find_node)"
  [ -n "$node" ] || { log "node 를 찾지 못함"; return 1; }
  local ios_done=0 and_done=0

  # ── iOS ──
  local a ist
  a="$("$node" "$STORE_DIR/asc.mjs" status 2>&1)"
  ist="$(printf '%s\n' "$a" | awk -v v="$ios" '$1==v {print $2; exit}')"
  if [ -z "$ist" ]; then log "iOS ${ios}: 상태 조회 실패 — $(printf '%s' "$a" | tail -1)"
  else
    changed ios "$ist" && log "iOS ${ios}: ${ist}"
    case "$ist" in
      PENDING_DEVELOPER_RELEASE)
        log "iOS ${ios}: 승인됨 → 출시"
        if "$node" "$STORE_DIR/asc.mjs" release --yes >> "$LOG" 2>&1; then notify "CodingPT iOS ${ios}" "심사 통과 — 출시했어요"; else notify "CodingPT iOS ${ios}" "출시 명령 실패 — 로그 확인"; fi ;;
      READY_FOR_DISTRIBUTION|READY_FOR_SALE)
        ios_done=1; changed ios-done 1 && notify "CodingPT iOS ${ios}" "게시 완료" ;;
      REJECTED|METADATA_REJECTED|INVALID_BINARY|DEVELOPER_REJECTED|REMOVED_FROM_SALE)
        ios_done=1; changed ios-done 1 && notify "CodingPT iOS ${ios}" "심사 결과 ${ist} — App Store Connect 에서 사유 확인" ;;
    esac
  fi

  # ── Android ──
  local p ast
  p="$("$node" "$STORE_DIR/play.mjs" status 2>&1)"
  ast="$(printf '%s\n' "$p" | awk -v v="$and" '$1=="production" && $2==v {print $3; exit}')"
  if [ -z "$ast" ]; then log "Android ${and}: 상태 조회 실패 — $(printf '%s' "$p" | tail -1)"
  else
    changed and "$ast" && log "Android ${and}: ${ast}"
    case "$ast" in
      PUBLISHED|COMPLETED)
        and_done=1; changed and-done 1 && notify "CodingPT Android ${and}" "게시 완료" ;;
      APPROVED_NOT_PUBLISHED)
        changed and-appr 1 && notify "CodingPT Android ${and}" "승인됨 — 관리형 게시라 Play Console 에서 '게시' 필요" ;;
      NOT_APPROVED)
        and_done=1; changed and-done 1 && notify "CodingPT Android ${and}" "거절됨 — Play Console 에서 사유 확인" ;;
    esac
  fi

  if [ "$ios_done" = 1 ] && [ "$and_done" = 1 ]; then
    log "두 스토어 모두 끝남 → 감시 해제"
    notify "CodingPT 출시 감시" "iOS ${ios} · Android ${and} 처리 끝 — 감시를 내립니다"
    rm -rf "$STATE_DIR"
    launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
    rm -f "$PLIST"
  fi
}

install() {
  local ios="$1" and="$2"
  mkdir -p "$(dirname "$PLIST")"; rm -rf "$STATE_DIR"
  local node_dir; node_dir="$(dirname "$(find_node)")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>${SELF}</string><string>check</string><string>${ios}</string><string>${and}</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${node_dir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StartInterval</key><integer>${INTERVAL}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  log "감시 시작: iOS ${ios} · Android ${and} (${INTERVAL}초마다)"
  echo "설치됨: ${PLIST} (${INTERVAL}초마다) · 로그 ${LOG}"
}

case "${1:-}" in
  install)   [ $# -eq 3 ] || { echo "사용법: $0 install <ios 버전> <android 버전>"; exit 1; }; install "$2" "$3" ;;
  check)     [ $# -eq 3 ] || exit 1; check "$2" "$3" ;;
  status)    launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | grep -E "state|last exit|run interval|arguments" -A0 || echo "감시 없음"; tail -8 "$LOG" 2>/dev/null ;;
  uninstall) launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; rm -f "$PLIST"; rm -rf "$STATE_DIR"; log "감시 해제(수동)"; echo "해제됨" ;;
  *) sed -n 2,7p "$0"; exit 1 ;;
esac
