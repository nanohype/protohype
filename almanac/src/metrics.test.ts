import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

// Override config so the metrics module does NOT treat this run as a test
// (the module no-ops when NODE_ENV=test; here we want to exercise the
// buffer + flush path directly).
vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "development",
    AWS_REGION: "us-west-2",
  },
}));

import { timing, counter, flushMetrics } from "./metrics.js";

const cwMock = mockClient(CloudWatchClient);

beforeEach(async () => {
  cwMock.reset();
  // Drain any buffer left over from a previous test.
  cwMock.on(PutMetricDataCommand).resolves({});
  await flushMetrics();
  cwMock.reset();
});

describe("metrics", () => {
  it("buffers datums and flushes them to PutMetricData on demand", async () => {
    cwMock.on(PutMetricDataCommand).resolves({});
    timing("QueryLatency", 123);
    counter("RedactionCount", 2);
    await flushMetrics();

    const calls = cwMock.commandCalls(PutMetricDataCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.Namespace).toBe("Almanac");
    expect(input.MetricData).toHaveLength(2);
    expect(input.MetricData?.[0].MetricName).toBe("QueryLatency");
    expect(input.MetricData?.[0].Unit).toBe("Milliseconds");
    expect(input.MetricData?.[1].MetricName).toBe("RedactionCount");
    expect(input.MetricData?.[1].Unit).toBe("Count");
  });

  it("attaches the Environment dimension to every datum", async () => {
    cwMock.on(PutMetricDataCommand).resolves({});
    counter("SomeCounter");
    await flushMetrics();
    const dims =
      cwMock.commandCalls(PutMetricDataCommand)[0].args[0].input.MetricData?.[0].Dimensions;
    expect(dims).toEqual([{ Name: "Environment", Value: "development" }]);
  });

  it("merges caller-supplied dimensions with the base Environment dimension", async () => {
    cwMock.on(PutMetricDataCommand).resolves({});
    counter("RateLimitHit", 1, { limit_type: "user" });
    await flushMetrics();
    const dims =
      cwMock.commandCalls(PutMetricDataCommand)[0].args[0].input.MetricData?.[0].Dimensions;
    expect(dims).toHaveLength(2);
    expect(dims).toEqual(
      expect.arrayContaining([
        { Name: "Environment", Value: "development" },
        { Name: "limit_type", Value: "user" },
      ]),
    );
  });

  it("does not throw when PutMetricData fails (metrics are best-effort)", async () => {
    cwMock.on(PutMetricDataCommand).rejects(new Error("throttled"));
    timing("X", 1);
    await expect(flushMetrics()).resolves.not.toThrow();
  });

  it("flushMetrics on an empty buffer is a cheap no-op (no API call)", async () => {
    await flushMetrics();
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });
});
