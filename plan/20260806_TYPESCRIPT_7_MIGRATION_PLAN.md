# 2026-08-06 TypeScript 7 迁移计划

> 状态：方案已调研完成，待执行
> 目标：将前端（含 Admin 控制台）与后端 TypeScript 编译器统一升级至 7.0.2
> 策略：渐进式迁移（配置预处理 → 共存测试 → 全量切换）
> 预计风险：低

## 0. 背景与目标

### 0.1 迁移背景

TypeScript 7.0 于 2026 年 7 月 8 日正式发布（npm 当前稳定版 `7.0.2`），是一次编译器层面的底层革命：

- **编译器用 Go 重写**：类型检查器、代码生成器、语言服务器全部从 TypeScript/JavaScript 移植到 Go 原生代码
- **性能大幅提升**：完整构建提速 8~12 倍，编辑器响应提速 10 倍以上，内存占用下降
- **类型逻辑结构同构**：类型检查逻辑从现有实现方法式移植，语义与 6.0 完全一致
- **新增并行能力**：`--checkers N` 控制类型检查器 worker 数，`--builders N` 控制项目引用并行构建数

> 微软 TS PM Daniel Rosenwasser 原话：「新代码库是从现有实现方法式地移植而来，而非从头重写，其类型检查逻辑在结构上与 TypeScript 6.0 相同。这种架构同构性确保编译器继续执行你已依赖的完全相同语义。」

### 0.2 项目当前版本

| 模块 | 当前版本 | 配置文件 |
| --- | --- | --- |
| 前端（业务 UI） | `^6.0.3` | `tsconfig.app.json`、`tsconfig.node.json` |
| 后端（Fastify） | `^5.7.0` | `server/tsconfig.json` |
| Admin 控制台 | 共用前端 `^6.0.3` | `admin/tsconfig.json` |

### 0.3 迁移目标

- 前端、后端、Admin 控制台统一升级至 `typescript@^7.0.2`
- 处理 TS 7 breaking changes 引起的配置与类型问题
- 保留现有构建流程（`tsc -b && vite build`、`tsx watch`）与测试流程（`vitest`）
- 全量测试通过，运行时行为无回归

## 1. TypeScript 7.0 关键变更

### 1.1 Breaking Changes（6.0 引入废弃 → 7.0 升级为硬错误）

| 废弃项 | 替代方案 |
| --- | --- |
| `target: "es5"` | 使用 ES2020+ |
| `downlevelIteration` | 不再支持 |
| `moduleResolution: "node"/"node10"` | 使用 `nodenext` 或 `bundler` |
| `module: "amd"/"umd"/"systemjs"/"none"` | 使用 `esnext` 或 `preserve` |
| `baseUrl` | 不再支持（`paths` 改为相对于项目根） |
| `esModuleInterop: false` / `allowSyntheticDefaultImports: false` | 不可设为 false |
| `alwaysStrict: false` | 始终为 true |
| `namespace` 中使用 `module` 关键字 | 禁止 |
| `import ... assert {...}` | 改用 `import ... with {...}` |

### 1.2 新默认值

| 配置项 | TS 7 默认值 | 影响 |
| --- | --- | --- |
| `strict` | `true` | 项目已设置 ✓ |
| `module` | `esnext` | 项目已设置 ✓ |
| `noUncheckedSideEffectImports` | `true` | **新增**，检查 side-effect import 是否能解析 |
| `libReplacement` | `false` | 新增 |
| `stableTypeOrdering` | `true`（**不可关闭**） | 类型解析顺序变更 |
| `rootDir` | `./`（需显式设置源目录） | 后端已设 ✓，前端 `noEmit` 不受影响 |
| `types` | `[]`（旧行为需设为 `["*"]`） | **关键变更**，不再自动加载全局 `@types/*` |

### 1.3 模板字面量类型的 Unicode 代码点感知

有意 breaking change：模板字面量类型 `infer` 拆分从 UTF-16 代码单元改为 Unicode 代码点感知。

```typescript
type HeadTail<S> = S extends `${infer Head}${infer Tail}` ? [Head, Tail] : never;
type Result = HeadTail<"abc">;
// 7.0:   ["", "abc"]
// 6.0:   ["\ud83d", "\ude00abc"]  // 旧行为按 UTF-16 拆分代理对
```

### 1.4 JavaScript 支持重构

基于 JSDoc 的类型推断有以下变更（对纯 JS 项目影响较大，本项目为纯 TS 不受影响）：

