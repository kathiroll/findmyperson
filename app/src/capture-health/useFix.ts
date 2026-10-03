import { useCallback } from 'react';
import { useCapture } from '../permissions';
import type { Fix } from './flags';

/** Runs a flag's fix: system settings through the module, or the in-app permission flow. */
export function useFix(onOpenPermissionFlow: () => void): (fix: Fix) => void {
  const capture = useCapture();
  return useCallback(
    (fix: Fix) => {
      if (fix.kind === 'permission') onOpenPermissionFlow();
      else if (fix.kind === 'settings') void capture.openSystemSettings(fix.target);
    },
    [capture, onOpenPermissionFlow],
  );
}
