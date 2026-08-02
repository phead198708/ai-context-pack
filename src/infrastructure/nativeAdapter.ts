import { requireOptionalNativeModule } from 'expo';
import type { NativeAdapter } from '../domain/nativeAdapter';
type NativeMethods = Omit<NativeAdapter, 'available'>;
const module = requireOptionalNativeModule<NativeMethods>('ContextNative');
export const nativeAdapter: NativeAdapter = module
  ? {
      available: true,
      scanInbox: () => module.scanInbox(),
      recognizeText: (uri, script) => module.recognizeText(uri, script),
      probePdf: uri => module.probePdf(uri),
    }
  : {
      available: false,
      scanInbox: async () => [],
      recognizeText: async () => {
        throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
      },
      probePdf: async () => {
        throw new Error('NATIVE_ADAPTER_UNAVAILABLE');
      },
    };
