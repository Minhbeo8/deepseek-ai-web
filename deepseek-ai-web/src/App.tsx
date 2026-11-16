
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  ChangeEvent,
  FormEvent,
  ReactNode,
} from 'react';

import {
  Check,
  Copy,
  FileText,
  Menu,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';

import {
  getDocument,
  GlobalWorkerOptions,
} from 'pdfjs-dist';

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import mammoth from 'mammoth';

import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

import NotFound from '@/pages/not-found';

import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

// ==========================================
// TYPES
// ==========================================

type ChatAttachment = {
  name: string;
  size: number;
};

type PendingAttachment = ChatAttachment & {
  id: string;
  text: string;
};

type ApiChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  displayContent?: string;
  attachments?: ChatAttachment[];
  streaming?: boolean;
  error?: boolean;
  streamId?: string;
};

type SavedChat = {
  id: string;
  title: string;
  messages: ChatMessage[];
};

// ==========================================
// CONFIGURATION
// ==========================================

const STORAGE_KEY = 'deepseek_ai_chats_v1';

const MAX_FILES = 3;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 100_000;

const TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xml',
  'html',
  'htm',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'py',
  'java',
  'go',
  'rs',
  'sql',
  'yaml',
  'yml',
  'toml',
  'log',
  'sh',
  'bash',
  'c',
  'cpp',
  'h',
  'hpp',
  'php',
  'rb',
  'swift',
  'kt',
  'lua',
  'dockerfile',
  'env',
  'ini',
]);

const suggestions = [
  {
    label: 'Giải thích một khái niệm',
    prompt: 'Giải thích một khái niệm khó theo cách dễ hiểu.',
  },
  {
    label: 'Viết code',
    prompt: 'Giúp tôi viết một đoạn code JavaScript đơn giản.',
  },
  {
    label: 'Lập kế hoạch',
    prompt: 'Lập kế hoạch học tập hiệu quả cho tôi.',
  },
];

// ==========================================
// UTILITIES
// ==========================================

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now());
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeTextContent(item))
      .filter(Boolean)
      .join('');
  }

  if (value && typeof value === 'object') {
    if (typeof (value as { text?: unknown }).text === 'string') {
      return normalizeTextContent((value as { text: unknown }).text);
    }

    if (typeof (value as { content?: unknown }).content === 'string') {
      return normalizeTextContent((value as { content: unknown }).content);
    }

    if (typeof (value as { message?: unknown }).message === 'string') {
      return normalizeTextContent((value as { message: unknown }).message);
    }

    if ((value as { message?: unknown }).message && typeof (value as { message: unknown }).message === 'object') {
      return normalizeTextContent((value as { message: unknown }).message);
    }

    if (Array.isArray((value as { content?: unknown }).content)) {
      return normalizeTextContent((value as { content: unknown }).content);
    }

    if ('answer' in value) {
      return normalizeTextContent((value as { answer?: unknown }).answer);
    }

    if ('result' in value) {
      return normalizeTextContent((value as { result?: unknown }).result);
    }

    return Object.values(value)
      .map((item) => normalizeTextContent(item))
      .filter(Boolean)
      .join(' ');
  }

  return value == null ? '' : String(value);
}

// ==========================================
// FILE EXTRACTION
// ==========================================

async function extractPdfText(file: File): Promise<string> {
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const document = await getDocument({
    data: await file.arrayBuffer(),
  }).promise;

  const pages: string[] = [];

  for (
    let pageNumber = 1;
    pageNumber <= document.numPages;
    pageNumber++
  ) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
    );

    if (pages.join('\n').length >= MAX_EXTRACTED_CHARS) {
      break;
    }
  }

  return pages.join('\n').trim();
}

async function extractFileText(file: File): Promise<string> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`${file.name} vượt quá giới hạn 5 MB.`);
  }

  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  if (
    extension === 'pdf' ||
    file.type === 'application/pdf'
  ) {
    return extractPdfText(file);
  }

  if (
    extension === 'docx' ||
    file.type ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });

    return result.value.trim();
  }

  if (
    TEXT_FILE_EXTENSIONS.has(extension) ||
    file.type.startsWith('text/')
  ) {
    return (await file.text()).trim();
  }

  throw new Error(
    `Chưa hỗ trợ tệp ${file.name}. Hãy chọn PDF, DOCX hoặc tệp văn bản.`
  );
}

