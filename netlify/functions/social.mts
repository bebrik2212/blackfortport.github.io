import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  comments,
  notifications,
  posts,
  profiles,
  uploads,
  votes,
} from "../../db/schema.js";

const MAX_MEDIA_SIZE = 67 * 1024 * 1024;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE = 3 * 1024 * 1024;
const MODERATOR_KEY = Buffer.from("YnVyYnVyYnVyYnVyYnVyYnVyYnVy", "base64").toString("utf8");

type JsonObject = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function getUploadStore() {
  return getStore("social-uploads");
}

function error(message: string, status = 400) {
  return json({ error: message }, status);
}

function normalizeNickname(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

function pathParts(req: Request) {
  const pathname = new URL(req.url).pathname;
  return pathname.replace(/^\/api\/social\/?/, "").split("/").filter(Boolean);
}

async function requestBody(req: Request): Promise<JsonObject> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function getProfile(profileId: string) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId)).limit(1);
  return profile;
}

async function createNotification(recipientId: string, message: string) {
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    recipientId,
    message,
  });
}

async function feed(req: Request) {
  const viewerId = new URL(req.url).searchParams.get("viewer") || "";
  const postRows = await db
    .select({
      id: posts.id,
      body: posts.body,
      createdAt: posts.createdAt,
      authorId: profiles.id,
      author: profiles.nickname,
      avatarUploadId: profiles.avatarUploadId,
    })
    .from(posts)
    .innerJoin(profiles, eq(posts.authorId, profiles.id))
    .orderBy(desc(posts.createdAt))
    .limit(100);

  const postIds = postRows.map((post) => post.id);
  const [mediaRows, voteRows, commentRows, viewerRows, notificationRows] = await Promise.all([
    postIds.length
      ? db.select().from(uploads).where(and(inArray(uploads.attachedPostId, postIds), eq(uploads.completed, true))).orderBy(asc(uploads.position))
      : Promise.resolve([]),
    postIds.length ? db.select().from(votes).where(inArray(votes.postId, postIds)) : Promise.resolve([]),
    postIds.length
      ? db
          .select({
            id: comments.id,
            postId: comments.postId,
            body: comments.body,
            createdAt: comments.createdAt,
            authorId: profiles.id,
            author: profiles.nickname,
            avatarUploadId: profiles.avatarUploadId,
          })
          .from(comments)
          .innerJoin(profiles, eq(comments.authorId, profiles.id))
          .where(inArray(comments.postId, postIds))
          .orderBy(asc(comments.createdAt))
      : Promise.resolve([]),
    validClientId(viewerId) ? db.select().from(profiles).where(eq(profiles.id, viewerId)).limit(1) : Promise.resolve([]),
    validClientId(viewerId)
      ? db.select().from(notifications).where(eq(notifications.recipientId, viewerId)).orderBy(desc(notifications.createdAt)).limit(50)
      : Promise.resolve([]),
  ]);

  const viewer = viewerRows[0];
  const canModerate = viewer?.nickname.toLocaleLowerCase("ru-RU") === MODERATOR_KEY;

  return json({
    profile: viewer
      ? {
          id: viewer.id,
          nickname: viewer.nickname,
          avatarUploadId: viewer.avatarUploadId,
        }
      : null,
    posts: postRows.map((post) => {
      const postVotes = voteRows.filter((vote) => vote.postId === post.id);
      return {
        id: post.id,
        text: post.body,
        createdAt: post.createdAt,
        authorId: post.authorId,
        author: post.author,
        avatarUploadId: post.avatarUploadId,
        likes: postVotes.filter((vote) => vote.value === 1).length,
        dislikes: postVotes.filter((vote) => vote.value === -1).length,
        viewerVote: postVotes.find((vote) => vote.profileId === viewerId)?.value || 0,
        canDelete: Boolean(canModerate),
        media: mediaRows
          .filter((media) => media.attachedPostId === post.id)
          .map((media) => ({
            id: media.id,
            type: media.kind,
            mimeType: media.mimeType,
            fileName: media.fileName,
            byteSize: media.byteSize,
            chunkCount: media.chunkCount,
          })),
        comments: commentRows
          .filter((comment) => comment.postId === post.id)
          .map((comment) => ({
            id: comment.id,
            text: comment.body,
            createdAt: comment.createdAt,
            authorId: comment.authorId,
            author: comment.author,
            avatarUploadId: comment.avatarUploadId,
          })),
      };
    }),
    notifications: notificationRows.map((notification) => ({
      id: notification.id,
      message: notification.message,
      read: notification.read,
      createdAt: notification.createdAt,
    })),
  });
}

