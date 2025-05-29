import { JsonPipe } from '@angular/common';
import { Component, effect, inject, Injector, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { debounced, throttled, until, withHistory } from '@mmstack/primitives';

@Component({
  selector: 'app-throttle-demo',
  imports: [JsonPipe],
  template: `
    <div
      (mousemove)="onMouseMove($event)"
      style="width: 300px; height: 200px; border: 1px solid black; padding: 10px; user-select: none;"
    >
      Move mouse here to see updates...
    </div>
    <p><b>Original Position:</b> {{ position.original() | json }}</p>
    <p><b>Throttled Position:</b> {{ position() | json }}</p>
  `,
})
export class ThrottleDemoComponent {
  // Throttle updates to at most once every 200ms
  position = throttled({ x: 0, y: 0 }, { ms: 200 });

  constructor() {
    // This effect runs on every single mouse move event.
    effect(() => {
      // console.log('Original value updated:', this.position.original());
    });
    // This effect will only run at most every 200ms.
    effect(() => {
      console.log('Throttled value updated:', this.position());
    });
  }

  onMouseMove(event: MouseEvent) {
    this.position.set({ x: event.offsetX, y: event.offsetY });
  }
}

@Component({
  selector: 'app-history-demo',
  standalone: true,
  imports: [FormsModule, JsonPipe],
  template: `
    <h4>Simple Text Editor</h4>
    <textarea [(ngModel)]="text" rows="4" cols="50"></textarea>
    <div class="buttons" style="margin-top: 8px; display: flex; gap: 8px;">
      <button (click)="text.undo()" [disabled]="!text.canUndo()">Undo</button>
      <button (click)="text.redo()" [disabled]="!text.canRedo()">Redo</button>
      <button (click)="text.clear()" [disabled]="!text.canClear()">
        Clear History
      </button>
    </div>
    <p>History Stack:</p>
    <pre>{{ text.history() | json }}</pre>

    {{ count() }}
    <button (click)="run()">run</button>
    <button (click)="count.set(count() + 1)">Increment Count</button>
  `,
})
export class HistoryDemoComponent {
  // Create a signal and immediately enhance it with history capabilities.
  text = withHistory(signal('Hello, type something!'), { maxSize: 10 });
  private injector = inject(Injector);
  count = signal(0);

  constructor() {
    // You can react to history changes as well
    effect(() => {
      console.log('History stack changed:', this.text.history());
    });
  }

  async run() {
    const final = await until(this.count, (c) => c > 5, {});
    console.log('Final count reached:', final);
  }
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HistoryDemoComponent],
  template: ` <app-history-demo />`,
  styles: ``,
})
export class AppComponent {
  readonly test = debounced('', {
    ms: 300,
  });

  e = effect(() => console.log('Debounced Value:', this.test()));
}
