/**
 * SPA entry point. Fonts are self-hosted (bundled, not fetched from a CDN) so
 * the dashboard renders identically offline, in a Codespace, and behind
 * Cloudflare — and so no third party sees a request per page view.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

// Latin subsets only — the UI is English (frontend-brief §12 puts i18n out of
// scope), so shipping cyrillic/greek/vietnamese faces would be dead weight in
// the image. Archivo is variable, covering every weight in one file.
import "@fontsource-variable/archivo/wght.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";

import "./theme/tokens.css";
import "./theme/global.css";

import { App } from "./App.js";
import { StoreProvider } from "./store/react.js";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <StoreProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StoreProvider>
  </StrictMode>
);
