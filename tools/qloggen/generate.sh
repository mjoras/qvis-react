#!/usr/bin/env bash
# Regenerates the qvis-react demo qlogs (public/examples/, manifests included) and the generated test fixtures
# (tests/fixtures/latest/) with quic-go v0.64.1 + quic-go-v0.64.1-qlog-latest.patch. See README.md.
#
# usage: tools/qloggen/generate.sh [--no-validate] [--no-fixtures] [scenario-id ...]
#
#   scenario-id    only (re)generate these scenarios of scenarios.json (default: all). The manifests are
#                  rewritten from all scenarios, so the files of the other scenarios must already exist.
#   --no-validate  skip the CDDL validation with scripts/validate-qlog.mjs
#   --no-fixtures  don't copy the small scenarios to tests/fixtures/latest/
#
# environment:
#   QUIC_GO_DIR    patched quic-go v0.64.1 source tree to build against (default: tools/qloggen/quic-go;
#                  if it doesn't exist, quic-go v0.64.1 is cloned there and the patch is applied)
#   CDDL_BIN       the Rust cddl CLI used by the validator (default: cddl on PATH), see scripts/cddl/README.md
#   GO             the go command (default: go; quic-go v0.64.1 needs Go 1.26 or newer)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
EXAMPLES="$ROOT/public/examples"
FIXTURES="$ROOT/tests/fixtures/latest"
PATCH="$HERE/quic-go-v0.64.1-qlog-latest.patch"
QUIC_GO_REPO="https://github.com/quic-go/quic-go.git"
QUIC_GO_VERSION="v0.64.1"
QUIC_GO_DIR="${QUIC_GO_DIR:-$HERE/quic-go}"
GO="${GO:-go}"
BUILD="$HERE/.build"

validate=1
fixtures=1
only=" "
for arg in "$@"; do
  case "$arg" in
    --no-validate) validate=0 ;;
    --no-fixtures) fixtures=0 ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) only="$only$arg " ;;
  esac
done

# ---------------------------------------------------------------- 1. the patched quic-go
if [ ! -e "$QUIC_GO_DIR" ]; then
  echo "==> cloning quic-go $QUIC_GO_VERSION into $QUIC_GO_DIR and applying $(basename "$PATCH")"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$QUIC_GO_VERSION" "$QUIC_GO_REPO" "$QUIC_GO_DIR"
  git -C "$QUIC_GO_DIR" apply "$PATCH"
elif [ -e "$QUIC_GO_DIR/.git" ]; then
  if ! git -C "$QUIC_GO_DIR" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "error: $QUIC_GO_DIR is not quic-go $QUIC_GO_VERSION with exactly $(basename "$PATCH") applied" >&2
    echo "       (git -C $QUIC_GO_DIR apply $PATCH, or remove the directory to have it cloned again)" >&2
    exit 1
  fi
else
  echo "warning: $QUIC_GO_DIR is not a git checkout, can't check that the patch is applied" >&2
fi
QUIC_GO_ABS="$(cd "$QUIC_GO_DIR" && pwd -P)"

# ---------------------------------------------------------------- 2. build the generator
# Build with a copy of go.mod whose replace directive points to QUIC_GO_DIR, leaving go.mod untouched.
echo "==> building qloggen against $QUIC_GO_ABS"
mkdir -p "$BUILD"
cp "$HERE/go.mod" "$BUILD/go.mod"
cp "$HERE/go.sum" "$BUILD/go.sum"
(
  cd "$HERE"
  "$GO" mod edit -modfile="$BUILD/go.mod" -replace "github.com/quic-go/quic-go=$QUIC_GO_ABS"
  "$GO" build -modfile="$BUILD/go.mod" -trimpath \
    -ldflags "-X github.com/quic-go/quic-go/qlogwriter.quicGoVersion=$QUIC_GO_VERSION+qlog-latest" \
    -o "$BUILD/qloggen" .
)

# ---------------------------------------------------------------- 3. run the scenarios
# One line per scenario: id, dir, qlog, fixture, title, description, args, separated by the ASCII unit separator
# (not by tabs: tabs are IFS whitespace, so read would merge them and lose the empty dir field).
scenario_lines() {
  node -e '
    const { scenarios } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const s of scenarios) {
      const f = [s.id, s.dir, s.qlog ? 1 : 0, s.fixture ? 1 : 0, s.title, s.description, s.args.join(" ")];
      if (f.some((x) => /[\x1f\n]/.test(String(x)))) throw new Error("separator or newline in scenario " + s.id);
      console.log(f.join("\x1f"));
    }' "$HERE/scenarios.json"
}

generated=()
fixture_files=()
while IFS=$'\x1f' read -r id dir qlog fixture title description args; do
  case "$only" in " ") ;; *" $id "*) ;; *) continue ;; esac
  out="$EXAMPLES${dir:+/$dir}"
  mkdir -p "$out"
  echo "==> $id: qloggen $args"
  attempt=1
  # shellcheck disable=SC2086 # args is a list of simple words
  until "$BUILD/qloggen" -out "$out" -name "$id" $args; do
    if [ "$attempt" -ge 3 ]; then
      echo "error: scenario $id failed $attempt times" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    echo "    retrying $id (attempt $attempt)"
  done
  files=("$out/${id}_client.sqlog" "$out/${id}_server.sqlog")
  if [ "$qlog" = 1 ]; then
    node "$ROOT/scripts/sqlog-to-qlog.mjs" -o "$out/$id.qlog" --title "$title" --description "$description" \
      "$out/${id}_client.sqlog" "$out/${id}_server.sqlog"
    files=("$out/$id.qlog" "${files[@]}")
  fi
  generated+=("${files[@]}")
  if [ "$fixture" = 1 ]; then fixture_files+=("${files[@]}"); fi
done < <(scenario_lines)

if [ "${#generated[@]}" -eq 0 ]; then
  echo "error: no scenario matched:$only" >&2
  exit 2
fi

# ---------------------------------------------------------------- 4. validate
if [ "$validate" = 1 ]; then
  echo "==> validating ${#generated[@]} files against the qlog CDDL"
  node "$ROOT/scripts/validate-qlog.mjs" -q "${generated[@]}"
fi

# ---------------------------------------------------------------- 5. manifests and fixtures
echo "==> writing the manifests"
node "$HERE/make-index.mjs" "$EXAMPLES"

if [ "$fixtures" = 1 ] && [ "${#fixture_files[@]}" -gt 0 ]; then
  echo "==> copying ${#fixture_files[@]} files to $FIXTURES"
  mkdir -p "$FIXTURES"
  cp "${fixture_files[@]}" "$FIXTURES/"
fi

echo "==> done"
ls -l "${generated[@]}"
