from __future__ import annotations

import json
from pathlib import Path

PERMISSIONS = json.loads(Path(__file__).with_name("permissions.json").read_text(encoding="utf-8"))
ACCESS = {entry["id"]: entry for entry in PERMISSIONS["entries"]}
API_ACCESS = {entry["api_name"]: entry for entry in PERMISSIONS["entries"]}
DEFAULT_RPM = 500


def effective_rpm(entry_id: str, task_rpm: int, global_rpm: int) -> int:
    return min(task_rpm, global_rpm, ACCESS[entry_id]["configured_rpm"])


def permission_summary(access: dict) -> str:
    kind = access["permission_kind"]
    if kind == "independent":
        requirement = f"须独立开通“{access['independent_permission']}”，8000积分不包含该授权"
    elif kind == "undocumented":
        requirement = "官网未公布最低积分，权限未核实"
    else:
        requirement = f"最低 {access['minimum_points']} 积分；当前声明为8000积分"
        if access["account_access"] == "insufficient_points":
            requirement += "，积分不足"
        elif kind == "derived":
            requirement += "；实际额度按SDK子接口执行"
    frequency = (
        f"接口频率 {access['documented_rpm']} 次/分钟"
        if access["documented_rpm"]
        else f"8000档频率未公布，本地保守限制 {access['configured_rpm']} 次/分钟"
    )
    quota = ""
    if access["daily_limit"]:
        quota = f"；日额度 {access['daily_limit']} 次，本采集器按滚动24小时保守计数"
    return f"{requirement}；{frequency}{quota}。积分符合不代表已验证账号授权。"
