# @mmstack/form-core

[![npm version](https://badge.fury.io/js/%40mmstack%2Fform-core.svg)](https://www.npmjs.com/package/@mmstack/form-core)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/form/core/LICENSE)

`@mmstack/form-core` is an Angular library that provides a powerful, signal-based approach to building reactive forms. It offers a flexible and type-safe alternative to `ngModel` and Angular's built-in reactive forms, while leveraging the efficiency of Angular signals. This library is designed for fine-grained reactivity and predictable state management, making it ideal for complex forms and applications.

## Features

- **Signal-Based:** Fully utilizes Angular signals for efficient change detection and reactivity.
- **Type-Safe:** Strongly typed API with excellent TypeScript support, ensuring compile-time safety and reducing runtime errors.
- **Composable Primitives:** Provides `formControl`, `formGroup`, and `formArray` primitives that can be composed to create forms of any complexity.
- **Predictable State:** Emphasizes immutability and a clear data flow, making it easier to reason about form state.
- **Customizable Validation:** Supports synchronous validators with full type safety.
- **Dirty and Touched Tracking:** Built-in tracking of `dirty` and `touched` states for individual controls and aggregated states for groups and arrays.
- **Reconciliation:** Efficiently updates form state when underlying data changes (e.g., when receiving data from an API).
- **Extensible:** Designed to be easily extended with custom form controls and validation logic.
- **UI Library Agnostic**: `form-core` can be used with any UI library

## Quick Start

1.  Install `@mmstack/form-core`.

    ```bash
    npm install @mmstack/form-core
    ```

2.  Start creating cool forms! :)

    ```typescript
    import { Component } from '@angular/core';
    import { formControl, formGroup } from '@mmstack/form-core';
    import { FormsModule } from '@angular/forms';

    @Component({
      selector: 'app-user-form',
      imports: [FormsModule],
      template: `
        <div>
          <label>
            Name:
            <input [value]="name.value()" (input)="name.value.set($any($event.target).value)" [class.invalid]="name.error() && name.touched()" (blur)="name.markAsTouched()" />
          </label>
        </div>
        <div>
          <label>
            Age:
            <input [(ngModel)]="age.value" type="number" [class.invalid]="age.error() && age.touched()" (blur)="age.markAsTouched()" />
            <span *ngIf="age.error() && age.touched()">{{ age.error() }}</span>
          </label>
        </div>
      `,
    })
    export class UserFormComponent {
      name = formControl('', {
        validator: () => (value) => (value ? '' : 'Name is required'),
      });
      age = formControl<number | undefined>(undefined, {
        //specify the type explicitely to have number type.
        validator: () => (value) => (value && value > 0 ? '' : 'Age must be a positive number'),
      });
    }
    ```

## Slightly more complex example

```typescript
import { Component, computed, inject, Injectable, isDevMode, linkedSignal, Signal, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { derived, formControl, FormControlSignal, formGroup, FormGroupSignal } from '@mmstack/form-core';
import { mutationResource, queryResource } from '@mmstack/resource';

type Post = {
  id: number;
  title?: string;
  body?: string;
};

@Injectable({
  providedIn: 'root',
})
export class PostsService {
  private readonly endpoint = 'https://jsonplaceholder.typicode.com/posts';

  readonly id = signal(1);

  readonly post = queryResource<Post>(
    () => ({
      url: `${this.endpoint}/${this.id()}`,
    }),
    {
      keepPrevious: true,
      cache: true,
    },
  );

  next() {
    this.id.update((id) => id + 1);
  }

  prev() {
    this.id.update((id) => id - 1);
  }

  private readonly createPostResource = mutationResource(
    () => ({
      url: this.endpoint,
      method: 'POST',
    }),
    {
      onMutate: (post: Post) => {
        const prev = untracked(this.post.value);
        this.post.set({ ...prev, ...post });
        return prev;
      },
      onError: (err, prev) => {
        if (isDevMode()) console.error(err);
        this.post.set(prev); // rollback on error
      },
      onSuccess: (next) => {
        this.post.set(next);
      },
    },
  );

  readonly loading = computed(() => this.createPostResource.isLoading() || this.post.isLoading());

  createPost(post: Post) {
    this.createPostResource.mutate({
      body: post,
    }); // send the request
  }

  updatePost(id: number, post: Partial<Post>) {
    this.createPostResource.mutate({
      body: { id, ...post },
      url: `${this.endpoint}/${id}`,
      method: 'PATCH',
    }); // send the request
  }
}

type PostState = FormGroupSignal<
  Post,
  {
    title: FormControlSignal<string | undefined, Post>;
    body: FormControlSignal<string | undefined, Post>;
  }
>;

function createPostState(post: Post, loading: Signal<boolean>): PostState {
  const value = signal<Post>(post);

  return formGroup(value, {
    title: formControl(derived(value, 'title'), {
      label: () => 'Title',
      readonly: loading,
      validator: () => (value) => (value ? '' : 'Title is required'),
    }),
    body: formControl(derived(value, 'body'), {
      label: () => 'Body',
      readonly: loading,
      validator: () => (value) => {
        if (value && value.length > 255) return 'Body is too long';
        return '';
      },
    }),
  });
}

@Component({
  selector: 'app-post-form',
  imports: [FormsModule],
  template: `
    <label
      >{{ formState().children().title.label() }}
      <input [(ngModel)]="formState().children().title.value" [readonly]="formState().children().body.readonly()" [class.error]="formState().children().title.touched() && formState().children().title.error()" />
    </label>
    <br />

    <label
      >{{ formState().children().body.label() }}
      <textarea [(ngModel)]="formState().children().body.value" [readonly]="formState().children().body.readonly()" [class.error]="formState().children().body.touched() && formState().children().body.error()"></textarea>
    </label>

    <br />

    <button (click)="submit()" [disabled]="svc.loading()">Submit</button>
  `,
})
export class PostFormComponent {
  protected readonly svc = inject(PostsService);

  protected readonly formState = linkedSignal<Post, PostState>({
    source: () => this.svc.post.value() ?? { title: '', body: '', id: -1, userId: -1 },
    computation: (source, prev) => {
      if (prev) {
        prev.value.forceReconcile(source);
        return prev.value;
      }

      return createPostState(source, this.svc.loading);
    },
  });

  protected submit() {
    if (untracked(this.svc.loading)) return;
    const state = untracked(this.formState);
    if (!untracked(state.valid)) return state.markAllAsTouched();
    const value = untracked(state.value);
    if (value.id === -1) this.svc.createPost(value);
    else this.svc.updatePost(value.id, untracked(state.partialValue));
  }
}
```

## In-depth

For an in-depth explanation of the primitives & how they work check out this article: [Fun-grained Reactivity in Angular: Part 2 - Forms](https://dev.to/mihamulec/fun-grained-reactivity-in-angular-part-2-forms-e84)
