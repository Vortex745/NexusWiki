// Original file: src/ingestion/parser/docreader.proto

import type { ReadConfig as _docreader_ReadConfig, ReadConfig__Output as _docreader_ReadConfig__Output } from '../docreader/ReadConfig';

export interface ReadRequest {
  'file_content'?: (Buffer | Uint8Array | string);
  'file_name'?: (string);
  'file_type'?: (string);
  'url'?: (string);
  'title'?: (string);
  'config'?: (_docreader_ReadConfig | null);
  'request_id'?: (string);
}

export interface ReadRequest__Output {
  'file_content': (Buffer);
  'file_name': (string);
  'file_type': (string);
  'url': (string);
  'title': (string);
  'config': (_docreader_ReadConfig__Output | null);
  'request_id': (string);
}
