// Original file: src/ingestion/parser/docreader.proto

import type * as grpc from '@grpc/grpc-js'
import type { MethodDefinition } from '@grpc/proto-loader'
import type { ListEnginesRequest as _docreader_ListEnginesRequest, ListEnginesRequest__Output as _docreader_ListEnginesRequest__Output } from '../docreader/ListEnginesRequest';
import type { ListEnginesResponse as _docreader_ListEnginesResponse, ListEnginesResponse__Output as _docreader_ListEnginesResponse__Output } from '../docreader/ListEnginesResponse';
import type { PreprocessImageRequest as _docreader_PreprocessImageRequest, PreprocessImageRequest__Output as _docreader_PreprocessImageRequest__Output } from '../docreader/PreprocessImageRequest';
import type { PreprocessImageResponse as _docreader_PreprocessImageResponse, PreprocessImageResponse__Output as _docreader_PreprocessImageResponse__Output } from '../docreader/PreprocessImageResponse';
import type { ReadRequest as _docreader_ReadRequest, ReadRequest__Output as _docreader_ReadRequest__Output } from '../docreader/ReadRequest';
import type { ReadResponse as _docreader_ReadResponse, ReadResponse__Output as _docreader_ReadResponse__Output } from '../docreader/ReadResponse';
import type { ReadStreamResponse as _docreader_ReadStreamResponse, ReadStreamResponse__Output as _docreader_ReadStreamResponse__Output } from '../docreader/ReadStreamResponse';

export interface DocReaderClient extends grpc.Client {
  ListEngines(argument: _docreader_ListEnginesRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  ListEngines(argument: _docreader_ListEnginesRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  ListEngines(argument: _docreader_ListEnginesRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  ListEngines(argument: _docreader_ListEnginesRequest, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  listEngines(argument: _docreader_ListEnginesRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  listEngines(argument: _docreader_ListEnginesRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  listEngines(argument: _docreader_ListEnginesRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  listEngines(argument: _docreader_ListEnginesRequest, callback: grpc.requestCallback<_docreader_ListEnginesResponse__Output>): grpc.ClientUnaryCall;
  
  PreprocessImage(argument: _docreader_PreprocessImageRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  PreprocessImage(argument: _docreader_PreprocessImageRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  PreprocessImage(argument: _docreader_PreprocessImageRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  PreprocessImage(argument: _docreader_PreprocessImageRequest, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  preprocessImage(argument: _docreader_PreprocessImageRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  preprocessImage(argument: _docreader_PreprocessImageRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  preprocessImage(argument: _docreader_PreprocessImageRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  preprocessImage(argument: _docreader_PreprocessImageRequest, callback: grpc.requestCallback<_docreader_PreprocessImageResponse__Output>): grpc.ClientUnaryCall;
  
  Read(argument: _docreader_ReadRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  Read(argument: _docreader_ReadRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  Read(argument: _docreader_ReadRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  Read(argument: _docreader_ReadRequest, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  read(argument: _docreader_ReadRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  read(argument: _docreader_ReadRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  read(argument: _docreader_ReadRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  read(argument: _docreader_ReadRequest, callback: grpc.requestCallback<_docreader_ReadResponse__Output>): grpc.ClientUnaryCall;
  
  ReadStream(argument: _docreader_ReadRequest, metadata: grpc.Metadata, options?: grpc.CallOptions): grpc.ClientReadableStream<_docreader_ReadStreamResponse__Output>;
  ReadStream(argument: _docreader_ReadRequest, options?: grpc.CallOptions): grpc.ClientReadableStream<_docreader_ReadStreamResponse__Output>;
  readStream(argument: _docreader_ReadRequest, metadata: grpc.Metadata, options?: grpc.CallOptions): grpc.ClientReadableStream<_docreader_ReadStreamResponse__Output>;
  readStream(argument: _docreader_ReadRequest, options?: grpc.CallOptions): grpc.ClientReadableStream<_docreader_ReadStreamResponse__Output>;
  
}

export interface DocReaderHandlers extends grpc.UntypedServiceImplementation {
  ListEngines: grpc.handleUnaryCall<_docreader_ListEnginesRequest__Output, _docreader_ListEnginesResponse>;
  
  PreprocessImage: grpc.handleUnaryCall<_docreader_PreprocessImageRequest__Output, _docreader_PreprocessImageResponse>;
  
  Read: grpc.handleUnaryCall<_docreader_ReadRequest__Output, _docreader_ReadResponse>;
  
  ReadStream: grpc.handleServerStreamingCall<_docreader_ReadRequest__Output, _docreader_ReadStreamResponse>;
  
}

export interface DocReaderDefinition extends grpc.ServiceDefinition {
  ListEngines: MethodDefinition<_docreader_ListEnginesRequest, _docreader_ListEnginesResponse, _docreader_ListEnginesRequest__Output, _docreader_ListEnginesResponse__Output>
  PreprocessImage: MethodDefinition<_docreader_PreprocessImageRequest, _docreader_PreprocessImageResponse, _docreader_PreprocessImageRequest__Output, _docreader_PreprocessImageResponse__Output>
  Read: MethodDefinition<_docreader_ReadRequest, _docreader_ReadResponse, _docreader_ReadRequest__Output, _docreader_ReadResponse__Output>
  ReadStream: MethodDefinition<_docreader_ReadRequest, _docreader_ReadStreamResponse, _docreader_ReadRequest__Output, _docreader_ReadStreamResponse__Output>
}
