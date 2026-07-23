/**
 * Основной API: скачать фото из Pyrus, оптимизировать, упаковать в zip, вернуть в Pyrus
 *
 * POST /api/optimize-photos
 * { "task_id": 367329712 }
 */

import sharp from 'sharp';
import JSZip from 'jszip';
import { pyrusRequest, downloadPyrusFile, uploadPyrusFile } from './_pyrus.js';

// Маппинг field codes по form_id. Можно переопределить через env FIELDS_CONFIG (JSON).
// Приоритет: env FIELDS_CONFIG > встроенный config
const DEFAULT_FIELDS_CONFIG = {
  2316414: { photos: 'u_photo2_source', archive: 'u_ne_source' },
  2451012: { photos: 'u_photo2_source', archive: 'u_ne_source' },
};

function getFieldsConfig() {
  if (process.env.FIELDS_CONFIG) {
    try {
      return JSON.parse(process.env.FIELDS_CONFIG);
    } catch (e) {
      console.warn('[OPTIMIZE] Invalid FIELDS_CONFIG, using default');
    }
  }
  return DEFAULT_FIELDS_CONFIG;
}

/**
 * Получить field id по code для конкретной задачи
 */
function getFieldIdsByCode(task) {
  const config = getFieldsConfig();
  const formId = task.form_id;
  const fieldsConfig = config[formId] || config[String(formId)];

  if (!fieldsConfig) {
    // Универсальный дефолт — используем code (работает на любой форме)
    console.log(`[OPTIMIZE] No fields config for form ${formId}, using default codes`);
    const codeMap = {};
    (task.fields || []).forEach(f => {
      if (f.code) codeMap[f.code] = f.id;
    });
    return {
      photos: codeMap['u_photo2_source'] || process.env.FIELD_PHOTOS_ID,
      archive: codeMap['u_ne_source'] || process.env.FIELD_ARCHIVE_ID,
    };
  }

  const fieldMap = {};
  (task.fields || []).forEach(f => {
    if (f.code) fieldMap[f.code] = f.id;
  });

  return {
    photos: fieldMap[fieldsConfig.photos],
    archive: fieldMap[fieldsConfig.archive],
  };
}

// Настройки оптимизации
const TARGET_ZIP_SIZE = 18 * 1024 * 1024;  // Целевой размер zip (с запасом от 20 MB лимита)
const PART_SIZE = 18 * 1024 * 1024;         // Размер одной части при сплите
const MIN_QUALITY = 60;                     // Минимальное качество JPEG (ниже — артефакты)
const MIN_DIMENSION = 1024;                 // Минимальная сторона (ниже — слишком мелко)

