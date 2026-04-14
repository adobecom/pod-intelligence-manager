import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "@react-spectrum/s2";
import "@react-spectrum/s2/page.css";
import "./global.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider>
      <App />
    </Provider>
  </StrictMode>,
);
