import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync, statSync } from 'node:fs';
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
        project_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, enabled INTEGER NOT NULL
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
        integration_generation INTEGER NOT NULL, enabled INTEGER NOT NULL,
        UNIQUE(integration_id, request_id)
      );
    `);
  }

  registerProject(input: { projectId: string; root: string }): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.projectId)) throw new Error('invalid project ID');
    const root = realpathSync(resolve(input.root));
    if (!statSync(root).isDirectory()) throw new Error('registered project root is not a directory');
    const projects = this.db.prepare('SELECT project_id,canonical_root FROM registered_projects WHERE enabled=1').all() as Array<Record<string, unknown>>;
    for (const project of projects) {
      const previous = String(project['canonical_root']);
      if (project['project_id'] === input.projectId) continue;
      if (contained(previous, root) || contained(root, previous)) throw new Error('registered project roots must be disjoint');
    }
    this.transaction(() => this.db.prepare(`INSERT INTO registered_projects(project_id,canonical_root,generation,enabled)
      VALUES(?,?,1,1) ON CONFLICT(project_id) DO UPDATE SET canonical_root=excluded.canonical_root,
      generation=registered_projects.generation+1,enabled=1`).run(input.projectId, root));
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
      session_binding,credential_hash,generation,project_generation,integration_generation,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(principal_id) DO UPDATE SET credential_hash=excluded.credential_hash,generation=excluded.generation,
      project_generation=excluded.project_generation,integration_generation=excluded.integration_generation,enabled=1`)
      .run(principalId, integrationId, input.requestId, fingerprint, input.projectId,
        input.sessionBinding, digest(credential), generation, project.generation, Number(owner['generation']));
    return { ok: true, session: { principalId, sessionId: principalId, projectId: input.projectId,
      sessionBinding: input.sessionBinding, registrationGeneration: generation, credential } };
  }

  authenticateAcpSession(credential: string): Omit<RegisteredAcpSession, 'credential' | 'sessionId'> | null {
    const rows = this.db.prepare(`SELECT a.principal_id,a.project_id,a.session_binding,a.generation,a.credential_hash
      FROM acp_principals a
      JOIN integrations i ON i.integration_id=a.integration_id AND i.enabled=1 AND i.generation=a.integration_generation
      JOIN integration_projects ip ON ip.integration_id=a.integration_id AND ip.project_id=a.project_id
      JOIN registered_projects p ON p.project_id=a.project_id AND p.enabled=1 AND p.generation=a.project_generation
      WHERE a.enabled=1`).all() as Array<Record<string, unknown>>;
    const row = rows.find((item) => sameSecret(credential, String(item['credential_hash'])));
    return row ? { principalId: String(row['principal_id']), projectId: String(row['project_id']),
      sessionBinding: String(row['session_binding']), registrationGeneration: Number(row['generation']) } : null;
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
