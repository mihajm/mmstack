import { AngularAppEngine, createRequestHandler } from '@angular/ssr';
import { Hono } from 'hono';

const app = new Hono();
const angularApp = new AngularAppEngine();

app.all('*', async (c) => (await angularApp.handle(c.req.raw)) ?? c.notFound());

export const reqHandler = createRequestHandler((request) => app.fetch(request));
