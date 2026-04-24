#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";

const current = readFileSync("eval/results.json", "utf8");
writeFileSync("eval/baseline.json", current);
console.log("Baseline updated.");
