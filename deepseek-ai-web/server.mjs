import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(rootDir, 'dist', 'public');
const apiUrl = 'https://api.apinex.bond/v1/chat/completions';
const model = 'free/deepseek-v4-pro-0813';

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ model });
});

app.get('/api/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.APINEX_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Hãy cấu hình APINEX_API_KEY trong biến môi trường của máy chủ.' });
    return;
  }

  const messages = req.body?.messages;
  const validMessages = Array.isArray(messages)
    && messages.length > 0
    && messages.length <= 40
    && messages.every((message) => (
      message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
      && message.content.length <= 30_000
    ));
  if (!validMessages) {
    res.status(400).json({ error: 'Danh sách tin nhắn không hợp lệ.' });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Bạn là trợ lý AI hữu ích. Trả lời bằng ngôn ngữ người dùng sử dụng. Khi viết mã, hãy trình bày rõ ràng và dùng code block.',
          },
          ...messages.slice(-40),
        ],
        stream: true,
        temperature: 0.7,
      }),
    });
  } catch (error) {
    console.error('Không kết nối được APINex:', error instanceof Error ? error.message : 'lỗi không xác định');
    res.status(502).json({ error: 'Không kết nối được APINex. Hãy thử lại sau.' });
    return;
  }

  if (!upstream.ok) {
    console.warn(`APINex trả về HTTP ${upstream.status}.`);
    res.status(502).json({
      error: `APINex trả về lỗi HTTP ${upstream.status}. Kiểm tra API Key, model và quota.`,
    });
    return;
  }
  if (!upstream.body) {
    res.status(502).json({ error: 'APINex không trả về dữ liệu.' });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  res.on('close', () => {
    if (!res.writableEnded) void reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      res.write(Buffer.from(value));
    }
  } catch (error) {
    if (!res.destroyed) {
      console.error('Luồng APINex bị gián đoạn:', error instanceof Error ? error.message : 'lỗi không xác định');
      res.write(`data: ${JSON.stringify({ error: 'Luồng trả lời bị gián đoạn.' })}\n\n`);
    }
  } finally {
    reader.releaseLock();
    if (!res.writableEnded) res.end();
  }
});

app.use(express.static(webRoot, { index: false }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Không tìm thấy API.' });
    return;
  }
  res.sendFile(path.join(webRoot, 'index.html'), (error) => {
    if (error) next(error);
  });
});

app.use((error, _req, res, _next) => {
  console.error('Yêu cầu không hợp lệ:', error instanceof Error ? error.message : 'lỗi không xác định');
  if (res.headersSent) return;
  res.status(error?.status === 413 ? 413 : 400).json({
    error: error?.status === 413 ? 'Dữ liệu gửi lên quá lớn.' : 'Yêu cầu không hợp lệ.',
  });
});

const port = Number(process.env.API_PORT || process.env.PORT || 3000);
export const server = app.listen(port, '0.0.0.0', () => {
  console.info(`DeepSeek AI Chat đang chạy trên cổng ${port}.`);
});
