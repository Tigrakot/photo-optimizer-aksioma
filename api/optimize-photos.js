/**
 * Основной API: скачать фото из Pyrus, оптимизировать, упаковать в zip, вернуть в Pyrus
 *
 * POST /api/optimize-photos
 * { "task_id": 367329712 }
 *
 * Поддерживает несколько пар полей (конфигурируется):
 * - u_photo2_source  →  u_ne_source    (основной осмотр)
 * - u_photo3_source  →  u_ne2_source   (доп. осмотр)
 *
 * Каждая пара обрабатывается независимо. Если фото в каком-то поле — бот
 * архивирует его и привязывает к соответствующему полю-результату.
 */

import sharp from 'sharp';
import JSZip from 'jszip';
import { pyrusRequest, downloadPyrusFile, downloadPyrusFilesParallel, uploadPyrusFile } from './_pyrus.js';

// Пары полей: вход (фото) → выход (архив). Можно расширять.
const FIELD_PAIRS = [
  { inputCode: 'u_photo2_source', outputCode: 'u_ne_source', label: 'осмотр' },
  { inputCode: 'u_photo3_source', outputCode: 'u_ne2_source', label: 'доп. осмотр' },
];

// Старая конфигурация для обратной совместимости (если есть FIELDS_CONFIG)
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

function getFieldIdByCode(task, code) {
  if (!code) return null;
  // Сначала пробуем по field.code (новый Pyrus API)
  const byCode = (task.fields || []).find(f => f.code === code);
  if (byCode) return byCode.id;
  // Fallback на env
  const envKey = `FIELD_${code.toUpperCase()}_ID`;
  return process.env[envKey] || null;
}

// Настройки оптимизации
const TARGET_ZIP_SIZE = 18 * 1024 * 1024;  // Целевой размер zip (с запасом от 20 MB лимита)
const PART_SIZE = 18 * 1024 * 1024;         // Размер одной части при сплите
const MIN_QUALITY = 60;
const MIN_DIMENSION = 1024;

const QUALITY_LEVELS = [
  { dimension: 1920, quality: 82 },
  { dimension: 1600, quality: 78 },
  { dimension: 1280, quality: 74 },
  { dimension: 1024, quality: 70 },
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

    // Стартовый комментарий убран — финальный и так короткий
    const startComment = null;

    // 2. Обрабатываем пары последовательно:
    // Сначала u_photo2_source → u_ne_source (первый осмотр)
    // Если архив в u_ne_source уже есть → обрабатываем u_photo3_source → u_ne2_source
    // Это позволяет сотруднику делать 2 нажатия кнопки:
    //   1) для основного осмотра
    //   2) для доп. осмотра (после загрузки фото)
    const results = [];
    for (const pair of FIELD_PAIRS) {
      const pairResult = await processFieldPair(task, taskId, pair, startTime);
      results.push(pairResult);
      // Если первая пара уже заархивирована (пропущена) — продолжаем
      // Если первая пара обработана — продолжаем
      // Если архивов нет и фото нет — пропускаем всё
    }

    // Финальный комментарий — максимально короткий
    const processedPairs = results.filter(r => r.processed);
    const skippedPairs = results.filter(r => !r.processed);

    let finalText = '';
    if (processedPairs.length > 0) {
      // Компактно: "Готово!" + название архива (без лишних деталей)
      for (const r of processedPairs) {
        const archiveName = r.zipName || `photo_archive_${r.label}_${new Date().toISOString().slice(0,10)}.zip`;
        finalText += `📦 Готово! ${archiveName}\n`;
      }
    } else {
      finalText = `ℹ️ Нет фото для обработки.`;
      if (skippedPairs.length > 0) {
        finalText += ' ' + skippedPairs.map(r => `${r.label}: ${r.skipped || 'skip'}`).join(', ');
      }
    }

    // Удаляем стартовый комментарий
    if (startComment && startComment.id) {
      try {
        await pyrusRequest(`/tasks/${taskId}/comments/${startComment.id}`, { method: 'DELETE' });
      } catch (e) {}
    }

    // Пишем финальный комментарий
    try {
      await pyrusRequest(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text: finalText }),
      });
    } catch (e) {
      console.error('[OPTIMIZE] final comment failed:', e.message);
    }

    console.log(`[OPTIMIZE] task=${taskId} all done in ${Date.now() - startTime}ms`);

    return res.status(200).json({
      success: true,
      task_id: taskId,
      results: results.map(r => ({
        label: r.label,
        input: r.inputCode,
        output: r.outputCode,
        processed: r.processed,
        photos: r.photos || 0,
      })),
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    console.error('[OPTIMIZE ERROR]', error);
    return res.status(500).json({ error: error.message });
  }
}

