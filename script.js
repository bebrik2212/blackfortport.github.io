const API_URL = '/api/social';
const DEFAULT_AVATAR = 'https://litmir.club/data/Author/279000/279758/Фото_Нуремхет_Аноним_b86a9.jpg';
const MAX_FILE_SIZE = 67 * 1024 * 1024;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const CHUNK_SIZE = 3 * 1024 * 1024;

const profileId = getProfileId();
let socialData = { profile: null, posts: [], notifications: [] };
let pendingMedia = [];
let profileSaveTimer = 0;
let syncInProgress = false;
let notificationPanelOpen = false;
let profileSavePromise = Promise.resolve(true);
const openComments = new Set();
const blobUrlCache = new Map();
const blobPromiseCache = new Map();
const uploadMetaCache = new Map();
const avatarTargets = new Map();

const nicknameInput = document.getElementById('nicknameInput');
const profileAvatarEl = document.getElementById('profileAvatar');
const profileBigAvatarEl = document.getElementById('profileBigAvatar');
const profileNicknameEl = document.getElementById('profileNickname');
const avatarUploadEl = document.getElementById('avatarUpload');
const bellBtnEl = document.getElementById('bellBtn');
const notifCountEl = document.getElementById('notifCount');
const notificationPanelEl = document.getElementById('notificationPanel');
const nickErrorMsg = document.getElementById('nickErrorMsg');
const postTextEl = document.getElementById('postText');
const mediaUploadEl = document.getElementById('mediaUpload');
const mediaPreviewEl = document.getElementById('mediaPreview');
const publishBtnEl = document.getElementById('publishBtn');
const uploadStatusEl = document.getElementById('uploadStatus');
const postsListFeedEl = document.getElementById('postsListFeed');
const postsListProfileEl = document.getElementById('postsListProfile');

function getProfileId() {
  const stored = localStorage.getItem('social_profile_id');
  if (stored) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem('social_profile_id', created);
  return created;
}

function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = value == null ? '' : String(value);
  return element.innerHTML;
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function showToast(message, isError = false) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

async function api(path = '', options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(20000),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.arrayBuffer();
  if (!response.ok) throw new Error(data?.error || 'Ошибка соединения');
  return data;
}

async function syncWithCloud({ silent = false } = {}) {
  if (syncInProgress || document.hidden) return;
  syncInProgress = true;
  try {
    const data = await api(`?viewer=${encodeURIComponent(profileId)}`);
    socialData = data;
    localStorage.setItem('social_feed_cache', JSON.stringify(data));
    updateProfileUI();
    renderAllPosts();
    updateNotifCount();
  } catch (error) {
    if (!silent) {
      const cached = localStorage.getItem('social_feed_cache');
      if (cached) {
        try {
          socialData = JSON.parse(cached);
          updateProfileUI();
          renderAllPosts();
          updateNotifCount();
        } catch {}
      }
      showToast('Нет связи. Показаны последние загруженные данные.', true);
    }
  } finally {
    syncInProgress = false;
  }
}

function updateProfileUI() {
  const nickname = document.activeElement === nicknameInput
    ? nicknameInput.value.trim()
    : socialData.profile?.nickname || localStorage.getItem('social_pending_nickname') || '';
  if (document.activeElement !== nicknameInput) nicknameInput.value = nickname;
  profileNicknameEl.textContent = nickname || 'Без имени';
  const avatarUploadId = socialData.profile?.avatarUploadId;
  if (avatarUploadId) {
    setAvatarSource(profileAvatarEl, avatarUploadId);
    setAvatarSource(profileBigAvatarEl, avatarUploadId);
  } else {
    profileAvatarEl.src = DEFAULT_AVATAR;
    profileBigAvatarEl.src = DEFAULT_AVATAR;
  }
}

function saveProfile(nickname, avatarUploadId) {
  profileSavePromise = profileSavePromise
    .catch(() => false)
    .then(() => performSaveProfile(nickname, avatarUploadId));
  return profileSavePromise;
}

