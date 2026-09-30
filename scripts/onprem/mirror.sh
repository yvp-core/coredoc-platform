#!/usr/bin/env bash
#
# Coredoc air-gap kit — mirror the bundled images into your own registry.
#
#   ./mirror.sh [--dry-run] <target-registry-prefix>
#   ./mirror.sh harbor.corp.example/coredoc
#
# Ships at the root of coredoc-onprem-<version>.tar.gz, next to images/,
# chart/, docs/, sboms/ and SHA-256SUMS. It resolves the kit from its own
# location, so run it from wherever you unpacked the kit.
#
# What it does, in order:
#   1. verifies the kit against SHA-256SUMS (refuses to touch anything on a
#      mismatch — a tampered or truncated tarball is not a mirror source);
#   2. pushes every images/*.tar to <prefix>/<image-name>:<image-tag>, keeping
#      the name and tag the image already carries;
#   3. prints the Helm values fragment that points the chart at your registry.
#
# `crane` is preferred (no docker daemon needed on a bastion host); docker is
# the fallback. Neither on PATH is a hard error.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./mirror.sh [--dry-run] <target-registry-prefix>

  <target-registry-prefix>  Registry host plus optional project path, e.g.
                            harbor.corp.example/coredoc  (no scheme, no tag)

  --dry-run                 Verify the kit and print every command that would
                            run, without loading or pushing anything.
  -h, --help                This message.
EOF
}

DRY_RUN=false
TARGET_PREFIX=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$TARGET_PREFIX" ]; then
        echo "error: unexpected extra argument '$1'" >&2
        exit 2
      fi
      TARGET_PREFIX="$1"
      ;;
  esac
  shift
done

if [ -z "$TARGET_PREFIX" ]; then
  echo "error: target registry prefix is required" >&2
  usage >&2
  exit 2
fi

case "$TARGET_PREFIX" in
  *://*)
    echo "error: drop the scheme — pass 'harbor.corp.example/coredoc', not '$TARGET_PREFIX'" >&2
    exit 2
    ;;
esac
TARGET_PREFIX="${TARGET_PREFIX%/}"

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$KIT_DIR"

if [ ! -f SHA-256SUMS ]; then
  echo "error: SHA-256SUMS not found in ${KIT_DIR} — run this script from inside the unpacked kit" >&2
  exit 1
fi

# --- 1. integrity -----------------------------------------------------------
# Both checks below see through symlinks: `sha256sum -c` hashes the link's
# target, and the `find -type f` inventory skips the link itself — so a
# symlinked images/evil.tar would be invisible to both and still get loaded and
# pushed by the mirror loop. A kit is a plain tree of regular files; anything
# else (symlink, fifo, device) means the tree was rewritten after packing.
echo "==> Checking ${KIT_DIR} contains only regular files"
IRREGULAR="$(find . ! -type d ! -type f)"
if [ -n "$IRREGULAR" ]; then
  printf '%s\n' "$IRREGULAR" >&2
  echo "error: the paths above are symlinks or special files, not regular files —" >&2
  echo "       refusing to mirror a kit that is not a plain tree of regular files" >&2
  exit 1
fi
echo "    OK (regular files only)"

echo "==> Verifying ${KIT_DIR}/SHA-256SUMS"
if command -v sha256sum > /dev/null 2>&1; then
  CHECK_OUTPUT="$(sha256sum -c SHA-256SUMS 2>&1)" || CHECK_FAILED=true
elif command -v shasum > /dev/null 2>&1; then
  CHECK_OUTPUT="$(shasum -a 256 -c SHA-256SUMS 2>&1)" || CHECK_FAILED=true
else
  echo "error: neither sha256sum nor shasum is on PATH — cannot verify the kit" >&2
  exit 1
fi
if [ "${CHECK_FAILED:-false}" = true ]; then
  echo "$CHECK_OUTPUT" >&2
  echo "error: checksum verification FAILED — refusing to mirror a kit that does not match SHA-256SUMS" >&2
  exit 1
fi
echo "    OK ($(printf '%s\n' "$CHECK_OUTPUT" | grep -c ': OK$') files)"

# `sha256sum -c` only proves that the files SHA-256SUMS lists are intact — it is
# silent about a file somebody added to the kit afterwards, which is exactly how
# an extra images/*.tar (mirrored into the customer's registry by the loop below)
# would arrive. Refuse on anything the manifest does not cover.
echo "==> Checking every kit file is listed in SHA-256SUMS"
# Manifest lines are "<64 hex><2 spaces><path>", so the path starts at column 67
# (cut, not awk field splitting, so a path with spaces survives intact).
LISTED_FILES="$(cut -c 67- SHA-256SUMS | LC_ALL=C sort)"
PRESENT_FILES="$(find . -type f ! -name SHA-256SUMS | LC_ALL=C sort)"
UNLISTED="$(comm -23 <(printf '%s\n' "$PRESENT_FILES") <(printf '%s\n' "$LISTED_FILES"))"
if [ -n "$UNLISTED" ]; then
  printf '%s\n' "$UNLISTED" >&2
  echo "error: the files above are in the kit but are NOT listed in SHA-256SUMS —" >&2
  echo "       refusing to mirror a kit that carries unverified files" >&2
  exit 1
