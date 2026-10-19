/**
 * ACP wire negotiation (v1 stable baseline; v2 draft optional). No installed vendor version is asserted.
 */

export const ACP_SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const;
export type AcpProtocolVersion = (typeof ACP_SUPPORTED_PROTOCOL_VERSIONS)[number];

export interface AcpNegotiatedSessionCapabilities {
  baselineSession: boolean;
  resume: boolean;
  load: boolean;
  list: boolean;
  prompt: boolean;
  cancel: boolean;
  modelSelection: boolean;
}

export interface AcpNegotiatedCodec {
  protocolVersion: AcpProtocolVersion;
  agentInfo?: { name?: string; version?: string };
  session: AcpNegotiatedSessionCapabilities;
}

function parseV1Capabilities(result: Record<string, unknown>): AcpNegotiatedSessionCapabilities {
  const agentCapabilities = result.agentCapabilities as Record<string, unknown> | undefined;
  const loadSession = agentCapabilities?.loadSession === true;
  const sessionCapabilities = agentCapabilities?.sessionCapabilities as
    | { resume?: unknown; list?: unknown }
    | undefined;
  return {
    baselineSession: true,
    prompt: true,
    cancel: true,
    load: loadSession,
    resume: sessionCapabilities?.resume !== undefined,
    list: sessionCapabilities?.list !== undefined,
    modelSelection: false,
  };
}

function parseV2Capabilities(result: Record<string, unknown>): AcpNegotiatedSessionCapabilities {
  const session = (result.capabilities as { session?: unknown } | undefined)?.session;
  if (session === undefined || session === null) {
    throw new Error('ACP_V2_MISSING_SESSION_CAPABILITY');
  }
  return {
    baselineSession: true,
    prompt: true,
    cancel: true,
    load: false,
    resume: true,
    list: true,
    modelSelection: false,
  };
}

export function parseInitializeResult(result: Record<string, unknown>): AcpNegotiatedCodec {
  const protocolVersion = result.protocolVersion;
  if (protocolVersion !== 1 && protocolVersion !== 2) {
    throw new Error(`ACP_UNSUPPORTED_PROTOCOL_VERSION:${String(protocolVersion)}`);
  }
  const version = protocolVersion as AcpProtocolVersion;
  const session = version === 1 ? parseV1Capabilities(result) : parseV2Capabilities(result);
  const agentInfo =
    version === 2
      ? (result.info as { name?: string; version?: string } | undefined)
      : (result.agentInfo as { name?: string; version?: string } | undefined);
  return {
    protocolVersion: version,
    ...(agentInfo ? { agentInfo } : {}),
    session,
  };
}

export function buildInitializeParams(version: AcpProtocolVersion): Record<string, unknown> {
  if (version === 2) {
    return {
      protocolVersion: 2,
      capabilities: {},
      info: { name: 'babel-protocol-host', title: 'Babel', version: '1' },
    };
  }
  return {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'babel-protocol-host', version: '1' },
  };
}
