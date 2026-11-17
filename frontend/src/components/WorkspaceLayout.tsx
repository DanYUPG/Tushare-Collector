import clsx from "clsx";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function WorkspaceHeader({title, description, actions}: {
  title: string; description?: string; actions?: ReactNode;
}) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>;
}

export function WorkspaceToolbar({label, children}: {label: string; children: ReactNode}) {
  return <div role="group" aria-label={label}
    className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
    {children}
  </div>;
}

export function WorkspaceDrawer({open, title, description, label, onClose, busy = false, wide = false,
  children, footer, bodyClassName}: {
  open: boolean; title: string; description?: string; label?: string; onClose: () => void;
  busy?: boolean; wide?: boolean; children: ReactNode; footer?: ReactNode; bodyClassName?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const element = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      if (element?.open) element.close();
      if (previousFocus?.isConnected && !document.querySelector("dialog:modal")) previousFocus.focus();
    };
  }, [open]);
  if (!open) return null;

  return <dialog ref={ref} aria-label={label} aria-labelledby={label ? undefined : titleId}
    onCancel={event => {event.preventDefault(); if (!busy) onClose();}}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const dialog = event.currentTarget;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, summary, [tabindex]',
      )).filter(element => element.tabIndex >= 0 && !element.matches(":disabled")
        && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) {event.preventDefault(); dialog.focus(); return;}
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget || busy) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}
    className={clsx(
      "fixed inset-0 m-0 ml-auto h-full max-h-none w-full border-0 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/35",
      wide ? "max-w-4xl" : "max-w-2xl",
    )}>
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-1 text-xs leading-relaxed text-slate-500">{description}</p>}
        </div>
        <button type="button" disabled={busy} onClick={onClose} aria-label={`关闭${label || title}`}
          className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className={bodyClassName ?? "min-h-0 flex-1 space-y-5 overflow-y-auto p-5"}>{children}</div>
      {footer && <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div>}
    </div>
  </dialog>;
}

export function WorkspaceMenu({label = "更多", children}: {label?: string; children: ReactNode}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) {
        ref.current?.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  return <details ref={ref} className="relative"
    onKeyDown={event => {
      if (event.key === "Escape" && ref.current?.open) {
        event.stopPropagation(); ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    }}>
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
      {label}<ChevronDown className="h-3.5 w-3.5" />
    </summary>
    <div role="group" aria-label={label}
      onClick={event => {
        if (event.target instanceof Element && event.target.closest("button")) {
          ref.current?.removeAttribute("open");
          ref.current?.querySelector("summary")?.focus();
        }
      }}
      className="absolute right-0 z-30 mt-1 min-w-52 space-y-1 rounded-xl border border-slate-200 bg-white p-2 text-xs text-slate-700 shadow-lg">
      {children}
    </div>
  </details>;
}
