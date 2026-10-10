from __future__ import annotations

import sys

import soc_log
from soc_config import ConfigurationError
from soc_operations import settings
from soc_operations.service import OperationsService
from soc_supervision.process import run

CONFIGURATION_REFUSED = 2

log = soc_log.get("soc_operations")


def main() -> int:
    soc_log.configure(settings.SERVICE)
    try:
        loaded = settings.load()
    except ConfigurationError as refusal:
        log.critical("configuration_refused", problems=refusal.problems)
        return CONFIGURATION_REFUSED
    return run(OperationsService(loaded).run)


if __name__ == "__main__":
    sys.exit(main())
