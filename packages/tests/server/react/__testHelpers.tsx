import { routerToServerAndClientNew } from '../___testHelpers';
import { createQueryClient, createQueryClientConfig } from '../__queryClient';
import { QueryClientProvider } from '@tanstack/react-query';
import type { TRPCWebSocketClient } from '@trpc/client';
import { createWSClient, httpBatchLink, splitLink, wsLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { OutputWithCursor } from '@trpc/react-query/shared';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/src/observable';
import { subscriptionPullFactory } from '@trpc/server/src/subscription';
import hash from 'hash-sum';
import type { ReactNode } from 'react';
import React from 'react';
import { z, ZodError } from 'zod';

export type Post = {
  id: string;
  title: string;
  createdAt: number;
};

export function createAppRouter() {
  const db: {
    posts: Post[];
  } = {
    posts: [
      { id: '1', title: 'first post', createdAt: 0 },
      { id: '2', title: 'second post', createdAt: 1 },
    ],
  };
  const postLiveInputs: unknown[] = [];
  const createContext = vi.fn(() => ({}));
  const allPosts = vi.fn();
  const postById = vi.fn();
  let wsClient: TRPCWebSocketClient = null as any;

  const t = initTRPC.create({
    errorFormatter({ shape, error }) {
      return {
        $test: 'formatted',
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
        ...shape,
      };
    },
  });

  let count = 0;
  const appRouter = t.router({
    count: t.procedure.input(z.string()).query(({ input }) => {
      return `${input}:${count++}`;
    }),
    allPosts: t.procedure.query(({}) => {
      allPosts();
      return db.posts;
    }),
    postById: t.procedure.input(z.string()).query(({ input }) => {
      postById(input);
      const post = db.posts.find((p) => p.id === input);
      if (!post) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      return post;
    }),
    paginatedPosts: t.procedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(100).default(50),
            cursor: z.number().nullish().default(null),
          })
          .default({}),
      )
      .query(({ input }) => {
        const items: typeof db.posts = [];
        const limit = input.limit;
        const { cursor } = input;
        let nextCursor: typeof cursor = null;
        for (const element of db.posts) {
          if (cursor != null && element.createdAt < cursor) {
            continue;
          }
          items.push(element);
          if (items.length >= limit) {
            break;
          }
        }
        const last = items[items.length - 1];
        const nextIndex = db.posts.findIndex((item) => item === last) + 1;
        if (db.posts[nextIndex]) {
          nextCursor = db.posts[nextIndex]!.createdAt;
        }
        return {
          items,
          nextCursor,
        };
      }),

    addPost: t.procedure
      .input(
        z.object({
          title: z.string(),
        }),
      )
      .mutation(({ input }) => {
        db.posts.push({
          id: `${Math.random()}`,
          createdAt: Date.now(),
          title: input.title,
        });
      }),

    deletePosts: t.procedure
      .input(z.array(z.string()).nullish())
      .mutation(({ input }) => {
        if (input) {
          db.posts = db.posts.filter((p) => !input.includes(p.id));
        } else {
          db.posts = [];
        }
      }),

    PING: t.procedure.mutation(({}) => {
      return 'PONG' as const;
    }),

    newPosts: t.procedure.input(z.number()).subscription(({ input }) => {
      return subscriptionPullFactory<Post>({
        intervalMs: 1,
        pull(emit) {
          db.posts.filter((p) => p.createdAt > input).forEach(emit.next);
        },
      });
    }),

    postsLive: t.procedure
      .input(
        z.object({
          cursor: z.string().nullable(),
        }),
      )
      .subscription(({ input }) => {
        const { cursor } = input;
        postLiveInputs.push(input);

        return subscriptionPullFactory<OutputWithCursor<Post[]>>({
          intervalMs: 10,
          pull(emit) {
            const newCursor = hash(db.posts);
            if (newCursor !== cursor) {
              emit.next({ data: db.posts, cursor: newCursor });
            }
          },
        });
      }),
    getMockPostByContent: t.procedure
      .input(
        z.object({
          id: z.string(),
          title: z.string(),
          content: z.object({
            type: z.string(),
            language: z.string(),
          }),
        }),
      )
      .query(({ input }) => {
        return {
          id: input.id,
          title: input.title,
          content: input.content.type,
          createdAt: 0,
        };
      }),
  });

  const linkSpy = {
    up: vi.fn(),
    down: vi.fn(),
  };
  const { client, trpcClientOptions, close } = routerToServerAndClientNew(
    appRouter,
    {
      server: {
        createContext,
        batching: {
          enabled: true,
        },
      },
      client({ httpUrl, wssUrl }) {
        wsClient = createWSClient({
          url: wssUrl,
        });
        return {
          links: [
            () =>
              ({ op, next }) => {
                return observable((observer) => {
                  linkSpy.up(op);
                  const subscription = next(op).subscribe({
                    next(result) {
                      linkSpy.down(result);
                      observer.next(result);
                    },
                    error(result) {
                      linkSpy.down(result);
                      observer.error(result);
                    },
                    complete() {
                      linkSpy.down('COMPLETE');
                      observer.complete();
                    },
                  });
                  return subscription;
                });
              },
            splitLink({
              condition(op) {
                return op.type === 'subscription';
              },
              true: wsLink({
                client: wsClient,
              }),
              false: httpBatchLink({
                url: httpUrl,
              }),
            }),
          ],
        };
      },
    },
  );

  trpcClientOptions.queryClientConfig = createQueryClientConfig(
    trpcClientOptions.queryClientConfig,
  );
  const queryClient = createQueryClient(trpcClientOptions.queryClientConfig);
  const trpc = createTRPCReact<typeof appRouter>();

  function App(props: { children: ReactNode }) {
    return (
      <trpc.Provider {...{ queryClient, client }}>
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      </trpc.Provider>
    );
  }
  return {
    App,
    appRouter,
    trpc,
    close,
    db,
    client,
    trpcClientOptions,
    postLiveInputs,
    resolvers: {
      postById,
      allPosts,
    },
    queryClient,
    createContext,
    linkSpy,
  };
}
