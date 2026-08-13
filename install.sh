#!/usr/bin/env bash

set -eu

repository="joisun/tasks-recorder"
asset_name="tasks-recorder-macos.tar.gz"
requested_version="latest"
start_service=1
uninstall=0

usage() {
  cat <<'EOF'
Usage: install.sh [--version <vX.Y.Z>] [--no-start] [--uninstall]

  --version <tag>  Install a specific GitHub Release tag (default: latest)
  --no-start       Install files only; do not install or start the LaunchAgent
  --uninstall      Remove the service and program files; preserve user data
EOF
}

die() {
  printf 'tasks-recorder installer: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die '--version requires a tag'
      requested_version="$2"
      shift 2
      ;;
    --no-start)
      start_service=0
      shift
      ;;
    --uninstall)
      uninstall=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

platform="${TASKS_RECORDER_TEST_PLATFORM:-$(uname -s)}"
[ "$platform" = 'Darwin' ] || die 'this release currently supports macOS only'
[ -n "${HOME:-}" ] || die 'HOME is not set'
case "$HOME" in
  /*) ;;
  *) die 'HOME must be an absolute path' ;;
esac

for command_name in node curl tar shasum; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || die 'Node.js 24 or newer is required'

install_root="$HOME/.local/share/tasks-recorder"
releases_root="$install_root/releases"
current_link="$install_root/current"
bin_directory="$HOME/.local/bin"
wrapper_path="$bin_directory/tasks-recorder"
data_directory="$HOME/.config/tasks-recorder"
config_path="$data_directory/config.json"

if [ "$uninstall" -eq 1 ]; then
  if [ -x "$wrapper_path" ] && [ -L "$current_link" ]; then
    "$wrapper_path" uninstall >/dev/null 2>&1 || true
  fi
  if [ -e "$wrapper_path" ] || [ -L "$wrapper_path" ]; then
    rm -f "$wrapper_path"
  fi
  if [ -d "$install_root" ]; then
    [ "$install_root" = "$HOME/.local/share/tasks-recorder" ] || die 'refusing to remove an unexpected install directory'
    rm -rf "$install_root"
  fi
  printf 'Uninstalled Tasks Recorder program files. Preserved %s and logs.\n' "$data_directory"
  exit 0
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/tasks-recorder-install.XXXXXX")"
cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

if [ -n "${TASKS_RECORDER_RELEASE_BASE_URL:-}" ]; then
  release_base_url="${TASKS_RECORDER_RELEASE_BASE_URL%/}"
elif [ "$requested_version" = 'latest' ]; then
  release_base_url="https://github.com/$repository/releases/latest/download"
else
  release_base_url="https://github.com/$repository/releases/download/$requested_version"
fi

archive_path="$temporary_directory/$asset_name"
checksums_path="$temporary_directory/SHA256SUMS"
curl -fsSL "$release_base_url/$asset_name" -o "$archive_path"
curl -fsSL "$release_base_url/SHA256SUMS" -o "$checksums_path"

expected_checksum="$(awk -v name="$asset_name" '$2 == name || $2 == "*" name { print $1; exit }' "$checksums_path")"
[ -n "$expected_checksum" ] || die "checksum entry missing for $asset_name"
actual_checksum="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
[ "$expected_checksum" = "$actual_checksum" ] || die "checksum verification failed for $asset_name"

archive_entries="$temporary_directory/archive-entries.txt"
tar -tzf "$archive_path" > "$archive_entries" || die 'release archive is invalid'
[ -s "$archive_entries" ] || die 'release archive is empty'

while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..)
      die "release archive contains an unsafe path: $entry"
      ;;
  esac
done < "$archive_entries"

archive_root="$(sed -n '1{s#/.*##;p;}' "$archive_entries")"
case "$archive_root" in
  tasks-recorder-*) ;;
  *) die "unexpected release archive root: $archive_root" ;;
esac
if awk -F/ -v root="$archive_root" '$1 != root { exit 1 }' "$archive_entries"; then
  :
else
  die 'release archive contains more than one root directory'
fi

extract_root="$temporary_directory/extracted"
mkdir -p "$extract_root"
tar -xzf "$archive_path" -C "$extract_root"
runtime_source="$extract_root/$archive_root"
[ -f "$runtime_source/ui/dist/index.html" ] || die 'prebuilt Dashboard is missing from the release'
[ -f "$runtime_source/server/taskd.mjs" ] || die 'taskd runtime is missing from the release'

installed_version="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.version)' "$runtime_source/package.json")"
case "$installed_version" in
  ''|*[!0-9A-Za-z.+-]*) die 'release contains an invalid version' ;;
esac
if [ "$requested_version" != 'latest' ]; then
  normalized_requested_version="${requested_version#v}"
  [ "$normalized_requested_version" = "$installed_version" ] || die "release version $installed_version does not match requested tag $requested_version"
fi

mkdir -p "$releases_root" "$bin_directory" "$data_directory"
chmod 700 "$data_directory"
release_directory="$releases_root/$installed_version"
if [ ! -d "$release_directory" ]; then
  mv "$runtime_source" "$release_directory"
fi

if [ ! -f "$config_path" ]; then
  cat > "$config_path" <<'EOF'
{
  "output_dir": ".",
  "server_host": "127.0.0.1",
  "server_port": 43127
}
EOF
  chmod 600 "$config_path"
fi

temporary_link="$install_root/.current.$$.tmp"
ln -s "$release_directory" "$temporary_link"
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$temporary_link" "$current_link"

cat > "$wrapper_path" <<'EOF'
#!/usr/bin/env sh
set -eu
runtime="$HOME/.local/share/tasks-recorder/current"
[ -d "$runtime" ] || {
  printf 'Tasks Recorder is not installed.\n' >&2
  exit 1
}
TASKS_RECORDER_PREBUILT=1 exec node "$runtime/server/control.mjs" "${1:-status}"
EOF
chmod 755 "$wrapper_path"

dashboard_url="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if ((p.server_host ?? "127.0.0.1") !== "127.0.0.1") process.exit(2); process.stdout.write(`http://127.0.0.1:${p.server_port ?? 43127}`)' "$config_path")" || die 'config server_host must be 127.0.0.1'

if [ "$start_service" -eq 1 ]; then
  "$wrapper_path" install >/dev/null
  ready=0
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if curl -fsS --connect-timeout 1 --max-time 1 "$dashboard_url/health/ready" >/dev/null 2>&1; then
      ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.2
  done
  [ "$ready" -eq 1 ] || die "service did not become ready; check $HOME/Library/Logs/tasks-recorder/taskd.stderr.log"
fi

printf 'Installed Tasks Recorder %s.\n' "$installed_version"
printf 'Dashboard: %s\n' "$dashboard_url"
if [ ":${PATH}:" != *":$bin_directory:"* ]; then
  printf 'Add %s to PATH to use the tasks-recorder command.\n' "$bin_directory"
fi
printf 'Install a Codex or Claude Code adapter separately; see the project README.\n'