// Адаптивные уровни сжатия
const QUALITY_LEVELS = [
  { dimension: 1920, quality: 82 },  // Стандарт
  { dimension: 1600, quality: 78 },  // Средний
  { dimension: 1280, quality: 74 },  // Агрессивный
  { dimension: 1024, quality: 70 },  // Экстра
];

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'photo-optimizer-aksioma' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const { task_id: taskId } = req.body || {};

  if (!taskId) {
    return res.status(400).json({ error: 'No task_id' });
  }

  try {
    console.log(`[OPTIMIZE] task=${taskId} start`);

    // 1. Получаем задачу
    const taskRes = await pyrusRequest(`/tasks/${taskId}`);
    if (taskRes.error || !taskRes.task) {
      return res.status(403).json({ error: taskRes.error || 'No access to task' });
    }
    const task = taskRes.task;
    const fieldMap = {};
    (task.fields || []).forEach(f => { fieldMap[f.id] = f.value; });

    // Получаем ID полей по кодам (поддержка разных форм)
    const fields = getFieldIdsByCode(task);
    if (!fields.photos || !fields.archive) {
      return res.status(400).json({
        error: `Cannot find required fields in form ${task.form_id}. photos=${fields.photos}, archive=${fields.archive}`,
      });
    }

    const photos = fieldMap[fields.photos];
    if (!photos || !Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ error: 'No photos in field 83 (Фото осмотра)' });
    }

    console.log(`[OPTIMIZE] task=${taskId} found ${photos.length} photos`);

    // Стартовый комментарий — чтобы пользователь видел что бот включился
    const startComment = await addComment(taskId, `⏳ Оптимизирую ${photos.length} фото...`);

    // 2. Скачиваем ВСЕ фото в память
    const photoBuffers = [];
    let totalOriginalSize = 0;
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      try {
        const buffer = await downloadPyrusFile(photo.id);
        totalOriginalSize += buffer.length;
        photoBuffers.push({ name: photo.name, original: buffer });
      } catch (err) {
        console.error(`[OPTIMIZE] Failed to download ${photo.name}:`, err);
      }
    }

    // Если сумма фото < 20 MB — НЕ сжимаем картинки (чтобы не раздувать)
    // Просто пакуем в ZIP (там работает DEFLATE, повторит сжатие)
    const shouldOptimize = totalOriginalSize > 20 * 1024 * 1024;
    console.log(`[OPTIMIZE] task=${taskId} total=${formatSize(totalOriginalSize)}, shouldOptimize=${shouldOptimize}`);

    await updateComment(taskId, progressComment.id,
      shouldOptimize
        ? `⏳ Сжимаю ${photos.length} фото (${formatSize(totalOriginalSize)} > 20 MB)...`
        : `⏳ Пакую ${photos.length} фото в архив (${formatSize(totalOriginalSize)} ≤ 20 MB)...`
    );

    // 4. Адаптивное сжатие с несколькими проходами
    // Если после сжатия архив > TARGET_ZIP_SIZE, пробуем более агрессивные настройки
    let optimized = [];
    let levelIndex = 0;
    let zipBuffer = null;
    let totalOptimizedSize = 0;

    // Если НЕ надо сжимать — сразу в ZIP без сжатия
    if (!shouldOptimize) {
      for (const item of photoBuffers) {
        optimized.push({ name: item.name, buffer: item.original });
        totalOptimizedSize += item.original.length;
      }
    } else {
      // Иначе — несколько проходов сжатия
      while (levelIndex < QUALITY_LEVELS.length + 1) {
        const isLastPass = levelIndex === QUALITY_LEVELS.length;
        const level = QUALITY_LEVELS[Math.min(levelIndex, QUALITY_LEVELS.length - 1)];

        await updateComment(taskId, progressComment.id,
          `⏳ Проход ${levelIndex + 1}: ${level.dimension || MIN_DIMENSION}px, q=${level.quality || MIN_QUALITY}...`
        );

        // Сжимаем все фото с текущими настройками
        optimized = [];
        totalOptimizedSize = 0;
        for (const item of photoBuffers) {
          try {
            const isImage = /\.(jpe?g|png|webp|heic|heif|tiff?)$/i.test(item.name);
            if (isImage) {
              const buf = await optimizeImage(item.original, level.dimension, level.quality);
              const newName = item.name.replace(/\.(png|webp|heic|heif|tiff?)$/i, '.jpg');
              optimized.push({ name: newName, buffer: buf });
              totalOptimizedSize += buf.length;
            } else {
              optimized.push({ name: item.name, buffer: item.original });
              totalOptimizedSize += item.original.length;
            }
          } catch (err) {
            console.error(`[OPTIMIZE] ${item.name} failed:`, err.message);
          }
        }

      // Пакуем в zip
      const zip = new JSZip();
      for (const item of optimized) {
        zip.file(item.name, item.buffer);
      }
      zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      console.log(`[OPTIMIZE] pass ${levelIndex + 1} (${level.dimension || MIN_DIMENSION}px/q${level.quality || MIN_QUALITY}): ${zipBuffer.length} bytes`);

      // Если zip влезает в лимит — выходим
      if (zipBuffer.length <= TARGET_ZIP_SIZE) {
        break;
      }

      // Если это был последний проход — выходим даже если не влезло
      if (isLastPass) {
        console.warn(`[OPTIMIZE] Even with max compression, zip is ${zipBuffer.length} bytes (target ${TARGET_ZIP_SIZE})`);
        break;
      }

      levelIndex++;
    }
    }  // end else (shouldOptimize)

    // Пакуем финальный архив
    const zip = new JSZip();
    for (const item of optimized) {
      zip.file(item.name, item.buffer);
    }
    zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    console.log(`[OPTIMIZE] task=${taskId} final zip size: ${zipBuffer.length} bytes (${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // 5. Если архив всё равно больше PART_SIZE — сплитим на части
    let archives = [{ name: `photo_archive_${new Date().toISOString().slice(0, 10)}.zip`, buffer: zipBuffer }];

    if (zipBuffer.length > PART_SIZE) {
      console.log(`[OPTIMIZE] Splitting archive into parts...`);
      archives = await splitZipBySize(optimized, PART_SIZE, (msg) =>
        updateComment(taskId, progressComment.id, `⏳ ${msg}`)
      );
    }

    // 6. Загружаем все части в Pyrus
    const uploadedArchives = [];
    for (let i = 0; i < archives.length; i++) {
      const archive = archives[i];
      await updateComment(taskId, progressComment.id, `⏳ Загружаю часть ${i + 1}/${archives.length}...`);
      console.log(`[OPTIMIZE] task=${taskId} uploading part ${i + 1}/${archives.length} (${archive.buffer.length} bytes)`);
      try {
        const uploaded = await uploadPyrusFile(archive.name, archive.buffer);
        console.log(`[OPTIMIZE] task=${taskId} uploaded guid=${uploaded.id}`);
        uploadedArchives.push(uploaded);
      } catch (upErr) {
        console.error(`[OPTIMIZE] task=${taskId} upload FAILED:`, upErr.message);
        throw upErr;
      }
    }

    const uploaded = uploadedArchives[0]; // первый архив — основной, его привязываем к полю

    // 6. Привязываем файл к задаче + пишем комментарий + обновляем поле "НЭ"
    // В одном запросе: attachments + field_updates (используем code, не id)
    const archiveFieldCode = 'u_ne_source';

    // Если несколько частей — упомянем в комменте
    const partsInfo = uploadedArchives.length > 1
      ? `\n📦 Разбито на ${uploadedArchives.length} частей`
      : '';

    // Трёхшаговый процесс:
    // 1. Прикрепить архив через attachments в "пустой" коммент (получить attachment id)
    // 2. Привязать к полю через field_updates с attachment_id
    // 3. Написать красивый комментарий со статистикой (без архива)

    let attachmentIds = [];

    // Шаг 1: прикрепляем архив через "технический" комментарий (без текста)
    let technicalCommentId = null;
    try {
      const attachResult = await pyrusRequest(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          text: '',
          attachments: uploadedArchives.map(a => a.id),
        }),
      });

      // Достаём id вложений из ответа
      const task = attachResult.task || attachResult;
      const lastComment = (task.comments || []).slice(-1)[0];
      if (lastComment && lastComment.attachments) {
        attachmentIds = lastComment.attachments.map(a => a.id);
        technicalCommentId = lastComment.id;
        console.log(`[OPTIMIZE] task=${taskId} attached, got ids:`, attachmentIds);
      }
    } catch (attachErr) {
      console.error(`[OPTIMIZE] task=${taskId} attach FAILED:`, attachErr.message);
    }

    // Шаг 2: привязываем к полю + пишем финальный комментарий (ОДНИМ запросом)
    if (attachmentIds.length > 0) {
      try {
        await pyrusRequest(`/tasks/${taskId}/comments`, {
          method: 'POST',
          body: JSON.stringify({
            text: `📦 Архив готов!${partsInfo}\n\n`
                + `📊 Статистика:\n`
                + `• Фото: ${photos.length}\n`
                + `• Исходный размер: ${formatSize(totalOriginalSize)}\n`
                + `• После сжатия: ${formatSize(zipBuffer.length)}\n`
                + `• Экономия: ${((1 - zipBuffer.length / totalOriginalSize) * 100).toFixed(0)}%\n`
                + `• Время: ${((Date.now() - startTime) / 1000).toFixed(1)} сек\n\n`
                + `Архив привязан к полю «НЭ».`,
            field_updates: [
              { code: archiveFieldCode, value: attachmentIds.map(id => ({ attachment_id: id })) },
            ],
          }),
        });
        console.log(`[OPTIMIZE] task=${taskId} final comment + field updated OK`);
      } catch (updateErr) {
        console.error(`[OPTIMIZE] task=${taskId} final comment FAILED:`, updateErr.message);
      }
    } else {
      // Если не получили ids — просто пишем комментарий
      try {
        await pyrusRequest(`/tasks/${taskId}/comments`, {
          method: 'POST',
          body: JSON.stringify({
            text: `📦 Архив готов!${partsInfo}\n\n`
                + `📊 Статистика:\n`
                + `• Фото: ${photos.length}\n`
                + `• Исходный размер: ${formatSize(totalOriginalSize)}\n`
                + `• После сжатия: ${formatSize(zipBuffer.length)}\n`
                + `• Экономия: ${((1 - zipBuffer.length / totalOriginalSize) * 100).toFixed(0)}%\n`
                + `• Время: ${((Date.now() - startTime) / 1000).toFixed(1)} сек`,
          }),
        });
      } catch (e) {}
    }

    // Шаг 3: удаляем технический комментарий с архивом
    if (technicalCommentId) {
      try {
        await pyrusRequest(`/tasks/${taskId}/comments/${technicalCommentId}`, {
          method: 'DELETE',
        });
        console.log(`[OPTIMIZE] task=${taskId} deleted technical comment ${technicalCommentId}`);
      } catch (delErr) {
        console.warn(`[OPTIMIZE] task=${taskId} could not delete technical comment:`, delErr.message);
      }
    }

    // Удаляем стартовый комментарий "⏳ Оптимизирую..." (если он есть)
    if (startComment && startComment.id) {
      try {
        await pyrusRequest(`/tasks/${taskId}/comments/${startComment.id}`, {
          method: 'DELETE',
        });
        console.log(`[OPTIMIZE] task=${taskId} deleted start comment ${startComment.id}`);
      } catch (delErr) {
        console.warn(`[OPTIMIZE] task=${taskId} could not delete start comment:`, delErr.message);
      }
    }

    // 8. Удаляем прогресс-коммент (если возможно) — больше не используется
    // (старый код оставлен для совместимости, ничего не делает)

    console.log(`[OPTIMIZE] task=${taskId} done in ${Date.now() - startTime}ms`);

    console.log(`[OPTIMIZE] task=${taskId} all done, returning response`);

    return res.status(200).json({
      success: true,
      task_id: taskId,
      photos: photos.length,
      parts: uploadedArchives.length,
      original_size: totalOriginalSize,
      optimized_size: totalOptimizedSize + zipBuffer.length,
      saved_percent: ((1 - (totalOptimizedSize + zipBuffer.length) / totalOriginalSize) * 100).toFixed(1),
      archives: uploadedArchives.map(a => ({ id: a.id, name: a.name, size: a.size })),
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    console.error('[OPTIMIZE ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}

// Helpers

async function optimizeImage(buffer, maxDim, quality) {
  return await sharp(buffer)
    .rotate() // авто-поворот по EXIF
    .resize({
      width: maxDim,
      height: maxDim,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({
      quality,
      mozjpeg: true,
      progressive: true,
      chromaSubsampling: '4:2:0',
    })
    .toBuffer();
}

/**
 * Разбить файлы на несколько zip-архивов, чтобы каждый был не больше maxPartSize
 * Стратегия: добавляем файлы по одному, пока архив не переполнится, потом новый архив
 */
async function splitZipBySize(items, maxPartSize, onProgress) {
  const parts = [];
  let currentZip = new JSZip();
  let currentSize = 0;
  let partIndex = 1;

  // Сортируем файлы по имени для предсказуемости
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));

  for (const item of sorted) {
    // Создаём превью zip с этим файлом, чтобы прикинуть размер
    const testZip = new JSZip();
    for (const part of currentZip.files) {
      testZip.file(part.name, await currentZip.file(part.name).async('nodebuffer'));
    }
    testZip.file(item.name, item.buffer);
    const testBuf = await testZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    // Если добавление файла переполнит — закрываем текущую часть и начинаем новую
    if (testBuf.length > maxPartSize && currentZip.files.length > 0) {
      const partBuf = await currentZip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      parts.push({
        name: `photo_archive_part${partIndex}_${new Date().toISOString().slice(0, 10)}.zip`,
        buffer: partBuf,
      });
      if (onProgress) onProgress(`Создана часть ${partIndex} (${formatSize(partBuf.length)})`);
      partIndex++;
      currentZip = new JSZip();
      currentSize = 0;
    }

    // Если файл сам по себе больше лимита — кладём его в отдельный архив
    if (item.buffer.length > maxPartSize) {
      console.warn(`[OPTIMIZE] File ${item.name} (${formatSize(item.buffer.length)}) exceeds part size, putting in separate archive`);
    }

    currentZip.file(item.name, item.buffer);
    currentSize += item.buffer.length;
  }

  // Закрываем последнюю часть
  if (currentZip.files.length > 0) {
    const partBuf = await currentZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    parts.push({
      name: `photo_archive_part${partIndex}_${new Date().toISOString().slice(0, 10)}.zip`,
      buffer: partBuf,
    });
  }

  return parts;
}

async function addComment(taskId, text) {
  const result = await pyrusRequest(`/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return { id: result.comment?.id || result.id, ...result };
}

async function updateComment(taskId, commentId, text) {
  // No-op: больше не спамим промежуточными комментариями
  // commentId может быть null (progressComment удалена) — игнорируем
  if (!commentId) return null;
  console.log(`[PROGRESS] ${commentId}: ${text}`);
  return null;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
