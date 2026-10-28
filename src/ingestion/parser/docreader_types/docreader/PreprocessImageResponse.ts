// Original file: src/ingestion/parser/docreader.proto


export interface PreprocessImageResponse {
  'image'?: (Buffer | Uint8Array | string);
  'fallback_needed'?: (boolean);
  'theta'?: (number | string);
  'residual'?: (number | string);
  'flip'?: (boolean);
  'n_boxes'?: (number);
  'n_kept'?: (number);
  'status'?: (string);
}

export interface PreprocessImageResponse__Output {
  'image': (Buffer);
  'fallback_needed': (boolean);
  'theta': (number);
  'residual': (number);
  'flip': (boolean);
  'n_boxes': (number);
  'n_kept': (number);
  'status': (string);
}
