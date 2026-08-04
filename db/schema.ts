import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const profiles = pgTable(
  "profiles",
  {
    id: text().primaryKey(),
    nickname: text().notNull(),
    nicknameKey: text("nickname_key").notNull(),
    avatarUploadId: text("avatar_upload_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("profiles_nickname_key_unique").on(table.nicknameKey)],
);

export const posts = pgTable(
  "posts",
  {
    id: text().primaryKey(),
    authorId: text("author_id").notNull().references(() => profiles.id),
    body: text().notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("posts_created_at_idx").on(table.createdAt)],
);

export const comments = pgTable(
  "comments",
  {
    id: text().primaryKey(),
    postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull().references(() => profiles.id),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("comments_post_id_idx").on(table.postId)],
);

export const votes = pgTable(
  "votes",
  {
    postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    profileId: text("profile_id").notNull().references(() => profiles.id),
    value: integer().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.profileId] })],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text().primaryKey(),
    recipientId: text("recipient_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    message: text().notNull(),
    read: boolean().notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("notifications_recipient_idx").on(table.recipientId, table.createdAt)],
);

export const uploads = pgTable(
  "uploads",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    purpose: text().notNull(),
    kind: text().notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    attachedPostId: text("attached_post_id").references(() => posts.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
    completed: boolean().notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("uploads_post_id_idx").on(table.attachedPostId),
    index("uploads_owner_id_idx").on(table.ownerId),
  ],
);

