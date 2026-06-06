import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { OrchestratorManifest, SwePlan, QaVerdict } from './schemas/agentContracts.js';

// ─── Internal types ───────────────────────────────────────────────────────────

interface QueueEntry {
  path: string;
  depth: number;
}

interface RankedCandidate {
  candidatePath: string;
  score: number;
  candidateIdentifierLength: number;
}

export interface TaskContract {
  deliverableRequired: boolean;
  taskClass: 'analysis_deliverable' | 'evidence_collection' | 'general';
  requestedOutputs: string[];
  evidenceOnlyAllowed: boolean;
  implementationRequested: boolean;
  deliverableStatus: 'evidence_only_allowed' | 'deliverable_required' | 'not_required';
  groundingRequired: boolean;
  focusArea: 'ui' | 'general';
  signals: string[];
  rawTask: string;
  taskText: string;
}

export interface TaskGrounding {
  projectRoot: string;
  appRoot: string;
  groundingRoots: string[];
  targetGroundingRoots: string[];
  referenceRoots: string[];
  targetFiles: string[];
  referenceFiles: string[];
  files: string[];
  fileCount: number;
  fileBasenames: string[];
  grounded: boolean;
  companionSnippets: string[];
  entitySnippets: string[];
  daoSnippets: string[];
  referenceInventorySnippets: string[];
}

export interface GroundedEvidenceRegistry {
  availableFiles: string[];
  referencedFiles: string[];
  availableFileSet: Set<string>;
  availableBasenameSet: Set<string>;
}

interface StepLike {
  step: number;
  tool?: string;
  target?: string;
  description?: string;
  rationale?: string;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function normalizeTaskText(value: unknown): string {
    return String(value ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeIdentifier(value: unknown): string {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter((value) => value && value.length > 0))];
}

function tokenizeTask(value: unknown): string[] {
    const stopWords = new Set([
        'the', 'and', 'for', 'with', 'that', 'this', 'make', 'plan', 'suggested',
        'changes', 'change', 'audit', 'review', 'critique', 'analyze', 'analyse',
        'evaluate', 'app', 'ui', 'ux', 'screen', 'screens', 'project', 'android',
    ]);
    return unique(String(value ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopWords.has(token)));
}

function listDirectories(rootPath: string, maxDepth = 3): string[] {
    if (!rootPath || !existsSync(rootPath)) {
        return [];
    }
    const results: string[] = [];
    const queue: QueueEntry[] = [{ path: rootPath, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            continue;
        }
        let entries: Dirent<string>[] = [];
        try {
            entries = readdirSync(current.path, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const nextPath = join(current.path, entry.name);
            results.push(nextPath);
            if (current.depth + 1 < maxDepth) {
                queue.push({ path: nextPath, depth: current.depth + 1 });
            }
        }
    }
    return results;
}

function findCandidateAppRoot(taskText: string, projectRoot: string): string {
    const taskIdentifier = normalizeIdentifier(taskText);
    const taskTokens = tokenizeTask(taskText);
    const candidateDirs = [projectRoot, ...listDirectories(projectRoot, 2)]
        .filter((candidatePath) => existsSync(join(candidatePath, 'app', 'src', 'main', 'java')));
    if (candidateDirs.length === 0) {
        return projectRoot;
    }
    const ranked: RankedCandidate[] = candidateDirs.map((candidatePath) => {
        const candidateName = basename(candidatePath);
        const candidateIdentifier = normalizeIdentifier(candidateName);
        let score = 0;
        if (candidateIdentifier && taskIdentifier.includes(candidateIdentifier)) {
            score += 10;
        }
        const nameTokens = tokenizeTask(candidateName);
        for (const token of nameTokens) {
            if (taskTokens.includes(token)) {
                score += 3;
            }
        }
        if (candidatePath === projectRoot) {
            score -= 1;
        }
        return { candidatePath, score, candidateIdentifierLength: candidateIdentifier.length };
    }).sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        return b.candidateIdentifierLength - a.candidateIdentifierLength;
    });
    return ranked[0]?.candidatePath ?? projectRoot;
}

function listUiDirectories(appRoot: string): string[] {
    const javaRoot = join(appRoot, 'app', 'src', 'main', 'java');
    if (!existsSync(javaRoot)) {
        return [];
    }
    const uiSubdirs = [javaRoot, ...listDirectories(javaRoot, 6)]
        .filter((candidatePath) => basename(candidatePath).toLowerCase() === 'ui');
    return unique([javaRoot, ...uiSubdirs]).sort((a, b) => a.localeCompare(b));
}

