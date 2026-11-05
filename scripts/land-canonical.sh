#!/usr/bin/env bash
# summary: Land a ref into the canonical checkout, which live Pi sessions load extensions from: move, install the packages whose manifests changed, admit the installs of the packages whose files moved, link host packages to the Pi on PATH, smoke-test Pi, and move back on any failure.
# read_when:
#   - "You want the canonical pi-extensions checkout at a newer commit (instead of pull, merge or reset by hand)."
#   - "Pi fails with 'Failed to load extension' after the checkout moved."
# Why (2026-09-27, AK6069): `git reset --hard origin/main` here brought a TypeScript 7 import without its
# install, no hook runs on reset, and every Pi start failed for ~25 min. Design: softwareco/infra/workstation
# docs/project/2026-09-27-live-runtime-promotion-design.md.
#
# usage: scripts/land-canonical.sh [--reset] <ref>
#   default   fast-forward only; uncommitted changes of other sessions stay (git refuses an overlap)
#   --reset   reset to <ref> even when it is not a fast-forward; refused while tracked files are modified
# Env: PI_SMOKE_CMD (default `pi --no-session -p ""`: loads every extension like a session, calls no model; `--list-models` tolerates a broken extension), PI_SMOKE_TIMEOUT_S (default 120),
#      LAND_NO_FETCH=1 skips `git fetch`.
#
# Admission scope (2026-11-05): install health is admitted for the packages whose *files* the move
# touches, not for the whole checkout. A source-only commit still changes what live Pi sessions load,
# so its package must be admitted; siblings that were never installed here are not this landing's
# business. Anything that cannot be attributed to an installable package keeps the fleet-wide check,
# because narrowing to nothing would report "consistent" without checking anything.
set -euo pipefail

mode=ff
if [[ "${1:-}" == "--reset" ]]; then mode=reset; shift; fi
[[ $# -eq 1 ]] || { echo "usage: land-canonical.sh [--reset] <ref>" >&2; exit 2; }
ref="$1"

root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ "$(realpath "$(git rev-parse --git-dir)")" == "$(realpath "$(git rev-parse --git-common-dir)")" ]] ||
  { echo "land-canonical: run this in the canonical checkout, not a linked worktree" >&2; exit 2; }
[[ "${LAND_NO_FETCH:-}" == 1 ]] || git fetch --quiet origin
target="$(git rev-parse --verify "$ref^{commit}")"
previous="$(git rev-parse HEAD)"
if [[ "$target" == "$previous" ]]; then echo '{"outcome":"unchanged","head":"'"$previous"'"}'; exit 0; fi
if [[ "$mode" == ff ]] && ! git merge-base --is-ancestor "$previous" "$target"; then
  echo "land-canonical: $ref is not a fast-forward of HEAD; use --reset (which needs a clean tracked tree)" >&2; exit 2
