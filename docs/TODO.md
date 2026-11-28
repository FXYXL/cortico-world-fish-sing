# 大肥鱼唱歌（cortico-world-fish-sing）改进待办清单

本文档记录对当前代码（v0.4.25）全面评审后整理出的 **Bug 修复** 与 **后续迭代优化** 待办项，按优先级分组推进。

---

## 一、明确 Bug 与逻辑漏洞（P0 · 优先修复）

- [x] **修复 `/current` 接口方法不匹配与重启接管训练闭环**
  - `worker/server.py` 的 `/current` 写在 `do_POST` 中，而 `src/worker.ts` 的 `currentJob()` 使用默认 `GET` 且未带鉴权头，导致永远 404 返回 `null`。
  - 修复：服务端在 `do_GET` 中也支持 `/current`（同时保留 `do_POST` 兼容旧版），并支持可选鉴权；`worker.ts` 携带鉴权头。
  - 修复 `src/world.ts` 的 `start()`：重启认回正在进行的训练后，重新挂回 `worker.wait()`，并持久化本次训练收尾配置（`pruneAfter` / `abTest` / `evaluationPaths` / `keepEvery`）到 `train.json`，确保重启后训练结束仍能更新状态、发通知、执行选模对比与清理。
- [x] **修复「安装与运行时」页「测试通知」按钮报错**
  - `dist/webui.js` 的 `mountSetup` 调用 `ctx.invoke('trainNotifyTest', [])`，但 `world.ts` 的 `setupInvoke` 未处理该方法。
  - 修复：在 `setupInvoke` 中补上 `trainNotifyTest` 分支（复用 `notifyEvent`）。
- [x] **修复换声缓存键遗漏新参数**
  - `src/library.ts` 的 `cacheKey()` 漏掉了 `rmsMixRate`、`harmony`、`harmonyGain`、`harmonyScope`，调整音量跟随或开启和声后重唱同一首歌会命中旧缓存。
  - 修复：将上述参数纳入缓存键计算，并递增 `CACHE_SCHEMA`。
- [x] **修复 `src/setup.ts` 缺少 `readdirSync` 导入**
  - `resolveSystemPython` 扫描 Windows 常见 Python 安装目录时调用了 `readdirSync` 但顶部未 import，抛出的 `ReferenceError` 被 `catch` 吞掉，导致兜底扫盘失效。
- [x] **修复 `src/worker.ts` 轮询超时失效与可选日志崩溃隐患**
  - `wait()` 中 `badSince = 0` 位于 `if (!job)` 之前，导致缺失 `job` 字段时永远不会触发 30 秒超时。
  - `maybeRestart()` 中直接调用了 `this.log.error(...)`，但 `LoggerLike.error` 为可选且 `world.ts` 未传入，连续崩溃超过 5 次会抛出 `TypeError`。
  - 清理 `JobState` 中重复声明的 `exp?: string`。
- [x] **修复 `src/world.ts` 环境提示词 `singLast` 显示歌曲时长而非“距今秒数”**
  - `envPromptVars()` 中误用了 `this.lastSong.duration`，应使用 `(Date.now() - this.lastSong.at) / 1000`（并格式化为更易读的时间描述）。
- [x] **修复 `src/sing.ts` 自动变调说明永不显示**
  - 第 345 行先将 `params.pitch` 从 `'auto'` 覆写为实际半音数，导致第 420 行 `params.pitch === 'auto' && suggest` 永远为 `false`。
- [x] **修复 `src/world.ts` 中 `saveWeights` 对 `mix` 模式文案错误**
  - 保存 `mix`（两端兼顾）模式时，提示文案误显示为「按主音域」。
- [x] **修复 `dist/webui.js` 训练页切换页签后轮询定时器泄漏**
  - `mountTrain` 的 `dispose()` 只清理了 `timer`，遗漏了 `trainTimer`。
