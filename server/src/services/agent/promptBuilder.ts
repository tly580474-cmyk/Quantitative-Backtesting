export type TemplateStyle = 'classic-blue' | 'dark-pro' | 'minimal-white' | 'dashboard';

const TEMPLATE_DESCRIPTIONS: Record<TemplateStyle, string> = {
  'classic-blue': '经典金融蓝风格 — 蓝色渐变头部、白色卡片背景、多层阴影、正式专业。主色 #1a73e8，背景 #f5f7fa，卡片白色。',
  'dark-pro': '暗黑专业版 — GitHub Dark 风格、深色背景 #0d1117、青蓝主色 #58a6ff、发光边框效果。适合深度阅读。',
  'minimal-white': '极简白风格 — Apple/Notion 风格、大留白、无背景色、细线分隔、字体灰色层次。适合移动端友好。',
  'dashboard': '数据仪表盘风格 — Bloomberg 终端风格、紧凑布局、深色背景 #1a1a2e、数据密集型、状态指示灯。适合高信息密度展示。',
};

// 精简 CSS 类名速查表 — 避免读取整个模板文件（31KB），节省上下文窗口
const CSS_QUICK_REFERENCE = `
/* === CSS 类名速查表（直接内联到 <style> 中，勿读取模板文件） === */

/* 基础 */
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f8f9fa; color: #202124; font-size: 15px; line-height: 1.8; padding: 24px 16px 48px; }
.report { max-width: 1080px; margin: 0 auto; }

/* 报告头部 */
.report-header { background: linear-gradient(135deg, #1a73e8 0%, #1557b0 100%); color: #fff; border-radius: 10px; padding: 32px 36px; box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06); margin-bottom: 24px; }
.report-header .eyebrow { font-size: 13px; letter-spacing: 2px; opacity: 0.85; margin-bottom: 8px; text-transform: uppercase; }
.report-header h1 { font-size: 26px; font-weight: 600; line-height: 1.4; margin-bottom: 18px; }
.report-header .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px 24px; font-size: 14px; }
.report-header .meta-label { font-size: 12px; opacity: 0.8; }

/* 卡片 */
.card { background: #fff; border-radius: 10px; padding: 24px 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04); margin-bottom: 20px; }
.card-title { font-size: 18px; font-weight: 600; color: #1a73e8; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 2px solid #e8f0fe; }

/* 指标网格 */
.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; }
.metric-card { background: #f8f9fa; border-radius: 8px; padding: 16px; text-align: center; }
.metric-label { font-size: 13px; color: #5f6368; margin-bottom: 4px; }
.metric-value { font-size: 28px; font-weight: 700; color: #1a73e8; }
.metric-value .unit { font-size: 14px; font-weight: 400; color: #5f6368; }
.up { color: #d93025; }  /* A股：红涨 */
.down { color: #1e8e3e; }  /* A股：绿跌 */

/* Tab 切换 */
.tab-wrap { margin: 16px 0; }
.tab-nav { display: flex; gap: 4px; border-bottom: 2px solid #e8eaed; margin-bottom: 16px; }
.tab-btn { padding: 8px 20px; border: none; background: none; cursor: pointer; font-size: 14px; color: #5f6368; border-bottom: 2px solid transparent; margin-bottom: -2px; }
.tab-btn.active { color: #1a73e8; border-bottom-color: #1a73e8; font-weight: 600; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* 图表 */
.chart-wrap { margin: 20px 0; }
.chart-svg { width: 100%; height: auto; }  /* SVG 禁止设 width/height 属性，必须用 viewBox */
.chart-legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: #5f6368; margin-top: 8px; }
.chart-legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; }

/* 表格 */
.table-wrap { overflow-x: auto; margin: 16px 0; }
.layer-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.layer-table th { background: #d6e4fc; color: #1a73e8; padding: 10px 12px; text-align: left; font-weight: 600; cursor: pointer; }
.layer-table td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; }
.layer-table tr:hover td { background: #f8f9fa; }
.pos { color: #d93025; }  /* 正收益红色 */
.neg { color: #1e8e3e; }  /* 负收益绿色 */

/* 折叠区块 */
.collapse-item { border: 1px solid #e8eaed; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
.collapse-header { padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: #fff; }
.collapse-body { display: none; padding: 16px; border-top: 1px solid #e8eaed; background: #f8f9fa; }
.collapse-body.open { display: block; }

/* 结论与风险 */
.conclusion-list { list-style: none; padding: 0; }
.conclusion-list li { padding: 8px 0 8px 28px; position: relative; }
.conclusion-list li::before { content: "→"; position: absolute; left: 8px; color: #1a73e8; font-weight: bold; }
.risk-box { background: #fef7e0; border-left: 4px solid #f9ab00; border-radius: 4px; padding: 16px 20px; margin: 16px 0; }
.risk-title { color: #b06000; font-weight: 600; margin-bottom: 8px; }

/* 页脚 */
.report-footer { text-align: center; padding: 24px; color: #5f6368; font-size: 13px; border-top: 1px solid #e8eaed; margin-top: 32px; }
`;

