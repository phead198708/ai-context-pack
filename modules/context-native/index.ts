// Re-export the native module. On web, it will be resolved to ContextNativeModule.web.ts
// and on native platforms to ContextNativeModule.ts
export { default } from './src/ContextNativeModule';
export * from './src/ContextNative.types';
