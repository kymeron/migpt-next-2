import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

function isXiaoAIAnswerFailure(text) {
  return /(?:我(?:还|暂时|暂不|也)?(?:不知道|不知道咋说|不太清楚|不支持|不会|回答不上)|不太清楚|无法(?:回答|理解|获取|处理)|没法回答|回答不了|没听懂|不明白.{0,8}(?:说|意思)|换个问题|我还在学习|(?:你|我).{0,4}(?:问住|难住)了|被难住了(?:诶|呢|呀|哦)?|暂不支持(?:该|此)?功能|不知道咋说|还.{0,4}(?:支持.{0,6}功能|学习)|不如换.{0,6}(?:方式|问题|说)|超出.{0,6}(?:能力|范围)|(?:没有|无法)找到.{0,8}(?:答案|结果|内容)|(?:暂时|还)回答不)/i.test(
    text,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 单段 TTS 文本的默认上限（L05B 对单次 TTS 文本长度有限制） */
const kDefaultMaxTextLength = 100;

/**
 * 等待小爱原生播报真正停止。
 *
 * 小爱刚生成的兜底回答往往在对话记录出现后才开始播放，
 * 此时立即下发新的 TTS 指令会被设备丢弃（接口返回成功但没有声音）。
 */
async function waitForPlaybackIdle(engine, timeout = 700) {
  const MiNA = engine.MiNA;
  if (!MiNA?.getStatus) {
    return;
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await MiNA.getStatus().catch(() => undefined);
    if (!status || status.status !== 'playing') {
      return;
    }
    await sleep(150);
  }
}

/** 按长度和标点切分文本，避免单次 TTS 过长导致播报失败 */
function splitText(text, maxLength = kDefaultMaxTextLength) {
  const limit = Math.max(1, maxLength);
  const chunks = [];
  let rest = String(text).trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const matched = window.match(/[\s\S]*[。！？；：，,.!?;:、\n]/);
    const index = matched ? matched[0].length : limit;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks.filter(Boolean);
}

/**
 * 按段落播报文本：先走 MIoT「播放文本」，失败时回退 MiNA TTS，并记录失败原因。
 *
 * MIoT 指令失败时 doAction 只会返回 false，不做日志会表现为「完全没有声音」。
 *
 * @param {object} [options]
 * @param {number} [options.maxLength] 单段文本上限
 * @param {number} [options.retries] 单段最多尝试次数（占位提示设为 1，避免失败时白等）
 * @param {number} [options.gap] 重试间隔与段间间隔（毫秒）
 */
async function playText(engine, text, options = {}) {
  const { maxLength = kDefaultMaxTextLength, retries = 2, gap = 200 } = options;
  const chunks = splitText(text, maxLength);
  for (const chunk of chunks) {
    let played = false;
    for (let attempt = 0; attempt < Math.max(1, retries) && !played; attempt++) {
      if (attempt > 0) {
        await sleep(gap || 500);
      }
      if (engine.MiOT?.doAction) {
        try {
          played = await engine.MiOT.doAction(5, 3, chunk);
          if (!played) {
            console.warn(`⚠️ MIoT 播放文本失败：${chunk}`);
          }
        } catch (error) {
          console.warn(`⚠️ MIoT 播放文本异常：${error?.message ?? error}`);
        }
      }
      if (!played && engine.speaker?.play) {
        try {
          played = await engine.speaker.play({ text: chunk });
          if (!played) {
            console.warn(`⚠️ MiNA TTS 播放失败：${chunk}`);
          }
        } catch (error) {
          console.warn(`⚠️ MiNA TTS 播放异常：${error?.message ?? error}`);
        }
      }
    }
    if (!played) {
      console.warn(`❌ 语音播报最终失败：${chunk}`);
    }
    // 连续下发指令时留出间隔，避免后一条覆盖前一条
    if (gap > 0) {
      await sleep(gap);
    }
  }
  return chunks.length > 0;
}

/**
 * 读取环境变量，未设置时使用占位符。
 *
 * 真实凭证请写在本地 `.env`（已被 .gitignore 忽略），不要把密钥提交进仓库。
 */
function env(key, fallback = '') {
  return process.env[key]?.trim() || fallback;
}

/** MiniMax 语音合成默认参数（未填写的字段会回落到这里） */
const kDefaultTTSConfig = {
  enabled: true,
  provider: 'minimax',
  model: 'speech-2.8-turbo',
  /** 音色 ID，可在 MiniMax 控制台「音色管理」查看 */
  voiceId: 'male-qn-qingse',
  speed: 1,
  vol: 1,
  pitch: 0,
  sampleRate: 32000,
  bitrate: 128000,
  format: 'mp3',
  /** 留空则复用 openai.baseURL / openai.apiKey */
  baseURL: '',
  apiKey: '',
  /**
   * 小爱访问不到局域网地址时（比如跨网段/走公网），填本机对外可访问的地址
   * 例：https://tts.example.com（需把该地址反向代理到本机 port）
   */
  publicBaseURL: '',
  /** 本地音频服务端口 */
  port: 17890,
  /** 合成超时时间（毫秒） */
  timeout: 20000,
  /** 最多保留的音频文件数 */
  keepFiles: 20,
};

const kContentType = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/wave',
  flac: 'audio/flac',
};

/**
 * 解析当前使用的语音来源。
 *
 * - `minimax`：MiniMax 合成后再播放（音色自然，约 1.5-2s 出声）
 * - `xiaoai`：小爱原生 TTS 直接播文本（约 0.6s 出声，音色机械）
 *
 * 兼容旧配置：`tts.enabled === false` 等价于 `xiaoai`。
 */
function resolveTTSProvider(tts) {
  if (tts?.enabled === false) {
    return 'xiaoai';
  }
  const provider = String(tts?.provider ?? 'minimax').toLowerCase();
  return provider === 'xiaoai' ? 'xiaoai' : 'minimax';
}

/** 去掉 Markdown / 链接等不该被念出来的内容 */
function toSpeakableText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[\d+\]/g, '')
    .replace(/[*_`~#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLocalIPv4() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) {
        return item.address;
      }
    }
  }
  return '127.0.0.1';
}

let ttsServer;
let ttsDir = '';

/**
 * 启动本地音频服务：小爱只能播放 URL，合成出来的音频需要先托管出去。
 * 返回音频文件对外可访问的 baseURL（优先级：publicBaseURL > 局域网 IP）。
 */
async function ensureTTSBaseURL(tts) {
  if (!ttsServer) {
    ttsDir = await mkdtemp(join(tmpdir(), 'migpt-tts-'));
    const contentType = kContentType[tts.format] ?? 'audio/mpeg';
    ttsServer = createServer(async (req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const name = pathname.replace(/^\/tts\//, '');
      if (!name || !/^[\w.-]+$/.test(name)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const file = join(ttsDir, name);
      try {
        const info = await stat(file);
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (range) {
          const start = Number(range[1] || 0);
          const end = range[2] ? Number(range[2]) : info.size - 1;
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Accept-Ranges': 'bytes',
          });
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': info.size,
          'Accept-Ranges': 'bytes',
        });
        createReadStream(file).pipe(res);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve, reject) => {
      ttsServer.once('error', reject);
      ttsServer.listen(tts.port, '0.0.0.0', () => resolve());
    });
    const port = ttsServer.address().port;
    console.log(`🎙️ 本地语音服务已启动：http://${getLocalIPv4()}:${port}/tts/`);
  }
  const port = ttsServer.address().port;
  const baseURL = tts.publicBaseURL || `http://${getLocalIPv4()}:${port}`;
  return String(baseURL).replace(/\/+$/, '');
}

