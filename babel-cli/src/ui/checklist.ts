import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { accentBright, muted, primary, bold, dim, ghost } from './theme.js';

/**
 * A selectable CLI checklist for plan review.
 * Allows users to toggle individual steps before execution.
 */
export async function renderInteractiveChecklist(steps: any[]): Promise<any[] | null> {
    if (process.env['BABEL_PIPELINE_V9_OFFLINE'] === '1') return [];
    if (!process.stdout.isTTY) return steps;

    let cursorIdx = 0;
    const selected = new Set(steps.map((_, i) => i));
    const stdin = process.stdin;
    const stdout = process.stdout;

    return new Promise((resolve) => {
        const render = () => {
            stdout.write('\u001b[s'); // save
            stdout.write('\u001b[J'); // clear below
            
            stdout.write(`\n  ${primary('Review Implementation Plan')}\n`);
            stdout.write(`  ${muted('Use arrows to move, SPACE to toggle, ENTER to execute, ESC to cancel')}\n\n`);

            steps.forEach((step, i) => {
                const isFocused = i === cursorIdx;
                const isChecked = selected.has(i);
                
                const box = isChecked ? accentBright('[x]') : muted('[ ]');
                const focusMarker = isFocused ? accentBright('› ') : '  ';
                const label = isFocused ? bold(primary(step.description)) : muted(step.description);
                const tool = dim(` (${step.tool})`);
                stdout.write(`${focusMarker}${box} ${label}${tool}\n`);
            });
            
            // Render Preview for focused step
            const step = steps[cursorIdx];
            if (step && (step.tool?.includes('replace') || step.tool?.includes('write'))) {
                const targetFile = step.TargetFile || step.path;
                if (targetFile && fs.existsSync(targetFile)) {
                    try {
                        const content = fs.readFileSync(targetFile, 'utf8');
                        const lines = content.split('\n');
                        const target = step.TargetContent || '';
                        let previewLine = -1;
                        if (target) {
                            previewLine = lines.findIndex(l => l.includes(target.split('\n')[0]));
                        }
                        
                        if (previewLine !== -1) {
                            const start = Math.max(0, previewLine - 1);
                            const end = Math.min(lines.length, previewLine + 2);
                            const snippet = lines.slice(start, end).map((l, i) => {
                                const lineNum = start + i + 1;
                                const prefix = lineNum === previewLine + 1 ? accentBright('│ ') : muted('│ ');
                                return `    ${prefix}${dim(lineNum.toString().padStart(3))} ${ghost(l)}`;
                            }).join('\n');
                            
                            stdout.write(`\n    ${dim(muted('Target Preview:'))}\n${snippet}\n`);
                        }
                    } catch {
                        // Ignore read errors
                    }
                }
            }

            stdout.write('\n\u001b[u'); // restore
        };

        const onKeypress = (str: string, key: any) => {
            if (key.name === 'up') {
                cursorIdx = (cursorIdx - 1 + steps.length) % steps.length;
                render();
            } else if (key.name === 'down') {
                cursorIdx = (cursorIdx + 1) % steps.length;
                render();
            } else if (key.name === 'space') {
                if (selected.has(cursorIdx)) {
                    selected.delete(cursorIdx);
                } else {
                    selected.add(cursorIdx);
                }
                render();
            } else if (key.name === 'return') {
                cleanup();
                const result = steps.filter((_, i) => selected.has(i));
                resolve(result);
            } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                cleanup();
                resolve(null);
            }
        };

        const cleanup = () => {
            stdin.removeListener('keypress', onKeypress);
            if (stdin.isTTY) stdin.setRawMode(false);
            stdin.pause();
            stdout.write('\u001b[J'); // clear menu
        };

        if (stdin.isTTY) {
            readline.emitKeypressEvents(stdin);
            stdin.setRawMode(true);
            stdin.resume();
            stdin.on('keypress', onKeypress);
        }

        render();
    });
}
