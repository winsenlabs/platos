import platools


def test_version_is_exported() -> None:
    # Bumped to 0.2.0 (2026-05-06): first publishable version with audited
    # `_context` envelope handling. Pinned literal here so a stale
    # pyproject.toml / __init__.py drift is caught by CI.
    assert platools.__version__ == "0.2.0"
