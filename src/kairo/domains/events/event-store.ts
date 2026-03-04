import type { EventFilter, EventStore, KairoEvent } from "./types";

export class RingBufferEventStore implements EventStore {
  private buffer: KairoEvent[] = [];

  constructor(private capacity: number = 1000) {}

  async append(event: KairoEvent): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  async query(filter: EventFilter): Promise<KairoEvent[]> {
    let result = this.buffer;

    if (filter.fromTime !== undefined) {
      result = result.filter((event) => new Date(event.time).getTime() >= filter.fromTime!);
    }

    if (filter.toTime !== undefined) {
      result = result.filter((event) => new Date(event.time).getTime() <= filter.toTime!);
    }

    if (filter.types && filter.types.length > 0) {
      result = result.filter((event) => filter.types!.includes(event.type));
    }

    if (filter.sources && filter.sources.length > 0) {
      result = result.filter((event) => filter.sources!.includes(event.source));
    }

    if (filter.limit) {
      result = result.slice(-filter.limit);
    }

    return result;
  }
}