// ==========================================
// CHAT STORAGE
// ==========================================

function loadChats(): SavedChat[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || '[]'
    );

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (chat): chat is SavedChat =>
          Boolean(
            chat &&
              typeof chat.id === 'string' &&
              typeof chat.title === 'string' &&
              Array.isArray(chat.messages)
          )
      )
      .map((chat) => ({
        id: chat.id,
        title: chat.title,

        messages: chat.messages
          .filter(
            (message: ChatMessage) =>
              message &&
              (message.role === 'user' ||
                message.role === 'assistant') &&
              typeof message.content === 'string'
          )
          .map((message: ChatMessage) => ({
            role: message.role,
            content: normalizeTextContent(message.content),

            ...(typeof message.displayContent === 'string'
              ? { displayContent: message.displayContent }
              : {}),

            ...(Array.isArray(message.attachments)
              ? {
                  attachments: message.attachments
                    .filter(
                      (file) =>
                        file &&
                        typeof file.name === 'string' &&
                        typeof file.size === 'number'
                    )
                    .map(({ name, size }) => ({
                      name,
                      size,
                    })),
                }
              : {}),
          })),
      }));
  } catch {
    return [];
  }
}

function cleanForStorage(chats: SavedChat[]) {
  return chats.map(({ id, title, messages }) => ({
    id,
    title,

    messages: messages
      .filter((message) => !message.streaming)
      .map(
        ({
          role,
          content,
          displayContent,
          attachments,
        }) => ({
          role,
          content: normalizeTextContent(content),

          ...(displayContent
            ? { displayContent }
            : {}),

          ...(attachments?.length
            ? { attachments }
            : {}),
        })
      ),
  }));
}

// ==========================================
// INLINE MARKDOWN
// ==========================================

