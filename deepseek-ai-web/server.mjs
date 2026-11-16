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

const API_URL = process.env.API_URL || "https://motapis.com/v1/chat/completions";
const API_KEY = process.env.API_KEY || process.env.APINEX_API_KEY;

function normalizeChatCompletion(data) {
  const choice = data?.choices?.[0];

  const messageContent =
    choice?.message?.content ??
    choice?.text ??
    data?.message?.content ??
    data?.content ??
    data?.answer ??
    data?.result ??
    '';

  return {
    id: data?.id || 'chatcmpl-local',
    object: 'chat.completion',
    created: Date.now(),
    model: data?.model || 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: typeof messageContent === 'string'
            ? messageContent
            : JSON.stringify(messageContent ?? ''),
        },
      },
    ],
    usage: data?.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

// API endpoint xử lý chat
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: "Tin nhắn không hợp lệ" } });
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: messages,
        stream: false
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const normalized = normalizeChatCompletion(data);
    res.json(normalized);
  } catch (error) {
    console.error("Lỗi khi gọi API:", error);
    res.status(500).json({ error: { message: "Lỗi kết nối máy chủ nội bộ" } });
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
