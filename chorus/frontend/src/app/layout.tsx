import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'chorus — feedback intelligence',
  description: 'Review proposed links between customer feedback and Linear backlog entries.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-1.5 focus:text-sm focus:shadow"
        >
          Skip to content
        </a>
        <header className="border-b surface-border">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <a href="/" className="text-lg font-semibold" aria-label="chorus home">
              chorus
            </a>
            <nav aria-label="Primary" className="flex items-center gap-3 text-sm">
              <a className="opacity-70 hover:opacity-100" href="/">
                Proposals
              </a>
            </nav>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
