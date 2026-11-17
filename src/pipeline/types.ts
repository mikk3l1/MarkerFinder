/** Platform-neutral RGBA image (same layout as browser ImageData). */
export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A detected cap, in original-image pixel coordinates. */
export interface Cap {
  cx: number;
  cy: number;
  r: number;
}

export type DetectionStatus = 'confirmed' | 'uncertain' | 'failed';

export interface CapResult extends Cap {
  /** Normalized, validated code (null when nothing valid was read). */
  code: string | null;
  /** Raw OCR text of the best candidate. */
  rawText: string;
  /** 0–100 OCR confidence of the best candidate. */
  conf: number;
  status: DetectionStatus;
  /** Rotation (degrees) applied to make the text upright. */
  angle: number;
}
