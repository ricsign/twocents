"use client";

/**
 * Getting a screenshot off a phone and onto the wire.
 *
 * A canvas rather than `FormData`, for two reasons that both matter. Every
 * route in this app parses `request.json()`, and one multipart endpoint would
 * be the only thing shaped differently. And a raw screenshot is two to three
 * megabytes of PNG, most of which buys nothing: the API scales anything past
 * roughly 1568px on its long edge down before it looks at it, so those extra
 * pixels cost upload seconds and no detail at all.
 *
 * Re-encoded as JPEG even when the input was a PNG. Screenshot text survives
 * quality 0.92 comfortably at this size, and it is the difference between a
 * 2.4MB upload and a 300KB one. If a reading ever comes back worse than it
 * should, the knob to turn is quality — not resolution.
 */

import { ACCEPTED_MIME, MAX_EDGE_PX } from "@/lib/ingest/schema";

export interface PreparedImage {
  mediaType: "image/jpeg";
  dataBase64: string;
  /** For the thumbnail strip, so the host can see what they are sending. */
  previewUrl: string;
  name: string;
}

/** What the file picker offers, and what `prepareImage` will accept. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_MIME.join(",");

export class UnreadableFileError extends Error {}

/**
 * One file, scaled and encoded.
 *
 * HEIC is not handled and is rejected by name rather than silently failing.
 * Chrome cannot decode it at all, so a path that worked on the presenter's
 * iPhone and nowhere else is worse than a clear "convert it first".
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (/\.hei[cf]$/i.test(file.name) || file.type === "image/heic") {
    throw new UnreadableFileError(
      `${file.name} is a HEIC photo, which most browsers cannot open. A screenshot or a JPEG works.`,
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new UnreadableFileError(`${file.name} could not be opened as an image.`);
  }

  try {
    // Never upscale: a small screenshot is small because it is small, and
    // stretching it adds bytes without adding anything to read.
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new UnreadableFileError("This browser would not give us a canvas.");
    context.drawImage(bitmap, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const comma = dataUrl.indexOf(",");
    if (comma === -1) throw new UnreadableFileError(`${file.name} could not be encoded.`);

    return {
      mediaType: "image/jpeg",
      // The prefix is stripped here: the provider builds the content block and
      // bytes still wrapped in `data:image/jpeg;base64,` make one the API rejects.
      dataBase64: dataUrl.slice(comma + 1),
      previewUrl: dataUrl,
      name: file.name,
    };
  } finally {
    bitmap.close();
  }
}
