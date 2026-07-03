import {
  ChangeDetectionStrategy,
  Component,
  computed,
} from '@angular/core';
import { store } from '@mmstack/primitives';

type Profile = {
  name: string;
  role: string;
  address: { city: string; country: string };
};

@Component({
  selector: 'demo-store',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="split">
      <div class="editor">
        <label>
          <span>name</span>
          <input [value]="s.name()" (input)="s.name.set(val($event))" />
        </label>
        <label>
          <span>role</span>
          <input [value]="s.role()" (input)="s.role.set(val($event))" />
        </label>
        <label>
          <span>address.city</span>
          <input
            [value]="s.address.city()"
            (input)="s.address.city.set(val($event))"
          />
        </label>
        <label>
          <span>address.country</span>
          <input
            [value]="s.address.country()"
            (input)="s.address.country.set(val($event))"
          />
        </label>
      </div>

      <div class="out">
        <p class="cap">source signal, live</p>
        <pre>{{ json() }}</pre>
        <p class="note">
          Every field is its own writable signal.
          <code>s.address.city.set(...)</code> writes straight through to the
          source, no spread.
        </p>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
    }

    .editor {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    label {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    label span {
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      color: var(--fg-muted, #6b7280);
    }

    input {
      padding: 0.4rem 0.55rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      background: var(--bg, #fff);
      color: inherit;
      font: inherit;
      font-size: 0.85rem;
    }

    .cap {
      margin: 0 0 0.35rem;
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      color: var(--fg-muted, #6b7280);
    }

    pre {
      margin: 0;
      padding: 0.75rem;
      background: var(--code-bg, #f6f8fa);
      border: 1px solid var(--line, #29292661);
      border-radius: 6px;
      font-size: 0.78rem;
      line-height: 1.5;
      overflow-x: auto;
    }

    .note {
      margin: 0.5rem 0 0;
      font-size: 0.78rem;
      color: var(--fg-muted, #6b7280);
    }

    @media (max-width: 560px) {
      .split {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class StoreDemo {
  // store() takes the raw object and owns the source signal itself; read the
  // whole value back through s().
  protected readonly s = store<Profile>({
    name: 'Ada Lovelace',
    role: 'Engineer',
    address: { city: 'London', country: 'UK' },
  });

  protected readonly json = computed(() => JSON.stringify(this.s(), null, 2));

  protected val(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
