/**
 * Webhook от Pyrus → запускает оптимизацию
 *
 * Триггерится:
 * 1. Нажатием кнопки "Архивировать" в задаче (workflow step)
 * 2. Созданием задачи / комментарием
 *
 * Логика:
 * - Проверяем что в u_photo2_source или u_photo3_source есть фото
 * - processFieldPair сам проверит есть ли архив в u_ne_source / u_ne2_source
 *   и пропустит пары где архив уже есть
 *
 * Никаких race condition блокировок, poller'ов и т.п. —
 * сотрудник нажимает кнопку, бот отрабатывает 1 раз.
 */

import { pyrusRequest } from './_pyrus.js';

// Дедупликация: Pyrus шлёт несколько webhook'ов на одно событие
// (task.moved, task.commented, и т.д.). Если тот же task_id пришёл
// в течение DEDUP_TTL_MS — пропускаем.
const recentCalls = new Map(); // taskId → timestamp
const DEDUP_TTL_MS = 60000; // 60 сек — Pyrus шлёт webhook и на нажатие кнопки, и на смену статуса

function isDuplicate(taskId) {
  const now = Date.now();
  const last = recentCalls.get(taskId);
  if (last && (now - last) < DEDUP_TTL_MS) {
    return true;
  }
  recentCalls.set(taskId, now);
  // Чистим старые записи (чтобы Map не рос вечно)
  if (recentCalls.size > 1000) {
    for (const [k, t] of recentCalls) {
      if (now - t > DEDUP_TTL_MS * 2) recentCalls.delete(k);
    }
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'pyrus-webhook' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id || data.task?.id;

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  // Дедупликация
  if (isDuplicate(taskId)) {
    console.log(`[WEBHOOK] task=${taskId} duplicate, skip`);
    return res.status(200).json({ skipped: 'duplicate' });
  }

  console.log(`[WEBHOOK] task=${taskId} → start optimization`);

  res.status(200).json({ accepted: true, task_id: taskId });

  optimizeAsync(taskId).catch(err => {
    console.error(`[WEBHOOK] task=${taskId} FAILED:`, err);
  });
}

async function optimizeAsync(taskId) {
  const { default: optimizeHandler } = await import('./optimize-photos.js');

  const mockReq = { method: 'POST', body: { task_id: taskId } };
  const mockRes = {
    status: (code) => ({
      json: (data) => {
        console.log(`[WEBHOOK] task=${taskId} result ${code}:`, JSON.stringify(data).substring(0, 200));
        return mockRes;
      },
    }),
    json: (data) => {
      console.log(`[WEBHOOK] task=${taskId} result:`, JSON.stringify(data).substring(0, 200));
      return mockRes;
    },
  };

  await optimizeHandler(mockReq, mockRes);
}
