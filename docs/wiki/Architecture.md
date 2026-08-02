# Technical Architecture — AI Context Pack

## 1. 技术基线

- Swift 6，严格并发检查。
- SwiftUI 主 App，UIKit/QuickLook/PDFKit 仅在系统能力需要时桥接。
- iOS/iPadOS 18+。
- Apple Vision OCR，PDFKit 文本提取与渲染。
- CryptoKit 计算 SHA-256。
- SwiftData 保存元数据，文件系统保存原始与派生二进制。
- App Group 连接 Share Extension 与主 App。
- MVP 不包含第三方分析 SDK 和云端 LLM SDK。

## 2. 模块边界

### App

负责主导航、依赖组装、系统权限和应用生命周期，不包含处理算法。

### ShareExtension

负责读取 NSItemProvider、类型验证、将输入原子复制到 App Group Inbox、写入 ingestion manifest，并打开或提示主 App。Extension 不运行 OCR、PDF 渲染或大图压缩。

### CoreDomain

包含 ContextPack、ContextItem、RiskFinding、ExportRecord、状态机、错误类型和跨模块协议。不得依赖 SwiftUI。

### Persistence

负责 SwiftData repository、文件路径分配、原子写入、引用计数、迁移、Inbox recovery 与 cleanup。

### Ingestion

把 Share Extension、PhotosPicker、fileImporter、pasteboard 的不同输入转换成统一 ContextItem。负责类型 sniffing、hash、大小限制和幂等导入。

### Extraction

包含 ImageOCRExtractor、PDFTextExtractor、PDFOCRFallback、PlainTextExtractor 与 URLMetadataExtractor。输出统一 ExtractedContent，不做 UI 决策。

### Processing

包含文本规范化、重复检测、感知 hash、预算估算和图片压缩。每一步以输入 artifact 生成新的 immutable derivative。

### Privacy

包含 SecretDetector、PIIDetector、finding model、review decision 和 RedactionRenderer。检测器版本进入 manifest，日志接口默认拒绝敏感 payload。

### Export

包含 MarkdownRenderer、PDFRenderer、BundleBuilder、ManifestWriter 和 ShareCoordinator。只允许从经过审核的 artifact allowlist 构建输出。

### UIComponents

包含 Pack card、item row、progress、risk badge、budget meter、preview 和通用 accessibility 支持。

## 3. 数据与文件布局

建议目录：

- Application Support/Packs/<pack-id>/originals
- Application Support/Packs/<pack-id>/derived
- Application Support/Packs/<pack-id>/exports
- App Group/Inbox/<ingestion-id>
- Caches/Previews

规则：

- originals 只读，所有处理产生 derived artifact。
- manifest 使用 schemaVersion，迁移必须向后兼容至少一个公开版本。
- 临时文件先写 .partial，再 fsync/close 后原子 rename。
- 数据库只保存相对引用，不保存可失效的临时绝对路径。
- Export allowlist 从 ContextItem 当前选择与 risk decision 生成。

## 4. Pipeline 状态机

Pack 状态：Draft → Processing → ReviewRequired/Ready → Exporting → Exported；任一步可进入 Failed 或 Cancelled，允许从 checkpoint 恢复。

Item stage：Received → Imported → Extracted → Analyzed → Reviewed → Packaged。

要求：

- stage 结果幂等；同一输入与配置重复执行不会产生冲突记录。
- 每一步都记录输入 artifact hash、处理器版本、输出 artifact hash 和耗时。
- failure 是 item 级；Pack 聚合完整性状态。
- 用户取消后停止创建新任务，已完成 artifact 保持一致。

## 5. 并发与后台执行

- 使用 actor 管理 Pack mutation 和 ArtifactStore。
- OCR、hash、压缩和 PDF 渲染在受限 TaskGroup 中执行。
- 初始并发上限 2；根据设备资源和热状态调节，不把并发直接等同 CPU 核数。
- 主 App 进入后台时保存 checkpoint；不承诺无限后台执行。
- Share Extension 只完成可在严格时间和内存预算内完成的接收任务。

## 6. 隐私与威胁模型

需要防护的风险：

- 原始敏感内容误进入导出。
- 视觉遮挡只覆盖 UI，但底层内容仍可恢复。
- 日志、崩溃报告或文件名泄漏用户数据。
- ZIP 路径穿越或恶意文件名覆盖。
- Share Extension 临时数据未清理。
- 处理失败被静默忽略，导致用户误以为输出完整。

控制措施：

- 导出使用新的 flattened bitmap 或经过替换的文本。
- Privacy-safe Logger 只接受枚举、计数、大小、耗时和不可逆 ID。
- 所有路径由内部 ID 生成，用户文件名只作为经过清洗的展示/导出名。
- 导出前执行 final audit：所有 pending high-risk finding 必须由用户处理或明确确认。
- 清理任务维护引用关系和过期时间，并有恢复扫描。

## 7. 可观察性

MVP 默认只记录本地技术指标：stage、duration、bytes、item count、error code、app version、detector version。

不得记录：OCR 原文、URL 全文、文件名、图片、PDF 内容、secret match、用户说明。

Beta 若加入诊断上传，必须：opt-in、先聚合/脱敏、可在设置中关闭，并提供待上传内容说明。

## 8. 测试策略

- CoreDomain：状态机与模型迁移单元测试。
- Ingestion：类型矩阵、部分失败、幂等和进程中断测试。
- Extraction：图片/PDF/文本 golden fixture。
- Processing：duplicate/near-duplicate、压缩质量和 token estimator 基准。
- Privacy：正例、困难负例、坐标映射、flatten 后不可恢复测试。
- Export：Markdown parser round-trip、PDF snapshot、ZIP manifest/hash/path traversal 测试。
- UI：核心 happy path、风险审核、失败恢复、VoiceOver smoke test。
- Performance：10/20/50 张截图和 10/50/100 页 PDF 的时间、峰值内存、输出大小。

测试 fixture 必须使用生成内容或公开无敏感样本，严禁提交真实 API Key 或个人文档。

## 9. 架构决策待确认

- SwiftData 在大量 item 与迁移场景下是否满足稳定性；Phase 0 用 spike 验证。
- PDF 生成选用 UIGraphicsPDFRenderer 还是更高层抽象；先以可测试性与字体支持为准。
- token 估算采用通用近似还是按目标预设插件化；MVP 采用通用估算并保留接口。
- ZIP 使用系统能力或轻量依赖；引入依赖前完成安全和 license review。
- 是否支持 App Intent/Shortcuts；延后到 MVP 后，避免阻塞核心路径。

