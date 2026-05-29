import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { toNodeHandler } from "better-auth/node";
import { PrismaClient } from "@prisma/client";
import { Config } from "../config";
import { Action, Arrangement, Edge } from "@piano/shared";
import { obs } from "./observability";

const log = obs.child({ domain: 'auth' });

const seedDefaultActions = (prismaClient: PrismaClient, userId: string) =>
  prismaClient.$transaction(async (tx) => {
    const existingCount = await tx.action.count({ where: { userId } });
    if (existingCount > 0) return;

    await tx.action.createMany({
      data: Action.DEFAULTS.map((action) => ({ userId, ...action })),
    });
  });

// Give every new account a non-empty canvas: one example research workflow
// (Arrangement.DEFAULT_WORKFLOW) so the user sees the note→action→children
// loop immediately instead of a blank arrangement. Notes are created first to
// resolve their generated ids, then the edges wire them by key.
const seedDefaultArrangement = (prismaClient: PrismaClient, userId: string) =>
  prismaClient.$transaction(async (tx) => {
    const existingCount = await tx.arrangement.count({ where: { userId } });
    if (existingCount > 0) return;

    const wf = Arrangement.DEFAULT_WORKFLOW;
    const arrangement = await tx.arrangement.create({
      data: { title: wf.title, userId, tags: wf.tags },
    });

    const idByKey: Record<string, string> = {};
    for (const note of wf.notes) {
      const created = await tx.note.create({
        data: Arrangement.toSeedNoteData(note, arrangement.id, userId),
      });
      idByKey[note.key] = created.id;
    }

    await tx.edge.createMany({
      data: wf.edges.map((e) =>
        Edge.childEdgeData(arrangement.id, idByKey[e.from]!, idByKey[e.to]!),
      ),
    });
  });

class AuthService {
  private auth: ReturnType<typeof betterAuth>;
  
  constructor(prismaClient: PrismaClient, config: Config) {
    const providers = config.auth.google ? ['email', 'google'] : ['email'];
    log.info(
      { baseURL: config.auth.baseURL, providers },
      'Auth configured',
    );

    this.auth = betterAuth({
      baseURL: config.auth.baseURL,
      basePath: "/api/auth",

      database: prismaAdapter(prismaClient, {
        provider: "postgresql"
      }),

      emailAndPassword: {
        enabled: true,
        requireEmailVerification: false, // set to true to require email verification before login
      },

      ...(config.auth.google && {
        socialProviders: {
          google: {
            clientId: config.auth.google.clientId,
            clientSecret: config.auth.google.clientSecret,
            prompt: "select_account",
          },
        },
      }),

      // If a user already has an email-password account and later signs in
      // via Google with the same (verified) email, link the providers to
      // the same User row instead of creating a duplicate. Google emails
      // are always verified after OAuth, so trusting the provider is safe.
      account: {
        accountLinking: {
          enabled: true,
          trustedProviders: ['google'],
        },
      },

      session: {
        expiresIn: 60 * 60 * 24 * 7, // 7 days
        updateAge: 60 * 60 * 24, // Update every day
      },

      databaseHooks: {
        user: {
          create: {
            after: async (user) => {
              await seedDefaultActions(prismaClient, user.id);
              await seedDefaultArrangement(prismaClient, user.id);
            },
          },
        },
      },

      trustedOrigins: config.env === 'development'
        ? (req?: Request) => {
            const origin = req?.headers.get('origin');
            return origin ? [origin] : [];
          }
        : config.auth.trustedOrigins,

      secret: config.auth.secret,

      advanced: {
        useSecureCookies: config.env !== 'development',
      },
    });
  }

  get handler() {
    return toNodeHandler(this.auth);
  }

  get api() {
    return this.auth.api;
  }
}

export default AuthService;
export type Auth = ReturnType<typeof betterAuth>;
