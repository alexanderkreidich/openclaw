#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage:
  gateway-driver.sh start <openclaw_home> <config_path> <state_dir> <port> <token> <log_path> <pid_path>
  gateway-driver.sh stop <pid_path>
EOF
}

start_gateway() {
  local openclaw_home="$1"
  local config_path="$2"
  local state_dir="$3"
  local port="$4"
  local token="$5"
  local log_path="$6"
  local pid_path="$7"

  mkdir -p "$(dirname "$config_path")" "$(dirname "$state_dir")" "$(dirname "$log_path")"

  env \
    OPENCLAW_HOME="$openclaw_home" \
    OPENCLAW_CONFIG_PATH="$config_path" \
    OPENCLAW_STATE_DIR="$state_dir" \
    OPENCLAW_GATEWAY_TOKEN="$token" \
    OPENCLAW_SKIP_CHANNELS=1 \
    OPENCLAW_SKIP_PROVIDERS=1 \
    OPENCLAW_SKIP_GMAIL_WATCHER=1 \
    OPENCLAW_SKIP_CRON=1 \
    OPENCLAW_SKIP_CANVAS_HOST=1 \
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1 \
    OPENCLAW_TEST_MINIMAL_GATEWAY=1 \
    node openclaw.mjs gateway run --bind loopback --port "$port" --force \
      >"$log_path" 2>&1 &

  local pid=$!
  printf '%s\n' "$pid" >"$pid_path"
}

stop_gateway() {
  local pid_path="$1"
  if [[ ! -f "$pid_path" ]]; then
    return 0
  fi

  local pid
  pid="$(tr -d '[:space:]' <"$pid_path")"
  if [[ -z "$pid" ]]; then
    rm -f "$pid_path"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$pid_path"
}

main() {
  if [[ $# -lt 1 ]]; then
    usage >&2
    exit 1
  fi

  local command="$1"
  shift

  case "$command" in
    start)
      if [[ $# -ne 7 ]]; then
        usage >&2
        exit 1
      fi
      start_gateway "$@"
      ;;
    stop)
      if [[ $# -ne 1 ]]; then
        usage >&2
        exit 1
      fi
      stop_gateway "$1"
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
