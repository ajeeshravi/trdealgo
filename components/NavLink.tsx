"use client";
import Link, { type LinkProps } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { forwardRef, useCallback, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { cn } from "@/lib/utils";

type NavLinkProps = Omit<LinkProps, "href"> &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    to: string;
    end?: boolean;
    className?: string;
    activeClassName?: string;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  };

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(
  ({ to, end, className, activeClassName, children, onMouseEnter, onFocus, ...rest }, ref) => {
    const pathname = usePathname() || "/";
    const router = useRouter();
    const isActive = end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
    // In dev mode Link doesn't auto-prefetch — kick a prefetch on hover/focus
    // so the route bundle is compiled before the click lands.
    const warm = useCallback(() => {
      try { router.prefetch(to); } catch { /* ignore */ }
    }, [router, to]);
    const handleEnter = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
      warm();
      onMouseEnter?.(e);
    }, [warm, onMouseEnter]);
    const handleFocus = useCallback((e: React.FocusEvent<HTMLAnchorElement>) => {
      warm();
      onFocus?.(e);
    }, [warm, onFocus]);
    return (
      <Link
        ref={ref}
        href={to}
        prefetch
        className={cn(className, isActive && activeClassName)}
        data-active={isActive || undefined}
        onMouseEnter={handleEnter}
        onFocus={handleFocus}
        {...rest}
      >
        {children}
      </Link>
    );
  },
);
NavLink.displayName = "NavLink";