- [x] **同步 `ENV_PROMPT.md` 与 `describe.json` 描述**
  - `ENV_PROMPT.md` 仍写着「带伴奏时人声升调、伴奏不升会跑调」，需更新为已支持整体同步变调的实际行为。
  - `describe.json` 补齐 `rmsMixRate` 参数，并将 `pitch` 更新为支持数字或 `"auto"`。

---

## 二、UI 与交互排版优化（P1）

- [x] **选模三段独立干声输入框排版与持久化**
  - 将 `evaluationInputs` 从固定 `110px` 宽的 `.fs-tin` 改为全宽输入并配低/中/高音标签；
  - 将上次填写的三段路径持久化到 `dataDir`（`<dataDir>/evaluation.json`），勾选「选模对比」或手动点击「选模素材」时展开，平时减少版面占用（并自动去除复制路径自带的首尾引号）。
- [x] **模型页「导入 .pth」去掉 `window.prompt()`**
  - 改为内联输入框，避免 Electron 环境禁用原生 `prompt`，并支持同时提示/关联对应 `.index`。
- [x] **训练页结构与交互降噪**
  - 统一「③ 高级：低音增强 / 音域加权」标题与「低音增强」复选框的实际位置；移除「② 训练」折叠体内部重复的 `训练` 标题；
  - 取消静默自动勾选「从上次存档继续」（避免 0.4.25 严格指纹校验下换实验时误报错），改为提供显式「续训 `<exp>`（已有 N 轮）」快捷按钮；
  - 权重面板的桶内抽样预估联动表单所选的 `batch` 大小（不再写死 `batch = 4`）。
- [x] **模型页与作品库信息增强**
  - 模型页按实验名筛选，支持在模型页直接按实验清理中间档；
  - 作品库列表返回并展示所用模型名（`params.model`），支持按标题或模型名过滤与排序，方便区分不同模型版本唱出的作品。
- [x] **整理面板样式注入**
  - 合并四个面板的样式为单一共享 `<style id="fish-sing-style">` 注入，消除重复注入 4 份基础 CSS 的冗余。

---

## 三、训练与推理逻辑优化（P1 / P2）

- [x] **数据集导入与切片提速**
  - `worker/dataset.py` 新增 `read_mono_fast()`，优先用 `soundfile.read` + `resample_to` 内存直读重采样，`import_experiment` 不再对几百个 `.wav` 切片逐个拉起 `ffmpeg` 子进程；
  - `build()` 合并对同一份 `vocal_wav` 的两次解码（仅解一次 40k 再降采样到 16k），并将写盘自检预期字节数修正为 `FLOAT` 对应的 4 字节/样本。
- [x] **选模对比（A/B）听感与防刷屏优化**
  - 没配置 QQ 通知目标时只记录一次提示日志，消除循环内连刷多条告警；
  - `ab_test` 按低/中/高音区额外拼接 3 条响度对齐的串联对比轨（段间 0.8s 静音）收进作品库，QQ 通知优先发送串联轨。
- [x] **B 站音源质量与混音听感提升**
  - `src/bili.ts` 改为优先选择 ≤256kbps 的高码率普通音轨，减少低码率 AAC 经分离+换声后的高频失真；
  - `worker/engine.py` 的 `mix()` 引入基于原唱分离干声有效 RMS 的响度自适应对齐，并新增可配置人声混响选项（`voice.reverb: off | light`）。
- [x] **推理耗时与中间产物缓存优化**
  - 新增分离产物缓存目录（`<dataDir>/cache/sep/<hash>/`，随 `pruneCache` 7 天过期或手动清理），换模型或调参数重唱同一首歌时跳过重复分离；
  - 定位并关闭导致多片推理第 2 片雪崩变慢的根因（`RVC_CUDA_GRAPH=0` 避免按切段 shape 捕获多份 CUDA Graph 锁死显存与跳过 `empty_cache`），默认改用常驻引擎连续推理（保留 `FISHSING_SUBPROCESS_CHUNKS=1` 回退开关）；
  - 修复子进程模式传入 `self.model_path`，解决 `ab_test` 回退 `logs/<exp>/G_xxx.pth` 时找不到模型的问题，并修正 `song()` 的进度回调嵌套。

