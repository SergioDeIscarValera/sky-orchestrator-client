from __future__ import annotations

import base64
import hashlib
import hmac
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from soc_migrate.migrations import MigrationError

SERVICE_ROLES = {
    "soc_cloud": "SOC_DB_PASSWORD_SOC_CLOUD",
    "soc_operations": "SOC_DB_PASSWORD_SOC_OPERATIONS",
}
MIN_PASSWORD_LENGTH = 32
PASSWORD_PATTERN = re.compile(r"^[A-Za-z0-9]+$")
SCRAM_ITERATIONS = 4096


def scram_sha_256(password: str, salt: bytes, iterations: int = SCRAM_ITERATIONS) -> str:
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    client_key = hmac.digest(salted, b"Client Key", "sha256")
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.digest(salted, b"Server Key", "sha256")

    def encoded(value: bytes) -> str:
        return base64.b64encode(value).decode("ascii")

    return f"SCRAM-SHA-256${iterations}:{encoded(salt)}${encoded(stored_key)}:{encoded(server_key)}"


@dataclass(frozen=True)
class RolePassword:
    role: str
    password: str = field(repr=False)

    def verifier(self, salt: bytes) -> str:
        return scram_sha_256(self.password, salt)


def role_passwords(environment: Mapping[str, str]) -> list[RolePassword]:
    passwords: list[RolePassword] = []
    for role, variable in SERVICE_ROLES.items():
        password = environment.get(variable, "")
        if not password:
            raise MigrationError(f"{variable} is not set: {role} cannot log in without it")
        if len(password) < MIN_PASSWORD_LENGTH or PASSWORD_PATTERN.match(password) is None:
            raise MigrationError(
                f"{variable} must be at least {MIN_PASSWORD_LENGTH} letters and digits"
            )
        passwords.append(RolePassword(role, password))
    return passwords
