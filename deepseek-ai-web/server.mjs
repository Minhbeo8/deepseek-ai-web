import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

const API_URL = process.env.API_URL || 'https://motapis.com/v1/chat/completions';
const API_KEY = process.env.API_KEY || process.env.APINEX_API_KEY;

function getTextContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(getTextContent).filter(Boolean).join('');
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.message === 'string') return value.message;
    if (value.message && typeof value.message === 'object') return getTextContent(value.message);
    if (Array.isArray(value.content)) return getTextContent(value.content);
    if (value.answer !== undefined) return getTextContent(value.answer);
    if (value.result !== undefined) return getTextContent(value.result);
  }
  return '';
}

function getAssistantContent(data) {
  const choice = data?.choices?.[0];
  return getTextContent(
    choice?.message?.content ?? choice?.text ?? data?.message?.content ??
    data?.content ?? data?.answer ?? data?.result
  ).trim();
}

function getErrorMessage(data, fallback) {
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.error?.message === 'string') return data.error.message;
  if (typeof data?.message === 'string') return data.message;
  return fallback;
}

async function callModel(messages) {
  if (!API_KEY) {
    const error = new Error('Máy chủ chưa được cấu hình API_KEY.');
    error.status = 500;
    throw error;
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
    const error = new Error(getErrorMessage(data, `Lỗi từ API (HTTP ${response.status})`));
    error.status = response.status;
    throw error;
  }

  const content = getAssistantContent(data);
  if (!content) {
    const error = new Error('API không trả về nội dung câu trả lời hợp lệ.');
    error.status = 502;
    throw error;
  }
  return content;
}

