# 月度选股与设备登录修复

已部署到 `192.168.2.218` 的 `/opt/quant-backtest`，前台 8080、管理页面 8081。

中证1000低PB按月保存最近三期结果，缓存文件为研究快照根目录下的 `selection-results/csi1000-low-pb-200.json`。同月访问直接读取结果文件，不读取当前快照或启动 DuckDB；服务重启后仍可复用。进入新月份时检查数据月份，等新月份快照可用后更新三期结果。手动“重新计算”仍可覆盖结果。原子替换防止写入半成品，并合并并发计算请求。价格与收益固定截至结果数据日期，页面明确展示该日期。

低PB页面不再顺带请求13因子选股。当前保存 2026-08-31、2026-07-31、2026-06-30 三期，每期200只，数据截至2026-09-21。部署首次生成耗时10.71秒；后续两次接口读取分别为10.5毫秒和8.8毫秒，生成时间相同，磁盘内容一致。

网站认证由浏览器 Basic 弹窗切换为登录表单。`quant-gateway.service` 使用现有 htpasswd 验证账号，随机设备令牌通过 HttpOnly、SameSite=Lax Cookie 传递；数据库只保存令牌哈希。每次成功访问更新服务端最后访问时间与 Cookie 的72小时有效期。连续72小时无访问、主动退出或密码文件发生变化后，旧会话失效。设备按浏览器 Cookie 区分，不按IP放行；管理API继续单独验证 Bearer Token。HTTPS入口会设置 Secure。服务只监听回环3002。

验证：前端构建、前后端类型检查通过；前端4项、后端5项、Python登录5项测试通过。Python测试包含独立临时账号的真实 htpasswd 校验及 HTTP 登录/续期/注销，覆盖过期边界、跨源请求拒绝、独立设备、令牌篡改、密码变化及存储重启恢复。线上匿名页面显示登录表单，匿名API返回401，无 Basic 弹窗。用户确认现有账号正常登录；线上已存在有效设备会话。

自动审批拒绝了从服务器凭据文件重试认证的排查操作，随后采用隔离测试凭据与用户手动登录确认完成验收，没有重置现有账号密码。

部署前备份位于 `/var/backups/quant-monthly-device-20260921-214349/`，包含 `app-before.tgz` 和 `nginx-before.tgz`。恢复时先恢复源文件与前端产物，再恢复 Nginx 配置，通过 `nginx -t` 及独立公网配置检查后重启后端、重载两个网关；确认恢复 Basic 后再停止新会话服务。

登录测试命令：`python3 deploy/linux/gateway-session_test.py`。网关通过 [Nginx auth_request](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html) 校验会话，密码通过 [htpasswd 的 stdin 验证模式](https://httpd.apache.org/docs/2.4/programs/htpasswd.html) 校验，不把密码放到命令行参数。
