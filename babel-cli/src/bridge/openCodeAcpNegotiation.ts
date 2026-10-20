/**
 * ACP wire negotiation (v1 stable baseline; v2 draft optional). No installed vendor version is asserted.
 */

export const ACP_SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
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
    resume:
      sessionCapabilities?.resume != null && typeof sessionCapabilities.resume === 'object',
    list: sessionCapabilities?.list != null && typeof sessionCapabilities.list === 'object',
    modelSelection: false,
  };
}

export function parseInitializeResult(result: Record<string, unknown>): AcpNegotiatedCodec {
  const protocolVersion = result.protocolVersion;
  if (protocolVersion !== 1) {
    throw new Error(`ACP_UNSUPPORTED_PROTOCOL_VERSION:${String(protocolVersion)}`);
  }
  const version = protocolVersion as AcpProtocolVersion;
  const session = parseV1Capabilities(result);
  const agentInfo = result.agentInfo as { name?: string; version?: string } | undefined;
  return {
    protocolVersion: version,
    ...(agentInfo ? { agentInfo } : {}),
    session,
  };
}

export function buildInitializeParams(version: AcpProtocolVersion): Record<string, unknown> {
  if (version !== 1) {
    throw new Error(`ACP_UNSUPPORTED_PROTOCOL_VERSION:${String(version)}`);
  }
  return {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'babel-protocol-host', version: '1' },
  };
}
