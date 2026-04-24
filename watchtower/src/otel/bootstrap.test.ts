import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTelemetry, _resetForTests } from "./bootstrap.js";

const original = process.env.OTEL_RESOURCE_ATTRIBUTES;

describe("initTelemetry", () => {
  beforeEach(() => {
    _resetForTests();
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = original;
  });

  it("sets OTEL_RESOURCE_ATTRIBUTES from config when unset", () => {
    initTelemetry({
      serviceName: "watchtower",
      serviceVersion: "0.1.0",
      environment: "staging",
      region: "us-west-2",
    });
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain("service.name=watchtower");
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain("deployment.environment=staging");
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain("cloud.region=us-west-2");
  });

  it("merges with existing OTEL_RESOURCE_ATTRIBUTES instead of overwriting", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "sidecar.injected=true";
    initTelemetry({
      serviceName: "watchtower",
      serviceVersion: "0.1.0",
      environment: "production",
      region: "us-west-2",
    });
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toMatch(/^sidecar\.injected=true,/);
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain("service.name=watchtower");
  });

  it("is idempotent — second call returns tracer+meter without re-mutating env", () => {
    initTelemetry({
      serviceName: "watchtower",
      serviceVersion: "0.1.0",
      environment: "staging",
      region: "us-west-2",
    });
    const before = process.env.OTEL_RESOURCE_ATTRIBUTES;
    initTelemetry({
      serviceName: "watchtower",
      serviceVersion: "0.1.0",
      environment: "staging",
      region: "us-west-2",
    });
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe(before);
  });
});
