import { z } from 'zod';
import { UUID_V4_PATTERN } from '../uuid';

/**
 * POST /v1/devices (plan 9.2, 9.4).
 *
 * The device id is never in the body: it comes from the request's device identity
 * (identity/deviceIdentity.ts), so a body cannot claim to be a different device.
 */

export const PushTokenSchema = z.object({
  provider: z.enum(['fcm', 'apns']),
  token: z.string().min(1).max(4_096),
});
export type PushToken = z.infer<typeof PushTokenSchema>;

export const DeviceRegistrationRequestSchema = z.object({
  platform: z.enum(['android', 'ios']),
  app_version: z.string().min(1).max(32),
  /**
   * Sent only by a device that has filed a report, so it can be told about responses. A
   * bystander device never sends one: it listens on coarse topics that need no server-held
   * token (plan 9.4). Registration replaces the stored state, so leaving `push` out also
   * deletes a token registered earlier.
   */
  push: PushTokenSchema.optional(),
});
export type DeviceRegistrationRequest = z.infer<typeof DeviceRegistrationRequestSchema>;

export const DeviceRegistrationResponseSchema = z.object({
  device_id: z.string().regex(UUID_V4_PATTERN),
  /** Whether the server now holds a push token for this device. */
  push_registered: z.boolean(),
});
export type DeviceRegistrationResponse = z.infer<typeof DeviceRegistrationResponseSchema>;
