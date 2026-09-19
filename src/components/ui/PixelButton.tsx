"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";

type Variant = "primary" | "dark" | "ghost" | "gold";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-coral text-white",
  dark: "bg-ink text-gold",
  ghost: "bg-card text-ink",
  gold: "bg-gold text-ink",
};

interface Common {
  variant?: Variant;
  className?: string;
  children: ReactNode;
  /** Adds the chunky 6px offset shadow used on step-advancing buttons. */
  raised?: boolean;
}

export function PixelButton({
  variant = "primary",
  className = "",
  raised = false,
  children,
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`disp px-press inline-flex cursor-pointer items-center justify-center border-[3px] border-ink text-[11px] ${VARIANTS[variant]} ${raised ? "px-shadow border-4" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

export function PixelLink({
  href,
  variant = "primary",
  className = "",
  raised = false,
  children,
}: Common & { href: string }) {
  return (
    <Link
      href={href}
      className={`disp px-press inline-flex items-center justify-center border-[3px] border-ink text-[11px] no-underline ${VARIANTS[variant]} ${raised ? "px-shadow border-4" : ""} ${className}`}
    >
      {children}
    </Link>
  );
}
