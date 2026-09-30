import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./app.css";

class RendererErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "An unexpected renderer error occurred.",
    };
  }
  render() {
    if (this.state.error)
      return (
        <main
          role="alert"
          style={{ padding: 28, fontFamily: "system-ui,sans-serif" }}
        >
          <h1>
            {window.appSurface === "diagnostic"
              ? "Desktop diagnostic could not render"
              : "Archivist could not start"}
          </h1>
          <p>{this.state.error}</p>
          <button onClick={() => window.location.reload()}>
            {window.appSurface === "diagnostic"
              ? "Reload diagnostic"
              : "Reload app"}
          </button>
        </main>
      );
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>,
  );
