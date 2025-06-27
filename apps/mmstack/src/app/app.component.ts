import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { queryResource } from '@mmstack/resource';
import {
  createColumnHelper,
  createTable,
  createTableState,
} from '@mmstack/table-core';
import { TableComponent } from '@mmstack/table-material';

type Post = {
  userId: number;
  id: number;
  title: string;
  body: string;
};

const col = createColumnHelper<Post>();

const columns = [
  col.number((src) => src.userId, {
    name: 'userId',
    header: 'User ID',
  }),
  col.string((src) => src.title, {
    name: 'title',
    header: 'Title',
  }),
];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TableComponent],
  template: ``,
  styles: ``,
})
export class AppComponent {
  private readonly data = queryResource<Post[]>(
    () => ({
      url: 'https://jsonplaceholder.typicode.com/posts',
    }),
    {
      defaultValue: [],
    },
  );

  protected readonly table = createTable(
    () => this.data.value(),
    signal(createTableState()),
    {
      columns,
    },
  );
}
