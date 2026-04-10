import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "spastic // cost",
  description: "Real-time cost dashboard for the spastic agent team",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
