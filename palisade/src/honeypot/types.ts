import type { createHoneypotHandler } from "./handler.js";

export type HoneypotHandler = ReturnType<typeof createHoneypotHandler>;