async function performSaveProfile(nickname, avatarUploadId) {
  try {
    await api('/profile', {
      method: 'PUT',
      body: JSON.stringify({ profileId, nickname, ...(avatarUploadId ? { avatarUploadId } : {}) }),
    });
    nicknameInput.classList.remove('error');
    nickErrorMsg.classList.remove('visible');
    localStorage.setItem('social_pending_nickname', nickname);
    await syncWithCloud({ silent: true });
    return true;
  } catch (error) {
    nicknameInput.classList.add('error');
    nickErrorMsg.textContent = error.message.includes('занят') ? '❌ Этот ник уже занят!' : `❌ ${error.message}`;
    nickErrorMsg.classList.add('visible');
    return false;
  }
}

nicknameInput.addEventListener('input', () => {
  const nickname = nicknameInput.value.trim();
  profileNicknameEl.textContent = nickname || 'Без имени';
  window.clearTimeout(profileSaveTimer);
  if (!nickname) {
    nicknameInput.classList.remove('error');
    nickErrorMsg.classList.remove('visible');
    return;
  }
  profileSaveTimer = window.setTimeout(() => saveProfile(nickname), 450);
});

nicknameInput.addEventListener('blur', () => {
  window.clearTimeout(profileSaveTimer);
  const nickname = nicknameInput.value.trim();
  if (nickname) saveProfile(nickname);
});

profileAvatarEl.addEventListener('click', () => avatarUploadEl.click());
document.getElementById('attachBtn').addEventListener('click', () => mediaUploadEl.click());

avatarUploadEl.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!socialData.profile?.nickname) return showToast('Сначала установите ник!', true);
  if (file.size > MAX_AVATAR_SIZE) return showToast('Аватар должен быть меньше 5 МБ', true);
  if (!file.type.startsWith('image/')) return showToast('Выберите изображение', true);
  try {
    profileAvatarEl.classList.add('uploading');
    const uploadId = await uploadFile(file, 'avatar', (progress) => {
      uploadStatusEl.textContent = `Загрузка аватара: ${progress}%`;
    });
    const saved = await saveProfile(socialData.profile.nickname, uploadId);
    if (saved) showToast('Аватар обновлён');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    profileAvatarEl.classList.remove('uploading');
    uploadStatusEl.textContent = '';
  }
});

mediaUploadEl.addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  let totalSize = pendingMedia.reduce((sum, item) => sum + item.file.size, 0);
  for (const file of files) {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      showToast(`Файл «${file.name}» не поддерживается`, true);
      continue;
    }
    if (file.size > MAX_FILE_SIZE || totalSize + file.size > MAX_FILE_SIZE) {
      showToast('Общий размер файлов превышает 67 МБ!', true);
      break;
    }
    totalSize += file.size;
    pendingMedia.push({ file, previewUrl: URL.createObjectURL(file) });
  }
  renderMediaPreview();
  updateUploadStatus();
});

function renderMediaPreview() {
  mediaPreviewEl.innerHTML = pendingMedia.map((item, index) => `
    <div class="preview-item">
      ${item.file.type.startsWith('video/')
        ? `<video src="${item.previewUrl}" muted></video>`
        : `<img src="${item.previewUrl}" alt="${escapeHtml(item.file.name)}">`}
      <div class="preview-size">${escapeHtml(item.file.name)} · ${(item.file.size / 1048576).toFixed(1)} МБ</div>
      <button class="remove-media" type="button" data-remove-media="${index}" aria-label="Удалить файл">✕</button>
    </div>`).join('');
}

function updateUploadStatus(customText = '') {
  if (customText) {
    uploadStatusEl.textContent = customText;
    return;
  }
  const totalSize = pendingMedia.reduce((sum, item) => sum + item.file.size, 0);
  uploadStatusEl.textContent = pendingMedia.length
    ? `Прикреплено: ${(totalSize / 1048576).toFixed(1)} МБ / 67 МБ (${pendingMedia.length} файлов)`
    : '';
}

mediaPreviewEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-media]');
  if (!button) return;
  const index = Number(button.dataset.removeMedia);
  const [removed] = pendingMedia.splice(index, 1);
  if (removed) URL.revokeObjectURL(removed.previewUrl);
  renderMediaPreview();
  updateUploadStatus();
});