- 在类型位置使用值 → 必须写 `typeof someValue`
- `@enum` → 改用 `@typedef` 加 `keyof typeof`
- 独立的 `?` 作为类型 → 改用 `any`
- `@class` → 改用 `class` 声明
- 后缀 `!` → 直接用 `T`
- Closure 风格函数类型 `function(string): void` → 改用 `(s: string) => void`

## 2. 项目兼容性分析

### 2.1 代码层面兼容性检查

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| `namespace` 声明 | ✅ 零使用 | 全仓库无 `namespace` 关键字 |
| `enum` 声明 | ✅ 零使用 | 不受 `--erasableSyntaxOnly` 影响 |
| `import ... assert {}` 语法 | ✅ 零使用 | 仅有 `import assert from 'node:assert/strict'`（Node.js 模块导入，不受影响） |
| 装饰器语法（`@decorator`） | ✅ 零使用 | 代码中的 `@` 均为 Ant Design 组件 props 或 JSDoc 标签 |
| 模板字面量类型 `infer` | ✅ 零使用 | 不受 Unicode 代码点感知变更影响 |
| `import = require()` 语法 | ✅ 零使用 | — |
| `export =` 语法 | ✅ 零使用 | — |
| `asserts` 关键字在 import 上 | ✅ 零使用 | — |

### 2.2 配置层面兼容性检查

| 配置项 | 项目现状 | TS 7 要求 | 状态 |
| --- | --- | --- | --- |
| `target` | ES2020 / ES2022 | 非 es5 | ✅ |
| `module` | `ESNext` | 非 amd/umd/systemjs/none | ✅ |
| `moduleResolution` | `bundler` / `NodeNext` | 非 node/node10 | ✅ |
| `baseUrl` | 未使用 | 不支持 | ✅ |
| `esModuleInterop` | `true`（后端） | 不可为 false | ✅ |
| `allowSyntheticDefaultImports` | 未设置 | 不可为 false | ✅ |
| `downlevelIteration` | 未使用 | 不支持 | ✅ |
| `alwaysStrict` | 未显式设置（用 `strict: true`） | 始终 true | ✅ |
| `rootDir` | 后端 `"./src"`，前端无（`noEmit`） | 需显式设置 | ✅ |
| `types` | **所有 tsconfig 均未设置** | 默认 `[]` | ⚠️ 需处理 |

### 2.3 需要处理的问题

#### 问题 1：`types` 默认值变更（关键）

TypeScript 7 将 `types` 默认值从「自动加载所有 `@types/*`」改为 `[]`（不加载任何全局类型）。

| 模块 | 影响分析 | 处理方案 |
| --- | --- | --- |
| **后端** | 大量使用全局 `process`、`Buffer`、`__dirname`（来自 `@types/node`），未显式 import | **必须**添加 `"types": ["node"]` |
| **前端** | `vite/client` 已通过 `/// <reference types="vite/client" />` 显式引用；React 类型通过 import 解析 | 可选添加 `"types": ["vite/client"]` 以显式声明 |
| **Admin** | 同前端 | 同上 |

#### 问题 2：`noUncheckedSideEffectImports` 新默认值

| side-effect import | 位置 | 类型声明 | 状态 |
| --- | --- | --- | --- |
| `import 'dotenv/config'` | 后端 25 个 CLI 入口文件 | dotenv 自带类型 | ✅ 不受影响 |
| `import './index.css'` | `src/main.tsx` | `vite/client` 声明了 `*.css` 模块 | ✅ 不受影响 |
| `import './styles.css'` | `admin/src/main.tsx` | 同上 | ✅ 不受影响 |

#### 问题 3：后端版本跨度较大（5.7 → 7.0）

后端当前 TypeScript 5.7.0，跳过 6.0 直接到 7.0。但由于配置已使用推荐值（`NodeNext`、`ES2022`、`strict`），6.0 的废弃警告在项目中不会触发，直接升级到 7.0 风险可控。

### 2.4 工具链兼容性

| 工具 | 是否依赖 TypeScript API | 兼容性 |
| --- | --- | --- |
| `tsc`（编译器本身） | 是 — 正在被升级 | 直接升级 |
| `tsx`（TS 运行时） | 否 — 使用 esbuild 转译 | ✅ 不受影响 |
| `vite`（前端构建） | 否 — 使用 esbuild 转译 | ✅ 不受影响 |
| `vitest`（测试框架） | 否 — 使用 esbuild 转译，未启用 `typecheck` | ✅ 不受影响 |

