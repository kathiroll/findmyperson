import { MAX_PHOTO_BASE64_CHARS, MAX_PHOTO_EDGE_PX, type PersonPhoto } from '@findmyperson/shared';

/**
 * The photo seam. Picking and resizing are native work (an image picker and an image
 * manipulator), and neither library is in the app yet, so the screen codes against this and a
 * build supplies the adapter. Nothing in this file touches pixels.
 */
export interface PhotoPicked {
  uri: string;
  width: number;
  height: number;
}

export interface PhotoPort {
  /** Opens the photo library for one photo. Resolves null when the person backs out. */
  pick(): Promise<PhotoPicked | null>;
  /**
   * Scales the picked image to exactly `width` x `height`, encodes it (`image/webp` where the
   * platform can, else `image/jpeg`) at `quality` (0 to 1) and returns standard base64, padded.
   */
  resize(
    picked: PhotoPicked,
    target: { width: number; height: number; quality: number },
  ): Promise<{ mime: PersonPhoto['mime']; b64: string }>;
}

/** Longest edge of the thumbnail that is uploaded: the contract's MAX_PHOTO_EDGE_PX (256). */
export const THUMBNAIL_EDGE_PX = MAX_PHOTO_EDGE_PX;

/** Tried in order until the encoded thumbnail fits the contract's size cap. */
export const THUMBNAIL_QUALITIES = [0.8, 0.65, 0.5, 0.35] as const;

/** Largest size with the same aspect ratio whose longest edge is at most `edge`. Never upscales. */
export function fitWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export class PhotoTooLargeError extends Error {}

/**
 * Downscales a picked photo to the upload thumbnail, on the phone, before anything is sent. The
 * original never leaves the device: only this 256 px thumbnail goes in the report. Each photo of
 * a report goes through here on its own; how many a report may carry is form.ts's rule.
 */
export async function makeThumbnail(port: PhotoPort, picked: PhotoPicked): Promise<PersonPhoto> {
  if (!(picked.width > 0 && picked.height > 0)) {
    throw new RangeError('the picked image has no size');
  }
  const size = fitWithin(picked.width, picked.height, THUMBNAIL_EDGE_PX);
  for (const quality of THUMBNAIL_QUALITIES) {
    const encoded = await port.resize(picked, { ...size, quality });
    if (encoded.b64.length <= MAX_PHOTO_BASE64_CHARS) {
      return { mime: encoded.mime, w: size.width, h: size.height, b64: encoded.b64 };
    }
  }
  throw new PhotoTooLargeError('the thumbnail is too large even at the lowest quality');
}