async function uploadFile(file, purpose, onProgress) {
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
  const { id } = await api('/uploads/init', {
    method: 'POST',
    body: JSON.stringify({
      profileId,
      purpose,
      fileName: file.name,
      mimeType: file.type,
      byteSize: file.size,
      chunkCount,
    }),
  });

  let completed = 0;
  const indexes = Array.from({ length: chunkCount }, (_, index) => index);
  await runPool(indexes, 3, async (index) => {
    const chunk = file.slice(index * CHUNK_SIZE, Math.min(file.size, (index + 1) * CHUNK_SIZE));
    await api(`/uploads/${id}/chunks/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'x-profile-id': profileId },
      body: chunk,
    });
    completed += 1;
    onProgress?.(Math.round((completed / chunkCount) * 100));
  });

  await api(`/uploads/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  });
  return id;
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

async function loadUploadBlob(upload) {
  if (blobUrlCache.has(upload.id)) return blobUrlCache.get(upload.id);
  if (blobPromiseCache.has(upload.id)) return blobPromiseCache.get(upload.id);
  const promise = (async () => {
    const chunks = new Array(upload.chunkCount);
    await runPool(Array.from({ length: upload.chunkCount }, (_, index) => index), 4, async (index) => {
      chunks[index] = await api(`/uploads/${upload.id}/chunks/${index}`);
    });
    const url = URL.createObjectURL(new Blob(chunks, { type: upload.mimeType }));
    blobUrlCache.set(upload.id, url);
    return url;
  })();
  blobPromiseCache.set(upload.id, promise);
  try {
    return await promise;
  } finally {
    blobPromiseCache.delete(upload.id);
  }
}

async function setAvatarSource(element, uploadId) {
  const key = `${uploadId}:${element.id || element.className}`;
  if (avatarTargets.get(element) === key) return;
  avatarTargets.set(element, key);
  try {
    let metadata = uploadMetaCache.get(uploadId);
    if (!metadata) {
      metadata = await api(`/uploads/${uploadId}/meta`);
      uploadMetaCache.set(uploadId, metadata);
    }
    const url = await loadUploadBlob(metadata);
    if (avatarTargets.get(element) === key) element.src = url;
  } catch {
    element.src = DEFAULT_AVATAR;
  }
}

function renderPostCard(post) {
  const deleteButton = post.canDelete ? `
    <button class="delete-post-btn" type="button" data-delete-post="${post.id}" aria-label="Удалить пост">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
    </button>` : '';
  return `
    <article class="post-card" data-postid="${post.id}">
      <div class="post-header">
        <img class="post-avatar" data-avatar-upload="${post.avatarUploadId || ''}" src="${DEFAULT_AVATAR}" alt="avatar">
        <span class="post-nick">${escapeHtml(post.author) || 'Аноним'}</span>
        <time class="post-time">${formatDate(post.createdAt)}</time>
        ${deleteButton}
      </div>
      ${post.text ? `<div class="post-text">${escapeHtml(post.text)}</div>` : ''}
      ${post.media.length ? `<div class="post-media">${post.media.map((media) => `
        <div class="media-loading" data-media-id="${media.id}" data-media-type="${media.type}" data-media-mime="${escapeHtml(media.mimeType)}" data-media-chunks="${media.chunkCount}">Загрузка медиа...</div>`).join('')}</div>` : ''}
      <div class="post-footer">
        <button class="vote-btn ${post.viewerVote === 1 ? 'liked' : ''}" type="button" data-postid="${post.id}" data-vote="1" aria-label="Нравится">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 1.96-2.45l-1.38-7A2 2 0 0 0 17.05 11H14z"/><rect x="4" y="11" width="3" height="11" rx="1"/></svg>${post.likes}
        </button>
        <button class="vote-btn ${post.viewerVote === -1 ? 'disliked' : ''}" type="button" data-postid="${post.id}" data-vote="-1" aria-label="Не нравится">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="transform:rotate(180deg)"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 1.96-2.45l-1.38-7A2 2 0 0 0 17.05 11H14z"/><rect x="4" y="11" width="3" height="11" rx="1"/></svg>${post.dislikes}
        </button>
        <button class="comment-btn" type="button" data-toggle-comments="${post.id}" aria-label="Комментарии">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${post.comments.length}
        </button>
      </div>
      <div class="comments-section" id="comments-${post.id}" style="display:${openComments.has(post.id) ? 'block' : 'none'}">
        ${post.comments.map((comment) => `
          <div class="comment">
            <img class="comment-avatar" data-avatar-upload="${comment.avatarUploadId || ''}" src="${DEFAULT_AVATAR}" alt="avatar">
            <div class="comment-content">
              <span class="comment-nick">${escapeHtml(comment.author) || 'Аноним'}</span>
              <div class="comment-text">${escapeHtml(comment.text)}</div>
            </div>
          </div>`).join('')}
        <div class="comment-input-row">
          <input class="comment-input" id="comment-input-${post.id}" maxlength="1000" placeholder="Комментарий...">
          <button class="btn add-comment-btn" type="button" data-add-comment="${post.id}">▶</button>
        </div>
      </div>
    </article>`;
}

function renderAllPosts() {
  const allPosts = socialData.posts || [];
  postsListFeedEl.innerHTML = allPosts.length
    ? allPosts.map(renderPostCard).join('')
    : '<div class="empty-posts">Пока нет постов. Создайте первый!</div>';
  const myPosts = allPosts.filter((post) => post.authorId === profileId);
  postsListProfileEl.innerHTML = myPosts.length
    ? myPosts.map(renderPostCard).join('')
    : '<div class="empty-posts">У вас пока нет постов</div>';
  hydrateVisibleAssets();
}

function hydrateVisibleAssets() {
  document.querySelectorAll('[data-avatar-upload]').forEach((element) => {
    if (element.dataset.avatarUpload) setAvatarSource(element, element.dataset.avatarUpload);
  });
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      hydrateMedia(entry.target);
    }
  }, { rootMargin: '240px' });
  document.querySelectorAll('.media-loading').forEach((element) => observer.observe(element));
}

