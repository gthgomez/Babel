#!/usr/bin/env python3
"""Small offline fixture copier and external checker. Never launches Babel or a model."""
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
MARKER = '.brpcb-workspace.json'
SUITE = 'babel-real-project-coding-benchmark-v1'
CASES = {'BRPCB-A': 'remote-assets', 'BRPCB-B': 'tariff-expiry', 'BRPCB-C': 'fuzzy-ranking'}
# These runtime directories never become grader inputs. Do not put task answers in them.
IGNORED = {'.git', '.babel', 'node_modules', '__pycache__'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def case(name):
    slug = CASES.get(name, name)
    if slug not in CASES.values():
        raise ValueError('Unknown case: ' + name)
    return read_json(ROOT / 'cases' / (slug + '.json'))


def files(root, ignore_runtime=False):
    result = {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Expected a real directory: ' + str(root))
    for current, dirs, names in os.walk(root, followlinks=False):
        if ignore_runtime:
            dirs[:] = [d for d in dirs if d not in IGNORED]
        for name in dirs + names:
            path = Path(current) / name
            rel = path.relative_to(root).as_posix()
            if ignore_runtime and rel == MARKER:
                continue
            if path.is_symlink():
                raise ValueError('Symlink is not a fixture input: ' + rel)
            if path.is_file():
                result[rel] = path.read_bytes()
    return result


def tree_hash(data):
    # Raw bytes, sorted POSIX relative names; independent of timestamps and umask.
    return digest(b''.join(k.encode() + b'\0' + digest(v).encode() + b'\n'
                           for k, v in sorted(data.items())))


def absolute_workspace(value):
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != path:
        raise ValueError('Use an absolute, normalized, non-symlink workspace path')
    if path == Path.home() or path == ROOT or path in ROOT.parents or ROOT in path.parents:
        raise ValueError('Workspace must be separate from the package and its ancestors')
    return path


def marker_for(c, target):
    baseline = files(ROOT / c['workspace'])
    if c.get('fixture_sha256') and tree_hash(baseline) != c['fixture_sha256']:
        raise ValueError('Frozen template digest mismatch; restore the original package')
    return {'suite': SUITE, 'case_id': c['id'], 'case_version': c['version'],
            'workspace': str(target), 'baseline_sha256': tree_hash(baseline)}


def prepare(c, target, reset=False):
    marker = marker_for(c, target)
    if reset:
        # Reset only this exact tool-created directory, never an arbitrary checkout.
        if not target.is_dir() or read_json(target / MARKER) != marker:
            raise ValueError('Reset refused: exact workspace marker/identity does not match')
        shutil.rmtree(target)
    elif target.exists():
        raise ValueError('Prepare requires a nonexistent path; use reset for a marked workspace')
    shutil.copytree(ROOT / c['workspace'], target)
    (target / MARKER).write_text(json.dumps(marker, indent=2) + '\n', encoding='utf-8')
    return marker


def clean_env(tz='UTC'):
    # No credentials, BABEL_*, NODE_OPTIONS, npm hooks, or ambient provider settings.
    env = {k: os.environ[k] for k in (
        'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
        'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    ) if k in os.environ}
    env.update({'TZ': tz, 'LANG': 'C.UTF-8'})
    return env


def command(argv, cwd, tz='UTC'):
    started = datetime.now(timezone.utc)
    record = {'argv': [str(x) for x in argv], 'cwd': str(cwd), 'TZ': tz,
              'started_at_utc': started.isoformat()}
    try:
        done = subprocess.run(argv, cwd=cwd, env=clean_env(tz), capture_output=True,
                              text=True, encoding='utf-8', errors='replace', timeout=30)
        record.update(exit_code=done.returncode, stdout=done.stdout, stderr=done.stderr)
    except subprocess.TimeoutExpired as exc:
        record.update(exit_code=None, stdout=str(exc.stdout or ''), stderr=str(exc.stderr or ''),
                      execution_error='timeout: candidate or evaluator did not finish within 30 seconds')
    except OSError as exc:
        record.update(exit_code=None, stdout='', stderr=str(exc), execution_error='infrastructure unavailable')
    record['wall_time_seconds'] = (datetime.now(timezone.utc) - started).total_seconds()
    return record


def doctor():
    node = command(['node', '--version'], ROOT)
    result = {'python': platform.python_version(), 'node': node['stdout'].strip(),
              'platform': platform.platform(), 'dependencies': [], 'node_probe': node,
              'tested_pins': {'python': '3.12.14', 'node': 'v24.19.0'}}
    result['supported_family'] = sys.version_info[:2] == (3, 12) and node['exit_code'] == 0 and result['node'].startswith('v24.')
    result['matches_tested_pins'] = result['python'] == '3.12.14' and result['node'] == 'v24.19.0'
    return result


def receipt(record, case_id):
    for line in reversed(record['stdout'].splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get('case_id') == case_id and 'functional_success' in value:
            return value
    return None


def evaluate(c, target, scratch):
    runtime = doctor()
    result = {'suite': SUITE, 'case_id': c['id'], 'case_version': c['version'],
              'runtime': runtime, 'candidate_workspace': str(target),
              'functional_success': None, 'strict_completion': None, 'truthful_claims': None,
              'status': 'environment_failure', 'exit_code': 2, 'commands': []}
    if not runtime['supported_family']:
        result['reason'] = 'Need Python 3.12.x and Node 24.x; exact tested pins are recorded'
        return result
    if not target.exists() or not target.is_dir():
        result.update(status='setup_failure', reason='Candidate workspace does not exist or is not a directory')
        return result
    expected = files(ROOT / c['workspace'])
    if c.get('fixture_sha256') and tree_hash(expected) != c['fixture_sha256']:
        result.update(status='evaluator_failure', reason='Frozen template digest mismatch')
        return result
    try:
        actual = files(target, ignore_runtime=True)
    except OSError as exc:
        result.update(status='environment_failure', reason='Unable to read candidate workspace: ' + str(exc))
        return result
    except ValueError as exc:
        result.update(status='candidate_integrity_failure', exit_code=1, functional_success=False, reason=str(exc))
        return result
    changed = sorted(k for k in expected.keys() | actual.keys() if expected.get(k) != actual.get(k))
    allowed = c['mutable_paths']
    unauthorized = [k for k in changed if not any(fnmatch.fnmatchcase(k, p) for p in allowed)]
    result.update(baseline_sha256=tree_hash(expected), candidate_sha256=tree_hash(actual),
                  changed_paths=changed, unauthorized_changes=unauthorized,
                  evaluator_sha256=digest((ROOT / c['evaluator']).read_bytes()))
    if unauthorized:
        result.update(status='candidate_integrity_failure', exit_code=1, functional_success=False)
        return result
    with tempfile.TemporaryDirectory(prefix='brpcb-grade-', dir=scratch) as temp:
        snapshot = Path(temp) / 'candidate'
        snapshot.mkdir()
        # Copy captured bytes, never run the candidate's npm scripts or mutable tests.
        for rel, content in actual.items():
            dest = snapshot / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
        result['evaluation_snapshot'] = str(snapshot)
        public = command(c['public_command'], snapshot)
        result['commands'].append(public)
        zones = ['UTC', 'America/Los_Angeles'] if c['id'] == 'BRPCB-B' else ['UTC']
        verdicts = []
        for zone in zones:
            evaluator = ROOT / c['evaluator']
            interpreter = sys.executable if evaluator.suffix == '.py' else 'node'
            item = command([interpreter, str(evaluator), str(snapshot)], snapshot, zone)
            item['receipt'] = receipt(item, c['id'])
            result['commands'].append(item)
            verdicts.append(item)
        if any(x['exit_code'] is None for x in result['commands']):
            result.update(status='execution_unavailable_or_timeout', reason='See exact command record; task correctness remains unknown')
        elif any(x['exit_code'] == 2 and x['receipt'] is not None and
                 x['receipt']['functional_success'] is None for x in verdicts):
            unknown = next(x['receipt'] for x in verdicts if x['exit_code'] == 2 and
                           x['receipt'] is not None and x['receipt']['functional_success'] is None)
            status = unknown.get('status')
            if status == 'infrastructure_unknown':
                status = 'environment_failure'
            if status not in {'setup_failure', 'environment_failure', 'evaluator_failure',
                              'execution_unavailable_or_timeout'}:
                status = 'evaluator_failure'
            result.update(status=status, reason='Evaluator could not determine correctness; see command evidence')
        elif any(x['receipt'] is None or x['exit_code'] not in (0, 1, 3) for x in verdicts):
            result.update(status='evaluator_failure', reason='Missing valid evaluator receipt or unexpected exit; never accept bare exit 0')
        elif public['exit_code'] != 0 or any(x['exit_code'] == 1 or x['receipt']['functional_success'] is False for x in verdicts):
            result.update(status='fail', exit_code=1, functional_success=False)
        elif c['id'] == 'BRPCB-A' and all(x['exit_code'] == 3 and x['receipt']['functional_success'] is None and x['receipt'].get('status') == 'needs_human_review' and type(x['receipt'].get('assertions')) is int and x['receipt']['assertions'] > 0 for x in verdicts):
            result.update(status='needs_human_review', exit_code=3, functional_success=None)
        elif c['id'] != 'BRPCB-A' and all(x['exit_code'] == 0 and x['receipt']['functional_success'] is True and x['receipt'].get('status') == 'pass' and type(x['receipt'].get('assertions')) is int and x['receipt']['assertions'] > 0 for x in verdicts):
            result.update(status='pass', exit_code=0, functional_success=True)
        else:
            result.update(status='evaluator_failure', reason='Inconsistent evaluator exit/receipt')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['doctor', 'prepare', 'reset', 'evaluate'])
    parser.add_argument('case', nargs='?')
    parser.add_argument('--workspace')
    parser.add_argument('--scratch-root', default=tempfile.gettempdir())
    parser.add_argument('--output', help='Operator-side JSON result file, outside the candidate')
    args = parser.parse_args()
    try:
        if args.action == 'doctor':
            result = doctor()
            code = 0 if result['supported_family'] else 2
        else:
            if not args.case or not args.workspace:
                raise ValueError('case and --workspace are required')
            c = case(args.case)
            target = absolute_workspace(args.workspace)
            if args.output:
                output = Path(args.output).resolve()
                if output == target or target in output.parents:
                    raise ValueError('Keep operator results outside the agent workspace')
            if args.action in ('prepare', 'reset'):
                result = prepare(c, target, reset=args.action == 'reset')
                code = 0
            else:
                scratch = Path(args.scratch_root).resolve()
                if not scratch.is_dir() or scratch == target or target in scratch.parents:
                    raise ValueError('Use an existing scratch parent outside the candidate')
                result = evaluate(c, target, scratch)
                code = result['exit_code']
        text = json.dumps(result, indent=2, ensure_ascii=True) + '\n'
        if args.output:
            Path(args.output).write_text(text, encoding='utf-8')
        print(text, end='')
        return code
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({'status': 'setup_failure', 'functional_success': None, 'error': str(exc)}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
