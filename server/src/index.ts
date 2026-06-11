import { listen } from "@colyseus/tools";
import app from "./app.config.js";

// Listens on process.env.PORT, defaulting to 2567.
listen(app);
