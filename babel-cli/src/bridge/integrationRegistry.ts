import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** Must match the wire helper's namespace in `protocol/remoteContract.ts`. */
const RENEWAL_REQUEST_PREFIX = 'renewal:';
function renewalRequestId(principalId: string, sequence: number): string {
  return `${RENEWAL_REQUEST_PREFIX}${principalId}:${sequence}`;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sameSecret(presented: string, expectedDigest: string): boolean {
  const actual = Buffer.from(digest(presented), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function contained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export interface RegisteredAcpSession {
  principalId: string;
  sessionId: string;
  projectId: string;
  sessionBinding: string;
  registrationGeneration: number;
  projectGeneration: number;
  hostInstanceId: string;
  expiresAtMs: number;
  credential: string;
}

export const ACP_SESSION_CREDENTIAL_TTL_MS = 5 * 60_000;

/**
 * Renewal history retained per principal. `request_sequence` is the monotonic
 * per-principal idempotency key: a sequence at or below the retained high-water
 * mark is retired and cannot act again, while the generation fence rejects
 * delayed messages from older generations. Only recent issuance rows are kept
 * for exact replay and conflict diagnostics, so storage is O(principals), not
 * O(renewals), and retired keys are unusable without any global lifetime cap.
 */
export const ACP_SESSION_RENEWAL_HISTORY = 8;

/** Additive schema version understood by this build. Later versions fail closed. */
const ACP_REGISTRY_SCHEMA_VERSION = 5;

/** Purpose-separated derivation scheme for ACP session credentials. */
const ACP_SESSION_CREDENTIAL_SCHEME = 'hmac-sha256-v1';
const ACP_SESSION_CREDENTIAL_PURPOSE = 'babel.integration.acp-session.v1';
/** v4 request IDs are recorded but their issuance metadata was discarded. */
const LEGACY_V4_RESERVATION_KIND = 'legacy_v4_reserved';
const LEGACY_V4_RESERVATION_SCHEME = 'legacy-v4-reserved';

interface ResolvedProject {
  projectId: string;
  canonicalRoot: string;
  generation: number;
  /** Digest of the canonical root and its live filesystem identity (`dev`/`ino`). */
  filesystemIdentity: string;
}

interface IssuanceScope {
  kind: 'registration' | 'requalification';
  integrationId: string;
  principalId: string;
  requestId: string;
  requestSequence: number | null;
  expectedGeneration: number;
  issuedGeneration: number;
  projectId: string;
  projectGeneration: number;
  projectIdentity: string;
  integrationGeneration: number;
  hostInstanceId: string;
  sessionBinding: string;
  expiresAtMs: number;
}

export type AcpSessionDisposition =
  | 'issued' | 'not_issued' | 'superseded' | 'expired' | 'revoked' | 'reserved' | 'retired';

export interface AcpSessionStatus {
  principalId: string;
  projectId: string;
  sessionBinding: string;
  requestId: string;
  requestSequence: number;
  /** Authoritative high-water idempotency sequence for the next renewal. */
  renewalSequence: number;
  /** Authoritative current host incarnation for the next renewal. */
  hostInstanceId: string;
  registrationGeneration: number;
  expiresAtMs: number;
  disposition: AcpSessionDisposition;
}

/** Internal signal for a serialized CAS miss; thrown to force transaction rollback. */
class RequalificationCasMissError extends Error {}

/**
 * Canonical, non-secret issuance metadata. Both the stored request fingerprint
 * and the derived credential are bound to exactly these fields.
 */
function issuanceMetadata(scope: IssuanceScope): string {
  return JSON.stringify({
    scheme: ACP_SESSION_CREDENTIAL_SCHEME,
    kind: scope.kind,
    integration_id: scope.integrationId,
    principal_id: scope.principalId,
    request_id: scope.requestId,
    request_sequence: scope.requestSequence,
    expected_generation: scope.expectedGeneration,
    issued_generation: scope.issuedGeneration,
    project_id: scope.projectId,
    project_generation: scope.projectGeneration,
    project_identity: scope.projectIdentity,
    integration_generation: scope.integrationGeneration,
    host_instance_id: scope.hostInstanceId,
    session_binding: scope.sessionBinding,
    expires_at: scope.expiresAtMs,
  });
}

/**
 * Derive an ACP session credential from the already-presented high-entropy
 * owner credential. The registry stores only its digest, so an exact replay can
 * reproduce the same plaintext without persisting reusable secrets.
 */
function deriveSessionCredential(ownerCredential: string, scope: IssuanceScope): string {
  const key = createHmac('sha256', ownerCredential).update(`${ACP_SESSION_CREDENTIAL_PURPOSE}.key`).digest();
  return createHmac('sha256', key)
    .update(ACP_SESSION_CREDENTIAL_PURPOSE)
    .update('\0')
    .update(issuanceMetadata(scope))
    .digest('base64url');
}

/**
 * Request intent fingerprint. Issued generation and expiry are deliberately
 * excluded so a lost-response retry reproduces the same intent fingerprint.
 */
function requestFingerprint(scope: IssuanceScope): string {
  return digest(JSON.stringify({
    scheme: ACP_SESSION_CREDENTIAL_SCHEME,
    kind: scope.kind,
    integration_id: scope.integrationId,
    principal_id: scope.principalId,
    request_id: scope.requestId,
    request_sequence: scope.requestSequence,
    expected_generation: scope.expectedGeneration,
    project_id: scope.projectId,
    project_generation: scope.projectGeneration,
    project_identity: scope.projectIdentity,
    integration_generation: scope.integrationGeneration,
    host_instance_id: scope.hostInstanceId,
    session_binding: scope.sessionBinding,
  }));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Durable owner-provisioned project and scoped ACP principal registry. */
export class IntegrationRegistry {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(databasePath: string, protectDirectory: (directory: string) => void,
    options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    protectDirectory(dirname(resolve(databasePath)));
    this.db = new DatabaseSync(databasePath);
    try {
      // Set the lock wait before the first version read so a cold or contended
      // database cannot fail immediately, and close on every startup failure.
      this.db.exec('PRAGMA busy_timeout=10000;');
      const initialVersion = this.readSchemaVersion();
      if (initialVersion > ACP_REGISTRY_SCHEMA_VERSION) {
        throw new Error(`integration registry schema version ${initialVersion} is newer than supported ${ACP_REGISTRY_SCHEMA_VERSION}`);
      }
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;');
      this.transaction(() => this.applySchema());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private readSchemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number })['user_version'] ?? 0);
  }

  /**
   * Atomic, version-checked, additive schema initialization. A database written
   * by a newer build fails closed before any table or row changes.
   */
  private applySchema(): void {
    const version = this.readSchemaVersion();
    if (version > ACP_REGISTRY_SCHEMA_VERSION) {
      throw new Error(`integration registry schema version ${version} is newer than supported ${ACP_REGISTRY_SCHEMA_VERSION}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registered_projects (
        project_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
        filesystem_dev TEXT NOT NULL, filesystem_ino TEXT NOT NULL, enabled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integrations (
        integration_id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_hash TEXT NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_projects (
        integration_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(integration_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS acp_principals (
        principal_id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, request_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL, project_id TEXT NOT NULL, session_binding TEXT NOT NULL,
        credential_hash TEXT NOT NULL, generation INTEGER NOT NULL, project_generation INTEGER NOT NULL,
        integration_generation INTEGER NOT NULL, host_instance_id TEXT NOT NULL,
        last_request_sequence INTEGER NOT NULL DEFAULT 0,
        last_requalification_request_id TEXT, last_requalification_fingerprint TEXT,
        expires_at INTEGER NOT NULL, enabled INTEGER NOT NULL,
        UNIQUE(integration_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS integration_transport_sessions (
        session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
        registration_generation INTEGER NOT NULL, project_generation INTEGER NOT NULL,
        host_instance_id TEXT NOT NULL, enabled INTEGER NOT NULL,
        UNIQUE(principal_id,host_instance_id,registration_generation)
      );
      CREATE TABLE IF NOT EXISTS acp_session_issuances (
        integration_id TEXT NOT NULL, request_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        issuance_kind TEXT NOT NULL, request_sequence INTEGER,
        expected_generation INTEGER NOT NULL, issued_generation INTEGER NOT NULL,
        project_id TEXT NOT NULL, project_generation INTEGER NOT NULL, project_identity TEXT NOT NULL,
        integration_generation INTEGER NOT NULL, host_instance_id TEXT NOT NULL, session_binding TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL, credential_scheme TEXT NOT NULL, credential_hash TEXT NOT NULL,
        issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(integration_id, request_id)
      );
    `);
    const principalColumns = new Set((this.db.prepare('PRAGMA table_info(acp_principals)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!principalColumns.has('host_instance_id')) {
      this.db.exec("ALTER TABLE acp_principals ADD COLUMN host_instance_id TEXT NOT NULL DEFAULT ''");
      this.db.exec("UPDATE acp_principals SET enabled=0 WHERE host_instance_id=''");
    }
    if (!principalColumns.has('last_request_sequence')) {
      this.db.exec('ALTER TABLE acp_principals ADD COLUMN last_request_sequence INTEGER NOT NULL DEFAULT 0');
    }
    if (!principalColumns.has('last_requalification_request_id')) {
      this.db.exec('ALTER TABLE acp_principals ADD COLUMN last_requalification_request_id TEXT');
    }
    if (!principalColumns.has('last_requalification_fingerprint')) {
      this.db.exec('ALTER TABLE acp_principals ADD COLUMN last_requalification_fingerprint TEXT');
    }
    if (!principalColumns.has('expires_at')) {
      this.db.exec('ALTER TABLE acp_principals ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
      this.db.exec("UPDATE acp_principals SET enabled=0 WHERE expires_at=0");
    }
    const issuanceColumns = new Set((this.db.prepare('PRAGMA table_info(acp_session_issuances)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!issuanceColumns.has('request_sequence')) {
      this.db.exec('ALTER TABLE acp_session_issuances ADD COLUMN request_sequence INTEGER');
    }
    const projectColumns = new Set((this.db.prepare('PRAGMA table_info(registered_projects)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!projectColumns.has('filesystem_dev')) {
      this.db.exec("ALTER TABLE registered_projects ADD COLUMN filesystem_dev TEXT NOT NULL DEFAULT ''");
      this.db.exec("UPDATE registered_projects SET enabled=0 WHERE filesystem_dev=''");
    }
    if (!projectColumns.has('filesystem_ino')) {
      this.db.exec("ALTER TABLE registered_projects ADD COLUMN filesystem_ino TEXT NOT NULL DEFAULT ''");
      this.db.exec("UPDATE registered_projects SET enabled=0 WHERE filesystem_ino=''");
    }
    const reserve = (predicate: string): void => {
      this.db.exec(`INSERT OR IGNORE INTO acp_session_issuances(
          integration_id,request_id,principal_id,issuance_kind,request_sequence,expected_generation,issued_generation,
          project_id,project_generation,project_identity,integration_generation,host_instance_id,session_binding,
          request_fingerprint,credential_scheme,credential_hash,issued_at,expires_at)
        SELECT a.integration_id,${predicate},a.principal_id,'${LEGACY_V4_RESERVATION_KIND}',NULL,
          -1,a.generation,a.project_id,a.project_generation,'',a.integration_generation,a.host_instance_id,
          a.session_binding,'','${LEGACY_V4_RESERVATION_SCHEME}','',0,0
        FROM acp_principals a
        WHERE ${predicate} IS NOT NULL AND ${predicate}<>''
          AND NOT EXISTS (SELECT 1 FROM acp_session_issuances s
            WHERE s.integration_id=a.integration_id AND s.request_id=${predicate})`);
    };
    // Retain every still-recorded v4 request ID: both the initial registration and
    // the last renewal. Older v4 history was already discarded and is not invented.
    reserve('a.request_id');
    reserve('a.last_requalification_request_id');
    // A v4 build does not write issuance rows, so these guards make downgraded
    // credential issuance/replay fail closed on a migrated database. There is no
    // supported live downgrade to v4; reopening with v5 restores the version.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS acp_principals_issuance_insert
      BEFORE INSERT ON acp_principals
      WHEN NOT EXISTS (
        SELECT 1 FROM acp_session_issuances s
        WHERE s.principal_id=NEW.principal_id AND s.request_id=NEW.request_id
          AND s.issued_generation=NEW.generation AND s.credential_hash=NEW.credential_hash
          AND s.issuance_kind='registration')
      BEGIN SELECT RAISE(ABORT, 'acp_principal_issuance_required'); END;
      CREATE TRIGGER IF NOT EXISTS acp_principals_issuance_update
      BEFORE UPDATE OF credential_hash, generation ON acp_principals
      WHEN NEW.enabled=1 AND NOT EXISTS (
        SELECT 1 FROM acp_session_issuances s
        WHERE s.principal_id=OLD.principal_id AND s.issued_generation=NEW.generation
          AND s.credential_hash=NEW.credential_hash
          AND s.request_id=NEW.last_requalification_request_id
          AND s.issuance_kind='requalification')
      BEGIN SELECT RAISE(ABORT, 'acp_principal_issuance_required'); END;
    `);
    this.db.exec(`PRAGMA user_version=${ACP_REGISTRY_SCHEMA_VERSION}`);
  }

  registerProject(input: { projectId: string; root: string }): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.projectId)) throw new Error('invalid project ID');
    const root = realpathSync(resolve(input.root));
    const rootInfo = statSync(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.dev === 0n || rootInfo.ino === 0n || lstatSync(root).isSymbolicLink()) {
      throw new Error('registered project root must be a real directory with stable filesystem identity');
    }
    const projects = this.db.prepare('SELECT project_id,canonical_root FROM registered_projects WHERE enabled=1').all() as Array<Record<string, unknown>>;
    for (const project of projects) {
      const previous = String(project['canonical_root']);
      if (project['project_id'] === input.projectId) continue;
      if (contained(previous, root) || contained(root, previous)) throw new Error('registered project roots must be disjoint');
    }
    this.transaction(() => this.db.prepare(`INSERT INTO registered_projects
      (project_id,canonical_root,generation,filesystem_dev,filesystem_ino,enabled)
      VALUES(?,?,1,?,?,1) ON CONFLICT(project_id) DO UPDATE SET canonical_root=excluded.canonical_root,
      generation=registered_projects.generation+1,filesystem_dev=excluded.filesystem_dev,
      filesystem_ino=excluded.filesystem_ino,enabled=1`).run(input.projectId, root,
      String(rootInfo.dev), String(rootInfo.ino)));
  }

  registerIntegration(input: { integrationId: string; name: string; allowedProjectIds: string[] }): string {
    if (!input.integrationId || !input.name || input.allowedProjectIds.length === 0) throw new Error('integration requires identity and project scope');
    for (const projectId of new Set(input.allowedProjectIds)) {
      const exists = this.db.prepare('SELECT 1 FROM registered_projects WHERE project_id=? AND enabled=1').get(projectId);
      if (!exists) throw new Error('integration references an unregistered project');
    }
    const credential = randomBytes(32).toString('base64url');
    this.transaction(() => {
      const generationRow = this.db.prepare('SELECT generation FROM integrations WHERE integration_id=?').get(input.integrationId) as { generation?: number } | undefined;
      const generation = (generationRow?.generation ?? 0) + 1;
      this.db.prepare(`INSERT INTO integrations(integration_id,name,credential_hash,generation,enabled) VALUES(?,?,?,?,1)
        ON CONFLICT(integration_id) DO UPDATE SET name=excluded.name,credential_hash=excluded.credential_hash,
        generation=excluded.generation,enabled=1`).run(input.integrationId, input.name, digest(credential), generation);
      this.db.prepare('DELETE FROM integration_projects WHERE integration_id=?').run(input.integrationId);
      const add = this.db.prepare('INSERT INTO integration_projects(integration_id,project_id) VALUES(?,?)');
      for (const projectId of new Set(input.allowedProjectIds)) add.run(input.integrationId, projectId);
    });
    return credential;
  }

  authenticateIntegration(credential: string): boolean {
    const rows = this.db.prepare('SELECT credential_hash FROM integrations WHERE enabled=1').all() as Array<{ credential_hash: string }>;
    return rows.some((row) => sameSecret(credential, row.credential_hash));
  }

  resolveProject(projectId: string): { projectId: string; canonicalRoot: string; generation: number } | null {
    const resolved = this.resolveProjectIdentity(projectId);
    return resolved ? { projectId: resolved.projectId, canonicalRoot: resolved.canonicalRoot, generation: resolved.generation } : null;
  }

  /**
   * Revalidate the live project root and bind its canonical path plus filesystem
   * identity (`dev`/`ino`) so issuance cannot rely on a stale registry row.
   */
  private resolveProjectIdentity(projectId: string): ResolvedProject | null {
    const row = this.db.prepare(`SELECT canonical_root,generation,filesystem_dev,filesystem_ino
      FROM registered_projects WHERE project_id=? AND enabled=1`).get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const root = String(row['canonical_root']);
    const dev = String(row['filesystem_dev']);
    const ino = String(row['filesystem_ino']);
    try {
      if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) return null;
      const actual = statSync(root, { bigint: true });
      if (!actual.isDirectory() || actual.dev === 0n || actual.ino === 0n ||
          String(actual.dev) !== dev || String(actual.ino) !== ino) return null;
    } catch {
      return null;
    }
    return { projectId, canonicalRoot: root, generation: Number(row['generation']),
      filesystemIdentity: digest(`${root}\u0000${dev}\u0000${ino}`) };
  }

  createAcpSession(input: {
    integrationCredential: string; requestId: string; projectId: string; sessionBinding: string;
    expectedHostInstance: string; currentHostInstance: string;
  }): { ok: true; session: RegisteredAcpSession } | { ok: false; reason: string } {
    return this.transaction(() => this.createAcpSessionInTransaction(input));
  }

  private createAcpSessionInTransaction(input: {
    integrationCredential: string; requestId: string; projectId: string; sessionBinding: string;
    expectedHostInstance: string; currentHostInstance: string;
  }): { ok: true; session: RegisteredAcpSession } | { ok: false; reason: string } {
    const owner = this.findIntegrationOwner(input.integrationCredential);
    if (!owner) return { ok: false, reason: 'integration_authentication_required' };
    const integrationId = String(owner['integration_id']);
    const integrationGeneration = Number(owner['generation']);
    if (input.expectedHostInstance !== input.currentHostInstance) return { ok: false, reason: 'stale_host_instance' };
    if (!input.requestId || input.requestId.length > 128 || !input.sessionBinding) return { ok: false, reason: 'invalid_registration' };
    // Renewal labels are a disjoint namespace; a pruned renewal ID can never be
    // reused as an initial registration even after its ledger row is pruned.
    if (input.requestId.startsWith(RENEWAL_REQUEST_PREFIX)) return { ok: false, reason: 'invalid_registration' };
    const allowed = this.db.prepare('SELECT 1 FROM integration_projects WHERE integration_id=? AND project_id=?')
      .get(integrationId, input.projectId);
    if (!allowed) return { ok: false, reason: 'project_scope_denied' };
    const project = this.resolveProjectIdentity(input.projectId);
    if (!project) return { ok: false, reason: 'project_identity_changed' };

    const scope: IssuanceScope = {
      kind: 'registration', integrationId, principalId: '', requestId: input.requestId, requestSequence: null,
      expectedGeneration: 0, issuedGeneration: 0, projectId: project.projectId,
      projectGeneration: project.generation, projectIdentity: project.filesystemIdentity,
      integrationGeneration, hostInstanceId: input.currentHostInstance,
      sessionBinding: input.sessionBinding, expiresAtMs: 0,
    };
    const fingerprint = requestFingerprint(scope);

    const issuance = this.findIssuance(integrationId, input.requestId);
    if (issuance) {
      if (issuance['issuance_kind'] === LEGACY_V4_RESERVATION_KIND) {
        return { ok: false, reason: 'legacy_request_id_reserved' };
      }
      if (issuance['issuance_kind'] !== 'registration' || String(issuance['request_fingerprint']) !== fingerprint) {
        return { ok: false, reason: 'registration_fingerprint_conflict' };
      }
      return this.replayIssuance(input.integrationCredential, issuance, 'registration');
    }

    const principalId = randomUUID();
    const issuedGeneration = 1;
    const expiresAtMs = this.now() + ACP_SESSION_CREDENTIAL_TTL_MS;
    const record: IssuanceScope = { ...scope, principalId, issuedGeneration, expiresAtMs };
    const credential = deriveSessionCredential(input.integrationCredential, record);
    const credentialHash = digest(credential);
    const issuedAt = this.now();
    // The durable issuance is written before the principal: schema triggers
    // reject any credential write that is not backed by an issuance row.
    this.insertIssuance(record, fingerprint, credentialHash, issuedAt);
    this.db.prepare(`INSERT INTO acp_principals(principal_id,integration_id,request_id,request_fingerprint,project_id,
      session_binding,credential_hash,generation,project_generation,integration_generation,host_instance_id,expires_at,enabled)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(principalId, integrationId, input.requestId, fingerprint, input.projectId, input.sessionBinding,
        credentialHash, issuedGeneration, project.generation,
        integrationGeneration, input.currentHostInstance, expiresAtMs);
    return { ok: true, session: { principalId, sessionId: principalId, projectId: project.projectId,
      sessionBinding: input.sessionBinding, registrationGeneration: issuedGeneration,
      projectGeneration: project.generation, hostInstanceId: input.currentHostInstance, expiresAtMs, credential } };
  }

  private replayIssuance(
    ownerCredential: string,
    issuance: Record<string, unknown>,
    expectedKind: 'registration' | 'requalification',
  ): { ok: true; session: RegisteredAcpSession } | { ok: false; reason: string } {
    const kindPrefix = expectedKind === 'registration' ? 'registration' : 'requalification';
    const principalId = String(issuance['principal_id']);
    const principal = this.db.prepare(`SELECT enabled,generation,credential_hash,project_id,project_generation,
        integration_generation FROM acp_principals WHERE principal_id=? AND integration_id=?`)
      .get(principalId, String(issuance['integration_id'])) as Record<string, unknown> | undefined;
    if (!principal) return { ok: false, reason: `${kindPrefix}_replay_unavailable` };
    if (Number(principal['enabled']) !== 1) return { ok: false, reason: 'registration_revoked' };
    const issuedGeneration = Number(issuance['issued_generation']);
    if (Number(principal['generation']) !== issuedGeneration ||
        principal['project_id'] !== issuance['project_id'] ||
        Number(principal['project_generation']) !== Number(issuance['project_generation']) ||
        Number(principal['integration_generation']) !== Number(issuance['integration_generation'])) {
      return { ok: false, reason: `${kindPrefix}_superseded` };
    }
    const expiresAtMs = Number(issuance['expires_at']);
    if (expiresAtMs <= this.now()) return { ok: false, reason: `${kindPrefix}_expired` };
    if (String(issuance['credential_scheme']) !== ACP_SESSION_CREDENTIAL_SCHEME) {
      return { ok: false, reason: `${kindPrefix}_replay_unavailable` };
    }
    const scope: IssuanceScope = {
      kind: expectedKind,
      integrationId: String(issuance['integration_id']),
      principalId,
      requestId: String(issuance['request_id']),
      requestSequence: issuance['request_sequence'] === null || issuance['request_sequence'] === undefined
        ? null : Number(issuance['request_sequence']),
      expectedGeneration: Number(issuance['expected_generation']),
      issuedGeneration,
      projectId: String(issuance['project_id']),
      projectGeneration: Number(issuance['project_generation']),
      projectIdentity: String(issuance['project_identity']),
      integrationGeneration: Number(issuance['integration_generation']),
      hostInstanceId: String(issuance['host_instance_id']),
      sessionBinding: String(issuance['session_binding']),
      expiresAtMs,
    };
    const credential = deriveSessionCredential(ownerCredential, scope);
    if (!sameSecret(credential, String(issuance['credential_hash'])) ||
        !sameSecret(credential, String(principal['credential_hash']))) {
      return { ok: false, reason: `${kindPrefix}_replay_unavailable` };
    }
    return { ok: true, session: { principalId, sessionId: principalId, projectId: scope.projectId,
      sessionBinding: scope.sessionBinding, registrationGeneration: issuedGeneration,
      projectGeneration: scope.projectGeneration, hostInstanceId: scope.hostInstanceId,
      expiresAtMs, credential } };
  }

  authenticateAcpSession(credential: string, expectedHostInstance: string): Omit<RegisteredAcpSession, 'credential' | 'sessionId'> | null {
    const rows = this.db.prepare(`SELECT a.principal_id,a.project_id,a.session_binding,a.generation,a.project_generation,
        a.host_instance_id,a.credential_hash,a.expires_at,p.canonical_root,p.filesystem_dev,p.filesystem_ino
      FROM acp_principals a
      JOIN integrations i ON i.integration_id=a.integration_id AND i.enabled=1 AND i.generation=a.integration_generation
      JOIN integration_projects ip ON ip.integration_id=a.integration_id AND ip.project_id=a.project_id
      JOIN registered_projects p ON p.project_id=a.project_id AND p.enabled=1 AND p.generation=a.project_generation
      WHERE a.enabled=1 AND a.host_instance_id=? AND a.expires_at>?`).all(expectedHostInstance, this.now()) as Array<Record<string, unknown>>;
    const row = rows.find((item) => sameSecret(credential, String(item['credential_hash'])) &&
      this.resolveProject(String(item['project_id'])) !== null);
    return row ? { principalId: String(row['principal_id']), projectId: String(row['project_id']),
      sessionBinding: String(row['session_binding']), registrationGeneration: Number(row['generation']),
      projectGeneration: Number(row['project_generation']), hostInstanceId: String(row['host_instance_id']),
      expiresAtMs: Number(row['expires_at']) } : null;
  }

  createTransportSession(input: { acpCredential: string; projectId: string; expectedHostInstance: string }):
    { ok: true; sessionId: string; principal: Omit<RegisteredAcpSession, 'credential' | 'sessionId'> } |
    { ok: false; reason: string } {
    return this.transaction(() => {
      const principal = this.authenticateAcpSession(input.acpCredential, input.expectedHostInstance);
      if (!principal) return { ok: false, reason: 'acp_session_authentication_required' };
      if (principal.projectId !== input.projectId) return { ok: false, reason: 'project_scope_denied' };
      const existing = this.db.prepare(`SELECT session_id FROM integration_transport_sessions
        WHERE principal_id=? AND host_instance_id=? AND registration_generation=? AND enabled=1`)
        .get(principal.principalId, principal.hostInstanceId, principal.registrationGeneration) as { session_id: string } | undefined;
      if (existing) return { ok: true, sessionId: existing.session_id, principal };
      const sessionId = randomUUID();
      this.db.prepare(`INSERT INTO integration_transport_sessions(session_id,principal_id,project_id,
        registration_generation,project_generation,host_instance_id,enabled) VALUES(?,?,?,?,?,?,1)`)
        .run(sessionId, principal.principalId, principal.projectId, principal.registrationGeneration,
          principal.projectGeneration, principal.hostInstanceId);
      return { ok: true, sessionId, principal };
    });
  }

  resolveTransportSession(input: { sessionId: string; acpCredential: string; expectedHostInstance: string }):
    ({ transportSessionId: string } & Omit<RegisteredAcpSession, 'credential' | 'sessionId'>) | null {
    const principal = this.authenticateAcpSession(input.acpCredential, input.expectedHostInstance);
    if (!principal) return null;
    const row = this.db.prepare(`SELECT * FROM integration_transport_sessions WHERE session_id=? AND enabled=1`)
      .get(input.sessionId) as Record<string, unknown> | undefined;
    if (!row || row['principal_id'] !== principal.principalId || row['project_id'] !== principal.projectId ||
        Number(row['registration_generation']) !== principal.registrationGeneration ||
        Number(row['project_generation']) !== principal.projectGeneration || row['host_instance_id'] !== principal.hostInstanceId) return null;
    return { ...principal, transportSessionId: input.sessionId };
  }

  /**
   * Parent-authenticated, read-only reconciliation for a pending renewal. It
   * returns only the authoritative current generation and the disposition of
   * the specific sequenced issuance; it never issues or replays a credential.
   */
  inspectAcpSession(input: {
    integrationCredential: string; principalId: string; projectId: string; requestId: string;
    requestSequence: number; sessionBinding: string; expectedHostInstance: string; currentHostInstance: string;
  }): { ok: true; status: AcpSessionStatus } | { ok: false; reason: string } {
    return this.transaction(() => {
      const owner = this.findIntegrationOwner(input.integrationCredential);
      if (!owner) return { ok: false, reason: 'integration_authentication_required' };
      const integrationId = String(owner['integration_id']);
      const integrationGeneration = Number(owner['generation']);
      if (input.expectedHostInstance !== input.currentHostInstance) return { ok: false, reason: 'stale_host_instance' };
      if (!input.requestId || input.requestId.length > 128 || !isPositiveSafeInteger(input.requestSequence)) {
        return { ok: false, reason: 'invalid_requalification' };
      }
      if (input.requestId.startsWith(RENEWAL_REQUEST_PREFIX) &&
          input.requestId !== renewalRequestId(input.principalId, input.requestSequence)) {
        return { ok: false, reason: 'invalid_requalification' };
      }
      const row = this.db.prepare('SELECT * FROM acp_principals WHERE principal_id=? AND integration_id=?')
        .get(input.principalId, integrationId) as Record<string, unknown> | undefined;
      if (!row || row['session_binding'] !== input.sessionBinding) return { ok: false, reason: 'session_binding_denied' };
      if (row['project_id'] !== input.projectId) return { ok: false, reason: 'project_scope_denied' };
      const projectId = String(row['project_id']);
      const allowed = this.db.prepare('SELECT 1 FROM integration_projects WHERE integration_id=? AND project_id=?')
        .get(integrationId, projectId);
      if (!allowed) return { ok: false, reason: 'project_scope_denied' };
      const project = this.resolveProjectIdentity(projectId);
      if (!project || project.generation !== Number(row['project_generation']) ||
          integrationGeneration !== Number(row['integration_generation'])) {
        return { ok: false, reason: 'project_identity_changed' };
      }
      const generation = Number(row['generation']);
      const expiresAtMs = Number(row['expires_at']);
      const renewalSequence = Number(row['last_request_sequence'] ?? 0);
      // The reply must name the serving incarnation so a restarted client never
      // has to guess which host its next fenced requalification must target.
      const hostInstanceId = input.currentHostInstance;
      const status = (disposition: AcpSessionDisposition): { ok: true; status: AcpSessionStatus } => ({
        ok: true, status: { principalId: input.principalId, projectId, sessionBinding: input.sessionBinding,
          requestId: input.requestId, requestSequence: input.requestSequence, renewalSequence, hostInstanceId,
          registrationGeneration: generation, expiresAtMs, disposition },
      });
      if (Number(row['enabled']) !== 1) return status('revoked');
      const issuance = this.findIssuance(integrationId, input.requestId);
      if (!issuance) {
        // A sequence at/below the durable high-water was consumed; its row may
        // have been pruned after committing, so it is retired, not "not issued".
        return status(input.requestSequence <= renewalSequence ? 'retired' : 'not_issued');
      }
      if (String(issuance['principal_id']) !== input.principalId || issuance['project_id'] !== projectId ||
          issuance['session_binding'] !== input.sessionBinding) return status('not_issued');
      if (issuance['issuance_kind'] === LEGACY_V4_RESERVATION_KIND) return status('reserved');
      if (issuance['issuance_kind'] !== 'requalification') return status('not_issued');
      const issuanceSequence = issuance['request_sequence'];
      if (issuanceSequence !== null && issuanceSequence !== undefined &&
          Number(issuanceSequence) !== input.requestSequence) return status('not_issued');
      if (Number(issuance['integration_generation']) !== integrationGeneration) return status('superseded');
      const issuedGeneration = Number(issuance['issued_generation']);
      if (issuedGeneration < generation) return status('superseded');
      if (issuedGeneration > generation) return status('not_issued');
      if (expiresAtMs <= this.now()) return status('expired');
      return status('issued');
    });
  }

  requalifyAcpSession(input: {
    integrationCredential: string; principalId: string; requestId: string; requestSequence: number;
    sessionBinding: string; expectedRegistrationGeneration: number;
    expectedHostInstance: string; currentHostInstance: string;
  }): { ok: true; session: RegisteredAcpSession } | { ok: false; reason: string } {
    try {
      return this.transaction(() => this.requalifyAcpSessionInTransaction(input));
    } catch (error) {
      if (error instanceof RequalificationCasMissError) {
        return { ok: false, reason: 'stale_registration_generation' };
      }
      throw error;
    }
  }

  private requalifyAcpSessionInTransaction(input: {
    integrationCredential: string; principalId: string; requestId: string; requestSequence: number;
    sessionBinding: string; expectedRegistrationGeneration: number;
    expectedHostInstance: string; currentHostInstance: string;
  }): { ok: true; session: RegisteredAcpSession } | { ok: false; reason: string } {
    const owner = this.findIntegrationOwner(input.integrationCredential);
    if (!owner) return { ok: false, reason: 'integration_authentication_required' };
    const integrationId = String(owner['integration_id']);
    const integrationGeneration = Number(owner['generation']);
    if (input.expectedHostInstance !== input.currentHostInstance) return { ok: false, reason: 'stale_host_instance' };
    const row = this.db.prepare('SELECT * FROM acp_principals WHERE principal_id=? AND integration_id=?')
      .get(input.principalId, integrationId) as Record<string, unknown> | undefined;
    if (!row || row['session_binding'] !== input.sessionBinding) return { ok: false, reason: 'session_binding_denied' };
    if (Number(row['enabled']) !== 1) return { ok: false, reason: 'registration_revoked' };
    if (!isPositiveSafeInteger(input.expectedRegistrationGeneration) || !isPositiveSafeInteger(input.requestSequence)) {
      return { ok: false, reason: 'invalid_requalification' };
    }
    if (!input.requestId || input.requestId.length > 128) return { ok: false, reason: 'invalid_requalification' };
    // Still-recorded legacy tombstones are classified before the canonical-label
    // fence so a v4 ID is reserved on the renewal route as well as registration.
    const existingIssuance = this.findIssuance(integrationId, input.requestId);
    if (existingIssuance && existingIssuance['issuance_kind'] === LEGACY_V4_RESERVATION_KIND) {
      return { ok: false, reason: 'legacy_request_id_reserved' };
    }
    // The renewal label is canonically derived from this principal and sequence,
    // so a pruned renewal label cannot be relabeled under another sequence or
    // principal, and a registration label cannot be used on this route.
    if (input.requestId !== renewalRequestId(input.principalId, input.requestSequence)) {
      return { ok: false, reason: 'invalid_requalification' };
    }
    const currentGeneration = Number(row['generation']);
    const lastRequestSequence = Number(row['last_request_sequence'] ?? 0);
    const projectId = String(row['project_id']);
    const allowed = this.db.prepare('SELECT 1 FROM integration_projects WHERE integration_id=? AND project_id=?')
      .get(integrationId, projectId);
    if (!allowed) return { ok: false, reason: 'project_scope_denied' };
    const project = this.resolveProjectIdentity(projectId);
    if (!project || project.generation !== Number(row['project_generation']) ||
        integrationGeneration !== Number(row['integration_generation'])) {
      return { ok: false, reason: 'project_identity_changed' };
    }

    const scope: IssuanceScope = {
      kind: 'requalification', integrationId, principalId: input.principalId, requestId: input.requestId,
      requestSequence: input.requestSequence, expectedGeneration: input.expectedRegistrationGeneration,
      issuedGeneration: currentGeneration + 1, projectId,
      projectGeneration: project.generation, projectIdentity: project.filesystemIdentity,
      integrationGeneration, hostInstanceId: input.currentHostInstance,
      sessionBinding: input.sessionBinding, expiresAtMs: 0,
    };
    const fingerprint = requestFingerprint(scope);

    const issuance = existingIssuance;
    if (issuance) {
      if (issuance['issuance_kind'] !== 'requalification' ||
          String(issuance['request_fingerprint']) !== fingerprint ||
          Number(issuance['expected_generation']) !== input.expectedRegistrationGeneration ||
          Number(issuance['request_sequence']) !== input.requestSequence) {
        return { ok: false, reason: 'requalification_fingerprint_conflict' };
      }
      return this.replayIssuance(input.integrationCredential, issuance, 'requalification');
    }

    if (currentGeneration >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, reason: 'registration_generation_exhausted' };
    }
    if (input.expectedRegistrationGeneration < currentGeneration) {
      return { ok: false, reason: 'stale_registration_generation' };
    }
    if (input.expectedRegistrationGeneration > currentGeneration) {
      return { ok: false, reason: 'registration_generation_conflict' };
    }
    if (lastRequestSequence >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, reason: 'request_sequence_exhausted' };
    }
    if (input.requestSequence <= lastRequestSequence) {
      return { ok: false, reason: 'request_sequence_retired' };
    }
    const record: IssuanceScope = { ...scope, expiresAtMs: this.now() + ACP_SESSION_CREDENTIAL_TTL_MS };
    const credential = deriveSessionCredential(input.integrationCredential, record);
    const credentialHash = digest(credential);
    // Write the issuance before the credential mutation so the schema guard can
    // prove the rotation is backed by durable request metadata.
    this.insertIssuance(record, fingerprint, credentialHash, this.now());
    // BEGIN IMMEDIATE serializes writers; this explicit CAS verifies the observed
    // generation (and grants) and fails closed if that invariant is ever violated.
    const update = this.db.prepare(`UPDATE acp_principals SET credential_hash=?,generation=?,host_instance_id=?,
      expires_at=?,last_request_sequence=?,last_requalification_request_id=?,last_requalification_fingerprint=?
      WHERE principal_id=? AND generation=? AND enabled=1 AND integration_generation=? AND project_generation=?`)
      .run(credentialHash, record.issuedGeneration, input.currentHostInstance, record.expiresAtMs,
        input.requestSequence, input.requestId, fingerprint, input.principalId, currentGeneration,
        integrationGeneration, project.generation);
    // Throwing (instead of returning inside the transaction) rolls back the
    // admission row, so a failed CAS can never commit a false issuance.
    if (Number(update.changes) !== 1) throw new RequalificationCasMissError();
    this.db.prepare(`DELETE FROM acp_session_issuances WHERE principal_id=? AND issuance_kind='requalification'
      AND request_sequence IS NOT NULL AND request_sequence<=?`)
      .run(input.principalId, input.requestSequence - ACP_SESSION_RENEWAL_HISTORY);
    return { ok: true, session: { principalId: input.principalId, sessionId: input.principalId, projectId,
      sessionBinding: input.sessionBinding, registrationGeneration: record.issuedGeneration,
      projectGeneration: project.generation, hostInstanceId: input.currentHostInstance,
      expiresAtMs: record.expiresAtMs, credential } };
  }

  revokeAcpSession(principalId: string): void {
    this.db.prepare('UPDATE acp_principals SET enabled=0,generation=generation+1 WHERE principal_id=?').run(principalId);
  }

  close(): void { this.db.close(); }

  private findIntegrationOwner(credential: string): Record<string, unknown> | undefined {
    const owners = this.db.prepare('SELECT integration_id,credential_hash,generation FROM integrations WHERE enabled=1')
      .all() as Array<Record<string, unknown>>;
    return owners.find((row) => sameSecret(credential, String(row['credential_hash'])));
  }

  private findIssuance(integrationId: string, requestId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM acp_session_issuances WHERE integration_id=? AND request_id=?')
      .get(integrationId, requestId) as Record<string, unknown> | undefined;
  }

  private insertIssuance(scope: IssuanceScope, fingerprint: string, credentialHash: string,
    issuedAt: number): void {
    this.db.prepare(`INSERT INTO acp_session_issuances(integration_id,request_id,principal_id,issuance_kind,
      request_sequence,expected_generation,issued_generation,project_id,project_generation,project_identity,
      integration_generation,host_instance_id,session_binding,request_fingerprint,credential_scheme,
      credential_hash,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(scope.integrationId, scope.requestId, scope.principalId, scope.kind, scope.requestSequence,
        scope.expectedGeneration, scope.issuedGeneration, scope.projectId, scope.projectGeneration,
        scope.projectIdentity, scope.integrationGeneration, scope.hostInstanceId, scope.sessionBinding,
        fingerprint, ACP_SESSION_CREDENTIAL_SCHEME, credentialHash, issuedAt, scope.expiresAtMs);
  }

  /**
   * `BEGIN IMMEDIATE` takes the write lock before any read, so admissions,
   * reconciliation, and schema initialization serialize across connections.
   * Credential UPDATEs additionally carry an explicit generation/grant CAS.
   */
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
