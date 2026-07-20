import React from "react";
import { createRoot } from "react-dom/client";
import Shell from "./Shell.jsx";
import "./index.css";

// Shell renders the perps App plus the prediction view and toggles between them.
// App.jsx itself is untouched — see Shell.jsx for the isolation contract.
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
