export default function App() {
  return (
    <main className="shell">
      <section aria-labelledby="welcome-title" className="welcome">
        <p className="eyebrow">Jian</p>
        <h1 id="welcome-title">A home for your agents.</h1>
        <p className="description">
          The Jian panel is ready to connect to the gateway that serves this workspace.
        </p>
        <p className="status" role="status">
          Gateway is starting
        </p>
      </section>
    </main>
  );
}
