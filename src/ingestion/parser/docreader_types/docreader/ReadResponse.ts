// Original file: src/ingestion/parser/docreader.proto

import type { ImageRef as _docreader_ImageRef, ImageRef__Output as _docreader_ImageRef__Output } from '../docreader/ImageRef';
import type { SourceBlock as _docreader_SourceBlock, SourceBlock__Output as _docreader_SourceBlock__Output } from '../docreader/SourceBlock';

export interface ReadResponse {
  'markdown_content'?: (string);
  'image_refs'?: (_docreader_ImageRef)[];
  'image_dir_path'?: (string);
  'metadata'?: ({[key: string]: string});
  'error'?: (string);
  'source_blocks'?: (_docreader_SourceBlock)[];
}

export interface ReadResponse__Output {
  'markdown_content': (string);
  'image_refs': (_docreader_ImageRef__Output)[];
  'image_dir_path': (string);
  'metadata': ({[key: string]: string});
  'error': (string);
  'source_blocks': (_docreader_SourceBlock__Output)[];
}
