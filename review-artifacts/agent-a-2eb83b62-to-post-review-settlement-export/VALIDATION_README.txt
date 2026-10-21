Post-review settlement + adapter resolution validation (2eb83b62 → 10ddcfc7)
============================================================================
Prior integrated candidate preserved: 2eb83b62 (tag research-v2-integrated-candidate-2eb83b62)
B source / prior bundle unchanged: agent-a-ad2755c2-to-2eb83b62-integrated-candidate-export

Commands (repo root unless noted)
---------------------------------
cd babel-cli && npm run typecheck
cd babel-cli && npm run build
cd babel-cli && node scripts/research-v2-collect-test-files.mjs | xargs -r npx tsx --test

Artifacts: TYPECHECK.log, BUILD.log, RESEARCH_V2_TEST_MANIFEST.txt, RESEARCH_V2_TAP_FULL.log
Tests: 242 pass (outer_exit in TAP log)

Publication / live API: HELD
