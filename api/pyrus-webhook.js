/**
 * Webhook от Pyrus → автоматически оптимизировать фото при загрузке
 *
 * Pyrus шлёт:
 * POST { event: "task.created" | "comment" | "comment.added", task_id, user_id, task: {...} }
 *
 * Логика: если у задачи заполнено поле "Фото осмотра" (u_photo2_source) и пусто "НЭ" (u_ne_source)
 * → запускаем оптимизацию.
 */

import { pyrusRequest } from './_pyrus.js';

const FIELDS = {
  PHOTOS: process.env.FIELD_PHOTOS_CODE || 'u_photo2_source',  // code поля с фото
  ARCHIVE: process.env.FIELD_ARCHIVE_CODE || 'u_ne_source',    // code поля для архива
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'pyrus-webhook' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;
  const event = data.event;

  console.log(`[WEBHOOK] event=${event} task=${taskId}`);

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  try {
    // Получаем задачу
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      console.warn(`[WEBHOOK] no access to task ${taskId}:`, taskRes.error);
      return res.status(200).json({ skipped: 'no access' });
    }

    const task = taskRes.task;
    const fieldMap = {};
    (task.fields || []).forEach(f => { fieldMap[f.code || f.id] = f.value; });

    const photos = fieldMap[FIELDS.PHOTOS];
    const archive = fieldMap[FIELDS.ARCHIVE];

    // Проверяем условия для запуска
    if (!photos || !Array.isArray(photos) || photos.length === 0) {
      console.log(`[WEBHOOK] task=${taskId} no photos, skip`);
      return res.status(200).json({ skipped: 'no photos' });
    }

    if (archive && Array.isArray(archive) && archive.length > 0) {
      console.log(`[WEBHOOK] task=${taskId} already has archive, skip`);
      return res.status(200).json({ skipped: 'already archived' });
    }

    console.log(`[WEBHOOK] task=${taskId} starting optimization (${photos.length} photos)`);

    // Запускаем оптимизацию асинхронно (Pyrus ждёт ответ 60 сек, оптимизация может быть дольше)
    // Поэтому сразу отвечаем 200, а в фоне запускаем
    optimizeAsync(taskId).catch(err => {
      console.error(`[WEBHOOK] optimize FAILED for task ${taskId}:`, err);
    });

    return res.status(200).json({ accepted: true, task_id: taskId });
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}

async function optimizeAsync(taskId) {
  // Импортируем логику динамически чтобы не блокировать webhook
  const { default: optimizeHandler } = await import('./optimize-photos.js');

  // Создаём mock req/res
  const mockReq = {
    method: 'POST',
    body: { task_id: taskId },
    query: {},
  };

  const mockRes = {
    status: (code) => ({
      json: (data) => {
        console.log(`[WEBHOOK] optimize result for task ${taskId}:`, code, JSON.stringify(data).substring(0, 300));
        return mockRes;
      },
    }),
    json: (data) => {
      console.log(`[WEBHOOK] optimize result for task ${taskId}:`, JSON.stringify(data).substring(0, 300));
      return mockRes;
    },
  };

  await optimizeHandler(mockReq, mockRes);
}
