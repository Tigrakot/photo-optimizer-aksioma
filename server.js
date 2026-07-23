/**
 * Express сервер для Railway
 * Заменяет Vercel serverless functions
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import optimizePhotosHandler from './api/optimize-photos.js';
import taskInfoHandler from './api/task-info.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'photo-optimizer-aksioma' });
});

// Index — redirect to confirm with task_id or healthcheck
app.get('/', (req, res) => {
  if (req.query.task_id) {
    return res.redirect(`/confirm.html?task_id=${req.query.task_id}`);
  }
  res.json({
    status: 'ok',
    service: 'photo-optimizer-aksioma',
    usage: 'GET /confirm.html?task_id=YOUR_PYRUS_TASK_ID',
  });
});

// API endpoints
app.all('/api/optimize-photos', (req, res) => optimizePhotosHandler(req, res));
app.all('/api/task-info', (req, res) => taskInfoHandler(req, res));

// Fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] photo-optimizer-aksioma listening on port ${PORT}`);
});
