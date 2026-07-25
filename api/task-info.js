/**
 * Возвращает инфо о задаче для страницы подтверждения
 * GET /api/task-info?task_id=...
 */

import { pyrusRequest } from './_pyrus.js';

const DEFAULT_FIELDS_CONFIG = {
  2316414: { photos: 'u_photo2_source' },
  2451012: { photos: 'u_photo2_source' },
};

function getPhotosFieldCode() {
  if (process.env.FIELD_PHOTOS_CODE) return process.env.FIELD_PHOTOS_CODE;
  // TODO: использовать FIELDS_CONFIG когда понадобится
  return 'u_photo2_source';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const taskId = req.query.task_id;
  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  try {
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      return res.status(403).json({ error: taskRes.error || 'No access to task' });
    }

    const task = taskRes.task;

    // Ищем поле по коду
    const photosCode = getPhotosFieldCode();
    const photosField = (task.fields || []).find(f => f.code === photosCode);
    const photos = photosField?.value || [];
    const totalSize = Array.isArray(photos)
      ? photos.reduce((sum, p) => sum + (p.size || 0), 0)
      : 0;

    return res.status(200).json({
      task_id: taskId,
      photo_count: Array.isArray(photos) ? photos.length : 0,
      total_size: totalSize,
      total_size_str: formatSize(totalSize),
      photos: Array.isArray(photos)
        ? photos.map(p => ({ name: p.name, size: p.size }))
        : [],
    });
  } catch (error) {
    console.error('[TASK-INFO ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
