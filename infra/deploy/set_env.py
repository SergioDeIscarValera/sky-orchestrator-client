#!/usr/bin/env python3
"""Set one value in an env file from stdin, so the value is never on a command line or a screen.

Usage, on the mini-PC, as the user who owns the file:
    printf '%s\\n' "$value" | python3 infra/deploy/set_env.py soc-cloud.env SOC_SUPABASE_URL
    openssl rand -hex 24 | python3 infra/deploy/set_env.py migrate.env SOC_DB_PASSWORD_SOC_CLOUD

The file must hold exactly one KEY= line. That line becomes KEY=<the first line of stdin>,
keeping its line ending; every other line stays byte for byte, and the file keeps its mode.
It is replaced through a temporary file in its folder, so a failure leaves it whole.

Refused, changing nothing: a key that is not a variable name, a file without the line or
with more than one, an empty value, or a value holding a quote, a space, a '#' or a '$',
which the env file would not read back as written. The value is never printed.

Exit status: 0 when the line was set, 1 when refused.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from deploy import write_atomically

KEY = re.compile(r"[A-Z_][A-Z0-9_]*")
# What an env file reads back as written, unquoted: no quotes, blanks, comments or
# interpolation. Percent-encoding (a DSN's password) and base64's '+', '/' and '=' pass.
VALUE = re.compile(r"[^\s'\"#$\\`]+")


class RefusedError(Exception):
    """The reason nothing was changed. Its text never holds the value."""


def with_value(content: bytes, key: str, value: str) -> bytes:
    prefix = re.compile(rb"[ \t]*(?:export[ \t]+)?" + re.escape(key.encode()) + rb"[ \t]*=")
    lines = content.splitlines(keepends=True)
    matches = [index for index, line in enumerate(lines) if prefix.match(line)]
    if len(matches) != 1:
        found = "no" if not matches else f"{len(matches)}"
        raise RefusedError(
            f"refused: nothing was changed. The file has {found} {key}= lines, not one"
        )
    index = matches[0]
    ending = lines[index][len(lines[index].rstrip(b"\r\n")) :]
    lines[index] = f"{key}={value}".encode() + ending
    return b"".join(lines)


def read_value(stream: str) -> str:
    value = stream.splitlines()[0] if stream else ""
    if not value:
        raise RefusedError("refused: nothing was changed. stdin held no value")
    if VALUE.fullmatch(value) is None:
        raise RefusedError(
            "refused: nothing was changed. The value holds a quote, a blank, a '#', a '$', a "
            "backslash or a backquote, which the env file would not read back as written"
        )
    return value


def set_env(path: Path, key: str, stream: str) -> None:
    if KEY.fullmatch(key) is None:
        raise RefusedError(f"refused: nothing was changed. {key!r} is not a variable name")
    value = read_value(stream)
    try:
        content = path.read_bytes()
    except OSError as error:
        raise RefusedError(f"refused: nothing was changed. Cannot read {path}: {error}") from error
    try:
        write_atomically(path, with_value(content, key, value))
    except OSError as error:
        raise RefusedError(f"refused: nothing was changed. Cannot write {path}: {error}") from error


def main(argv: list[str] | None = None) -> int:
    command = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    command.add_argument("file", type=Path, help="the env file, such as soc-cloud.env")
    command.add_argument("key", help="the variable, such as SOC_SUPABASE_SERVICE_ROLE_KEY")
    arguments = command.parse_args(argv)
    try:
        set_env(arguments.file, arguments.key, sys.stdin.read())
    except RefusedError as refusal:
        print(f"{arguments.file}: {refusal}", file=sys.stderr)
        return 1
    print(f"{arguments.file}: {arguments.key} set")
    return 0


if __name__ == "__main__":
    sys.exit(main())
