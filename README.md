# cortico-world-fish-sing · 大肥鱼唱歌

让她真的开口唱：**B 站点歌 / 本地文件 → 人声分离 → RVC 换声 → 混音 → 本机出声或发 QQ 语音条**。
附带一套训练面板：选素材 → 分离 → 切片 → **按音域调权重** → 训练 → 出模型，全程点按钮。

给 [Coopanion](https://github.com/Pal-AI-Lab/cortico-extensions) 用的 World 扩展。
重活（torch / demucs / RVC）都在常驻的 Python worker 里，TS 侧只负责编排、投递和面板。

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
  RVC 换声（模型常驻，按显存自动切片）
        │
        ▼
  混音 → mp3
        │
   ┌────┴────┐
   ▼         ▼
本机 ffplay  QQ 语音条（自动切 ≤60s 多条）
```

- [装之前先看](#装之前先看)
- [安装](#安装)
- [第一次使用](#第一次使用)
- [控制台四个页](#控制台四个页)
- [训练自己的音色](#训练自己的音色)
- [工具（她怎么调用）](#工具她怎么调用)
- [命令行（不起桌宠也能用）](#命令行不起桌宠也能用)
- [目录结构](#目录结构)
- [排障](#排障)
- [许可](#许可)

## 装之前先看

| | |
|---|---|
| 桌宠 | Coopanion（Core api 6） |
| Node | ≥ 22.6（要支持 `--experimental-strip-types`） |
| 显卡 | 推荐 NVIDIA 8 GB 以上。没有也能跑，用 CPU 运行时（慢 6~8 倍） |
| ffmpeg | 需要 `ffmpeg.exe` / `ffprobe.exe` / `ffplay.exe` 三件套，Windows 用 full build |
| 磁盘 | 推理约 7 GB（torch + demucs + 909 MB 权重），训练再预留几 GB |
| 发 QQ 语音 | 可选，需要 SnowLuma 或其他 OneBot HTTP 实现 |

插件包本身只有 **511 KB**：代码和配置随包分发，权重和 Python 运行时装好插件后再点按钮下载。

## 安装

### npm（推荐）

```bash
cd D:\Coopanion\data\extensions
node D:/Coopanion/resources/app/node_modules/pnpm/bin/pnpm.cjs add cortico-world-fish-sing
```

> 用桌宠内置的 pnpm（v11），不要用命令行那个 v10，会 store 冲突。

刚发布的包可能被 pnpm 的 `minimumReleaseAge` 拦住（要求包发布满 24 小时）。在
`D:\Coopanion\data\extensions\pnpm-workspace.yaml` 里加一段即可立即装：

```yaml
minimumReleaseAgeExclude:
  - cortico-world-fish-sing@0.1.1
```

更新：

```bash
node D:/Coopanion/resources/app/node_modules/pnpm/bin/pnpm.cjs update cortico-world-fish-sing
```

桌宠控制台「扩展管理」里也会显示 `0.1.1 → 0.1.2` 和「更新」按钮。

### 手动（改源码时用）

1. 把本目录复制到 `D:\Coopanion\data\extensions\node_modules\cortico-world-fish-sing\`
2. 在 `D:\Coopanion\data\extensions\package.json` 的 `dependencies` 里加：
   ```json
   "cortico-world-fish-sing": "0.1.1"
   ```
3. 在 `D:\Coopanion\data\home\companion\config.json` 的 `worlds` 下加：
   ```json
   "fish-sing": { "enabled": true }
   ```
4. 重启 Coopanion

或者直接跑 `node tools/install.mjs`（做 1~3 步，**先关掉桌宠**）。

## 第一次使用

装完插件后还有两样东西要装，都在控制台「大肥鱼唱歌 → 安装与运行时」页，点按钮就行：

| 按钮 | 装什么 | 大小 |
|---|---|---|
| 下载模型权重 | 模型 + 检索索引 + ContentVec + RMVPE + 底模 | 909 MB |
| 安装 GPU 运行时 | torch(cu118) + demucs + faiss + pyworld + soundfile | 下载 2.5 GB / 装完 6 GB |
| 安装 CPU 运行时 | 同上，torch 是 CPU 版 | 约 200 MB，但慢 6~8 倍 |

命令行也可以（每步幂等，失败直接重跑）：

```bash
node tools/bootstrap.mjs                # 只体检，不动磁盘
node tools/bootstrap.mjs rvc            # 复制 RVC 代码（3 MB）
node tools/bootstrap.mjs models --download   # 下载 909 MB 权重并校验 sha256
node tools/bootstrap.mjs venv           # 建 Python 运行时
node tools/bootstrap.mjs verify
```

装完长这样：

```
<数据目录>/runtime/
  rvc/     ← 代码 + 权重（assets/weights、assets/rmvpe、assets/hubert_base、logs/<实验>）
  venv/    ← Python 运行时
```

**配置里那四个路径框全部留空 = 自托管**，什么都不用改。
已经有一份外部 RVC 项目的开发者，把 `worker.rvcRoot` / `worker.pythonPath` 填上就切回外部模式。

本机已经跑通过 RVC 的，直接迁移最快（硬链接，不占空间）：

```bash
node tools/bootstrap.mjs all --link     # 代码 + 权重
node tools/bootstrap.mjs venv           # 复制现有 venv，自动补 demucs
```

## 控制台四个页

| 页 | 干什么 |
|---|---|
| **安装与运行时** | 状态卡片（代码/权重/运行时/ffmpeg）+ 上面的三个安装按钮 |
| **训练数据** | 选素材 → 分离 → 切片 → 音域权重 → 特征 → 训练，一整条流水线 |
| **模型** | `assets/weights` 下所有模型：实验名、轮次、大小、有无索引，一键切换/删除/导入 |
| **作品库** | 她唱过的每一首：试听、改名、删除、打开目录、排序过滤 |

另外有一栏**环境提示词**：她"怎么用唱歌工具"的说明，可以直接在面板里改，
改动写到 `<Coo 根>/worlds/fish-sing/ENV_PROMPT.md`，**升级插件不会覆盖**（删掉即回退默认）。

## 训练自己的音色

「训练数据」页六步，全程点按钮：

| 步骤 | 做什么 | 说明 |
|---|---|---|
| ① 选素材 | 粘贴文件夹或文件路径 → 扫描 | 直接读本机磁盘，不复制；自动认「已是干声」还是「含伴奏」 |
| ② 分离 | demucs 出人声 | 只留干声，伴奏当场删掉（一首省 40 MB） |
| ③ 切片 | 按乐句自适应切 2–4.5 秒 | 不用固定 3.7 秒硬切；同时算每片的 F0 中位 / p90 |
| ④ 音域权重 | 四档滑块 + 8 个预设 | 见下 |
| ⑤ 特征 | F0 → ContentVec → faiss 索引 | 已有就跳过，可勾「重算特征」 |
| ⑥ 训练 | 轮次 / batch / 存档间隔 | 实时进度 + loss 曲线，可随时停 |

### 音域权重是怎么生效的

RVC 本来是**均匀采样**：唱得高的片和唱得低的片被抽中的概率一样。面板把它改成**按档位偏置**：

- 改的是 `DistributedBucketSampler` 的桶内抽样（`torch.multinomial` 有放回）
- **每轮步数不变、显存占用不变**——不会因为加权让训练从 3 小时变成 9 小时
- 权重全为 1 时走官方原路径，和没加权逐位一致
- 实测：某档 2 倍权重，该档占比从 12% → 29%，等效时长翻倍

三种分档口径：

| 口径 | 判据 | 适合 |
|---|---|---|
| 按主音域 | 片段 F0 中位 | 补低音（男歌） |
| 按最高音 | 片段 F0 p90 | 补高音（高音发虚） |
| 两端兼顾 | 主音域 <280 算低音；否则 p90 ≥540 算高音 | 同时扩下限和上限 |

预设八个：均衡基线 / 补低音 / 微调高音 / 补高音 / 两端都补 / 守住中音 / 高音冲刺 / 压住低音，
每个都写着「治什么毛病、代价是什么」。滑块范围 0.5x–5x。

### 在已有模型上补音域

「已有模型」下拉选一个本机训练过的实验 → 点「导入已训练模型的数据」，
它 `logs/<exp>/0_gt_wavs` 里的切片会**硬链接**成数据集（不占空间），
然后勾着「追加到当前数据集」把新素材加进去，音域分布和权重按合并后的总量重算。

> 前提：那个实验的切片还在。清理过 `logs/<exp>/0_gt_wavs` 就只能从原始音频重建。
> 用本插件建的会保留 `sep/vocals.wav`，不会丢。

### 训练时的边界

- **独占显存**：训练期间唱歌会被直接拒绝（不是排队），提示「正在训练，这会儿唱不了」
- **可暂停**：停下后最近的 `G_xxx.pth` 还在，勾「从上次存档继续」接着练
- **重启桌宠不会中断训练**：退出只对唱歌任务发取消；训练中连 worker 一起留着
- **重启后看得到进度**：实验名存在 `<dataDir>/train.json`；万一没有，会自动去扫
  哪个实验的日志最近还在写（孤儿进程也逃不掉）。数字来自磁盘上的 train.log，每 3 秒刷新
- **重启后还能停**：`/stop` 取消的是 worker 当前任务，跟谁提交的无关
- **不自动切换**：训练完的模型只出现在「模型」页，自己挑一档试听

### 中间档不会自动删

每 N 轮导出一个 53 MB 的小模型，200 轮就是 **20 个 / 约 1.06 GB**，训练完**不会**自己清理
（忘记点就一直留着）。想自动清就勾「训练完自动清理中间档」。
手动清理在训练页底部：「中间档：N 个 · X MB」+「每 N 轮留一个」+「清理中间档」，两步确认：

- 只删 `assets/weights/<exp>_eN_sX.pth` 这类导出的小模型
- **不动**：最终模型 `<exp>.pth`、续训用的 `logs/<exp>/G_2333333.pth` 与 `D_2333333.pth`、
  唱歌要加载的 `.index`
- 顺手清掉 `logs/<exp>/total_fea.npy`（建索引的汇总，200~300 MB，重建时会自动再生成）

`logs/<exp>/` 里的 `0_gt_wavs`、`3_feature768` 也不小，但续训时跳过重新提取全靠它们，别删。

## 工具（她怎么调用）

| 工具 | 作用 |
|---|---|
| `fish_sing` | 唱一首。`song` = 歌名 / BV 号 / 本地路径；`to` = `local` / `group:<群号>` / `private:<QQ号>` / `both` |
| `fish_sing_stop` | 停掉播放并取消正在处理的歌 |
| `fish_sing_library` | 列出 / 回放 / 删除唱过的歌 |
| `fish_sing_status` | 模型、队列、当前进度 |

只唱副歌（顺便绕开 QQ 60 秒限制）：

```
fish_sing(song="我不难过", start=95, duration=30, to="group:123456")
```

不确定 B 站上哪条视频对，先让她自己看候选再挑：

```
fish_sing(song="晴天 女声翻唱", search=true)   # 只搜索不下歌，返回标题/时长/UP主/BV
fish_sing(song="晴天 女声翻唱", pick=3)        # 指定第 3 条
```

> 男声原调的歌她唱不了（模型只学过女声音域）。遇到就找女声翻唱版，
> 别用 `pitch` 硬顶——那只会把音色拉走样。

## 命令行（不起桌宠也能用）

```bash
cd worker
D:\AI\rvc\venv\Scripts\python.exe cli.py "D:\AI\孙燕姿 - 我不难过.mp3" --play
D:\AI\rvc\venv\Scripts\python.exe cli.py in.mp3 --mode vocals --out 清唱.mp3
D:\AI\rvc\venv\Scripts\python.exe cli.py in.mp3 --start 95 --duration 30 --out 副歌.mp3
```

## 目录结构

```
vendor/rvc/     RVC 代码副本（MIT，随包分发，改动记在 UPSTREAM.md）
assets/models.manifest.json   权重清单（名称 / 大小 / sha256 / 落盘路径）
dist/webui-<hash>.js          控制台面板（手写 ESM，无构建链；改完跑 tools/bundle-webui.mjs）
src/
  index.ts / definition.ts    入口与 WorldDefinition
  config.ts / paths.ts        配置段与路径解析（自托管 / 外部 RVC）
  world.ts                    World 类：工具、环境提示词、四个面板
  sing.ts                     编排：找源 → 换声 → 投递
  bili.ts                     B 站搜索 / 打分 / 取音频流 / 下载
  audio.ts / deliver.ts       ffmpeg 处理、本机播放与 OneBot 发送
  library.ts / models.ts      作品库、模型管理
  train.ts                    数据集统计、音域权重、训练日志解析、中间档清理
  setup.ts / worker.ts        安装流程、与 worker 的通信（自动拉起 / 轮询 / 取消）
worker/
  engine.py     RVC 常驻推理 + 切片 + 混音
  server.py     HTTP：/health /job /job/<id> /current /scan /stop /doctor
  dataset.py    素材扫描、分离、自适应切片、质检、manifest
  trainer.py    F0 → ContentVec → 索引 → 训练（按音域加权）
  separate.py   demucs 分离（自带，不依赖外部项目）
  cli.py        一条命令跑完整条链
tools/
  doctor.mjs            自检
  install.mjs           安装到桌宠
  bootstrap.mjs         运行时与权重安装（幂等）
  upload-release.mjs    维护者：发布权重到 GitHub Release
  bundle-webui.mjs      维护者：给面板产物加内容哈希
```

## 排障

```bash
node tools/doctor.mjs                                  # 扩展结构 + 路径 + torch/CUDA + worker
cd worker && D:\AI\rvc\venv\Scripts\python.exe engine.py   # 只查推理环境
node tools/bootstrap.mjs                               # 查运行时缺什么
```

几个踩过的坑，写在代码注释里了：

- **长音频必须切片**：整段喂 RVC 会一次性过 encoder（注意力 O(n²)），
  5 分钟的歌实测跑 10 分钟不结束、内存涨到 13 GB。切片后 6 片共 76 秒跑完
- **子进程输出不能走管道**：Windows 管道只有 64 KB，写满就永久阻塞。
  分离和训练的输出都改成写文件了
- **面板产物必须带哈希命名**：文件名不变时浏览器一直用旧缓存，
  改完面板不换名，重启桌宠也还是旧的
- **一个队列一个线程**：只有一张显卡，两个 torch 进程同时抢会双双卡死

## 许可

MIT。RVC / demucs / ContentVec 各自遵循其原始许可；
用别人的声音训练模型前请确认授权——**音色也有权利**。
