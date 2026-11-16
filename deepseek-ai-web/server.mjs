import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cấu hình giới hạn payload và bật CORS
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

const API_URL = process.env.API_URL || 'https://motapis.com/v1/chat/completions';
const API_KEY = process.env.API_KEY || process.env.APINEX_API_KEY;

function getTextContent(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('');
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }

  return '';
}

function getAssistantContent(data) {
  const choice = data?.choices?.[0];

  return getTextContent(
    choice?.message?.content ??
    choice?.text ??
    data?.message?.content ??
    data?.content ??
    data?.answer ??
    data?.result
  );
}

function getErrorMessage(data, fallback) {
  const error = data?.error;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  if (typeof data?.message === 'string') return data.message;
  return fallback;
}

// API endpoint xử lý chat. Frontend đọc phản hồi theo định dạng SSE.
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Tin nhắn không hợp lệ' } });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: { message: 'Máy chủ chưa được cấu hình API_KEY.' } });
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages,
        // Provider được gọi non-stream; server chuyển kết quả thành SSE cho frontend.
        stream: false,
      }),
    });

    const responseText = await response.text();
    let data;

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = { message: responseText };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: { message: getErrorMessage(data, `Lỗi từ API (HTTP ${response.status})`) },
      });
    }

    const content = getAssistantContent(data);
    if (!content) {
      return res.status(502).json({
        error: { message: getErrorMessage(data, 'API không trả về nội dung câu trả lời hợp lệ.') },
      });
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const characters = [...content];
    for (let offset = 0; offset < characters.length; offset += 80) {
      const delta = characters.slice(offset, offset + 80).join('');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Lỗi khi gọi API:', error);

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(500).json({ error: { message: 'Lỗi kết nối máy chủ nội bộ' } });
  }
});

// Phục vụ giao diện frontend (Vite build)
app.use(express.static(path.join(__dirname, 'dist/public')));

// Dùng biểu thức chính quy (Regex) thay cho dấu '*' để tương thích với Express phiên bản mới
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/public/index.html'));
});

app.listen(PORT, () => {
  console.log(`DeepSeek AI Chat đang chạy trên cổng ${PORT}`);
});
