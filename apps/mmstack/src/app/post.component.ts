import { httpResource } from '@angular/common/http';
import { Component, input } from '@angular/core';

export type Post = {
  userId: number;
  id: number;
  title: string;
  body: string;
};

@Component({
  selector: 'mm-post',
  template: ` Post: {{ post.value()?.title }} {{ id() }}`,
})
export class PostComponent {
  readonly id = input<string>();
  readonly post = httpResource<Post>(() => {
    const id = this.id();
    if (!id) return;
    return {
      url: 'https://jsonplaceholder.typicode.com/posts/' + id,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      responseType: 'json',
    };
  });
}
