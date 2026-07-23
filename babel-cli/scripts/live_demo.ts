import logUpdate from 'log-update';
import { 
    renderProductBanner, 
    renderStageSection, 
    renderProgressLabel 
} from '../src/ui/renderers.js';
import { renderStatusRows } from '../src/ui/statusLine.js';
import { renderSection } from '../src/ui/sections.js';
import { muted, primary, getTerminalWidth } from '../src/ui/theme.js';

// Mock context for the demo
const context = {
    mode: 'deep',
    router: 'v9',
    task: 'Optimize cross-domain routing policy',
    project: 'Babel Core',
    model: 'sonnet-3.5',
    tier: 'premium',
    runDir: 'runs/live-demo-001'
};

const contextRows = [
    { label: 'Task', value: context.task },
    { label: 'Project', value: context.project },
    { label: 'Mode', value: context.mode, tone: 'accent' },
    { label: 'Router', value: context.router, tone: 'accent' },
    { label: 'Model', value: context.model },
    { label: 'Tier', value: context.tier },
    { label: 'Run ID', value: context.runDir },
];

const metadata = `${context.mode} · ${context.router}`;

// Cache the static parts of the screen
const staticPrelude = [
    renderProductBanner('Run', 'abstract layered architecture'),
    renderSection('STATUS', [renderStatusRows(contextRows)], metadata),
    ''
].join('\n');

let frame = 0;
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

// Handle terminal resize to prevent layout artifacts
process.stdout.on('resize', () => {
    logUpdate.clear();
});

// Initial render
process.stdout.write(HIDE_CURSOR);

const timer = setInterval(() => {
    try {
        const width = getTerminalWidth();
        
        // Stateful Stage Animation: Advance stage every 20 frames
        // Stage 1 (Orchestrator), Stage 2 (Planner), 3 (QA), 4 (Executor)
        const activeStage = Math.min(4, Math.floor(frame / 20) + 1);
        
        const pipeline = renderStageSection(activeStage, {
            activeState: 'ACTIVE',
            metadata: 'layered flow simulation'
        });
        
        const progress = renderProgressLabel('Simulation running', { 
            frameIndex: frame++,
            timestamp: new Date().toLocaleTimeString()
        });
        
        const footer = '\n' + muted('─'.repeat(width)) + '\n' + 
                       primary('  ↵ submit / ctrl+c cancel');
        
        // Assemble screen and write
        logUpdate(`${staticPrelude}${pipeline}\n\n${progress}${footer}`);
        
    } catch (error) {
        clearInterval(timer);
        process.stdout.write(SHOW_CURSOR);
        console.error('\nDemo error:', error);
        process.exit(1);
    }
}, 80);

// Graceful exit
process.on('SIGINT', () => {
    clearInterval(timer);
    logUpdate.done();
    process.stdout.write(`${SHOW_CURSOR}\n`);
    process.exit(0);
});

// Auto-stop after 10 seconds to allow seeing the full animation cycle
setTimeout(() => {
    clearInterval(timer);
    logUpdate.done();
    process.stdout.write(`${SHOW_CURSOR}\nDemo completed successfully.\n`);
    process.exit(0);
}, 10000);
