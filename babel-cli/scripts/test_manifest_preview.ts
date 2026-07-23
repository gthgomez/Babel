import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

interface ManifestSummary {
    projectKind: string;
    taskCategory: string;
    model: string | null;
    pipelineMode: string | null;
    selectedCodexAdapter: string | null;
    recommendedTaskOverlayIds: string[];
    recommendedSkillIds: string[];
    selectedStack: Array<{
        id: string | null;
        layer: string | null;
        loadPosition: number | null;
        relativePath: string | null;
        orderIndex: number | null;
    }>;
}

interface PreviewCase {
    label: string;
    taskCategory: string;
    projectPrivate: string;
    projectPublic: string;
    pipelineMode: string;
    fixture: string;
    expectedModel?: string;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const babelRoot = resolve(scriptDir, '..', '..');
const resolverScript = join(babelRoot, 'tools', 'resolve-local-stack.ps1');
const previewRoot = join(babelRoot, 'examples', 'manifest-previews');

const hasPrivateBackendProject = existsSync(join(babelRoot, 'Project_SaaS', 'example_saas_backend'));
const hasPrivateMobileProject = existsSync(join(babelRoot, 'example_mobile_suite'));

const cases: PreviewCase[] = [
    {
        label: 'backend-verified',
        taskCategory: 'backend',
        projectPrivate: 'example_saas_backend',
        projectPublic: 'example_saas_backend',
        pipelineMode: 'deep',
        fixture: 'backend-verified.json',
        expectedModel: 'codex',
    },
    {
        label: 'mobile-direct',
        taskCategory: 'mobile',
        projectPrivate: 'example_mobile_suite',
        projectPublic: 'example_mobile_suite',
        pipelineMode: 'chat',
        fixture: 'mobile-direct.json',
        expectedModel: 'codex',
    },
];

function assertNonEmptyString(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map(v => String(v));
}

function asNumber(value: unknown): number | null {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return null;
    }

    return value;
}

function toSummary(label: string, manifest: Record<string, unknown>): ManifestSummary {
    const selectedStack = Array.isArray(manifest.SelectedStack)
        ? manifest.SelectedStack.map((entry: unknown) => {
            const value = entry as Record<string, unknown>;
            return {
                id: value?.Id ? String(value.Id) : null,
                layer: value?.Layer ? String(value.Layer) : null,
                loadPosition: asNumber(value?.LoadPosition),
                relativePath: value?.RelativePath ? String(value.RelativePath) : null,
                orderIndex: asNumber(value?.OrderIndex),
            };
        })
        : [];

    return {
        projectKind: label,
        taskCategory: assertNonEmptyString(manifest.TaskCategory) ? String(manifest.TaskCategory) : '',
        model: assertNonEmptyString(manifest.Model) ? String(manifest.Model) : null,
        pipelineMode: assertNonEmptyString(manifest.PipelineMode) ? String(manifest.PipelineMode) : null,
        selectedCodexAdapter: assertNonEmptyString(manifest.SelectedCodexAdapter) ? String(manifest.SelectedCodexAdapter) : null,
        recommendedTaskOverlayIds: asStringArray(manifest.RecommendedTaskOverlayIds),
        recommendedSkillIds: asStringArray(manifest.RecommendedSkillIds),
        selectedStack,
    };
}

function toFixtureSummary(label: string, rawFixture: Record<string, unknown>): ManifestSummary {
    return toSummary(label, rawFixture);
}

function parseManifestOutput(output: string): Record<string, unknown> {
    const first = output.indexOf('{');
    const last = output.lastIndexOf('}');

    if (first < 0 || last < first) {
        throw new Error('Manifest output did not contain JSON content.');
    }

    try {
        const payload = output.slice(first, last + 1);
        return JSON.parse(payload) as Record<string, unknown>;
    } catch (error) {
        throw new Error(`Unable to parse resolver manifest output as JSON: ${(error instanceof Error ? error.message : String(error))}`);
    }
}

function runResolver(command: {
    taskCategory: string;
    project: string;
    pipelineMode: string;
    model: string;
}): Record<string, unknown> {
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolverScript,
        '-TaskCategory',
        command.taskCategory,
        '-Project',
        command.project,
        '-Model',
        command.model,
        '-PipelineMode',
        command.pipelineMode,
        '-Format',
        'json',
    ];

    const result = spawnSync(shell, args, {
        encoding: 'utf8',
        windowsHide: true,
        cwd: babelRoot,
    });

    if (result.status !== 0) {
        const stderr = result.stderr?.toString().trim();
        throw new Error(`resolve-local-stack failed for ${command.taskCategory} with exit code ${result.status}: ${stderr}`);
    }

    const stdout = result.stdout?.toString().trim();
    if (!stdout) {
        const stderr = result.stderr?.toString().trim();
        throw new Error(`No output from resolve-local-stack for ${command.taskCategory}. stderr: ${stderr}`);
    }

    return parseManifestOutput(stdout);
}

function getAvailableProject(caseSpec: PreviewCase): string | null {
    if (caseSpec.taskCategory === 'backend' && hasPrivateBackendProject) {
        return caseSpec.projectPrivate;
    }

    if (caseSpec.taskCategory === 'mobile' && hasPrivateMobileProject) {
        return caseSpec.projectPrivate;
    }

    return null;
}

function assertPreviewCase(caseSpec: PreviewCase): void {
    const project = getAvailableProject(caseSpec);
    if (project === null) {
        console.log(`Skipping ${caseSpec.label} manifest preview regression (project context unavailable in this checkout): ${caseSpec.projectPublic}`);
        return;
    }

    const fixturePath = join(previewRoot, caseSpec.fixture);
    if (!existsSync(fixturePath)) {
        throw new Error(`Manifest preview fixture not found: ${fixturePath}`);
    }

    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const actual = runResolver({
        taskCategory: caseSpec.taskCategory,
        project,
        pipelineMode: caseSpec.pipelineMode,
        model: caseSpec.expectedModel ?? 'codex',
    });
    const actualSummary = toSummary(caseSpec.label, actual);
    const expectedSummary = toFixtureSummary(caseSpec.label, fixture);

    assert.deepStrictEqual(actualSummary, expectedSummary);
}

function main(): void {
    cases.forEach(assertPreviewCase);
    console.log('manifest-preview regression tests passed');
}

main();
