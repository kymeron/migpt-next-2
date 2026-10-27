import { ChatBot, type IMessage } from '@mi-gpt/chat';
import type { IReply } from '@mi-gpt/engine/base';
import { type EngineConfig, MiGPTEngine } from '@mi-gpt/engine/index';
import { deepMerge, sleep } from '@mi-gpt/utils';
import type { DeepPartial, Prettify } from '@mi-gpt/utils/typing';
import { MiMessage } from './message.js';
import { MiService, type MiServiceConfig } from './service.js';
import { MiSpeaker } from './speaker.js';

export { extractNativeAnswer } from './native-answer.js';
export type { NativeAnswer } from './native-answer.js';

export type MiGPTConfig = Prettify<
  EngineConfig<MiJiaEngine> &
    DeepPartial<{
      debug: boolean;
      /**
       * 判断某条消息是否跳过「等待小爱原生回答」
       *
       * 返回 true 时，轮询到这条消息就立即交给 onMessage 处理，
       * 不再等待小爱生成回答（可省掉最多 2s 的延迟，适合语音控制电脑这类自定义指令）。
       */
      shouldSkipNativeAnswerWait?: (text: string) => boolean;
      speaker: MiServiceConfig & {
        /**
         * 消息轮询间隔（毫秒）
         *
         * 默认 1000（最低 1 秒）
         */
        heartbeat?: number;
      };
    }>
>;

const kDefaultMiGPTConfig: MiGPTConfig = {
  debug: false,
  speaker: {
    heartbeat: 500,
  },
};

class MiJiaEngine extends MiGPTEngine {
  config: MiGPTConfig = kDefaultMiGPTConfig;

  speaker = MiSpeaker;

  get MiNA() {
    return MiService.MiNA!;
  }

  get MiOT() {
    return MiService.MiOT!;
  }

  // 轮询消息
  #processing = false;
  async #processMessage(msg: IMessage) {
    if (this.#processing) return;
    this.#processing = true;
    try {
      await this.onMessage(msg);
    } finally {
      this.#processing = false;
    }
  }

  async start(config: MiGPTConfig) {
    await super.start(deepMerge(kDefaultMiGPTConfig, config));

    await MiService.init(this.config as any);

    MiMessage.setSkipNativeAnswerWait(this.config.shouldSkipNativeAnswerWait);

    console.log('✅ 服务已启动...');

    // 轮询间隔最小 1 秒
    const heartbeat = Math.max(500, this.config.speaker!.heartbeat!);

    // 轮询消息
    while (this.status === 'running') {
      const msg = await MiMessage.fetchNextMessage();
      if (msg) {
        await this.#processMessage(msg);
      }
      await sleep(heartbeat);
    }
  }

  async askAI(msg: IMessage): Promise<IReply> {
    const text = await ChatBot.chat(msg);
    return { text };
  }
}

export const MiGPT = new MiJiaEngine();
