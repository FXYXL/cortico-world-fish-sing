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

插件自带**代码和配置**，你只需要准备两样：

- **Python 运行时**（torch cu118 + demucs + faiss + soundfile）→ `node tools/bootstrap.mjs venv`
- **模型权重**（909 MB，6 个文件）→ `node tools/bootstrap.mjs models --download`
- ffmpeg 三件套（`ffmpeg.exe` / `ffprobe.exe` / `ffplay.exe`，默认 `D:\ffmpeg\bin`）
- 可选：SnowLuma（OneBot HTTP）用于发 QQ 语音条

## 运行时与权重

一条命令体检，告诉你还缺什么（不动磁盘）：

```bash
node tools/bootstrap.mjs
```

逐步安装，每步都能重复跑、失败直接重试：

```bash
node tools/bootstrap.mjs rvc                  # 复制 RVC 代码到 <数据目录>/runtime/rvc（3 MB）
node tools/bootstrap.mjs models               # 从已有 RVC 目录复制权重（本机迁移用；--from 可换来源）
node tools/bootstrap.mjs models --download    # 从 GitHub Release 下载 909 MB 并校验 sha256
node tools/bootstrap.mjs venv                 # 准备 Python 运行时，并补 demucs
node tools/bootstrap.mjs verify               # 检查 torch/demucs/faiss 与权重是否齐
```

装完的目录：

```
<数据目录>/runtime/
  rvc/     ← 代码 + 权重（assets/weights、assets/rmvpe、assets/hubert_base、logs/dfy2）
  venv/    ← Python 运行时
```

**配置里那四个路径框全部留空 = 自托管**，什么都不用改。
已经有一份外部 RVC 的开发者，把 `worker.rvcRoot` / `worker.pythonPath` 填上就切回外部模式。

### 迁移已有环境（不重新下载）

本机已经跑通过 RVC 的，从现有项目抄过来最快：

```bash
node tools/bootstrap.mjs all --link     # 代码 + 权重；--link 用硬链接，同盘几乎不占空间
node tools/bootstrap.mjs venv           # 复制现有 venv（6 GB，几分钟），自动补 demucs
node tools/bootstrap.mjs verify
```

`venv --fresh` 是从零建（要下 torch 2.5 GB，走国内镜像约 10~20 分钟）。

### 发布权重到 Release（维护者）

```bash
node tools/upload-release.mjs --dry     # 先看要传什么
$env:GITHUB_TOKEN="ghp_xxx"             # classic 勾 repo，或 fine-grained 给 Contents: Read and write
node tools/upload-release.mjs           # 自动建 Release（tag=models-v1）+ 上传 + 复核
```

也可以网页传：<https://github.com/FXYXL/cortico-world-fish-sing/releases/new>，
**tag 必须填 `models-v1`**（清单里的下载地址按它拼），把 6 个文件拖进去。

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
