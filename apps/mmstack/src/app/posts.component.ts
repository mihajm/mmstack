import { httpResource } from '@angular/common/http';
import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

export type Post = {
  userId: number;
  id: number;
  title: string;
  body: string;
};

@Component({
  selector: 'app-posts',
  imports: [RouterLink, RouterOutlet],
  template: `
    <div>
      @for (post of posts.value(); track post.id) {
        <a [routerLink]="['/posts/details/view', post.id, 'info']">{{
          post.title
        }}</a>
        <br />
      }
    </div>
    <div>
      <a routerLink="/home">Home</a>
      yaaay
      <router-outlet />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: row;
      align-items: flex-start;
    }
  `,
})
export class PostsComponent {
  readonly posts = httpResource<Post[]>(() => ({
    url: 'https://jsonplaceholder.typicode.com/posts',
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    responseType: 'json',
  }));
}
