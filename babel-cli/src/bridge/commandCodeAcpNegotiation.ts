/**
 * ACP wire negotiation outcomes (v1 stable, v2 draft). Installed vendor version is not asserted here.
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
}

export interface AcpNegotiatedCodec {
  protocolVersion: AcpProtocolVersion;
  agentInfo?: { name?: string; version?: string };
  session: AcpNegotiatedSessionCapabilities;
}

export function parseInitializeResult(result: Record<string, unknown>): AcpNegotiatedCodec {
  const protocolVersion = result.protocolVersion;
  if (protocolVersion !== 1 && protocolVersion !== 2) {
    throw new Error(`ACP_UNSUPPORTED_PROTOCOL_VERSION:${String(protocolVersion)}`);
  }
  const version = protocolVersion as AcpProtocolVersion;
  const caps =
    version === 2
      ? (result.capabilities as { session?: unknown } | undefined)?.session
      : (result.agentCapabilities as { session?: unknown } | undefined)?.session;
  const sessionCaps =
    caps === undefined || caps === null
      ? {
          baselineSession: false,
          resume: false,
          load: false,
          list: false,
          prompt: false,
          cancel: false,
        }
      : {
          baselineSession: true,
          resume: true,
          load: version === 1,
          list: true,
          prompt: true,
          cancel: true,
        };
  if (!sessionCaps.baselineSession) {
    throw new Error('ACP_AGENT_MISSING_SESSION_SURFACE');
  }
  const agentInfo =
    version === 2
      ? (result.info as { name?: string; version?: string } | undefined)
      : (result.agentInfo as { name?: string; version?: string } | undefined);
  return {
    protocolVersion: version,
    ...(agentInfo ? { agentInfo } : {}),
    session: sessionCaps,
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
