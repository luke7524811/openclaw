import { describe, expect, it, vi } from "vitest";

vi.mock("../../daemon/launchd.js", () => ({
  resolveGatewayLogPaths: vi.fn(() => ({
    logDir: "/tmp/openclaw/logs",
    stdoutPath: "/tmp/openclaw/logs/gateway.log",
    stderrPath: "/tmp/openclaw/logs/gateway.err.log",
  })),
}));

vi.mock("./gateway.js", () => ({
  readFileTailLines: vi.fn(async () => []),
  summarizeLogTail: vi.fn(() => []),
}));

import { appendStatusAllDiagnosis } from "./diagnosis.js";

describe("appendStatusAllDiagnosis", () => {
  it("avoids unreachable gateway diagnosis in node-only mode", async () => {
    const lines: string[] = [];

    await appendStatusAllDiagnosis({
      lines,
      progress: {
        setLabel: () => {},
        tick: () => {},
      } as never,
      muted: (text) => text,
      ok: (text) => text,
      warn: (text) => text,
      fail: (text) => text,
      connectionDetailsForReport: [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: gateway.example.com:19000",
      ].join("\n"),
      snap: null,
      remoteUrlMissing: false,
      secretDiagnostics: [],
      sentinel: null,
      lastErr: null,
      port: 18789,
      portUsage: { listeners: [] },
      tailscaleMode: "off",
      tailscale: {
        backendState: "Running",
        dnsName: null,
        ips: [],
        error: null,
      },
      tailscaleHttpsUrl: null,
      skillStatus: null,
      pluginCompatibility: [],
      channelsStatus: null,
      channelIssues: [],
      gatewayReachable: false,
      health: undefined,
      nodeOnlyGateway: {
        gatewayTarget: "gateway.example.com:19000",
        gatewayValue: "node → gateway.example.com:19000 · no local gateway",
        connectionDetails: [
          "Node-only mode detected",
          "Local gateway: not expected on this machine",
          "Remote gateway target: gateway.example.com:19000",
          "Inspect the remote gateway host for live channel and health details.",
        ].join("\n"),
      },
    });

    const output = lines.join("\n");
    expect(output).toContain("Node-only mode detected");
    expect(output).toContain(
      "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
    );
    expect(output).not.toContain("Channel issues skipped (gateway unreachable)");
    expect(output).not.toContain("Gateway health:");
  });
});
