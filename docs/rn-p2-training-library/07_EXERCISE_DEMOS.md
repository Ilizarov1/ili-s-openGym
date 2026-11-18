# 07 动作演示

## 需求

用户在动作库或动作选择器里打开详情，可浏览演示，决定是否把动作加入训练。内置动作支持服务器提供的演示，自定义动作支持查看已在 Web 挂载并同步的媒体。

1. **内置演示**。已配对且服务器托管目录媒体时，含别名的动作也能展示正确静图与动画。详情中可播放和暂停，返回列表后停止播放。
2. **自定义演示**。当前账号能看已同步的图片、动图或受设备支持的视频，视频加载前可显示已有封面。动作选取、编辑与收藏仍可从原入口完成。
3. **异常与切账号**。练习模式、服务器缺素材、媒体未启用、权限失败、断网或解码失败时，按可用素材显示静图或占位，仍可选择动作。切换账号或服务器后只显示新工作区的数据与媒体。

## 实现设计

- [动作库](../../mobile-rn/src/screens/ExerciseLibraryScreen.tsx) 加独立「查看详情」操作，使用设计系统 `Screen`、`Header`、`MediaThumb` 样式和现有选择回调，保留列表原有点选逻辑。列表继续加载缩略图，只有详情按需加载演示。
- **内置资源**。沿用 [目录数据](../../catalogue/README.md) 的动作别名和文件名，以及上游 [`imgSrc/gifSrc`](../../frontend/src/lib/exercises.js) 规则。用服务器基础地址拼相对目录 `exercise-media/still/` 和 `exercise-media/clip/`。动画失败回退静图，静图不可用时用现有占位。MP4 计划使用 SDK 55 的 `expo-video`，图片和动图沿用 `expo-image`。进入详情后按需准备播放器，离开或切后台暂停，关闭详情时销毁。[Expo Video](https://docs.expo.dev/versions/v55.0.0/sdk/video/)
- **自定义资源**。读取 `customEx[].media`、可选 `poster` 和 `url`，评估 `/api/config` 的媒体能力。配对 Bearer 仅发往当前实例的 `/api/media/{hash}`。接口返回完整文件，先下载到私有临时文件，校验字节数及 SHA-256 后交给原生渲染。私有文件按服务器、账号及 hash 隔离，退出详情回收临时文件，切账号时取消旧请求并清除旧来源。外链仅在用户点击后由系统打开有效的 HTTP(S) 链接。[API 契约](../../api/openapi.yaml) · [Expo FileSystem](https://docs.expo.dev/versions/v55.0.0/sdk/filesystem/) · [Expo Crypto](https://docs.expo.dev/versions/v55.0.0/sdk/crypto/)

## 执行步骤

1. 以已接入的 [动作详情](../../mobile-rn/src/screens/ExerciseDetailScreen.tsx) 和 `expo-video` 构建 Android，核对静图、详情入口和选择回调。验证内置可播、别名解析和缺视频的静图回退。
2. 为现有 [独立 API fixture](../../mobile-rn/scripts/loopback-api.mjs) 增加媒体启用的场景，准备已入库的视频、封面和动图。核对有效 Bearer、缺文件、损坏文件和换账号，确认临时文件清理和缓存隔离。
3. 用可见模拟器验证播放、暂停、返回及切后台，再做 ARM64 真机解码检查。按 [共用验收](README.md#共用验收) 记录媒体加载结果、截图和候选 APK。

## 本地内置（非商业 Fork）

当前 RN 分支把 180 px 目录素材随客户端分发，离线也能播放：

- **静图**：`src/catalogueMedia.generated.ts` 为 5,632 个动作生成静态 `require('../../catalogue/media/still/...')`，由 Metro 打进 bundle。
- **动画**：MP4 不经过 Metro。`npm run catalogue:stage` 把它们复制到 `android/app/src/main/assets/exercise-media/clip/`，运行时用 `asset:///exercise-media/clip/<file>.mp4` 播放。这样避免 Metro 一次打开上万文件触发 Windows `EMFILE`。
- **介绍**：`src/catalogueContent.generated.json` 由 `catalogue/exercises/*.json` 和 `catalogue/i18n/zh.json` 生成，包含中文名、中文简介（按目标/协同肌群生成）和 30,709 条中文步骤；全部 5,632 个有英文步骤的动作均已翻译。
- **详情页**：内置动作优先显示本地媒体和介绍；本地缺失时才回退服务器，再回退占位。自定义动作仍走服务器上传的 `media`。

构建顺序：

```powershell
cd mobile-rn
npm.cmd run catalogue:generate
npx.cmd expo prebuild --platform android --no-install
npm.cmd run catalogue:stage
cd android
.\gradlew.bat :app:assembleDebug
# Release: .\gradlew.bat :app:assembleRelease
```

`android/` 是 gitignore 的生成目录，`catalogue:stage` 必须在每次 `expo prebuild` 后重跑。静图仍来自仓库的 `catalogue/media`，不复制第二份。

许可是非商业 Fork 使用范围：只随客户端分发**未修改的 180 px 素材**，保留 `catalogue/media/NOTICE.md`/`NOTICE.md`，不改图、不单独提取、不用于商业产品。商业发布或更大分辨率需要 Gym visual 授权。

## 验收目标

| 编号 | 前置条件 | 操作 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 已配对实例托管一个目录动作的静图与 MP4，并准备它的别名 ID | 从列表进入详情，播放、暂停、返回、再切后台 | 别名加载同一素材，能播放和暂停；返回或后台时停止播放 |
| 2 | 当前账号有图片、动图和带封面的自定义视频各一项 | 依次进入三个详情并从选择器使用动作 | 图片/动图可读，视频先显示封面再成功播放；使用动作回到原选择流程 |
| 3 | 列表中的内置 MP4 缺失但静图可用；另一个动作无素材 | 进入详情，再断网重试 | 前者可退到静图，后者显示占位；列表仍能收藏、编辑自定义动作或选择动作 |
| 4 | 两个账号媒体不同；当前账号的合法文件一份，哈希不符/401/404 fixture 各一份 | 查看后切账号并查看对应详情 | 只显示当前账号的已验证文件；失败显示回退；临时文件及网络记录可核对账户隔离 |
| 5 | ARM64 真机有有效的内置和自定义短视频 | 逐个播放、暂停和退出详情 | 视频可解码，状态正常，退出后不再占用播放会话；记录机型、编码及结果 |
