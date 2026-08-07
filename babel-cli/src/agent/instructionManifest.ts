/**
 * InstructionManifestV1 — H2 policy-bound instruction authority.
 *
 * Evolves the path-list prompt_manifest / ChatCompiledStack into a durable
 * rule-ID + source-hash manifest that survives compaction, failover, handoff,
 * and resume. Does not replace catalog stackResolver; wraps its outputs with
 * provenance suitable for LiveSession projection.
 */

import { createHash } from 'node:crypto';
import type { ChatCompiledStack, ChatStackEntry } from './chatStackCompile.js';

export const INSTRUCTION_MANIFEST_VERSION = 1 as const;

export type InstructionFragmentScope =
  | 'session'
  | 'turn'
  | 'plan_step'
  | 'tool'
  | 'global';

export type InstructionPrecedence =
  | 'identity'
  | 'project'
  | 'domain'
  | 'skill'
  | 'safety'
  | 'provider'
  | 'verifier'
  | 'policy'
  | 'task';

export interface InstructionFragmentV1 {
  /** Stable rule / fragment id. */
  rule_id: string;
  /** Source path or synthetic id. */
  source: string;
  /** sha256 of authoritative source content (or content hash when inline). */
  source_hash: string;
  /** Layer / precedence class. */
  precedence: InstructionPrecedence;
  /** Scope of applicability. */
  scope: InstructionFragmentScope;
  /** Why this fragment was selected. */
  selection_reason: string;
  /** Optional plan-step binding. */
  plan_step_id?: string;
  /** Optional content preview (not authoritative). */
  content_preview?: string;
  /** Advisory vs mechanically enforceable. */
  policy_class: 'mechanical' | 'verifier' | 'advisory';
}

export interface InstructionManifestV1 {
  schema_version: typeof INSTRUCTION_MANIFEST_VERSION;
  /** Immutable identity of this resolved manifest. */
  manifest_id: string;
  /** Aggregate hash of all fragment source_hashes (ordered by rule_id). */
  manifest_hash: string;
  fragments: InstructionFragmentV1[];
  /** Mode that resolved this manifest. */
  mode: 'chat' | 'plan' | 'deep' | string;
  /** Task class when known. */
  task_class?: string;
  created_at: string;
}

