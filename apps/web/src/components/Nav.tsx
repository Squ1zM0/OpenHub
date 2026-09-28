"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Home" },
  { href: "/chat", label: "Chat" },
  { href: "/connect/deepseek", label: "Connect" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: "#fff",
        borderBottom: "1px solid #e5e5e5",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "10px 12px",
        paddingTop: "max(10px, env(safe-area-inset-top))",
      }}
    >
      {links.map((link) => {
        const active =
          link.href === "/"
            ? pathname === "/"
            : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: active ? 600 : 400,
              color: active ? "#111" : "#666",
              background: active ? "#f0f0f0" : "transparent",
              textDecoration: "none",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
