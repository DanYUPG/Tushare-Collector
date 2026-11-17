from __future__ import annotations

import msvcrt
import os
import time
import winreg
from functools import lru_cache
from pathlib import Path

import ntsecuritycon
import pywintypes
import win32api
import win32con
import win32file
import win32security
import winerror


@lru_cache(maxsize=1)
def long_paths_enabled():
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\FileSystem",
        ) as key:
            value, kind = winreg.QueryValueEx(key, "LongPathsEnabled")
    except FileNotFoundError:
        return False
    return kind == winreg.REG_DWORD and value == 1


def current_user_sid():
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        return win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()


def _private_attributes(user):
    acl = win32security.ACL()
    acl.AddAccessAllowedAce(win32security.ACL_REVISION, ntsecuritycon.FILE_ALL_ACCESS, user)
    descriptor = win32security.SECURITY_DESCRIPTOR()
    descriptor.SetSecurityDescriptorOwner(user, False)
    descriptor.SetSecurityDescriptorDacl(True, acl, False)
    descriptor.SetSecurityDescriptorControl(win32security.SE_DACL_PROTECTED, win32security.SE_DACL_PROTECTED)
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = descriptor
    attributes.bInheritHandle = False
    return attributes


def _check_private_handle(handle, user):
    info = win32file.GetFileInformationByHandle(handle)
    if info[0] & (win32con.FILE_ATTRIBUTE_REPARSE_POINT | win32con.FILE_ATTRIBUTE_DIRECTORY) or info[7] != 1:
        raise PermissionError("本地凭证文件不能是链接、重解析点或目录")
    descriptor = win32security.GetSecurityInfo(
        handle, win32security.SE_FILE_OBJECT,
        win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION,
    )
    acl = descriptor.GetSecurityDescriptorDacl()
    control, _ = descriptor.GetSecurityDescriptorControl()
    if (
        descriptor.GetSecurityDescriptorOwner() != user or acl is None or acl.GetAceCount() != 1
        or not control & win32security.SE_DACL_PROTECTED
    ):
        raise PermissionError("本地凭证文件的所有者或专属 ACL 不正确")
    ace = acl.GetAce(0)
    if (
        len(ace) != 3 or ace[0] != (win32security.ACCESS_ALLOWED_ACE_TYPE, 0)
        or ace[1] != ntsecuritycon.FILE_ALL_ACCESS or ace[2] != user
    ):
        raise PermissionError("本地凭证文件必须仅允许当前用户访问")


def private_file(path: Path, *, create: bool = False):
    created = opened = False
    try:
        user = current_user_sid()
        access = win32con.GENERIC_READ | win32con.READ_CONTROL
        if create:
            access |= win32con.GENERIC_WRITE
        handle = win32file.CreateFile(
            str(path), access, 0, _private_attributes(user) if create else None,
            win32con.CREATE_NEW if create else win32con.OPEN_EXISTING,
            win32file.FILE_FLAG_OPEN_REPARSE_POINT, None,
        )
        created = create
        try:
            _check_private_handle(handle, user)
            descriptor = msvcrt.open_osfhandle(
                int(handle), os.O_BINARY | (os.O_RDWR if create else os.O_RDONLY),
            )
            handle.Detach()
            try:
                stream = os.fdopen(descriptor, "w+b" if create else "rb")
                opened = True
                return stream
            except BaseException:
                os.close(descriptor)
                raise
        finally:
            handle.Close()
    except pywintypes.error as error:
        raise OSError(error.winerror, error.strerror, str(path), error.winerror) from None
    finally:
        if created and not opened:
            path.unlink(missing_ok=True)


def move_file(source: Path, destination: Path, *, replace: bool):
    flags = win32file.MOVEFILE_WRITE_THROUGH
    if replace:
        flags |= win32file.MOVEFILE_REPLACE_EXISTING
    deadline = time.monotonic() + 1
    while True:
        try:
            win32file.MoveFileEx(str(source), str(destination), flags)
            return
        except pywintypes.error as error:
            if (
                error.winerror not in {winerror.ERROR_SHARING_VIOLATION, winerror.ERROR_LOCK_VIOLATION}
                or time.monotonic() >= deadline
            ):
                raise OSError(error.winerror, error.strerror, str(destination), error.winerror) from None
            time.sleep(0.05)