async function updateProfile(req: Request) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  const nickname = normalizeNickname(body.nickname);
  const avatarUploadId = typeof body.avatarUploadId === "string" ? body.avatarUploadId : undefined;

  if (!validClientId(profileId)) return error("Некорректный профиль");
  if (nickname.length < 2 || nickname.length > 30) return error("Ник должен содержать от 2 до 30 символов");

  const nicknameKey = nickname.toLocaleLowerCase("ru-RU");
  const [taken] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.nicknameKey, nicknameKey)).limit(1);
  if (taken && taken.id !== profileId) return error("Этот ник уже занят", 409);

  if (avatarUploadId) {
    const [avatar] = await db.select().from(uploads).where(eq(uploads.id, avatarUploadId)).limit(1);
    if (!avatar || avatar.ownerId !== profileId || avatar.purpose !== "avatar" || !avatar.completed) {
      return error("Аватар не загружен");
    }
  }

  const existing = await getProfile(profileId);
  try {
    await db
      .insert(profiles)
      .values({
        id: profileId,
        nickname,
        nicknameKey,
        avatarUploadId: avatarUploadId || null,
      })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          nickname,
          nicknameKey,
          avatarUploadId: avatarUploadId === undefined ? existing?.avatarUploadId || null : avatarUploadId,
          updatedAt: new Date(),
        },
      });
  } catch (cause) {
    if ((cause as { code?: string }).code === "23505") return error("Этот ник уже занят", 409);
    throw cause;
  }

  return json({ ok: true });
}

async function initUpload(req: Request) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  const purpose = body.purpose === "avatar" ? "avatar" : "media";
  const byteSize = Number(body.byteSize);
  const chunkCount = Number(body.chunkCount);
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.slice(0, 120) : "application/octet-stream";
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 180) : "file";
  const kind = mimeType.startsWith("video/") ? "video" : "image";

  if (!validClientId(profileId) || !(await getProfile(profileId))) return error("Сначала установите ник", 401);
  if (!Number.isInteger(byteSize) || byteSize < 1 || byteSize > (purpose === "avatar" ? MAX_AVATAR_SIZE : MAX_MEDIA_SIZE)) {
    return error(purpose === "avatar" ? "Аватар должен быть меньше 5 МБ" : "Файл превышает 67 МБ");
  }
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > Math.ceil(MAX_MEDIA_SIZE / MAX_CHUNK_SIZE)) {
    return error("Некорректное количество частей");
  }
  if (chunkCount !== Math.ceil(byteSize / MAX_CHUNK_SIZE)) return error("Некорректный размер загрузки");
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) return error("Поддерживаются только изображения и видео");

  const id = crypto.randomUUID();
  await db.insert(uploads).values({
    id,
    ownerId: profileId,
    purpose,
    kind,
    fileName,
    mimeType,
    byteSize,
    chunkCount,
  });
  return json({ id }, 201);
}

async function uploadChunk(req: Request, uploadId: string, chunkText: string) {
  const profileId = req.headers.get("x-profile-id") || "";
  const chunkIndex = Number(chunkText);
  if (!validClientId(profileId) || !validId(uploadId) || !Number.isInteger(chunkIndex)) return error("Некорректная загрузка");

  const [upload] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  if (!upload || upload.ownerId !== profileId || chunkIndex < 0 || chunkIndex >= upload.chunkCount) return error("Загрузка не найдена", 404);

  const data = await req.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_CHUNK_SIZE) return error("Часть файла слишком большая", 413);
  await getUploadStore().set(`${uploadId}/${chunkIndex}`, data, {
    metadata: { contentType: upload.mimeType, byteSize: String(data.byteLength) },
  });
  return json({ ok: true });
}

