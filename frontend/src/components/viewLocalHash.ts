import { useCallback, useEffect, useRef, useState } from "react";

// Local filters never change the parent's route or add history entries.
export function useViewLocalHash(view: "warehouse" | "local-data", prefix: "wh_" | "raw_") {
  const read = useCallback(() => {
    const all = new URLSearchParams(window.location.hash.slice(1));
    const local = new URLSearchParams();
    if (all.get("view") === view) {
      all.forEach((value, key) => {
        if (key.startsWith(prefix)) local.set(key.slice(prefix.length), value);
      });
    }
    return local;
  }, [view, prefix]);
  const [params, setParams] = useState(read);
  const observed = useRef(params.toString());

  useEffect(() => {
    const restore = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).get("view") !== view) return;
      const next = read();
      if (observed.current !== next.toString()) {
        observed.current = next.toString();
        setParams(next);
      }
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    window.addEventListener("collector:navigation", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("collector:navigation", restore);
    };
  }, [read, view]);

  const replace = useCallback((patch: Record<string, string | null>) => {
    const url = new URL(window.location.href);
    const all = new URLSearchParams(url.hash.slice(1));
    if (all.get("view") !== view) return;
    for (const [key, value] of Object.entries(patch)) {
      if (value) all.set(`${prefix}${key}`, value);
      else all.delete(`${prefix}${key}`);
    }
    url.hash = all.toString();
    window.history.replaceState(window.history.state, "", url);
    observed.current = read().toString();
  }, [view, prefix, read]);

  return { params, replace };
}
