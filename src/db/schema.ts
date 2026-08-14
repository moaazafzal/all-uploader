import {
  pgTable, text, timestamp, integer, bigint, jsonb, boolean,
  uniqueIndex, index, primaryKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Default lives in the database, not just in JS: lib/queue.ts inserts jobs with
// raw SQL, which bypasses any Drizzle-side $defaultFn.
const id = () => text('id').primaryKey().default(sql`gen_random_uuid()::text`)
const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/* ---------------------------------------------------------------- identity */

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: now(),
}, (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)])

export const sessions = pgTable('sessions', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: now(),
}, (t) => [index('sessions_user_idx').on(t.userId)])

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: now(),
})

/** owner > admin > member. member can draft; admin can connect accounts and publish. */
export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  createdAt: now(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })])

/* ------------------------------------------------------- connected accounts */

/**
 * One row per connected destination. Note "destination", not "platform login":
 * one Meta OAuth grant can yield several rows (each FB Page, each IG Business
 * account it manages), which is why externalId is scoped per-platform and the
 * page/IG identifiers live in `meta`.
 */
export const socialAccounts = pgTable('social_accounts', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  handle: text('handle'),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),

  accessToken: text('access_token_enc'),
  refreshToken: text('refresh_token_enc'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes').array(),

  /** Platform-specific connection data: pageId, igUserId, instanceUrl, openId, channelId, ... */
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),

  status: text('status', { enum: ['active', 'needs_reauth', 'disabled'] }).notNull().default('active'),
  lastError: text('last_error'),
  connectedByUserId: text('connected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: now(),
}, (t) => [
  uniqueIndex('social_accounts_ws_platform_ext_key').on(t.workspaceId, t.platform, t.externalId),
  index('social_accounts_ws_idx').on(t.workspaceId),
])

/* ------------------------------------------------------------------ media */

export const mediaAssets = pgTable('media_assets', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['image', 'video'] }).notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  storageKey: text('storage_key').notNull(),
  checksum: text('checksum'),
  uploadedByUserId: text('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: now(),
}, (t) => [index('media_ws_idx').on(t.workspaceId)])

/* ------------------------------------------------------------------ posts */

/**
 * `posts` is the composed idea. `postTargets` is one row per destination and
 * carries its own status: a post that lands on X but fails on TikTok is
 * `partial`, and only the TikTok target is retried.
 */
export const posts = pgTable('posts', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
  text: text('text').notNull().default(''),
  status: text('status', {
    enum: ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled'],
  }).notNull().default('draft'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('posts_ws_status_idx').on(t.workspaceId, t.status),
  index('posts_scheduled_idx').on(t.scheduledAt),
])

export const postMedia = pgTable('post_media', {
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  mediaId: text('media_id').notNull().references(() => mediaAssets.id, { onDelete: 'restrict' }),
  position: integer('position').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.postId, t.mediaId] })])

export const postTargets = pgTable('post_targets', {
  id: id(),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  socialAccountId: text('social_account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),

  /** Null means "use the post's shared text". Set to tailor copy per platform. */
  overrideText: text('override_text'),
  /** Per-platform publish options: subreddit, board id, privacy level, title, ... */
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),

  status: text('status', {
    enum: ['pending', 'publishing', 'published', 'failed', 'skipped'],
  }).notNull().default('pending'),
  remoteId: text('remote_id'),
  remoteUrl: text('remote_url'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('post_targets_post_account_key').on(t.postId, t.socialAccountId),
  index('post_targets_status_idx').on(t.status),
])

/* ------------------------------------------------------------------- jobs */

/**
 * Postgres-backed queue. Workers claim rows with FOR UPDATE SKIP LOCKED, so
 * several workers can run without Redis and without double-publishing.
 */
export const jobs = pgTable('jobs', {
  id: id(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  /** Dedup key -- a unique index makes "enqueue this target once" safe under races. */
  dedupeKey: text('dedupe_key'),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull().default('queued'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  createdAt: now(),
}, (t) => [
  index('jobs_claim_idx').on(t.status, t.runAt),
  uniqueIndex('jobs_dedupe_key').on(t.dedupeKey).where(sql`${t.dedupeKey} is not null and ${t.status} in ('queued','running')`),
])

/* ------------------------------------------------------------- audit trail */

export const auditLog = pgTable('audit_log', {
  id: id(),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  subject: text('subject'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: now(),
}, (t) => [index('audit_ws_idx').on(t.workspaceId, t.createdAt)])

export const oauthStates = pgTable('oauth_states', {
  state: text('state').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  codeVerifier: text('code_verifier'),
  redirectTo: text('redirect_to'),
  extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export type User = typeof users.$inferSelect
export type Workspace = typeof workspaces.$inferSelect
export type SocialAccount = typeof socialAccounts.$inferSelect
export type MediaAsset = typeof mediaAssets.$inferSelect
export type Post = typeof posts.$inferSelect
export type PostTarget = typeof postTargets.$inferSelect
export type Job = typeof jobs.$inferSelect
