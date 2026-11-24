# AI 动作检索前后对比报告（`rn (v1)` vs `server_v2 (v2)`）

> 注：所有成对比较基于同一次 VLM 识别输出（Paired Single-VLM），已剥离 VLM 随机波动。`v2` 的 `Top-5` 严格按前 5 名截断计分以保证公平性；`v1` 与 `v2` 非对偶指标（如服务端 `Recall@75`/`RRF@30`/`Top-10` 与客户端 `Recall@5`）分别以 `N/A (仅 v1/仅 v2)` 单列展示。

## 1. 四档提示梯度总览（对称指标对比）

| 梯度 | 有效样本 | 平台 | Top-1 | Strict Top-1 | Top-5 | MRR@5 | nDCG@5 | Wrong-High | WrongEq | WrongBP | BadImage-FP | NearOOD-FP | 延迟 P50 / P95 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `photo-only` | 32 (err=0) | `v1` | 9/25 (36.0%) | 7/25 (28.0%) | 13/25 (52.0%) | 0.440 | 0.348 | 7/32 (21.9%) | 3/25 (12.0%) | 12/25 (48.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 66ms / 142ms |
| `photo-only` | 32 (err=0) | `v2` | 2/25 (8.0%) | 1/25 (4.0%) | 4/25 (16.0%) | 0.107 | 0.073 | 16/32 (50.0%) | 4/25 (16.0%) | 16/25 (64.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 2260ms / 2826ms |
| `photo-only` Δ | - | **`v2-v1`** | -28pp ⚠️ | -24pp ⚠️ | -36pp ⚠️ | -0.333 ⚠️ | -0.276 ⚠️ | +28.1pp ⚠️ | +4pp ⚠️ | +16pp ⚠️ | 0pp | 0pp | +2194ms / +2684ms |
| `simple` | 32 (err=0) | `v1` | 19/25 (76.0%) | 17/25 (68.0%) | 19/25 (76.0%) | 0.760 | 0.593 | 5/32 (15.6%) | 3/25 (12.0%) | 0/25 (0.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 51ms / 127ms |
| `simple` | 32 (err=0) | `v2` | 3/25 (12.0%) | 1/25 (4.0%) | 8/25 (32.0%) | 0.213 | 0.147 | 23/32 (71.9%) | 14/25 (56.0%) | 5/25 (20.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 2276ms / 2943ms |
| `simple` Δ | - | **`v2-v1`** | -64pp ⚠️ | -64pp ⚠️ | -44pp ⚠️ | -0.547 ⚠️ | -0.446 ⚠️ | +56.3pp ⚠️ | +44pp ⚠️ | +20pp ⚠️ | 0pp | 0pp | +2225ms / +2816ms |
| `alias` | 32 (err=0) | `v1` | 21/25 (84.0%) | 19/25 (76.0%) | 21/25 (84.0%) | 0.840 | 0.668 | 4/32 (12.5%) | 2/25 (8.0%) | 0/25 (0.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 61ms / 135ms |
| `alias` | 32 (err=0) | `v2` | 9/25 (36.0%) | 7/25 (28.0%) | 13/25 (52.0%) | 0.403 | 0.344 | 18/32 (56.3%) | 6/25 (24.0%) | 3/25 (12.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 2399ms / 2883ms |
| `alias` Δ | - | **`v2-v1`** | -48pp ⚠️ | -48pp ⚠️ | -32pp ⚠️ | -0.437 ⚠️ | -0.323 ⚠️ | +43.8pp ⚠️ | +16pp ⚠️ | +12pp ⚠️ | 0pp | 0pp | +2338ms / +2748ms |
| `detailed` | 32 (err=0) | `v1` | 18/25 (72.0%) | 18/25 (72.0%) | 21/25 (84.0%) | 0.780 | 0.636 | 5/32 (15.6%) | 3/25 (12.0%) | 0/25 (0.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 61ms / 153ms |
| `detailed` | 32 (err=0) | `v2` | 5/25 (20.0%) | 2/25 (8.0%) | 12/25 (48.0%) | 0.299 | 0.195 | 22/32 (68.8%) | 3/25 (12.0%) | 7/25 (28.0%) | 5/6 (83.3%) | 1/1 (100.0%) | 2572ms / 3075ms |
| `detailed` Δ | - | **`v2-v1`** | -52pp ⚠️ | -64pp ⚠️ | -36pp ⚠️ | -0.481 ⚠️ | -0.442 ⚠️ | +53.2pp ⚠️ | 0pp | +28pp ⚠️ | 0pp | 0pp | +2511ms / +2922ms |

## 2. 消歧覆盖与多合法动作共现（对称对比）

| 梯度 | `v1` 歧义组消歧率 (非High) | `v2` 歧义组消歧率 (非High) | `v1` 清晰组打扰率 | `v2` 清晰组打扰率 | `v1` 二合一双动作共现 | `v2` 二合一双动作共现 | `v1` Coverage / Precision | `v2` Coverage / Precision |
|---|---|---|---|---|---|---|---|---|
| `photo-only` | 8/9 (88.9%) / 6/9 (66.7%) | 7/9 (77.8%) / 2/9 (22.2%) | 5/9 (55.6%) | 5/9 (55.6%) | 3/23 (13.0%) | 2/23 (8.7%) | 25/25 (100.0%) / 9/25 (36.0%) | 25/25 (100.0%) / 2/25 (8.0%) |
| `simple` | 6/9 (66.7%) / 4/9 (44.4%) | 9/9 (100.0%) / 0/9 (0.0%) | 2/9 (22.2%) | 9/9 (100.0%) | 3/23 (13.0%) | 3/23 (13.0%) | 25/25 (100.0%) / 19/25 (76.0%) | 25/25 (100.0%) / 3/25 (12.0%) |
| `alias` | 7/9 (77.8%) / 5/9 (55.6%) | 9/9 (100.0%) / 0/9 (0.0%) | 4/9 (44.4%) | 5/9 (55.6%) | 5/23 (21.7%) | 7/23 (30.4%) | 25/25 (100.0%) / 21/25 (84.0%) | 25/25 (100.0%) / 9/25 (36.0%) |
| `detailed` | 4/9 (44.4%) / 4/9 (44.4%) | 7/9 (77.8%) / 0/9 (0.0%) | 2/9 (22.2%) | 6/9 (66.7%) | 3/23 (13.0%) | 3/23 (13.0%) | 25/25 (100.0%) / 18/25 (72.0%) | 25/25 (100.0%) / 5/25 (20.0%) |

## 3. 非对称诊断指标（各版本专属，不强行求差）

| 梯度 | `v1` 本地 Recall@5 (仅 v1) | `v2` Top-10 (仅 v2) | `v2` MRR@10 (仅 v2) | `v2` 文本@75 (仅 v2) | `v2` 向量@75 (仅 v2) | `v2` RRF@30 (仅 v2) | `v2` 空例短路拒识率 (仅 v2) | `v2` 分阶段 P50 (text/vec/fuse/rerank) |
|---|---|---|---|---|---|---|---|---|
| `photo-only` | 14/25 (56.0%) | 8/25 (32.0%) | 0.128 | 17/25 (68.0%) | 20/25 (80.0%) | 16/25 (64.0%) | 1/7 (14.3%) | 94ms / 53ms / 0ms / 2135ms |
| `simple` | 21/25 (84.0%) | 13/25 (52.0%) | 0.241 | 22/25 (88.0%) | 22/25 (88.0%) | 22/25 (88.0%) | 1/7 (14.3%) | 120ms / 55ms / 0ms / 2081ms |
| `alias` | 24/25 (96.0%) | 16/25 (64.0%) | 0.420 | 25/25 (100.0%) | 25/25 (100.0%) | 25/25 (100.0%) | 1/7 (14.3%) | 132ms / 57ms / 0ms / 2218ms |
| `detailed` | 23/25 (92.0%) | 16/25 (64.0%) | 0.322 | 25/25 (100.0%) | 24/25 (96.0%) | 25/25 (100.0%) | 1/7 (14.3%) | 112ms / 53ms / 0ms / 2408ms |

## 4. 按样本组切片对照

### 4.1 `photo-only` 切片

| 组别 | `v1` Top-1 / Top-5 / FP | `v2` Top-1 / Top-5 / Top-10 / FP | `v2` Wrong-High | `v2` 文本@75 / 向量@75 / RRF@30 |
|---|---|---|---|---|
| `standard_positive` | 2/9 (22.2%) / 4/9 (44.4%) / - | 0/9 (0.0%) / 0/9 (0.0%) / 2/9 (22.2%) / - | 4/9 (44.4%) | 5/9 (55.6%) / 7/9 (77.8%) / 5/9 (55.6%) |
| `hard_confusing` | 5/9 (55.6%) / 6/9 (66.7%) / - | 1/9 (11.1%) / 2/9 (22.2%) / 4/9 (44.4%) / - | 5/9 (55.6%) | 7/9 (77.8%) / 8/9 (88.9%) / 7/9 (77.8%) |
| `cross_domain_occlusion` | 2/7 (28.6%) / 3/7 (42.9%) / - | 1/7 (14.3%) / 2/7 (28.6%) / 2/7 (28.6%) / - | 4/8 (50.0%) | 5/7 (71.4%) / 5/7 (71.4%) / 4/7 (57.1%) |
| `near_ood` | - / - / 1/1 (100.0%) | - / - / - / 1/1 (100.0%) | 1/1 (100.0%) | N/A |
| `bad_image` | - / - / 4/5 (80.0%) | - / - / - / 4/5 (80.0%) | 2/5 (40.0%) | N/A |

### 4.2 `simple` 切片

| 组别 | `v1` Top-1 / Top-5 / FP | `v2` Top-1 / Top-5 / Top-10 / FP | `v2` Wrong-High | `v2` 文本@75 / 向量@75 / RRF@30 |
|---|---|---|---|---|
| `standard_positive` | 7/9 (77.8%) / 7/9 (77.8%) / - | 0/9 (0.0%) / 2/9 (22.2%) / 2/9 (22.2%) / - | 9/9 (100.0%) | 8/9 (88.9%) / 8/9 (88.9%) / 8/9 (88.9%) |
| `hard_confusing` | 8/9 (88.9%) / 8/9 (88.9%) / - | 3/9 (33.3%) / 3/9 (33.3%) / 6/9 (66.7%) / - | 6/9 (66.7%) | 8/9 (88.9%) / 8/9 (88.9%) / 8/9 (88.9%) |
| `cross_domain_occlusion` | 4/7 (57.1%) / 4/7 (57.1%) / - | 0/7 (0.0%) / 3/7 (42.9%) / 5/7 (71.4%) / - | 7/8 (87.5%) | 6/7 (85.7%) / 6/7 (85.7%) / 6/7 (85.7%) |
| `near_ood` | - / - / 1/1 (100.0%) | - / - / - / 1/1 (100.0%) | 1/1 (100.0%) | N/A |
| `bad_image` | - / - / 4/5 (80.0%) | - / - / - / 4/5 (80.0%) | 0/5 (0.0%) | N/A |

### 4.3 `alias` 切片

| 组别 | `v1` Top-1 / Top-5 / FP | `v2` Top-1 / Top-5 / Top-10 / FP | `v2` Wrong-High | `v2` 文本@75 / 向量@75 / RRF@30 |
|---|---|---|---|---|
| `standard_positive` | 8/9 (88.9%) / 8/9 (88.9%) / - | 4/9 (44.4%) / 5/9 (55.6%) / 6/9 (66.7%) / - | 5/9 (55.6%) | 9/9 (100.0%) / 9/9 (100.0%) / 9/9 (100.0%) |
| `hard_confusing` | 8/9 (88.9%) / 8/9 (88.9%) / - | 2/9 (22.2%) / 5/9 (55.6%) / 6/9 (66.7%) / - | 7/9 (77.8%) | 9/9 (100.0%) / 9/9 (100.0%) / 9/9 (100.0%) |
| `cross_domain_occlusion` | 5/7 (71.4%) / 5/7 (71.4%) / - | 3/7 (42.9%) / 3/7 (42.9%) / 4/7 (57.1%) / - | 4/8 (50.0%) | 7/7 (100.0%) / 7/7 (100.0%) / 7/7 (100.0%) |
| `near_ood` | - / - / 1/1 (100.0%) | - / - / - / 1/1 (100.0%) | 1/1 (100.0%) | N/A |
| `bad_image` | - / - / 4/5 (80.0%) | - / - / - / 4/5 (80.0%) | 1/5 (20.0%) | N/A |

### 4.4 `detailed` 切片

| 组别 | `v1` Top-1 / Top-5 / FP | `v2` Top-1 / Top-5 / Top-10 / FP | `v2` Wrong-High | `v2` 文本@75 / 向量@75 / RRF@30 |
|---|---|---|---|---|
| `standard_positive` | 6/9 (66.7%) / 8/9 (88.9%) / - | 2/9 (22.2%) / 3/9 (33.3%) / 5/9 (55.6%) / - | 7/9 (77.8%) | 9/9 (100.0%) / 9/9 (100.0%) / 9/9 (100.0%) |
| `hard_confusing` | 8/9 (88.9%) / 8/9 (88.9%) / - | 2/9 (22.2%) / 7/9 (77.8%) / 8/9 (88.9%) / - | 7/9 (77.8%) | 9/9 (100.0%) / 9/9 (100.0%) / 9/9 (100.0%) |
| `cross_domain_occlusion` | 4/7 (57.1%) / 5/7 (71.4%) / - | 1/7 (14.3%) / 2/7 (28.6%) / 3/7 (42.9%) / - | 6/8 (75.0%) | 7/7 (100.0%) / 6/7 (85.7%) / 7/7 (100.0%) |
| `near_ood` | - / - / 1/1 (100.0%) | - / - / - / 1/1 (100.0%) | 1/1 (100.0%) | N/A |
| `bad_image` | - / - / 4/5 (80.0%) | - / - / - / 4/5 (80.0%) | 1/5 (20.0%) | N/A |

## 5. 置信度分档校准（Calibration）与 `v2` Rerank 分数分布

| 梯度 | `v1` high / medium / low 准确率 | `v2` high / medium / low 准确率 | `v2` 命中样本 Score (min/p50/max) | `v2` 错判正例 Score (min/p50/max) | `v2` 反例误报 Score (min/p50/max) |
|---|---|---|---|---|---|
| `photo-only` | 5/12 (41.7%) · 4/19 (21.1%) · 0/0 (-) | 1/17 (5.9%) · 1/7 (14.3%) · 0/7 (0.0%) | n=2: 0.5132/0.5132/0.9833 | n=23: 0.0806/0.8338/0.9917 | n=6: 0.1006/0.703/0.8674 |
| `simple` | 13/18 (72.2%) · 6/13 (46.2%) · 0/0 (-) | 3/26 (11.5%) · 0/3 (0.0%) · 0/2 (0.0%) | n=3: 0.9427/0.9909/0.9978 | n=22: 0.8176/0.9847/0.9967 | n=6: 0.0255/0.5252/0.987 |
| `alias` | 13/17 (76.5%) · 8/14 (57.1%) · 0/0 (-) | 9/27 (33.3%) · 0/1 (0.0%) · 0/3 (0.0%) | n=9: 0.9649/0.997/0.9981 | n=16: 0.923/0.9954/0.9997 | n=6: 0.1322/0.3201/0.9974 |
| `detailed` | 14/19 (73.7%) · 4/12 (33.3%) · 0/0 (-) | 5/27 (18.5%) · 0/1 (0.0%) · 0/3 (0.0%) | n=5: 0.9847/0.9952/0.9992 | n=20: 0.9743/0.9989/0.9999 | n=6: 0.0817/0.3839/0.9997 |

## 6. 同动作家族跨视角/跨加载方式一致率（以 `photo-only` 为例）

| 动作家族 | 样本数 | `v1` 命中 / 全对 | `v2` 命中 / 全对 |
|---|---:|---|---|
| `chest-press` | 3 | 2/3 (部分) | 0/3 (部分) |
| `hack-squat` | 2 | 0/2 (部分) | 0/2 (部分) |
| `hip-abduction` | 2 | 0/2 (部分) | 0/2 (部分) |
| `incline-chest-press` | 2 | 0/2 (部分) | 1/2 (部分) |
| `leg-press` | 3 | 3/3 (全对) | 1/3 (部分) |
| `seated-leg-curl` | 2 | 1/2 (部分) | 0/2 (部分) |
| `seated-row` | 2 | 1/2 (部分) | 0/2 (部分) |
| `shoulder-press` | 2 | 0/2 (部分) | 0/2 (部分) |

## 7. 逐样本成对变化归因（`v1` vs `v2`）

### 7.1 `photo-only`：翻正 1 例 / 翻错 8 例

| 方向 | ID | 分组 / 家族 | `v1` 首名 (档位) | `v2` 首名 (档位 · 分数) | `v2` 期望排位 | `v2` 漏斗 (Text75/Vec75/RRF30) |
|---|---|---|---|---|---:|---|
| ✅ 翻正 | `machine_016` | `cross_domain_occlusion` / `incline-chest-press` | `0603` (medium) | `1299` (medium · 0.5131924152374268) | 1 | true/true/true |
| ❌ 翻错 | `machine_001` | `standard_positive` / `chest-press` | `0576` (high) | `2659` (high · 0.8338228464126587) | - | true/true/true |
| ❌ 翻错 | `machine_004` | `standard_positive` / `seated-row` | `1350` (high) | `2662` (low · 0.4860023260116577) | 8 | true/true/true |
| ❌ 翻错 | `machine_008` | `hard_confusing` / `leg-press` | `0739` (medium) | `2267` (high · 0.9916883111000061) | - | true/true/true |
| ❌ 翻错 | `machine_009` | `hard_confusing` / `hip-adduction` | `0597` (medium) | `2663` (high · 0.8559790253639221) | 7 | true/true/true |
| ❌ 翻错 | `machine_011` | `hard_confusing` / `seated-leg-curl` | `0585` (high) | `1869` (high · 0.9498285055160522) | - | true/true/true |
| ❌ 翻错 | `machine_018` | `cross_domain_occlusion` / `chest-press` | `0576` (high) | `2664` (medium · 0.7702687382698059) | - | true/true/true |
| ❌ 翻错 | `machine_021` | `cross_domain_occlusion` / `leg-press` | `0739` (medium) | `1425` (high · 0.9314767718315125) | 3 | true/true/true |
| ❌ 翻错 | `machine_024` | `hard_confusing` / `smith-machine` | `0770` (high) | `0652` (low · 0.10508879274129868) | - | true/true/true |

### 7.2 `simple`：翻正 0 例 / 翻错 16 例

| 方向 | ID | 分组 / 家族 | `v1` 首名 (档位) | `v2` 首名 (档位 · 分数) | `v2` 期望排位 | `v2` 漏斗 (Text75/Vec75/RRF30) |
|---|---|---|---|---|---:|---|
| ❌ 翻错 | `machine_001` | `standard_positive` / `chest-press` | `0576` (high) | `1073` (high · 0.9624778032302856) | 2 | true/true/true |
| ❌ 翻错 | `machine_002` | `standard_positive` / `incline-chest-press` | `1299` (high) | `1289` (high · 0.9694700241088867) | - | true/true/true |
| ❌ 翻错 | `machine_003` | `standard_positive` / `shoulder-press` | `0603` (high) | `0360` (high · 0.9447024464607239) | 3 | true/true/true |
| ❌ 翻错 | `machine_004` | `standard_positive` / `seated-row` | `1350` (high) | `1453` (high · 0.8175730109214783) | - | true/true/true |
| ❌ 翻错 | `machine_005` | `standard_positive` / `leg-extension` | `0585` (high) | `2100` (high · 0.9897294044494629) | - | true/true/true |
| ❌ 翻错 | `machine_006` | `standard_positive` / `seated-leg-curl` | `0599` (high) | `4456` (high · 0.9948773980140686) | - | true/true/true |
| ❌ 翻错 | `machine_008` | `hard_confusing` / `leg-press` | `0739` (medium) | `2951` (high · 0.9936830997467041) | - | true/true/true |
| ❌ 翻错 | `machine_012` | `hard_confusing` / `chest-press` | `0576` (high) | `10672` (high · 0.9190342426300049) | 7 | true/true/true |
| ❌ 翻错 | `machine_013` | `hard_confusing` / `shoulder-press` | `0603` (high) | `2318` (high · 0.9868797063827515) | 7 | true/true/true |
| ❌ 翻错 | `machine_014` | `hard_confusing` / `seated-row` | `1350` (medium) | `1454` (high · 0.9855755567550659) | 7 | true/true/true |
| ❌ 翻错 | `machine_015` | `hard_confusing` / `leg-press` | `0739` (medium) | `2611` (high · 0.9846944212913513) | - | true/true/true |
| ❌ 翻错 | `machine_016` | `cross_domain_occlusion` / `incline-chest-press` | `1299` (high) | `1195` (high · 0.9915956854820251) | 2 | true/true/true |
| ❌ 翻错 | `machine_018` | `cross_domain_occlusion` / `chest-press` | `0576` (high) | `1073` (high · 0.9661548137664795) | 2 | true/true/true |
| ❌ 翻错 | `machine_019` | `cross_domain_occlusion` / `hip-abduction` | `0597` (medium) | `0710` (high · 0.9878652691841125) | 2 | true/true/true |
| ❌ 翻错 | `machine_021` | `cross_domain_occlusion` / `leg-press` | `0739` (medium) | `2749` (high · 0.9670055508613586) | 10 | true/true/true |
| ❌ 翻错 | `machine_023` | `standard_positive` / `chest-fly` | `1030` (high) | `0602` (high · 0.9920152425765991) | - | true/true/true |

### 7.3 `alias`：翻正 0 例 / 翻错 12 例

| 方向 | ID | 分组 / 家族 | `v1` 首名 (档位) | `v2` 首名 (档位 · 分数) | `v2` 期望排位 | `v2` 漏斗 (Text75/Vec75/RRF30) |
|---|---|---|---|---|---:|---|
| ❌ 翻错 | `machine_002` | `standard_positive` / `incline-chest-press` | `1299` (high) | `0576` (high · 0.9985734224319458) | 6 | true/true/true |
| ❌ 翻错 | `machine_004` | `standard_positive` / `seated-row` | `1350` (high) | `0571` (high · 0.9993353486061096) | 3 | true/true/true |
| ❌ 翻错 | `machine_006` | `standard_positive` / `seated-leg-curl` | `0599` (high) | `0595` (high · 0.997840166091919) | - | true/true/true |
| ❌ 翻错 | `machine_007` | `standard_positive` / `hack-squat` | `0743` (medium) | `2749` (high · 0.9964733719825745) | - | true/true/true |
| ❌ 翻错 | `machine_008` | `hard_confusing` / `leg-press` | `0739` (medium) | `1027` (high · 0.9939051270484924) | - | true/true/true |
| ❌ 翻错 | `machine_009` | `hard_confusing` / `hip-adduction` | `0598` (medium) | `0585` (high · 0.9939215183258057) | 4 | true/true/true |
| ❌ 翻错 | `machine_010` | `hard_confusing` / `hip-abduction` | `0598` (medium) | `0710` (high · 0.9970861077308655) | - | true/true/true |
| ❌ 翻错 | `machine_011` | `hard_confusing` / `seated-leg-curl` | `0585` (high) | `1385` (high · 0.999687671661377) | - | true/true/true |
| ❌ 翻错 | `machine_013` | `hard_confusing` / `shoulder-press` | `0603` (high) | `0584` (high · 0.9738340973854065) | 4 | true/true/true |
| ❌ 翻错 | `machine_015` | `hard_confusing` / `leg-press` | `0739` (high) | `0760` (high · 0.9960534572601318) | 4 | true/true/true |
| ❌ 翻错 | `machine_016` | `cross_domain_occlusion` / `incline-chest-press` | `1299` (high) | `10669` (high · 0.9953528642654419) | - | true/true/true |
| ❌ 翻错 | `machine_021` | `cross_domain_occlusion` / `leg-press` | `0739` (medium) | `2267` (high · 0.9807941913604736) | 9 | true/true/true |

### 7.4 `detailed`：翻正 0 例 / 翻错 13 例

| 方向 | ID | 分组 / 家族 | `v1` 首名 (档位) | `v2` 首名 (档位 · 分数) | `v2` 期望排位 | `v2` 漏斗 (Text75/Vec75/RRF30) |
|---|---|---|---|---|---:|---|
| ❌ 翻错 | `machine_001` | `standard_positive` / `chest-press` | `0576` (high) | `5815` (high · 0.9946657419204712) | 5 | true/true/true |
| ❌ 翻错 | `machine_002` | `standard_positive` / `incline-chest-press` | `1299` (high) | `0590` (high · 0.99837327003479) | - | true/true/true |
| ❌ 翻错 | `machine_006` | `standard_positive` / `seated-leg-curl` | `0599` (high) | `11567` (high · 0.9991359114646912) | - | true/true/true |
| ❌ 翻错 | `machine_009` | `hard_confusing` / `hip-adduction` | `0598` (high) | `2335` (high · 0.9978829026222229) | 2 | true/true/true |
| ❌ 翻错 | `machine_011` | `hard_confusing` / `seated-leg-curl` | `0599` (high) | `3760` (high · 0.9991021156311035) | - | true/true/true |
| ❌ 翻错 | `machine_012` | `hard_confusing` / `chest-press` | `0576` (high) | `10672` (high · 0.9987275004386902) | 5 | true/true/true |
| ❌ 翻错 | `machine_013` | `hard_confusing` / `shoulder-press` | `0603` (high) | `10669` (high · 0.9960880279541016) | 3 | true/true/true |
| ❌ 翻错 | `machine_015` | `hard_confusing` / `leg-press` | `0739` (medium) | `2951` (high · 0.999896764755249) | 9 | true/true/true |
| ❌ 翻错 | `machine_016` | `cross_domain_occlusion` / `incline-chest-press` | `1299` (high) | `2277` (high · 0.9958005547523499) | - | true/true/true |
| ❌ 翻错 | `machine_018` | `cross_domain_occlusion` / `chest-press` | `0576` (high) | `2277` (high · 0.9994602799415588) | 8 | true/true/true |
| ❌ 翻错 | `machine_019` | `cross_domain_occlusion` / `hip-abduction` | `0597` (high) | `1454` (high · 0.9989193677902222) | 2 | true/true/true |
| ❌ 翻错 | `machine_023` | `standard_positive` / `chest-fly` | `1030` (high) | `2278` (high · 0.9742675423622131) | - | true/true/true |
| ❌ 翻错 | `machine_024` | `hard_confusing` / `smith-machine` | `0770` (high) | `1598` (high · 0.9998898506164551) | 2 | true/true/true |

## 8. 补充基线数据集对比（历史回放集）

| 数据集 | 样本 | `v1` Top-1 / Top-5 / Wrong-High / FP | `v2` Top-1 / Top-5 / Top-10 / Wrong-High / FP | `v2` 文本@75 / 向量@75 / RRF@30 |
|---|---|---|---|---|
| `repo13` | 13 (err=0) | 5/11 (45.5%) / 7/11 (63.6%) / 0/13 (0.0%) / 0/2 (0.0%) | 2/11 (18.2%) / 7/11 (63.6%) / 7/11 (63.6%) / 6/13 (46.2%) / 1/2 (50.0%) | 11/11 (100.0%) / 10/11 (90.9%) / 11/11 (100.0%) |

---

## 9. 核心量化结论与下一步调优建议（基于 128 条配对实测 + 13 条回放）

### 9.1 四大核心实测发现

1. **多路召回与 RRF 融合已经达标（`Recall@30` 最高 100%），瓶颈 100% 在 Cross-Encoder 精排阶段**：
   - 在 `alias` 与 `detailed` 档位下，`v2` 的文本召回 `Recall@75` 与 RRF `Recall@30` 均达到 **`25/25 (100.0%)`**，向量 `Recall@75` 达 `25/25`（`alias`）/ `24/25`（`detailed`）；在 `repo13` 历史集上，RRF `Recall@30` 也达 **`11/11 (100.0%)`**。
   - **对照 RRF 首名 vs Rerank 首名（关键归因）**：
     - `repo13`：`v1` Top-1 = `5/11 (45.5%)` → **RRF 首名 = `8/11 (72.7%)`** → 经 `bge-reranker-v2-m3` 精排后跌至 **`2/11 (18.2%)`**；
     - `detailed`：`v1` Top-1 = `18/25 (72.0%)` → **RRF 首名 = `19/25 (76.0%)`**（Strict `17/25`）→ 经精排后跌至 **`5/25 (20.0%)`**；
     - `simple`：`v1` Top-1 = `19/25 (76.0%)` → **RRF 首名 = `18/25 (72.0%)`** → 经精排后跌至 **`3/25 (12.0%)`**；
     - `alias`：`v1` Top-1 = `21/25 (84.0%)` → **RRF 首名 = `17/25 (68.0%)`** → 经精排后跌至 **`9/25 (36.0%)`**；
     - `photo-only`：`v1` Top-1 = `9/25 (36.0%)` → RRF 首名 = `6/25 (24.0%)` → 经精排后跌至 **`2/25 (8.0%)`**。
   - **根因定位**：核查 `D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts` L91–L92 可见，`rerankQuery` 仅拼接了 `hintText` + `fallback.understanding` + 裸 slug 列表，**遗漏了 VLM 识别出的动作核心名称（`candidates[i].name` / `candidates[i].nameEn`）**。这导致 Cross-Encoder 对着长描述文本（`fallback.understanding` vs `rerank_text` 中的英文说明/步骤）打分，把所有 30 个候选几乎都打到 `0.994–0.9999` 饱和区间，反而让冷门变式（如 `11567`、`5815`、`1598`、`1073`、`2277`）反超标准主动作（`0576`、`1299`、`0599`、`0770`）。

2. **置信度分档严重过自信（`Wrong-High` 从 `12.5%–21.9%` 飙升至 `50.0%–71.9%`）**：
   - `retrieval.service.ts` L111 使用硬编码阈值 `score >= 0.8 => high`、`>= 0.5 => medium`。实测在 `simple` / `alias` / `detailed` 档位下，**`v2` 错判正例的 `top1Score` 中位数高达 `0.985–0.999`**（最小值就达 `0.818–0.974`），导致 `v2` `high` 档真实准确率只有 **`5.9%–33.3%`**（而 `v1` `high` 档为 `41.7%–76.5%`），触发大面积高置信误报。

3. **下游缺少 Score Floor 与端到端拒识门控，`v1` 与 `v2` 在废片/OOD 上均呈现 `5/6` 误报**：
   - `photo-only` / `simple` / `alias` / `detailed` 四档下，6 张 `bad_image` 中有 5 张、1 张 `near_ood` 中有 1 张（共 `6/7`）在 VLM 阶段仍生成了至少 1 个候选（仅 `machine_032` 无意义天花板图触发了 VLM 短路拒识 `shortCircuited = true`）。
   - 对 `v2` 而言，一旦未在 VLM 短路，由于没有 Rerank 分数下限（`bad_image` 在 `photo-only` 下有低分 `0.101` / `0.456`，在 `detailed` 下也存在 `0.082` / `0.169` / `0.384`），`v2` 依然强制拼出 10 条推荐；甚至当背景器械被命中时出现 `0.9997` 高分误报（`machine_028`）。

4. **`v2` 在纯 `clarifications` 透传与延迟上的代价**：
   - **消歧缺失兜底**：`v1` 的 `deriveClarificationChips()` 能在 `hard_confusing` 档位结合低置信自动补齐消歧 Chip；`v2` 仅透传 VLM 的 `clarifications`，在 `simple`/`alias`/`detailed` 下虽然 `hard_confusing` 触发率 77.8%–100%，但因为 `v2` 将首项标为 `high`，导致 `clarificationNoHigh` 降为 **`0/9 (0.0%)`**（`v1` 为 `4/9`–`6/9`）。
   - **延迟代价**：`v1` 匹配 P50 `51–66ms`（P95 `127–153ms`）；`v2` 检索+精排 P50 **`2,260–2,572ms`**（P95 `2,826–3,075ms`），其中 **`bge-reranker-v2-m3` 单步就占 `2,081–2,408ms`**（占 `v2` 后处理耗时 ~92%），PG 文本召回约 `94–132ms`、本机向量约 `53–57ms`、RRF `0–1ms`。

---

### 9.2 下一步针对 `D:\wt\og-retrieval` 的高优先级调优建议

> 以下改动均可在现有已重构的配对评估脚本下用 `--mode replay` 零 VLM 成本快速迭代验证（直接读取本轮 `--save-replay` 冻结的 4 档输出即可）：

1. **P0 · 修复 `rerankQuery` 模板与精排输入长度**：将 VLM 识别出的 `candidates` 名称（优先 `nameEn` 与中文 `name`）放在 `rerankQuery` 最前部，精排文档 `rerank_text` 优先突出名称/标准别名/器械/部位/姿势并缩减冗余长步骤干扰，同时评估对 `RRF` 排名与 Cross-Encoder 分数做线性/倒数秩加权融合（`α * norm(rerank) + (1-α) * rrf_rank_score`），防止精排单独推翻已经命中的 `RRF #1`。
2. **P0 · 标定 `high / medium / low` 置信度阈值与 `level` 约束**：使用 `bge-reranker-v2-m3` 实测分值分布重标 `high` 门限（或改为基于 **Score Margin `s1 - s2` + RRF 一致性 + 器械/部位匹配度** 联合判定 `high`，而不是单看饱和到 `0.99` 的绝对分），将 `Wrong-High` 压回接近 `0%`；对 `hard_confusing` 与无名称证据命中封顶 `medium`。
3. **P1 · 增加 Rerank Score Floor 与客户端兜底对齐**：对 `top1Score` 低于阈值（如 `< 0.35`–`0.45`，结合复测分布标定）的样本丢弃低质候选并回落为 `rankedIds: []` + `fallback` 理解；并考虑在服务端补充共享 `deriveClarificationChips()` 逻辑，避免纯 `high` 标定吞掉消歧。
4. **P1 · 优化 `bge-reranker-v2-m3` 精排延迟**：将送交 Cross-Encoder 的候选池从 `30` 压缩到 `15–20`（先看 `Fusion Recall@20` 损失多少），或缩短 `rerank_text` 长度，预期可将 `rerankMs` P50 从 `~2.2s` 降至 `<1.0s`。


