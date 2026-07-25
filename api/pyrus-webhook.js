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

// Все пары полей (должны совпадать с FIELD_PAIRS в optimize-photos.js)
const FIELD_PAIRS = [
  { inputCode: 'u_photo2_source', outputCode: 'u_ne_source', label: 'осмотр' },
  { inputCode: 'u_photo3_source', outputCode: 'u_ne2_source', label: 'доп. осмотр' },
];

// Защита от обработки старых задач
const MAX_TASK_AGE_DAYS = parseInt(process.env.MAX_TASK_AGE_DAYS || '30', 10);
// Защита: если в поле-результате уже есть ЛЮБОЙ файл — пропускаем (не наша забота)
const SKIP_IF_ARCHIVE_FIELD_NON_EMPTY = process.env.SKIP_IF_ARCHIVE_FIELD_NON_EMPTY !== 'false';

// === Глобальная блокировка от race condition ===
// Если webhook уже обрабатывает задачу — остальные получат 200 (skip)
// и не будут плодить параллельные инвокации optimizeAsync
const activeTasks = new Set();
const TASK_LOCK_TTL_MS = 5 * 60 * 1000; // 5 мин максимум (защита от зависаний)

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'pyrus-webhook' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Для bot webhook (step) Pyrus может слать другой формат. Главное — task_id
  if (data && data.task) {
    // Иногда данные внутри task
    const innerTask = data.task;
    if (!taskId && innerTask.id) {
      req.body.task_id = innerTask.id;
    }
  }

  const data = req.body || {};
  const taskId = data.task_id || data.id;
  const event = data.event;

  console.log(`[WEBHOOK] event=${event} task=${taskId}`);

  // Если это webhook от bot (задача попала в наш step) — событие может быть другим
  // (Pyrus не всегда указывает event для bot webhook'ов)
  // Проверяем наличие задачи и идём дальше
  if (!event && taskId) {
    console.log(`[WEBHOOK] no event but task=${taskId}, assuming bot step trigger`);
  }

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  // Race condition защита: если уже обрабатываем эту задачу — пропускаем
  if (activeTasks.has(taskId)) {
    console.log(`[WEBHOOK] task=${taskId} already in progress, skip (race)`);
    return res.status(200).json({ skipped: 'already processing' });
  }
  activeTasks.add(taskId);
  setTimeout(() => activeTasks.delete(taskId), TASK_LOCK_TTL_MS); // автоснятие через 5 мин

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

    // Защита 1: не обрабатывать задачи старше MAX_TASK_AGE_DAYS дней
    const createDate = new Date(task.create_date);
    const ageMs = Date.now() - createDate.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_TASK_AGE_DAYS) {
      console.log(`[WEBHOOK] task=${taskId} too old (${ageDays.toFixed(1)} days > ${MAX_TASK_AGE_DAYS}), skip`);
      return res.status(200).json({ skipped: 'too old' });
    }

    // Проверяем: есть ли хотя бы в одной паре фото, и нет ли архивов бота
    let hasAnyPhotos = false;
    let hasAnyBotArchive = false;

    for (const pair of FIELD_PAIRS) {
      const photos = fieldMap[pair.inputCode];
      const archive = fieldMap[pair.outputCode];

      if (photos && Array.isArray(photos) && photos.length > 0) {
        hasAnyPhotos = true;
      }

      if (archive && Array.isArray(archive)) {
        const botArchived = archive.some(f => f.name && /^photo_archive_.*\.zip$/i.test(f.name));
        if (botArchived) {
          hasAnyBotArchive = true;
        }
      }
    }

    if (!hasAnyPhotos) {
      console.log(`[WEBHOOK] task=${taskId} no photos in any field, skip`);
      return res.status(200).json({ skipped: 'no photos' });
    }

    // Защита 2: если в поле-результате конкретной пары уже есть ЛЮБЫЕ файлы — не трогаем ЭТУ пару
    // (но другие пары могут быть пустыми и должны обрабатываться)
    if (SKIP_IF_ARCHIVE_FIELD_NON_EMPTY) {
      for (const pair of FIELD_PAIRS) {
        const photos = fieldMap[pair.inputCode];
        const archive = fieldMap[pair.outputCode];
        if (photos && Array.isArray(photos) && photos.length > 0) {
          if (archive && Array.isArray(archive) && archive.length > 0) {
            // Поле-результат занято — пропускаем только ЭТУ пару
            console.log(`[WEBHOOK] pair ${pair.inputCode}: result field has files, will skip in handler`);
            // Не выходим, просто помечаем (processFieldPair проверит ещё раз)
          }
        }
      }
    }

    // Если во ВСЕХ заполненных полях уже есть архивы бота — пропускаем
    // Если хотя бы в одном заполненном фото-поле нет архива — запускаем
    let allArchived = true;
    for (const pair of FIELD_PAIRS) {
      const photos = fieldMap[pair.inputCode];
      const archive = fieldMap[pair.outputCode];
      if (photos && Array.isArray(photos) && photos.length > 0) {
        const hasArchive = archive && Array.isArray(archive) && archive.some(f =>
          f.name && /^photo_archive_.*\.zip$/i.test(f.name)
        );
        if (!hasArchive) {
          allArchived = false;
          break;
        }
      }
    }
    if (allArchived) {
      console.log(`[WEBHOOK] task=${taskId} all photo fields already archived, skip`);
      return res.status(200).json({ skipped: 'already archived' });
    }

    console.log(`[WEBHOOK] task=${taskId} starting optimization`);

    // Запускаем оптимизацию асинхронно (Pyrus ждёт ответ 60 сек, оптимизация может быть дольше)
    // Снимаем блокировку после завершения (успех или ошибка)
    optimizeAsync(taskId)
      .catch(err => {
        console.error(`[WEBHOOK] optimize FAILED for task ${taskId}:`, err);
      })
      .finally(() => {
        activeTasks.delete(taskId);
        console.log(`[WEBHOOK] task=${taskId} lock released`);
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
