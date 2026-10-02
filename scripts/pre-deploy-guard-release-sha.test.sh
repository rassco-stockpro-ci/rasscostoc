#!/usr/bin/env bash
#
# Regression test for the Pre-Deploy Guard's release-sha check
# (scripts/pre-deploy-guard.sh check 12, via scripts/lib/release-sha-check.sh).
#
# This check used to be WARN-only when dist/RELEASE_SHA was absent, and
# only checked mismatch when the file happened to exist -- it never
# actually blocked a deploy. This test proves all four cases are now hard
# pass/fail with no silent WARN path:
#   1. Valid, matching SHA          -> pass (exit 0)
#   2. Missing file                 -> fail (exit 1)
#   3. Malformed / invalid SHA      -> fail (exit 2)
#   4. Valid but stale/old SHA      -> fail (exit 3)
#   5. Dirty-tree build (<sha>-dirty) -> fail (exit 4), even for HEAD
#
# Runs entirely against a throwaway temp directory -- never touches the
# real dist/ or the git index -- so it needs no cleanup of tracked state.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
. scripts/lib/release-sha-check.sh

TMP_DIST="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIST"; }
trap cleanup EXIT

CURRENT_SHA="$(git rev-parse HEAD)"
OLD_SHA="$(git rev-parse HEAD~1 2>/dev/null || echo "0000000000000000000000000000000000000000")"

fail_case() {
  echo "FAIL: $1" >&2
  exit 1
}

# 1. Valid, matching SHA -> pass
echo "$CURRENT_SHA" > "$TMP_DIST/RELEASE_SHA"
REASON="$(check_release_sha "$TMP_DIST" "$CURRENT_SHA")" && STATUS=0 || STATUS=$?
[ "$STATUS" -eq 0 ] || fail_case "expected pass (0) for a valid matching SHA, got $STATUS: $REASON"
echo "PASS: valid matching SHA -> pass (0): $REASON"
rm -f "$TMP_DIST/RELEASE_SHA"

# 2. Missing file -> fail (1)
REASON="$(check_release_sha "$TMP_DIST" "$CURRENT_SHA")" && STATUS=0 || STATUS=$?
[ "$STATUS" -eq 1 ] || fail_case "expected missing-file failure (1), got $STATUS: $REASON"
echo "PASS: missing RELEASE_SHA -> fail (1): $REASON"

# 3. Malformed / invalid SHA -> fail (2)
echo "not-a-real-sha" > "$TMP_DIST/RELEASE_SHA"
REASON="$(check_release_sha "$TMP_DIST" "$CURRENT_SHA")" && STATUS=0 || STATUS=$?
[ "$STATUS" -eq 2 ] || fail_case "expected invalid-format failure (2), got $STATUS: $REASON"
echo "PASS: malformed SHA -> fail (2): $REASON"
rm -f "$TMP_DIST/RELEASE_SHA"

# 4. Valid but stale/old SHA -> fail (3)
echo "$OLD_SHA" > "$TMP_DIST/RELEASE_SHA"
REASON="$(check_release_sha "$TMP_DIST" "$CURRENT_SHA")" && STATUS=0 || STATUS=$?
[ "$STATUS" -eq 3 ] || fail_case "expected mismatch failure (3), got $STATUS: $REASON"
echo "PASS: stale/old SHA -> fail (3): $REASON"
rm -f "$TMP_DIST/RELEASE_SHA"

# 5. Dirty-tree build of the current commit -> fail (4)
echo "$CURRENT_SHA-dirty" > "$TMP_DIST/RELEASE_SHA"
REASON="$(check_release_sha "$TMP_DIST" "$CURRENT_SHA")" && STATUS=0 || STATUS=$?
[ "$STATUS" -eq 4 ] || fail_case "expected dirty-build failure (4), got $STATUS: $REASON"
echo "PASS: dirty build -> fail (4): $REASON"
rm -f "$TMP_DIST/RELEASE_SHA"

echo "PRE_DEPLOY_GUARD_RELEASE_SHA_REGRESSION: ALL CHECKS PASSED"
exit 0