async function completeUpload(req: Request, uploadId: string) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  if (!validClientId(profileId) || !validId(uploadId)) return error("Некорректная загрузка");
  const [upload] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  if (!upload || upload.ownerId !== profileId) return error("Загрузка не найдена", 404);

  const uploadStore = getUploadStore();
  const chunks = await Promise.all(
    Array.from({ length: upload.chunkCount }, (_, index) => uploadStore.getMetadata(`${uploadId}/${index}`)),
  );
  if (chunks.some((chunk) => !chunk)) return error("Не все части файла загружены", 409);
  const uploadedBytes = chunks.reduce((total, chunk) => total + Number(chunk?.metadata.byteSize || 0), 0);
  if (uploadedBytes !== upload.byteSize) return error("Размер файла не совпадает", 409);

  await db.update(uploads).set({ completed: true }).where(eq(uploads.id, uploadId));
  return json({ ok: true });
}

async function downloadChunk(uploadId: string, chunkText: string) {
  const chunkIndex = Number(chunkText);
  if (!validId(uploadId) || !Number.isInteger(chunkIndex)) return error("Файл не найден", 404);
  const [upload] = await db.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.completed, true))).limit(1);
  if (!upload || chunkIndex < 0 || chunkIndex >= upload.chunkCount) return error("Файл не найден", 404);
  const chunk = await getUploadStore().get(`${uploadId}/${chunkIndex}`, { type: "arrayBuffer" });
  if (!chunk) return error("Файл не найден", 404);
  return new Response(chunk, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

async function uploadMetadata(uploadId: string) {
  if (!validId(uploadId)) return error("Файл не найден", 404);
  const [upload] = await db.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.completed, true))).limit(1);
  if (!upload) return error("Файл не найден", 404);
  return json({
    id: upload.id,
    type: upload.kind,
    mimeType: upload.mimeType,
    chunkCount: upload.chunkCount,
    byteSize: upload.byteSize,
  });
}

async function createPost(req: Request) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 5000) : "";
  const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.filter(validId).slice(0, 10) : [];
  const profile = validClientId(profileId) ? await getProfile(profileId) : null;
  if (!profile) return error("Сначала установите ник", 401);
  if (!text && !mediaIds.length) return error("Напишите текст или прикрепите медиа");

  const mediaRows = mediaIds.length ? await db.select().from(uploads).where(inArray(uploads.id, mediaIds)) : [];
  if (mediaRows.length !== mediaIds.length || mediaRows.some((media) => media.ownerId !== profileId || media.purpose !== "media" || !media.completed || media.attachedPostId)) {
    return error("Один из файлов не готов");
  }

  const postId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(posts).values({ id: postId, authorId: profileId, body: text });
    for (const [position, mediaId] of mediaIds.entries()) {
      await tx.update(uploads).set({ attachedPostId: postId, position }).where(eq(uploads.id, mediaId));
    }
  });
  await createNotification(profileId, "Вы создали новый пост");
  return json({ id: postId }, 201);
}

async function voteOnPost(req: Request, postId: string) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  const requestedValue = body.value === -1 ? -1 : 1;
  const profile = validClientId(profileId) ? await getProfile(profileId) : null;
  if (!profile || !validId(postId)) return error("Некорректный запрос", 401);
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return error("Пост не найден", 404);

  const [existing] = await db.select().from(votes).where(and(eq(votes.postId, postId), eq(votes.profileId, profileId))).limit(1);
  let finalValue = requestedValue;
  if (existing?.value === requestedValue) {
    await db.delete(votes).where(and(eq(votes.postId, postId), eq(votes.profileId, profileId)));
    finalValue = 0;
  } else {
    await db
      .insert(votes)
      .values({ postId, profileId, value: requestedValue })
      .onConflictDoUpdate({ target: [votes.postId, votes.profileId], set: { value: requestedValue, createdAt: new Date() } });
  }

  if (finalValue && post.authorId !== profileId) {
    await createNotification(post.authorId, `${profile.nickname} ${finalValue === 1 ? "лайкнул(а)" : "дизлайкнул(а)"} ваш пост`);
  }
  return json({ value: finalValue });
}

