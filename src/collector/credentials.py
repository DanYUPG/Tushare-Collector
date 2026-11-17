import os
import stat
import uuid
from pathlib import Path

from .filesystem import atomic_move, sync_directory
from .models import CollectorError


def checked_token(value: str) -> str:
    token = value.strip()
    if not token or len(token) > 512 or any(character.isspace() for character in token):
        raise CollectorError("Token 须为不含空白字符的 1–512 位文本")
    return token


class CredentialStore:
    def __init__(self, root: Path):
        self.path = root / ".tushare-token"

    @staticmethod
    def _open(path: Path, *, create: bool = False):
        if os.name == "nt":
            from .windows_files import private_file

            return private_file(path, create=create)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL if create else os.O_RDONLY | os.O_NONBLOCK
        descriptor = os.open(path, flags | os.O_NOFOLLOW, 0o600)
        try:
            if create:
                os.fchmod(descriptor, 0o600)
            return os.fdopen(descriptor, "wb" if create else "rb")
        except BaseException:
            os.close(descriptor)
            if create:
                path.unlink(missing_ok=True)
            raise

    def load(self) -> str:
        try:
            stream = self._open(self.path)
        except FileNotFoundError:
            return ""
        except OSError as error:
            raise CollectorError(
                f"无法读取本地凭证文件（{type(error).__name__}），请检查文件及权限"
            ) from None
        try:
            with stream:
                info = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or (os.name != "nt" and (
                        info.st_nlink != 1 or info.st_uid != os.getuid()
                        or stat.S_IMODE(info.st_mode) != 0o600
                    ))
                ):
                    raise CollectorError("本地凭证必须为当前用户独占的普通文件，POSIX 权限须为 600")
                content = stream.read(4097)
            if len(content) > 4096:
                raise CollectorError("本地凭证文件过大，请重新配置")
            return checked_token(content.decode("utf-8"))
        except (OSError, UnicodeError) as error:
            raise CollectorError(f"无法读取本地凭证文件（{type(error).__name__}），请重新配置") from None

    def save(self, token: str):
        token = checked_token(token)
        temporary = self.path.with_name(f"{self.path.name}.{uuid.uuid4().hex}")
        created = False
        try:
            stream = self._open(temporary, create=True)
            created = True
            with stream:
                stream.write((token + "\n").encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            atomic_move(temporary, self.path, replace=True)
            sync_directory(self.path.parent)
        except OSError as error:
            raise CollectorError(f"本地凭证保存失败（{type(error).__name__}），请检查目录及权限") from None
        finally:
            if created:
                temporary.unlink(missing_ok=True)

    def clear(self):
        try:
            self.path.unlink(missing_ok=True)
            sync_directory(self.path.parent)
        except OSError as error:
            raise CollectorError(f"本地凭证清除失败（{type(error).__name__}），请检查目录及权限") from None
