# @mmstack/local

[![npm version](https://badge.fury.io/js/%40mmstack%2Flocal.svg)](https://www.npmjs.com/package/@mmstack/local)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/form/core/LICENSE)

A set of signal based tools for your local data management needs.

## idb

A powerful, type-safe, and reactive IndexedDB wrapper for modern Angular applications.

`@mmstack/local` provides a simple and resource-based API to manage client-side data with IndexedDB. It offers a type-safe way to define your database schema, perform migrations, and interact with your data reactively & optimistically.

### Features

- 🚀 **First-Class Reactivity:** Provides a signal-based (`ResourceRef`) mirror of your IndexedDB tables, giving you reactive `value`, `isLoading`, and `error` states out of the box.
- ⚡️ **Optimistic Updates:** Fast UI updates with automatic rollbacks on error `.add()`, `.update()`, and `.remove()` update the local signal instantly.
- 🔒 **Type-Safe:** A fully type-safe API from end to end. Your database schema is strongly typed, and all data manipulation methods are type-checked against your data models.
- 🔄 **Cross-Tab Sync:** Opt-in support for automatically syncing state across multiple browser tabs using a `BroadcastChannel`.
- 🔧 **Migrations support:** A system for managing database schema evolution over time.
- 💪 **Resilient by Design:** Graceful fallbacks prevent runtime crashes from configuration errors or unsupported environments (like SSR), ensuring your application remains stable.
- 🍃 **Lightweight & Modern:** Built with modern APIs and a minimal footprint.

### Quick Start

#### 1. Install

```bash
npm install @mmstack/local
```

#### 2. Configure

Define your database schema and provide it to your application **once** in your `app.config.ts`.

```typescript
// app.config.ts
import { ApplicationConfig } from '@angular/core';
import { provideDBConfig } from '@mmstack/local';

export const appConfig: ApplicationConfig = {
  providers: [
    provideDBConfig({
      dbName: 'my-todo-app',
      version: 1,
      syncTabs: true, // Enable cross-tab synchronization
      schema: {
        tasks: {
          primaryKey: 'id',
          autoIncrement: true,
          indexes: {
            byStatus: { keyPath: 'status' },
          },
        },
      },
    }),
  ],
};
```

#### 3. Usage

Use the `idb` helper function in any component or service to get a reactive handle to your table.

```typescript
// task-list.component.ts

type Task = {
  id?: number;
  title: string;
  status: 'pending' | 'completed';
};

@Component({
  selector: 'app-task-list',
  template: `
    @if (tasks.isLoading()) {
      <p>Loading tasks...</p>
    }
    <ul>
      @for (task of tasks.value(); track task.id) {
        <li>{{ task.title }}</li>
      }
    </ul>
    <button (click)="addTask()">Add New Task</button>
  `,
})
export class TaskList {
  // a call to 'tasks' will always return the same instance, so updates happen across the entire application
  tasks = idb<Task, 'id'>('tasks');

  constructor() {
    effect(() => {
      console.log('Tasks in the database:', this.tasks.value());
    });
  }

  async addTask() {
    await this.tasks.add({ title: 'A new adventure!', status: 'pending' });
    console.log('Task added successfully!');
  }
}
```

### Advanced topics

#### Migrations

For the initial creation of your database (`version: 1`), the declarative `schema` is all you need. To upgrade your database to a new version, provide a `migrations` map.

```typescript
provideDBConfig({
  dbName: 'my-todo-app',
  version: 2, // New version
  schema: {
    tasks: {
      primaryKey: 'id',
      autoIncrement: true,
      indexes: {
        byStatus: { keyPath: 'status' },
        byPriority: { keyPath: 'priority' }, // New index added in v2
      },
    },
  },
  migrations: {
    // This function runs when a user on v1 upgrades to v2
    2: (db, transaction) => {
      const tasksStore = transaction.objectStore('tasks');
      tasksStore.createIndex('byPriority', 'priority');
    },
  },
});
```

#### Lifecycle Events

You can provide hooks to react to database lifecycle events, which is crucial for handling multi-tab scenarios.

```typescript
provideDBConfig({
  // ...
  onblocked: () => {
    alert('Database upgrade is blocked. Please close all other tabs.');
  },
  onversionchange: () => {
    // The library will automatically close the connection after calling this.
    alert('Database is outdated. The page will now reload.');
    window.location.reload();
  },
});
```

## Contributing

Contributions, issues, and feature requests are welcome!
