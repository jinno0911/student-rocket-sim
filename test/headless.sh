#!/usr/bin/env bash
# ヘッドレス Chrome でページを開き、JS 実行後の DOM を stdout、console/例外を stderr に出す。
# usage: bash test/headless.sh <url|file-path> [virtual_time_budget_ms]
#   例: bash test/headless.sh http://localhost:8775/test/physics-test.html
#       bash test/headless.sh test/physics-test.html        (file:// で開く)
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
TARGET="$1"
if [ -f "$TARGET" ]; then TARGET="file:///$(cygpath -m "$(realpath "$TARGET")")"; fi
PROF=$(mktemp -d)
timeout 180 "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$(cygpath -w "$PROF")" --enable-logging=stderr --v=0 \
  --virtual-time-budget="${2:-20000}" --dump-dom "$TARGET" 2> "$PROF/err.txt"
code=$?
grep -E "CONSOLE|Uncaught|SyntaxError|ReferenceError|TypeError" "$PROF/err.txt" | sed 's/^/[console] /' >&2
rm -rf "$PROF"
exit $code
