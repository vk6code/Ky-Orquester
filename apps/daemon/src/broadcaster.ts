import type { EventMessage } from "@orquester/api";
import { randomUUID } from "node:crypto";

interface Sink {
  send(data: string): void;
}

/**
 * Fan-out for daemon events to every connected `/events` client, so multiple
 * clients (or reconnects) stay in sync on session lifecycle changes.
 */
export class Broadcaster {
  private sinks = new Set<Sink>();

  add(sink: Sink): void {
    this.sinks.add(sink);
  }

  remove(sink: Sink): void {
    this.sinks.delete(sink);
  }

  publish(channel: string, type: string, payload: unknown): void {
    const event: EventMessage = {
      id: randomUUID(),
      channel,
      type,
      createdAt: new Date().toISOString(),
      payload
    };
    const data = JSON.stringify(event);
    for (const sink of this.sinks) {
      try {
        sink.send(data);
      } catch {
        this.sinks.delete(sink);
      }
    }
  }
}