/**
 * Обработать одну пару полей (фото → архив)
 */
async function processFieldPair(task, taskId, pair, startTime) {
  const result = {
    label: pair.label,
    inputCode: pair.inputCode,
    outputCode: pair.outputCode,
    processed: false,
    skipped: null,
    photos: 0,
    originalSize: 0,
    zipSize: 0,
    savedPercent: 0,
    parts: 1,
  };

  const inputFieldId = getFieldIdByCode(task, pair.inputCode);
  const outputFieldId = getFieldIdByCode(task, pair.outputCode);

  if (!inputFieldId) {
    console.log(`[OPTIMIZE] pair ${pair.inputCode}: field not found, skipping`);
    result.skipped = 'field not found';
    return result;
  }

  // Собираем значение полей (массив вложений)
  const inputField = (task.fields || []).find(f => f.id === inputFieldId);
  const outputField = outputFieldId ? (task.fields || []).find(f => f.id === outputFieldId) : null;
  const photos = inputField?.value;
  const existingArchive = outputField?.value;

  if (!photos || !Array.isArray(photos) || photos.length === 0) {
    console.log(`[OPTIMIZE] pair ${pair.inputCode}: no photos, skipping`);
    result.skipped = 'no photos';
    return result;
  }

  // Проверка: если в поле-результате уже есть архив бота — не пересобираем
  if (existingArchive && Array.isArray(existingArchive)) {
    const hasBotArchive = existingArchive.some(f =>
      f.name && /^photo_archive_.*\.zip$/i.test(f.name)
    );
    if (hasBotArchive) {
      console.log(`[OPTIMIZE] pair ${pair.inputCode}: already has bot archive in ${pair.outputCode}, skipping`);
      result.skipped = 'already archived';
      return result;
    }
  }

  // 1. Скачиваем фото (параллельно, по 5 одновременно, 30s timeout на файл)
  console.log(`[OPTIMIZE] pair ${pair.inputCode}: downloading ${photos.length} photos (parallel, 5 concurrent)`);
  const downloaded = await downloadPyrusFilesParallel(photos, 5, (done, total) => {
    if (done % 20 === 0 || done === total) {
      console.log(`[OPTIMIZE] pair ${pair.inputCode}: downloaded ${done}/${total}`);
    }
  });

  if (downloaded.length === 0) {
    console.error(`[OPTIMIZE] pair ${pair.inputCode}: failed to download any photo`);
    result.skipped = 'download failed';
    return result;
  }

  const photoBuffers = downloaded;
  const totalOriginalSize = photoBuffers.reduce((s, x) => s + x.original.length, 0);
  result.originalSize = totalOriginalSize;
  result.photos = photoBuffers.length;  // Реальное кол-во (с учётом ошибок скачивания)
  if (downloaded.length < photos.length) {
    console.warn(`[OPTIMIZE] pair ${pair.inputCode}: only ${downloaded.length}/${photos.length} photos downloaded`);
  }

  // 2. Оптимизация
  const shouldOptimize = totalOriginalSize > 20 * 1024 * 1024;
  let optimized = [];
  let zipBuffer = null;

  if (!shouldOptimize) {
    // Просто пакуем как есть
    for (const item of photoBuffers) {
      optimized.push({ name: item.name, buffer: item.original });
    }
  } else {
    // Адаптивное сжатие
    let levelIndex = 0;
    while (levelIndex < QUALITY_LEVELS.length + 1) {
      const isLastPass = levelIndex === QUALITY_LEVELS.length;
      const level = QUALITY_LEVELS[Math.min(levelIndex, QUALITY_LEVELS.length - 1)];

      console.log(`[OPTIMIZE] pair ${pair.inputCode}: pass ${levelIndex + 1} (${level.dimension}px/q${level.quality})`);

      optimized = [];
      for (const item of photoBuffers) {
        try {
          const isImage = /\.(jpe?g|png|webp|heic|heif|tiff?)$/i.test(item.name);
          if (isImage) {
            const buf = await optimizeImage(item.original, level.dimension, level.quality);
            const newName = item.name.replace(/\.(png|webp|heic|heif|tiff?)$/i, '.jpg');
            optimized.push({ name: newName, buffer: buf });
          } else {
            optimized.push({ name: item.name, buffer: item.original });
          }
        } catch (err) {
          console.error(`[OPTIMIZE] ${item.name} failed:`, err.message);
        }
      }

      // Проверяем размер zip
      const zip = new JSZip();
      for (const item of optimized) zip.file(item.name, item.buffer);
      zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      if (zipBuffer.length <= TARGET_ZIP_SIZE) break;
      if (isLastPass) {
        console.warn(`[OPTIMIZE] pair ${pair.inputCode}: even max compression > target`);
        break;
      }
      levelIndex++;
    }
  }

  // Финальная упаковка
  if (!zipBuffer) {
    const zip = new JSZip();
    for (const item of optimized) zip.file(item.name, item.buffer);
    zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }

  result.zipSize = zipBuffer.length;
  result.savedPercent = ((1 - zipBuffer.length / totalOriginalSize) * 100).toFixed(0);

  console.log(`[OPTIMIZE] pair ${pair.inputCode}: final zip ${formatSize(zipBuffer.length)} (saved ${result.savedPercent}%)`);

  // 3. Сплит если > 18 MB
  const dateStr = new Date().toISOString().slice(0, 10);
  const labelAscii = transliterate(pair.label).replace(/\s+/g, '_');
  const mainZipName = `photo_archive_${labelAscii}_${dateStr}.zip`;
  result.zipName = mainZipName;
  let archives = [{ name: mainZipName, buffer: zipBuffer }];

  if (zipBuffer.length > PART_SIZE) {
    archives = await splitZipBySize(optimized, PART_SIZE, labelAscii);
  }

  // 4. Загружаем в Pyrus
  // Перед загрузкой — повторная проверка (race condition защита):
  // если другой инвокс бота уже загрузил архив — отменяем свой
  try {
    const recheckRes = await pyrusRequest(`/tasks/${taskId}`);
    const recheckTask = recheckRes.task || recheckRes;
    const recheckField = (recheckTask.fields || []).find(f => f.id === outputFieldId);
    const recheckArchive = recheckField?.value;
    if (recheckArchive && Array.isArray(recheckArchive) && recheckArchive.length > 0) {
      const hasBotArchiveNow = recheckArchive.some(f =>
        f.name && /^photo_archive_.*\.zip$/i.test(f.name)
      );
      if (hasBotArchiveNow) {
        console.log(`[OPTIMIZE] pair ${pair.inputCode}: re-check found bot archive (race condition), aborting`);
        result.skipped = 'already archived (race)';
        return result;
      }
    }
  } catch (e) {
    console.warn(`[OPTIMIZE] pair ${pair.inputCode}: re-check failed:`, e.message);
  }

  const uploadedArchives = [];
  for (let i = 0; i < archives.length; i++) {
    const archive = archives[i];
    console.log(`[OPTIMIZE] pair ${pair.inputCode}: uploading part ${i + 1}/${archives.length}`);
    const uploaded = await uploadPyrusFile(archive.name, archive.buffer);
    uploadedArchives.push(uploaded);
  }

  // 5. Привязываем к полю-результату
  if (outputFieldId && uploadedArchives.length > 0) {
    // Технический коммент чтобы получить attachment_id
    let attachmentIds = [];
    try {
      const attachResult = await pyrusRequest(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          text: '.',
          attachments: uploadedArchives.map(a => a.id),
        }),
      });
      const result = attachResult.task || attachResult;
      const lastComment = (result.comments || []).slice(-1)[0];
      if (lastComment && lastComment.attachments) {
        attachmentIds = lastComment.attachments.map(a => a.id);
      }
    } catch (e) {
      console.error(`[OPTIMIZE] pair ${pair.inputCode}: attach failed:`, e.message);
    }

    // Привязка к полю
    if (attachmentIds.length > 0) {
      try {
        await pyrusRequest(`/tasks/${taskId}/comments`, {
          method: 'POST',
          body: JSON.stringify({
            text: '',
            field_updates: [
              { code: pair.outputCode, value: attachmentIds.map(id => ({ attachment_id: id })) },
            ],
          }),
        });
        console.log(`[OPTIMIZE] pair ${pair.inputCode}: attached to ${pair.outputCode}`);
      } catch (e) {
        console.error(`[OPTIMIZE] pair ${pair.inputCode}: field update failed:`, e.message);
      }
    }
  }

  result.parts = archives.length;
  result.processed = true;
  return result;
}