> 注：TypeScript 7 的稳定程序化 API 要到 7.1 才就绪，但本项目工具链均使用 esbuild 转译，不直接调用 TypeScript API，因此不受影响。

## 3. 迁移方案

### 3.1 迁移策略：npm aliases 共存测试 → 全量切换

采用**渐进式迁移**，先用 npm aliases 让 TS 6 和 TS 7 共存进行测试，确认无问题后全量切换。

### 3.2 迁移阶段划分

| 阶段 | 内容 | 风险 | 可回滚 |
| --- | --- | --- | --- |
| Phase 1 | 配置预处理（不改变 TypeScript 版本） | 极低 | ✅ |
| Phase 2 | TS 7 共存测试（不替换 TS 6） | 低 | ✅ |
| Phase 3 | 全量切换 | 中 | ✅ |

## 4. Phase 1：配置预处理（不改变 TypeScript 版本）

### 4.1 目标

在不升级 TypeScript 版本的前提下，预先调整 tsconfig 以适配 TS 7 新默认值，确保在 TS 6 下无副作用。

### 4.2 步骤

#### Step 1：为所有 tsconfig 添加 `types` 字段

| 文件 | 变更内容 |
| --- | --- |
| `server/tsconfig.json` | 添加 `"types": ["node"]` |
| `tsconfig.app.json` | 添加 `"types": ["vite/client"]` |
| `admin/tsconfig.json` | 添加 `"types": ["vite/client"]` |
| `tsconfig.node.json` | 无需修改（仅编译 `vite.config.ts`，Vite 自身处理） |

#### Step 2：在 TS 6 下验证配置预处理无副作用

```bash
# 前端
npx tsc -b --noEmit

# 后端
cd server && npx tsc --noEmit

# Admin
npx tsc -p admin/tsconfig.json --noEmit
```

### 4.3 验收标准

- [ ] 三个模块的 `tsc --noEmit` 全部通过，无新增错误
- [ ] `npm test`（前端）和 `cd server && npm test`（后端）全部通过
- [ ] Git 提交：`chore(tsconfig): 预处理 types 字段以适配 TS 7 新默认值`

## 5. Phase 2：TS 7 共存测试（不替换 TS 6）

### 5.1 目标

通过 npm aliases 安装 TS 7 为独立别名包，与现有 TS 6 共存，使用 TS 7 运行类型检查与测试，捕获潜在兼容性问题。

### 5.2 步骤

#### Step 3：安装 TS 7 为独立别名包

```bash
# 前端根目录
npm install -D typescript-7@npm:typescript@7.0.2

# 后端目录
cd server && npm install -D typescript-7@npm:typescript@7.0.2
```

#### Step 4：用 TS 7 运行类型检查（不动 TS 6）

```bash
# 前端
npx -p typescript-7@npm:typescript@7.0.2 tsc -b --noEmit

# 后端
cd server && npx -p typescript-7@npm:typescript@7.0.2 tsc --noEmit

# Admin
npx -p typescript-7@npm:typescript@7.0.2 tsc -p admin/tsconfig.json --noEmit
```

#### Step 5：修复 TS 7 报告的类型错误（如有）

重点关注：

- `stableTypeOrdering` 引起的联合类型 / 条件类型解析顺序变化
- `noUncheckedSideEffectImports` 引起的 side-effect import 报错
- 任何因类型检查逻辑微调产生的新错误

#### Step 6：运行完整测试套件

```bash
# 前端测试
npm test

# 后端测试
cd server && npm test
```

### 5.3 验收标准

- [ ] TS 7 下三个模块的 `tsc --noEmit` 全部通过
- [ ] 前端全量测试通过
- [ ] 后端全量测试通过
- [ ] 所有 TS 7 报告的类型错误已修复（或确认为误报并记录）
- [ ] Git 提交：`chore(typescript): 安装 TS 7 别名包进行共存测试`（如有代码修复，含修复内容）

## 6. Phase 3：全量切换

### 6.1 目标

确认共存测试无问题后，正式将 TS 6 替换为 TS 7，移除别名包，完成迁移。

### 6.2 步骤

#### Step 7：正式升级版本

| 文件 | 变更内容 |
| --- | --- |
| `package.json` | `"typescript": "^6.0.3"` → `"typescript": "^7.0.2"` |
| `server/package.json` | `"typescript": "^5.7.0"` → `"typescript": "^7.0.2"` |

#### Step 8：移除别名包

```bash
npm uninstall typescript-7
cd server && npm uninstall typescript-7
```

#### Step 9：重新安装依赖并全量验证

