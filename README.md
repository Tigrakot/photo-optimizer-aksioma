# Photo Optimizer АКСИОМА (Railway)

Бот для оптимизации фото осмотра в задачах Pyrus. Express-сервер на Railway с Docker.

## Что умеет

- 📉 Сжатие JPEG через mozjpeg (q=70-82)
- 📐 Уменьшение до 1024-1920px (адаптивно)
- 🔒 Удаление EXIF/GPS
- 📦 Адаптивная упаковка: если архив > 18 MB, сжимает агрессивнее
- 📦✂️ Сплит на части по 18 MB если всё равно большой
- 💬 Прогресс-комментарии в Pyrus

## Структура

```
photo-optimizer-aksioma/
├── api/
│   ├── _pyrus.js          # Pyrus auth + download/upload
│   ├── optimize-photos.js # Основной endpoint
│   └── task-info.js       # Инфо о задаче
├── public/
│   └── confirm.html       # Web-страница подтверждения
├── server.js              # Express entry point
├── Dockerfile
├── railway.json
├── package.json
└── README.md
```

## Деплой на Railway

### 1. Создай репо на GitHub

```bash
cd /Users/vladimirosadchiy/Desktop/photo-optimizer-aksioma
git init
git add .
git commit -m "Initial commit"
gh repo create photo-optimizer-aksioma --public --source=. --remote=origin --push
```

### 2. Создай проект в Railway

1. Открой https://railway.app → New Project → Deploy from GitHub
2. Выбери репо `photo-optimizer-aksioma`
3. Railway сам найдёт `Dockerfile` и соберёт

### 3. Добавь env vars

В Railway → Variables:
- `PYRUS_BOT_LOGIN` = email бота Pyrus
- `PYRUS_BOT_KEY` = security key бота

### 4. Готово

Railway даст URL типа `https://photo-optimizer-aksioma.up.railway.app`.

## Использование

### Кнопка в Pyrus

В форме 2316414 (или 2451012) добавь поле-кнопку (например id 41 "Архивировать") с URL:

```
https://<your-railway-url>/confirm.html?task_id={task_id}
```

`{task_id}` — Pyrus подставит сам.

### Прямой вызов (для тестов)

```bash
curl -X POST https://<your-railway-url>/api/optimize-photos \
  -H "Content-Type: application/json" \
  -d '{"task_id": 368153730}'
```

## Поля формы

Бот использует **field codes** (стабильнее чем id):

| Form ID | photos (code) | archive (code) |
|---------|--------------|----------------|
| 2316414 | `u_photo2_source` | `u_ne_source` |
| 2451012 | `u_photo2_source` | `u_ne_source` |

Можно переопределить через env `FIELDS_CONFIG` (JSON):

```json
{
  "2316414": { "photos": "u_photo2_source", "archive": "u_ne_source" },
  "2451012": { "photos": "u_photo2_source", "archive": "u_ne_source" }
}
```

## Сравнение с Vercel

| | Vercel Free | Railway Free |
|---|---|---|
| Function timeout | 10 сек | ∞ |
| Memory | 1024 MB | 8 GB |
| Bandwidth | лимиты | 100 GB/мес |
| Multipart upload | часто ломается | работает |
| Cold start | есть | минимальный |
| Цена | $0 | $5 кредит/мес |

## Разработка локально

```bash
npm install
PYRUS_BOT_LOGIN=... PYRUS_BOT_KEY=... npm start
```

Сервер на `http://localhost:3000`.