async function hydrateMedia(element) {
  try {
    const upload = {
      id: element.dataset.mediaId,
      type: element.dataset.mediaType,
      mimeType: element.dataset.mediaMime,
      chunkCount: Number(element.dataset.mediaChunks),
    };
    const url = await loadUploadBlob(upload);
    const media = document.createElement(upload.type === 'video' ? 'video' : 'img');
    media.src = url;
    if (upload.type === 'video') {
      media.controls = true;
      media.preload = 'metadata';
    } else {
      media.alt = 'media';
      media.loading = 'lazy';
    }
    element.replaceWith(media);
  } catch {
    element.textContent = 'Не удалось загрузить медиа';
  }
}

document.addEventListener('click', async (event) => {
  const voteButton = event.target.closest('[data-vote]');
  if (voteButton) {
    if (!socialData.profile?.nickname) return showToast('Сначала установите ник!', true);
    voteButton.disabled = true;
    try {
      await api(`/posts/${voteButton.dataset.postid}/vote`, {
        method: 'POST',
        body: JSON.stringify({ profileId, value: Number(voteButton.dataset.vote) }),
      });
      await syncWithCloud({ silent: true });
    } catch (error) { showToast(error.message, true); }
    return;
  }

  const toggleButton = event.target.closest('[data-toggle-comments]');
  if (toggleButton) {
    const postId = toggleButton.dataset.toggleComments;
    const section = document.getElementById(`comments-${postId}`);
    if (!section) return;
    const opening = section.style.display !== 'block';
    section.style.display = opening ? 'block' : 'none';
    opening ? openComments.add(postId) : openComments.delete(postId);
    return;
  }

  const commentButton = event.target.closest('[data-add-comment]');
  if (commentButton) {
    if (!socialData.profile?.nickname) return showToast('Сначала установите ник!', true);
    const postId = commentButton.dataset.addComment;
    const input = document.getElementById(`comment-input-${postId}`);
    const text = input?.value.trim();
    if (!text) return;
    commentButton.disabled = true;
    try {
      await api(`/posts/${postId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ profileId, text }),
      });
      openComments.add(postId);
      await syncWithCloud({ silent: true });
    } catch (error) { showToast(error.message, true); }
    return;
  }

  const deleteButton = event.target.closest('[data-delete-post]');
  if (deleteButton) {
    if (!confirm('Удалить этот пост?')) return;
    deleteButton.disabled = true;
    try {
      await api(`/posts/${deleteButton.dataset.deletePost}`, {
        method: 'DELETE',
        body: JSON.stringify({ profileId }),
      });
      await syncWithCloud({ silent: true });
    } catch (error) { showToast(error.message, true); }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || !event.target.classList.contains('comment-input')) return;
  event.preventDefault();
  event.target.closest('.comment-input-row')?.querySelector('[data-add-comment]')?.click();
});

publishBtnEl.addEventListener('click', async () => {
  if (!socialData.profile?.nickname) return showToast('Сначала установите ник!', true);
  const text = postTextEl.value.trim();
  if (!text && pendingMedia.length === 0) return showToast('Напишите текст или прикрепите медиа', true);
  publishBtnEl.disabled = true;
  publishBtnEl.textContent = 'Публикация...';
  try {
    const mediaIds = new Array(pendingMedia.length);
    await runPool(Array.from({ length: pendingMedia.length }, (_, index) => index), 2, async (index) => {
      const item = pendingMedia[index];
      const uploadId = await uploadFile(item.file, 'media', (progress) => {
        updateUploadStatus(`Загрузка файла ${index + 1} из ${pendingMedia.length}: ${progress}%`);
      });
      mediaIds[index] = uploadId;
    });
    await api('/posts', {
      method: 'POST',
      body: JSON.stringify({ profileId, text, mediaIds }),
    });
    postTextEl.value = '';
    pendingMedia.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    pendingMedia = [];
    renderMediaPreview();
    updateUploadStatus();
    setActiveTab('tabFeed', 'feedSection');
    await syncWithCloud({ silent: true });
  } catch (error) {
    showToast(error.message, true);
    updateUploadStatus();
  } finally {
    publishBtnEl.disabled = false;
    publishBtnEl.textContent = 'Опубликовать';
  }
});

function updateNotifCount() {
  const unread = (socialData.notifications || []).filter((notification) => !notification.read).length;
  notifCountEl.textContent = String(unread);
  notifCountEl.classList.toggle('visible', unread > 0);
  if (notificationPanelOpen) renderNotifications();
}

function renderNotifications() {
  const items = socialData.notifications || [];
  notificationPanelEl.innerHTML = items.length
    ? items.map((item) => `<div class="notif-item">${escapeHtml(item.message)}<span class="notif-time">${formatDate(item.createdAt)}</span></div>`).join('')
    : '<div class="notif-item">Нет уведомлений</div>';
}

bellBtnEl.addEventListener('click', async () => {
  if (!socialData.profile?.nickname) return showToast('Сначала установите ник!', true);
  notificationPanelOpen = !notificationPanelOpen;
  notificationPanelEl.style.display = notificationPanelOpen ? 'block' : 'none';
  if (!notificationPanelOpen) return;
  renderNotifications();
  try {
    await api('/notifications/read', { method: 'POST', body: JSON.stringify({ profileId }) });
    socialData.notifications.forEach((item) => { item.read = true; });
    updateNotifCount();
  } catch {}
});

document.addEventListener('click', (event) => {
  if (!notificationPanelOpen || bellBtnEl.contains(event.target) || notificationPanelEl.contains(event.target)) return;
  notificationPanelOpen = false;
  notificationPanelEl.style.display = 'none';
});

function setActiveTab(buttonId, sectionId) {
  document.querySelectorAll('.tabs button').forEach((button) => button.classList.toggle('active', button.id === buttonId));
  document.querySelectorAll('.section').forEach((section) => section.classList.toggle('active', section.id === sectionId));
}

document.getElementById('tabFeed').addEventListener('click', () => setActiveTab('tabFeed', 'feedSection'));
document.getElementById('tabCreate').addEventListener('click', () => setActiveTab('tabCreate', 'createSection'));
document.getElementById('tabProfile').addEventListener('click', () => setActiveTab('tabProfile', 'profileSection'));

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncWithCloud({ silent: true });
});

window.addEventListener('online', () => syncWithCloud());

async function initialize() {
  const pendingNickname = localStorage.getItem('social_pending_nickname');
  if (pendingNickname) nicknameInput.value = pendingNickname;
  await syncWithCloud();
  if (!socialData.profile && pendingNickname) await saveProfile(pendingNickname);
  window.setInterval(() => syncWithCloud({ silent: true }), 10000);
}

initialize();
