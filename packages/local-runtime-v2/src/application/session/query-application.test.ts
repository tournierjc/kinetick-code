import { describe, expect, it, vi } from "vitest";

import { SessionQueryApplication } from "./query-application.js";

/** The fields the view converter reads; pin state is never one of them. */
function record(sessionId: string, updatedAtMs = 1): Record<string, unknown> {
  return {
    sessionId,
    agentName: "coder",
    sessionType: "root",
    archived: false,
    workspaceDir: "/workspace",
    runtime: "local",
    visibility: "visible",
    sessionKind: "default",
    createdAtMs: updatedAtMs,
    updatedAtMs,
  };
}

function createApplication(
  options: { pinned?: readonly string[]; failPinRead?: boolean } = {},
): SessionQueryApplication {
  const list = vi.fn(async () => ({
    sessions: [record("session-a"), record("session-b")],
    hasMore: false,
  }));
  const get = vi.fn(async (sessionId: string) => record(sessionId));
  return new SessionQueryApplication({
    service: { list, get } as never,
    ...(options.pinned || options.failPinRead
      ? {
          pinnedSessions: async () => {
            if (options.failPinRead) throw new Error("pin list unavailable");
            return options.pinned ?? [];
          },
        }
      : {}),
  });
}

describe("SessionQueryApplication pin projection", () => {
  it("marks the pinned Session of a page and leaves the others untouched", async () => {
    const application = createApplication({ pinned: ["session-b"] });

    const page = await application.listSessions({} as never, {} as never);

    expect(page.sessions).toEqual([
      expect.objectContaining({ sessionId: "session-a" }),
      expect.objectContaining({ sessionId: "session-b", pinned: true }),
    ]);
    expect(page.sessions[0]).not.toHaveProperty("pinned");
  });

  it("marks a single Session read", async () => {
    const application = createApplication({ pinned: ["session-a"] });

    await expect(application.getSession({} as never, { id: "session-a" } as never)).resolves.toEqual({
      session: expect.objectContaining({ sessionId: "session-a", pinned: true }),
    });

    const other = createApplication({ pinned: ["session-b"] });
    await expect(other.getSession({} as never, { id: "session-a" } as never)).resolves.toEqual({
      session: expect.objectContaining({ sessionId: "session-a" }),
    });
  });

  it("returns the catalogue when the pin list cannot be read", async () => {
    const application = createApplication({ failPinRead: true });

    const page = await application.listSessions({} as never, {} as never);

    // Losing the flag is better than losing the catalogue.
    expect(page.sessions).toHaveLength(2);
    expect(page.sessions.some((session) => session.pinned === true)).toBe(false);
  });

  it("does not mark anything when no pin port is wired", async () => {
    const application = createApplication();

    const page = await application.listSessions({} as never, {} as never);

    expect(page.sessions).toHaveLength(2);
    expect(page.sessions.some((session) => "pinned" in session)).toBe(false);
  });
});
