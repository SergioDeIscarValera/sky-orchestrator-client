#!/usr/bin/env bash
#
# Apply this repository's GitHub configuration: merge behaviour, automatic
# deletion of merged branches, default branch, rulesets and labels. The
# configuration lives in .github/rulesets/*.json and below, reviewed like any
# change; this script only applies it, idempotently.
#
# Rulesets need a public repository or GitHub Pro. On a private repository on the
# free plan the script applies everything else and says plainly what it could not
# (docs/github-governance.md).
#
# Usage:
#   tools/setup_github.sh            apply
#   tools/setup_github.sh --dry-run  show what would be applied
#
# Exit status: 0 applied, 1 something failed, 2 applied except what the plan forbids.

set -uo pipefail

MODE=apply
case "${1:-}" in
  --dry-run) MODE=dry-run ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 1 ;;
esac

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || exit 1
ROOT="$(git rev-parse --show-toplevel)" || exit 1

APPLIED=()
PLAN_LIMITED=()
FAILED=()

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { printf '  %s\n' "$*"; }

attempt() {
  local what="$1"; shift
  if [[ "$MODE" == dry-run ]]; then
    step "would apply: $what"
    return 0
  fi
  local output
  if output="$("$@" 2>&1)"; then
    step "applied: $what"
    APPLIED+=("$what")
  elif grep -qiE 'upgrade to github (pro|team)|make this repository public' <<<"$output"; then
    step "unavailable on this plan: $what"
    PLAN_LIMITED+=("$what")
  else
    step "FAILED: $what"
    printf '    %s\n' "$output" | head -5
    FAILED+=("$what")
  fi
}

say "Repository: $REPO ($(gh repo view --json visibility -q .visibility))"

say "Merge behaviour"
attempt "merge commits only, merged branches deleted automatically" \
  gh api -X PATCH "repos/$REPO" \
    -F allow_merge_commit=true \
    -F allow_squash_merge=false \
    -F allow_rebase_merge=false \
    -F delete_branch_on_merge=true \
    -f merge_commit_title=MERGE_MESSAGE \
    -f merge_commit_message=PR_TITLE \
    -F has_wiki=false \
    -F has_projects=false \
    --silent

say "Default branch"
if git ls-remote --exit-code --heads origin develop >/dev/null 2>&1; then
  attempt "default branch is develop" gh api -X PATCH "repos/$REPO" -f default_branch=develop --silent
else
  step "develop does not exist on the remote yet; skipped"
fi

say "Rulesets"
existing="$(gh api "repos/$REPO/rulesets" --jq '.[] | "\(.name)\t\(.id)"' 2>/dev/null || true)"
for file in "$ROOT"/.github/rulesets/*.json; do
  name="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["name"])' "$file")"
  id="$(printf '%s\n' "$existing" | awk -F'\t' -v n="$name" '$1 == n {print $2}')"
  if [[ -n "$id" ]]; then
    attempt "ruleset '$name' updated" gh api -X PUT "repos/$REPO/rulesets/$id" --input "$file" --silent
  else
    attempt "ruleset '$name' created" gh api -X POST "repos/$REPO/rulesets" --input "$file" --silent
  fi
done

say "Labels"
label() { attempt "label '$1'" gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force; }
label breaking      b60205 "Changes an interface other code depends on"
label enhancement   0e8a16 "New behaviour"
label bug           d73a4a "Corrected behaviour"
label safety        e11d21 "Can command an aircraft, or change when one is commanded"
label documentation 0075ca "Documentation, requirements or decision records"
label tooling       c5def5 "Repository tooling"
label ci            c5def5 "Pipelines"
label dependencies  ededed "Dependency updates"
label no-changelog  ededed "Excluded from generated release notes"

say "Summary"
step "${#APPLIED[@]} applied, ${#PLAN_LIMITED[@]} unavailable on this plan, ${#FAILED[@]} failed"
if (( ${#PLAN_LIMITED[@]} )); then
  printf '\n  Needs a public repository or GitHub Pro:\n'
  printf '    %s\n' "${PLAN_LIMITED[@]}"
fi
if (( ${#FAILED[@]} )); then
  exit 1
fi
(( ${#PLAN_LIMITED[@]} )) && exit 2
exit 0
