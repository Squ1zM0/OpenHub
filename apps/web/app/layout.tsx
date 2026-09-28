import type { ReactNode } from "react";
import { Nav } from "@/src/components/Nav";

export const metadata = { title: "OpenHub" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "ui-sans-serif, system-ui" }}>
        <Nav />
        {/* Offset for the fixed nav. 56px matches nav height + its vertical padding. */}
        <div style={{ paddingTop: 56 }}>{children}</div>
      </body>
    </html>
  );
}
