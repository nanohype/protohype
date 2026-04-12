'use client';
import Link from 'next/link';
import AuthGate from './auth-gate';
import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>MCP Gateway — Cost Dashboard</title>
        <meta name="description" content="Real-time token usage and API spend tracking for Claude managed agents" />
      </head>
      <body className="min-h-screen bg-gray-950 text-gray-100 font-mono">
        <nav className="border-b border-gray-800 px-6 py-3 flex items-center gap-4">
          <span className="text-orange-400 font-bold tracking-tight">MCP Gateway</span>
          <span className="text-gray-600 text-sm">Cost Dashboard</span>
          <div className="ml-auto flex gap-4 text-sm text-gray-400">
            <Link href="/" className="hover:text-white transition-colors">Summary</Link>
            <Link href="/agents" className="hover:text-white transition-colors">Agents</Link>
            <Link href="/workflows" className="hover:text-white transition-colors">Workflows</Link>
            <Link href="/sessions" className="hover:text-white transition-colors">Sessions</Link>
            <Link href="/budget" className="hover:text-white transition-colors">Budget</Link>
          </div>
        </nav>
        <main className="p-6">
          <AuthGate>{children}</AuthGate>
        </main>
      </body>
    </html>
  );
}
