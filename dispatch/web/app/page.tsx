export default function HomePage() {
  return (
    <main className="page-shell">
      <header className="review-header">
        <h1>Dispatch</h1>
        <p className="muted">
          Weekly newsletter review for the Chief of Staff. Open a draft from the
          Slack notification link, or sign in to view the latest pending draft.
        </p>
      </header>
      <section className="card" style={{ marginTop: 24 }}>
        <h2>Getting here</h2>
        <p>
          Dispatch posts a link into <code>#newsletter-review</code> every
          Friday morning. Click that link to land on the review page for the
          week&apos;s draft.
        </p>
        <p>
          If you landed here directly and aren&apos;t signed in yet, you&apos;ll
          be redirected to sign in automatically.
        </p>
      </section>
    </main>
  );
}