fi
echo "    OK (no unlisted files)"

# --- 2. tooling -------------------------------------------------------------
if command -v crane > /dev/null 2>&1; then
  PUSHER=crane
elif command -v docker > /dev/null 2>&1; then
  PUSHER=docker
else
  echo "error: neither 'crane' nor 'docker' is on PATH." >&2
  echo "       Install one of them on this host (crane needs no daemon:" >&2
  echo "       https://github.com/google/go-containerregistry), or copy the kit" >&2
  echo "       to a host that has it, then re-run." >&2
  exit 1
fi
echo "==> Using ${PUSHER} to push into ${TARGET_PREFIX}"
[ "$DRY_RUN" = true ] && echo "    (dry run — nothing will be loaded or pushed)"

run() {
  if [ "$DRY_RUN" = true ]; then
    printf '    +'
    printf ' %s' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# --- 3. push ----------------------------------------------------------------
SERVER_REPO=""
SERVER_TAG=""
NEO4J_TAG=""
PUSHED=0

for TARBALL in images/*.tar; do
  [ -e "$TARBALL" ] || {
    echo "error: no image tarballs found in ${KIT_DIR}/images" >&2
    exit 1
  }

  # The image's own reference, read from the docker-save manifest, is the
  # source of truth for name+tag — never the file name.
  # (tr puts the RepoTags array on its own line so the sed capture cannot run
  #  past it into another field.)
  SOURCE_REF="$(tar -xOf "$TARBALL" manifest.json 2> /dev/null |
    tr ',' '\n' | sed -n 's/.*"RepoTags":\["\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$SOURCE_REF" ]; then
    echo "error: could not read a RepoTags entry from ${TARBALL} — is it a 'docker save' archive?" >&2
    exit 1
  fi

  # An untagged RepoTags entry (`repo` with no `:tag`) would make ${REF##*:}
  # return the repo name and mirror the image as <prefix>/<name>:<name>.
  # A registry host may carry a port, so require the colon AFTER the last slash.
  case "${SOURCE_REF##*/}" in
    *:*) ;;
    *)
      echo "error: ${TARBALL} carries an untagged image reference '${SOURCE_REF}' — re-save it with an explicit tag" >&2
      exit 1
      ;;
  esac

  IMAGE_TAG="${SOURCE_REF##*:}"
  IMAGE_NAME="${SOURCE_REF%:*}"
  IMAGE_NAME="${IMAGE_NAME##*/}"
  TARGET_REF="${TARGET_PREFIX}/${IMAGE_NAME}:${IMAGE_TAG}"

  echo "==> ${SOURCE_REF}  ->  ${TARGET_REF}"
  if [ "$PUSHER" = crane ]; then
    run crane push "$TARBALL" "$TARGET_REF"
  else
    run docker load -i "$TARBALL"
    run docker tag "$SOURCE_REF" "$TARGET_REF"
    run docker push "$TARGET_REF"
  fi

  case "$IMAGE_NAME" in
    coredoc-server)
      SERVER_REPO="${TARGET_PREFIX}/${IMAGE_NAME}"
      SERVER_TAG="$IMAGE_TAG"
      ;;
    neo4j) NEO4J_TAG="$IMAGE_TAG" ;;
  esac
  PUSHED=$((PUSHED + 1))
done

# --- 4. the values fragment -------------------------------------------------
# Key shapes verified against the vendored upstream neo4j subchart
# (charts/coredoc/Chart.lock -> neo4j 2026.5.0, templates/_image.tpl): it
# composes <image.registry>/<image.repository>:<image.tag>, and rejects mixing
# those separated fields with image.customImage.
NEO4J_REGISTRY="${TARGET_PREFIX%%/*}"
NEO4J_REPOSITORY="neo4j"
if [ "$NEO4J_REGISTRY" != "$TARGET_PREFIX" ]; then
  NEO4J_REPOSITORY="${TARGET_PREFIX#*/}/neo4j"
fi

echo
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete — ${PUSHED} image(s) would be mirrored. Helm values fragment:"
else
  echo "Mirrored ${PUSHED} image(s). Add this to your Helm values:"
fi
echo
if [ -n "$SERVER_REPO" ]; then
  cat <<EOF
image:
  repository: ${SERVER_REPO}
  tag: "${SERVER_TAG}"
EOF
fi
if [ -n "$NEO4J_TAG" ]; then
  cat <<EOF
neo4j:
  image:
    registry: ${NEO4J_REGISTRY}
    repository: ${NEO4J_REPOSITORY}
    tag: "${NEO4J_TAG}"
EOF
fi
cat <<'EOF'
# Add image.pullSecrets: [<secret>] if your registry needs credentials.
EOF
echo
echo "Then install from the bundled chart:"
echo "  helm install coredoc chart/coredoc-*.tgz -f my-values.yaml -n coredoc"
