# Implementation Roadmap

## 总体策略

先证明一条完整、隐私安全、可恢复的端到端路径，再扩展格式和自动化。每个 Phase 都有 promotion gate；未达到 gate 不进入下一阶段的功能堆叠。

## Phase 0 — Foundation

目标：得到可编译、可测试、可持续集成的原生 iOS 工程和已验证的关键技术决策。

交付：

- Xcode 工程、App 与 Share Extension target。
- 模块边界、领域模型、App Group、Persistence spike。
- CI、lint、unit test、fixture 规则、隐私安全日志。
- ADR：系统版本、存储、并发、PDF/ZIP 与 token estimator。

Promotion gate：

- clean checkout 可构建。
- App 与 Extension 在 CI/本地测试中通过。
- Share Extension 能把单张图片写入 Inbox，主 App 可恢复读取。
- 无用户内容进入日志。
- 未决架构问题有明确结论或有 owner 的 spike。

## Phase 1 — Ingest and Extract

目标：可靠接收所有 MVP 输入并生成统一、可恢复的提取结果。

交付：

- Share Extension 多 item 接收。
- Photos/Files/Text/URL 主 App 导入。
- 图片 OCR、PDF 文本提取与扫描页 OCR fallback。
- 统一 manifest、hash、checkpoint、item 级错误。
- 基础 Pack 列表、详情和状态展示。

Promotion gate：

- Photos、Files、Safari 三条端到端导入通过。
- 20 张截图一次分享不丢项。
- 四类 PDF fixture 有确定结果。
- 中断恢复不重复、不丢失、不产生半写文件。
- 所有失败项对用户可见并可重试。

## Phase 2 — Transform, Privacy and Export

目标：将输入变成安全、紧凑、可发送的上下文包。

交付：

- 规范化、完全/近似去重提示。
- 预算估算、三种预设、图片压缩。
- 敏感信息检测、审核与图片/文本遮挡。
- Pack Editor、最终预览。
- Markdown、PDF、attachment bundle 与系统分享。

Promotion gate：

- 典型 10 张截图流程在目标设备 15 秒内完成。
- Markdown round-trip、ZIP manifest/hash 和 PDF 快照测试通过。
- 高风险 finding 未决时默认阻止无提示快速导出。
- flatten 后敏感像素/文本不可恢复。
- 所有自动删除和遮挡均可解释、可复核。

## Phase 3 — Beta and App Store Readiness

目标：通过真实任务、性能和隐私审查，达到 TestFlight 与 App Store 可发布质量。

交付：

- 历史、删除、空间管理和生命周期清理。
- onboarding、权限解释、空状态、错误恢复。
- Accessibility、英文/中文、本地化截图。
- 性能矩阵、崩溃与资源测试。
- 隐私政策、App Privacy 回答、TestFlight build、发布 checklist。

Promotion gate：

- 至少 20 个真实任务，任务完成率 ≥80%。
- P0/P1 bug 为 0；已知 P2 有明确接受或修复计划。
- 飞行模式核心流程通过。
- 隐私审计、日志审计、依赖/license 审计通过。
- TestFlight 安装、升级、删除和数据清理路径验证。

## Phase 4 — Post-MVP

候选方向按用户数据决定，不提前阻塞 MVP：

- 屏幕录制：关键帧抽取、转录、重复帧删除。
- App Intents/Shortcuts：快速创建和导出。
- 目标预设：ChatGPT、Claude、Codex 的大小/格式模板，但保持标准输出。
- macOS 与跨设备 clipboard workflow。
- MCP Server：让桌面 AI 读取用户选择的 Pack。
- 可选 iCloud 同步和端到端加密共享。

进入条件：MVP 有稳定留存信号，且真实用户最常见失败明确指向该扩展。

## 建议开发顺序

1. 工程与 CI。
2. Domain/Persistence/App Group。
3. Share Extension + 图片 happy path。
4. 完整输入矩阵与 extraction。
5. Pack Editor 基础 UI。
6. normalization、duplicate、budget 与 compression。
7. privacy detection/review/redaction。
8. Markdown → bundle → PDF export。
9. recovery、storage、accessibility、localization。
10. performance、Beta、App Store release。

