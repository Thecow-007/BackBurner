/**
 * The application shell. Round C replaces this with the real router + shell;
 * for Gate A it exists so the app boots to an empty, honest surface rather
 * than a blank page.
 */
import { useAuth, useConnection } from "./store/react.js";

export function App(): React.ReactElement {
  const { status } = useAuth();
  const connection = useConnection();

  return (
    <main
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "100vh",
        padding: "var(--s-9)",
      }}
    >
      <div style={{ display: "grid", gap: "var(--s-4)", justifyItems: "center" }}>
        <div
          aria-hidden="true"
          style={{
            width: 8,
            height: 22,
            borderRadius: 1,
            background: "linear-gradient(180deg, var(--ember-hi), var(--ember))",
          }}
        />
        <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.01em" }}>BackBurner</div>
        <div className="micro">
          shell · auth {status} · stream {connection}
        </div>
      </div>
    </main>
  );
}
