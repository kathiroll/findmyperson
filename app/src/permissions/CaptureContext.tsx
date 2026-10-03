import type { LocationCapture } from '@findmyperson/native-location-capture';
/* eslint-disable @typescript-eslint/no-require-imports */
import { createContext, useContext, type ReactNode } from 'react';

const CaptureContext = createContext<LocationCapture | null>(null);

/** Supplies the capture module to screens. Production passes `NativeLocationCapture`. */
export function CaptureProvider({
  capture,
  children,
}: {
  capture: LocationCapture;
  children: ReactNode;
}) {
  return <CaptureContext.Provider value={capture}>{children}</CaptureContext.Provider>;
}

export function useCapture(): LocationCapture {
  const capture = useContext(CaptureContext);
  if (capture === null) {
    throw new Error('useCapture needs a CaptureProvider above it');
  }
  return capture;
}

/**
 * The real module, looked up on first use: importing it throws wherever native code is not
 * linked (unit tests, the app before the native projects exist), so the navigator only reaches
 * for it when no module was passed in.
 */
export function loadNativeCapture(): LocationCapture {
  const native = require('@findmyperson/native-location-capture/native') as {
    NativeLocationCapture: LocationCapture;
  };
  return native.NativeLocationCapture;
}
