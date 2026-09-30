import type {
  PinSessionInput as PinSessionReq,
  PinSessionResult as PinSessionResp,
} from "@mavis/protocol/local";

import type { PinService } from "../../service/pin/index.js";
import type { ApplicationContext } from "../context.js";
import { publishBestEffort, type GlobalEventPublisher } from "../events.js";

export interface SessionPinApplicationOptions {
  /**
   * Owner of the ordered pin list. Session pins are a preference value, not a
   * column on the Session row, so this application never touches a repository.
   */
  readonly pinService: Pick<PinService, "pinSession">;
  readonly publish: GlobalEventPublisher;
}

/**
 * Pin or unpin a Session as a product-level quick-access item.
 *
 * The event is published only after the pin list write resolved, so
 * `session.pinned_updated` never describes a pin that was not committed — the same
 * rule `SessionLifecycleEventProjector` follows for Session facts.
 */
export class SessionPinApplication {
  constructor(private readonly options: SessionPinApplicationOptions) {}

  async pinSession(_context: ApplicationContext, req: PinSessionReq): Promise<PinSessionResp> {
    const pinned = req.pinned !== false;
    await this.options.pinService.pinSession(
      req.id,
      pinned,
      typeof req.insertIndex === "number" ? req.insertIndex : undefined,
    );
    publishBestEffort(this.options.publish, {
      type: "session.pinned_updated",
      payload: { sessionId: req.id, pinned },
    });
    return { success: true, pinned };
  }
}
