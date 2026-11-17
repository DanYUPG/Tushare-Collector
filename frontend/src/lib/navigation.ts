import { normalizeWorkspaceHash } from "./helpers";
import type { NavTab } from "../types";

export function readLocationState(): URLSearchParams {
  return new URLSearchParams(normalizeWorkspaceHash(window.location.hash));
}

export function workspaceView(params: URLSearchParams): NavTab {
  switch (params.get("view")) {
    case "needs": return "needs";
    case "warehouse": return "warehouse";
    case "local-data": return "local-data";
    case "runs": return "runs";
    case "custom": return "custom";
    case "permissions": return "permissions";
    case "datasets": return "datasets";
    default: return "needs";
  }
}

export function patchLocationState(
  patch: Record<string, string | null>,
  mode: "push" | "replace" = "replace",
): void {
  const params = readLocationState();
  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const hash = `#${normalizeWorkspaceHash(params.toString())}`;
  if (hash === window.location.hash) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", hash);
  window.dispatchEvent(new Event("collector:navigation"));
}
