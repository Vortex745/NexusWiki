// Original file: src/ingestion/parser/docreader.proto


export interface ImageRef {
  'filename'?: (string);
  'original_ref'?: (string);
  'mime_type'?: (string);
  'storage_key'?: (string);
  'image_data'?: (Buffer | Uint8Array | string);
}

export interface ImageRef__Output {
  'filename': (string);
  'original_ref': (string);
  'mime_type': (string);
  'storage_key': (string);
  'image_data': (Buffer);
}