function listFrontendUiDirectories(projectRoot: string): string[] {
    const candidates = [
        join(projectRoot, 'audit-frontend', 'src', 'app'),
        join(projectRoot, 'audit-frontend', 'src', 'components'),
        join(projectRoot, 'audit-frontend', 'src', 'styles'),
        join(projectRoot, 'audit-frontend', 'src'),
        join(projectRoot, 'src', 'app'),
        join(projectRoot, 'src', 'components'),
        join(projectRoot, 'src', 'styles'),
        join(projectRoot, 'src'),
        join(projectRoot, 'app'),
        join(projectRoot, 'pages'),
        join(projectRoot, 'components'),
        join(projectRoot, 'styles'),
    ];
    return unique(candidates.filter((candidatePath) => existsSync(candidatePath))).sort((a, b) => a.localeCompare(b));
}

function listGroundedFiles(rootPath: string, filePattern: RegExp = /\.(kt|java|xml)$/i): string[] {
    if (!rootPath || !existsSync(rootPath)) {
        return [];
    }
    const results: string[] = [];
    const stack: string[] = [rootPath];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        let entries: Dirent<string>[] = [];
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const nextPath = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(nextPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (!filePattern.test(entry.name)) {
                continue;
            }
            results.push(nextPath);
        }
    }
    return results.sort((a, b) => a.localeCompare(b));
}

function pathToPosix(rootPath: string, filePath: string): string {
    return relative(rootPath, filePath).replace(/\\/g, '/');
}

