# 第三方代码来源

本目录是 [Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
（MIT License, © RVC-Project）的裁剪副本，只保留推理与训练所需的模块：

- `infer/`　推理管线（VC、RMVPE、ContentVec 封装、音频读写）
- `configs/`　配置与采样率模板
- `train/`　预处理 / 特征提取 / 训练 / 建索引
- `i18n/`、`tools/`　日志与通用工具
- `webui.py`、`requirments_cu118_py312.txt`　原样保留，供排障参考
- `assets/hubert_base/*.json`　ContentVec 的模型配置（权重不随包分发）

改动：
1. 没有修改任何 RVC 源码逻辑；仅删除了与本插件无关的训练 GUI、实时变声、文档与预训练权重。
2. `assets/` 下只保留 hubert 的两个 json；`pytorch_model.bin`、`rmvpe.pt`、`pretrained_v2/*`、
   `logs/*.index` 由用户在「模型」页按 `assets/models.manifest.json` 下载（sha256 校验）。

License: MIT，全文见仓库根目录 `LICENSE`（本插件亦为 MIT）。
