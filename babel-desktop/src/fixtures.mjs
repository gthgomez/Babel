export const MODE_OPTIONS = [
  {id:'chat',label:'Chat',description:'General development'},
  {id:'plan',label:'Plan',description:'Structured multi-step'},
  {id:'deep',label:'Deep',description:'Extended investigation'}
];
export const MODEL_OPTIONS = ['gpt-5.6-sol','claude-sonnet-5','gemini-3.7-high','deepseek-v4'];
export const TOOL_OPTIONS = ['File system','Git','Shell','Web search','Package manager'];
export const FINDINGS = [
  'Timeout is currently based on total elapsed time, not progress.',
  'Long-running tasks with output can be incorrectly terminated.',
  'No distinction between "stalled" and "actively making progress."',
  'Tests assume a fixed deadline rather than progress-based liveness.'
];
export const SOLUTIONS = [
  'Replace fixed timeout with progress-aware liveness check.',
  'Track last meaningful output, file changes, or tool activity.',
  'Allow configurable max idle time (e.g., no progress for N minutes).',
  'Add tests for active-but-slow vs. truly stuck processes.',
  'Update documentation and defaults.'
];
export const PREVIEW_FILES = [
  {name:'src',type:'folder',children:[{name:'review',type:'folder',children:[{name:'controller.ts',type:'file'}]},{name:'runtime',type:'folder',children:[{name:'subprocess.ts',type:'file'}]},{name:'index.ts',type:'file'}]},
  {name:'tests',type:'folder',children:[{name:'review_timeout_test.py',type:'file'}]},
  {name:'docs',type:'folder',children:[{name:'architecture.md',type:'file'}]},
  {name:'scripts',type:'folder',children:[{name:'verify.ps1',type:'file'}]},
  {name:'tools',type:'folder',children:[{name:'check.mjs',type:'file'}]},
  {name:'configs',type:'folder',children:[{name:'runtime.json',type:'file'}]},
  {name:'README.md',type:'file'}, {name:'pyproject.toml',type:'file'}, {name:'package.json',type:'file'}
];
export function createReference() {
  return {version:1, activeId:'reference',mode:'chat',model:MODEL_OPTIONS[0],sessions:[
    {id:'reference',title:'Timeout architecture...',fixture:true,messages:[]},
    ...['Chat truth repair','TUI theme design','Independent review v3','Model comparison','DragonWake assets','Chicago MCP research','September income plan','Runtime observability','Windows process cleanup','Release preparation'].map((title,i)=>({id:`sample-${i}`,title,messages:[]}))
  ]};
}
export const REFERENCE_PROMPT = `Investigate the review timeout behavior and propose a fix that prevents
legitimate long-running work from being terminated while still stopping
stuck processes.`;
export const REFERENCE_INTRO = `I'll inspect the review controller, subprocess handling, and timeout logic first,
then propose a design that uses progress-based liveness instead of a fixed wall-
clock timeout.`;
export const REFERENCE_SUMMARY = `I found that the current timeout is applied at the process boundary rather than
the task-progress boundary. This means legitimate work with steady progress can
still be terminated if it exceeds the fixed duration.`;
export const REFERENCE_TOOLS = [
  {id:'ref-read-1',action:'read',path:'src/review/controller.ts',label:'read src/review/controller.ts',meta:'184 lines',duration:'12 ms',status:'complete',detail:'Reference fixture · file read\n\n184 lines · 12 ms\nThis row reproduces the supplied image. No repository file was read.'},
  {id:'ref-read-2',action:'read',path:'src/runtime/subprocess.ts',label:'read src/runtime/subprocess.ts',meta:'312 lines',duration:'18 ms',status:'complete',detail:'Reference fixture · file read\n\n312 lines · 18 ms\nThis row reproduces the supplied image. No repository file was read.'},
  {id:'ref-search',action:'search',path:'"timeout" src/',label:'search "timeout" src/',meta:'14 matches',duration:'45 ms',status:'complete',detail:'Reference fixture · search\n\n14 matches · 45 ms\nThese values come from the supplied North Star image, not a live search.'},
  {id:'ref-test',action:'run',path:'tests/review_timeout_test.py',label:'run tests/review_timeout_test.py',meta:'running...',duration:'',status:'running',detail:'Reference fixture · running-state demonstration\n\nNo tests are executing. This row remains in its reference state until you leave the sample session.'}
];
