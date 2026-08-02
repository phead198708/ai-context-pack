import { NativeModule, registerWebModule } from 'expo';
class ContextNativeModule extends NativeModule {
  async scanInbox(): Promise<readonly never[]> {
    return [];
  }
}
export default registerWebModule(ContextNativeModule, 'ContextNative');
