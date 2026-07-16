#!/usr/bin/env python3
"""PreToolUse(Bash) 훅 — git 커밋 안전 가드.

차단 규칙(exit 2 = 도구 실행 차단, stderr가 Claude에게 전달됨):
  1. 커밋 메시지에 Claude/AI 흔적(Co-Authored-By, Generated with, 🤖, 메시지 내 'claude') 금지
  2. .env 계열 파일을 git add/commit 대상으로 지정 금지(.env.example 제외)

주의: 'claude' 검사는 -m 메시지 인자에만 적용(경로 .claude/ 커밋은 정상 허용).
동일 사본이 codingpt_app/.claude/hooks/ 에도 있음 — 수정 시 양쪽 동기화.
"""
import json
import re
import shlex
import sys


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if "git" not in cmd:
        return 0

    is_commit = re.search(r"\bgit\b[^|;&]*\bcommit\b", cmd)

    # 1) 메시지 어디에도 나타나면 안 되는 시그니처(경로와 무관하게 전체 문자열 검사)
    if is_commit and re.search(r"co-authored-by|generated with|🤖", cmd, re.I):
        print("커밋 메시지에 Claude/AI 흔적(Co-Authored-By 등) 금지 — 사용자 규칙. 메시지에서 제거 후 재시도.", file=sys.stderr)
        return 2

    # 토큰 분해(실패 시 원문 기반 보수적 검사)
    try:
        toks = shlex.split(cmd)
    except ValueError:
        toks = cmd.split()

    # 2) -m/-am 메시지 인자 안의 claude 언급 차단
    #    단, 파일명 언급(CLAUDE.md, .claude/)은 정상 — 제거 후 검사
    def has_claude(msg):
        cleaned = re.sub(r"CLAUDE\.md|\.claude\b", "", msg, flags=re.I)
        return re.search(r"claude|anthropic", cleaned, re.I)

    if is_commit:
        for i, t in enumerate(toks):
            if t in ("-m", "-am", "--message") and i + 1 < len(toks):
                if has_claude(toks[i + 1]):
                    print("커밋 메시지에 Claude 언급 금지 — 사용자 규칙. 메시지 수정 후 재시도.", file=sys.stderr)
                    return 2
            if t.startswith("--message="):
                if has_claude(t):
                    print("커밋 메시지에 Claude 언급 금지 — 사용자 규칙.", file=sys.stderr)
                    return 2

    # 3) .env 파일 스테이징/커밋 차단
    if re.search(r"\bgit\b[^|;&]*\b(add|commit)\b", cmd):
        for t in toks:
            base = t.rsplit("/", 1)[-1]
            if re.match(r"^\.env(\.|$)", base) and not base.startswith(".env.example"):
                print(f".env 파일({t}) 커밋 금지 — 시크릿 포함. .gitignore 확인.", file=sys.stderr)
                return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
