import type { AuthenticatedDevice } from '@findmyperson/shared';

/**
 * Who may release or reject a report.
 *
 * TODO(operator-auth): NEEDS REAL OPERATOR AUTHENTICATION BEFORE THIS FACES THE INTERNET. For now
 * the operator is a device id on an allow-list, authenticated by the same forgeable stub as every
 * other caller (`createStubDeviceAuthenticator`): anyone who learns the captain's device id can
 * release reports. The release gate is the project's main safety control, so replace this with a
 * credential that is not end-user identity (an operator token, mTLS, or an admin login) and keep
 * the allow-list out of the picture. Every operator route calls `isOperator`; that is the one
 * call site to change. With an empty allow-list nobody is an operator (fails closed).
 */
export interface OperatorPolicy {
  isOperator(device: AuthenticatedDevice): boolean;
}

export function createDeviceAllowListOperatorPolicy(
  operatorDeviceIds: readonly string[],
): OperatorPolicy {
  const allowed = new Set(operatorDeviceIds);
  return { isOperator: (device) => allowed.has(device.device_id) };
}
