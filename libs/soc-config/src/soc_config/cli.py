"""Start a service's configuration file from the contract, or check one.

Usage:
    soc-config example soc-cloud > soc-cloud.json
    soc-config check soc-cloud soc-cloud.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from soc_config.configuration import ConfigurationError, load
from soc_config.contract import Contract


def main(argv: list[str] | None = None, contract: Contract | None = None) -> int:
    contract = contract or Contract.read()
    parser = argparse.ArgumentParser(prog="soc-config", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    example = commands.add_parser("example", help="every key at its default, null where none")
    example.add_argument("consumer", choices=contract.consumers)
    check = commands.add_parser("check", help="refuse or accept a file, printing its fingerprint")
    check.add_argument("consumer", choices=contract.consumers)
    check.add_argument("file", type=Path)
    arguments = parser.parse_args(argv)

    if arguments.command == "example":
        print(json.dumps(contract.starting_file(arguments.consumer), indent=2))
        return 0
    try:
        configuration = load(
            arguments.file.read_text(encoding="utf-8"), arguments.consumer, contract
        )
    except (OSError, ConfigurationError) as error:
        problems = error.problems if isinstance(error, ConfigurationError) else [str(error)]
        print(f"{arguments.file} refused for {arguments.consumer}:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print(f"{configuration.fingerprint}  contract {configuration.contract_version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
