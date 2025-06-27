import { Component, untracked } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { mutationResource, queryResource } from '@mmstack/resource';
import { createColumnHelper } from '@mmstack/table-core';
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
  template: `<button (click)="test()">Test Mutation</button>
    {{ data.value().length }}`,
  styles: ``,
})
export class AppComponent {
  protected readonly data = queryResource<Post[]>(
    () => ({
      url: 'https://jsonplaceholder.typicode.com/posts',
    }),
    {
      defaultValue: [],
    },
  );

  private readonly mutation = mutationResource(
    (post: Post) => {
      return {
        url: 'https://jsonplaceholder.typicode.com/posts',
        method: 'POST',
        body: post,
      };
    },
    {
      onMutate: (post) => {
        const prev = untracked(this.data.value);
        this.data.update((prev) => [...prev, post]);
        return prev;
      },
      onError: (err, ctx) => {
        this.data.set(ctx);
      },
    },
  );

  test() {
    this.mutation.mutate({
      id: 1,
      userId: 1,
      title: 'Test Post',
      body: 'This is a test post.',
    });
  }
}
