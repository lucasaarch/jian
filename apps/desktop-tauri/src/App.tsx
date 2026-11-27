export default function App() {
  return (
    <main className="shell">
      <section aria-labelledby="welcome-title" className="welcome">
        <p className="eyebrow">Jian · Desktop</p>
        <h1 id="welcome-title">A native home for Jian.</h1>
        <p className="description">
          The React renderer is running inside a Tauri window. Gateway startup and product screens
          are the next integration.
        </p>
        <p className="status" role="status">
          Native desktop shell ready
        </p>
      </section>
    </main>
  );
}
