# Fun-grained Reactivity in Angular: Part 4 - NestedSignals()()

Hey everyone, been a while! :) This one will be short & hopefuly sweet. I'll be assuming a decent familiarity with Angular's change detection mechanics, so before we get into it, heres a great (refresher)[https://angular.love/the-latest-in-angular-change-detection-zoneless-signals] on the topic, in case it's been a while ;)

## Keeping it clean

As we all now know, change detection in angular refers to three operations. The first will mark various components as dirty & needing a check, the second checks the state for differences & the third calls the renderer to update the DOM where necessary. While these operations are highly performant, we'd still like to avoid operations, if they aren't required.

We've had the onPush strategy to solve parts of this for quite a while, and since Angular v18 we've had the new signal scheduler that skips quite a few operations when we only use signals, only marking parent as `HasChildViewToRefresh` instead of as `dirty` when a signal within a child component changes.

_There are of course exceptions to this, for example unless we use the new `ZonelessChangeDetection` a button click will still mark all parent components as `dirty`. For the sake of this article, we will ignore these cases, as in my opinion this is a temporary state, which will get further optimized in the future as Angular slowly transitions towards a fully signal based future, we're seeing some of that with v20 marking zone.js as an [optional peer dependency](https://github.com/angular/angular/pull/61616) already & I can't wait to see what's comming down the pipe in the future :D!_

Anyway let's get right into it.

## In it

```typescript
@Component({
  ...
})
export class ExampleComponent {
  protected readonly count = signal(0);

  protected inc() {
    this.count.update((cur) => cur++);
  }
}

```

So a component, like the one above (in a zoneless environment) really only triggers change detection for itself. Parents & it's children will not be checked...unless we add inputs into the mix.

```typescript
@Component({
  ...
  template: `<app-example-child [count]="count()" />` // marks child as dirty on trigger
})
export class ExampleComponent {
  protected readonly count = model(0); // doesn't mark parents as dirty as it assumes that they already are

  protected inc() {
    this.count.update((cur) => cur++);
  }
}

```

This simple example wouldn't cause any issues, of course. But as we all know, any decently sized app will be passing around tons of state, lots of times several levels deep. More often than not, changes to that state unecessarily trigger intermediary components, as the changes really only apply to children. A common pattern to mitigate this is to externalize state into an injectable store. This prevents marking intermediary components as dirty, since we are no longer passing state _through_ them.

```typescript
@Injectable()
export class CountStore {
  readonly count = signal(0);

  inc() {
    this.count.update((cur) => cur++);
  }
}

@Component({
  ...
  template: `<app-example-child [count]="store.count()" />`
})
export class ExampleComponent {
  protected readonly store = inject(CountStore);
}

```

This pattern, while very useful, does however have some drawbacks. It adds complexity for re-use & decreases flexibility vs just an input. I won't get into it too much here, we all know that we have lots of examples of components in our apps where we've chosen not to do this for various reasons & have rather passed state through layers of inputs...so how do we square this circle, getting the perf. increase with inputs alone.

Well what we've started to use to _"solve"_ this is use nested signals. There's a few variations on this pattern, but it all boils down to the same thing. Angular's change detector will only check for referential equality on inputs, if the object/function reference doesn't change it moves on. Since signals are really just a function/object this applies to them as well :) So if we pass a signal to a signal input, & use it in the template, we can rely that it will only "trigger" the components it's used in.

```typescript
@Component({
  ...
  template: `{{count()()}}` // only this component re-renders
})
export class ExampleChildComponent {
  protected readonly count = input.required<Signal<number>>();

  protected inc() {
    this.count.update((cur) => cur++);
  }
}

@Component({
  ...
  template: `<app-example-child [count]="count" />`
})
export class ExampleComponent {
  protected readonly count = signal(0);

  protected inc() {
    this.count.update((cur) => cur++);
  }
}

```

In fact & I'm not sure exactly when this happened, but testing in v19, only the part of the template that uses the signal is actually re-rendered. So if we're calling the signal in say a span, only that span gets re-rendered. I wouldn't count on this just yet, but for sure it is the future of any signal based framework (SolidJS's renderer already works like this for example).

