# RN Android scripts

These scripts drive a dedicated, already running Android emulator. They do not use emulator
snapshots; fixture data is written into the Debug app's private SQLite database through `run-as`.
Run them from `mobile-rn/` or from the repository root with the paths shown below.

Prerequisites:

- Debug APK (`android/app/build/outputs/apk/debug/app-debug.apk` by default for the smoke test).
- Metro running and reachable; the smoke script installs `adb reverse tcp:8081 tcp:8081`.
- For `android-regression.ps1`, JDK 17 and Android SDK platform/build-tools 36, plus API
  dependencies installed with `npm.cmd ci` in `api/`.

## fuse-suggestion-check.mjs

```powershell
node --no-warnings .\mobile-rn\scripts\fuse-suggestion-check.mjs
```

Calibrates the zero-result Fuse.js index against the catalogue without an emulator, Metro or a
Debug APK. It checks the Chinese typo sample, the equipment-filtered pool and an unrelated query.

## Five-tab navigation map

The current shell is 首页 / 计划 / 统计 / 动作库 plus the centre 开始 button. Settings moved to the
home gear.

| Old regression step | Current step |
| --- | --- |
| `训练` tab | `首页` or `计划` |
| `历史` tab | `统计` |
| `服务器` tab | `首页` → gear (`设置`) |
| `开始训练` button | `计划` → `训练计划` → `<routine> 更多操作` → `开始训练` |
| Workout plan edit | `计划` → `训练计划` → `<routine> 更多操作` → `编辑计划` |
| Plan row edit | tap the routine row |
| Workout set controls | `Stepper` inputs labelled `<set>重量` / `<set>次数` and the checkbox `<set>完成` |
| Workout menu | `训练菜单` (`更多`) ActionSheet |
| History workout menu | expand the workout row, then `训练操作` ActionSheet |
| Settings close | `返回` |

## five-tab-smoke.ps1

```powershell
.\mobile-rn\scripts\five-tab-smoke.ps1 -Serial emulator-5556 -ResetAppData
```

Checks the five-tab shell, home, settings, plan list/editor, stats, library and the start sheet.
Use this first after a UI change.

## android-regression.ps1

```powershell
.\mobile-rn\scripts\android-regression.ps1 `
  -Apk .\mobile-rn\dist\openGym-RN-debug.apk `
  -Serial emulator-5556 -ResetAppData `
  -FeatureChecks -P1Checks -SupersetChecks
```

P0 runs by default. `-FeatureChecks` adds the rest countdown, background/restart, weight prefill,
set changes, warm-ups and planned backup exercise checks. `-P1Checks` adds history correction,
custom exercises, scheduling, timed/cardio history, notifications, merging and backup files.
`-SupersetChecks` adds the `Superset fixture` scenario:

- plan grouping/unlinking, group name and 73-second rest saved through `/api/data`;
- `A1 → B1 → A2` with an uneven 2/1 set split, no rest between A1 and B1, 73-second round rest;
- a future round blocked until its turn, draft restart, history group fields and API read-back.

The 73-second rest is read live and must show 69–73 seconds and drop 2–5 seconds in a 3-second
window. A complete expiry wait, the notification and long-duration backgrounding remain manual
items unless a separate real-time check is run.

## superset-smoke.ps1

```powershell
.\mobile-rn\scripts\superset-smoke.ps1 `
  -Apk .\mobile-rn\android\app\build\outputs\apk\debug\app-debug.apk `
  -Serial emulator-5556
```

Installs the Debug APK, clears app data and the saved pairing, installs the superset fixture and
verifies:

- plan editor group name/rest (`Push pair`, 73 s), save, reopen and a second workout with the
  new name;
- `A1 → B1 → A2`, no intra-round rest, a 73-second round rest, no rest after the final set;
- force-stop/resume from the correct next set;
- history rendering with `超级组 · <name>`;
- a group without `sgRest` using the longest member rest (40 s, not 25 s);
- creating a new group from two ungrouped exercises, saving, reopening and starting it.

Fixture plans: `超级组推胸 A` (73 s override), `超级组长休息 B` (25/40 member rests) and
`超级组新建 C` (ungrouped). The fixture also seeds `超级组历史样本` for the Stats screen.

The script reads the running countdown with the same `DumpActiveWindow` UiAutomation helper as the
regression, so the once-per-second rest text does not depend on `uiautomator dump` idle waits.
Without `-RealtimeRest`, the full 73-second expiry and notification are reported as `MANUAL`.
With `-RealtimeRest` the expiry is asserted, but the rest-expiry notification remains a manual
item. Do not report a manual item as passed.

On a failure the script writes `failure.png`, `failure-window.xml` and `logcat.txt` next to the
screenshots in `mobile-rn/dist/ui/superset/`. `dist/` is gitignored.

## Local catalogue demonstrations

The RN build carries the 180 px catalogue media for offline exercise details:

```powershell
cd mobile-rn
npm.cmd run catalogue:generate
npx.cmd expo prebuild --platform android --no-install
npm.cmd run catalogue:stage
```

`catalogue:generate` writes `src/catalogueContent.generated.json` and
`src/catalogueMedia.generated.ts`. The 5,632 stills are static `require()` assets bundled by
Metro. The 5,632 MP4 clips are copied to `android/app/src/main/assets/exercise-media/clip/` and
played through `asset:///`; going through Metro's asset registry for both would exceed the
Windows file-handle limit. Run `catalogue:stage` after every `expo prebuild`, because `android/`
is generated.

This is for the non-commercial openGym fork: keep the 180 px media unmodified, ship the Gym
visual notice, and obtain a separate licence for commercial use or larger media.

The Web plan/history modules imported by `src/sharing` still mention Capacitor plugins in dynamic
imports. `metro.config.js` aliases those packages to the inert stubs in `mobile-rn/shims/`, because
Metro resolves every dynamic import up front even though the RN screens never take those branches.

## UI capture and design checks

```powershell
.\mobile-rn\scripts\ui-capture.ps1 -Serial emulator-5556 -Fixture
.\mobile-rn\scripts\ui-fixture.ps1 -Serial emulator-5556
.\mobile-rn\scripts\design-gallery-verify.ps1 -Serial emulator-5556
```

`ui-capture.ps1 -Fixture` writes the same fixture (superset plans plus a planned drop/rest-pause
exercise) and captures the five-tab screens and contact sheets. Deep links use
`opengym://home|plan|stats|library|settings`. Do not add `e2e=1` to scripts that assert real rest
timers: it freezes the workout and rest countdowns for visual-only checks.

The P2 progress/body/import screens have their own deep links for manual checks:

```text
opengym://progress          # 训练进度：PR、1RM、趋势、肌群
opengym://body              # 身体数据：体重、围度、照片
opengym://reminder          # 训练提醒
opengym://history-import    # 第三方历史导入
opengym://plan-share        # 计划分享；?mode=import 直接打开导入
opengym://pair              # 扫描配对二维码
```

The fixture seeds two weigh-ins, two measurement days, an older 100 kg bench session and a local
reminder preference so those screens render without manual setup. The photo picker itself still
needs a test image in the emulator's gallery; `dist/ui/test-photo.png` is generated by the manual
check commands and is not committed.

Run the source gates before any device script:

```powershell
cd mobile-rn
npm.cmd run check
```
