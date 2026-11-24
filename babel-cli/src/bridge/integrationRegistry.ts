import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

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
  credential: string;
}

/** Durable owner-provisioned project and scoped ACP principal registry. */
export class IntegrationRegistry {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, protectDirectory: (directory: string) => void) {
    protectDirectory(dirname(resolve(databasePath)));
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;');
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
        last_requalification_request_id TEXT, last_requalification_fingerprint TEXT, enabled INTEGER NOT NULL,
        UNIQUE(integration_id, request_id)
      );
    `);
    const principalColumns = new Set((this.db.prepare('PRAGMA table_info(acp_principals)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!principalColumns.has('host_instance_id')) {
      this.db.exec("ALTER TABLE acp_principals ADD COLUMN host_instance_id TEXT NOT NULL DEFAULT ''");
      this.db.exec("UPDATE acp_principals SET enabled=0 WHERE host_instance_id=''");
    }
    if (!principalColumns.has('last_requalification_request_id')) {
      this.db.exec('ALTER TABLE acp_principals ADD COLUMN last_requalification_request_id TEXT');
    }
    if (!principalColumns.has('last_requalification_fingerprint')) {
      this.db.exec('ALTER TABLE acp_principals ADD COLUMN last_requalification_fingerprint TEXT');
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
    this.db.exec('PRAGMA user_version=3');
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
    const row = this.db.prepare(`SELECT canonical_root,generation,filesystem_dev,filesystem_ino
      FROM registered_projects WHERE project_id=? AND enabled=1`).get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const root = String(row['canonical_root']);
    try {
      if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) return null;
      const actual = statSync(root, { bigint: true });
      if (!actual.isDirectory() || actual.dev === 0n || actual.ino === 0n ||
          String(actual.dev) !== row['filesystem_dev'] || String(actual.ino) !== row['filesystem_ino']) return null;
    } catch {
      return null;
    }
    return { projectId, canonicalRoot: root, generation: Number(row['generation']) };
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
    const integration = this.db.prepare('SELECT integration_id,credential_hash,generation FROM integrations WHERE enabled=1').all() as Array<Record<string, unknown>>;
    const owner = integration.find((row) => sameSecret(input.integrationCredential, String(row['credential_hash'])));
    if (!owner) return { ok: false, reason: 'integration_authentication_required' };
    const integrationId = String(owner['integration_id']);
    if (input.expectedHostInstance !== input.currentHostInstance) return { ok: false, reason: 'stale_host_instance' };
    if (!input.requestId || !input.sessionBinding) return { ok: false, reason: 'invalid_registration' };
    const allowed = this.db.prepare('SELECT 1 FROM integration_projects WHERE integration_id=? AND project_id=?')
      .get(integrationId, input.projectId);
    const project = this.db.prepare('SELECT generation FROM registered_projects WHERE project_id=? AND enabled=1').get(input.projectId) as { generation: number } | undefined;
    if (!allowed || !project) return { ok: false, reason: 'project_scope_denied' };
    const fingerprint = digest(JSON.stringify({ projectId: input.projectId, projectGeneration: project.generation,
      hostInstanceId: input.currentHostInstance,
      integrationGeneration: owner['generation'], sessionBinding: input.sessionBinding }));
    const prior = this.db.prepare(`SELECT * FROM acp_principals WHERE integration_id=? AND request_id=?`)
      .get(integrationId, input.requestId) as Record<string, unknown> | undefined;
    if (prior && (prior['request_fingerprint'] !== fingerprint || prior['project_id'] !== input.projectId)) {
      return { ok: false, reason: 'registration_fingerprint_conflict' };
    }
    const credential = randomBytes(32).toString('base64url');
    const principalId = prior ? String(prior['principal_id']) : randomUUID();
    const generation = prior ? Number(prior['generation']) + 1 : 1;
    this.db.prepare(`INSERT INTO acp_principals(principal_id,integration_id,request_id,request_fingerprint,project_id,
      session_binding,credential_hash,generation,project_generation,integration_generation,host_instance_id,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(principal_id) DO UPDATE SET credential_hash=excluded.credential_hash,generation=excluded.generation,
      project_generation=excluded.project_generation,integration_generation=excluded.integration_generation,
      host_instance_id=excluded.host_instance_id,enabled=1`)
      .run(principalId, integrationId, input.requestId, fingerprint, input.projectId,
        input.sessionBinding, digest(credential), generation, project.generation, Number(owner['generation']), input.currentHostInstance);
    return { ok: true, session: { principalId, sessionId: principalId, projectId: input.projectId,
      sessionBinding: input.sessionBinding, registrationGeneration: generation, projectGeneration: project.generation,
      hostInstanceId: input.currentHostInstance, credential } };
  }

  authenticateAcpSession(credential: string, expectedHostInstance: string): Omit<RegisteredAcpSession, 'credential' | 'sessionId'> | null {
    const rows = this.db.prepare(`SELECT a.principal_id,a.project_id,a.session_binding,a.generation,a.project_generation,
        a.host_instance_id,a.credential_hash,p.canonical_root,p.filesystem_dev,p.filesystem_ino
      FROM acp_principals a
      JOIN integrations i ON i.integration_id=a.integration_id AND i.enabled=1 AND i.generation=a.integration_generation
      JOIN integration_projects ip ON ip.integration_id=a.integration_id AND ip.project_id=a.project_id
      JOIN registered_projects p ON p.project_id=a.project_id AND p.enabled=1 AND p.generation=a.project_generation
      WHERE a.enabled=1 AND a.host_instance_id=?`).all(expectedHostInstance) as Array<Record<string, unknown>>;
    const row = rows.find((item) => sameSecret(credential, String(item['credential_hash'])) &&
      this.resolveProject(String(item['project_id'])) !== null);
    return row ? { principalId: String(row['principal_id']), projectId: String(row['project_id']),
      sessionBinding: String(row['session_binding']), registrationGeneration: Number(row['generation']),
      projectGeneration: Number(row['project_generation']), hostInstanceId: String(row['host_instance_id']) } : null;
  }

  requalifyAcpSession(input: {
    integrationCredential: string; principalId: string; requestId: string; sessionBinding: string;
    expectedHostInstance: string; currentHostInstance: string;
  }): { ok: true; session: RegisteredAcpSession } | { ok: false; reason: string } {
    return this.transaction(() => {
      const owners = this.db.prepare('SELECT integration_id,credential_hash,generation FROM integrations WHERE enabled=1').all() as Array<Record<string, unknown>>;
      const owner = owners.find((row) => sameSecret(input.integrationCredential, String(row['credential_hash'])));
      if (!owner) return { ok: false, reason: 'integration_authentication_required' };
      const integrationId = String(owner['integration_id']);
      if (input.expectedHostInstance !== input.currentHostInstance) return { ok: false, reason: 'stale_host_instance' };
      const row = this.db.prepare('SELECT * FROM acp_principals WHERE principal_id=? AND integration_id=? AND enabled=1')
        .get(input.principalId, integrationId) as Record<string, unknown> | undefined;
      if (!row || row['session_binding'] !== input.sessionBinding) return { ok: false, reason: 'session_binding_denied' };
      const projectId = String(row['project_id']);
      const project = this.db.prepare(`SELECT p.generation FROM registered_projects p
        JOIN integration_projects ip ON ip.project_id=p.project_id AND ip.integration_id=?
        WHERE p.project_id=? AND p.enabled=1`).get(integrationId, projectId) as { generation: number } | undefined;
      if (!project || project.generation !== Number(row['project_generation']) ||
          Number(owner['generation']) !== Number(row['integration_generation'])) {
        return { ok: false, reason: 'project_identity_changed' };
      }
      if (!this.resolveProject(projectId)) return { ok: false, reason: 'project_identity_changed' };
      if (!input.requestId || input.requestId.length > 128) return { ok: false, reason: 'invalid_requalification' };
      const fingerprint = digest(JSON.stringify({ principalId: input.principalId, projectId, projectGeneration: project.generation,
        integrationGeneration: owner['generation'], sessionBinding: input.sessionBinding,
        hostInstanceId: input.currentHostInstance }));
      if (row['host_instance_id'] === input.currentHostInstance &&
          (row['last_requalification_request_id'] !== input.requestId || row['last_requalification_fingerprint'] !== fingerprint)) {
        return { ok: false, reason: 'requalification_already_current' };
      }
      if (row['last_requalification_request_id'] === input.requestId && row['last_requalification_fingerprint'] !== fingerprint) {
        return { ok: false, reason: 'requalification_fingerprint_conflict' };
      }
      const credential = randomBytes(32).toString('base64url');
      const generation = Number(row['generation']) + 1;
      this.db.prepare(`UPDATE acp_principals SET credential_hash=?,generation=?,host_instance_id=?,
        last_requalification_request_id=?,last_requalification_fingerprint=? WHERE principal_id=?`)
        .run(digest(credential), generation, input.currentHostInstance, input.requestId, fingerprint, input.principalId);
      return { ok: true, session: { principalId: input.principalId, sessionId: input.principalId, projectId,
        sessionBinding: input.sessionBinding, registrationGeneration: generation, projectGeneration: project.generation,
        hostInstanceId: input.currentHostInstance, credential } };
    });
  }

  revokeAcpSession(principalId: string): void {
    this.db.prepare('UPDATE acp_principals SET enabled=0,generation=generation+1 WHERE principal_id=?').run(principalId);
  }

  close(): void { this.db.close(); }

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
