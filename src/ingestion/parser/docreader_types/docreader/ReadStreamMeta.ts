// Original file: src/ingestion/parser/docreader.proto

import type { SourceBlock as _docreader_SourceBlock, SourceBlock__Output as _docreader_SourceBlock__Output } from '../docreader/SourceBlock';

export interface ReadStreamMeta {
  'markdown_content'?: (string);
  'image_dir_path'?: (string);
  'metadata'?: ({[key: string]: string});
  'error'?: (string);
  'image_count'?: (number);
  'source_blocks'?: (_docreader_SourceBlock)[];
}

export interface ReadStreamMeta__Output {
  'markdown_content': (string);
  'image_dir_path': (string);
  'metadata': ({[key: string]: string});
  'error': (string);
  'image_count': (number);
  'source_blocks': (_docreader_SourceBlock__Output)[];
}
