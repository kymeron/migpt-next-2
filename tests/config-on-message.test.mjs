import assert from 'node:assert/strict';
import test from 'node:test';

import baseConfig from '../config.js';

/** 这些用例只验证文本播报链路，关掉语音合成避免真的发起网络请求 */
const config = { ...baseConfig, tts: { ...baseConfig.tts, enabled: false } };

function createEngine(calls, { abortResult = true, answer = '这是豆包返回的答案' } = {}) {
  return {
    config,
    speaker: {
      async abortXiaoAI() {
        calls.push(['abort']);
        return abortResult;
      },
    },
    MiOT: {
      async doAction(siid, aiid, text) {
        calls.push(['tts', siid, aiid, text]);
        return true;
      },
    },
    async askAI(receivedMessage, options) {
      calls.push(['askAI', receivedMessage.text, options]);
      return { text: answer };
    },
  };
}

test('enables model-directed web search', () => {
  assert.equal(config.openai.webSearch?.enabled, true);
  assert.equal(config.openai.webSearch?.strategy, 'hybrid');
});

test('uses the L05B MIoT text action for thinking and the AI answer', async () => {
  const calls = [];
  const message = {
    id: 'message-1',
    sender: 'user',
    text: '华为是一家什么样的公司',
    timestamp: 1,
  };
  const engine = createEngine(calls);

  const reply = await config.onMessage(engine, message);

  assert.deepEqual(calls, [
    ['askAI', message.text, { stream: false }],
    ['abort'],
    ['tts', 5, 3, '正在思考中'],
    ['tts', 5, 3, '这是豆包返回的答案'],
  ]);
  assert.deepEqual(reply, { handled: true });
});

test('keeps a useful native XiaoAI answer without interrupting it', async () => {
  const calls = [];
  const message = {
    id: 'message-native',
    sender: 'user',
    text: '今天杭州天气怎么样',
    timestamp: 2,
    metadata: {
      xiaoAIAnswer: '今天杭州晴到多云，最高气温三十八度。',
      xiaoAIAnswerType: 'TTS',
    },
  };

  const reply = await config.onMessage(createEngine(calls), message);

  assert.deepEqual(calls, []);
  assert.deepEqual(reply, { handled: true });
});

test('uses the external LLM for explicit XiaoAI failure answers', async () => {
  const failures = [
    '这个我不知道',
    '抱歉，我暂时无法回答',
    '这个问题我回答不了',
    '我没听懂你说什么',
    '你可以换个问题',
    '被你问住了，看来要更努力学习了',
    '每个问题你都问住了，看来我要更努力学习了',
    '本设备暂不支持该功能，请前往手机小爱查询',
    '这个我暂时还回答不上诶，我要再学习学习',
    '这个问题把我难住了，我会继续努力的',
    '被难住了诶，看我还要再学习一下',
  ];

  for (const [index, xiaoAIAnswer] of failures.entries()) {
    const calls = [];
    const message = {
      id: `message-failure-${index}`,
      sender: 'user',
      text: '这是一个小爱不会的问题',
      timestamp: 3 + index,
      metadata: { xiaoAIAnswer, xiaoAIAnswerType: 'TTS' },
    };

    await config.onMessage(createEngine(calls), message);

    assert.deepEqual(calls, [
      ['askAI', message.text, { stream: false }],
      ['abort'],
      ['tts', 5, 3, '正在思考中'],
      ['tts', 5, 3, '这是豆包返回的答案'],
    ]);
  }
});

test('falls back to MiNA TTS when the MIoT text action fails', async () => {
  const calls = [];
  const engine = {
    config,
    speaker: {
      async abortXiaoAI() {
        calls.push(['abort']);
        return true;
      },
      async play({ text }) {
        calls.push(['mina', text]);
        return true;
      },
    },
    MiOT: {
      async doAction(siid, aiid, text) {
        calls.push(['miot', siid, aiid, text]);
        return false;
      },
    },
    async askAI() {
      calls.push(['askAI']);
      return { text: '退化为 MiNA 播放' };
    },
  };

  await config.onMessage(engine, {
    id: 'message-fallback',
    sender: 'user',
    text: '小爱不会的问题',
    timestamp: 200,
    metadata: { xiaoAIAnswer: '被你问住了', xiaoAIAnswerType: 'TTS' },
  });

  // 思考提示与 LLM 并行，占位阶段两类播报的先后不固定，这里只校验集合
  const key = (call) => JSON.stringify(call);
  assert.deepEqual(
    calls.map(key).sort(),
    [
      ['abort'],
      ['miot', 5, 3, '正在思考中'],
      ['mina', '正在思考中'],
      ['askAI'],
      ['miot', 5, 3, '退化为 MiNA 播放'],
      ['mina', '退化为 MiNA 播放'],
    ]
      .map(key)
      .sort(),
  );
  // 回答的播报必须在思考提示之后
  assert.deepEqual(calls.slice(-2), [
    ['miot', 5, 3, '退化为 MiNA 播放'],
    ['mina', '退化为 MiNA 播放'],
  ]);
});

