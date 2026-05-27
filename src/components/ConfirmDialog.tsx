"use client";
/**
 * Themed confirmation dialog + `useConfirm()` hook.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "Delete?", message: "Sure?" }))) return;
 *
 * The hook returns a promise that resolves true/false based on which
 * button the user clicks (or false on Esc / backdrop click). One provider
 * (mounted in app/(app)/layout.tsx) serves the whole app.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import clsx from "clsx";

export type ConfirmVariant = "default" | "danger" | "warning";

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Default: "Confirm". */
  confirmLabel?: string;
  /** Default: "Cancel". */
  cancelLabel?: string;
  /** Default: "default". `danger` makes the primary button red. */
  variant?: ConfirmVariant;
  /** If set, the user must type this text exactly to enable Confirm. Used
   *  for destructive actions where typing the strategy name is a sanity
   *  check on top of the click. */
  requireTyped?: string;
}

type Resolver = (value: boolean) => void;

interface PendingState {
  options: ConfirmOptions;
  resolve: Resolver;
}

const ConfirmCtx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) {
    throw new Error("useConfirm() must be used inside <ConfirmProvider>");
  }
  return ctx;
}

const VARIANT_BTN: Record<ConfirmVariant, string> = {
  default: "btn-primary",
  danger:  "btn-danger",
  warning: "btn-primary",
};

const VARIANT_ICON: Record<ConfirmVariant, { glyph: string; cls: string }> = {
  default: { glyph: "?",  cls: "bg-primary/15 text-primary" },
  danger:  { glyph: "⚠", cls: "bg-danger/15 text-danger" },
  warning: { glyph: "⚠", cls: "bg-orange-500/15 text-orange-300" },
};

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);
  const [typed, setTyped] = useState("");
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setTyped("");
      setPending({ options, resolve });
    });
  }, []);

  function close(result: boolean) {
    if (!pending) return;
    pending.resolve(result);
    setPending(null);
    setTyped("");
  }

  // Focus the safer button (Cancel) on open. Users can Tab to Confirm.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => cancelBtnRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [pending]);

  // Keyboard: Esc → cancel; Enter → confirm (unless typed-confirm is incomplete).
  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        const req = pending?.options.requireTyped;
        if (req && typed !== req) return;
        e.preventDefault();
        close(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, typed]);

  const value = useMemo(() => confirm, [confirm]);
  const o = pending?.options;
  const variant: ConfirmVariant = o?.variant ?? "default";
  const requiredText = o?.requireTyped ?? "";
  const typedOk = !requiredText || typed === requiredText;

  return (
    <ConfirmCtx.Provider value={value}>
      {children}
      {pending && o && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-message"
        >
          {/* backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={() => close(false)}
          />
          {/* panel */}
          <div className="relative w-full max-w-md card shadow-xl animate-[fadeIn_0.15s_ease-out]">
            <div className="flex items-start gap-3">
              <div
                className={clsx(
                  "shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-lg",
                  VARIANT_ICON[variant].cls,
                )}
                aria-hidden
              >
                {VARIANT_ICON[variant].glyph}
              </div>
              <div className="flex-1 min-w-0">
                <h2
                  id="confirm-title"
                  className="text-base font-semibold leading-snug pr-6"
                >
                  {o.title}
                </h2>
                {o.message && (
                  <p
                    id="confirm-message"
                    className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap break-words"
                  >
                    {o.message}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="absolute top-3 right-3 text-muted-foreground hover:text-gray-200 text-sm"
                onClick={() => close(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {requiredText && (
              <div className="mt-3 ml-12">
                <div className="label mb-1">
                  Type{" "}
                  <span className="font-mono text-gray-300">{requiredText}</span>{" "}
                  to confirm
                </div>
                <input
                  className="input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}

            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                ref={cancelBtnRef}
                type="button"
                className="btn-outline"
                onClick={() => close(false)}
              >
                {o.cancelLabel ?? "Cancel"}
              </button>
              <button
                ref={confirmBtnRef}
                type="button"
                className={VARIANT_BTN[variant]}
                onClick={() => close(true)}
                disabled={!typedOk}
                title={!typedOk ? `type "${requiredText}" first` : undefined}
              >
                {o.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
