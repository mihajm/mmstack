import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import {
  readSpan,
  TELEMETRY,
  tracedSignal,
  withTelemetryParent,
} from '@mmstack/telemetry-core';
import { pageSink } from '../telemetry';

/**
 * Close-the-loop demo for @mmstack/telemetry-*. Every action emits through the
 * real facade; the page renders the memory sink, and the same telemetry flows
 * to Grafana when the otel-lgtm stack is up (see scripts/telemetry-otlp-smoke.sh).
 */
@Component({
  selector: 'mm-telemetry-example',
  template: `
    <section>
      <h2>Telemetry</h2>
      <p>
        Items: <b>{{ items() }}</b>
        @if (lastCause(); as cause) {
          <span class="cause">last write caused by span {{ cause }}</span>
        }
      </p>
      <div class="actions">
        <button (click)="addItem()">Add item (span → tracedSignal)</button>
        <button (click)="checkout()">Checkout (span + nested HTTP + event + metric + log)</button>
        <button (click)="fail()">Fail (recorded error)</button>
      </div>

      <div class="feed">
        <h3>Spans</h3>
        <ul>
          @for (span of spans(); track $index) {
            <li>
              <code>{{ span.name }}</code>
              trace {{ span.ctx.traceId.slice(0, 8) }}…
              @if (span.ctx.parentSpanId) {
                <em>→ child of {{ span.ctx.parentSpanId.slice(0, 8) }}…</em>
              }
              @if (span.error) {
                <b class="err">errored</b>
              }
              {{ span.ended ? '(ended)' : '(open)' }}
            </li>
          }
        </ul>
        <h3>Events / metrics / logs / errors</h3>
        <ul>
          @for (line of emits(); track $index) {
            <li>{{ line }}</li>
          }
        </ul>
      </div>
    </section>
  `,
  styles: `
    section {
      padding: 1rem;
      font-family: system-ui, sans-serif;
      color: #334155;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .cause {
      margin-left: 0.75rem;
      font-size: 0.85em;
      color: #64748b;
    }
    .feed h3 {
      margin: 0.75rem 0 0.25rem;
      font-size: 0.9em;
    }
    .feed ul {
      margin: 0;
      font-size: 0.85em;
    }
    .err {
      color: #dc2626;
    }
  `,
})
export class TelemetryExample {
  private readonly telemetry = inject(TELEMETRY);
  private readonly http = inject(HttpClient);

  private readonly quantity = tracedSignal(1);
  readonly items = this.quantity.asReadonly();
  readonly lastCause = signal<string | undefined>(undefined);

  // memorySink arrays are plain mutables; bump a version to re-render the feed.
  private readonly version = signal(0);
  readonly spans = computed(() => {
    this.version();
    return [...pageSink.spans].reverse();
  });
  readonly emits = computed(() => {
    this.version();
    return [
      ...pageSink.events.map((e) => `event ${e.name} ${JSON.stringify(e.attrs)}`),
      ...pageSink.metrics.map((m) => `metric ${m.name}=${m.value} (${m.kind ?? 'histogram'})`),
      ...pageSink.logs.map((l) => `log [${l.severity}] ${l.body}`),
      ...pageSink.errors.map((e) => `error ${(e.err as Error).message ?? e.err}`),
    ].reverse();
  });

  addItem(): void {
    this.telemetry.span('add-item', () => this.quantity.update((q) => q + 1));
    const cause = this.quantity.causedBy();
    this.lastCause.set(cause && readSpan(cause).spanId.slice(0, 8) + '…');
    this.version.update((v) => v + 1);
  }

  checkout(): void {
    this.telemetry.span('checkout', (span) => {
      this.telemetry.event('checkout.started', { items: this.items() });
      this.telemetry.metric('checkout_clicks', 1, undefined, { kind: 'counter' });
      this.http
        .get('https://jsonplaceholder.typicode.com/todos/1', {
          context: withTelemetryParent(span),
        })
        .subscribe({
          next: () => {
            this.telemetry.log('info', 'checkout settled');
            this.version.update((v) => v + 1);
          },
          error: (err: unknown) => {
            this.telemetry.error(err);
            this.version.update((v) => v + 1);
          },
        });
    });
    this.version.update((v) => v + 1);
  }

  fail(): void {
    try {
      this.telemetry.span('breaks', () => {
        throw new Error('demo failure');
      });
    } catch (err) {
      this.telemetry.error(err, { where: 'telemetry-example' });
    }
    this.version.update((v) => v + 1);
  }
}