function InlineText({ text }: { text: string }) {
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|https?:\/\/[^\s<]+)/g;

  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, index) => {
        if (
          part.startsWith('`') &&
          part.endsWith('`')
        ) {
          return (
            <code key={index}>
              {part.slice(1, -1)}
            </code>
          );
        }

        if (
          (part.startsWith('**') && part.endsWith('**')) ||
          (part.startsWith('__') && part.endsWith('__'))
        ) {
          return (
            <strong key={index}>
              {part.slice(2, -2)}
            </strong>
          );
        }

        if (
          (part.startsWith('*') && part.endsWith('*')) ||
          (part.startsWith('_') && part.endsWith('_'))
        ) {
          return (
            <em key={index}>
              {part.slice(1, -1)}
            </em>
          );
        }

        if (/^https?:\/\//.test(part)) {
          return (
            <a
              key={index}
              href={part}
              target="_blank"
              rel="noreferrer"
              className="text-lime-200 underline decoration-lime-200/40 underline-offset-2"
            >
              {part}
            </a>
          );
        }

        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

// ==========================================
// MARKDOWN RENDERER
// ==========================================

function Markdown({
  text,
  onCopy,
}: {
  text: string;
  onCopy: (value: string) => void;
}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const blocks: ReactNode[] = [];

  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();

      const code: string[] = [];

      index++;

      while (
        index < lines.length &&
        !lines[index].trim().startsWith('```')
      ) {
        code.push(lines[index]);
        index++;
      }

      if (index < lines.length) {
        index++;
      }

      const value = code.join('\n');

      blocks.push(
        <pre
          key={key++}
          data-language={language || undefined}
        >
          <code>{value}</code>

          <button
            className="code-copy"
            onClick={() => onCopy(value)}
            data-testid="button-copy-code"
          >
            <Copy size={12} />
            Sao chép code
          </button>
        </pre>
      );

      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);

    if (heading) {
      const Tag = `h${heading[1].length}` as
        | 'h1'
        | 'h2'
        | 'h3';

      blocks.push(
        <Tag key={key++}>
          <InlineText text={heading[2]} />
        </Tag>
      );

      index++;
      continue;
    }

    if (/^\s*[-+]\s+/.test(line)) {
      const items: string[] = [];

      while (
        index < lines.length &&
        /^\s*[-+]\s+/.test(lines[index])
      ) {
        items.push(
          lines[index++].replace(/^\s*[-+]\s+/, '')
        );
      }

      blocks.push(
        <ul key={key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <InlineText text={item} />
            </li>
          ))}
        </ul>
      );

      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];

      while (
        index < lines.length &&
        /^\s*\d+\.\s+/.test(lines[index])
      ) {
        items.push(
          lines[index++].replace(/^\s*\d+\.\s+/, '')
        );
      }

      blocks.push(
        <ol key={key++}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <InlineText text={item} />
            </li>
          ))}
        </ol>
      );

      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];

      while (
        index < lines.length &&
        /^\s*>\s?/.test(lines[index])
      ) {
        quote.push(
          lines[index++].replace(/^\s*>\s?/, '')
        );
      }

      blocks.push(
        <blockquote key={key++}>
          <InlineText text={quote.join(' ')} />
        </blockquote>
      );

      continue;
    }

    const paragraph = [line];

    index++;

    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,3}\s|```|\s*[-+]\s+|\s*\d+\.\s+|\s*>)/.test(
        lines[index]
      )
    ) {
      paragraph.push(lines[index++]);
    }

    blocks.push(
      <p key={key++}>
        {paragraph.map((part, partIndex) => (
          <span key={partIndex}>
            {partIndex > 0 && <br />}
            <InlineText text={part} />
          </span>
        ))}
      </p>
    );
  }

  return <>{blocks}</>;
}

// ==========================================
// HOME COMPONENT
// ==========================================

function Home() {
  const initialChats = useMemo(() => loadChats(), []);

  const [chats, setChats] = useState<SavedChat[]>(initialChats);

  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  const [activeId, setActiveId] = useState<string | null>(
    initialChats[0]?.id ?? null
  );

  const [draft, setDraft] = useState('');

  const [attachments, setAttachments] = useState<
    PendingAttachment[]
  >([]);

  const [readingFiles, setReadingFiles] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const [errorMessage, setErrorMessage] = useState<string | null>(
    null
  );

  const [modelName, setModelName] = useState('DeepSeek');
  const [configLoading, setConfigLoading] = useState(true);

  const [healthError, setHealthError] = useState(false);
  const [healthLoading, setHealthLoading] = useState(true);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const controllerRef = useRef<AbortController | null>(null);

  const activeChat =
    chats.find((chat) => chat.id === activeId) ?? null;

  useEffect(() => {
    let cancelled = false;

    fetch('/api/config')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Không tải được cấu hình mô hình.');
        }

        return response.json() as Promise<{
          model?: string;
        }>;
      })
      .then((config) => {
        if (!cancelled && config.model) {
          setModelName(config.model);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelName('DeepSeek');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setConfigLoading(false);
        }
      });

    fetch('/api/healthz')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Máy chủ không hoạt động.');
        }

        if (!cancelled) {
          setHealthError(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealthError(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHealthLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);

    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }

    toastTimer.current = setTimeout(() => {
      setToast('');
    }, 2300);
  }, []);

  const commitChats = useCallback(
    (
      next:
        | SavedChat[]
        | ((previous: SavedChat[]) => SavedChat[])
    ) => {
      const updated =
        typeof next === 'function'
          ? next(chatsRef.current)
          : next;

      chatsRef.current = updated;
      setChats(updated);

      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(cleanForStorage(updated))
        );
      } catch {
        notify('Không đủ dung lượng lưu lịch sử trên trình duyệt.');
      }
    },
    [notify]
  );

  useEffect(() => {
    if (!activeId && chats.length) {
      setActiveId(chats[0].id);
    }
  }, [activeId, chats]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop =
        scrollRef.current.scrollHeight;
    }
  }, [
    activeChat?.messages.length,
    activeChat?.messages.at(-1)?.content,
  ]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
      }
    };
  }, []);

  const createChat = useCallback(() => {
    const chat = {
      id: newId(),
      title: 'Cuộc trò chuyện mới',
      messages: [],
    };

    commitChats((previous) => [chat, ...previous]);

    setActiveId(chat.id);
    setErrorMessage(null);
    setSidebarOpen(false);
    setDraft('');
    setAttachments([]);

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [commitChats]);

  const copyText = useCallback(
    async (
      value: string,
      label = 'Đã sao chép câu trả lời.'
    ) => {
      try {
        await navigator.clipboard.writeText(value);

        notify(label);

        setCopied(value);

        setTimeout(() => {
          setCopied(null);
        }, 1400);
      } catch {
        notify('Trình duyệt không cho phép sao chép.');
      }
    },
    [notify]
  );

  const streamReply = useCallback(
    async (chatId: string, assistant: ChatMessage) => {
      const chat = chatsRef.current.find(
        (item) => item.id === chatId
      );

      if (!chat) {
        throw new Error('Không tìm thấy cuộc trò chuyện.');
      }

      const messages: ApiChatMessage[] = chat.messages
        .filter(
          (message) =>
            !message.streaming && !message.error
        )
        .map(({ role, content }) => ({
          role,
          content: normalizeTextContent(content),
        }));

      const controller = new AbortController();
      controllerRef.current = controller;

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          messages,
        }),
      });

      if (!response.ok) {
        let message = `Lỗi HTTP ${response.status}`;

        const responseText = await response.text();

        if (responseText) {
          try {
            const payload = JSON.parse(responseText);

            if (typeof payload === 'string') {
              message = payload;
            } else if (payload?.error?.message) {
              message = payload.error.message;
            } else if (payload?.message) {
              message = payload.message;
            } else if (payload?.error) {
              message =
                typeof payload.error === 'string'
                  ? payload.error
                  : JSON.stringify(payload.error);
            }
          } catch {
            message = responseText;
          }
        }

        throw new Error(message);
      }

      if (!response.body) {
        throw new Error('Trình duyệt không hỗ trợ streaming.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const consumeLine = (line: string) => {
        if (!line.startsWith('data:')) {
          return;
        }

        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          return;
        }

        let payload: {
          error?: unknown;
          choices?: Array<{
            delta?: {
              content?: unknown;
            };
          }>;
        };

        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }

        if (payload.error) {
          const errStr =
            typeof payload.error === 'string'
              ? payload.error
              : payload.error && typeof payload.error === 'object' && 'message' in payload.error && typeof (payload.error as { message?: unknown }).message === 'string'
                ? (payload.error as { message: string }).message
                : JSON.stringify(payload.error);

          throw new Error(errStr);
        }

        const rawDelta = payload.choices?.[0]?.delta?.content;
        const delta = normalizeTextContent(rawDelta);

        if (delta) {
          assistant.content += delta;

          commitChats((previous) =>
            previous.map((item) =>
              item.id === chatId
                ? {
                    ...item,
                    messages: item.messages.map(
                      (message) =>
                        message.streamId === assistant.streamId
                          ? {
                              ...message,
                              content: normalizeTextContent(assistant.content),
                            }
                          : message
                    ),
                  }
                : item
            )
          );
        }
      };

      try {
        let done = false;

        while (!done) {
          const result = await reader.read();
          done = result.done;

          buffer += decoder.decode(result.value, {
            stream: !done,
          });

          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          lines.forEach(consumeLine);
        }

        if (buffer.trim()) {
          consumeLine(buffer.trim());
        }
      } finally {
        reader.releaseLock();
      }
    },
    [commitChats]
  );

  const runGeneration = useCallback(
    async (chatId: string, assistant: ChatMessage) => {
      setGenerating(true);
      setErrorMessage(null);

      try {
        await streamReply(chatId, assistant);

        assistant.streaming = false;
        assistant.content = normalizeTextContent(assistant.content);

        if (!assistant.content) {
          assistant.content = '(AI không trả về nội dung.)';
        }
      } catch (error) {
        assistant.streaming = false;
        assistant.error = true;

        let message = 'Lỗi không xác định';

        if (error instanceof Error) {
          message = error.message;
        } else if (
          typeof error === 'object' &&
          error !== null
        ) {
          message = JSON.stringify(error);
        } else {
          message = String(error);
        }

        try {
          const parsed = JSON.parse(message);

          if (parsed?.error?.message) {
            message = parsed.error.message;
          } else if (parsed?.message) {
            message = parsed.message;
          } else if (parsed?.error) {
            message =
              typeof parsed.error === 'string'
                ? parsed.error
                : JSON.stringify(parsed.error);
          }
        } catch {
          // Not JSON
        }

        assistant.content =
          error instanceof DOMException &&
          error.name === 'AbortError'
            ? 'Đã dừng tạo câu trả lời.'
            : `Không thể nhận câu trả lời: ${normalizeTextContent(message)}`;

        setErrorMessage(message);
      } finally {
        controllerRef.current = null;
        setGenerating(false);

        commitChats((previous) =>
          previous.map((item) =>
            item.id === chatId
              ? {
                  ...item,
                  messages: item.messages.map(
                    (message) =>
                      message.streamId === assistant.streamId
                        ? {
                            ...assistant,
                            streaming: false,
                            content: normalizeTextContent(assistant.content),
                          }
                        : message
                  ),
                }
              : item
          )
        );
      }
    },
    [commitChats, streamReply]
  );

  const sendMessage = useCallback(
    async (
      rawText: string,
      attachedFiles: PendingAttachment[] = []
    ) => {
      const text = rawText.trim();

      if (
        (!text && !attachedFiles.length) ||
        generating ||
        readingFiles
      ) {
        return;
      }

      const displayText =
        text || 'Hãy đọc và phân tích tệp đính kèm.';

      let remainingChars = MAX_EXTRACTED_CHARS;

      const fileContext = attachedFiles
        .map((file) => {
          const extractedText = file.text.slice(
            0,
            remainingChars
          );

          remainingChars -= extractedText.length;

          return (
            `\n\n--- Nội dung tệp: ${file.name} ---\n` +
            extractedText
          );
        })
        .join('');

      const messageContent =
        normalizeTextContent(
          displayText.slice(
            0,
            Math.max(0, 120_000 - fileContext.length)
          ) + fileContext
        );

      let chat = chatsRef.current.find(
        (item) => item.id === activeId
      );

      if (!chat) {
        chat = {
          id: newId(),
          title: 'Cuộc trò chuyện mới',
          messages: [],
        };

        setActiveId(chat.id);
        commitChats((previous) => [chat!, ...previous]);
      }

      const chatId = chat.id;

      const firstUserMessage = !chat.messages.some(
        (message) => message.role === 'user'
      );

      const assistant: ChatMessage = {
        role: 'assistant',
        content: '',
        streaming: true,
        streamId: newId(),
      };

      const userMessage: ChatMessage = {
        role: 'user',
        content: messageContent,
        displayContent: displayText,

        ...(attachedFiles.length
          ? {
              attachments: attachedFiles.map(
                ({ name, size }) => ({
                  name,
                  size,
                })
              ),
            }
          : {}),
      };

      commitChats((previous) =>
        previous.map((item) =>
          item.id === chatId
            ? {
                ...item,
                title: firstUserMessage
                  ? displayText.slice(0, 42)
                  : item.title,
                messages: [
                  ...item.messages,
                  userMessage,
                  assistant,
                ],
              }
            : item
        )
      );

      setDraft('');
      setAttachments([]);

      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
      }

      await runGeneration(chatId, assistant);
    },
    [
      activeId,
      commitChats,
      generating,
      readingFiles,
      runGeneration,
    ]
  );

  const retryMessage = useCallback(
    async (messageIndex: number) => {
      const chat = chatsRef.current.find(
        (item) => item.id === activeId
      );

      if (!chat || generating) {
        return;
      }

      let userIndex = messageIndex - 1;

      while (
        userIndex >= 0 &&
        chat.messages[userIndex].role !== 'user'
      ) {
        userIndex--;
      }

      if (userIndex < 0) {
        return;
      }

      const retained = chat.messages.slice(
        0,
        userIndex + 1
      );

      const assistant: ChatMessage = {
        role: 'assistant',
        content: '',
        streaming: true,
        streamId: newId(),
      };

      commitChats((previous) =>
        previous.map((item) =>
          item.id === chat.id
            ? {
                ...item,
                messages: [...retained, assistant],
              }
            : item
        )
      );

      setErrorMessage(null);

      await runGeneration(chat.id, assistant);
    },
    [
      activeId,
      commitChats,
      generating,
      runGeneration,
    ]
  );

  const renameChat = (chat: SavedChat) => {
    const next = window.prompt(
      'Tên cuộc trò chuyện:',
      chat.title
    );

    if (next?.trim()) {
      commitChats((previous) =>
        previous.map((item) =>
          item.id === chat.id
            ? {
                ...item,
                title: next.trim().slice(0, 80),
              }
            : item
        )
      );
    }
  };

  const deleteChat = (chat: SavedChat) => {
    if (!window.confirm('Xóa cuộc trò chuyện này?')) {
      return;
    }

    const remaining = chatsRef.current.filter(
      (item) => item.id !== chat.id
    );

    commitChats(remaining);

    if (activeId === chat.id) {
      setActiveId(remaining[0]?.id ?? null);
    }

    setErrorMessage(null);
  };

  const handleSubmit = (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    void sendMessage(draft, attachments);
  };

  const handleInput = (
    event: ChangeEvent<HTMLTextAreaElement>
  ) => {
    setDraft(event.target.value);

    event.target.style.height = 'auto';
    event.target.style.height =
      `${Math.min(event.target.scrollHeight, 180)}px`;
  };

  const handleFilesSelected = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const selectedFiles = Array.from(
      event.target.files || []
    );

    event.target.value = '';

    if (!selectedFiles.length) {
      return;
    }

    const availableSlots = MAX_FILES - attachments.length;

    if (availableSlots <= 0) {
      notify(
        `Chỉ có thể đính kèm tối đa ${MAX_FILES} tệp.`
      );

      return;
    }

    const filesToRead = selectedFiles.slice(
      0,
      availableSlots
    );

    if (selectedFiles.length > availableSlots) {
      notify(`Đã chọn tối đa ${MAX_FILES} tệp.`);
    }

    setReadingFiles(true);

    const incoming: PendingAttachment[] = [];
    const issues: string[] = [];

    let extractedChars = attachments.reduce(
      (total, file) => total + file.text.length,
      0
    );

    for (const file of filesToRead) {
      try {
        const text = await extractFileText(file);

        if (!text) {
          issues.push(
            `${file.name} không có nội dung văn bản để đọc.`
          );

          continue;
        }

        const remaining =
          MAX_EXTRACTED_CHARS - extractedChars;

        if (remaining <= 0) {
          issues.push(
            'Tổng nội dung tệp đã vượt giới hạn. Hãy gỡ bớt tệp trước khi thêm.'
          );

          break;
        }

        const clippedText = text.slice(0, remaining);

        incoming.push({
          id: newId(),
          name: file.name,
          size: file.size,
          text: clippedText,
        });

        extractedChars += clippedText.length;

        if (clippedText.length < text.length) {
          issues.push(
            `${file.name} đã được rút gọn để vừa giới hạn nội dung.`
          );
        }
      } catch (error) {
        issues.push(
          error instanceof Error
            ? error.message
            : `Không thể đọc tệp ${file.name}.`
        );
      }
    }

    if (incoming.length) {
      setAttachments((current) => [
        ...current,
        ...incoming,
      ]);
    }

    if (issues.length) {
      notify(issues.slice(0, 2).join(' '));
    }

    setReadingFiles(false);
  };

  return (
    <div className="app-shell">
      <div
        className={`mobile-backdrop ${sidebarOpen ? 'show' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      <aside
        className={`sidebar ${sidebarOpen ? 'open' : ''}`}
        aria-label="Lịch sử trò chuyện"
      >
        <div className="sidebar-head">
          <div className="brand">
            <span
              className="brand-glyph"
              aria-hidden="true"
            >
              ✦
            </span>

            <span>DeepSeek AI</span>
          </div>

          <button
            className="icon-button mobile-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Đóng lịch sử"
            data-testid="button-close-sidebar"
          >
            <X size={19} />
          </button>
        </div>

        <button
          className="new-chat-button"
          onClick={createChat}
          data-testid="button-new-chat"
        >
          <MessageSquarePlus size={16} />
          <span>Cuộc trò chuyện mới</span>
        </button>

        <div className="history-label">
          LỊCH SỬ
        </div>

        <div
          className="history-list"
          data-testid="list-chat-history"
        >
          {chats.length === 0 && (
            <div className="sidebar-empty">
              Các cuộc trò chuyện của bạn sẽ xuất hiện tại đây.
            </div>
          )}

          {chats.map((chat) => (
            <div
              key={chat.id}
              className={`history-row ${
                chat.id === activeId ? 'active' : ''
              }`}
              data-testid={`row-chat-${chat.id}`}
            >
              <button
                className="history-select"
                onClick={() => {
                  setActiveId(chat.id);
                  setAttachments([]);
                  setErrorMessage(null);
                  setSidebarOpen(false);
                }}
                title={chat.title}
                data-testid={`button-select-chat-${chat.id}`}
              >
                {chat.title || 'Cuộc trò chuyện mới'}
              </button>

              <div className="history-actions">
                <button
                  className="icon-button"
                  onClick={() => renameChat(chat)}
                  aria-label={`Đổi tên ${chat.title}`}
                  title="Đổi tên"
                  data-testid={`button-rename-chat-${chat.id}`}
                >
                  <Pencil size={13} />
                </button>

                <button
                  className="icon-button"
                  onClick={() => deleteChat(chat)}
                  aria-label={`Xóa ${chat.title}`}
                  title="Xóa"
                  data-testid={`button-delete-chat-${chat.id}`}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="model-status">
            <span
              className={`status-dot ${
                healthError ? 'offline' : ''
              }`}
            />

            <span>
              {configLoading
                ? 'Đang tải mô hình…'
                : modelName}
            </span>
          </div>

          <div
            className="sidebar-note"
            data-testid="status-server-health"
          >
            {healthLoading
              ? 'Đang kết nối máy chủ'
              : healthError
                ? 'Không thể kết nối máy chủ'
                : 'Lịch sử được lưu trên thiết bị này'}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Mở lịch sử"
            data-testid="button-open-sidebar"
          >
            <Menu size={19} />
          </button>

          <div className="topbar-center">
            <div className="topbar-title">
              DeepSeek AI
            </div>

            <span className="model-caption">
              · {modelName}
            </span>
          </div>

          <div className="topbar-actions">
            <button
              className="icon-button"
              onClick={createChat}
              aria-label="Chat mới"
              title="Chat mới"
              data-testid="button-top-new-chat"
            >
              <Plus size={20} />
            </button>
          </div>
        </header>

        <section
          className="chat-scroll"
          ref={scrollRef}
          aria-label="Nội dung trò chuyện"
        >
          {(!activeChat ||
            activeChat.messages.length === 0) && (
            <div className="welcome">
              <div
                className="welcome-sigil"
                aria-hidden="true"
              >
                <span className="brand-glyph">
                  ✦
                </span>
              </div>

              <h1>
                Bạn muốn tìm hiểu điều gì?
              </h1>

              <p>
                Hỏi bất cứ điều gì, DeepSeek sẽ hỗ trợ bạn.
              </p>

              <div className="suggestions">
                {suggestions.map(({ label, prompt }) => (
                  <button
                    key={label}
                    className="suggestion"
                    onClick={() => {
                      setDraft(prompt);
                      inputRef.current?.focus();
                    }}
                    data-testid={`button-suggestion-${label}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!!activeChat?.messages.length && (
            <div
              className="messages"
              data-testid={`list-messages-${activeChat.id}`}
            >
              {activeChat.messages.map(
                (message, index) => (
                  <div
                    key={`${activeChat.id}-${index}-${message.role}`}
                    className={`message-row ${message.role}`}
                    data-testid={`message-${message.role}-${index}`}
                  >
                    <div
                      className={`message-content ${
                        message.streaming
                          ? 'typing-cursor'
                          : ''
                      } ${
                        message.error
                          ? 'message-error'
                          : ''
                      }`}
                    >
                      {message.role === 'assistant' ? (
                        <Markdown
                          text={normalizeTextContent(message.content)}
                          onCopy={(value) =>
                            void copyText(
                              value,
                              'Đã sao chép code.'
                            )
                          }
                        />
                      ) : (
                        <>
                          <span>
                            {normalizeTextContent(
                              message.displayContent ?? message.content
                            )}
                          </span>

                          {!!message.attachments?.length && (
                            <div className="message-attachments">
                              {message.attachments.map(
                                (file, fileIndex) => (
                                  <span
                                    className="message-attachment"
                                    key={`${file.name}-${fileIndex}`}
                                  >
                                    <FileText size={13} />
                                    {file.name}
                                  </span>
                                )
                              )}
                            </div>
                          )}
                        </>
                      )}

                      {message.role === 'assistant' &&
                        !message.streaming && (
                          <div className="message-tools">
                            <button
                              onClick={() =>
                                void copyText(normalizeTextContent(message.content))
                              }
                              data-testid={`button-copy-answer-${index}`}
                            >
                              {copied === normalizeTextContent(message.content) ? (
                                <Check size={13} />
                              ) : (
                                <Copy size={13} />
                              )}

                              Sao chép
                            </button>

                            <button
                              onClick={() =>
                                void retryMessage(index)
                              }
                              disabled={generating}
                              data-testid={`button-retry-answer-${index}`}
                            >
                              <RefreshCw size={13} />
                              Thử lại
                            </button>
                          </div>
                        )}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </section>

        <div className="composer-wrap">
          <form
            className="composer"
            onSubmit={handleSubmit}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.html,.htm,.js,.jsx,.ts,.tsx,.css,.scss,.py,.java,.go,.rs,.sql,.yaml,.yml,.toml,.log,.sh,.bash,.c,.cpp,.h,.hpp,.php,.rb,.swift,.kt,.lua,.dockerfile,.env,.ini"
              onChange={(event) =>
                void handleFilesSelected(event)
              }
              disabled={generating || readingFiles}
              aria-label="Chọn tệp để gửi cho DeepSeek"
            />

            {!!attachments.length && (
              <div
                className="pending-attachments"
                aria-label="Tệp đang đính kèm"
              >
                {attachments.map((file) => (
                  <div
                    className="pending-attachment"
                    key={file.id}
                  >
                    <FileText size={14} />

                    <span
                      className="pending-file-name"
                      title={file.name}
                    >
                      {file.name}
                    </span>

                    <small>
                      {formatFileSize(file.size)}
                    </small>

                    <button
                      type="button"
                      className="remove-attachment"
                      aria-label={`Gỡ ${file.name}`}
                      title="Gỡ tệp"
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter(
                            (item) => item.id !== file.id
                          )
                        )
                      }
                      disabled={generating}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              ref={inputRef}
              className="prompt-input"
              value={draft}
              onChange={handleInput}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={1}
              placeholder="Nhắn tin cho DeepSeek…"
              autoComplete="off"
              disabled={generating}
              aria-label="Tin nhắn của bạn"
              data-testid="input-chat-message"
            />

            <div className="composer-bottom">
              <div className="composer-controls">
                <button
                  className="attach-button"
                  type="button"
                  onClick={() =>
                    fileInputRef.current?.click()
                  }
                  disabled={
                    generating ||
                    readingFiles ||
                    attachments.length >= MAX_FILES
                  }
                  aria-label="Đính kèm tệp"
                  title="Đính kèm PDF, DOCX hoặc tệp văn bản (tối đa 3 tệp, 5 MB mỗi tệp)"
                  data-testid="button-attach-file"
                >
                  <Paperclip size={15} />

                  <span className="attach-label">
                    Đính kèm tệp
                  </span>
                </button>

                <span className="composer-hint">
                  {readingFiles
                    ? 'Đang đọc tệp…'
                    : `${modelName} · PDF, DOCX, văn bản`}
                </span>
              </div>

              <div className="composer-controls">
                <span className="composer-hint">
                  {attachments.length
                    ? `${attachments.length}/${MAX_FILES} tệp`
                    : 'Free Tier'}
                </span>

                <button
                  className="send-button"
                  type="submit"
                  disabled={
                    (!draft.trim() &&
                      !attachments.length) ||
                    generating ||
                    readingFiles
                  }
                  aria-label="Gửi tin nhắn"
                  data-testid="button-send-message"
                >
                  {generating ? (
                    <span aria-label="Đang tạo">
                      …
                    </span>
                  ) : readingFiles ? (
                    <span aria-label="Đang đọc tệp">
                      …
                    </span>
                  ) : (
                    <Send size={16} />
                  )}
                </button>
              </div>
            </div>
          </form>

          <div className="disclaimer">
            AI có thể mắc lỗi. Hãy kiểm tra thông tin quan trọng.
          </div>
        </div>
      </main>

      {errorMessage && (
        <div
          className="toast show"
          role="alert"
          data-testid="status-chat-error"
        >
          {`Không thể nhận câu trả lời: ${errorMessage}`}
        </div>
      )}

      <div
        className={`toast ${toast ? 'show' : ''}`}
        role="status"
        data-testid="status-toast"
      >
        {toast}
      </div>
    </div>
  );
}

function Router() {
  return (
    <ErrorBoundary resetKey={useLocation()[0]}>
      <Switch>
        <Route
          path="/"
          component={Home}
        />

        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter
        base={import.meta.env.BASE_URL.replace(/\/$/, '')}
      >
        <Router />
      </WouterRouter>

      <Toaster />
    </TooltipProvider>
  );
}

export default App;