---

## 四、更实用的功能扩展（P2）

- [x] **新增控制台「试唱 / 点歌」面板**
  - 在 WebUI 中直接输入歌名 / BV 号 / 本地路径，支持起止秒截取、`pitch / indexRate / protect / rmsMixRate / harmony` 调节、实时进度展示与一键试听。
- [x] **作品库支持「发到 QQ」与「用当前模型重唱」**
  - 作品库行操作新增「发到 QQ」与「用当前模型重唱」按钮；
  - `fish_sing_library` 工具新增可选 `to` 参数，支持直接将作品库已有音频发送到指定 QQ 群/私聊。
- [x] **数据集质检明细可视化**
  - 在「训练数据」页展示每首素材的保留率与丢弃明细（含 `f0_analysis_failed` 需复查列表），便于剔除劣质源重新切片。
- [x] **模型页展示音域统计**
  - 读取 `logs/<exp>/range.json`，在模型列表中展示各模型的音域下限 / 中位 / 上限（Hz），直观验证扩音域训练效果。

---

## 五、与桌宠深度配合的演唱与互动流程进化（P2）

- [x] **唱前 / 唱后声学体检报告（自检闭环）**
  - 利用分离干声（`vocals.wav`）与换声成品，结合模型 `range.json` 与 F0 曲线，向桌宠返回结构化分段报告：音域越界/吃力时间段、F0 剧烈跳变或疑似破音/伴奏漏音区间、副歌/主歌自动分段区间，让桌宠有据可依地评价或决定返工。
- [x] **局部返工重唱 / 补录（`fish_sing_patch`）**
  - 复用分离缓存与上一版换声人声轨，仅对指定 `[startSec, endSec]` 区间更换模型或参数（`pitch` / `indexRate` / `protect` / `rmsMixRate`）重新换声，通过交叉淡化无缝贴回原位并重新混音，支持单句返工而无需整首重跑。
- [x] **单句试唱与乐句静音边界吸附**
  - 在短片段试唱（「只唱一句」）与局部补录时，基于干声能量包络将起止时间微调吸附到前后换气/静音谷底，避免截断在字中间产生突兀截断感。
- [x] **分段换音色 / 自动主歌柔、副歌亮**
  - 复用同一份分离干声按时间轴（手动分段或自动主歌/副歌分段）套用不同音色参数或模型（如主歌轻柔、副歌明亮或切换模型），在静音边界交叉淡化无缝拼接后再统一混音。
- [x] **异步后台唱播与自然播完回调**
  - 支持非阻塞式后台准备与播放，配合随时打断/停止，并通过 `pushEvent` 在开始播放、自然播完或被中途叫停时通知桌宠，让唱中互动与唱后接话更自然。
- [x] **时间轴歌词表与唱中插话联动**
  - 为每首歌生成结构化「句号 + 起止秒 + 歌词文本」时间轴表（多级获取策略：优先本地/开源 LRC 精准歌词库或 B 站视频自带字幕轨 → 可选干声 Whisper/ASR 识别兜底 → 无歌词时退回静音切片乐句时间轴）；
  - 结合异步播放实时进度（当前唱到第几句/第几秒），支持桌宠顺着歌词情绪演绎、唱前提示音域难点，并在唱到一半响应插话（如「这句慢一点」「再来一遍副歌」「从第 7 句重来」）。

---

## 六、底层引擎与音质上限进化（P2）

- [x] **接入 UVR5 内核（`audio-separator`：RoFormer + De-Reverb 双档位分离）**
  - 在 `worker/separate.py` 中新增 `audio-separator` 可选后端（未安装时平滑回落至 `htdemucs`），按需拉取并缓存模型权重；
  - **训练数据集场景**：支持一键启用「RoFormer 人声分离 + De-Reverb 去混响（按需去伴唱和声）」，从源头净化干声，直接抬高训练模型音色上限；
  - **日常点歌场景**：提供分离档位切换（快速档 `htdemucs` / 精唱档 `RoFormer + 可选 De-Reverb`），分离缓存键纳入分离模式，首跑后调参、重唱、局部返工均 0 秒复用。
