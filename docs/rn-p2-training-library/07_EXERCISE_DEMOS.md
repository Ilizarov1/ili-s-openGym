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

1. 先接静图、详情入口与选取回调，再用 `npx.cmd expo install expo-video --npm` 接播放器并重建 Android。验证内置可播、别名解析和缺视频的静图回退。
2. 为现有 [独立 API fixture](../../mobile-rn/scripts/loopback-api.mjs) 增加媒体启用的场景，准备已入库的视频、封面和动图。核对有效 Bearer、缺文件、损坏文件和换账号，确认临时文件清理和缓存隔离。
3. 用可见模拟器验证播放、暂停、返回及切后台，再做 ARM64 真机解码检查。按 [共用验收](README.md#共用验收) 记录媒体加载结果、截图和候选 APK。
