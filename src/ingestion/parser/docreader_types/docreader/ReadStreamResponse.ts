// Original file: src/ingestion/parser/docreader.proto

import type { ReadStreamMeta as _docreader_ReadStreamMeta, ReadStreamMeta__Output as _docreader_ReadStreamMeta__Output } from '../docreader/ReadStreamMeta';
import type { ImageRef as _docreader_ImageRef, ImageRef__Output as _docreader_ImageRef__Output } from '../docreader/ImageRef';

export interface ReadStreamResponse {
  'meta'?: (_docreader_ReadStreamMeta | null);
  'image'?: (_docreader_ImageRef | null);
  'payload'?: "meta"|"image";
}

export interface ReadStreamResponse__Output {
  'meta'?: (_docreader_ReadStreamMeta__Output | null);
  'image'?: (_docreader_ImageRef__Output | null);
  'payload'?: "meta"|"image";
}