export interface BuildInstructionManifestInput {
  mode: InstructionManifestV1['mode'];
  taskClass?: string;
  /** From compileChatStack. */
  chatStack?: ChatCompiledStack;
  /** Path-list prompt_manifest from catalog resolver. */
  promptManifestPaths?: readonly string[];
  /** Optional inline rules with content for hashing. */
  inlineRules?: ReadonlyArray<{
    rule_id: string;
    source: string;
    content: string;
    precedence: InstructionPrecedence;
    scope?: InstructionFragmentScope;
    selection_reason: string;
    plan_step_id?: string;
    policy_class?: InstructionFragmentV1['policy_class'];
  }>;
  /** Optional path → content map for hashing disk paths. */
  pathContents?: ReadonlyMap<string, string> | Record<string, string>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Validate the structural identity of a persisted instruction manifest. */
export function validateInstructionManifestV1(value: InstructionManifestV1): string[] {
  const errors: string[] = []
  if (value.schema_version !== INSTRUCTION_MANIFEST_VERSION) errors.push('schema_version')
  if (!Array.isArray(value.fragments) || value.fragments.length === 0) errors.push('fragments')
  const computed = sha256(
    [...(value.fragments ?? [])]
      .sort((a, b) => a.rule_id.localeCompare(b.rule_id))
      .map((fragment) => `${fragment.rule_id}:${fragment.source_hash}`)
      .join('\n'),
  ).slice(0, 32)
  if (value.manifest_hash !== computed) errors.push('manifest_hash')
  if (value.manifest_id !== `im1:${computed}`) errors.push('manifest_id')
  return errors
}

function layerToPrecedence(layer: ChatStackEntry['layer']): InstructionPrecedence {
  return layer;
}

function defaultPolicyClass(
  precedence: InstructionPrecedence,
): InstructionFragmentV1['policy_class'] {
  if (precedence === 'safety' || precedence === 'verifier') return 'mechanical';
  if (precedence === 'domain' || precedence === 'skill') return 'advisory';
  return 'advisory';
}

function getPathContent(
  path: string,
  pathContents?: BuildInstructionManifestInput['pathContents'],
): string | undefined {
  if (!pathContents) return undefined;
  if (pathContents instanceof Map) return pathContents.get(path);
  return (pathContents as Record<string, string>)[path];
}

/**
 * Build InstructionManifestV1 from chat stack and/or catalog prompt paths.
 */
export function buildInstructionManifestV1(
  input: BuildInstructionManifestInput,
): InstructionManifestV1 {
  const fragments: InstructionFragmentV1[] = [];

  if (input.chatStack) {
    for (const entry of input.chatStack.selected_entries) {
      const content =
        getPathContent(entry.path, input.pathContents) ??
        entry.contentPreview ??
        entry.path;
      const precedence = layerToPrecedence(entry.layer);
      fragments.push({
        rule_id: entry.id,
        source: entry.path,
        source_hash: sha256(content),
        precedence,
        scope: 'session',
        selection_reason: `chat_stack:${entry.layer}`,
        policy_class: defaultPolicyClass(precedence),
        ...(entry.contentPreview
          ? { content_preview: entry.contentPreview.slice(0, 200) }
          : {}),
      });
    }
  }

  if (input.promptManifestPaths) {
    for (const p of input.promptManifestPaths) {
      const already = fragments.some((f) => f.source === p);
      if (already) continue;
      const content = getPathContent(p, input.pathContents) ?? p;
      fragments.push({
        rule_id: `prompt:${p}`,
        source: p,
        source_hash: sha256(content),
        precedence: 'policy',
        scope: 'session',
        selection_reason: 'catalog_prompt_manifest',
        policy_class: 'advisory',
      });
    }
  }

  if (input.inlineRules) {
    for (const r of input.inlineRules) {
      fragments.push({
        rule_id: r.rule_id,
        source: r.source,
        source_hash: sha256(r.content),
        precedence: r.precedence,
        scope: r.scope ?? 'session',
        selection_reason: r.selection_reason,
        policy_class: r.policy_class ?? defaultPolicyClass(r.precedence),
        ...(r.plan_step_id ? { plan_step_id: r.plan_step_id } : {}),
        content_preview: r.content.slice(0, 200),
      });
    }
  }

  fragments.sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  const manifest_hash = sha256(
    fragments.map((f) => `${f.rule_id}:${f.source_hash}`).join('\n'),
  ).slice(0, 32);
  const manifest_id = `im1:${manifest_hash}`;

  return {
    schema_version: INSTRUCTION_MANIFEST_VERSION,
    manifest_id,
    manifest_hash,
    fragments,
    mode: input.mode,
    ...(input.taskClass ? { task_class: input.taskClass } : {}),
    created_at: new Date().toISOString(),
  };
}

/** True when two manifests are authority-equivalent (same hashes). */
export function instructionManifestsEqual(
  a: InstructionManifestV1,
  b: InstructionManifestV1,
): boolean {
  return a.manifest_hash === b.manifest_hash && a.manifest_id === b.manifest_id;
}

/**
 * Bind a fragment rule_id to a plan step (returns new manifest; does not mutate).
 */
export function bindFragmentToPlanStep(
  manifest: InstructionManifestV1,
  ruleId: string,
  planStepId: string,
): InstructionManifestV1 {
  const fragments = manifest.fragments.map((f) =>
    f.rule_id === ruleId ? { ...f, plan_step_id: planStepId, scope: 'plan_step' as const } : f,
  );
  const manifest_hash = sha256(
    fragments.map((f) => `${f.rule_id}:${f.source_hash}:${f.plan_step_id ?? ''}`).join('\n'),
  ).slice(0, 32);
  return {
    ...manifest,
    fragments,
    manifest_hash,
    manifest_id: `im1:${manifest_hash}`,
  };
}

/** Lookup fragment by rule id. */
export function getFragment(
  manifest: InstructionManifestV1,
  ruleId: string,
): InstructionFragmentV1 | undefined {
  return manifest.fragments.find((f) => f.rule_id === ruleId);
}
