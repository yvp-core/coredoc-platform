#!/usr/bin/env bash
#
# Checks the built server and agent runner images against the promises the
# runner design makes about them:
#
#   server  never contains the Agent SDK or Claude Code, and stays within its
#           size budget (an SDK pulled into its dependency closure would add
#           a ~230 MB native binary);
#   runner  linux/amd64, a non-root numeric user, tini as PID 1, root-owned
#           content nobody else can write, the pinned SDK with its glibc
#           Claude Code binary, the plugin at a path without spaces, git, and
#           within its size budget.
#
# On an x86_64 host it also runs the bundled binaries, and the runner's own
# start-up check against the real SDK and plugin with a read-only root
# filesystem and /scratch as the only writable path. Elsewhere (an emulated
# amd64 container on Apple silicon) those binaries abort under QEMU, so that
# part is skipped with a notice.
#
#   scripts/images/check-images.sh <server-image> <runner-image>
#
# Size budgets are uncompressed image sizes in MB; raise one deliberately, in
# the same change that explains the growth.
set -euo pipefail

SERVER_MAX_MB="${SERVER_MAX_MB:-1100}"
RUNNER_MAX_MB="${RUNNER_MAX_MB:-1000}"
SDK_VERSION="0.3.285"
RUNNER_ROOT=/opt/coredoc-agent-runner
PLUGIN_ROOT=/opt/coredoc-workflows

if [ $# -ne 2 ]; then
  echo "usage: $0 <server-image> <runner-image>" >&2
  exit 2
fi
SERVER_IMAGE="$1"
RUNNER_IMAGE="$2"
FAILED=0

fail() {
  echo "FAIL: $*" >&2
  FAILED=1
}
ok() { echo "ok:   $*"; }

size_mb() {
  local bytes
  bytes="$(docker image inspect --format '{{.Size}}' "$1")"
  echo $(((bytes + 1048575) / 1048576))
}

check_size() {
  local label="$1" image="$2" max="$3" mb
  mb="$(size_mb "$image")"
  if [ "$mb" -le "$max" ]; then ok "$label image is ${mb} MB (budget ${max} MB)"; else fail "$label image is ${mb} MB, over its ${max} MB budget"; fi
}

# Runs a shell script inside an image as root, without its entrypoint.
in_image() {
  local image="$1"
  shift
  docker run --rm --platform "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" \
    --user 0 --entrypoint /bin/sh "$image" -c "$*"
}

# --- server ------------------------------------------------------------------
echo "==> server: $SERVER_IMAGE"
SDK_IN_SERVER="$(in_image "$SERVER_IMAGE" \
  "find / -xdev \\( -name 'claude-agent-sdk*' -o -path '*/@anthropic-ai/claude-code' \\) -print 2>/dev/null | head -n 5")"
if [ -z "$SDK_IN_SERVER" ]; then
  ok "server image contains no Agent SDK or Claude Code"
else
  fail "server image contains the Agent SDK or Claude Code:"
  echo "$SDK_IN_SERVER" >&2
fi
check_size server "$SERVER_IMAGE" "$SERVER_MAX_MB"

# --- runner ------------------------------------------------------------------
echo "==> runner: $RUNNER_IMAGE"
PLATFORM="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$RUNNER_IMAGE")"
if [ "$PLATFORM" = "linux/amd64" ]; then ok "runner platform is $PLATFORM"; else fail "runner platform is $PLATFORM, not linux/amd64"; fi

USER_SPEC="$(docker image inspect --format '{{.Config.User}}' "$RUNNER_IMAGE")"
case "$USER_SPEC" in
  0 | 0:* | root | root:* | "") fail "runner image runs as '${USER_SPEC:-root}'" ;;
  [0-9]*) ok "runner runs as numeric user $USER_SPEC" ;;
  *) fail "runner user '$USER_SPEC' is not numeric (runAsNonRoot cannot verify a name)" ;;
esac

ENTRYPOINT="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$RUNNER_IMAGE")"
if [ "$ENTRYPOINT" = '["/usr/bin/tini","--"]' ]; then ok "tini is PID 1"; else fail "entrypoint is $ENTRYPOINT, not tini"; fi

CONTENT="$(in_image "$RUNNER_IMAGE" "
  set -e
  cd $RUNNER_ROOT/apps/agent-runner
  sdk=\$(realpath node_modules/@anthropic-ai/claude-agent-sdk)
  echo sdk=\$(node -p \"require('\$sdk/package.json').version\")
  test -x \"\$sdk/../claude-agent-sdk-linux-x64/claude\" && echo glibc-binary=yes || echo glibc-binary=no
  ls -d $RUNNER_ROOT/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64-musl@* >/dev/null 2>&1 && echo musl-binary=yes || echo musl-binary=no
  test -f $PLUGIN_ROOT/.claude-plugin/plugin.json && echo plugin=yes || echo plugin=no
  echo writable=\$(find $RUNNER_ROOT $PLUGIN_ROOT \\( -perm -g+w -o -perm -o+w \\) ! -type l | wc -l)
  echo foreign-owner=\$(find $RUNNER_ROOT $PLUGIN_ROOT ! -user root | wc -l)
  command -v git >/dev/null && echo git=yes || echo git=no
")"
expect() {
  if printf '%s\n' "$CONTENT" | grep -qx "$1"; then ok "$2"; else fail "$2 (expected $1; got: $(printf '%s' "$CONTENT" | tr '\n' ' '))"; fi
}
expect "sdk=$SDK_VERSION" "runner pins Agent SDK $SDK_VERSION"
expect "glibc-binary=yes" "the SDK's linux-x64 glibc Claude Code binary is installed"
expect "musl-binary=no" "no musl Claude Code binary is shipped"
expect "plugin=yes" "coredoc-workflows plugin is installed at $PLUGIN_ROOT"
expect "writable=0" "runner and plugin are writable by root only"
expect "foreign-owner=0" "runner and plugin are owned by root"
expect "git=yes" "git is installed"
case "$PLUGIN_ROOT" in *" "*) fail "plugin path contains a space" ;; *) ok "plugin path has no spaces" ;; esac
check_size runner "$RUNNER_IMAGE" "$RUNNER_MAX_MB"

# --- runner binaries and start-up check (native amd64 only) ------------------
if [ "$(uname -m)" = "x86_64" ]; then
  echo "==> runner start-up check (read-only root filesystem)"
  if docker run --rm --read-only --tmpfs /scratch:uid=10001,gid=10001 \
    -w "$RUNNER_ROOT/apps/agent-runner" "$RUNNER_IMAGE" \
    node --input-type=module -e "
      import { query } from '@anthropic-ai/claude-agent-sdk';
      import { checkClaudeStartup } from './dist/claude/startup-check.js';
      const report = await checkClaudeStartup({
        query, pluginPath: '$PLUGIN_ROOT', scratchRoot: '/scratch', versions: { runner: 'image-check' },
      });
      console.log(JSON.stringify(report));
      process.exit(report.problem ? 1 : 0);
    "; then
    ok "start-up check passed: Claude Code started and the plugin loaded with its skills"
  else
    fail "the runner's start-up check failed inside the image"
  fi
else
  echo "notice: not on x86_64; skipped running the bundled binaries and the start-up check"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "Image checks failed." >&2
  exit 1
fi
echo "All image checks passed."
