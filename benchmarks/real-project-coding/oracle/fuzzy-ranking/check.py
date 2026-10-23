#!/usr/bin/env python3
"""Authoritative behavioral comparison; candidate code runs only in a Node child."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

CASE_ID = "BRPCB-C"
HERE = Path(__file__).resolve().parent
COMMANDS = []
# Preserve runtime essentials only; candidates and the trusted generator do not
# inherit credentials, provider settings, NODE_OPTIONS or npm hooks.
CHILD_ENV = {key: os.environ[key] for key in
             ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TZ") if key in os.environ}
CHILD_ENV["LANG"] = "C.UTF-8"
CHILD_ENV.setdefault("TZ", "UTC")


def invoke(argv, cwd, payload=None, timeout=15):
    evidence = {"argv": argv, "cwd": str(cwd), "TZ": CHILD_ENV["TZ"],
                "timeout_seconds": timeout, "timed_out": False, "exit_code": None}
    stdout = stderr = b""
    try:
        result = subprocess.run(argv, cwd=cwd, env=CHILD_ENV, input=payload,
                                capture_output=True, timeout=timeout)
        stdout, stderr = result.stdout, result.stderr
        evidence["exit_code"] = result.returncode
        return result
    except subprocess.TimeoutExpired as error:
        stdout, stderr = error.stdout or b"", error.stderr or b""
        evidence["timed_out"] = True
        raise
    except OSError as error:
        evidence["launch_error"] = str(error)
        raise
    finally:
        evidence.update(stdout_bytes=len(stdout), stdout_sha256=hashlib.sha256(stdout).hexdigest(),
                        stderr_bytes=len(stderr), stderr_sha256=hashlib.sha256(stderr).hexdigest(),
                        stderr_preview=stderr[:2000].decode("utf-8", errors="replace"))
        COMMANDS.append(evidence)


def strict_equal(actual, expected):
    """JSON comparison with booleans distinct from numeric scores and indices."""
    if type(expected) is bool:
        return type(actual) is bool and actual == expected
    if type(expected) in (int, float):
        return type(actual) in (int, float) and math.isfinite(actual) and actual == expected
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(strict_equal(a, e) for a, e in zip(actual, expected))
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(strict_equal(actual[k], v) for k, v in expected.items())
    return actual == expected


def reject_constant(value):
    raise ValueError("Non-JSON numeric constant: " + value)


def receipt(errors, assertions, groups, failed_checks, unknown=False):
    passed = failed_checks == 0
    print(json.dumps({
        "case_id": CASE_ID,
        "status": "infrastructure_unknown" if unknown else ("pass" if passed else "fail"),
        "functional_success": None if unknown else passed,
        "assertions": assertions,
        "checks": [{"name": name, "passed": good} for name, good in groups.items()],
        "failed_checks": None if unknown else failed_checks,
        "errors": errors,
        "commands": COMMANDS,
    }, ensure_ascii=True))
    return 2 if unknown else (0 if passed else 1)


def main():
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        print("usage: python check.py ABSOLUTE_CANDIDATE_WORKSPACE", file=sys.stderr)
        return 2
    candidate = Path(sys.argv[1])
    node = shutil.which("node")
    if node is None:
        return receipt(["Node.js 24.x is unavailable"], 0, {}, 1, unknown=True)

    # This separate trusted process imports only the pinned scorer, never the candidate.
    try:
        built = invoke([node, str(HERE / "vectors.mjs")], HERE, timeout=10)
        if built.returncode != 0:
            raise ValueError("Trusted vector generator exited " + str(built.returncode))
        plan = json.loads(built.stdout, parse_constant=reject_constant)
        vectors = plan["vectors"]
        expected_ids = [v["id"] for v in vectors]
        if plan["case_id"] != CASE_ID or not vectors or len(set(expected_ids)) != len(vectors):
            raise ValueError("Invalid trusted vector plan")
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        return receipt(["Trusted vector setup failed: " + str(error)], 0, {}, 1, unknown=True)

    # Only per-call inputs cross into the candidate process. Expected values stay here.
    requests = [{"id": v["id"], "method": v["method"], "args": v["args"]} for v in vectors]
    try:
        child = invoke([node, str(HERE / "candidate-worker.mjs"), str(candidate)], candidate,
                       json.dumps({"requests": requests}, ensure_ascii=True).encode("utf-8"), timeout=15)
    except (OSError, subprocess.SubprocessError) as error:
        return receipt(["Candidate hang or environment problem; no correctness verdict: " + str(error)],
                       0, {}, 1, unknown=True)
    if child.returncode != 0:
        return receipt(["Candidate worker exited " + str(child.returncode)], 1, {}, 1)

    # Console output or an alleged case-level pass is not evidence of per-call behavior.
    envelopes = []
    for line in child.stdout.splitlines():
        try:
            value = json.loads(line, parse_constant=reject_constant)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("protocol") == "brpcb-fuzzy-values-v1":
            envelopes.append(value)
    if len(envelopes) != 1:
        return receipt(["Missing or ambiguous candidate value envelope"], 1, {}, 1)
    envelope = envelopes[0]
    actual_results = envelope.get("results")
    if envelope.get("load_error") is not None:
        return receipt(["Candidate module failed to load: " + str(envelope["load_error"])], 1, {}, 1)
    if not isinstance(actual_results, list) or len(actual_results) != len(vectors):
        return receipt(["Candidate response count does not match the complete input plan"], 1, {}, 1)
    if any(not isinstance(r, dict) or not isinstance(r.get("id"), str) for r in actual_results):
        return receipt(["Malformed candidate response records"], 1, {}, 1)
    results_by_id = {r["id"]: r for r in actual_results}
    if len(results_by_id) != len(vectors) or set(results_by_id) != set(expected_ids):
        return receipt(["Candidate response IDs are duplicated, missing or unknown"], 1, {}, 1)

    errors = []
    groups = {}
    failed = 0
    for vector in vectors:
        actual = results_by_id[vector["id"]]
        expected = vector["expected"]
        groups.setdefault(vector["group"], True)
        good = actual.get("inputs_unchanged") is True and actual.get("kind") == expected["kind"]
        if expected["kind"] == "error":
            good = good and actual.get("name") == "RangeError" and actual.get("range_error") is True
        else:
            good = good and "value" in actual and strict_equal(actual["value"], expected["value"])
            if vector["method"] == "score":
                good = good and actual.get("value_type") == "number"
            else:
                expected_types = [{"item": "string", "score": "number", "index": "number"}
                                  for _ in expected["value"]]
                good = good and actual.get("is_array") is True and strict_equal(actual.get("field_types"), expected_types)
        if not good:
            failed += 1
            groups[vector["group"]] = False
            if len(errors) < 20:
                errors.append(vector["id"] + " / " + vector["group"] + ": wrong value, return/error type, or input mutation")
    return receipt(errors, len(vectors), groups, failed)


if __name__ == "__main__":
    raise SystemExit(main())
