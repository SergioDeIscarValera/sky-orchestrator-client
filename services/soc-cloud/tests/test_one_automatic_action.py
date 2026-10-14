"""SOC's one autonomous action is return_home on a geofence breach (NFR-SAF-04, FR-SAF-01).

Every code path that publishes on a dock's `services` topic is found through the syntax tree
of soc-cloud's own code: the link's `send_service` is called from the commands alone, for an
intent a member or soc-operations asked for (`_execute`) and for soc-cloud's own command
(`send_now`); and `send_now` is called from the flights alone, with `return_home`, when a
sample is outside its flight's geofence. A new path fails this test until it is named here.
"""

from __future__ import annotations

import ast
from pathlib import Path

import soc_cloud

SOURCE = Path(soc_cloud.__file__).parent


def calls_of(method: str) -> list[tuple[str, str, ast.Call]]:
    """Each call of `method` in soc-cloud's code: its module, the function it is in, the call."""
    found: list[tuple[str, str, ast.Call]] = []
    for path in sorted(SOURCE.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for function in ast.walk(tree):
            if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for node in ast.walk(function):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == method
                ):
                    found.append((path.relative_to(SOURCE).as_posix(), function.name, node))
    return found


def test_only_the_commands_publish_on_a_docks_services_topic() -> None:
    # The topic is named in one place, the link's send_service ...
    naming = sorted({(module, function) for module, function, _ in calls_of("services")})
    assert naming == [("link/stack.py", "send_service")]
    # ... which the commands alone call.
    publishing = sorted({(module, function) for module, function, _ in calls_of("send_service")})
    assert publishing == [("commands.py", "_execute"), ("commands.py", "send_now")]


def test_soc_clouds_own_command_is_a_return_home_on_a_geofence_breach() -> None:
    own = calls_of("send_now")
    assert [(module, function) for module, function, _ in own] == [("flights.py", "_return_home")]
    ((_, _, call),) = own
    verbs = [
        argument.value
        for argument in call.args
        if isinstance(argument, ast.Constant) and isinstance(argument.value, str)
    ]
    assert verbs == ["return_home"]


def test_the_breach_path_is_the_only_one_that_reaches_the_return() -> None:
    """`_return_home` is spawned from the geofence's judgement of an outside sample alone."""
    spawned = [
        (module, function)
        for module, function, call in calls_of("_return_home")
        if isinstance(call.func, ast.Attribute)
    ]
    assert spawned == [("flights.py", "_judge")]
