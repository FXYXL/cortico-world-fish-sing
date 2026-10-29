# cortico-world-fish-sing

让她真的开口唱：**B 站点歌 / 本地文件 → 人声分离 → RVC 换声 → 混音 → 本机出声或发 QQ 语音条**。

给 [Coopanion](https://github.com/Pal-AI-Lab/cortico-extensions) 用的 World 扩展。配套一个常驻 Python worker 做推理，TS 侧只负责编排与投递。

```
你想听她唱《我不难过》
        │
        ▼
  B 站搜索（或 BV 号 / 本地文件）
        │
        ▼
  demucs 分离 ──► 干声 + 伴奏
        │
        ▼
  RVC 换声（55 秒切片，模型常驻）
        │
        ▼
  混音 → mp3
        │
   ┌────┴────┐
   ▼         ▼
本机 ffplay  QQ 语音条（自动切 ≤60s 多条）
```

## 为什么这么做

| 决策 | 原因 |
|---|---|
| 模型常驻（独立 worker 进程） | 每次起进程要重载 hubert + rmvpe + 生成器 + faiss，实测 8 秒；常驻后 55 秒音频只要 4 秒 |
| **强制 55 秒切片** | 整段喂给 RVC 会一次性过 encoder，5 分钟的歌 ≈ 32k 帧，注意力 O(n²)：实测跑 10 分钟不结束、内存涨到 13 GB。切片后 6 片共 76 秒跑完 |
| 不做 TTS | 说话是 gpt-sovits 扩展的活，这里只管唱 |
| 不依赖 qq-final / fishtools | 语音条自己走 SnowLuma 的 OneBot HTTP `record` 段；B 站搜索自己实现了一份 |
| 一个队列一个线程 | 只有一张显卡，两个 torch 进程同时抢会双双卡死 |

## 依赖

- **RVC 项目 + 训练好的模型**（默认 `D:\AI\rvc`，模型 `assets/weights/dfy2.pth`，索引 `logs/dfy2/added_*.index`）
- **demucs 环境**（默认 `D:\AI\seed-vc\venv`，脚本 `D:\AI\seed-vc-src\separate.py`）
- **ffmpeg 三件套**（`ffmpeg.exe` / `ffprobe.exe` / `ffplay.exe`，默认 `D:\ffmpeg\bin`）
- 可选：SnowLuma（OneBot HTTP）用于发 QQ 语音条

全部路径都能在控制台「大肥鱼唱歌」页里改。

## 安装

### 手动（最稳，推荐）

1. 把本目录复制到 `D:\Coopanion\data\extensions\node_modules\cortico-world-fish-sing\`
2. 在 `D:\Coopanion\data\extensions\package.json` 的 `dependencies` 里加：
   ```json
   "cortico-world-fish-sing": "0.1.0"
   ```
3. 在 `D:\Coopanion\data\home\companion\config.json` 的 `worlds` 下加：
   ```json
   "fish-sing": { "enabled": true }
   ```
4. 重启 Coopanion，在控制台「Worlds」页确认「大肥鱼唱歌」已加载

或者直接跑 `node tools/install.mjs`（会做 1~3 步，**先关掉 Coo**）。

### npm

```bash
cd D:\Coopanion\data\extensions
node D:/Coopanion/resources/app/node_modules/pnpm/bin/pnpm.cjs add cortico-world-fish-sing
```

> 用桌宠内置的 pnpm（v11），不要用命令行那个 v10，会 store 冲突。

## 配置

控制台 →「大肥鱼唱歌」→ 四组配置：

- **换声**：模型、检索索引、`index-rate`（越大越像本人）、`protect`（气声保护）、默认移调、默认输出（带伴奏/清唱）
- **点歌**：B 站搜索的相关性阈值、时长与体积上限、避开词
- **播放与发送**：本机播放开关与音量、OneBot HTTP 地址与令牌、单条语音上限、多条间隔
- **运行时**：RVC 根目录、两个 python 路径、ffmpeg 目录、worker 端口与自动拉起

## 工具

| 工具 | 作用 |
|---|---|
| `fish_sing` | 唱一首。`song` = 歌名 / BV 号 / 本地路径；`to` = `local` / `group:<群号>` / `private:<QQ号>` / `both` |
| `fish_sing_stop` | 停掉播放并取消正在处理的歌 |
| `fish_sing_library` | 列出 / 回放 / 删除唱过的歌 |
| `fish_sing_status` | 模型、队列、当前进度 |

只唱副歌（也顺便绕开 QQ 60 秒限制）：

```
fish_sing(song="我不难过", start=95, duration=30, to="group:123456")
```

男歌女唱唱不上去：

```
fish_sing(song="晴天", pitch=3)
```

## 命令行（不起 Coo 也能用）

```bash
cd worker
D:\AI\rvc\venv\Scripts\python.exe cli.py "D:\AI\孙燕姿 - 我不难过.mp3" --play
D:\AI\rvc\venv\Scripts\python.exe cli.py in.mp3 --mode vocals --out 清唱.mp3
D:\AI\rvc\venv\Scripts\python.exe cli.py in.mp3 --start 95 --duration 30 --out 副歌.mp3
```

## 目录

```
vendor/rvc/     RVC 代码副本（MIT，随包分发）
assets/models.manifest.json   权重清单（名称/大小/sha256/落盘路径）
dist/webui.js   控制台面板（手写 ESM，无构建链）
src/
  index.ts      入口（default 导出 definition）
  definition.ts WorldDefinition（id/默认值/preflight/create/describe）
  config.ts     配置段与默认值
  paths.ts      路径解析（自托管 / 外部 RVC 两种模式）
  world.ts      World 类：工具、环境提示词、控制台声明
  sing.ts       编排：找源 → 换声 → 投递
  bili.ts       B 站搜索 / 打�� / 取音频流 / 下载
  worker.ts     与 Python worker 通信（自动拉起、轮询、取消）
  audio.ts      ffmpeg：时长、转码、截取、切段
  deliver.ts    本机 ffplay 播放 + OneBot record 发送
  library.ts    缓存与作品库
worker/
  engine.py     RVC 常驻 + 55 秒切片 + 分离 + 混音
  server.py     HTTP：/health /job /job/<id> /stop /doctor
  cli.py        一条命令跑完整条链
  separate.py   demucs 分离（自带，不依赖外部项目）
tools/
  doctor.mjs    自检
  install.mjs   安装到 Coopanion（会改 extensions/package.json 与 config.json）
```

## 自检

```bash
node tools/doctor.mjs        # 扩展结构 + 路径 + torch/CUDA + worker 是否在线
cd worker && D:\AI\rvc\venv\Scripts\python.exe engine.py   # 只查推理环境
```

## 许可

MIT。RVC / demucs / ContentVec 各自遵循其原始许可；用别人的声音训练模型前请确认授权（音色也有权利）。
