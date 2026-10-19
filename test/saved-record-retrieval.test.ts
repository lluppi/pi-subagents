/**
 * saved-record-retrieval.test.ts — get_subagent_result after the live record is gone.
 *
 * A completion notification carries only a preview and points at
 * get_subagent_result for the full text, but the live record is evicted ten
 * minutes after the agent finishes, read or not, and a reload or restart drops
 * it at once. The final record is also appended to the session as a
 * `subagents:record` entry; get_subagent_result falls back to it.
 *
 * A second activation of the extension over the same session branch is the
 * reload case, and the same lookup as an evicted record: the manager has no
 * record for the id.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

/** A pi whose appended custom entries land on `branch`, as pi's session does. */
function makePi(branch: any[]) {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data })),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx(branch: any[]) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("get_subagent_result falls back to the saved record", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off, as in foreground-result-retrieval.test.ts.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-saved-record-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-saved-record-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Run an agent to completion in a first activation; returns its id. */
  async function finishedAgent(branch: any[]): Promise<string> {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "THE-FULL-RESULT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const first = makePi(branch);
    subagentsExtension(first.pi);
    const res = await first.tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "Review the change.", description: "Review the change", subagent_type: "Explore", run_in_background: false },
      undefined,
      undefined,
      ctx(branch),
    );
    await first.lifecycle.get("session_shutdown")?.({}, ctx(branch));
    return (res as any).details?.agentId as string;
  }

  it("answers from the session's subagents:record entry once the live record is gone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    expect(branch.some((entry) => entry.customType === "subagents:record" && entry.data.id === id)).toBe(true);

    const reloaded = makePi(branch);
    subagentsExtension(reloaded.pi);
    const read = await reloaded.tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx(branch));
    const out = textOf(read);
    expect(out).toContain(`Agent: ${id}`);
    expect(out).toContain("Status: completed");
    expect(out).toContain("THE-FULL-RESULT");
    expect(out).toContain("saved record");

    await reloaded.lifecycle.get("session_shutdown")?.({}, ctx(branch));
  });

  it("still reports an id with no saved record as not found", async () => {
    const branch: any[] = [];
    await finishedAgent(branch);

    const reloaded = makePi(branch);
    subagentsExtension(reloaded.pi);
    const read = await reloaded.tools
      .get("get_subagent_result")
      .execute("tc-read", { agent_id: "3f1320a7-74ec-422" }, undefined, undefined, ctx(branch));
    expect(textOf(read)).toContain("Agent not found");

    await reloaded.lifecycle.get("session_shutdown")?.({}, ctx(branch));
  });
});
