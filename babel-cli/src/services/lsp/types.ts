/**
 * LSP Protocol Types — minimal TypeScript types mirroring the LSP protocol.
 *
 * LSP specification: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
 *
 * We define our own types (rather than depending on vscode-languageserver-types)
 * to keep the dependency footprint small and avoid version conflicts.
 */

// ─── Primitive Positions & Ranges ──────────────────────────────────────────

/** A position in a text document (0-based line and character). */
export interface Position {
  line: number;
  character: number;
}

/** A range in a text document (inclusive start, exclusive end). */
export interface Range {
  start: Position;
  end: Position;
}

/** A location in a text document (URI + range). */
export interface Location {
  uri: string;
  range: Range;
}

/**
 * A location link returned by goToDefinition when the server supports
 * linkSupport. Links the original position to the target location.
 */
export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange?: Range;
}

// ─── Text Document Identifiers ─────────────────────────────────────────────

export interface TextDocumentIdentifier {
  uri: string;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

// ─── Hover ─────────────────────────────────────────────────────────────────

export interface MarkupContent {
  kind: 'markdown' | 'plaintext';
  value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

// ─── Symbols ───────────────────────────────────────────────────────────────

export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  tags?: number[];
  deprecated?: boolean;
  location: Location;
  containerName?: string;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  tags?: number[];
  deprecated?: boolean;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

// ─── Call Hierarchy ────────────────────────────────────────────────────────

export interface CallHierarchyItem {
  name: string;
  kind: SymbolKind;
  tags?: number[];
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

// ─── Server Capabilities ───────────────────────────────────────────────────

export interface ServerCapabilities {
  textDocumentSync?: number | TextDocumentSyncOptions;
  hoverProvider?: boolean;
  definitionProvider?: boolean | { linkSupport: boolean };
  referencesProvider?: boolean;
  documentSymbolProvider?: boolean;
  workspaceSymbolProvider?: boolean;
  implementationProvider?: boolean;
  callHierarchyProvider?: boolean;
}

export interface TextDocumentSyncOptions {
  openClose: boolean;
  change: number;
  willSave?: boolean;
  willSaveWaitUntil?: boolean;
  save?: boolean | { includeText: boolean };
}

// ─── Initialize ────────────────────────────────────────────────────────────

export interface InitializeParams {
  processId: number | null;
  clientInfo?: { name: string; version: string };
  locale?: string;
  rootPath?: string;
  rootUri: string | null;
  capabilities: ClientCapabilities;
  initializationOptions?: unknown;
  trace?: 'off' | 'messages' | 'verbose';
  workspaceFolders?: WorkspaceFolder[] | null;
}

export interface WorkspaceFolder {
  uri: string;
  name: string;
}

export interface ClientCapabilities {
  workspace?: {
    configuration?: boolean;
    workspaceFolders?: boolean;
    didChangeConfiguration?: { dynamicRegistration: boolean };
  };
  textDocument?: {
    synchronization?: {
      dynamicRegistration?: boolean;
      willSave?: boolean;
      willSaveWaitUntil?: boolean;
      didSave?: boolean;
    };
    hover?: {
      dynamicRegistration?: boolean;
      contentFormat?: string[];
    };
    definition?: {
      dynamicRegistration?: boolean;
      linkSupport?: boolean;
    };
    references?: {
      dynamicRegistration?: boolean;
    };
    documentSymbol?: {
      dynamicRegistration?: boolean;
      hierarchicalDocumentSymbolSupport?: boolean;
    };
    callHierarchy?: {
      dynamicRegistration?: boolean;
    };
    publishDiagnostics?: {
      relatedInformation?: boolean;
      tagSupport?: { valueSet: number[] };
      versionSupport?: boolean;
      codeDescriptionSupport?: boolean;
      dataSupport?: boolean;
    };
  };
  general?: {
    positionEncodings?: string[];
  };
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

// ─── LSP Operations ────────────────────────────────────────────────────────

export const LSP_OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

// ─── Server Config ─────────────────────────────────────────────────────────

export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface LspServerConfig {
  languageId: string;
  command: string;
  args: string[];
  fileExtensions: string[];
  /** Optional environment variables to pass to the server process. */
  env?: Record<string, string>;
  /** Optional workspace folder path. Defaults to project root. */
  workspaceFolder?: string;
  /** Maximum number of restarts on crash (default: 3). */
  maxRestarts?: number;
  /** Timeout in ms for server startup (default: 30000). */
  startupTimeout?: number;
  /** Initialization options to pass to the server. */
  initializationOptions?: unknown;
}

// ─── JSON-RPC 2.0 Base Types ───────────────────────────────────────────────

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: TResult;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

// ─── LSP Error Codes ───────────────────────────────────────────────────────

export const LSP_ERROR_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  UnknownErrorCode: -32001,
  ContentModified: -32801,
  RequestCancelled: -32800,
} as const;
