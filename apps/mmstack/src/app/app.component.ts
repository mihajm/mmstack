import { Component, signal } from '@angular/core';
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
  template: `
    <button (click)="id.set(id() - 1)" [disabled]="id() <= 1">prev</button>
    <button (click)="id.set(id() + 1)">next</button>
    {{ data.value()?.title }}

    <br />
    <button (click)="createPost()">Create Post</button>
  `,
  styles: ``,
})
export class AppComponent {
  protected readonly id = signal(1);
  protected readonly data = queryResource<Post>(
    () => ({
      url: `https://jsonplaceholder.typicode.com/posts/${this.id()}`,
    }),
    {
      keepPrevious: true,
      cache: {
        staleTime: 1000 * 60 * 5, // 5 minutes
        ttl: 1000 * 60 * 60, // 1 hour
      },
    },
  );

  private readonly mutation = mutationResource<Post, Post, Post>(
    (p: Post) => ({
      url: 'https://jsonplaceholder.typicode.com/posts',
      method: 'POST',
      body: p,
    }),
    {
      onSuccess: (data) => {
        console.log('Post created:', data);
      },
      queueIfNetworkUnavailable: true,
    },
  );

  private inc = 1000;

  protected createPost() {
    this.mutation.mutate({
      userId: 1,
      id: this.inc++,
      title: 'New Post',
      body: 'This is a new post created via mutation.',
    });
  }
}
