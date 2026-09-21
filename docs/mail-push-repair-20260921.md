# 测试服务器邮件推送修复（2026-09-21）

服务器：`192.168.2.218`；应用目录：`/opt/quant-backtest`。

## 故障原因

- 东方财富 `clist/get` 列表接口在服务器上主动断开连接，资金流与热点板块回退到旧缓存，被邮件数据新鲜度检查拒绝。
- `OPENAI_BASE_URL=https://127.0.0.1:8443/v1` 使用自签名证书，Node 返回 `DEPTH_ZERO_SELF_SIGNED_CERT`。
- SMTP 连接与授权码认证正常。推送开关已开启，计划为上海时间 09:00、12:00、15:00。

## 修复

- 邮件上下文独立使用备用源，不覆盖原有逐股资金与板块缓存：资金使用东方财富沪深大盘汇总，板块使用新浪行业/概念行情。
- 资金备用源必须匹配目标交易日；交易时段要求有效分钟数据，午间允许当日 11:30 快照；盘前和盘后可使用目标交易日的日累计数据。备用源没有合格数据时仍拒绝推送。
- 新浪板块不提供主力资金和涨跌家数，这些字段保持 `null`，不伪造为 0。报告提示和新鲜度附录明确标注数据来源及口径限制。
- 模型地址修正为同机上游 `http://127.0.0.1:8787/v1`，没有关闭 TLS 证书校验，也没有更改模型密钥或邮件凭证。
- CLI 新增 `--dry-run`：验证 SMTP、刷新新闻与行情、执行新鲜度检查并生成报告，但不调用邮件投递。

```bash
cd /opt/quant-backtest/server
runuser -u quant -- node --import tsx src/services/marketOpinionPushCli.ts --kind=morning --dry-run
```

`--simulation` 仍会真实发信，仅在主题中添加“模拟推送”；验证配置请使用 `--dry-run`。

## 验证与回滚

- Windows 类型检查通过，Windows/Linux 共用的 37 项相关测试通过。
- 服务器真实 dry-run 成功：18 条入选新闻、3 个来源、约 4,800 字报告；SMTP 认证成功，`sent=false`。
- 本次真实数据验证在盘后执行，未假装验证未来交易时段的外部数据可用性；数据源均失败时继续停止投递，避免发送陈旧行情。
- 后端重启后推送状态为已启用、已配置；收件人数和推送时间保持原值。
- 初始备份：`/opt/quant-backtest/.deploy-backups/quant-mail-fix-20260921T122557Z`，包括源文件清单及仅 root 可读的环境文件备份。回滚需恢复源文件和本次修改的模型地址，并重启 `quant-backend`；不要覆盖修复之后用户新增的配置。

备用字段依据服务器已安装的 AKShare `stock_fund_em.py`、`stock_industry.py`，并在服务器直接验证数据响应；项目来源：[AKShare](https://github.com/akfamily/akshare)。
