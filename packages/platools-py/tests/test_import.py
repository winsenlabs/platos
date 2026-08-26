import platools


def test_version_is_exported() -> None:
    # Python package versions are explicit because Changesets only manages npm.
    assert platools.__version__ == "1.0.0"
