"use client";
/**
 * Recursive expression editor — Phase D math layer.
 *
 * Wraps an `Expr` value into a small visual tree. The current expression
 * can be one of four shapes:
 *
 *   - **Indicator**  — passes through to <IndicatorExprEditor>
 *   - **Constant**   — single number input
 *   - **Binary op**  — `+`, `-`, `×`, `÷` on two sub-expressions (each is
 *                     itself an <ArithExprEditor>, so trees nest)
 *   - **Function**   — `sqrt`, `abs` on one sub-expression
 *
 * The "kind" selector at the top lets the user reshape the current node;
 * when wrapping into a binary/function, we keep the previous expression as
 * the `a` / first arg so the user's work isn't lost on mode flip.
 */
import {
  BinaryOpExpr,
  Expr,
  FunctionExpr,
  IndicatorExpr,
  defaultIndicatorExpr,
  exprKindOf,
  wrapInBinary,
  wrapInFunction,
} from "@/components/strategy/types";
import { IndicatorExprEditor } from "@/components/strategy/IndicatorExprEditor";

type Kind = "indicator" | "constant" | "+" | "-" | "*" | "/" | "sqrt" | "abs";

const KIND_LABEL: Record<Kind, string> = {
  indicator: "Indicator",
  constant:  "Constant",
  "+":       "a + b",
  "-":       "a − b",
  "*":       "a × b",
  "/":       "a ÷ b",
  sqrt:      "sqrt(x)",
  abs:       "abs(x)",
};

/** Default to render when the user picks a new kind. Preserves the prior
 *  expression as the leading operand so a chain of mode-switches doesn't
 *  blow away work. */
function freshOfKind(kind: Kind, prev: Expr): Expr {
  switch (kind) {
    case "indicator":
      return defaultIndicatorExpr("ema");
    case "constant":
      return { value: 0 };
    case "+":
    case "-":
    case "*":
    case "/":
      return wrapInBinary(prev, kind);
    case "sqrt":
    case "abs":
      return wrapInFunction(prev, kind);
  }
}

interface Props {
  value: Expr;
  symbols: string[];
  onChange: (next: Expr) => void;
  /** Visual nesting depth — used to flatten the chrome on deep trees so
   *  the editor doesn't drown in borders. */
  depth?: number;
}

export function ArithExprEditor({ value, symbols, onChange, depth = 0 }: Props) {
  const kind = exprKindOf(value) as Kind;

  function switchKind(next: Kind) {
    if (next === kind) return;
    onChange(freshOfKind(next, value));
  }

  // Render shell — thin border on outer node, no border on nested ones to
  // keep deep trees readable. Inner contents indent slightly per level.
  const chrome =
    depth === 0
      ? "rounded-md border border-border/60 bg-panel2/30 p-2 space-y-2"
      : "pl-2 space-y-2 border-l border-border/40 ml-1";

  return (
    <div className={chrome}>
      <div className="flex items-center gap-1.5">
        <select
          className="input h-8 text-xs"
          value={kind}
          onChange={(e) => switchKind(e.target.value as Kind)}
        >
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      {kind === "indicator" && (
        <IndicatorExprEditor
          value={value as IndicatorExpr}
          symbols={symbols}
          onChange={(v) => onChange(v)}
        />
      )}

      {kind === "constant" && (
        <input
          className="input"
          type="number"
          step="any"
          value={(value as { value: number }).value}
          onChange={(e) => onChange({ value: Number(e.target.value) })}
        />
      )}

      {(kind === "+" || kind === "-" || kind === "*" || kind === "/") && (
        <BinaryEditor
          value={value as BinaryOpExpr}
          symbols={symbols}
          onChange={onChange}
          depth={depth}
        />
      )}

      {(kind === "sqrt" || kind === "abs") && (
        <FunctionEditor
          value={value as FunctionExpr}
          symbols={symbols}
          onChange={onChange}
          depth={depth}
        />
      )}
    </div>
  );
}

function BinaryEditor({
  value,
  symbols,
  onChange,
  depth,
}: {
  value: BinaryOpExpr;
  symbols: string[];
  onChange: (next: Expr) => void;
  depth: number;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">a</div>
      <ArithExprEditor
        value={value.a}
        symbols={symbols}
        depth={depth + 1}
        onChange={(a) => onChange({ ...value, a })}
      />
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">b</div>
      <ArithExprEditor
        value={value.b}
        symbols={symbols}
        depth={depth + 1}
        onChange={(b) => onChange({ ...value, b })}
      />
    </div>
  );
}

function FunctionEditor({
  value,
  symbols,
  onChange,
  depth,
}: {
  value: FunctionExpr;
  symbols: string[];
  onChange: (next: Expr) => void;
  depth: number;
}) {
  // sqrt/abs are unary today; the args array stays in place so a future
  // min/max addition just renders multiple sub-editors here.
  const arg = value.args[0] ?? { value: 0 };
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">argument</div>
      <ArithExprEditor
        value={arg}
        symbols={symbols}
        depth={depth + 1}
        onChange={(a) => onChange({ ...value, args: [a] })}
      />
    </div>
  );
}
