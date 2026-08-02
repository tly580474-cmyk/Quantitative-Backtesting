# M5 任意 Python 隔离 Worker

此目录不是普通 Python 子进程包装器。生产路径必须选择以下强隔离边界之一：

- Linux `systemd-run + bubblewrap`：动态用户、独立 PID/网络/挂载命名空间、只读系统、空宿主目录、资源上限；
- OCI 容器：镜像必须使用 `name@sha256:digest`，禁网、只读根文件系统、非 root、全部 capability 删除、seccomp、CPU/内存/PID/输出限制。

默认配置 `EXPERIMENT_ARBITRARY_PYTHON_ENABLED=false`。即使显式开启，结果也固定标记为
`authority=exploration_only` 和 `publishable=false`，必须通过 TypeScript 权威引擎复算及人工审批后才能进入治理流程。

系统不向容器传入数据库、模型或云服务密钥，也不挂载项目目录、研究快照或制品目录。任务输入仅通过 stdin 传递，输出仅允许一个受限 JSON envelope。

## 构建与供应链门禁

- `Dockerfile` 的基础镜像固定为 `name@sha256`；构建脚本拒绝可变 tag；
- `build-sign-verify.sh` 先构建和推送，再用 Trivy 阻断存在已修复 High/Critical 的镜像；
- 扫描通过后才允许 Cosign 签名，并立即用指定公钥验证；
- `docker-run.sh` 在每次运行前重新验证 digest 对应签名，缺少公钥、seccomp 或 digest
  均拒绝启动；
- 生产签名密钥应放在 KMS/HSM，生产 registry 必须使用 TLS。HTTP registry 和
  `insecure-ignore-tlog` 仅供本机演练，禁止进入生产配置。

VectorBT 快筛依赖位于 `tools/vector-screen/requirements.lock`；任意 Python 协议运行器
只使用标准库，其空依赖约束记录在本目录 `requirements.lock`。
