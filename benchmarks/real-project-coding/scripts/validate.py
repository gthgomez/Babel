#!/usr/bin/env python3
"""Exercise exactly three fixtures, their references, negatives, integrity, and reset."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import bench


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scratch-root', required=True, help='Existing absolute parent for disposable workspaces')
    parser.add_argument('--output', required=True, help='Operator-side validation JSON path')
    args = parser.parse_args()
    parent = Path(args.scratch_root)
    if not parent.is_absolute() or not parent.is_dir():
        parser.error('--scratch-root must be an existing absolute directory')
    root = None
    report = {'kind': 'offline_fixture_validation', 'started_at_utc': datetime.now(timezone.utc).isoformat(),
              'record_timezone': 'UTC', 'runtime': None,
              'scratch_root': None, 'validator_sha256': bench.digest(Path(__file__).read_bytes()),
              'steps': [], 'unexpected_results': [], 'live_model_runs': 'not_run',
              'explanation_semantics': 'Human judgment required; use oracle/remote-assets/RUBRIC.md'}

    def run(label, argv, expected, cwd=bench.ROOT):
        item = bench.command(argv, cwd)
        item.update(label=label, expected_exit_codes=expected,
                    matched_expectation=item['exit_code'] in expected)
        report['steps'].append(item)
        if not item['matched_expectation']:
            report['unexpected_results'].append(label)
        print(label + ': exit ' + str(item['exit_code']) + (' OK' if item['matched_expectation'] else ' UNEXPECTED'), flush=True)
        if not item['matched_expectation']:
            raise RuntimeError('Unexpected command outcome: ' + label)
        return item

    def cli(action, c, workspace, label, expected):
        argv = [sys.executable, str(bench.ROOT / 'scripts/bench.py'), action, c['id'],
                '--workspace', str(workspace), '--scratch-root', str(root)]
        return run(label, argv, expected)

    def overlay(path, workspace):
        content = bench.files(bench.ROOT / path)
        for rel, data in content.items():
            dest = workspace / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        report['steps'].append({'operation': 'apply_overlay', 'source': path, 'destination': str(workspace),
                                'files_sha256': {k: bench.digest(v) for k, v in content.items()}})

    try:
        root = Path(tempfile.mkdtemp(prefix='brpcb-validation-', dir=parent))
        report['scratch_root'] = str(root)
        report['runtime'] = bench.doctor()
        run('toolchain preflight', [sys.executable, str(bench.ROOT / 'scripts/bench.py'), 'doctor'], [0])
        for case_id in bench.CASES:
            c = bench.case(case_id)
            workspace = root / bench.CASES[case_id]
            ok = 3 if case_id == 'BRPCB-A' else 0
            for cycle in (1, 2):
                p = f'{case_id} cycle {cycle}'
                cli('prepare' if cycle == 1 else 'reset', c, workspace, p + ' fresh workspace', [0])
                visible = bench.files(workspace, ignore_runtime=True)
                leaked = [x for x in visible if any(part in {'oracle', 'reference', 'negative-controls'} for part in Path(x).parts)]
                report['steps'].append({'operation': 'visible_inventory', 'case_id': case_id, 'cycle': cycle,
                                        'files': sorted(visible), 'forbidden_directory_leaks': leaked})
                if leaked:
                    report['unexpected_results'].append(p + ' answer-directory leakage')
                run(p + ' baseline public', c['public_command'], [c['baseline']['public_exit']], workspace)
                cli('evaluate', c, workspace, p + ' baseline independent', [c['baseline']['evaluator_exit']])
                overlay(c['reference'], workspace)
                run(p + ' reference public', c['public_command'], [0], workspace)
                cli('evaluate', c, workspace, p + ' reference independent', [ok])
                if c.get('alternative_reference'):
                    cli('reset', c, workspace, p + ' alternative reset', [0])
                    overlay(c['alternative_reference'], workspace)
                    run(p + ' alternative public', c['public_command'], [0], workspace)
                    cli('evaluate', c, workspace, p + ' alternative independent', [ok])
                for negative in c['negative_controls']:
                    name = Path(negative).name
                    cli('reset', c, workspace, p + ' negative ' + name + ' reset', [0])
                    overlay(negative, workspace)
                    public_expected = 0
                    if c.get('negative_control_expectations'):
                        expectations = bench.read_json(bench.ROOT / c['negative_control_expectations'])['controls']
                        expectation = next(x for x in expectations if x.get('path', x.get('overlay')) == negative)
                        public_expected = expectation.get('expected_public_exit',
                            expectation.get('expected_public_exit_by_timezone', {}).get('UTC'))
                        if public_expected is None:
                            raise ValueError('Missing declared public outcome for ' + negative)
                    run(p + ' negative ' + name + ' public', c['public_command'], [public_expected], workspace)
                    cli('evaluate', c, workspace, p + ' negative ' + name + ' independent',
                        [3] if case_id == 'BRPCB-A' else [1])
                cli('reset', c, workspace, p + ' final reset', [0])
                same = bench.files(workspace, ignore_runtime=True) == bench.files(bench.ROOT / c['workspace'])
                report['steps'].append({'operation': 'reset_byte_comparison', 'case_id': case_id, 'cycle': cycle, 'matches_baseline': same})
                if not same:
                    report['unexpected_results'].append(p + ' reset left changed state')

            # Correct source plus test deletion or weakening must still fail integrity.
            for mode in ('deleted-public-test', 'weakened-public-test', 'changed-evaluator-script'):
                cli('reset', c, workspace, case_id + ' ' + mode + ' reset', [0])
                overlay(c['reference'], workspace)
                public_path = workspace / 'tests/public.test.mjs'
                if mode == 'deleted-public-test':
                    public_path.unlink()
                elif mode == 'weakened-public-test':
                    public_path.write_text('// Assertions removed by a bad candidate.\n', encoding='utf-8')
                else:
                    (workspace / 'check.mjs').write_text('process.exit(0);\n', encoding='utf-8')
                cli('evaluate', c, workspace, case_id + ' rejects ' + mode, [1])
            cli('reset', c, workspace, case_id + ' clean final state', [0])

        # A bare process exit cannot substitute for a real evaluator receipt.
        c = bench.case('BRPCB-C')
        workspace = root / 'fuzzy-ranking'
        (workspace / 'src/rankCandidates.ts').write_text('process.exit(0);\n', encoding='utf-8')
        cli('evaluate', c, workspace, 'BRPCB-C rejects bare exit zero without receipt', [1])
        cli('reset', c, workspace, 'BRPCB-C reset after exit-zero control', [0])

        cli('evaluate', c, root / 'nonexistent-workspace', 'missing workspace is setup failure, not task failure', [2])

        # Refuse to remove an unmarked directory. This is a reset-safety control.
        ordinary = root / 'unmarked-project'
        ordinary.mkdir()
        (ordinary / 'keep.txt').write_text('preserve me\n', encoding='utf-8')
        cli('reset', c, ordinary, 'refuse reset of an unmarked directory', [2])
        preserved = (ordinary / 'keep.txt').read_text(encoding='utf-8') == 'preserve me\n'
        if not preserved:
            report['unexpected_results'].append('unmarked-directory preservation')
        report['unmarked_directory_preserved'] = preserved
    except (Exception, KeyboardInterrupt) as error:
        report['fatal_error'] = {'type': type(error).__name__, 'message': str(error)}
        if not report['unexpected_results']:
            report['unexpected_results'].append('validation aborted: ' + type(error).__name__)
    report['completed_at_utc'] = datetime.now(timezone.utc).isoformat()
    report['all_expected_automated_outcomes_observed'] = not report['unexpected_results']
    report['cleanup'] = 'Grading snapshots use scoped TemporaryDirectory copies. Validation workspaces remain under the recorded unique scratch root for inspection; no user project was removed.'
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(output.resolve()), 'unexpected_results': report['unexpected_results'],
                      'automated_outcomes_ok': report['all_expected_automated_outcomes_observed']}))
    return 0 if report['all_expected_automated_outcomes_observed'] else 1


if __name__ == '__main__':
    sys.exit(main())
