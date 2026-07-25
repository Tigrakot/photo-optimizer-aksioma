/**
 * Pyrus auth + API helpers для photo-optimizer-aksioma
 */

const PYRUS_LOGIN = process.env.PYRUS_BOT_LOGIN;
const PYRUS_SECURITY_KEY = process.env.PYRUS_BOT_KEY;
const PYRUS_API_BASE = 'https://api.pyrus.com/v4';

let cachedToken = null;
let tokenExpires = 0;

export async function getPyrusToken() {
  if (cachedToken && Date.now() < tokenExpires) {
    return cachedToken;
  }

  const response = await fetch('https://accounts.pyrus.com/api/v4/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: PYRUS_LOGIN,
      security_key: PYRUS_SECURITY_KEY,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Pyrus auth failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

export async function pyrusRequest(path, options = {}) {
  const token = await getPyrusToken();
  const response = await fetch(`${PYRUS_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pyrus API ${response.status}: ${text.substring(0, 300)}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Parse error: ${text.substring(0, 200)}`);
  }
}

/**
 * Скачать файл Pyrus по id
 * @param {number} fileId
 * @returns {Promise<Buffer>}
 */
export async function downloadPyrusFile(fileId) {
  const token = await getPyrusToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout per file
  try {
    const response = await fetch(`${PYRUS_API_BASE}/files/download/${fileId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Параллельное скачивание N файлов (concurrency=5)
 */
export async function downloadPyrusFilesParallel(photos, concurrency = 5, onProgress) {
  const results = new Array(photos.length);
  let completed = 0;

  async function downloadOne(photo, index) {
    try {
      const buffer = await downloadPyrusFile(photo.id);
      results[index] = { name: photo.name, original: buffer, error: null };
    } catch (err) {
      console.error(`[PYRUS] Failed to download ${photo.name} (id=${photo.id}):`, err.message);
      results[index] = { name: photo.name, original: null, error: err.message };
    }
    completed++;
    if (onProgress) onProgress(completed, photos.length);
  }

  // Worker pool
  const queue = photos.map((p, i) => ({ photo: p, index: i }));
  const workers = Array.from({ length: Math.min(concurrency, photos.length) }, async () => {
    while (queue.length > 0) {
      const { photo, index } = queue.shift();
      await downloadOne(photo, index);
    }
  });
  await Promise.all(workers);

  return results.filter(r => r && r.original); // вернуть только успешные
}

/**
 * Залить файл в Pyrus (multipart/form-data)
 * @param {string} filename
 * @param {Buffer} content
 * @returns {Promise<{id, name, size, md5}>}
 */
export async function uploadPyrusFile(filename, content) {
  const token = await getPyrusToken();

  // multipart/form-data
  const formData = new FormData();
  const blob = new Blob([content], { type: 'application/octet-stream' });
  formData.append('file', blob, filename);

  const response = await fetch(`${PYRUS_API_BASE}/files/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Upload failed: ${response.status} ${err}`);
  }

  const result = await response.json();
  return {
    id: result.guid,
    name: filename,
    size: content.length,
    md5: result.md5_hash,
  };
}
