// Original file: src/ingestion/parser/docreader.proto


export interface ReadConfig {
  'parser_engine'?: (string);
  'parser_engine_overrides'?: ({[key: string]: string});
}

export interface ReadConfig__Output {
  'parser_engine': (string);
  'parser_engine_overrides': ({[key: string]: string});
}
