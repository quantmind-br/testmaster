import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./theme/theme.css";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
