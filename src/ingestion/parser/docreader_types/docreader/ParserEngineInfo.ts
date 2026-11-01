// Original file: src/ingestion/parser/docreader.proto


export interface ParserEngineInfo {
  'name'?: (string);
  'description'?: (string);
  'file_types'?: (string)[];
  'available'?: (boolean);
  'unavailable_reason'?: (string);
}

export interface ParserEngineInfo__Output {
  'name': (string);
  'description': (string);
  'file_types': (string)[];
  'available': (boolean);
  'unavailable_reason': (string);
}
