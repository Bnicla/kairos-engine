/**
 * Instant navigation feedback for every route (App Router streams this while
 * the server component fetches from Drive). Without it a click showed nothing
 * for seconds, which read as "broken", not "loading".
 */
export default function Loading() {
  return (
    <main>
      <div className="hero">
        <div className="skeleton" style={{ width: "45%", height: "2rem" }} />
        <div className="skeleton" style={{ width: "70%", height: "1rem", marginTop: "0.8rem" }} />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="card">
          <div className="skeleton" style={{ width: "30%", height: "1.1rem" }} />
          <div className="skeleton" style={{ width: "85%", height: "0.85rem", marginTop: "0.7rem" }} />
          <div className="skeleton" style={{ width: "60%", height: "0.85rem", marginTop: "0.45rem" }} />
        </div>
      ))}
    </main>
  );
}
