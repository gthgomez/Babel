import { Command } from 'commander';

/** Worktree lifecycle plus governed child-worktree adoption. */
export function registerWorktreeCommands(program: Command): void {
  program
    .command('worktree')
    .description('Manage git worktree isolation for safe parallel work')
    .addCommand(
      new Command('create')
        .description('Create an isolated git worktree')
        .argument('<name>', 'Worktree name')
        .option('--project-root <path>', 'Project root', process.cwd())
        .option('--branch <name>', 'Branch name (default: babel-worktree-<name>)')
        .option('--detach', 'Detach HEAD (no branch)')
        .action(async (name, options) => {
          const { createWorktree } = await import('../services/worktreeIsolation.js');
          try {
            const info = createWorktree(name, {
              projectRoot: options.projectRoot,
              branch: options.branch,
              detach: options.detach,
            });
            console.log(JSON.stringify(info, null, 2));
          } catch (error: any) {
            console.error(`Worktree create failed: ${error.message}`);
            process.exitCode = 1;
          }
        }),
    )
    .addCommand(
      new Command('enter')
        .description('Enter an existing worktree (sets BABEL_WORKTREE_ROOT)')
        .argument('<name>', 'Worktree name')
        .option('--project-root <path>', 'Project root', process.cwd())
        .action(async (name, options) => {
          const { enterWorktree } = await import('../services/worktreeIsolation.js');
          try {
            enterWorktree(name, options.projectRoot);
            const root = process.env['BABEL_WORKTREE_ROOT'];
            console.log(`Entered worktree "${name}" at ${root}`);
          } catch (error: any) {
            console.error(`Worktree enter failed: ${error.message}`);
            process.exitCode = 1;
          }
        }),
    )
    .addCommand(
      new Command('exit')
        .description('Exit the active worktree (clears BABEL_WORKTREE_ROOT)')
        .action(async () => {
          const { exitWorktree, getActiveWorktreeRoot } =
            await import('../services/worktreeIsolation.js');
          const root = getActiveWorktreeRoot();
          exitWorktree();
          console.log(root ? `Exited worktree at ${root}` : 'No active worktree.');
        }),
    )
    .addCommand(
      new Command('list')
        .description('List all git worktrees')
        .option('--project-root <path>', 'Project root', process.cwd())
        .action(async (options) => {
          const { listWorktrees, getActiveWorktreeRoot } =
            await import('../services/worktreeIsolation.js');
          const entries = listWorktrees(options.projectRoot);
          if (entries.length === 0) {
            console.log('No worktrees found.');
            return;
          }
          const active = getActiveWorktreeRoot();
          for (const entry of entries) {
            const marker = entry.active ? ' *' : '  ';
            const head = entry.detached ? `(detached: ${entry.branch.slice(0, 8)})` : entry.branch;
            console.log(`${marker} ${entry.name}  ${head}  ${entry.path}`);
          }
          if (!active) {
            console.log('\n  No active worktree session.');
          }
        }),
    )
    .addCommand(
      new Command('remove')
        .description('Remove a worktree and its branch')
        .argument('<name>', 'Worktree name')
        .option('--project-root <path>', 'Project root', process.cwd())
        .option('--force', 'Force removal of dirty worktree')
        .action(async (name, options) => {
          const { removeWorktree } = await import('../services/worktreeIsolation.js');
          try {
            removeWorktree(name, {
              projectRoot: options.projectRoot,
              force: options.force,
            });
            console.log(`Removed worktree "${name}".`);
          } catch (error: any) {
            console.error(`Worktree remove failed: ${error.message}`);
            process.exitCode = 1;
          }
        }),
    )
    .addCommand(
      new Command('adopt')
        .description('Adopt recorded child-worktree changes into the parent (dry run by default)')
        .argument('<name>', 'Worktree name recorded in the child manifest')
        .requiredOption('--manifest <path>', 'Path to child-adoption-manifest.json from the child run')
        .option('--project-root <path>', 'Parent project root', process.cwd())
        .option('--apply', 'Write the adopted changes into the parent (default: dry run)')
        .option('--allow-advanced-base', 'Allow adoption when the parent advanced past the child base')
        .option('--verify <command>', 'Parent-side verification command (shell) run after adoption')
        .option('--cleanup', 'Remove the worktree only after a fully adopted result (and verification when supplied)')
        .action(async (name, options) => {
          const { readFileSync } = await import('node:fs');
          const { spawnSync } = await import('node:child_process');
          const { promoteImplementWorktree } = await import('../agent/implementWorktreeAgent.js');
          try {
            const raw = JSON.parse(readFileSync(options.manifest, 'utf-8')) as {
              artifact_type?: string;
              schema_version?: number;
              worktree_name?: string;
              worktree_path?: string;
              base_sha?: string | null;
              write_scope?: string[];
              changed_files?: Array<{ path: string; before_hash: string | null; after_hash: string | null }>;
            };
            if (
              raw.artifact_type !== 'babel_child_adoption_manifest' ||
              raw.schema_version !== 1 ||
              typeof raw.worktree_name !== 'string' ||
              typeof raw.worktree_path !== 'string' ||
              !Array.isArray(raw.write_scope) ||
              !Array.isArray(raw.changed_files)
            ) {
              throw new Error('Invalid child adoption manifest');
            }
            if (raw.worktree_name !== name) {
              throw new Error(`Manifest belongs to worktree "${raw.worktree_name}", not "${name}".`);
            }
            const projectRoot = options.projectRoot as string;
            const result = promoteImplementWorktree({
              projectRoot,
              worktreePath: raw.worktree_path,
              worktreeName: raw.worktree_name,
              writeScope: raw.write_scope,
              ...(raw.base_sha ? { baseSha: raw.base_sha } : {}),
              expectedChanges: raw.changed_files,
              mode: options.apply ? 'copy' : 'dry_run',
              cleanupWorktree: options.cleanup === true,
              allowAdvancedBase: options.allowAdvancedBase === true,
              ...(typeof options.verify === 'string'
                ? {
                    verify: () => {
                      const check = spawnSync(options.verify as string, {
                        cwd: projectRoot,
                        encoding: 'utf-8',
                        shell: true,
                        timeout: 300_000,
                      });
                      return {
                        ok: check.status === 0,
                        summary: `verify exit ${check.status ?? 'missing'}`,
                        diagnostics: [{
                          code: 'parent_verifier',
                          message: `${(check.stdout ?? '').slice(-500)}${(check.stderr ?? '').slice(-500)}`,
                        }],
                      };
                    },
                  }
                : {}),
            });
            console.log(JSON.stringify(result, null, 2));
            if (!result.success) process.exitCode = 1;
          } catch (error: any) {
            console.error(`Worktree adopt failed: ${error.message}`);
            process.exitCode = 1;
          }
        }),
    );
}
