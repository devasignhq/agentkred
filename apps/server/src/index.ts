// API entry point: serves the escrow and seller routes on the configured port.

import { createApp } from "./app.js";
import { Env } from "./config/env.js";

createApp().listen(Env.port(), () => {
    console.log(`AgentKred API listening on port ${Env.port()}`);
});