export function buildPrompt(userPrompt: string, projectPath: string, templateStyle: TemplateStyle = 'classic-blue', reportPath: string = '', isResume: boolean = false): string {
  return `你是一个量化策略研究智能体，运行在 ${projectPath} 项目环境中。

## 项目能力

### 1. MySQL 数据库
项目有 MySQL 数据库（连接配置见 \`server/.env\`），你可以用 Python（\`pymysql\`）或 TypeScript（\`npx tsx -e "..."\`）执行 SQL 查询。

可查询的主要表：
- \`daily_candles\` — 日线 OHLCV 行情
- \`daily_bars_v2\` — v2 历史 K 线（含复权因子）
- \`daily_stock_metrics\` — PE_TTM、PB、换手率等
- \`instruments\` — 股票主数据
- \`trading_calendar\` — 交易日历
- \`factor_definitions\` / \`factor_runs\` / \`factor_reports\` — 因子研究记录
- \`index_constituent_members\` — 指数成分股
- \`sw_industry_memberships\` — 申万行业分类

> ⚠️ 因子库数据暂不完整，部分因子可能需要自行编写 Python 脚本定义和计算。

### 2. DuckDB 研究快照
Parquet 快照在 \`server/data/snapshots/\` 下：
\`\`\`bash
cd server && npm run duckdb
\`\`\`
DuckDB 使用教程：\`doc/02-因子研究与查询/LOCAL_DUCKDB_CLI_GUIDE.md\`

### 3. 外部数据获取
允许使用外部数据源。参考 \`a-stock-data\` 技能获取 A 股数据。可用：akshare、mootdx、东方财富等。
使用前需 \`pip install akshare\` 等所需包。

### 4. 回测
通过编写 Python 脚本完成回测。参考 \`CLAUDE.md\` 中的 "Backtest Engine Rules"。
- T 日信号，T+1 开盘执行（避免前视偏差）
- 买入：开盘价 × (1+滑点)；卖出：开盘价 × (1-滑点)
- 佣金：买卖均收；卖出额外收印花税

### 5. 因子研究
\`\`\`bash
cd server && npm run factor:run -- --factor momentum_20 --start 2026-05-01 --end 2026-06-30
\`\`\`

### 6. 报告生成
最终输出自包含 HTML 文件。报告写入路径由系统指定（见下方"报告输出路径"）。

## 用户需求

${userPrompt}

${isResume ? `## ⚠️ 重要：这是继续之前的会话

之前的研究数据已收集完毕，**请勿重新查询数据**。直接根据已有数据生成 HTML 报告。

` : ''}## 报告输出规范

1. 逐步展示思考和执行步骤
2. 输出**完整的自包含 HTML 文件**到以下路径：
   \`\`\`
   ${reportPath}
   \`\`\`
   确保目录存在（\`mkdir -p\`），然后将 HTML 内容写入该文件。

### ⚠️ 报告生成策略（关键！）

**不要试图一次性写入完整 HTML 文件。** 大型 HTML 报告可能超过单次输出限制，导致写入被截断并卡住。

请按以下步骤分步生成：

1. **第一步：写入 HTML 骨架**
   用 Write 工具写入包含 \`<!DOCTYPE html>\`、\`<head>\`、\`<style>\`（完整 CSS）、\`<body>\` 基本结构的骨架文件。body 中只放空的 \`<div class="report"></div>\` 容器。

2. **第二步起：用 Edit 工具逐章节填充内容**
   每次用 Edit 在 \`<div class="report">\` 中插入一个章节（如报告头部、研究目标、数据说明、结果展示、结论建议等）。每次只插入一个章节，控制单次输出量。

3. **最后一步：检查完整性**
   确认 HTML 文件结构完整，所有章节已填充。

这样可以避免单次输出过大导致截断卡住。

### HTML 报告要求
- **自包含**：所有 CSS/JS 内联，不引用外部资源（禁止 CDN）
- **交互性**：可排序表格、Tab 切换、SVG 图表 hover tooltip、折叠区块
- **视觉设计**：金融蓝（#1a73e8）主色，多层阴影，响应式，中文排版（行高 1.8，14-16px）
- **报告结构**：标题+元信息、研究目标、数据说明、分析方法、结果展示（交互图表）、结论建议、风险提示
- **图表**：内联 SVG，不依赖 JS 图表库
- **SVG 图表规范**：
  * 所有 SVG 图表必须包裹在 \`<div class="chart-wrap">\` 中
  * SVG 标签上**禁止**设置 \`width\` 和 \`height\` 属性
  * 必须设置正确的 \`viewBox\` 属性（如 \`viewBox="0 0 800 240"\`）
  * 图表内容（路径、文字、坐标轴）必须全部位于 viewBox 边界内
  * 使用标准 800x240 坐标系，左边距 50px、右边距 20px、上距 20px、下距 40px
  * 模板会自动注入 \`resizeCharts()\` 脚本处理自适应，请勿覆盖该函数
- **title 标签**以"研究报告："开头

### 报告模板风格

请使用以下风格生成报告：
${TEMPLATE_DESCRIPTIONS[templateStyle]}

**不要读取模板文件。** 请直接使用以下内联 CSS 类名速查表生成报告：
${CSS_QUICK_REFERENCE}

### 报告提取标记
HTML 中加 \`<!-- REPORT_SUMMARY: ... -->\` 注释，一行纯文本摘要。
`;
}
