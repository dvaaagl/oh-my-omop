/**
 * ChannelAdapter interface (FLOW.md bagian 12).
 * Setiap adapter cukup mengimplementasikan interface ini.
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  InboundMessage,
  OutboundMessage,
  Target,
} from "../core/types.js";

export interface ChannelAdapter {
  readonly channel: string;

  /** Mulai mendengarkan. Pesan masuk diteruskan ke onMessage. */
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;

  /** Kirim balasan ke target. */
  send(target: Target, message: OutboundMessage): Promise<void>;

  /** Minta persetujuan pemilik. Timeout berarti tolak. */
  requestApproval(target: Target, request: ApprovalRequest): Promise<ApprovalDecision>;

  stop(): Promise<void>;
}
