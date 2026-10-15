import {Server} from '@overnightjs/core';
import {json, type NextFunction, type Request, type Response} from 'express';
import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories} from '../../../../../test/helpers';
import {ApiKeys} from '../../controllers/ApiKeys.js';
import {Campaigns} from '../../controllers/Campaigns.js';
import {Contacts} from '../../controllers/Contacts.js';
import {Domains} from '../../controllers/Domains.js';
import {Emails} from '../../controllers/Emails.js';
import {Layouts} from '../../controllers/Layouts.js';
import {Segments} from '../../controllers/Segments.js';
import {Templates} from '../../controllers/Templates.js';
import {Topics} from '../../controllers/Topics.js';
import {Uploads} from '../../controllers/Uploads.js';
import {HttpException} from '../../exceptions/index.js';
import {SCOPED_ROUTES} from '../../services/ApiKeyScopes.js';
import {ApiKeyService} from '../../services/ApiKeyService.js';

/** The controllers the scope table names, as the API serves them, answering errors with their status. */
function servedApp() {
  const server = new Server();
  server.app.use(json());
  server.addControllers([
    new Campaigns(),
    new Templates(),
    new Segments(),
    new Layouts(),
    new Topics(),
    new Contacts(),
    new Domains(),
    new Uploads(),
    new Emails(),
    new ApiKeys(),
  ]);
  server.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof HttpException ? error.code : 500).json({message: error.message});
  });
  return server.app;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';

/** The scope table (D37) against the routes Express really matches. */
describe('scoped API key routes', () => {
  const app = servedApp();
  let projectId: string;
  let secret: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    secret = (await ApiKeyService.create(projectId, {name: 'all', scopes: ['draft', 'sync']})).secret;
  });

  const call = (method: Method, url: string) => {
    const sent = request(app)[method](url).set('Authorization', `Bearer ${secret}`);
    return method === 'get' || method === 'head' ? sent : sent.send({});
  };

  const refusedAsUnlisted = (answer: request.Response) =>
    answer.status === 403 && String((answer.body as {message?: string}).message).includes("don't include");

  it('names only routes the controllers serve', async () => {
    const unmatched: string[] = [];
    for (const route of Object.keys(SCOPED_ROUTES)) {
      const [method, path] = route.split(' ') as [string, string];
      const url = path.replace(/:(\w+)/g, (_, name: string) =>
        name === 'slug' ? 'probe' : name === 'projectId' ? projectId : '00000000-0000-4000-8000-000000000000',
      );
      if (refusedAsUnlisted(await call(method.toLowerCase() as Method, url))) {
        unmatched.push(route);
      }
    }

    expect(Object.keys(SCOPED_ROUTES).length).toBeGreaterThan(30);
    expect(unmatched).toEqual([]);
  });

  it('refuses every other route, method and spelling', async () => {
    for (const [method, url] of [
      ['get', '/contacts'],
      ['post', '/campaigns/00000000-0000-4000-8000-000000000000/send'],
      ['get', '/api-keys'],
      ['head', '/campaigns'],
      ['get', '/CAMPAIGNS'],
    ] as const) {
      const answer = await call(method, url);
      expect(answer.status, `${method} ${url}`).toBe(403);
    }
  });
});
