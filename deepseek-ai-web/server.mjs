import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

const API_URL = process.env.API_URL || "https://motapis.com/v1/chat/completions";
const API_KEY = process.env.API_KEY || process.env.APINEX_API_KEY;

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

    res.json(data);
  } catch (error) {
    console.error("Lỗi khi gọi API:", error);
    res.status(500).json({ error: { message: "Lỗi kết nối máy chủ nội bộ" } });
  }
});

app.listen(PORT, () => {
  console.log(`DeepSeek AI Chat đang chạy trên cổng ${PORT}`);
});
