"use client";
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Minimal shadcn-compatible Select.
 *
 * Backed by a native <select> for zero runtime weight and no extra dep.
 * Accepts the same JSX shape as the @radix-based shadcn Select:
 *
 *   <Select value={v} onValueChange={setV}>
 *     <SelectTrigger className="…"><SelectValue /></SelectTrigger>
 *     <SelectContent>
 *       <SelectItem value="A">A</SelectItem>
 *     </SelectContent>
 *   </Select>
 *
 * SelectTrigger / SelectValue / SelectContent / SelectItem render
 * nothing themselves — they're walked at render time so the items can
 * be placed inside the native <select>, and the trigger's className
 * applied to the visible element.
 */

type SelectProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  children: React.ReactNode;
};

type WalkResult = {
  options: React.ReactNode[];
  triggerCls?: string;
};

function walkChildren(nodes: React.ReactNode, acc: WalkResult) {
  React.Children.forEach(nodes, (child) => {
    if (!React.isValidElement(child)) return;
    const dn = (child.type as any)?.displayName;
    if (dn === "SelectItem") {
      const v = (child.props as any).value;
      acc.options.push(
        <option key={v} value={v}>
          {(child.props as any).children}
        </option>,
      );
      return;
    }
    if (dn === "SelectTrigger") {
      const cls = (child.props as any).className;
      if (cls && !acc.triggerCls) acc.triggerCls = cls;
    }
    if ((child.props as any)?.children) walkChildren((child.props as any).children, acc);
  });
}

export function Select({ value, defaultValue, onValueChange, children }: SelectProps) {
  const [internal, setInternal] = React.useState<string | undefined>(defaultValue);
  const current = value ?? internal;

  const acc: WalkResult = { options: [] };
  walkChildren(children, acc);

  return (
    <div className="relative inline-flex h-full w-full items-center">
      <select
        value={current ?? ""}
        onChange={(e) => {
          if (value === undefined) setInternal(e.target.value);
          onValueChange?.(e.target.value);
        }}
        className={cn(
          "h-full w-full appearance-none rounded-md border border-input bg-background pl-3 pr-8 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          acc.triggerCls,
        )}
      >
        {acc.options}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-4 w-4 opacity-50" />
    </div>
  );
}

export function SelectTrigger(_props: { className?: string; children?: React.ReactNode }) {
  return null;
}
SelectTrigger.displayName = "SelectTrigger";

export function SelectValue(_props: { placeholder?: string }) {
  return null;
}
SelectValue.displayName = "SelectValue";

export function SelectContent({ children: _children }: { children: React.ReactNode }) {
  return null;
}
SelectContent.displayName = "SelectContent";

export function SelectItem(_props: { value: string; children: React.ReactNode }) {
  return null;
}
SelectItem.displayName = "SelectItem";
