/**
 * Host Execution Safety
 *
 * Running without a Conway key is fully supported, and it means there is no
 * sandbox — so the agent's shell commands would execute on the host, in the
 * user's home directory, with no isolation boundary. Two protections:
 *
 *   1. Host execution is opt-in (AUTOMATON_ALLOW_HOST_EXEC=1).
 *   2. The forbidden-command patterns cover Windows/PowerShell, not just
 *      POSIX. Every original pattern assumed `rm`/`cat`/`pkill`, so on the
 *      one platform where host exec is most likely, none of the agent's
 *      self-preservation guards applied.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createCommandSafetyRules } from "../agent/policy-rules/command-safety.js";
import type { AutomatonTool, PolicyRequest, ToolContext } from "../types.js";

const rules = createCommandSafetyRules();
const forbiddenRule = rules.find((r) => r.id === "command.forbidden_patterns")!;

/** Ask the policy rule whether a shell command is blocked. */
function isBlocked(command: string): boolean {
  const request: PolicyRequest = {
    tool: {
      name: "exec",
      description: "",
      parameters: {},
      execute: async () => "",
      riskLevel: "caution",
      category: "vm",
    } as AutomatonTool,
    args: { command },
    context: {} as ToolContext,
    turnContext: {
      inputSource: "agent",
      turnToolCallCount: 0,
      sessionSpend: null as never,
    },
  };
  const verdict = forbiddenRule.evaluate(request);
  return verdict != null && verdict.action === "deny";
}

describe("forbidden commands: POSIX (regression baseline)", () => {
  it("blocks the classic Unix forms", () => {
    expect(isBlocked("rm -rf ~/.automaton")).toBe(true);
    expect(isBlocked("cat ~/.automaton/wallet.json")).toBe(true);
    expect(isBlocked("pkill automaton")).toBe(true);
  });
});

describe("forbidden commands: Windows / PowerShell", () => {
  // Each of these was permitted before: they are the exact Windows
  // equivalents of commands the POSIX patterns already blocked.
  it("blocks deleting its own wallet and state", () => {
    expect(isBlocked("del /s /q %USERPROFILE%\\.automaton")).toBe(true);
    expect(isBlocked("Remove-Item -Recurse -Force ~\\.automaton")).toBe(true);
    expect(isBlocked("del C:\\Users\\x\\.automaton\\wallet.json")).toBe(true);
    expect(isBlocked("rmdir /s /q state.db")).toBe(true);
    expect(isBlocked("Remove-Item SOUL.md")).toBe(true);
  });

  it("blocks reading the private key out of the wallet", () => {
    expect(isBlocked("type %USERPROFILE%\\.automaton\\wallet.json")).toBe(true);
    expect(isBlocked("Get-Content ~/.automaton/wallet.json")).toBe(true);
    expect(isBlocked("gc wallet.json")).toBe(true);
  });

  it("blocks harvesting other credentials", () => {
    expect(isBlocked("type C:\\Users\\x\\.ssh\\id_rsa")).toBe(true);
    expect(isBlocked("Get-Content .env")).toBe(true);
  });

  it("blocks killing its own process", () => {
    expect(isBlocked("taskkill /F /IM node.exe")).toBe(true);
    expect(isBlocked("Stop-Process -Name node -Force")).toBe(true);
  });

  it("blocks overwriting its own safety infrastructure", () => {
    expect(isBlocked("Set-Content src/agent/injection-defense.ts -Value ''")).toBe(true);
    expect(isBlocked("Out-File src/agent/policy-rules/index.ts")).toBe(true);
  });

  it("still allows ordinary work", () => {
    expect(isBlocked("node --version")).toBe(false);
    expect(isBlocked("git status")).toBe(false);
    expect(isBlocked("Get-Content README.md")).toBe(false);
    expect(isBlocked("npm install express")).toBe(false);
  });
});

describe("host execution is opt-in", () => {
  const saved = process.env.AUTOMATON_ALLOW_HOST_EXEC;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTOMATON_ALLOW_HOST_EXEC;
    else process.env.AUTOMATON_ALLOW_HOST_EXEC = saved;
  });

  async function makeSandboxlessClient() {
    const { createConwayClient } = await import("../conway/client.js");
    return createConwayClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      sandboxId: "", // no sandbox => would fall back to host execution
    });
  }

  it("refuses to run host commands unless explicitly enabled", async () => {
    delete process.env.AUTOMATON_ALLOW_HOST_EXEC;
    const client = await makeSandboxlessClient();
    const result = await client.exec("echo should-not-run");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/AUTOMATON_ALLOW_HOST_EXEC/);
    expect(result.stdout).toBe("");
  });

  it("runs host commands once explicitly enabled", async () => {
    process.env.AUTOMATON_ALLOW_HOST_EXEC = "1";
    const client = await makeSandboxlessClient();
    const result = await client.exec("echo host-exec-ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("host-exec-ok");
  });
});