- [x] **8G 显存空闲自动释放（Idle Unload）**
  - 在 `worker/server.py` 与 `worker/engine.py` 中增加空闲卸载计时器（如空闲 10 分钟无任务自动卸载 GPU 模型并 `empty_cache()`），平时挂机几乎零显存占用，下次点歌时 4~5 秒自动拉回。
- [x] **F0 音高毛刺抑制与可选 `fcpe`**
  - 增加轻量级 F0 异常八度跳变滤波，减少偶发 1~2 帧音高飞点引起的破音/电音毛刺；
  - 开放 `fcpe` 作为 `rmvpe` 之外的可选 F0 提取器，改善极高音与气声重段落的稳定性。
- [x] **自托管分发兼容：面板检测与一键安全安装 UVR5 可选依赖（发版前提醒）**
  - 面向其他用户分发插件时，在「安装与运行时」面板增加 `audio-separator`（UVR5 精唱/去混响内核）安装状态检测与一键安装/重装提示；
  - 严格采用锁定版本 + `--no-deps` 安装策略（`audio-separator==0.30.2` 等纯辅助包），防止新版 `audio-separator` 自动拉高 `numpy>=2` 或用 CPU 版 `torch` 覆盖现有 `torch 2.7.1+cu118`。

---

## 七、下一阶段迭代规划（v0.6.x 候选方向）

- [x] **LRC 歌词前奏偏移自动校准 + 任意句跳播**
  - 基于分离干声 `vocals.wav` 首个真实人声开口时间戳与 LRC 首句对齐，自动估算并修正 B 站视频片头/加长前奏造成的时间轴整体偏移（并在面板提供 `±秒` 手动微调与持久化）；
  - 新增按句号/副歌/秒数跳播能力（`ffplay -ss`），支持直接从副歌或指定句重听，无需整首从头播放。
- [x] **点歌队列与后台无缝预热（「小歌会 / 连唱模式」）**
  - 支持轻量点歌队列（加歌、插队、切歌、清空、顺序/单曲循环）；
  - 播放第 1 首期间后台预热第 2 首的下载、分离与换声，首尾无缝衔接，并支持在切歌间隙触发事件供桌宠自然报幕串场。
- [x] **个人曲库记忆与拿手歌本（Repertoire）**
  - 在 `dataDir` 维护按曲目组织的 `repertoire.json`（与按录音文件存储的作品库互补），记录：星标拿手曲、情绪/风格标签、最佳参数配方（`model` / `pitch` / `indexRate` / `protect` / `rmsMixRate` / `harmony` / `f0Method` / `dynamicStyle` / `lrcOffsetSec`）、定稿作品 ID 与简短唱后笔记；
  - 支持「随便唱首拿手的 / 按标签挑歌」、再点老歌自动复用最佳配方（不占用常驻 `ENV_PROMPT.md` 上下文，纯按需工具查询 + 面板星标管理）。
- [x] **双音色真合唱 & RVC 模型权重融合（Fusion）**
  - 合唱/对唱模式：支持主歌 A/B 交替用不同模型演唱，副歌左右声道双模型真合唱混音；
  - 模型权重一键融合：在模型页支持将两个 `.pth` 按比例插值融合为新音色模型（秒级生成，无需重新训练）。
- [x] **音质与闭环再进阶：UVR5 去伴唱和声（Karaoke）+ 体检一键自动修补**
  - 在 `audio-separator` 精唱链路中增加可选 Karaoke 去原唱垫音/伴唱和声档位，进一步净化伴奏串音；
  - 基于声学体检报告标出的异常句（F0 跳变 / 越界吃力），提供「自动修问题句」能力，自动切 `fcpe` 或微调参数触发 `fish_sing_patch` 并无缝贴回。
