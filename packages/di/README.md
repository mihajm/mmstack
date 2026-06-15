# @mmstack/di

A collection of dependency injection utilities for Angular that simplify working with InjectionTokens and provide type-safe patterns for creating injectable services.

[![npm version](https://badge.fury.io/js/%40mmstack%2Fdi.svg)](https://badge.fury.io/js/%40mmstack%2Fdi)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/di/LICENSE)

## Installation

```bash
npm install @mmstack/di
```

## Utilities

This library provides the following utilities:

- `injectable` - Creates a typed InjectionToken with inject and provide helper functions for type-safe dependency injection.
- `injectLazy` - Defers the resolution and instantiation of a token until it is actually accessed.
- `injectAsync` - Lazily loads a service's code chunk (a dynamic `import()`) and resolves it from DI on first access. A v19+ port of Angular v22's `injectAsync` that additionally works for non-root services and adds prefetch/scoping options.
- `provideLazy` - Registers a lazy dependency against a token: drop its provider into any `providers` array and inject a memoized async getter deep in the tree, without statically importing the module.
- `createRunInInjectionContext` - Captures an injection context and returns a runner function, useful for `inject()` inside async callbacks.
- `rootInjectable` - Creates a lazily-initialized root-level injectable that maintains a per-application singleton instance.
- `createScope` - Creates a dependency injection scope that caches singletons based on the factory function.
- `provideAs` - Tiny helper that builds a `useValue` or `useFactory` provider depending on what you hand it.

## When to use what

Angular's own DI primitives cover a lot of ground — these helpers are thin, named conveniences on top of them, and a couple of Angular's newer built-ins may already be exactly what you need:

| You want to…                                                                | Reach for                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Inject a service, normally                                                  | Angular's `inject()`                                                    |
| A class singleton for the whole app                                          | Angular's `@Injectable({ providedIn: 'root' })`                         |
| A typed token + provide/inject pair without the `InjectionToken` boilerplate | `injectable` (think `createContext` for Angular)                        |
| Defer **constructing** an already-bundled service until first use            | `injectLazy`                                                            |
| Lazy-load the code for a `providedIn: 'root'` / `@Service()` service (v22+)   | Angular's native `injectAsync` — built in, nothing needed here 🎉        |
| Lazy-load a service that **isn't** root-provided, or support v19–v21          | `injectAsync` (this lib)                                                |
| Register a lazy dependency in a `providers` array and inject it deep in the tree | `provideLazy`                                                        |
| A factory-built (non-class) app-wide singleton                               | `rootInjectable`                                                        |
| A whole family of factory-built singletons scoped to a component subtree     | `createScope`                                                           |
| Run `inject()` later, in a callback that lost the context                    | `createRunInInjectionContext` (or Angular's `runInInjectionContext`)    |

**Native `injectAsync` vs this one.** On Angular v22+, if the lazily-loaded service is auto-provided (`@Injectable({ providedIn: 'root' })` or `@Service()`), Angular's built-in `injectAsync` is all you need. Reach for **this** library's `injectAsync` when either is true: you're on **v19–v21** (no built-in), or the service **isn't** root-provided — a plain `@Injectable()`, or one you want scoped to a component/route. Native rejects those; this one auto-provides and scopes them (and adds `optional`, `prefetch`, `providedWith`, and lifecycle-tied teardown). `provideLazy` builds on it for the "provide once, inject anywhere below" pattern.

`injectLazy` and `injectAsync` also compose: `injectAsync` gets the code onto the page, `injectLazy` decides when an instance is constructed.

### A note on SSR

Fallbacks (`injectable`'s `fallback`/`lazyFallback`) and `rootInjectable` singletons are implemented as **token factories**, which Angular caches *per root injector*. That means every application — including every server-side request, which gets its own root injector — lazily constructs its own instance. Module-scope definition, per-app state: you can define these at the top of a file without anything leaking between requests, tests, or multiple apps on one page.

---

## injectable

Creates a typed InjectionToken with convenient, type-safe inject and provider functions, eliminating boilerplate and ensuring type safety throughout your dependency injection flow. It returns a tuple of `[injectFn, provideFn, token]` that work together seamlessly (the raw token is there for interop — destructure it only when you need it).

The `injectable` function supports four patterns:

1. **Basic** - Returns `T | null` when not provided
2. **With Fallback** - Returns a default value when not provided
3. **With Lazy Fallback** - Same as with fallback, but the fallback is lazily evaluated — useful for expensive fallbacks or ones that require injection. Evaluated at most once *per application* (SSR-safe, see the note above).
4. **With Error** - Throws a custom error message when not provided

### Basic Usage

```typescript
import { Component, Injectable } from '@angular/core';
import { injectable } from '@mmstack/di';

// Create a typed injectable
const [injectLogger, provideLogger] = injectable<Logger>('Logger');

// Provide the value in a component or module
@Component({
  selector: 'app-root',
  providers: [
    provideLogger({
      log: (msg) => console.log(`[LOG]: ${msg}`),
      error: (msg) => console.error(`[ERROR]: ${msg}`),
    }),
  ],
})
export class AppComponent {}

// Inject it anywhere in the component tree
@Injectable()
export class DataService {
  private logger = injectLogger(); // Logger | null

  fetchData() {
    this.logger?.log('Fetching data...');
  }
}
```

### With Factory Dependencies

```typescript
import { HttpClient } from '@angular/common/http';
import { injectable } from '@mmstack/di';

interface ApiConfig {
  baseUrl: string;
  timeout: number;
}

const [injectApiConfig, provideApiConfig] = injectable<ApiConfig>('ApiConfig');

// Provide using a factory with dependencies
@Component({
  providers: [
    provideApiConfig(
      (http: HttpClient) => ({
        baseUrl: 'https://api.example.com',
        timeout: 5000,
      }),
      [HttpClient], // Dependencies array
    ),
  ],
})
export class AppComponent {}
```

### With Fallback Value

When you want to provide a default value instead of returning `null`:

```typescript
import { injectable } from '@mmstack/di';

interface Theme {
  primary: string;
  secondary: string;
}

const [injectTheme, provideTheme] = injectable<Theme>('Theme', {
  fallback: {
    primary: '#007bff',
    secondary: '#6c757d',
  },
});

// or if you need inject/lazy evaluation
const [injectTheme, provideTheme] = injectable<Theme>('Theme', {
  lazyFallback: () => {
    return {
      primary: inject(APP_PRIMARY),
      secondary: '#6c757d',
    },
  }
});

@Injectable()
export class ThemeService {
  // Always returns a Theme, never null
  private theme = injectTheme();

  getPrimaryColor() {
    return this.theme.primary; // Safe to access
  }
}
```

### With Error Message

When you want to enforce that the value must be provided:

```typescript
import { injectable } from '@mmstack/di';

const [injectApiKey, provideApiKey] = injectable<string>('ApiKey', {
  errorMessage: 'API Key is required! Please provide it using provideApiKey().',
});

@Injectable()
export class ApiService {
  // Throws error if not provided
  private apiKey = injectApiKey();

  makeRequest() {
    // apiKey is guaranteed to exist here
    return fetch(`https://api.example.com?key=${this.apiKey}`);
  }
}
```

### Providing Functions as Values

The `provideFn` correctly handles functions as values (not factories):

```typescript
import { injectable } from '@mmstack/di';

type Validator = (value: string) => boolean;

const [injectValidator, provideValidator] = injectable<Validator>('Validator');

@Component({
  providers: [
    // Providing a function as a value (not a factory)
    provideValidator((value: string) => value.length > 5),
  ],
})
export class FormComponent {
  private validator = injectValidator();

  validate(input: string) {
    return this.validator?.(input) ?? false;
  }
}
```

### Interop: the raw token

The third tuple element is the underlying `InjectionToken` — handy for `deps` arrays, `Injector.create`, or `TestBed.overrideProvider`:

```typescript
const [injectApi, provideApi, API_TOKEN] = injectable<ApiClient>('Api');

// In a classic factory provider elsewhere:
{ provide: OTHER, useFactory: (api: ApiClient) => new Other(api), deps: [API_TOKEN] }

// In a test:
TestBed.overrideProvider(API_TOKEN, { useValue: fakeApi });
```

### Advanced: Scoped Context Pattern

Create context-like dependency injection patterns:

```typescript
import { Component, Injectable } from '@angular/core';
import { injectable } from '@mmstack/di';

interface FormContext {
  formId: string;
  isDirty: boolean;
  submit: () => void;
}

const [injectFormContext, provideFormContext] = injectable<FormContext>('FormContext', {
  errorMessage: 'FormContext must be provided by a parent form component',
});

@Component({
  selector: 'app-form',
  providers: [
    provideFormContext({
      formId: 'user-form',
      isDirty: false,
      submit: () => console.log('Submitting form...'),
    }),
  ],
  template: `
    <form>
      <app-form-field></app-form-field>
      <app-form-actions></app-form-actions>
    </form>
  `,
})
export class FormComponent {}

@Component({
  selector: 'app-form-field',
  template: `<input [id]="formContext.formId + '-input'" />`,
})
export class FormFieldComponent {
  // Automatically gets the context from parent
  formContext = injectFormContext();
}

@Component({
  selector: 'app-form-actions',
  template: `<button (click)="formContext.submit()">Submit</button>`,
})
export class FormActionsComponent {
  formContext = injectFormContext();
}
```

---

## injectLazy

Defers the resolution and instantiation of an injection token until the returned getter function is actually called.

Angular's native `inject()` resolves and instantiates dependencies immediately during the construction phase. If a service is heavily resource-intensive but only needed conditionally (like an export service or a complex editor), `injectLazy` allows you to capture the injection context immediately while delaying instantiation. The resolved value is cached, acting as a standard scoped singleton on subsequent calls.

> **`injectLazy` vs `injectAsync`:** they solve adjacent problems. `injectAsync(() => import('./heavy'))` defers *loading the code* (a separate bundle chunk) and returns a `Promise`; `injectLazy(Heavy)` defers *constructing* an already-bundled service and stays synchronous. If your goal is bundle size, use [`injectAsync`](#injectasync). If your goal is construction timing (or you need a sync getter), `injectLazy` is the fit. They also compose.

### Basic Usage

```typescript
import { Component, HostListener } from '@angular/core';
import { injectLazy } from '@mmstack/di';

@Component({
  selector: 'app-export-button',
  template: `<button>Export Data</button>`,
})
export class ExportButtonComponent {
  // Captures the Injector but does NOT instantiate HeavyExportService yet
  private getExportService = injectLazy(HeavyExportService);

  @HostListener('click')
  export() {
    // HeavyExportService is instantiated on the first click, then cached
    const service = this.getExportService();
    service.doExport();
  }
}
```

### With Options

It fully supports Angular's `InjectOptions` and guarantees correct return types (e.g., returning `T | null` when `optional: true`):

```typescript
const getOptionalDep = injectLazy(MyToken, { optional: true });

// Later...
const dep = getOptionalDep(); // MyToken | null
```

---

## injectAsync

Lazily loads a service's code chunk via a dynamic `import()` and resolves it from DI on first access — a v19+ port of Angular v22's native [`injectAsync`](https://angular.dev/api/core/injectAsync). It returns a memoized getter; the loader runs at most once, and the resolved instance is cached. Must be called in an injection context.

**Use the native one when you can.** On Angular v22+, if the service is auto-provided (`@Injectable({ providedIn: 'root' })` or `@Service()`), reach for Angular's built-in `injectAsync` — nothing here is needed. This implementation exists for the cases the built-in can't cover:

- **Angular v19–v21**, which have no `injectAsync` at all.
- **Services that aren't root-provided** — a plain `@Injectable()`, or one you want scoped to a component/route. The native API _requires_ `providedIn: 'root'` / `@Service()` because it resolves via `injector.get(token)`. This version instead does a behavioral probe: if the token resolves through normal DI you get that instance (identical to native, including the root singleton); otherwise, if it's a class, it's **auto-provided** in a child injector scoped to — and destroyed with — the target injector.

### Basic Usage

```typescript
import { Component } from '@angular/core';
import { injectAsync } from '@mmstack/di';

@Component({
  selector: 'app-editor',
  template: `<button (click)="preview()">Preview</button>`,
})
export class EditorComponent {
  // MarkdownService lives in its own chunk — not loaded until preview() runs.
  private readonly markdown = injectAsync(() =>
    import('./markdown.service').then((m) => m.MarkdownService),
  );

  async preview(src: string) {
    const svc = await this.markdown(); // loads + resolves on first call, cached after
    return svc.render(src);
  }
}
```

A default-export module works too — `injectAsync(() => import('./markdown.service'))` when `MarkdownService` is the module's `default` export.

### Options

`injectAsync(loader, options?)` accepts:

- **`optional`, `self`, `skipSelf`, `host`** — the same `InjectOptions` flags as `injectLazy`. `{ optional: true }` widens the getter to `Promise<T | null>` (returned when a token loader has no provider; a loaded _class_ always resolves).
- **`prefetch`** — eagerly load ahead of the first access. Pass `'idle'`, a millisecond deadline (`number`), or a custom `() => Promise<void>` trigger. Only runs in the browser, and is skipped on slow / data-saver connections.
- **`providedWith`** — an `Injector` (or `InjectionToken<Injector>`) to resolve/auto-provide against, instead of the call-site injector. This is the knob `provideLazy` builds on.

```typescript
// Prefetch the chunk when the browser goes idle:
private readonly heavy = injectAsync(
  () => import('./heavy.service').then((m) => m.HeavyService),
  { prefetch: 'idle' },
);
```

> **SSR:** `injectAsync` holds no module-level state — everything is captured per-call (per request), and `prefetch` is a no-op on the server. Like the native API, the in-flight import is **not** registered with `PendingTasks`, so it won't hold server rendering — it's meant for interaction-time services, not render-blocking data.

---

## provideLazy

Registers a lazily-loaded dependency against a token and returns a `[injectFn, provideFn, token]` tuple. The provided value is a **loader** (a dynamic `import()`) rather than an eager value — so you can declare a lazy dependency in a route's (or component's) `providers` and inject it deep in the tree, without that consumer statically importing the module.

It's built on `injectAsync`, so it inherits auto-provisioning, lifecycle-tied teardown, and the options above. **Scope-shared:** every consumer under the same provider boundary shares one instance and one in-flight load — the resolver is built once at the provide site, matching what putting something in `providers` means.

```typescript
import { Component } from '@angular/core';
import { Routes } from '@angular/router';
import { provideLazy } from '@mmstack/di';

const [injectMarkdown, provideMarkdown] = provideLazy<MarkdownService>('Markdown');

// Register the lazy dependency at a route boundary:
const routes: Routes = [
  {
    path: 'docs',
    providers: [
      provideMarkdown(() => import('./markdown.service').then((m) => m.MarkdownService)),
    ],
    loadComponent: () => import('./docs.component'),
  },
];

// Consume it anywhere under that route — no static import of the module:
@Component({
  selector: 'app-docs',
  template: `...`,
})
export class DocsComponent {
  private readonly markdown = injectMarkdown(); // () => Promise<MarkdownService>, memoized & shared
  async preview(src: string) {
    return (await this.markdown()).render(src);
  }
}
```

`injectFn()` accepts `{ optional: true }` (resolves `null` if no loader was provided rather than throwing), and the third tuple element is the raw loader `InjectionToken` — handy for `TestBed.overrideProvider(token, { useValue: mockLoader })`.

---

## createRunInInjectionContext

Captures an injection context securely and returns a runner function.

This utility allows you to execute callbacks inside the captured context at a later time. It solves the common pain point of needing to use `inject()` inside asynchronous callbacks, RxJS streams, or external event listeners where the framework's implicit injection context has been lost.

### Basic Usage

```typescript
import { Component, OnInit, inject } from '@angular/core';
import { createRunInInjectionContext } from '@mmstack/di';

@Component({
  selector: 'app-dialog-trigger',
  template: `<button>Open Dialog</button>`,
})
export class DialogTriggerComponent implements OnInit {
  // Grabs the current injector during construction
  private runInContext = createRunInInjectionContext();

  ngOnInit() {
    // someExternalLibrary is out of Angular's zone/context
    someExternalLibrary.on('openEvent', () => {
      this.runInContext(() => {
        // We can safely use `inject()` here even though we are inside an async callback!
        const dialog = inject(DialogService);
        dialog.open();
      });
    });
  }
}
```

### With Explicit Injector

You can also completely bypass the ambient capture and provide an `Injector` explicitly:

```typescript
// Outside of normal injection context
const runner = createRunInInjectionContext(appRef.injector);

runner(() => {
  const router = inject(Router);
  router.navigate(['/home']);
});
```

---

## rootInjectable

Creates a lazily-initialized root-level injectable that maintains a singleton instance across your entire application. The factory function runs in the root injection context on first access, allowing you to inject other dependencies.

**Important:** This should only be used for pure singletons. If you need scoped instances, use regular `@Injectable` services with `providedIn` or component-level providers.

### Basic Usage

```typescript
import { Injectable } from '@angular/core';
import { rootInjectable } from '@mmstack/di';

interface Logger {
  log: (message: string) => void;
}

// Create a root-level injectable
const injectLogger = rootInjectable<Logger>(() => ({
  log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
}));

@Injectable()
export class DataService {
  private logger = injectLogger();

  fetchData() {
    this.logger.log('Fetching data...');
  }
}

@Injectable()
export class UserService {
  private logger = injectLogger(); // Same instance as above

  saveUser() {
    this.logger.log('Saving user...');
  }
}
```

### With Dependencies

The factory function receives the root injector, allowing you to inject other services:

```typescript
import { HttpClient } from '@angular/common/http';
import { rootInjectable } from '@mmstack/di';

interface ApiClient {
  get: (url: string) => Promise<any>;
  post: (url: string, data: any) => Promise<any>;
}

const injectApiClient = rootInjectable<ApiClient>((injector) => {
  const http = injector.get(HttpClient); // or just inject(HttpClient)

  return {
    get: (url) => fetch(url).then((r) => r.json()),
    post: (url, data) =>
      fetch(url, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then((r) => r.json()),
  };
});

@Injectable()
export class ProductService {
  private api = injectApiClient(); // Singleton instance

  loadProducts() {
    return this.api.get('/api/products');
  }
}
```

### State Management Example

Create a simple global state manager:

```typescript
import { signal, computed } from '@angular/core';
import { rootInjectable } from '@mmstack/di';

interface User {
  id: string;
  name: string;
  email: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
}

const injectAuthStore = rootInjectable(() => {
  const user = signal<User | null>(null);
  const isAuthenticated = computed(() => user() !== null);

  return {
    user: user.asReadonly(),
    isAuthenticated,
    login: (userData: User) => user.set(userData),
    logout: () => user.set(null),
  };
});

@Injectable()
export class AuthService {
  private store = injectAuthStore(); // Singleton across app

  login(email: string, password: string) {
    // Perform authentication...
    this.store.login({
      id: '123',
      name: 'John Doe',
      email,
    });
  }

  logout() {
    this.store.logout();
  }
}

@Component({
  selector: 'app-navbar',
  template: `
    @if (authStore.isAuthenticated()) {
      <span>{{ authStore.user()?.name }}</span>
      <button (click)="logout()">Logout</button>
    }
  `,
})
export class NavbarComponent {
  authStore = injectAuthStore(); // Same instance

  logout() {
    this.authStore.logout();
  }
}
```

---

## createScope

Creates a dependency injection scope using a dynamic `InjectionToken` representing a caching registry. Factories executed within the scope run in the Angular injection context and their results are cached, effectively creating scoped singletons, that are destroyed when the scoped provider is. It returns a tuple of `[injectable, provider]`.

### Basic Usage

```typescript
import { Component, inject } from '@angular/core';
import { createScope } from '@mmstack/di';

// Create the scope
const [injectableFeatureItem, provideFeatureScope] = createScope('FeatureScope');

// Provide the scope at a specific component level boundary
@Component({
  selector: 'app-feature',
  providers: [provideFeatureScope()],
  template: `<app-child></app-child>`,
})
export class FeatureComponent {}

// Use the scope to register an item factory
// The factory will run in the injection context so you can use inject()
const useFeatureItem = injectableFeatureItem(() => {
  const someDep = inject(SomeDependency);
  return {
    id: Math.random(),
    doWork: () => someDep.work(),
  };
});

@Component({
  selector: 'app-child',
  template: `<div>Child Item ID: {{ item.id }}</div>`,
})
export class ChildComponent {
  // Always returns the exact same instance for this specific scope provider boundary
  item = useFeatureItem();
}
```

Each subtree that provides the scope gets its **own** set of instances — two sibling `<app-feature>` components don't share anything.

### Overrides (testing / Storybook)

The provide function accepts `overrides` — pairs of `[injectFn, replacementFactory]` that swap a specific registration at that boundary only. Dependents resolve the override transitively:

```typescript
const [register, provideFeatureScope] = createScope('FeatureScope');

const injectLogger = register(() => inject(RealLogger));
const injectWorker = register(() => createWorker(injectLogger()));

// In a test or story — same scope, stubbed logger:
TestBed.configureTestingModule({
  providers: [
    provideFeatureScope({
      overrides: [[injectLogger, () => ({ log: () => void 0 })]],
    }),
  ],
});
// injectWorker() now receives the stub too
```

---

## provideAs

A tiny convenience that builds a provider from either a plain value (`useValue`) or a zero-arg factory (`useFactory`). The factory branch runs in an injection context, so it can use `inject()`:

```typescript
import { provideAs } from '@mmstack/di';

providers: [
  provideAs(RETRY_COUNT, 3), // useValue
  provideAs(API_CONFIG, () => ({ baseUrl: inject(BASE_URL) })), // useFactory, inject() works
];
```

> **Heads up:** functions are *always* treated as factories. If your token holds a function type, wrap the value: `provideAs(VALIDATOR, () => myValidatorFn)` — passing it bare would call it as a factory.

---

## License

MIT © [Miha Mulec](https://github.com/mihajm)
