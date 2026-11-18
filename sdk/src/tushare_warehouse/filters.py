from __future__ import annotations

import math
import operator
from collections.abc import Sequence
from datetime import date, datetime
from numbers import Real

import pyarrow as pa
import pyarrow.dataset as ds

from .errors import SelectionError

COMPARISONS = {
    "==": operator.eq, "!=": operator.ne, ">": operator.gt,
    ">=": operator.ge, "<": operator.lt, "<=": operator.le,
}


def typed_value(value: object, field: pa.Field) -> pa.Scalar:
    kind = field.type
    if pa.types.is_string(kind):
        valid = isinstance(value, str)
    elif pa.types.is_boolean(kind):
        valid = type(value) is bool
    elif pa.types.is_integer(kind):
        valid = type(value) is int
    elif pa.types.is_floating(kind):
        valid = isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)
    elif pa.types.is_timestamp(kind):
        valid = isinstance(value, datetime) and value.tzinfo is None
    elif pa.types.is_date(kind):
        valid = type(value) is date
    else:
        valid = False
    if not valid:
        raise SelectionError(f"{field.name}: expected a non-null {kind} value, got {value!r}")
    try:
        return pa.scalar(value, type=kind)
    except (pa.ArrowException, OverflowError, TypeError, ValueError) as error:
        raise SelectionError(f"{field.name}: invalid {kind} value: {error}") from error


def expression(schema: pa.Schema, filters: Sequence | None) -> ds.Expression | None:
    if filters is None:
        return None
    if not isinstance(filters, (list, tuple)):
        raise SelectionError("filters must be a list of (column, operator, value) conditions joined by AND")
    result = None
    for condition in filters:
        if not isinstance(condition, (list, tuple)) or len(condition) != 3:
            raise SelectionError("each filter must be (column, operator, value)")
        name, operation, value = condition
        if not isinstance(name, str) or name not in schema.names:
            raise SelectionError(f"unknown filter column: {name!r}")
        if not isinstance(operation, str):
            raise SelectionError("filter operator must be a string")
        column, field = ds.field(name), schema.field(name)
        if operation in {"is null", "is not null"}:
            if value is not None:
                raise SelectionError("null tests require None as the third item")
            current = column.is_null() if operation == "is null" else column.is_valid()
        elif operation in {"in", "not in"}:
            if not isinstance(value, (list, tuple)) or not value:
                raise SelectionError("in / not in require a non-empty list or tuple without nulls")
            values = pa.array([typed_value(item, field).as_py() for item in value], type=field.type)
            current = column.isin(values)
            if operation == "not in":
                current = column.is_valid() & ~current
        elif operation in COMPARISONS:
            current = COMPARISONS[operation](column, typed_value(value, field))
        else:
            raise SelectionError(f"unsupported filter operator: {operation!r}")
        result = current if result is None else result & current
    return result
