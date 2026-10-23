import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bench
import validate


class OperatorTests(unittest.TestCase):
    def test_clean_environment_retains_windows_home_without_provider_settings(self):
        essentials = {'USERPROFILE': 'C:\\fixture-home', 'HOMEDRIVE': 'C:', 'HOMEPATH': '\\fixture-home'}
        with patch.dict(os.environ, {**essentials, 'BABEL_COMPACTION_MODEL': 'excluded'}, clear=True):
            actual = bench.clean_env()
        for name, value in essentials.items():
            self.assertEqual(actual.get(name), value)
        self.assertNotIn('BABEL_COMPACTION_MODEL', actual)

    def test_receipt_survives_an_ascii_output_pipe(self):
        raw = io.BytesIO()
        stdout = io.TextIOWrapper(raw, encoding='ascii')
        with patch.object(bench, 'doctor', return_value={'supported_family': True, 'output': '\u2714'}), \
                patch.object(sys, 'argv', ['bench.py', 'doctor']), patch.object(sys, 'stdout', stdout):
            result = bench.main()
            stdout.flush()
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(raw.getvalue())['output'], '\u2714')

    def assert_failure_report(self, exits, expected_steps):
        with tempfile.TemporaryDirectory(prefix='brpcb-operator-test-') as temp:
            root = Path(temp).resolve()
            output = root / 'report.json'
            records = [{'exit_code': code, 'stdout': '', 'stderr': '', 'argv': []} for code in exits]
            with patch.object(bench, 'doctor', return_value={'supported_family': True}), \
                    patch.object(bench, 'command', side_effect=records) as command, \
                    patch.object(sys, 'argv', ['validate.py', '--scratch-root', str(root), '--output', str(output)]), \
                    patch.object(sys, 'stdout', io.StringIO()):
                code = validate.main()
            self.assertEqual(code, 1)
            self.assertEqual(command.call_count, expected_steps)
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertFalse(report['all_expected_automated_outcomes_observed'])
            self.assertEqual(len(report['unexpected_results']), 1)
            self.assertEqual(len(report['steps']), expected_steps)
            self.assertIn('completed_at_utc', report)

    def test_failed_toolchain_writes_report_and_stops(self):
        self.assert_failure_report([2], 1)

    def test_failed_preparation_writes_report_without_inventorying_missing_workspace(self):
        self.assert_failure_report([0, 2], 2)

    def test_scratch_creation_failure_writes_report(self):
        with tempfile.TemporaryDirectory(prefix='brpcb-operator-test-') as temp:
            root = Path(temp).resolve()
            output = root / 'report.json'
            with patch.object(validate.tempfile, 'mkdtemp', side_effect=OSError('fixture scratch unavailable')), \
                    patch.object(sys, 'argv', ['validate.py', '--scratch-root', str(root), '--output', str(output)]), \
                    patch.object(sys, 'stdout', io.StringIO()):
                code = validate.main()
            self.assertEqual(code, 1)
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['fatal_error']['type'], 'OSError')
            self.assertIsNone(report['scratch_root'])
            self.assertIsNone(report['runtime'])
            self.assertFalse(report['all_expected_automated_outcomes_observed'])

    def test_case_provenance_paths_exist(self):
        for case_id in bench.CASES:
            case = bench.case(case_id)
            if 'provenance' in case:
                self.assertTrue((bench.ROOT / case['provenance']).is_file(), case_id)

    def test_unexpected_exception_keeps_completed_steps(self):
        with tempfile.TemporaryDirectory(prefix='brpcb-operator-test-') as temp:
            root = Path(temp).resolve()
            output = root / 'report.json'
            with patch.object(bench, 'doctor', return_value={'supported_family': True}), \
                    patch.object(bench, 'command', side_effect=[
                        {'exit_code': 0, 'stdout': '', 'stderr': '', 'argv': []},
                        OSError('fixture launch unavailable'),
                    ]), \
                    patch.object(sys, 'argv', ['validate.py', '--scratch-root', str(root), '--output', str(output)]), \
                    patch.object(sys, 'stdout', io.StringIO()):
                code = validate.main()
            self.assertEqual(code, 1)
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['fatal_error']['type'], 'OSError')
            self.assertEqual(len(report['steps']), 1)
            self.assertFalse(report['all_expected_automated_outcomes_observed'])


if __name__ == '__main__':
    unittest.main()
