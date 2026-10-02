#!/usr/bin/env bash
#
# Shared by scripts/pre-deploy-guard.sh (check 12) and
# scripts/pre-deploy-guard-release-sha.test.sh.
#
# Validates that a built artifact's dist/RELEASE_SHA (written by
# scripts/write-release-sha.cjs as part of `npm run build`) exists, is a
# well-formed full git SHA, and matches the commit that is actually
# supposed to be deployed. Historically this was a WARN-only check that
# silently did nothing when the file was absent -- it never actually
# blocked a stale or mismatched build from deploying. All three failure
# modes below are now hard failures.
#
# Usage: check_release_sha <dist_dir> <expected_sha>
#   <dist_dir>:     path to the directory that should contain RELEASE_SHA
#   <expected_sha>: the full 40-char commit SHA the build is expected to
#                   match (normally the source HEAD at guard-run time)
#
# Prints a human-readable reason to stdout and returns:
#   0  - RELEASE_SHA present, well-formed, and matches expected_sha
#   1  - RELEASE_SHA missing
#   2  - RELEASE_SHA present but not a well-formed 40-char hex SHA
#   3  - RELEASE_SHA present, well-formed, but does not match expected_sha
#   4  - RELEASE_SHA is "<sha>-dirty": the artifact was built from
#        uncommitted changes (scripts/write-release-sha.cjs) and is not a
#        release of any commit
check_release_sha() {
  local dist_dir="$1"
  local expected_sha="$2"
  local release_sha_file="$dist_dir/RELEASE_SHA"
  local build_sha

  if [ ! -f "$release_sha_file" ]; then
    echo "missing: $release_sha_file does not exist"
    return 1
  fi

  build_sha="$(tr -d '[:space:]' < "$release_sha_file")"

  if [[ "$build_sha" =~ ^[0-9a-f]{40}-dirty$ ]]; then
    echo "dirty: $release_sha_file is '$build_sha' -- built from uncommitted changes, not a release of any commit"
    return 4
  fi

  if ! [[ "$build_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "invalid: $release_sha_file contains '$build_sha', not a well-formed 40-char lowercase hex SHA"
    return 2
  fi

  if [ "$build_sha" != "$expected_sha" ]; then
    echo "mismatch: $release_sha_file ($build_sha) does not match expected commit ($expected_sha) -- stale or wrong build"
    return 3
  fi

  echo "ok: $release_sha_file matches $expected_sha"
  return 0
}
