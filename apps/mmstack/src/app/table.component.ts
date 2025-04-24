import { httpResource } from '@angular/common/http';
import { Component, computed } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBar } from '@angular/material/progress-bar';
import { faker } from '@faker-js/faker';
import { queryResource } from '@mmstack/resource';
import { createClientModel } from '@mmstack/table-client';
import {
  ColumnDef,
  createColumnHelper,
  createTable,
  createTableState,
  TableState,
} from '@mmstack/table-core';
import { TableComponent } from '@mmstack/table-material';

type EventDef = {
  id: string;
  name: string;
  age: number;
  test: {
    id: string;
    label: string;
  };
};

const col = createColumnHelper<EventDef>();

const columns = [
  col.accessor((e) => e.id, {
    name: 'id',
  }),
  col.accessor((e) => e.name, {
    name: 'name',
  }),
];

type Post = {
  id: number;
  title: string;
  body: string;
};

const todoColumns: ColumnDef<Post, string | number, 'id' | 'title' | 'body'>[] =
  [
    {
      name: 'id',
      header: () => 'ID',
      accessor: (row) => row.id,
      footer: () => 'yay',
    },
    {
      name: 'title',
      header: () => 'Title',
      accessor: (row) => row.title,
      footer: () => 'zaz',
    },
    {
      name: 'body',
      header: () => 'Body',
      accessor: (row) => row.body,
      footer: () => 'zaz',
    },
  ];

function resolveSort({ sort }: TableState): string | null {
  if (!sort) return null;

  return sort.direction === 'desc' ? `-${sort.name}` : sort.name;
}

const VALUES = Array.from({ length: 3000 }, (_, i): Post => {
  return {
    id: i,
    title: faker.person.firstName(),
    body: `Body ${i}`,
  };
});

@Component({
  selector: 'app-table-demo',
  imports: [MatProgressBar, TableComponent, MatCardModule],
  template: `
    <mat-progress-bar
      mode="indeterminate"
      [style.visibility]="events.isLoading() ? 'visible' : 'hidden'"
    />
    <mat-card>
      <mm-table [state]="todoTable" />
    </mat-card>
  `,
  styles: `
    mat-card {
      margin: 2rem;
      max-height: 80vh;
    }
  `,
})
export class TablePlaygroundComponent {
  readonly tableState = createTableState(columns);

  readonly events = queryResource<EventDef[]>(
    () => {
      const sortParam = resolveSort(this.tableState());

      const baseState = {
        offset:
          this.tableState().pagination.page *
          this.tableState().pagination.pageSize,
        limit: this.tableState().pagination.pageSize,
        search: this.tableState().globalFilter,
      };

      return {
        url: 'http://localhost:3000/api/event-definition',
        params: sortParam
          ? {
              ...baseState,
              sort: sortParam,
            }
          : baseState,
      };
    },
    {
      keepPrevious: true,
      defaultValue: [],
    },
  );

  readonly todos = httpResource<Post[]>(
    'https://jsonplaceholder.typicode.com/posts',
    {
      defaultValue: [],
    },
  );
  readonly todoState = createTableState(todoColumns);

  readonly todoTable = createTable({
    data: () => VALUES,
    model: createClientModel(),
    columns: todoColumns,
    state: this.todoState,
    opt: {
      rowSelect: {
        enableRowSelection: true,
      },
    },
  });

  readonly table = createTable({
    data: this.events.value,
    columns,
    state: this.tableState,
    opt: {
      pagination: {
        total: computed(() => {
          const t = this.events.headers()?.get('Content-Range')?.split('/')[1];
          if (t === undefined) return 0;

          return parseInt(t, 10);
        }),
      },
    },
  });
}
