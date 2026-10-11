from __future__ import annotations

import sys

import soc_log
from soc_cloud import settings
from soc_cloud.service import CloudService
from soc_config import ConfigurationError
from soc_supervision.process import run

CONFIGURATION_REFUSED = 2

log = soc_log.get("soc_cloud")


def main() -> int:
    soc_log.configure(settings.SERVICE)
    try:
        loaded = settings.load()
    except ConfigurationError as refusal:
        log.critical("configuration_refused", problems=refusal.problems)
        return CONFIGURATION_REFUSED
    return run(CloudService(loaded).run)


if __name__ == "__main__":
    sys.exit(main())
