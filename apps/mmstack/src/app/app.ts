import {
  Component,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { mapArray, nestedEffect } from '@mmstack/primitives';

const users = signal([
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' },
]);

function updateRandomUserName() {
  users.update((cur) => {
    const random = Math.floor(Math.random() * cur.length);

    const names = ['Dave', 'Eve', 'Frank', 'Grace', 'Heidi'];
    const next = [...cur];
    next[random] = {
      ...cur[random],
      name: names[Math.floor(Math.random() * names.length)],
    };
    return next;
  });
}

function initState() {
  setInterval(() => updateRandomUserName(), 2000);
  const injector = inject(Injector);

  return mapArray(
    users,
    (user) => {
      const name = computed(() => user().name);
      const intial = name();
      console.log('creating effect'); // fires 3 times on init
      const ref = nestedEffect(
        () => {
          if (name() == intial) return;
          console.log(`User updated: ${name()}`); // fires whenever user.name at i changes
        },
        { injector },
      );

      return {
        name,
        destroy: () => ref.destroy(),
      };
    },
    {
      onDestroy: (u) => u.destroy(),
    },
  );
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    @for (user of state(); track user) {
      <div>{{ user.name() }}</div>
    }
  `,
  styles: ``,
})
export class App {
  state = initState();

  constructor() {
    const test = signal(0);
    const injector = inject(Injector);
    effect((cleanup) => {
      console.log('Test effect:', test());

      const ref = untracked(() => {
        return effect(
          () => {
            console.log('Nested test effect:', test());
          },
          { injector },
        );
      });
      return cleanup(() => ref.destroy());
    });
  }
}
