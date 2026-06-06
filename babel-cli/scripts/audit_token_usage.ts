import { runTokenUsageAudit } from '../src/audit/tokenUsage.js';

const result = runTokenUsageAudit();

process.stdout.write(`${JSON.stringify({
  generated_at: result.summary.generatedAt,
  tokenizer_encoding: result.summary.tokenizerEncoding,
  active_skill_count: result.summary.activeSkillCount,
  active_domain_count: result.summary.activeDomainCount,
  scenario_count: result.summary.scenarioCount,
  success_count: result.summary.successCount,
  failure_count: result.summary.failureCount,
  actual_policy_miss_count: result.summary.actualPolicyMissCount,
  missing_budget_scenario_count: result.summary.missingBudgetScenarioCount,
  run_dir: result.runDir,
  markdown_path: result.markdownPath,
  latest_markdown_path: result.latestMarkdownPath,
  latest_json_path: result.latestJsonPath,
}, null, 2)}\n`);