// Helpers

async function optimizeImage(buffer, maxDim, quality) {
  return await sharp(buffer)
    .rotate()
    .resize({
      width: maxDim,
      height: maxDim,
      fit: 'inside',
      withoutEnlargement: true,
      // kernel: 'lanczos3' (по умолчанию) — лучше чем bicubic для фото
    })
    .jpeg({
      quality,
      mozjpeg: true,                    // MozJPEG encoder
      trellisQuantisation: true,        // Trellis quantisation — лучше качество на низких q
      overshootDeringing: true,         // Убирает ringing-артефакты
      progressive: true,                // Progressive JPEG
      chromaSubsampling: '4:2:0',      // Стандарт для фото
      optimizeScans: true,              // Оптимизация progressive scans
      optimizeCoding: true,             // Оптимизация Huffman tables
    })
    .withMetadata({
      // Удаляем EXIF, ICC, XMP — экономит 5-15% размера
      exif: {},
      icc: 'srgb',  // Конвертируем в sRGB (убираем большие ICC-профили)
    })
    .toBuffer();
}

async function splitZipBySize(items, maxPartSize, pairCode) {
  const parts = [];
  let currentZip = new JSZip();
  let partIndex = 1;
  const dateStr = new Date().toISOString().slice(0, 10);
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));

  for (const item of sorted) {
    // Тестовый архив
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

    if (testBuf.length > maxPartSize && currentZip.files.length > 0) {
      const partBuf = await currentZip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      parts.push({
        name: `photo_archive_${pairCode}_part${partIndex}_${dateStr}.zip`,
        buffer: partBuf,
      });
      partIndex++;
      currentZip = new JSZip();
    }

    currentZip.file(item.name, item.buffer);
  }

  if (currentZip.files.length > 0) {
    const partBuf = await currentZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    parts.push({
      name: `photo_archive_${pairCode}_part${partIndex}_${dateStr}.zip`,
      buffer: partBuf,
    });
  }

  return parts;
}

async function addComment(taskId, text) {
  try {
    const result = await pyrusRequest(`/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    return { id: result.comment?.id || result.id };
  } catch (e) {
    console.error('[OPTIMIZE] addComment failed:', e.message);
    return null;
  }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Транслитерация кириллицы → латиница для имён файлов
 * (для совместимости с Windows, email-клиентами и т.д.)
 */
function transliterate(text) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
    'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
    'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch',
    'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z',
    'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
    'С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sch',
    'Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya',
  };
  return text.replace(/[А-Яа-яЁё]/g, c => map[c] || c);
}
