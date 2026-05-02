import type { ClockPort } from "../../core/ports.js";

export const systemClock: ClockPort = {
  now: () => new Date(),
};
