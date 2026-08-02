ARG PYTHON_BASE_IMAGE=docker.io/library/python@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b
FROM ${PYTHON_BASE_IMAGE}

RUN useradd --system --uid 65532 --no-create-home sandbox
COPY --chown=root:root runner.py /opt/quant-sandbox/runner.py
RUN chmod 0555 /opt/quant-sandbox/runner.py
USER 65532:65532
WORKDIR /work
ENV PYTHONHASHSEED=0 SANDBOX_MAX_INPUT_BYTES=1048576 SANDBOX_MAX_OUTPUT_BYTES=1048576
ENTRYPOINT ["python3", "-I", "-S", "/opt/quant-sandbox/runner.py"]
