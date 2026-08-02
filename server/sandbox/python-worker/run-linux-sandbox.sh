#!/usr/bin/env bash
set -euo pipefail

if [[ "${EXPERIMENT_ARBITRARY_PYTHON_ENABLED:-false}" != "true" ]]; then
  echo '{"status":"rejected","error":{"type":"Disabled","message":"ARBITRARY_PYTHON_DISABLED"}}' >&2
  exit 78
fi

runner="${M5_SANDBOX_RUNNER:-$(cd "$(dirname "$0")" && pwd)/runner.py}"
max_seconds="${EXPERIMENT_SANDBOX_MAX_SECONDS:-15}"
max_memory_mb="${EXPERIMENT_SANDBOX_MAX_MEMORY_MB:-256}"
max_output_bytes="${EXPERIMENT_SANDBOX_MAX_OUTPUT_BYTES:-1048576}"
unit="m5-python-${RANDOM}-$(date +%s%N)"

command -v systemd-run >/dev/null || { echo 'systemd-run is required' >&2; exit 69; }
command -v bwrap >/dev/null || { echo 'bubblewrap is required' >&2; exit 69; }

# Bubblewrap needs the host /proc/sys values while constructing its new
# namespace. The payload itself still receives an isolated --proc mount.
exec systemd-run --quiet --wait --pipe --collect --service-type=exec --unit="$unit" \
  --property=DynamicUser=yes \
  --property=PrivateNetwork=yes \
  --property=PrivateTmp=yes \
  --property=PrivateDevices=yes \
  --property=ProtectSystem=strict \
  --property=ProtectHome=yes \
  --property=NoNewPrivileges=yes \
  --property=LockPersonality=yes \
  --property=RestrictSUIDSGID=yes \
  --property=RestrictRealtime=yes \
  --property=CapabilityBoundingSet= \
  --property=DevicePolicy=closed \
  --property="MemoryMax=${max_memory_mb}M" \
  --property=TasksMax=16 \
  --property=CPUQuota=100% \
  --property="RuntimeMaxSec=${max_seconds}" \
  /usr/bin/bwrap \
    --unshare-all --unshare-user --disable-userns --die-with-parent --new-session --clearenv \
    --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --proc /proc --dev /dev --tmpfs /tmp --dir /work --chdir /work \
    --ro-bind "$runner" /runner.py \
    --setenv PATH /usr/bin \
    --setenv PYTHONHASHSEED 0 \
    --setenv SANDBOX_MAX_INPUT_BYTES 1048576 \
    --setenv SANDBOX_MAX_OUTPUT_BYTES "$max_output_bytes" \
    /usr/bin/python3 -I -S /runner.py
