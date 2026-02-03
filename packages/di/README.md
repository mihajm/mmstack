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
- `rootInjectable` - Creates a lazily-initialized root-level injectable that maintains a singleton instance.

---

## injectable

Creates a typed InjectionToken with convenient inject and provide helper functions, eliminating boilerplate and ensuring type safety throughout your dependency injection flow. It returns a tuple of `[injectFn, provideFn]` that work together seamlessly.

The `injectable` function supports three patterns:

1. **Basic** - Returns `T | null` when not provided
2. **With Fallback** - Returns a default value when not provided
3. **With Error** - Throws a custom error message when not provided

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
  const http = injector.get(HttpClient);

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

### Browser API Wrapper

Wrap browser APIs in a testable, injectable way:

```typescript
import { rootInjectable } from '@mmstack/di';

interface StorageService {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
  clear: () => void;
}

const injectStorage = rootInjectable<StorageService>(() => {
  // SSR-safe check
  if (typeof localStorage === 'undefined') {
    return {
      get: () => null,
      set: () => {},
      remove: () => {},
      clear: () => {},
    };
  }

  return {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
    clear: () => localStorage.clear(),
  };
});

@Injectable()
export class PreferencesService {
  private storage = injectStorage();

  saveTheme(theme: string) {
    this.storage.set('theme', theme);
  }

  loadTheme(): string {
    return this.storage.get('theme') ?? 'light';
  }
}
```

---

## Best Practices

### When to use `injectable`

- ✅ Creating flexible, reusable dependencies
- ✅ Building context-based injection patterns
- ✅ Need different implementations in different parts of the app
- ✅ Testing with mock providers

### When to use `rootInjectable`

- ✅ Application-wide singletons (logger, analytics, etc.)
- ✅ Global state management
- ✅ Browser API wrappers
- ✅ Performance-critical singleton services
- ❌ Avoid for services that need different instances per scope

### Testing

Both utilities work seamlessly with Angular's testing utilities:

```typescript
import { TestBed } from '@angular/core/testing';
import { injectable } from '@mmstack/di';

const [injectConfig, provideConfig] = injectable<{ apiUrl: string }>('Config');

describe('DataService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideConfig({ apiUrl: 'https://test-api.example.com' }), DataService],
    });
  });

  it('should use test configuration', () => {
    const service = TestBed.inject(DataService);
    expect(service.getApiUrl()).toBe('https://test-api.example.com');
  });
});
```

---

## Type Safety

Both utilities provide full type safety:

```typescript
const [injectConfig, provideConfig] = injectable<{ port: number }>('Config');

// ✅ Type-safe
provideConfig({ port: 3000 });

// ❌ TypeScript error: missing property
provideConfig({});

// ❌ TypeScript error: wrong type
provideConfig({ port: '3000' });

// Inject function returns correct type
const config = injectConfig(); // { port: number } | null
```

---

## License

MIT © [Miha Mulec](https://github.com/mihajm)
