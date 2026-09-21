# 市场走势图切换与登录安全复核

已部署到测试服务器 `192.168.2.218`，本次只重启登录网关并重载 Nginx，未重启业务后端、未重置账号或删除用户登录会话。

## 图表修复

市场总览原先在组件挂载时把指数预览置为空，并等待所有指数请求完成后才一起显示。分时无数据或失败时，回退到日线的结果没有单独缓存，因此下次进入仍会先尝试分时接口。

现在预览图在首次渲染时直接恢复上次结果。三分钟内复用已选定的分时/日线结果；过期时后台刷新，期间继续显示旧图。多个页面实例共享正在进行的请求；每张图独立更新，单个慢请求不会阻塞其他图。手动刷新可跳过有效缓存，短暂接口故障保留已有图形。

前端构建与类型检查通过，相关20项测试通过：缓存与请求合并4项、页面卸载/重挂载2项、移动端自选4项、市场总览组件及指数卡片10项。页面测试使用真实 MarketDataPage 和 React StrictMode，覆盖日线回退后切换不新增请求、同步恢复图形、慢请求隔离和过期刷新失败保留图形。

浏览器自动化连接因 request-header policy 加载失败而不可用，两次尝试均失败；未完成真实浏览器点击切换复验，不能把组件回归等同于浏览器端实测。线上前端入口文件 SHA256 与本地构建一致：`1cb82028edfd915f6e6826235860d9842fdc8b73f66a5fe669aa57ffdf5b7965`。

## 安全发现与修复

| 发现 | 处理 |
| --- | --- |
| Cookie 认证的业务写请求未检查来源，只依赖 SameSite | 对非 GET/HEAD/OPTIONS 请求验证完整 Origin（含端口），拒绝缺失或跨源请求；Nginx 覆盖原始方法、来源、Fetch Metadata 等转发字段，客户端伪造不能绕过 |
| 登录和退出允许缺少 Origin | 改为要求匹配入口的完整 Origin，并拒绝 cross-site/same-site Fetch Metadata |
| 登录请求格式约束不足 | 限制请求类型、字段数、重复字段、用户名/密码长度，拒绝超大请求；会话令牌严格检查长度与字符集，增加连接读取超时 |
| 归一化后的 API 路径可能收到200登录HTML，而非401 | 按 Nginx 归一化 URI 判定，稳定返回401；此前未发现因此获得业务数据 |
| 登录页面需要更明确的浏览器防护头 | 增加 X-Frame-Options: DENY 与 Referrer-Policy: no-referrer，保留 CSP、no-store、nosniff |
| 用户当前使用 HTTP 8080 入口 | **未解决的传输风险**：该入口不提供 TLS，不能保证密码与会话 Cookie 在网络传输中的保密性；应在公网或不可信网络使用前配置 HTTPS |

来源检查适用于网页登录及使用 Cookie 的写操作。自动化客户端若使用 Cookie 执行写请求，须携带与入口一致的 Origin；管理API继续使用独立 Bearer 验证。本次未更改管理API权限模型。

## 验证证据

原有5项会话测试全部通过，包括72小时滑动失效、存储重启恢复、独立设备、令牌篡改、密码文件变更失效、登录限流、跳转检查和真实 htpasswd 校验。

新增8项集成安全测试使用独立 Nginx、临时随机账号、独立会话库和虚拟API，运行身份为 `www-data`；不读取现有账号密码或用户会话，不向真实业务API发送修改。覆盖：

- 匿名请求、路径归一化、内部鉴权地址与伪造头不能绕过认证。
- 登录后正常访问，Cookie 自动续期，重新登录轮换令牌，退出后旧令牌失效。
- 篡改和过期 Cookie 被拒绝，数据库只保存令牌哈希。
- 登录、退出和业务写请求拒绝缺失/错误/跨端口来源，正常同源写请求成功到达虚拟API。
- 伪造 X-Real-IP/X-Forwarded-For 无法绕过十次/五分钟的登录限流。
- 过大请求、重复参数、多余字段和错误 Content-Type 被拒绝。
- 外部跳转、HTML注入、响应缓存及嵌入页面防护。

线上10项无凭据检查全部通过：两个入口显示登录表单；匿名业务API401；内部鉴权地址404；归一化API401；前台访问管理API403；管理健康接口无Bearer时401；跨源和缺失Origin的登录403；伪造转发字段的跨源写请求403。线上检查没有执行密码猜测，避免影响真实用户限流。

文件权限检查：会话目录0700、数据库0600，归属 `www-data`；密码文件0640、归属 `root:www-data`。业务后端3001和会话服务3002仅监听127.0.0.1。8080/8081对主机网络开放；443虽有回环监听，不能据此认定用户当前HTTP地址已受TLS保护。

这属于针对本次认证变更的代码复核、安全回归与有限线上探测，**不是独立第三方安全审计或完整渗透测试**。未进行拒绝服务压测、全站XSS/依赖漏洞审计或外部TLS入口验收。已窃取的有效Bearer Cookie也不能仅靠设备记忆机制阻止重放，因此HTTPS仍是必要的后续措施。

参照 [OWASP 会话管理建议](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) 和 [CSRF防护建议](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) 检查传输、Cookie、会话生命周期和来源验证。

复测：`python3 deploy/linux/gateway-session_test.py`、`python3 deploy/linux/gateway-security_test.py`。部署前备份位于 `/var/backups/quant-chart-login-audit-20260921-220500/`，包含源文件/前端与Nginx配置。

## 登录表单403兼容性修复

用户反馈未登录设备在HTTP 8080提交账号密码后出现403。复核发现本次加固引入的 `Referrer-Policy: no-referrer` 与原生HTML表单来源检查冲突：浏览器在此策略下提交表单会将 Origin 序列化为 null，而后端按预期拒绝null来源。此前HTTP客户端测试自行指定了合法Origin，没有覆盖浏览器的这个行为。[MDN对该行为的说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy#effect_on_the_origin_header)。

已仅将登录响应策略改为 `same-origin`，保留同源原生表单的Origin，并继续阻止空来源、跨源请求。未恢复用户要求撤销的Host白名单。13项原有认证测试通过；线上核实8080/8081的 `/` 与 `/auth/login` 均返回200及新策略，null/跨源POST均在密码验证前返回403。密码文件与会话库未修改，备份位于 `/var/backups/quant-login-form-403-20260921-225554/`。

浏览器自动化连接再次因request-header policy加载失败而不可用，未完成真实浏览器表单复验。用户需重新打开登录页，让文档加载新策略；不能把本轮HTTP测试等同于浏览器端登录确认。
