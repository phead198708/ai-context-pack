import { requireOptionalNativeModule } from 'expo';
import { createNativeAdapter, type NativeMethods } from './createNativeAdapter';

const module = requireOptionalNativeModule<NativeMethods>('ContextNative');
export const nativeAdapter = createNativeAdapter(module);