async function readLimitedRequest(req, limit) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > limit) {
    const error = new Error('Dữ liệu tải lên vượt giới hạn cho phép.');
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('Dữ liệu tải lên vượt giới hạn cho phép.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim();
  if (!boundary || boundary.length > 200) {
    const error = new Error('Boundary multipart/form-data không hợp lệ.');
    error.status = 400;
    throw error;
  }

  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const fields = {};
  let file = null;
  let cursor = buffer.indexOf(marker);

  if (cursor < 0) {
    const error = new Error('Không tìm thấy dữ liệu multipart hợp lệ.');
    error.status = 400;
    throw error;
  }

  cursor += marker.length;
  while (cursor < buffer.length) {
    if (buffer.subarray(cursor, cursor + 2).toString() === '--') break;
    if (buffer.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;

    const headerEnd = buffer.indexOf(separator, cursor);
    if (headerEnd < 0) break;
    const headerText = buffer.subarray(cursor, headerEnd).toString('utf8');
    const contentStart = headerEnd + separator.length;
    const partEnd = buffer.indexOf(delimiter, contentStart);
    if (partEnd < 0) break;

    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const fieldName = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
    const fileName = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
    const part = buffer.subarray(contentStart, partEnd);

    if (fieldName && fileName !== undefined) {
      if (fieldName === 'file') {
        file = {
          originalName: path.basename(fileName.replace(/\\/g, '/')).slice(0, 180) || 'upload.bin',
          mimeType: headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream',
          buffer: part,
        };
      }
    } else if (fieldName) {
      fields[fieldName] = part.toString('utf8').slice(0, 2000);
    }

    cursor = partEnd + 2 + marker.length;
  }

  if (!file || file.buffer.length === 0) {
    const error = new Error('Vui lòng chọn một tệp không rỗng để phân tích.');
    error.status = 400;
    throw error;
  }
  if (file.buffer.length > MAX_UPLOAD_BYTES) {
    const error = new Error(`Tệp vượt giới hạn ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    error.status = 413;
    throw error;
  }
  return { file, fields };
}

function inspectFile(file) {
  const bytes = file.buffer;
  const starts = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  let format = 'Không xác định / dữ liệu nhị phân';
  let category = 'binary';
  let details = {};

  if (starts(0x1b, 0x4c, 0x75, 0x61)) {
    format = 'Lua bytecode';
    category = 'lua-bytecode';
    const versionByte = bytes[4];
    const versions = { 0x51: '5.1', 0x52: '5.2', 0x53: '5.3', 0x54: '5.4', 0x55: '5.5' };
    details.lua = {
      signature: '1B 4C 75 61 (\\x1bLua)',
      version: versions[versionByte] || `Không nhận diện (0x${(versionByte || 0).toString(16).padStart(2, '0')})`,
      versionByte: versionByte ?? null,
      formatByte: bytes[5] ?? null,
      headerHex: bytes.subarray(0, 32).toString('hex').match(/.{1,2}/g)?.join(' ') || '',
      decompiler: 'Chưa có decompiler Lua được tích hợp; không tự dựng source từ bytecode.',
    };
  } else if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) {
    format = 'PDF'; category = 'document';
  } else if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08)) {
    format = 'ZIP container (có thể là DOCX/JAR/ZIP)'; category = 'archive';
  } else if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    format = 'PNG image'; category = 'image';
  } else if (starts(0xff, 0xd8, 0xff)) {
    format = 'JPEG image'; category = 'image';
  } else if (starts(0x47, 0x49, 0x46, 0x38)) {
    format = 'GIF image'; category = 'image';
  } else if (starts(0x7f, 0x45, 0x4c, 0x46)) {
    format = 'ELF executable/object'; category = 'executable';
  } else if (starts(0x4d, 0x5a)) {
    format = 'Windows PE/DOS executable candidate (MZ)'; category = 'executable';
  } else if (starts(0x00, 0x61, 0x73, 0x6d)) {
    format = 'WebAssembly module'; category = 'executable';
  } else if (starts(0x52, 0x61, 0x72, 0x21)) {
    format = 'RAR archive'; category = 'archive';
  } else if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) {
    format = '7-Zip archive'; category = 'archive';
  }

  const previewLength = Math.min(bytes.length, 256);
  const hexPreview = Array.from(bytes.subarray(0, previewLength), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
  const asciiPreview = Array.from(bytes.subarray(0, Math.min(bytes.length, 128)), (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');

  return {
    name: file.originalName,
    declaredMimeType: file.mimeType,
    detectedFormat: format,
    category,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    headerHex: Array.from(bytes.subarray(0, Math.min(bytes.length, 32)), (byte) => byte.toString(16).padStart(2, '0')).join(' '),
    hexPreview,
    asciiPreview,
    lua: details.lua || null,
    safetyNote: 'Tệp được phân tích tĩnh như bytes; máy chủ không thực thi tệp và không tải lên thư mục lưu trữ.',
    sourceReconstruction: category === 'lua-bytecode'
      ? 'Không khả dụng: chỉ nhận diện header Lua; custom VM, bytecode đã bảo vệ hoặc phiên bản không hỗ trợ cần công cụ chuyên biệt.'
      : 'Không áp dụng hoặc chưa có decompiler cho định dạng này.',
  };
}

function writeSse(res, content) {
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
}

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Tin nhắn không hợp lệ' } });
    }
    const content = await callModel(messages);
    return writeSse(res, content);
  } catch (error) {
    console.error('Lỗi khi gọi API:', error);
    if (res.headersSent) return res.end();
    return res.status(error.status || 500).json({ error: { message: error.message || 'Lỗi kết nối máy chủ nội bộ' } });
  }
});

// Binary upload performs static inspection only: uploaded bytes are never executed or persisted.
app.post('/api/analyze-file', async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return res.status(415).json({ error: { message: 'Yêu cầu multipart/form-data.' } });
    }

    const body = await readLimitedRequest(req, MAX_MULTIPART_BYTES);
    const { file, fields } = parseMultipart(body, contentType);
    const inspection = inspectFile(file);
    const userPrompt = (fields.prompt || 'Phân tích tệp này.').trim().slice(0, 1500);

    const analysisPrompt = [
      'Bạn là trợ lý phân tích tệp theo hướng tĩnh và an toàn. Chỉ dựa trên metadata và byte preview dưới đây; không khẳng định đã chạy tệp, giải mã toàn bộ, hoặc tái dựng source nếu không có bằng chứng/công cụ phù hợp.',
      'Nếu là Lua bytecode, giải thích ý nghĩa header đã nhận diện và giới hạn: hiện không có decompiler tích hợp; không bịa source. Nếu là định dạng thực thi, chỉ mô tả định dạng/signature, không hướng dẫn thực thi.',
      `Yêu cầu: ${userPrompt}`,
      `Kết quả File Inspector: ${JSON.stringify({ ...inspection, hexPreview: inspection.hexPreview.slice(0, 768) })}`,
    ].join('\n\n');

    const explanation = await callModel([
      { role: 'system', content: 'Phân tích chính xác, phân biệt rõ dữ kiện đã kiểm tra và suy luận. Trả lời bằng tiếng Việt.' },
      { role: 'user', content: analysisPrompt },
    ]);

    return res.json({ inspection, explanation });
  } catch (error) {
    console.error('Lỗi phân tích tệp:', error);
    return res.status(error.status || 500).json({
      error: { message: error.message || 'Không thể phân tích tệp.' },
    });
  }
});

app.get('/binary-analyzer', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist/public/binary-analyzer.html'));
});

app.use(express.static(path.join(__dirname, 'dist/public')));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/public/index.html'));
});

app.listen(PORT, () => {
  console.log(`DeepSeek AI Chat đang chạy trên cổng ${PORT}`);
});