I'll fully admit that the double signal call _"looks weird"_ though :) So another option is just wrapping it in an object, that doesn't really change. BTW this is how [@mmstack/forms](https://www.npmjs.com/package/@mmstack/form-material) work :)

```typescript

type CountState = {
  count: Signal<number>;
}

@Component({
  ...
  template: `{{state().count()}}`
})
export class ExampleChildComponent {
  protected readonly state = input.required<CountState>();

  protected inc() {
    this.count.update((cur) => cur++);
  }
}

@Component({
  ...
  template: `<app-example-child [state]="state" />`
})
export class ExampleComponent {
  protected readonly state = {
    count: signal(0)
  };

  protected inc() {
    this.count.update((cur) => cur++);
  }
}

```

A side benefit this provides is it allows us to use mutable signals. A problem those have is that angular checks referential equality of the value, since we're mutating those values in-line they never "update" the input.

```typescript
import { mutable } from '@mmstack/primitives'

@Component({
  ...
  template: `
    <app-example-child [state]="state" /> // will update the content every time the signal value mutates
    <app-other-child [state]="state()" /> // never triggers

  `
})
export class ExampleComponent {
  protected readonly state = mutable({
    count: 0
  });


  protected inc() {
    this.state.mutate((cur) => {
      cur.count++;
      return cur;
    })
  }
}
```

## Arrays

Finally, we should talk about arrays, the patterns above can be relatively easily implemented for a single object state, but arrays require some _"work"_. Usually we'll get some array data from a server & just render it out to a list/table with one or more `@for` loops. While this is fine & Angular does some extra magic for us via the track method, more or less we will be re-rendering the entire list any time something changes.

What we'd want instead of an array of objects then is an array of signals of those objects. One that keeps the signals themselves stable, but updates their values as needed. Even better if we can keep existing signals through a lenght change. Luckily, with Angular's new `linkedSignal` we can make that pretty easily :)

```typescript

type Note = {
  id: string;
  content: string;
}

const notes = signal<Note[]>([
  ...
]);

const length = computed(() => notes().length); // stabalize length

const noteContents = linkedSignal({
  source: () => length(),
  computation: (length, prev) => ({
    if (!prev) return Array.from({length}, (_, i) => computed(() => notes()[i].content));

    if (length === prev.value.length) return prev.value;

    if (length < prev.value.length>) {
      return prev.value.slice(0, length); // returns a new instance of the array as we want to notify angular of the "structure" changing as well
    } else {
      const next = [...prev.value]; // returns a new instance of the array as we want to notify angular of the "structure" changing as well
      for (let i = prev.value.length; i < length; i++) {
        next[i] = computed(() => notes()[i].content);
      }

      return next;
    }
  }),
  equal: (a, b) => a.length === b.length // not really necessary, but doesn't hurt :)
})

@Component({
  ...
  template: `{{content()()}}`
})
export class NoteContentComponent {
  readonly content = input.required<Signal<string>>();
}

@Component({
  ...
  template: `
    // we can simply track the signal's reference as it doesn't change. Or we could add an id param to the signal object if we want to be explicit
    @for (contentSig of noteContents(); track contentSig) {
      <app-note-content [content]="contentSig" />
    }
  `
})

```

As you can see, by both stabilizing the array & passing the signals through, only the parts of the UI that are bound to those content signals will update when those signals trigger. The rest stays stable. This allows us to really dial in performance for large tables/lists where we most need it. If you'd like a more `generic` version of what we did above [@mmstack/primitives](https://www.npmjs.com/package/@mmstack/primitives) exposes a helper for it called `mapArray`. Which transforms a T[] into a Signal<T>[] & then provides a map function so you can further transform it as needed :) Here's the code for that if you're curious [mapArray.ts](https://github.com/mihajm/mmstack/blob/master/packages/primitives/src/lib/map-array.ts);

## Outro

We'll that's about all I have for you this time :) I'm currently working on a datatable component using these methods to provide the best possible render performance. I'll hopefuly be launching it soon so look out for any posts about an @mmstack/table-x set of libraries in the future. Happy coding! 🚀
