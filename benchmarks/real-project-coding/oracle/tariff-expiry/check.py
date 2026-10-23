#!/usr/bin/env python3
"""BRPCB-B behavioral supervisor. Candidate JavaScript runs only in a child."""
import calendar
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

CASE_ID = "BRPCB-B"
DAY_MS = 86_400_000
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def tag(kind, value=None):
    result = {"kind": kind}
    if value is not None:
        result["value"] = value
    return result


def obj(**fields):
    return {"kind": "object", "fields": fields}


def utc_ms(value):
    if type(value) is int:
        return value
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    delta = parsed.astimezone(timezone.utc) - EPOCH
    return delta.days * DAY_MS + delta.seconds * 1000 + delta.microseconds // 1000


def fixtures():
    vectors, expected = [], []

    def add(name, entry, now, want, entry_key=None):
        vector = {"id": name, "entry": entry, "now_ms": utc_ms(now)}
        if entry_key is not None:
            vector["entry_key"] = entry_key
        vectors.append(vector)
        expected.append(want)

    def day(name, text):
        start = utc_ms(text + "T00:00:00Z")
        entry = obj(effectiveTo=tag("string", text))
        for suffix, offset, want in [
            ("preceding-day", -43_200_000, False), ("before-start", -1, False),
            ("at-start", 0, False), ("first-millisecond", 1, False),
            ("midday", 43_200_000, False), ("last-millisecond", DAY_MS - 1, False),
            ("following-midnight", DAY_MS, True), ("after-midnight", DAY_MS + 1, True),
            ("later", DAY_MS * 4, True),
        ]:
            add(name + "/" + suffix, entry, start + offset, want, name)

    for text in [
        "0100-01-01", "0100-02-28", "1582-10-04", "1900-02-28", "1987-11-06",
        "1999-12-31", "2000-02-29", "2004-02-29", "2023-02-28", "2024-02-29",
        "2026-03-08", "2026-04-30", "2026-11-01", "2026-12-31", "2037-06-30",
        "2100-02-28", "2400-02-29", "8001-07-19", "9998-12-31",
    ]:
        day("calendar/" + text, text)

    # Deterministic known-valid dates; no expected value is sent to the child.
    seed = 0x42524342

    def next_integer():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed

    for index in range(96):
        year, month, date = 100 + next_integer() % 9899, 1 + next_integer() % 12, 1 + next_integer() % 28
        day("generated/" + str(index), f"{year:04d}-{month:02d}-{date:02d}")
        if index % 8 == 0:
            last = calendar.monthrange(year, month)[1]
            day("generated-month-end/" + str(index), f"{year:04d}-{month:02d}-{last:02d}")

    for name, now, want in [
        ("positive-offset-still-live", "2037-07-01T02:30:00+05:00", False),
        ("negative-offset-already-expired", "2037-06-30T23:30:00-04:00", True),
        ("positive-offset-boundary", "2037-07-01T09:00:00+09:00", True),
        ("negative-offset-boundary", "2037-06-30T17:00:00-07:00", True),
        ("positive-offset-last-ms", "2037-07-01T08:59:59.999+09:00", False),
        ("negative-offset-last-ms", "2037-06-30T16:59:59.999-07:00", False),
    ]:
        add("offset/" + name, obj(effectiveTo=tag("string", "2037-06-30")), now, want)

    for name, entry in [
        ("missing-entry", tag("undefined")), ("null-entry", tag("null")),
        ("missing-property", obj()), ("undefined-property", obj(effectiveTo=tag("undefined"))),
        ("null-property", obj(effectiveTo=tag("null"))),
        ("empty-property", obj(effectiveTo=tag("string", ""))),
        ("unrelated-fields", obj(label=tag("string", "unchanged"), effectiveFrom=tag("string", "2020-01-01"))),
    ]:
        for now in ["0100-01-01T00:00:00Z", "2042-06-15T09:30:00Z", "9998-12-31T23:59:59Z"]:
            add("unbounded/" + name + "/" + now, entry, now, False)

    invalid_strings = [
        ("text", "not-a-date"), ("space", " "), ("tabs", "\t\r\n"),
        ("short-month", "2026-2-03"), ("short-day", "2026-02-3"),
        ("month-zero", "2026-00-01"), ("month-thirteen", "2026-13-01"),
        ("day-zero", "2026-01-00"), ("day-thirty-two", "2026-01-32"),
        ("february-thirty", "2026-02-30"), ("common-year-leap-day", "2023-02-29"),
        ("century-not-leap", "2100-02-29"), ("april-thirty-one", "2026-04-31"),
        ("november-thirty-one", "2026-11-31"), ("slash-form", "2026/02/03"),
        ("timestamp", "2026-02-03T00:00:00Z"), ("date-zone", "2026-02-03Z"),
        ("missing-day", "2026-02"), ("extra-prefix", "+2026-02-03"),
        ("inner-space", "2026- 02-03"), ("trailing-text", "2026-02-03junk"),
        ("unicode-dashes", "2026–02–03"), ("unicode-digits", "２０２６-０２-０３"),
    ]
    invalid = [(name, tag("string", value)) for name, value in invalid_strings] + [
        ("false", tag("boolean", False)), ("true", tag("boolean", True)),
        ("zero", tag("number", 0)), ("number", tag("number", 20260203)),
        ("nan", tag("nan")), ("infinity", tag("infinity")), ("negative-infinity", tag("negative-infinity")),
        ("array-empty", tag("array", [])), ("array-date", tag("array", [tag("string", "2026-02-03")])),
        ("object", obj()), ("date-object", tag("date", "2026-02-03T00:00:00Z")),
        ("function", tag("function")), ("symbol", tag("symbol", "2026-02-03")),
        ("bigint", tag("bigint", "20260203")),
    ]
    for name, value in invalid:
        for now in ["0200-01-01T00:00:00Z", "2026-02-03T12:00:00Z", "9998-12-31T00:00:00Z"]:
            add("malformed/" + name + "/" + now, obj(effectiveTo=value), now, True)

    for name, text in [
        ("spaces", " 1987-11-06 "), ("tabs-newline", "\t1987-11-06\r\n"),
        ("nonbreaking-space", "\u00a01987-11-06\u00a0"),
        ("mixed-whitespace", " \t\n1987-11-06 \r\n"),
    ]:
        for suffix, now, want in [
            ("earlier", "1987-11-05T12:00:00Z", False),
            ("last-day", "1987-11-06T12:00:00Z", False),
            ("last-ms", "1987-11-06T23:59:59.999Z", False),
            ("expired", "1987-11-07T00:00:00Z", True),
        ]:
            add("trim/" + name + "/" + suffix, obj(effectiveTo=tag("string", text)), now, want)

    for index, now, want in [
        (0, "2041-08-28T00:00:00Z", True), (1, "2041-08-27T23:59:59.999Z", False),
        (2, "2040-01-01T00:00:00Z", False), (3, "2043-01-01T00:00:00Z", True),
    ]:
        add("reused-entry/" + str(index),
            obj(effectiveTo=tag("string", "2041-08-27"), description=tag("string", "keep me")),
            now, want, "reusable")
    return vectors, expected


