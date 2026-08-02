#!/usr/bin/env bash
set -euo pipefail

if [[ "${EXPERIMENT_ARBITRARY_PYTHON_ENABLED:-false}" != "true" ]]; then
  echo 'ARBITRARY_PYTHON_DISABLED' >&2
  exit 78
fi
: "${M5_SANDBOX_IMAGE_DIGEST:?M5_SANDBOX_IMAGE_DIGEST must be an immutable name@sha256 reference}"
[[ "$M5_SANDBOX_IMAGE_DIGEST" == *@sha256:* ]] || { echo 'mutable image references are forbidden' >&2; exit 64; }
: "${M5_SANDBOX_IMAGE_PUBLIC_KEY:?M5_SANDBOX_IMAGE_PUBLIC_KEY is required}"
: "${M5_SANDBOX_SECCOMP_PROFILE:?seccomp profile required}"
runtime="${M5_CONTAINER_RUNTIME:-docker}"
command -v "$runtime" >/dev/null || { echo "container runtime not found: $runtime" >&2; exit 69; }
command -v cosign >/dev/null || { echo 'cosign is required' >&2; exit 69; }
cosign_args=(verify --key "$M5_SANDBOX_IMAGE_PUBLIC_KEY")
runtime_registry_args=()
if [[ "${M5_SANDBOX_ALLOW_HTTP_REGISTRY:-false}" == "true" ]]; then
  cosign_args+=(--allow-http-registry --insecure-ignore-tlog)
  if [[ "$runtime" == "podman" ]]; then runtime_registry_args+=(--tls-verify=false); fi
fi
cosign "${cosign_args[@]}" "$M5_SANDBOX_IMAGE_DIGEST" >/dev/null

exec "$runtime" run "${runtime_registry_args[@]}" --rm -i --network=none --read-only --user=65532:65532 \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt="seccomp=${M5_SANDBOX_SECCOMP_PROFILE}" \
  --pids-limit=16 --memory="${EXPERIMENT_SANDBOX_MAX_MEMORY_MB:-256}m" \
  --cpus=1 --stop-timeout=1 --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m \
  --env SANDBOX_MAX_OUTPUT_BYTES="${EXPERIMENT_SANDBOX_MAX_OUTPUT_BYTES:-1048576}" \
  "$M5_SANDBOX_IMAGE_DIGEST"
