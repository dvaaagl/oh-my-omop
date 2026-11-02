/**
 * Server tiruan model OpenAI-compatible (TESTING.md bagian 2).
 * Streaming, tool call berpotongan, JSON rusak, usage kosong.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockScenario {
  /** Respons dalam urutan; tiap entri satu panggilan. */
  steps: MockStep[];
}

export type MockStep =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "tool_call_broken"; id: string; name: string; rawArgs: string }
  | { kind: "refusal" }
  | { kind: "max_tokens"; text: string }
  | { kind: "error"; status: number }
  | { kind: "usage_only"; text: string };

export interface MockCall {
  body: Record<string, unknown>;
}

export class MockModelServer {
  private server: Server | null = null;
  private calls: MockCall[] = [];
  private stepIndex = 0;

  constructor(private readonly scenario: MockScenario) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          /* noop */
        }
        this.calls.push({ body: parsed });
        const step = this.scenario.steps[this.stepIndex] ?? { kind: "text", text: "(selesai)" };
        this.stepIndex++;
        this.respond(res, step);
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}/v1`;
  }

  get callCount(): number {
    return this.calls.length;
  }

  get receivedCalls(): MockCall[] {
    return this.calls;
  }

  /** Header yang diterima, untuk memastikan key terkirim. */
  lastAuthHeader(req: { headers: Record<string, unknown> }): string | undefined {
    const auth = req.headers["authorization"];
    return typeof auth === "string" ? auth : undefined;
  }

  private respond(res: import("node:http").ServerResponse, step: MockStep): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    switch (step.kind) {
      case "text": {
        send({ choices: [{ index: 0, delta: { content: step.text } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        send({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
        break;
      }
      case "tool_call": {
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: step.id,
                    type: "function",
                    function: { name: step.name, arguments: JSON.stringify(step.args) },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        send({ usage: { prompt_tokens: 20, completion_tokens: 8 } });
        break;
      }
      case "tool_call_broken": {
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: step.id,
                    type: "function",
                    function: { name: step.name, arguments: step.rawArgs },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        break;
      }
      case "refusal": {
        send({ choices: [{ index: 0, delta: { content: "Saya tidak bisa membantu itu." }, finish_reason: "stop" }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] });
        break;
      }
      case "max_tokens": {
        send({ choices: [{ index: 0, delta: { content: step.text } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
        break;
      }
      case "error": {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock error" } }));
        return;
      }
      case "usage_only": {
        send({ choices: [{ index: 0, delta: { content: step.text } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        send({ usage: null });
        break;
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
