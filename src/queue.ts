/**
 * 点歌队列与后台预热状态机（小歌会 / 连唱模式）。
 *
 * 职责极简：
 *  · 管理待唱列表、插队、移出、清空与循环模式（顺序 / 单曲循环 / 列表循环）；
 *  · 追踪队首曲目的预热状态（pending → warming → ready / failed），配合 World 在
 *    当前歌曲播放期间趁 GPU 空闲提前准备好下一首，播完瞬间 0 秒无缝衔接；
 *  · 保持纯内存逻辑，方便单测且无文件锁负担。
 */
import type { SingRequest } from './sing.ts';

export type QueueLoopMode = 'sequence' | 'loop-one' | 'loop-all';

export interface QueuePrepared {
  id: string;
  title: string;
  file: string;
  durationSec: number;
  reportSummary?: string;
}

export interface QueueItem {
  qid: string;
  song: string;
  title: string;
  req: SingRequest;
  state: 'pending' | 'warming' | 'ready' | 'failed';
  error?: string;
  prepared?: QueuePrepared;
  addedAt: number;
}

export class SingQueue {
  private items: QueueItem[] = [];
  private seq = 0;
  mode: QueueLoopMode = 'sequence';

  private nextId(): string {
    this.seq += 1;
    return `q${Date.now().toString(36)}_${this.seq}`;
  }

  get length(): number {
    return this.items.length;
  }

  list(): QueueItem[] {
    return this.items.map((it) => ({ ...it }));
  }

  peek(): QueueItem | undefined {
    return this.items[0];
  }

  /** 追加一首到队尾（或 front=true 插队到下一首）。 */
  enqueue(
    input: { song: string; title?: string; req?: Partial<SingRequest>; prepared?: QueuePrepared },
    front = false,
  ): QueueItem {
    const song = String(input.song || '').trim();
    const item: QueueItem = {
      qid: this.nextId(),
      song,
      title: String(input.title || input.prepared?.title || song).trim(),
      req: { ...(input.req ?? {}), song, to: 'none' },
      state: input.prepared ? 'ready' : 'pending',
      prepared: input.prepared,
      addedAt: Date.now(),
    };
    if (front) this.items.unshift(item);
    else this.items.push(item);
    return item;
  }

  /** 取出队首曲目准备开播。 */
  shift(): QueueItem | undefined {
    return this.items.shift();
  }

  /** 按 qid、1 基序号或歌名模糊移出一条待唱曲目。 */
  remove(keyOrIndex: string | number): QueueItem | null {
    if (!this.items.length) return null;
    const raw = String(keyOrIndex ?? '').trim();
    if (!raw) return null;
    const asNum = Number(raw);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= this.items.length) {
      return this.items.splice(asNum - 1, 1)[0] ?? null;
    }
    const idx = this.items.findIndex(
      (it) => it.qid === raw || it.title.toLowerCase().includes(raw.toLowerCase()) || it.song.toLowerCase().includes(raw.toLowerCase()),
    );
    if (idx < 0) return null;
    return this.items.splice(idx, 1)[0] ?? null;
  }

  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  /** 查找队列里第一首需要后台预热的待唱曲目。 */
  findNextToWarm(): QueueItem | undefined {
    return this.items.find((it) => it.state === 'pending');
  }

  /** 按 qid 更新条目状态（仅当条目仍在队列中时生效）。 */
  markState(qid: string, state: QueueItem['state'], patch?: { prepared?: QueuePrepared; title?: string; error?: string }): QueueItem | null {
    const it = this.items.find((x) => x.qid === qid);
    if (!it) return null;
    it.state = state;
    if (patch?.prepared) it.prepared = patch.prepared;
    if (patch?.title) it.title = patch.title;
    if (patch?.error !== undefined) it.error = patch.error;
    return it;
  }

  /** 紧凑格式化队列给桌宠阅读。 */
  formatText(): string {
    const modeLabel = this.mode === 'loop-one' ? '单曲循环' : this.mode === 'loop-all' ? '列表循环' : '顺序连唱';
    if (!this.items.length) return `点歌队列为空（模式：${modeLabel}）。`;
    const stateTag = (s: QueueItem['state']) => (
      s === 'ready' ? '已就绪' : s === 'warming' ? '预热中' : s === 'failed' ? '失败' : '待准备'
    );
    const lines = this.items.map((it, i) => `${i + 1}. 《${it.title}》[${stateTag(it.state)}]${it.error ? `（${it.error}）` : ''}`);
    return `点歌队列共 ${this.items.length} 首（模式：${modeLabel}）：\n${lines.join('\n')}`;
  }
}