```bash
# 前端
npm install
npm run build              # tsc -b && vite build
npm test

# 后端
cd server
npm install
npm run typecheck          # tsc --noEmit
npm run build              # tsc
npm test

# Admin
npm run admin:build        # tsc -p admin/tsconfig.json --noEmit && vite build
```

#### Step 10：启动开发服务器进行运行时验证

```bash
# 启动前后端
# 双击 start.bat 或运行 scripts/start-dev.ps1
# 验证：前端 5558、Admin 5559、后端 3001 正常运行
```

#### Step 11：运行时功能抽查

| 抽查项 | 验证点 |
| --- | --- |
| 前端业务 UI | 页面加载、路由跳转、K 线图渲染、回测执行 |
| Admin 控制台 | 登录、概览、诊断、配置编辑 |
| 后端 API | 市场数据接口、因子研究接口、模拟交易接口 |
| 构建产物 | `dist/` 目录生成正常，`tsc` 产物可被 `tsx` 运行 |

### 6.3 验收标准

- [ ] 前端 `npm run build` 通过
- [ ] 后端 `npm run build` 通过
- [ ] Admin `npm run admin:build` 通过
- [ ] 前端全量测试通过
- [ ] 后端全量测试通过
- [ ] 三个服务（5558/5559/3001）正常启动并响应
- [ ] Git 提交：`feat(typescript): 全面迁移至 TypeScript 7.0.2`

## 7. 最终配置变更清单

迁移完成后的最终配置变更总览：

| 文件 | 变更内容 |
| --- | --- |
| `package.json` | `typescript: "^6.0.3"` → `"^7.0.2"` |
| `server/package.json` | `typescript: "^5.7.0"` → `"^7.0.2"` |
| `server/tsconfig.json` | 添加 `"types": ["node"]` |
| `tsconfig.app.json` | 添加 `"types": ["vite/client"]` |
| `admin/tsconfig.json` | 添加 `"types": ["vite/client"]` |

## 8. 风险评估

| 风险项 | 等级 | 说明 | 缓解措施 |
| --- | --- | --- | --- |
| `types` 默认值变更 | 🟡 中 | 后端全局 Node 类型丢失 | Phase 1 预处理，提前添加 `types` |
| `stableTypeOrdering` 不可关闭 | 🟡 中 | 类型解析顺序变化可能导致新错误 | Phase 2 共存测试阶段捕获并修复 |
| 后端 5.7→7.0 跨版本 | 🟢 低 | 配置已使用推荐值，6.0 废弃项不触发 | Phase 2 共存测试验证 |
| 工具链不兼容 | 🟢 极低 | tsx/vite/vitest 均用 esbuild，不依赖 TS API | — |
| 运行时行为变化 | 🟢 极低 | TS 7 类型逻辑与 6.0 结构同构 | Phase 3 启动开发服务器验证 |

**总体风险：低**。项目代码风格现代（无 namespace/enum/decorator/旧式 import），配置已使用推荐值，工具链不依赖 TS API。

## 9. 回滚方案

如果迁移后出现不可解决的问题：

```bash
# 前端
git checkout -- package.json tsconfig.app.json admin/tsconfig.json
npm install

# 后端
cd server
git checkout -- package.json tsconfig.json
npm install
```

各 Phase 独立提交，可按 Phase 粒度回滚：

- Phase 3 失败 → 回滚到 Phase 2 状态（保留别名包配置）
- Phase 2 失败 → 回滚到 Phase 1 状态（移除别名包，保留 `types` 预处理）
- Phase 1 失败 → 回滚到初始状态（移除 `types` 字段）

## 10. 迁移后可选优化

迁移成功后，可在 CI 和本地开发中利用 TS 7 并行编译能力：

```bash
# CI 环境（平衡速度与内存）
npx tsc --checkers 4

# 本地开发机（追求速度）
npx tsc --checkers 8

# Monorepo 项目引用并行构建
npx tsc --build --builders 4
```

`--checkers` 和 `--builders` 有乘法效应：`--checkers 4 --builders 4` 允许最多 16 个类型检查器同时运行。需根据机器 CPU 核数和内存容量调整。

## 11. 关键参考

- TypeScript 7.0 RC 深度解读：Go 重写完成，编译器的「奇点时刻」
- TypeScript 7.0 正式发布：性能大幅提升，主版本号跃迁
- npm 包信息：`typescript@7.0.2`
- 官方共存策略：`@typescript/typescript6` 兼容包（本项目不需要，因工具链不依赖 TS API）
