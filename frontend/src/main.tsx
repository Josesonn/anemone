import "./force-motion";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import "@/components/arc/foundation.css";
import "./index.css";
import { ToastStack, ToastStackProvider } from "@/components/arc/toast-stack/toast-stack";
import App from "./App";

document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.accent = "blue";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastStackProvider limit={5}>
      <App />
      <ToastStack position="bottom-center" label="Task alerts" />
    </ToastStackProvider>
  </StrictMode>,
);
