from __future__ import annotations

import base64

import pytest

from soc_migrate.migrations import MigrationError
from soc_migrate.roles import SERVICE_ROLES, RolePassword, role_passwords, scram_sha_256

POSTGRES_VERIFIER = (
    "SCRAM-SHA-256$4096:9NvzxX6guYPADHYWbtTktA==$"
    "PxaMSgKPDynz474sxcr6yQaUaIqpbBEOnbYDLhTdLas=:ZJGvcPtrEXK5i5knmTynohXRJ7B+Keq5BPUayqQgGhw="
)
POSTGRES_PASSWORD = "CorrectHorseBatteryStaple0123456789abcd"  # gitleaks:allow (a test vector)
STRONG = "a" * 16 + "B" * 8 + "0123456789"


def test_the_verifier_equals_the_one_postgres_computed() -> None:
    salt = base64.b64decode(POSTGRES_VERIFIER.split("$")[1].split(":")[1])
    assert scram_sha_256(POSTGRES_PASSWORD, salt) == POSTGRES_VERIFIER


def test_the_password_never_appears_in_its_representation() -> None:
    password = RolePassword("soc_cloud", STRONG)
    assert STRONG not in repr(password)
    assert STRONG not in password.verifier(b"0123456789abcdef")


def test_every_service_role_gets_its_password() -> None:
    environment = dict.fromkeys(SERVICE_ROLES.values(), STRONG)
    assert [password.role for password in role_passwords(environment)] == list(SERVICE_ROLES)


def test_a_missing_password_is_refused_by_name() -> None:
    environment = {"SOC_DB_PASSWORD_SOC_CLOUD": STRONG}
    with pytest.raises(MigrationError, match="SOC_DB_PASSWORD_SOC_OPERATIONS is not set"):
        role_passwords(environment)


@pytest.mark.parametrize("weak", ["short", "a" * 31, "a" * 40 + "!", "a" * 40 + " "])
def test_a_weak_password_is_refused(weak: str) -> None:
    environment = dict.fromkeys(SERVICE_ROLES.values(), weak)
    with pytest.raises(MigrationError, match="at least 32 letters and digits"):
        role_passwords(environment)