function listDirectChildDirectories(rootPath: string): string[] {
    if (!rootPath || !existsSync(rootPath)) {
        return [];
    }
    try {
        return readdirSync(rootPath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(rootPath, entry.name))
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

function isLikelyPythonReferenceRoot(rootPath: string): boolean {
    if (!rootPath || !existsSync(rootPath)) {
        return false;
    }
    if (existsSync(join(rootPath, 'pyproject.toml')) || existsSync(join(rootPath, 'requirements.txt')) || existsSync(join(rootPath, 'setup.py'))) {
        return true;
    }
    const nestedPythonFiles = listGroundedFiles(rootPath, /\.py$/i);
    return nestedPythonFiles.length > 0;
}

function findReferenceSourceRoots(taskText: string, projectRoot: string): string[] {
    if (!projectRoot || !existsSync(projectRoot)) {
        return [];
    }
    const normalizedTask = normalizeTaskText(taskText);
    const taskIdentifier = normalizeIdentifier(taskText);
    const directChildren = listDirectChildDirectories(projectRoot);
    const mirroredRoot = join(projectRoot, 'reference-Example Finance Forecast');
    const candidates = [
        ...(existsSync(mirroredRoot) ? [mirroredRoot] : []),
        ...directChildren,
    ];
    return unique(candidates).filter((candidatePath) => {
        const candidateName = basename(candidatePath);
        const candidateLower = candidateName.toLowerCase();
        const candidateIdentifier = normalizeIdentifier(candidateName);
        const hintedByName = candidateLower.startsWith('reference-') || candidateLower.includes('reference');
        const hintedByTask = normalizedTask.includes(candidateLower) || (candidateIdentifier && taskIdentifier.includes(candidateIdentifier));
        return (hintedByName || hintedByTask) && isLikelyPythonReferenceRoot(candidatePath);
    });
}

function buildReferenceInventorySnippets(projectRoot: string, referenceRoots: string[]): string[] {
    const snippets: string[] = [];
    for (const referenceRoot of referenceRoots) {
        const rootFiles: string[] = [];
        const readmePath = join(referenceRoot, 'README.md');
        const pyprojectPath = join(referenceRoot, 'pyproject.toml');
        if (existsSync(readmePath)) {
            rootFiles.push(readmePath);
        }
        if (existsSync(pyprojectPath)) {
            rootFiles.push(pyprojectPath);
        }
        for (const childDir of listDirectChildDirectories(referenceRoot)) {
            const pythonFiles = listGroundedFiles(childDir, /\.py$/i);
            if (pythonFiles.length > 0) {
                rootFiles.push(...pythonFiles);
            }
        }
        if (rootFiles.length > 0) {
            snippets.push(`// ${pathToPosix(projectRoot, referenceRoot)} authoritative source file_read allowlist (closed; exact paths only)\n${unique(rootFiles).join('\n')}`);
        }
        const sourceModuleFiles = listGroundedFiles(join(referenceRoot, 'monte_carlo_ledger'), /\.py$/i);
        if (sourceModuleFiles.length > 0) {
            const sourceModuleNames = unique(sourceModuleFiles.map((filePath) => basename(filePath))).sort((a, b) => a.localeCompare(b));
            snippets.push(`// ${pathToPosix(projectRoot, join(referenceRoot, 'monte_carlo_ledger'))} closed source module inventory (exact basenames)\n// ${sourceModuleNames.join(', ')}\n// Do not invent models.py or engine.py; they are not present in this inventory.`);
        }
    }
    return snippets;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function classifyTaskContract(taskText: unknown): TaskContract {
    const normalized = normalizeTaskText(taskText);
    const isEvaluative = /\b(audit|review|critique|evaluate|evaluation|analyze|analyse|assess)\b/.test(normalized);
    const requestsSuggestions = /\b(suggest(?:ed)? changes?|recommend(?:ation|ations)?|improvement(?:s)?|next steps)\b/.test(normalized);
    const requestsPlan = /\b(plan|roadmap|prioriti[sz]ed)\b/.test(normalized);
    const uiFocus = /\b(ui|ux|screen|screens|compose|material|layout|accessibility|visual)\b/.test(normalized);
    const implementationRequested = /\b(implement|apply|fix|modify|update|improve|refine|polish|create|port|continue|finish|complete|build)\b/.test(normalized)
        && /\b(code|ui|screen|screens|app|changes?)\b/.test(normalized);
    const evidenceOnlyAllowed = /\b(gather|collect|read|inspect)\b.{0,40}\b(evidence|files|context|inputs)\b/.test(normalized)
        && !(/\b(make|produce|deliver|write|draft)\b.{0,40}\b(plan|recommend|findings|changes|audit|review)\b/.test(normalized));
    const deliverableRequired = isEvaluative || requestsSuggestions || requestsPlan;
    const requestedOutputs = unique([
        isEvaluative ? 'findings' : '',
        requestsSuggestions ? 'recommendations' : '',
        requestsPlan ? 'prioritized_next_steps' : '',
    ]);
    const taskClass: TaskContract['taskClass'] = deliverableRequired
        ? 'analysis_deliverable'
        : (evidenceOnlyAllowed ? 'evidence_collection' : 'general');
    const deliverableStatus: TaskContract['deliverableStatus'] = evidenceOnlyAllowed
        ? 'evidence_only_allowed'
        : (deliverableRequired ? 'deliverable_required' : 'not_required');
    return {
        deliverableRequired,
        taskClass,
        requestedOutputs,
        evidenceOnlyAllowed,
        implementationRequested,
        deliverableStatus,
        groundingRequired: deliverableRequired && isEvaluative,
        focusArea: uiFocus ? 'ui' : 'general',
        signals: unique([
            isEvaluative ? 'evaluative_request' : '',
            requestsSuggestions ? 'recommendations_requested' : '',
            requestsPlan ? 'plan_requested' : '',
            uiFocus ? 'ui_focus' : '',
            evidenceOnlyAllowed ? 'evidence_only_allowed' : '',
            implementationRequested ? 'implementation_requested' : '',
        ]),
        rawTask: String(taskText ?? ''),
        taskText: normalized,
    };
}

export function hasPlaceholderProjectPath(projectPath: unknown): boolean {
    const normalized = String(projectPath ?? '').trim();
    if (!normalized) {
        return false;
    }
    return /<[^>]+>/.test(normalized) || normalized.includes('YOUR_PROJECT_ROOT');
}

export function getDeliverableStatus(
    taskContract: TaskContract | null | undefined,
    swePlan: SwePlan | null | undefined,
): string {
    if (taskContract?.evidenceOnlyAllowed) {
        return 'evidence_only_allowed';
    }
    if (!taskContract?.deliverableRequired) {
        return 'not_required';
    }
    if (swePlan?.plan_type === 'EVIDENCE_REQUEST') {
        return 'evidence_only_incomplete';
    }
    return 'deliverable_ready';
}

export function shouldRejectEvidenceOnlyPlan(
    taskContract: TaskContract | null | undefined,
    swePlan: SwePlan | null | undefined,
): boolean {
    return getDeliverableStatus(taskContract, swePlan) === 'evidence_only_incomplete';
}

export function shouldApplyAndroidUiAuditHardening(
    taskContract: TaskContract | null | undefined,
    manifest: OrchestratorManifest | null | undefined,
): boolean {
    if (manifest?.target_project !== 'example_mobile_suite') {
        return false;
    }
    if (taskContract?.focusArea !== 'ui') {
        return false;
    }
    return Boolean(taskContract?.deliverableRequired || taskContract?.evidenceOnlyAllowed);
}

export function getAndroidUiAuditHardening(taskContract: TaskContract | null | undefined): {
    domainId: string;
    requiredSkillIds: string[];
    requiredTaskOverlayIds: string[];
    projectOverlayId: string;
} | null {
    if (taskContract?.focusArea !== 'ui') {
        return null;
    }
    return {
        domainId: 'domain_android_kotlin',
        requiredSkillIds: unique([
            'skill_jetpack_compose',
            'skill_android_ui_audit_review',
        ]),
        requiredTaskOverlayIds: unique([
            'task_overlay_ai_android_development',
        ]),
        projectOverlayId: 'overlay_example_mobile_suite',
    };
}

export function shouldPreloadGroundedEvidence(taskContract: TaskContract | null | undefined): boolean {
    return taskContract?.focusArea === 'ui' && taskContract?.deliverableStatus === 'deliverable_required';
}

export function buildDeliverableQaReject(
    taskContract: TaskContract | null | undefined,
    userRequest: unknown,
): Partial<QaVerdict> {
    const outputs = taskContract?.requestedOutputs?.length
        ? taskContract.requestedOutputs.join(', ')
        : 'findings, recommendations, and prioritized next steps';
    return {
        verdict: 'REJECT',
        failure_count: 1,
        overall_confidence: 5,
        failures: [
            {
                tag: 'INCOMPLETE_SUBMISSION',
                condition: `[DELIVERABLE_COMPLETENESS] Evidence-only plan is incomplete for this task. The user requested a finished evaluative deliverable, not only evidence gathering.`,
                confidence: 5,
                fix_hint: `Replace the evidence-only pass with the requested deliverable shape: ${outputs}.`,
            },
        ],
        proposed_fix_strategy: `Use the available evidence to produce the requested deliverable structure (${outputs}) for: ${String(userRequest ?? '').trim() || 'the user request'}.`,
    };
}

export function isDeliverableCompletenessReject(verdict: Partial<QaVerdict> | null | undefined): boolean {
    if (!verdict || !('failures' in verdict) || !Array.isArray(verdict.failures)) return false;
    return verdict.failures.some((failure) => String((failure as { condition?: unknown }).condition ?? '').includes('[DELIVERABLE_COMPLETENESS]'));
}

export function buildTaskGrounding(
    taskContract: TaskContract | null | undefined,
    projectRoot: string | null | undefined,
): TaskGrounding | null {
    if ((!taskContract?.groundingRequired && !taskContract?.implementationRequested) || !projectRoot || !existsSync(projectRoot)) {
        return null;
    }
    const rawTask = String(taskContract?.rawTask ?? '');
    const appRoot = findCandidateAppRoot(taskContract.taskText, projectRoot);
    const androidUiDirectories = taskContract.focusArea === 'ui' ? listUiDirectories(appRoot) : [];
    const frontendUiDirectories = taskContract.focusArea === 'ui' ? listFrontendUiDirectories(projectRoot) : [];
    const groundingRoots = androidUiDirectories.length > 0
        ? androidUiDirectories
        : (frontendUiDirectories.length > 0 ? frontendUiDirectories : [appRoot]);
    const filePattern = frontendUiDirectories.length > 0 && androidUiDirectories.length === 0
        ? /\.(ts|tsx|js|jsx|css|scss|sass|md|mdx)$/i
        : /\.(kt|java|xml)$/i;
    const targetFiles = unique(groundingRoots.flatMap((groundingRoot) => listGroundedFiles(groundingRoot, filePattern)));
    const referenceRoots = findReferenceSourceRoots(rawTask, projectRoot);
    if (referenceRoots.length === 0 && /Example Finance Forecast|example_autonomous_agent/i.test(rawTask)) {
        const externalReferenceRoot = resolve(projectRoot, '..', 'example_autonomous_agent', 'Example Finance Forecast');
        if (existsSync(externalReferenceRoot) && isLikelyPythonReferenceRoot(externalReferenceRoot)) {
            referenceRoots.push(externalReferenceRoot);
        }
    }
    const referenceFiles = unique(referenceRoots.flatMap((referenceRoot) => listGroundedFiles(referenceRoot, /\.(py|md|toml|sql|yaml|yml|json)$/i)));
    const files = unique([...targetFiles, ...referenceFiles]);
    const classNameMatches = [...new Set((rawTask.match(/\b([A-Z][A-Za-z0-9]+)\b/g) ?? []))];
    const companionSnippets: string[] = [];
    for (const className of classNameMatches) {
        const matchedFile = files.find((filePath) => basename(filePath, extname(filePath)) === className);
        if (matchedFile && existsSync(matchedFile)) {
            const lines = readFileSync(matchedFile, 'utf8').split('\n').slice(0, 60);
            companionSnippets.push(`// ${relative(projectRoot, matchedFile).replace(/\\/g, '/')}\n${lines.join('\n')}`);
        }
    }
    const isRepositoryTask = /repository/i.test(rawTask)
        || files.some((filePath) => basename(filePath).endsWith('Repository.kt'));
    const entitySnippets: string[] = [];
    const daoSnippets: string[] = [];
    if (isRepositoryTask) {
        const entityFiles = files.filter((filePath) => filePath.endsWith('Entity.kt'));
        for (const entityFile of entityFiles) {
            const content = readFileSync(entityFile, 'utf8');
            entitySnippets.push(`// ${relative(projectRoot, entityFile).replace(/\\/g, '/')}\n${content}`);
        }
        const daoFiles = files.filter((filePath) => filePath.endsWith('Dao.kt') || filePath.endsWith('Dao.java'));
        for (const daoFile of daoFiles) {
            const content = readFileSync(daoFile, 'utf8');
            const sigLines = content
                .split('\n')
                .filter((line) => /^\s*(suspend\s+)?fun\s+|@(Query|Insert|Update|Delete|Transaction)/.test(line))
                .join('\n');
            daoSnippets.push(`// ${relative(projectRoot, daoFile).replace(/\\/g, '/')}\n${sigLines}`);
        }
    }
    const referenceInventorySnippets = buildReferenceInventorySnippets(projectRoot, referenceRoots);
    return {
        projectRoot,
        appRoot,
        groundingRoots: unique([...groundingRoots, ...referenceRoots]),
        targetGroundingRoots: groundingRoots,
        referenceRoots,
        targetFiles,
        referenceFiles,
        files,
        fileCount: files.length,
        fileBasenames: unique(files.map((filePath) => basename(filePath))),
        grounded: files.length > 0,
        companionSnippets,
        entitySnippets,
        daoSnippets,
        referenceInventorySnippets,
    };
}

export function formatGroundingContext(grounding: TaskGrounding | null | undefined): string {
    if (!grounding || grounding.fileCount === 0) {
        return '';
    }
    const lines = [
        '--- GROUNDED FILE INVENTORY ---',
        'Use this real inventory as the authoritative file surface for the task.',
        'Do not invent filenames. If you reference or modify existing files, prefer this inventory first.',
        `Project root: ${grounding.projectRoot}`,
        `App root: ${grounding.appRoot}`,
        `Grounded roots: ${grounding.groundingRoots.join(', ')}`,
        `Grounded files (${grounding.fileCount}):`,
        ...grounding.files.map((filePath) => `  - ${relative(grounding.projectRoot, filePath).replace(/\\/g, '/')}`),
    ];
    if (grounding.referenceRoots?.length > 0) {
        lines.push(
            '',
            'Reference source roots (directory_list only; do not file_read these directories):',
            ...grounding.referenceRoots.map((referenceRoot) => `  - ${pathToPosix(grounding.projectRoot, referenceRoot)}`),
            `Canonical port root: ${grounding.projectRoot}`,
            `Canonical reference mirror root: ${grounding.referenceRoots[0]}`,
        );
    }
    if (grounding.companionSnippets?.length > 0) {
        lines.push('', 'Referenced class signatures (first 60 lines each):', grounding.companionSnippets.join('\n---\n'));
    }
    if (grounding.referenceInventorySnippets?.length > 0) {
        lines.push('', 'Reference source file_read allowlist (closed; use only these exact paths instead of guessing module names):', grounding.referenceInventorySnippets.join('\n---\n'));
        lines.push(
            '',
            'Reference file-read skill:',
            '1. Read README.md and pyproject.toml first.',
            '2. Then read only the exact source module filenames listed in the closed allowlist above.',
            '3. Do not guess alternate module names such as models.py, engine.py, core_engine.py, or data_models.py.',
            '4. If the file you want is not in the allowlist, stop and surface the gap instead of inventing a path.',
        );
    }
    if (grounding.entitySnippets?.length > 0) {
        lines.push('', 'Entity schemas (authoritative field definitions — do not invent other fields):', grounding.entitySnippets.join('\n---\n'));
    }
    if (grounding.daoSnippets?.length > 0) {
        lines.push('', 'DAO method signatures (authoritative callable surface — do not invent other methods):', grounding.daoSnippets.join('\n---\n'));
    }
    return lines.join('\n');
}

function resolveTargetPath(projectRoot: string, target: unknown): string | null {
    const normalized = String(target ?? '').trim();
    if (!normalized) {
        return null;
    }
    if (/^[A-Za-z]:[\\/]/.test(normalized)) {
        return resolve(normalized);
    }
    return resolve(projectRoot, normalized);
}

function escapeRegex(value: unknown): string {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEvidencePath(value: unknown): string {
    return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function toGroundedRelativePath(grounding: TaskGrounding, filePath: string): string {
    return relative(grounding.projectRoot, filePath).replace(/\\/g, '/');
}

function resolveGroundedTargetMatches(target: unknown, grounding: TaskGrounding): string[] {
    const normalizedTarget = String(target ?? '').trim().replace(/\\/g, '/');
    if (!normalizedTarget || !grounding?.grounded) {
        return [];
    }
    const directMatches = grounding.files
        .map((filePath) => toGroundedRelativePath(grounding, filePath))
        .filter((relativePath) => normalizedTarget.toLowerCase().includes(relativePath.toLowerCase()));
    const basenameToRelative = new Map<string, string[]>();
    for (const filePath of grounding.files) {
        const basenameKey = basename(filePath).toLowerCase();
        const relativePath = toGroundedRelativePath(grounding, filePath);
        const existing = basenameToRelative.get(basenameKey) ?? [];
        existing.push(relativePath);
        basenameToRelative.set(basenameKey, existing);
    }
    const basenameMatches: string[] = [];
    for (const [basenameKey, relativePaths] of basenameToRelative.entries()) {
        if (relativePaths.length !== 1) {
            continue;
        }
        const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(basenameKey)}($|[^A-Za-z0-9_])`, 'i');
        if (pattern.test(normalizedTarget)) {
            basenameMatches.push(relativePaths[0]!);
        }
    }
    return unique([...directMatches, ...basenameMatches]);
}

function canonicalizeExternalReferenceTarget(target: unknown, grounding: TaskGrounding): string | null {
    const normalizedTarget = String(target ?? '').trim();
    if (!normalizedTarget || !grounding?.grounded) {
        return null;
    }
    const externalMarker = 'example_autonomous_agent\\Example Finance Forecast';
    const normalizedMarker = externalMarker.replace(/\\/g, '/').toLowerCase();
    const normalizedInput = normalizedTarget.replace(/\\/g, '/');
    const markerIndex = normalizedInput.toLowerCase().indexOf(normalizedMarker);
    if (markerIndex < 0) {
        return null;
    }
    const mirrorRoot = (Array.isArray(grounding.referenceRoots) && grounding.referenceRoots.length > 0)
        ? grounding.referenceRoots[0]!
        : join(grounding.projectRoot, 'reference-Example Finance Forecast');
    if (!mirrorRoot || !existsSync(mirrorRoot)) {
        return null;
    }
    const suffix = normalizedInput.slice(markerIndex + normalizedMarker.length).replace(/^\/+/, '');
    return suffix.length > 0 ? join(mirrorRoot, suffix) : mirrorRoot;
}

function canonicalizeReferenceModuleGuess(step: StepLike, grounding: TaskGrounding): string | null {
    const normalizedTarget = String(step?.target ?? '').trim();
    const normalizedBasename = basename(normalizedTarget).toLowerCase();
    if (!normalizedBasename || !grounding?.grounded || !Array.isArray(grounding.files)) {
        return null;
    }
    const candidateBasenames: string[] = [];
    if (normalizedBasename === 'core_engine.py' || normalizedBasename === 'engine.py') {
        candidateBasenames.push('forecasting.py', 'budget_engine.py');
    } else if (normalizedBasename === 'models.py') {
        const haystack = [
            String(step?.description ?? ''),
            String(step?.rationale ?? ''),
        ].join(' ').toLowerCase();
        if (/\b(schema|sqlite|table|tables|database|model)\b/.test(haystack)) {
            candidateBasenames.push('schema.sql', 'db_manager.py', 'domain_rules.py');
        } else {
            candidateBasenames.push('db_manager.py', 'schema.sql', 'domain_rules.py');
        }
    } else {
        return null;
    }
    for (const candidateBasename of candidateBasenames) {
        const match = grounding.files.find((filePath) => basename(filePath).toLowerCase() === candidateBasename);
        if (match) {
            return match;
        }
    }
    return null;
}

function shouldNormalizeGroundedTargetStep(step: StepLike): boolean {
    const tool = String(step?.tool ?? '').trim();
    if (!['file_read', 'directory_list', 'audit_ui'].includes(tool)) {
        return false;
    }
    const target = String(step?.target ?? '').trim();
    return target.length > 0;
}

export function normalizePlanTargetsAgainstGrounding(grounding: TaskGrounding | null | undefined, swePlan: SwePlan): { plan: SwePlan; warnings: string[] };
export function normalizePlanTargetsAgainstGrounding(grounding: TaskGrounding | null | undefined, swePlan: SwePlan | null | undefined): { plan: SwePlan | null | undefined; warnings: string[] };
export function normalizePlanTargetsAgainstGrounding(
    grounding: TaskGrounding | null | undefined,
    swePlan: SwePlan | null | undefined,
): { plan: SwePlan | null | undefined; warnings: string[] } {
    if (!grounding?.grounded || !Array.isArray(swePlan?.minimal_action_set)) {
        return { plan: swePlan, warnings: [] };
    }
    const warnings: string[] = [];
    let changed = false;
    const normalizedSteps: SwePlan['minimal_action_set'] = [];
    for (const step of swePlan.minimal_action_set) {
        let normalizedStep = step;
        if (!shouldNormalizeGroundedTargetStep(normalizedStep)) {
            normalizedSteps.push(normalizedStep);
            continue;
        }
        const guessedModuleTarget = canonicalizeReferenceModuleGuess(normalizedStep, grounding);
        if (guessedModuleTarget && String(normalizedStep.target).trim() !== guessedModuleTarget) {
            changed = true;
            warnings.push(`[PLAN_TARGET_CANONICALIZED] Step ${step.step} target normalized to grounded reference module: ${guessedModuleTarget}`);
            normalizedStep = { ...normalizedStep, target: guessedModuleTarget };
        }
        const externalCanonicalTarget = canonicalizeExternalReferenceTarget(normalizedStep.target, grounding);
        if (externalCanonicalTarget && String(normalizedStep.target).trim() !== externalCanonicalTarget) {
            changed = true;
            warnings.push(`[PLAN_TARGET_CANONICALIZED] Step ${step.step} target normalized to mirrored reference root: ${externalCanonicalTarget}`);
            normalizedStep = { ...normalizedStep, target: externalCanonicalTarget };
        }
        const matches = resolveGroundedTargetMatches(normalizedStep.target, grounding);
        if (matches.length === 0) {
            normalizedSteps.push(normalizedStep);
            continue;
        }
        if (matches.length === 1) {
            const canonicalTarget = matches[0]!;
            if (String(normalizedStep.target).trim() !== canonicalTarget) {
                changed = true;
                warnings.push(`[PLAN_TARGET_CANONICALIZED] Step ${step.step} target normalized to grounded file: ${canonicalTarget}`);
                normalizedSteps.push({ ...normalizedStep, target: canonicalTarget });
                continue;
            }
            normalizedSteps.push(normalizedStep);
            continue;
        }
        changed = true;
        warnings.push(`[PLAN_TARGET_SPLIT] Step ${step.step} target expanded into ${matches.length} grounded single-file steps.`);
        for (const canonicalTarget of matches) {
            normalizedSteps.push({ ...normalizedStep, target: canonicalTarget });
        }
    }
    if (!changed) {
        return { plan: swePlan, warnings };
    }
    const resequencedSteps = normalizedSteps.map((step, index) => ({
        ...step,
        step: index + 1,
    }));
    return {
        plan: {
            ...swePlan,
            minimal_action_set: resequencedSteps,
        },
        warnings,
    };
}

export function extractGroundedFilesFromEvidenceContext(evidenceContext: unknown): string[] {
    const matches: string[] = [];
    const pattern = /^\[FILE\]\s+(.+)$/gm;
    for (const match of String(evidenceContext ?? '').matchAll(pattern)) {
        const normalized = normalizeEvidencePath(match[1]);
        if (normalized) {
            matches.push(normalized);
        }
    }
    return unique(matches);
}

export function buildGroundedEvidenceRegistry(
    grounding: TaskGrounding | null | undefined,
    evidenceContext: unknown,
    swePlan: SwePlan | null | undefined,
): GroundedEvidenceRegistry | null {
    const availableFiles = extractGroundedFilesFromEvidenceContext(evidenceContext);
    if (!grounding?.grounded || availableFiles.length === 0) {
        return null;
    }
    const availableSet = new Set(availableFiles.map((filePath) => filePath.toLowerCase()));
    const availableGroundingFiles = grounding.files.filter((filePath) => availableSet.has(toGroundedRelativePath(grounding, filePath).toLowerCase()));
    const availableGrounding: TaskGrounding = {
        ...grounding,
        files: availableGroundingFiles,
        fileBasenames: unique(availableGroundingFiles.map((filePath) => basename(filePath))),
    };
    const referencedFiles = Array.isArray(swePlan?.minimal_action_set)
        ? unique(swePlan.minimal_action_set.flatMap((step) => resolveGroundedTargetMatches(step?.target, availableGrounding)))
        : [];
    return {
        availableFiles,
        referencedFiles,
        availableFileSet: new Set(availableFiles.map((filePath) => filePath.toLowerCase())),
        availableBasenameSet: new Set(availableFiles.map((filePath) => basename(filePath).toLowerCase())),
    };
}

export function formatGroundedEvidenceRegistry(registry: GroundedEvidenceRegistry | null | undefined): string {
    if (!registry || registry.availableFiles.length === 0) {
        return '';
    }
    const lines = [
        '--- GROUNDED EVIDENCE REGISTRY ---',
        'The following files are ALREADY present in submission context via preloaded [FILE] evidence.',
        'Treat them as PRESENT for Evidence Gate purposes. Do NOT require redundant file_read steps for these files.',
        `Grounded files in context (${registry.availableFiles.length}):`,
        ...registry.availableFiles.map((filePath) => `  - ${filePath}`),
    ];
    if (registry.referencedFiles.length > 0) {
        lines.push(`Plan-referenced grounded files (${registry.referencedFiles.length}):`, ...registry.referencedFiles.map((filePath) => `  - ${filePath}`));
    }
    return lines.join('\n');
}

function extractEvidenceGateMentions(condition: unknown): string[] {
    return unique((String(condition ?? '').match(/[A-Za-z0-9_./\\:-]+\.(kt|java|xml|md)/gi) ?? []).map((match) => normalizeEvidencePath(match)));
}

function isGroundedEvidenceMention(registry: GroundedEvidenceRegistry, mention: string): boolean {
    const normalized = normalizeEvidencePath(mention).toLowerCase();
    if (!normalized) {
        return false;
    }
    return registry.availableFileSet.has(normalized) || registry.availableBasenameSet.has(basename(normalized).toLowerCase());
}

export function reconcileQaVerdictWithGroundedEvidence(
    verdict: QaVerdict | null | undefined,
    registry: GroundedEvidenceRegistry | null | undefined,
): QaVerdict | null | undefined {
    if (!registry || verdict?.verdict !== 'REJECT' || !('failures' in verdict) || !Array.isArray(verdict.failures) || verdict.failures.length === 0) {
        return verdict;
    }
    const remainingFailures: typeof verdict.failures = [];
    let suppressedCount = 0;
    for (const failure of verdict.failures) {
        if (failure?.tag !== 'EVIDENCE-GATE') {
            remainingFailures.push(failure);
            continue;
        }
        const mentions = extractEvidenceGateMentions(failure.condition);
        if (mentions.length === 0 || !mentions.every((mention) => isGroundedEvidenceMention(registry, mention))) {
            remainingFailures.push(failure);
            continue;
        }
        suppressedCount += 1;
    }
    if (suppressedCount === 0) {
        return verdict;
    }
    if (remainingFailures.length === 0) {
        return {
            verdict: 'PASS',
            overall_confidence: Math.max(1, Math.min(5, Number(verdict.overall_confidence) || 3)) as 1 | 2 | 3 | 4 | 5,
            notes: `Grounded evidence registry satisfied ${suppressedCount} false Evidence Gate check(s).`,
        };
    }
    return {
        ...verdict,
        failure_count: remainingFailures.length,
        failures: remainingFailures,
    };
}

function extractReferencedPaths(step: StepLike): string[] {
    const target = String(step?.target ?? '').trim();
    if (!target) {
        return [];
    }
    const tool = String(step?.tool ?? '').trim();
    if (!target.includes(',') && !target.includes('*') && (tool === 'file_read' || tool === 'file_write')) {
        return /[\\/]$/.test(target) ? [] : [target];
    }
    if (!target.includes(',') && !target.includes('*') && (/\.(kt|java|xml|md)$/i.test(target) || /[\\/]$/.test(target))) {
        return [target];
    }
    const matches = target.match(/[A-Za-z0-9_./\\:-]+\.(kt|java|xml|md)/gi);
    return unique(matches ?? []);
}

export function collectPlanGroundingViolations(
    taskContract: TaskContract | null | undefined,
    grounding: TaskGrounding | null | undefined,
    swePlan: SwePlan | null | undefined,
): string[] {
    if ((!taskContract?.groundingRequired && !taskContract?.implementationRequested) || !grounding?.grounded || !swePlan?.minimal_action_set) {
        return [];
    }
    const violations: string[] = [];
    for (const step of swePlan.minimal_action_set) {
        const tool = String(step?.tool ?? '').trim();
        const candidatePaths = extractReferencedPaths(step);
        for (const candidatePath of candidatePaths) {
            const resolvedTarget = resolveTargetPath(grounding.projectRoot, candidatePath);
            const exists = resolvedTarget ? existsSync(resolvedTarget) : false;
            const groundedMatches = resolveGroundedTargetMatches(candidatePath, grounding);
            const basenameMatch = grounding.fileBasenames.includes(basename(candidatePath));
            const inGroundedFiles = resolvedTarget ? grounding.files.includes(resolvedTarget) : false;
            if (tool === 'file_write' && !exists) {
                continue;
            }
            if (!exists && groundedMatches.length === 0 && (/\.(kt|java|xml)$/i.test(candidatePath) || tool === 'file_read' || tool === 'audit_ui')) {
                violations.push(`[GROUNDING_GUARD] Step ${step.step} references missing path: ${candidatePath}`);
                continue;
            }
            if (/\.(kt|java|xml)$/i.test(candidatePath) && !(basenameMatch || inGroundedFiles)) {
                violations.push(`[GROUNDING_GUARD] Step ${step.step} references file outside grounded inventory: ${candidatePath}`);
            }
        }
    }
    return unique(violations);
}

export function buildGroundingQaReject(violations: string[]): Partial<QaVerdict> {
    return {
        verdict: 'REJECT',
        failure_count: violations.length,
        overall_confidence: 5,
        failures: violations.map((condition) => ({
            tag: 'EVIDENCE-GATE',
            condition,
            confidence: 5,
            fix_hint: 'Use only grounded files or read the real files first before recommending changes.',
        })),
        proposed_fix_strategy: 'Regenerate the plan using the grounded file inventory and gather real file content before referencing additional existing files.',
    };
}
