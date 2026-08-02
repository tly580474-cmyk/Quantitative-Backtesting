#!/usr/bin/env python3
"""M5 arbitrary-Python protocol endpoint. Must only run inside the Linux sandbox."""

from __future__ import annotations

import hashlib
import json
import os
import resource
import sys
import tempfile
import traceback


def emit(payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    os.write(1, data + b"\n")


def main() -> None:
    request_bytes = sys.stdin.buffer.read(int(os.environ.get("SANDBOX_MAX_INPUT_BYTES", "1048576")) + 1)
    if len(request_bytes) > int(os.environ.get("SANDBOX_MAX_INPUT_BYTES", "1048576")):
        raise ValueError("SANDBOX_INPUT_LIMIT_EXCEEDED")
    request = json.loads(request_bytes)
    if request.get("protocolVersion") != "1.0":
        raise ValueError("SANDBOX_PROTOCOL_UNSUPPORTED")
    code = request.get("code")
    approval_id = request.get("humanApprovalId")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("SANDBOX_CODE_REQUIRED")
    if not isinstance(approval_id, str) or not approval_id.strip():
        raise ValueError("SANDBOX_HUMAN_APPROVAL_REQUIRED")

    max_output = int(os.environ.get("SANDBOX_MAX_OUTPUT_BYTES", "1048576"))
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_output, max_output))
    original_stdout = os.dup(1)
    original_stderr = os.dup(2)
    captured_path = tempfile.mktemp(prefix="job-output-", dir="/tmp")
    captured_fd = os.open(captured_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    namespace = {"input_data": request.get("input"), "result": None}
    status = "completed"
    error = None
    try:
        os.dup2(captured_fd, 1)
        os.dup2(captured_fd, 2)
        exec(compile(code, "<sandbox-job>", "exec"), namespace, namespace)
    except BaseException as exc:  # The worker must convert user failures into an audited envelope.
        status = "failed"
        error = {"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc(limit=8)}
    finally:
        os.dup2(original_stdout, 1)
        os.dup2(original_stderr, 2)
        os.close(original_stdout)
        os.close(original_stderr)
        size = os.lseek(captured_fd, 0, os.SEEK_END)
        os.lseek(captured_fd, 0, os.SEEK_SET)
        captured = os.read(captured_fd, min(size, max_output)).decode("utf-8", errors="replace")
        os.close(captured_fd)

    result = namespace.get("result")
    try:
        result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        status = "failed"
        error = {"type": "ResultSerializationError", "message": "result must be JSON serializable"}
        result_json = "null"
        result = None
    if len(result_json.encode("utf-8")) > max_output:
        status = "failed"
        error = {"type": "OutputLimitError", "message": "SANDBOX_RESULT_LIMIT_EXCEEDED"}
        result = None
        result_json = "null"

    emit({
        "protocolVersion": "1.0",
        "status": status,
        "authority": "exploration_only",
        "publishable": False,
        "humanApprovalId": approval_id,
        "codeHash": hashlib.sha256(code.encode("utf-8")).hexdigest(),
        "resultHash": hashlib.sha256(result_json.encode("utf-8")).hexdigest(),
        "result": result,
        "capturedOutput": captured,
        "error": error,
    })


try:
    main()
except BaseException as exc:
    emit({
        "protocolVersion": "1.0",
        "status": "rejected",
        "authority": "exploration_only",
        "publishable": False,
        "error": {"type": type(exc).__name__, "message": str(exc)},
    })
    raise SystemExit(2)