const ttsFiles = [];
async function cleanupTTSFiles(max) {
  while (ttsFiles.length > max) {
    const file = ttsFiles.shift();
    await rm(file, { force: true }).catch(() => {});
  }
}

/** 调用 MiniMax T2A 接口，返回 mp3 音频数据 */
async function synthesizeMiniMax(tts, openai, text) {
  const baseURL = String(tts.baseURL || openai.baseURL || 'https://api.minimaxi.com/v1').replace(
    /\/+$/,
    '',
  );
  const apiKey = tts.apiKey || openai.apiKey;
  if (!apiKey) {
    throw new Error('未配置 MiniMax apiKey（tts.apiKey 或 openai.apiKey）');
  }
  const res = await fetch(`${baseURL}/t2a_v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: tts.model,
      text,
      stream: false,
      language_boost: 'auto',
      voice_setting: {
        voice_id: tts.voiceId,
        speed: tts.speed,
        vol: tts.vol,
        pitch: tts.pitch,
      },
      audio_setting: {
        sample_rate: tts.sampleRate,
        bitrate: tts.bitrate,
        format: tts.format,
        channel: 1,
      },
    }),
    signal: AbortSignal.timeout(tts.timeout),
  });
  if (!res.ok) {
    throw new Error(`MiniMax TTS HTTP ${res.status}：${await res.text().catch(() => '')}`);
  }
  const data = await res.json();
  const code = data?.base_resp?.status_code ?? 0;
  if (code !== 0) {
    throw new Error(`MiniMax TTS 失败(${code})：${data?.base_resp?.status_msg ?? '未知错误'}`);
  }
  const hex = data?.data?.audio;
  if (!hex) {
    throw new Error('MiniMax TTS 未返回音频数据');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * 用 MiniMax 合成语音并让小爱播放。
 *
 * 返回值 false 表示没播成功，调用方应回退到 MIoT 文本播报。
 */
async function playMiniMax(engine, text) {
  const tts = { ...kDefaultTTSConfig, ...(engine.config?.tts ?? {}) };
  const speakText = toSpeakableText(text);
  if (!speakText) {
    return false;
  }
  const audio = await synthesizeMiniMax(tts, engine.config?.openai ?? {}, speakText);
  const baseURL = await ensureTTSBaseURL(tts);
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${tts.format}`;
  await writeFile(join(ttsDir, name), audio);
  ttsFiles.push(join(ttsDir, name));
  await cleanupTTSFiles(Math.max(1, tts.keepFiles));
  const url = `${baseURL}/tts/${name}`;
  const played = await engine.speaker.play({ url });
  console.log(
    played
      ? `🎙️ MiniMax 语音已下发（${Math.round(audio.length / 1024)}KB）：${url}`
      : `⚠️ MiniMax 语音下发失败：${url}`,
  );
  return played;
}

/**
 * @type {import('@mi-gpt/next').MiGPTConfig}
 */
export default {
  debug: false, // 是否开启调试模式
  speaker: {
    /**
     * 小爱音箱在米家中设置的名称
     *
     * 如果提示找不到设备，请打开调试模式获取设备真实的 name、miotDID 或 mac 地址填入
     */
    did: env('MI_SPEAKER_DID', '小爱音箱Play'),
    /**
     * 小米 ID（一串数字）
     *
     * 注意：不是手机号或邮箱，请在小米账号「个人信息」-「小米 ID」查看
     */
    userId: env('MI_USER_ID', 'xiaomizhanghaoidxxxx'),
    /**
     * 小米账号登录密码
     *
     * 如果提示登录失败，请使用 passToken 登录
     */
    password: env('MI_PASSWORD', 'xiaomizhanghaomimaxxxx'),
    /**
     * （可选）小米账号 passToken
     *
     * 获取教程：https://github.com/idootop/migpt-next/issues/4
     */
    passToken: env('MI_PASS_TOKEN', 'xiaomizhanghaopasstokenxxxx'),
  },
  openai: {
    enableProxy: true,
    /**
     * 你的大模型服务提供商的接口地址
     *
     * 支持兼容 OpenAI 接口的大模型服务，比如：DeepSeek V3 等
     *
     * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
     * - ✅ https://api.openai.com/v1
     * - ❌ https://api.openai.com/v1/（最后多了一个 /
     * - ❌ https://api.openai.com/v1/chat/completions（不需要加 /chat/completions）
     */
    baseURL: env('OPENAI_BASE_URL', 'https://api.minimaxi.com/v1'),
    /**
     * API 密钥（填在本地 .env 的 OPENAI_API_KEY，不要写进仓库）
     */
    apiKey: env('OPENAI_API_KEY', 'apikeyxxxxxxxxxxxxxxxxxxx'),
    /**
     * 模型名称，注意这里填的是火山引擎的模型接入点，ep 开头
     */
    model: env('OPENAI_MODEL', 'MiniMax-M3.1-Flash'),
    /**
     * 按需联网：由模型判断当前问题是否需要搜索最新信息。
     */
    webSearch: {
      enabled: true,
      strategy: 'hybrid',
      fallbackNotice: '联网搜索暂时不可用，以下内容可能不是最新。',
    },
    /**
     * 扩展配置
     */
    extra: {
      /**
       * 请求超时时间（毫秒），默认 30 秒
       */
      requestOptions: {
        timeout: 60000,
      },
    },
  },
  /**
   * 外接 LLM 回答的语音播报
   *
   * 语音来源开关：
   * - 'minimax'（默认）：MiniMax 合成 mp3 → 本地静态服务托管 → 小爱播放音频链接，音色自然，约 1.5-2s 出声；
   * - 'xiaoai'：直接用小爱原生 TTS 播文本，约 0.6s 出声，音色机械、长文本会分段，且可能被小爱原生播报复盖。
   *
   * 也可用环境变量 TTS_PROVIDER 切换；MiniMax 合成失败会自动回退到原生 TTS。
   */
  tts: {
    provider: env('TTS_PROVIDER', 'minimax'),
    /** 兼容旧配置：设为 false 等价于 provider: 'xiaoai' */
    enabled: true,
    /** 语音模型 */
    model: env('TTS_MODEL', 'speech-2.8-turbo'),
    /** 音色 ID（MiniMax 控制台「音色管理」里的 voice_id） */
    voiceId: env('TTS_VOICE_ID', 'male-qn-qingse'),
    speed: 1,
    vol: 1,
    pitch: 0,
    /** 采样率 / 码率 / 格式，format 目前支持 mp3、wav、pcm、flac */
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    /**
     * 合成接口地址与密钥，留空则复用上面 openai.baseURL / openai.apiKey
     *
     * 例：https://api.minimaxi.com/v1
     */
    baseURL: env('TTS_BASE_URL', ''),
    apiKey: env('TTS_API_KEY', ''),
    /**
     * 小爱访问不到局域网地址时（跨网段 / 走公网）填本机对外地址
     *
     * 例：https://tts.example.com （需反向代理到本机 port）
     */
    publicBaseURL: env('TTS_PUBLIC_BASE_URL', ''),
    /** 本地音频服务端口 */
    port: 17890,
    timeout: 20000,
    keepFiles: 20,
  },
  prompt: {
    /**
     * 系统提示词，如需关闭可设置为：''（空字符串）
     */
    system: '你是一个智能助手，请用简洁的语言回答用户的问题，每次回答控制在150字以内。',
  },
  context: {
    /**
     * 每次对话携带的最大历史消息数（如需关闭可设置为：0）
     */
    historyMaxLength: 10,
  },
  /**
   * 流式响应配置
   */
  stream: {
    /**
     * 单次响应的最大长度（控制分句大小）
     * 小爱音箱 L05B 对 TTS 文本长度有限制，建议不超过 100
     */
    maxReplyLength: 100,
  },
  /**
   * 只回答以下关键词开头的消息：
   *
   * - 请问地球为什么是圆的？
   * - 你知道世界上跑的最快的动物是什么吗？
   */
  callAIKeywords: [''],
  /**
   * 自定义消息回复
   */
  async onMessage(engine, msg) {
    if (!engine.config.callAIKeywords?.some((keyword) => msg.text.startsWith(keyword))) {
      console.log(`🧭 回答来源：小爱原生播报（未命中唤醒词，交给小爱自己答）｜${msg.text}`);
      return;
    }

    const xiaoAIAnswer =
      typeof msg.metadata?.xiaoAIAnswer === 'string' ? msg.metadata.xiaoAIAnswer.trim() : '';
    if (xiaoAIAnswer && !isXiaoAIAnswerFailure(xiaoAIAnswer)) {
      console.log(`🧭 回答来源：小爱原生播报（小爱已作答，不再调用 LLM）｜${xiaoAIAnswer}`);
      return { handled: true };
    }
    if (xiaoAIAnswer) {
      console.log(`🧭 回答来源：外接 LLM（小爱答不上来：${xiaoAIAnswer}）｜${msg.text}`);
    } else {
      console.log(`🧭 回答来源：外接 LLM（小爱无原生回答）｜${msg.text}`);
    }

    const startAt = Date.now();

    // LLM 请求和「打断小爱 → 等空闲 → 播思考提示」互不依赖，先把请求发出去并行等待。
    let llmMs = 0;
    const llmStartAt = Date.now();
    const llmPromise = engine
      .askAI(msg, { stream: false })
      .then((reply) => {
        llmMs = Date.now() - llmStartAt;
        return reply;
      })
      .catch((error) => {
        llmMs = Date.now() - llmStartAt;
        console.warn(`❌ 外接 LLM 调用失败：${error?.message ?? error}`);
        return undefined;
      });

    // L05B 的 MiNA TTS 无法稳定抢占小爱原生回复，改用 MIoT 的“播放文本”动作。
    try {
      const stopped = await engine.speaker.abortXiaoAI();
      if (!stopped) {
        console.warn('⚠️ 未能确认已停止小爱原生播报，继续切换外接 LLM');
      }
    } catch (error) {
      console.warn(`⚠️ 停止小爱原生播报异常：${error?.message ?? error}`);
    }

    // 等待小爱原生播报真正停止，否则新的 TTS 指令会被设备丢弃（无声音）。
    await waitForPlaybackIdle(engine);

    // 思考提示只发一次：失败也不重试，避免为了占位白等 500ms。
    await playText(engine, '正在思考中', { retries: 1, gap: 0 });
    const promptAt = Date.now();

    const reply = await llmPromise;
    const text = reply?.text ?? '';
    const llmAt = Date.now();

    if (text) {
      const ttsProvider = resolveTTSProvider(engine.config?.tts);
      const voiceLabel =
        ttsProvider === 'minimax'
          ? `MiniMax ${engine.config?.tts?.model ?? kDefaultTTSConfig.model}`
          : '小米原生 TTS';

      let played = false;
      if (ttsProvider === 'minimax') {
        try {
          played = await playMiniMax(engine, text);
        } catch (error) {
          console.warn(`⚠️ MiniMax 语音合成失败，回退文本播报：${error?.message ?? error}`);
        }
      }
      if (!played) {
        played = await playText(engine, text, {
          maxLength: this.stream?.maxReplyLength ?? kDefaultMaxTextLength,
        });
      }
      const doneAt = Date.now();
      console.log(
        played
          ? `✅ 回答来源：外接 LLM（语音：${voiceLabel}）已播报｜${text}`
          : `❌ 回答来源：外接 LLM 播报失败（语音：${voiceLabel}，指令未生效）｜${text}`,
      );
      console.log(
        `⏱️ 耗时 ${doneAt - startAt}ms（打断+占位 ${promptAt - startAt}ms，等 LLM ${llmAt - promptAt}ms，语音 ${doneAt - llmAt}ms；LLM 实际 ${llmMs}ms）`,
      );
    } else {
      console.warn('⚠️ 回答来源：外接 LLM 无返回，已改播兜底话术');
      await playText(engine, '抱歉，我这边没能想出答案，请稍后再试。');
    }

    // 阻止引擎再走默认的 MiNA TTS 链路。
    return { handled: true };
  },
};
