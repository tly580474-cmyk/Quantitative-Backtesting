# 阶段 C：研究代码沙箱镜像（与 M5 纯标准库沙箱不同，允许三方库用于数据研究）。
# 安全边界：只读数据挂载 + 只读 MySQL 账号 + 无宿主写路径 + 资源上限；
# 结果恒标记 authority=exploration_only / publishable=false（ADR-05）。
# 基础镜像复用本地 quant-sandbox:dev（其基础 Python 已钉 digest），
# 再叠加研究依赖；生产构建同样应过 digest 钉死与签名门禁。
ARG PYTHON_BASE_IMAGE=quant-sandbox:dev
FROM ${PYTHON_BASE_IMAGE}

USER root
RUN python3 -m pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple duckdb pandas pymysql
USER 65532:65532
WORKDIR /work
# 注意：不用 -S（需加载 site-packages 中的 duckdb/pandas）；保留 -I 隔离用户环境。
ENV PYTHONHASHSEED=0 \
    SANDBOX_MAX_INPUT_BYTES=1048576 \
    SANDBOX_MAX_OUTPUT_BYTES=4194304
ENTRYPOINT ["python3", "-I", "/opt/quant-sandbox/runner.py"]
