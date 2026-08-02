#!/usr/bin/env bash
set -euo pipefail

: "${M5_SANDBOX_REPOSITORY:?target image repository is required}"
: "${M5_SANDBOX_SIGNING_KEY:?cosign signing key or KMS URI is required}"
: "${M5_SANDBOX_PUBLIC_KEY:?cosign public key is required}"
base_image="${M5_SANDBOX_BASE_IMAGE:-docker.io/library/python@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b}"
[[ "$base_image" == *@sha256:* ]] || { echo 'base image must be pinned by digest' >&2; exit 64; }
runtime="${M5_CONTAINER_RUNTIME:-docker}"
tag="${M5_SANDBOX_BUILD_TAG:-$(date -u +%Y%m%d%H%M%S)}"
context="$(cd "$(dirname "$0")" && pwd)"
image="${M5_SANDBOX_REPOSITORY}:${tag}"
command -v "$runtime" >/dev/null || { echo "container runtime not found: $runtime" >&2; exit 69; }
for command in skopeo trivy cosign; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 69; }
done

tls_args=()
cosign_sign_registry_args=()
cosign_verify_registry_args=()
if [[ "${M5_SANDBOX_ALLOW_HTTP_REGISTRY:-false}" == "true" ]]; then
  tls_args+=(--tls-verify=false)
  cosign_sign_registry_args+=(--allow-http-registry)
  cosign_verify_registry_args+=(--allow-http-registry --insecure-ignore-tlog)
fi

"$runtime" build --no-cache --build-arg "PYTHON_BASE_IMAGE=${base_image}" -t "$image" "$context"
"$runtime" push "${tls_args[@]}" "$image"
digest="$(skopeo inspect "${tls_args[@]}" --format '{{.Digest}}' "docker://${image}")"
immutable="${M5_SANDBOX_REPOSITORY}@${digest}"
scan_archive="$(mktemp --suffix=.tar)"
trap 'rm -f "$scan_archive"' EXIT
if [[ "$runtime" == "podman" ]]; then
  "$runtime" save --format docker-archive -o "$scan_archive" "$image"
else
  "$runtime" save -o "$scan_archive" "$image"
fi
trivy image --input "$scan_archive" --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1

signing_args=(sign --yes --key "$M5_SANDBOX_SIGNING_KEY")
if [[ -n "${M5_SANDBOX_SIGNING_CONFIG:-}" ]]; then
  signing_args+=(--signing-config "$M5_SANDBOX_SIGNING_CONFIG" --new-bundle-format)
fi
cosign "${signing_args[@]}" "${cosign_sign_registry_args[@]}" "$immutable"
cosign verify --key "$M5_SANDBOX_PUBLIC_KEY" "${cosign_verify_registry_args[@]}" "$immutable" >/dev/null
printf '{"status":"passed","baseImage":"%s","image":"%s"}\n' "$base_image" "$immutable"
