import sharp from 'sharp';
import type { RGBAImage } from '../src/pipeline/types';

/** Load an image file as RGBA, applying EXIF orientation. */
export async function loadImage(path: string): Promise<RGBAImage> {
  const { data, info } = await sharp(path).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}
