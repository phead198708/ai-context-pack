import { NativeModule, registerWebModule } from 'expo';
class ContextNativeModule extends NativeModule {
  async scanInbox(): Promise<readonly never[]> {
    return [];
  }
  async getPendingShareEvents(): Promise<readonly never[]> {
    return [];
  }
  async ackPendingShareEvent(): Promise<boolean> {
    return true;
  }
  async ackEphemeralShareEvent(): Promise<boolean> {
    return true;
  }
  async getPendingRecoveryEvent(): Promise<null> {
    return null;
  }
  async ackRecoveryEvent(): Promise<boolean> {
    return true;
  }
}
export default registerWebModule(ContextNativeModule, 'ContextNative');
