import { describe, expect, it, vi } from "vitest";

import { SessionPinApplication } from "./pin-application.js";
import type { GlobalEventInput } from "@mavis/shared/global-events";

function createApplication(
  overrides: { pinSession?: ReturnType<typeof vi.fn> } = {},
): {
  application: SessionPinApplication;
  pinSession: ReturnType<typeof vi.fn>;
  published: GlobalEventInput[];
} {
  const pinSession =
    overrides.pinSession ?? vi.fn(async () => ({ items: [] }));
  const published: GlobalEventInput[] = [];
  const application = new SessionPinApplication({
    pinService: { pinSession } as never,
    publish: (event: GlobalEventInput) => {
      published.push(event);
    },
  });
  return { application, pinSession, published };
}

describe("SessionPinApplication", () => {
  it("pins a Session and publishes the pin once the write committed", async () => {
    const { application, pinSession, published } = createApplication();

    await expect(application.pinSession({} as never, { id: "session-a", pinned: true })).resolves.toEqual(
      { success: true, pinned: true },
    );

    expect(pinSession.mock.calls).toEqual([["session-a", true, undefined]]);
    expect(published).toEqual([
      { type: "session.pinned_updated", payload: { sessionId: "session-a", pinned: true } },
    ]);
  });

  it("unpins a Session", async () => {
    const { application, pinSession, published } = createApplication();

    await expect(
      application.pinSession({} as never, { id: "session-a", pinned: false }),
    ).resolves.toEqual({ success: true, pinned: false });

    expect(pinSession.mock.calls).toEqual([["session-a", false, undefined]]);
    expect(published).toEqual([
      { type: "session.pinned_updated", payload: { sessionId: "session-a", pinned: false } },
    ]);
  });

  it("pins when the flag is absent, the way archiving reads an absent flag", async () => {
    const { application, pinSession } = createApplication();

    await expect(application.pinSession({} as never, { id: "session-a" })).resolves.toEqual({
      success: true,
      pinned: true,
    });

    expect(pinSession.mock.calls).toEqual([["session-a", true, undefined]]);
  });

  it("forwards the requested slot in the pinned list", async () => {
    const { application, pinSession } = createApplication();

    await application.pinSession({} as never, { id: "session-a", pinned: true, insertIndex: 0 });

    expect(pinSession.mock.calls).toEqual([["session-a", true, 0]]);
  });

  it("publishes nothing when the pin write fails", async () => {
    const failure = new Error("session-not-found");
    const { application, published } = createApplication({
      pinSession: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(application.pinSession({} as never, { id: "session-a", pinned: true })).rejects.toBe(
      failure,
    );

    // The event must never describe a pin that was not committed.
    expect(published).toEqual([]);
  });
});
