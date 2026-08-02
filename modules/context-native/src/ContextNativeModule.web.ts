import { NativeModule, registerWebModule } from 'expo';
class ContextNativeModule extends NativeModule {
  async scanInbox(): Promise<readonly never[]> {
    return [];
  }
  async consumePendingShareResult(): Promise<null> {
    return null;
  }
}
export default registerWebModule(ContextNativeModule, 'ContextNative');
