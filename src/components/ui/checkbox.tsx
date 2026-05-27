"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "checked"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked = false, onCheckedChange, disabled, ...rest }, ref) => {
    return (
      <span
        className={cn(
          "relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input bg-background transition-colors",
          checked && "border-primary bg-primary text-primary-foreground",
          disabled && "opacity-50 cursor-not-allowed",
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
          {...rest}
        />
        {checked && <Check className="h-3 w-3 pointer-events-none" strokeWidth={3} />}
      </span>
    );
  },
);
Checkbox.displayName = "Checkbox";
