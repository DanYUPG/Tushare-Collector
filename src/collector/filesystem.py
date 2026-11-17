from __future__ import annotations

import base64
import errno
import logging
import os
from functools import lru_cache
from pathlib import Path, PurePath

LOGGER = logging.getLogger(__name__)
IS_WINDOWS = os.name == "nt"


def compact_identifier(value: str) -> str:
    return base64.b32encode(bytes.fromhex(value)).decode("ascii").rstrip("=").lower()


def ensure_path_length(path: PurePath):
    if not IS_WINDOWS or str(path).startswith("\\\\?\\"):
        return
    size = len(str(path).encode("utf-16-le")) // 2
    parent_size = len(str(path.parent).encode("utf-16-le")) // 2
    if size < 260 and parent_size < 248:
        return
    from .windows_files import long_paths_enabled

    if not long_paths_enabled():
        raise OSError(
            errno.ENAMETOOLONG,
            "生成路径超过 Windows 传统长度限制，请缩短控制 / 导出目录，或启用 Windows 长路径并重启程序",
            str(path),
        )


@lru_cache(maxsize=1)
def _windows_directory_sync_notice():
    LOGGER.warning(
        "Windows 不提供 POSIX 目录 fsync；文件发布采用文件刷新和 WRITE_THROUGH 移动，"
        "但不保证与 POSIX 目录同步相同的断电持久性。请保留数据备份。"
    )


def sync_directory(path: Path):
    if IS_WINDOWS:
        if not path.is_dir():
            raise NotADirectoryError(str(path))
        _windows_directory_sync_notice()
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_move(source: Path, destination: Path, *, replace: bool = False):
    if IS_WINDOWS:
        from .windows_files import move_file

        ensure_path_length(destination)
        if source.is_dir():
            for directory, _, filenames in os.walk(source):
                for filename in filenames:
                    ensure_path_length(destination / Path(directory).relative_to(source) / filename)
        move_file(source, destination, replace=replace)
    elif replace:
        source.replace(destination)
    else:
        source.rename(destination)
