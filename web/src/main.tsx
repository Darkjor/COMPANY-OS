import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Company } from "./Company.tsx";
import { Project } from "./Project.tsx";
import { Session } from "./Session.tsx";
import "./styles.css";

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** A render error must never blank the whole page — show it and offer a way back. */
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <p>[ERROR] Algo falló al dibujar esta vista: {this.state.error.message}</p>
        <a className="back" href="#/">← Volver a la empresa</a>
      </div>
    );
  }
}

function App() {
  const hash = useHash();
  const session = /^#\/s\/(.+)$/.exec(hash)?.[1];
  const project = /^#\/p\/(.+)$/.exec(hash)?.[1];
  // Braces matter: newer Chromium returns a Promise from scrollTo, and React would call it as a cleanup.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [hash]);
  return (
    <>
      <nav className="top">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden />
          Company OS
        </a>
        <span className="top-sub">observador de solo lectura</span>
      </nav>
      <main className="wrap">
        <ErrorBoundary resetKey={hash}>
          {session ? (
            <Session id={decodeURIComponent(session)} />
          ) : project ? (
            <Project projectKey={decodeURIComponent(project)} />
          ) : (
            <Company />
          )}
        </ErrorBoundary>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
