import { Routes } from '@angular/router';
import { createBreadcrumb } from '@mmstack/router-core';
import { PostsComponent } from './posts.component';

export const POST_ROUTES: Routes = [
  {
    path: 'details',
    component: PostsComponent,
    data: {
      skipBreadcrumb: true,
    },
    children: [
      {
        path: 'view/:id',
        loadChildren: () =>
          import('./post-details.routes').then((m) => m.ROUTES),
        resolve: {
          bc: createBreadcrumb(() => ({
            label: 'test',
          })),
        },
      },
    ],
  },
];
