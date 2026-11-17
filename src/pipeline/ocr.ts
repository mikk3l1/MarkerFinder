import type { GrayImage } from './orientText';

export interface OcrWord {
  text: string;
  /** 0–100 */
  conf: number;
}

/** A text-line recognizer: one image holding a single line of text. */
export interface OcrEngine {
  recognize(img: GrayImage): Promise<OcrWord[]>;
  terminate(): Promise<void>;
}