test('splits long answers to fit the TTS length limit', async () => {
  const calls = [];
  const longAnswer = `${'很长的回答，'.repeat(30)}结束。`;
  const engine = createEngine(calls, { answer: longAnswer });

  await config.onMessage(engine, {
    id: 'message-long',
    sender: 'user',
    text: '小爱不会的问题',
    timestamp: 300,
    metadata: { xiaoAIAnswer: '被你问住了', xiaoAIAnswerType: 'TTS' },
  });

  const played = calls.filter((call) => call[0] === 'tts' && call[3] !== '正在思考中');
  assert.ok(played.length > 1);
  for (const [, , , text] of played) {
    assert.ok(text.length <= 100, `chunk too long: ${text.length}`);
  }
  assert.equal(played.map((call) => call[3]).join(''), longAnswer);
});

test('continues to the thinking prompt when native playback cannot be stopped', async () => {
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await config.onMessage(createEngine(calls, { abortResult: false }), {
      id: 'message-stop-failed',
      sender: 'user',
      text: '小爱不会的问题',
      timestamp: 99,
      metadata: { xiaoAIAnswer: '被你问住了', xiaoAIAnswerType: 'TTS' },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings[0], /未能确认已停止小爱原生播报/);
  assert.deepEqual(calls, [
    ['askAI', '小爱不会的问题', { stream: false }],
    ['abort'],
    ['tts', 5, 3, '正在思考中'],
    ['tts', 5, 3, '这是豆包返回的答案'],
  ]);
});

test('switches to Xiaomi native TTS when tts.provider is xiaoai', async () => {
  const calls = [];
  const engine = {
    config: { ...config, tts: { ...config.tts, enabled: true, provider: 'xiaoai' } },
    speaker: {
      async abortXiaoAI() {
        calls.push(['abort']);
        return true;
      },
      async play({ text, url }) {
        calls.push(['play', url ? 'url' : text]);
        return true;
      },
    },
    MiOT: {
      async doAction(_siid, _aiid, text) {
        calls.push(['miot', text]);
        // L05B 不支持 MIoT 播放文本，回退 MiNA 原生 TTS
        return false;
      },
    },
    async askAI() {
      return { text: '小米原生播报' };
    },
  };

  await config.onMessage(engine, {
    id: 'message-xiaoai-tts',
    sender: 'user',
    text: '小爱不会的问题',
    timestamp: 400,
    metadata: { xiaoAIAnswer: '被你问住了', xiaoAIAnswerType: 'TTS' },
  });

  // 走原生 TTS 时不应出现 MiniMax 的音频链接播放
  assert.equal(
    calls.some(([type, value]) => type === 'play' && value === 'url'),
    false,
  );
  assert.deepEqual(
    calls.filter(([type, value]) => type === 'play' && value !== '正在思考中'),
    [['play', '小米原生播报']],
  );
});

test('keeps PC control disabled by default', () => {
  assert.equal(baseConfig.pcControl?.enabled, false);
});

test('runs a whitelisted PC command without calling the LLM', async () => {
  const calls = [];
  const engine = {
    config: {
      ...config,
      pcControl: {
        enabled: true,
        muteMs: 0,
        commands: { 测试指令: ['/bin/echo', ['ok']] },
      },
    },
    speaker: {
      async abortXiaoAI() {
        calls.push(['abort']);
        return true;
      },
      async play({ text, url }) {
        calls.push(['play', url ? 'url' : text]);
        return true;
      },
    },
    MiOT: {
      async doAction(_siid, _aiid, text) {
        calls.push(['miot', text]);
        return false;
      },
    },
    async askAI() {
      calls.push(['askAI']);
      return { text: '不该走到模型' };
    },
  };

  const reply = await config.onMessage(engine, {
    id: 'message-pc',
    sender: 'user',
    text: '小爱同学，帮我测试指令',
    timestamp: 500,
  });

  assert.deepEqual(reply, { handled: true });
  assert.equal(calls.some(([type]) => type === 'askAI'), false);
  assert.deepEqual(calls.at(-1), ['play', '好的，已执行']);
});

test('ignores texts that are not in the PC command whitelist', async () => {
  const calls = [];
  const engine = {
    config: {
      ...config,
      pcControl: { enabled: true, muteMs: 0, commands: { 测试指令: ['/bin/echo'] } },
    },
    speaker: {
      async abortXiaoAI() {
        return true;
      },
    },
    async askAI() {
      calls.push(['askAI']);
      return { text: '' };
    },
  };

  await config.onMessage(engine, {
    id: 'message-pc-miss',
    sender: 'user',
    text: '今天天气怎么样',
    timestamp: 501,
  });

  assert.deepEqual(calls, [['askAI']]);
});
