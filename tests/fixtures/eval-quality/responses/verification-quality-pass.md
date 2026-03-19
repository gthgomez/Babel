OBJECTIVE: Define objective and reproducible verification for Phase 4 quality fixtures.

Verification Method:
1. Run powershell -ExecutionPolicy Bypass -File .\tools\test-eval-quality-fixtures.ps1 and require exit code 0.
2. Run powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1 and require exit code 0.
3. Run cd babel-cli and npm run typecheck and require exit code 0.

Expected evidence:
- Each command returns exit code 0.
- The fixture grading summary reports zero expectation mismatches.

Failure signal:
- Any command returns a non-zero exit code.
- The fixture grader reports expected vs actual mismatch for any fixture.
