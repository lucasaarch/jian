export default function App() {
  return (
    <main className="shell">
      <section aria-labelledby="welcome-title" className="welcome">
        <p className="eyebrow">Jian · Desktop</p>
        <h1 id="welcome-title">A native home for Jian.</h1>
        <p className="description">
          The React renderer is running inside a Tauri window, with Jian’s local Rust gateway
          starting alongside it. Product screens are the next integration.
        </p>
        <p className="status" role="status">
          Local gateway is starting
        </p>
      </section>
    </main>
  );
}
