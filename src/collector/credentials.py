import os
import stat
import tempfile
from pathlib import Path

from .artifacts import sync_directory
from .models import CollectorError


def checked_token(value: str) -> str:
    token = value.strip()
    if not token or len(token) > 512 or any(character.isspace() for character in token):
        raise CollectorError("Token 须为不含空白字符的 1–512 位文本")
    return token


class CredentialStore:
    def __init__(self, root: Path):
        self.path = root / ".tushare-token"

    def load(self) -> str:
        try:
            descriptor = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return ""
        except OSError as error:
            raise CollectorError(
                f"无法读取本地凭证文件（{type(error).__name__}），请检查文件及权限"
            ) from None
        try:
            with os.fdopen(descriptor, "rb") as stream:
                info = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600
                ):
                    raise CollectorError("本地凭证必须为当前用户独占的普通文件，权限须为 600")
                content = stream.read(4097)
            if len(content) > 4096:
                raise CollectorError("本地凭证文件过大，请重新配置")
            return checked_token(content.decode("utf-8"))
        except (OSError, UnicodeError) as error:
            raise CollectorError(f"无法读取本地凭证文件（{type(error).__name__}），请重新配置") from None

    def save(self, token: str):
        token = checked_token(token)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent,
                prefix=".tushare-token.", delete=False,
            ) as stream:
                temporary = Path(stream.name)
                os.fchmod(stream.fileno(), 0o600)
                stream.write(token + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.path)
            sync_directory(self.path.parent)
        except OSError as error:
            raise CollectorError(f"本地凭证保存失败（{type(error).__name__}），请检查目录及权限") from None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def clear(self):
        try:
            self.path.unlink(missing_ok=True)
            sync_directory(self.path.parent)
        except OSError as error:
            raise CollectorError(f"本地凭证清除失败（{type(error).__name__}），请检查目录及权限") from None
