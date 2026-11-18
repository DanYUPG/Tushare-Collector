class WarehouseError(Exception):
    """The warehouse is missing, incompatible, or unreadable."""


class IntegrityError(WarehouseError):
    """Published metadata or a data file failed validation."""


class SelectionError(WarehouseError, ValueError):
    """The requested table, repository, variant, columns, or filters are invalid."""
