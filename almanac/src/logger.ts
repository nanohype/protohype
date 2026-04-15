import pino from "pino";
import { config } from "./config/index.js";
import { requestContext } from "./context.js";

export const logger = pino(
  {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    base: { service: "almanac" },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: () => requestContext.getStore() ?? {},
  },
  pino.destination(2),
);
