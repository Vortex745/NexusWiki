import type * as grpc from '@grpc/grpc-js';
import type { MessageTypeDefinition } from '@grpc/proto-loader';

import type { DocReaderClient as _docreader_DocReaderClient, DocReaderDefinition as _docreader_DocReaderDefinition } from './docreader/DocReader';
import type { ImageRef as _docreader_ImageRef, ImageRef__Output as _docreader_ImageRef__Output } from './docreader/ImageRef';
import type { ListEnginesRequest as _docreader_ListEnginesRequest, ListEnginesRequest__Output as _docreader_ListEnginesRequest__Output } from './docreader/ListEnginesRequest';
import type { ListEnginesResponse as _docreader_ListEnginesResponse, ListEnginesResponse__Output as _docreader_ListEnginesResponse__Output } from './docreader/ListEnginesResponse';
import type { ParserEngineInfo as _docreader_ParserEngineInfo, ParserEngineInfo__Output as _docreader_ParserEngineInfo__Output } from './docreader/ParserEngineInfo';
import type { PreprocessImageRequest as _docreader_PreprocessImageRequest, PreprocessImageRequest__Output as _docreader_PreprocessImageRequest__Output } from './docreader/PreprocessImageRequest';
import type { PreprocessImageResponse as _docreader_PreprocessImageResponse, PreprocessImageResponse__Output as _docreader_PreprocessImageResponse__Output } from './docreader/PreprocessImageResponse';
import type { ReadConfig as _docreader_ReadConfig, ReadConfig__Output as _docreader_ReadConfig__Output } from './docreader/ReadConfig';
import type { ReadRequest as _docreader_ReadRequest, ReadRequest__Output as _docreader_ReadRequest__Output } from './docreader/ReadRequest';
import type { ReadResponse as _docreader_ReadResponse, ReadResponse__Output as _docreader_ReadResponse__Output } from './docreader/ReadResponse';
import type { ReadStreamMeta as _docreader_ReadStreamMeta, ReadStreamMeta__Output as _docreader_ReadStreamMeta__Output } from './docreader/ReadStreamMeta';
import type { ReadStreamResponse as _docreader_ReadStreamResponse, ReadStreamResponse__Output as _docreader_ReadStreamResponse__Output } from './docreader/ReadStreamResponse';
import type { SourceBlock as _docreader_SourceBlock, SourceBlock__Output as _docreader_SourceBlock__Output } from './docreader/SourceBlock';

type SubtypeConstructor<Constructor extends new (...args: any) => any, Subtype> = {
  new(...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  docreader: {
    DocReader: SubtypeConstructor<typeof grpc.Client, _docreader_DocReaderClient> & { service: _docreader_DocReaderDefinition }
    ImageRef: MessageTypeDefinition<_docreader_ImageRef, _docreader_ImageRef__Output>
    ListEnginesRequest: MessageTypeDefinition<_docreader_ListEnginesRequest, _docreader_ListEnginesRequest__Output>
    ListEnginesResponse: MessageTypeDefinition<_docreader_ListEnginesResponse, _docreader_ListEnginesResponse__Output>
    ParserEngineInfo: MessageTypeDefinition<_docreader_ParserEngineInfo, _docreader_ParserEngineInfo__Output>
    PreprocessImageRequest: MessageTypeDefinition<_docreader_PreprocessImageRequest, _docreader_PreprocessImageRequest__Output>
    PreprocessImageResponse: MessageTypeDefinition<_docreader_PreprocessImageResponse, _docreader_PreprocessImageResponse__Output>
    ReadConfig: MessageTypeDefinition<_docreader_ReadConfig, _docreader_ReadConfig__Output>
    ReadRequest: MessageTypeDefinition<_docreader_ReadRequest, _docreader_ReadRequest__Output>
    ReadResponse: MessageTypeDefinition<_docreader_ReadResponse, _docreader_ReadResponse__Output>
    ReadStreamMeta: MessageTypeDefinition<_docreader_ReadStreamMeta, _docreader_ReadStreamMeta__Output>
    ReadStreamResponse: MessageTypeDefinition<_docreader_ReadStreamResponse, _docreader_ReadStreamResponse__Output>
    SourceBlock: MessageTypeDefinition<_docreader_SourceBlock, _docreader_SourceBlock__Output>
  }
}