def main():
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        print("Usage: python check.py ABSOLUTE_CANDIDATE_DIRECTORY", file=sys.stderr)
        return 2
    vectors, expected = fixtures()
    assertions, failed_checks, errors = 0, 0, []

    def verify(condition, message):
        nonlocal assertions
        assertions += 1
        if not condition:
            raise AssertionError(message)

    def fail(name, message):
        nonlocal failed_checks
        failed_checks += 1
        if len(errors) < 20:
            errors.append({"test": name, "message": str(message)[:500]})

    worker = Path(__file__).resolve().with_name("worker.mjs")
    if not worker.is_file():
        print(json.dumps({"case_id": CASE_ID, "status": "evaluator_failure", "functional_success": None,
                          "assertions": 0, "errors": ["Missing operator worker"]}))
        return 2
    environment = {key: os.environ[key] for key in
                   ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TZ") if key in os.environ}
    environment["LANG"] = "C.UTF-8"
    environment.setdefault("TZ", "UTC")
    # Only input vectors cross this boundary. Expected results remain in Python.
    request = {"protocol": "brpcb-b-input-v1", "cases": vectors}
    payload = json.dumps(request).encode("utf-8")
    worker_command = {"argv": ["node", str(worker), sys.argv[1]], "cwd": sys.argv[1],
                      "TZ": environment["TZ"], "stdin_bytes": len(payload),
                      "stdin_sha256": hashlib.sha256(payload).hexdigest()}
    started = time.monotonic()

    def record_worker(exit_code, stdout=b"", stderr=b""):
        worker_command.update(exit_code=exit_code, stdout_bytes=len(stdout),
                              stdout_sha256=hashlib.sha256(stdout).hexdigest(),
                              stderr=stderr[:4096].decode("utf-8", errors="replace"),
                              stderr_bytes=len(stderr), stderr_truncated=len(stderr) > 4096,
                              wall_time_seconds=time.monotonic() - started)

    try:
        completed = subprocess.run(
            worker_command["argv"], input=payload, cwd=sys.argv[1],
            env=environment, capture_output=True, timeout=20,
        )
    except OSError as error:
        record_worker(None, stderr=str(error).encode("utf-8", errors="replace"))
        print(json.dumps({"case_id": CASE_ID, "status": "environment_failure", "functional_success": None,
                          "assertions": 0, "errors": [str(error)], "worker_command": worker_command}))
        return 2
    except subprocess.TimeoutExpired as error:
        record_worker(None, error.stdout or b"", error.stderr or b"")
        print(json.dumps({"case_id": CASE_ID, "status": "execution_unavailable_or_timeout",
                          "functional_success": None, "assertions": 0,
                          "errors": ["Worker exceeded 20 seconds; task correctness needs diagnosis"],
                          "worker_command": worker_command}))
        return 2
    record_worker(completed.returncode, completed.stdout, completed.stderr)

    if completed is not None:
        try:
            verify(completed.returncode == 0, "Candidate worker exited " + str(completed.returncode))
            lines = [line for line in completed.stdout.decode("utf-8", errors="replace").splitlines() if line.strip()]
            reply = json.loads(lines[-1]) if lines else None
            verify(type(reply) is dict and reply.get("protocol") == "brpcb-b-results-v1",
                   "Missing worker result protocol; a grading receipt is not a result vector")
            rows = reply.get("results")
            verify(type(rows) is list and len(rows) == len(vectors), "Result count does not match input count")
            verify([row.get("id") if type(row) is dict else None for row in rows] ==
                   [vector["id"] for vector in vectors], "Result IDs or their order do not match inputs")
        except (AssertionError, json.JSONDecodeError) as error:
            fail("worker-protocol", error)
        else:
            for vector, want, row in zip(vectors, expected, rows):
                try:
                    verify(row.get("ok") is True, "Candidate threw: " + str(row.get("error")))
                    verify(row.get("return_type") == "boolean", "Candidate must return a boolean")
                    verify(type(row.get("value")) is bool and row["value"] is want, "Incorrect expiry result")
                    verify(row.get("entry_unchanged") is True, "Candidate mutated the supplied entry")
                    verify(row.get("now_unchanged") is True, "Candidate mutated the supplied Date")
                except AssertionError as error:
                    fail(vector["id"], error)

    success = failed_checks == 0
    print(json.dumps({"case_id": CASE_ID, "status": "pass" if success else "fail",
                      "functional_success": success, "assertions": assertions, "errors": errors,
                      "failed_checks": failed_checks, "cases": len(vectors),
                      "worker_command": worker_command}))
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
