import { collectCandidateEnvelope } from './candidateCollector.js';

async function main() {
  const args = process.argv.slice(2);
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--staged' || arg === '--json') {
      options[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      const val = args[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = val;
    }
  }

  const envelope = await collectCandidateEnvelope({
    repoRoot: options['repo-root'] as string | undefined,
    pr: options['pr'] ? Number(options['pr']) : undefined,
    base: options['base'] as string | undefined,
    head: options['head'] as string | undefined,
    staged: Boolean(options['staged']),
    path: options['path'] as string | undefined,
    range: options['range'] as string | undefined,
    task: options['task'] as string | undefined,
    taskId: options['task-id'] as string | undefined,
  });

  if (options['json'] || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stdout.write(`Candidate: ${envelope.repository}\n`);
    process.stdout.write(`Digest: ${envelope.candidate_digest}\n`);
    process.stdout.write(`Risk tier: ${envelope.risk_tier}\n`);
    process.stdout.write(`Trust mode: ${envelope.trust_mode}\n`);
    process.stdout.write(`Scope (${envelope.scope.length} files):\n`);
    for (const f of envelope.scope) process.stdout.write(`  - ${f}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
