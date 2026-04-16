import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Kiln — Dependency Upgrade Automation",
  description:
    "Kiln reads vendor changelogs, identifies breaking changes against your codebase, and applies mechanical patches — so your team ships upgrade PRs instead of accumulating dep debt.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-neutral-50 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
