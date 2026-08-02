# AI Context Pack

> Share anything. Clean it, compress it, redact it, and send it to any AI.

把零散的截图、PDF、网页和文字，整理成一份可以直接发送给 ChatGPT、Claude、Codex 或其他工具的干净上下文包。

## Platform and architecture

The v0.1 MVP targets iOS/iPadOS and Android.

- React Native 0.86 + TypeScript provides the shared application UI, domain model, workflow orchestration, and deterministic Markdown output.
- Expo SDK 57 modules provide selected cross-platform capabilities, but `ios/` and `android/` are committed and maintained as production source.
- Swift and Kotlin adapters own system share ingestion, OCR, PDF processing, irreversible image redaction, and other resource-sensitive work.
- The core workflow is local-first and does not require an account, backend, cloud OCR, or remote LLM.

Incoming sharing is implemented with a native iOS Share Extension and Android share intents. The project does not depend on Expo's experimental iOS behavior for opening the containing app from a Share Extension.

## Planning

- [Product overview and usage](docs/wiki/Home.md)
- [Detailed product specification](docs/wiki/Product-Spec.md)
- [Technical architecture](docs/wiki/Architecture.md)
- [Implementation roadmap](docs/wiki/Roadmap.md)
- [Issue label taxonomy](docs/wiki/Labels.md)
- [ADR-0001: React Native cross-platform architecture](docs/adr/0001-react-native-cross-platform.md)