async function addComment(req: Request, postId: string) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
  const profile = validClientId(profileId) ? await getProfile(profileId) : null;
  if (!profile || !validId(postId)) return error("Некорректный запрос", 401);
  if (!text) return error("Введите комментарий");
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return error("Пост не найден", 404);

  await db.insert(comments).values({ id: crypto.randomUUID(), postId, authorId: profileId, body: text });
  if (post.authorId !== profileId) {
    const excerpt = text.length > 50 ? `${text.slice(0, 50)}...` : text;
    await createNotification(post.authorId, `${profile.nickname} прокомментировал(а) ваш пост: “${excerpt}”`);
  }
  return json({ ok: true }, 201);
}

async function deletePost(req: Request, context: Context, postId: string) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  const profile = validClientId(profileId) ? await getProfile(profileId) : null;
  if (!profile || profile.nickname.toLocaleLowerCase("ru-RU") !== MODERATOR_KEY) return error("Недостаточно прав", 403);
  if (!validId(postId)) return error("Пост не найден", 404);

  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return error("Пост не найден", 404);
  const mediaRows = await db.select().from(uploads).where(eq(uploads.attachedPostId, postId));

  await db.delete(posts).where(eq(posts.id, postId));
  await createNotification(post.authorId, "Ваш пост был удалён");
  const uploadStore = getUploadStore();
  context.waitUntil(
    Promise.all(mediaRows.flatMap((media) => Array.from({ length: media.chunkCount }, (_, index) => uploadStore.delete(`${media.id}/${index}`)))).then(() => undefined),
  );
  return json({ ok: true });
}

async function markNotificationsRead(req: Request) {
  const body = await requestBody(req);
  const profileId = body.profileId;
  if (!validClientId(profileId)) return error("Некорректный профиль");
  await db.update(notifications).set({ read: true }).where(eq(notifications.recipientId, profileId));
  return json({ ok: true });
}

export default async function handler(req: Request, context: Context) {
  const parts = pathParts(req);
  try {
    if (req.method === "GET" && parts.length === 0) return feed(req);
    if (req.method === "PUT" && parts[0] === "profile") return updateProfile(req);
    if (req.method === "POST" && parts[0] === "uploads" && parts[1] === "init") return initUpload(req);
    if (req.method === "PUT" && parts[0] === "uploads" && parts[1] && parts[2] === "chunks" && parts[3]) return uploadChunk(req, parts[1], parts[3]);
    if (req.method === "POST" && parts[0] === "uploads" && parts[1] && parts[2] === "complete") return completeUpload(req, parts[1]);
    if (req.method === "GET" && parts[0] === "uploads" && parts[1] && parts[2] === "meta") return uploadMetadata(parts[1]);
    if (req.method === "GET" && parts[0] === "uploads" && parts[1] && parts[2] === "chunks" && parts[3]) return downloadChunk(parts[1], parts[3]);
    if (req.method === "POST" && parts[0] === "posts" && parts.length === 1) return createPost(req);
    if (req.method === "POST" && parts[0] === "posts" && parts[1] && parts[2] === "vote") return voteOnPost(req, parts[1]);
    if (req.method === "POST" && parts[0] === "posts" && parts[1] && parts[2] === "comments") return addComment(req, parts[1]);
    if (req.method === "DELETE" && parts[0] === "posts" && parts[1]) return deletePost(req, context, parts[1]);
    if (req.method === "POST" && parts[0] === "notifications" && parts[1] === "read") return markNotificationsRead(req);
    return error("Маршрут не найден", 404);
  } catch (cause) {
    console.error("social api error", cause);
    return error("Временная ошибка сервера", 500);
  }
}

export const config: Config = {
  path: ["/api/social", "/api/social/*"],
};
