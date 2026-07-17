import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import OKLabLearningApp from "./OKLabLearningApp";
import "./styles.css";

createRoot(document.getElementById("oklab-root")!).render(
  <StrictMode>
    <OKLabLearningApp />
  </StrictMode>,
);