fi
if [[ "$mode" == reset && -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "land-canonical: tracked files are modified here; --reset would discard another session's work" >&2; exit 2
fi

# packages whose manifest or lock differs between two commits, as directories (the validator's topology)
changed_packages() {
  git diff --name-only "$1" "$2" -- 'package.json' 'package-lock.json' \
    'packages/*/package.json' 'packages/*/package-lock.json' \
    'packages/*/*/package.json' 'packages/*/*/package-lock.json' |
    xargs -r -n1 dirname | sort -u
}

# Packages that install from a tracked lock, at a commit. Only these are admission subjects.
# `git ls-tree` accepts literal paths only (it rejects `:(glob)`), so the owned topology is filtered
# here the same way validate-package-installs.mjs filters tracked manifests, then each candidate must
# carry a tracked lock. `|| true`: no match is a legitimate answer, not an error.
installable_packages() {
  git ls-tree -r --name-only "$1" |
    grep -E '^packages/[^/]+/([^/]+/)?package\.json$' |
    sed 's|/package.json$||' | sort -r |
    while IFS= read -r dir; do
      if git cat-file -e "$1:$dir/package-lock.json" 2>/dev/null; then printf '%s\n' "$dir"; fi
    done || true
}

# Sets admission_owners (deepest installable owner per changed file) and admission_fleet.
# The longest matching owner wins, so a package-group child beats its parent package whatever order
# the tree listing produced.
admission_scope() {
  local previous="$1" target="$2" file owner candidate
  local -a installable=()
  mapfile -t installable < <(installable_packages "$target")
  admission_owners=()
  admission_fleet=0
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    # A root manifest can change the install topology of every package; never narrow it away.
    case "$file" in package.json|package-lock.json) admission_fleet=1; continue ;; esac
    owner=''
    for candidate in "${installable[@]}"; do
      case "$file" in "$candidate"/*) if [[ ${#candidate} -gt ${#owner} ]]; then owner="$candidate"; fi ;; esac
    done
    if [[ -n "$owner" ]]; then admission_owners+=("$owner"); fi
  done < <(git diff --name-only "$previous" "$target")
  # docs, scripts and root files own no install; a diff made only of those keeps the fleet-wide check.
  if [[ ${#admission_owners[@]} -eq 0 ]]; then admission_fleet=1; fi
  if [[ ${#admission_owners[@]} -gt 0 ]]; then
    mapfile -t admission_owners < <(printf '%s\n' "${admission_owners[@]}" | sort -u)
  fi
}

install_packages() {
  local dir
  # shellcheck source=/dev/null
  [[ -f scripts/select-gate-node.sh ]] && source scripts/select-gate-node.sh
  for dir in "$@"; do
    [[ -f "$dir/package-lock.json" ]] || continue
    echo "land-canonical: npm ci --prefix $dir" >&2
    npm ci --prefix "$dir" --no-audit --no-fund >&2 || return 1
  done
}

smoke() {
  local out status=0
  local cmd=(pi --no-session -p "")
  # shellcheck disable=SC2206 # an override is a plain command line
  [[ -n "${PI_SMOKE_CMD:-}" ]] && cmd=($PI_SMOKE_CMD)
  out="$(timeout "${PI_SMOKE_TIMEOUT_S:-120}" "${cmd[@]}" 2>&1 </dev/null)" || status=$?
  if [[ $status -ne 0 ]] || grep -q 'Failed to load extension' <<<"$out"; then
    echo "land-canonical: Pi smoke failed (exit $status): $(grep -m1 -E 'Failed to load extension|Error' <<<"$out" || tail -n1 <<<"$out")" >&2
    return 1
  fi
}

# The admission is the one step that knows which owners this move is responsible for.
health() {
  local owner
  local -a args=()
  if [[ $admission_fleet -eq 1 ]]; then
    echo 'land-canonical: install health (fleet-wide)' >&2
    node scripts/package-install-health.mjs >&2
    return
  fi
  for owner in "${admission_owners[@]}"; do args+=(--package-root "$owner"); done
  echo "land-canonical: install health (scoped: ${admission_owners[*]})" >&2
  node scripts/package-install-health.mjs "${args[@]}" >&2
}

# Host-provided packages (pi-ai, pi-agent-core, pi-coding-agent, pi-tui, typebox) installed here become links
# to the Pi on PATH, so compiled ESM loaded natively from a sibling package shares the host's modules (AK6828).
check() { install_packages "$@" && node scripts/link-host-packages.mjs >&2 && health && smoke; }

scope_label() {
  if [[ $admission_fleet -eq 1 ]]; then printf 'fleet'; else local IFS=,; printf '%s' "${admission_owners[*]}"; fi
}

receipt() {
  printf '{"outcome":"%s","mode":"%s","ref":"%s","previous":"%s","head":"%s","scope":"%s","installed":"%s"}\n' \
    "$1" "$mode" "$ref" "$previous" "$(git rev-parse HEAD)" "$(scope_label)" "${packages[*]:-}"
}

mapfile -t packages < <(changed_packages "$previous" "$target")
admission_scope "$previous" "$target"
if [[ "$mode" == ff ]]; then git merge --quiet --ff-only "$target"; else git reset --quiet --hard "$target"; fi

if check "${packages[@]}"; then receipt landed; exit 0; fi

echo "land-canonical: moving back to $previous" >&2
git reset --quiet --keep "$previous"
if check "${packages[@]}"; then receipt rolled_back; else receipt rollback_unhealthy; fi
exit 1
