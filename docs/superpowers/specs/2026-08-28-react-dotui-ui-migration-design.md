# Tasks Recorder React + dotUI 迁移设计

**Date:** 2026-08-28  
**Status:** Approved; implementation in progress  
**Supersedes:** `2026-08-28-react-21st-ui-migration-design.md`

## 1. 决策摘要

Tasks Recorder React Dashboard 采用 dotUI 作为唯一通用 UI system：

```text
React 19 + TypeScript
├── dotUI source components（React Aria Components）
├── dotUI Vercel preset（Geist · 8px · default）
├── Tailwind CSS v4 + dotUI semantic tokens
├── TanStack Query（REST server state + SSE invalidation）
└── SVAR React Gantt（Task Tree / Timeline renderer）
```

不再把 21st.dev、shadcn New York/Radix 或自建 primitive 当作并行基础。dotUI component 通过官方 registry 在开发期写入仓库，运行时、CI 与 release build 不访问 dotui.org。产品特有的 Tree、Timeline bar、NOW marker、column layout 与密集数据表达保留本地实现。

此次迁移只替换 React preview 的 UI system，不改变 taskd、REST/SSE、SQLite、Runtime Registry、Agent adapter、Session resume 与 Scheduler contract。Legacy Dashboard 在 React preview 通过完整 cutover gates 前保持稳定。

## 2. First Principles

### Goal

建立一套可预测、可访问、可维护的交互语言，让 Tasks Recorder 的 Task Tree、Timeline、Scheduler、Session 与 Settings 不再依赖大量散落的原生 control 和 feature-specific CSS。

### Facts

- React 19、TypeScript、Tailwind CSS v4、TanStack Query 与 SVAR React Gantt 已进入 React preview。
- `ui/react/styles/app.css` 已超过 1,200 行；当前通用层只有 6 个 shadcn/Radix 风格 primitive，业务页面仍存在多处原生 `select`、input 与自定义状态样式。
- dotUI 官方要求 React 19、Tailwind CSS 4 与 TypeScript 5，本项目满足前置条件。
- dotUI 官方组件基于 React Aria Components，并使用 `tailwind-variants`、`tailwindcss-react-aria-components`、`tailwindcss-with` 与 `tw-animate-css`。
- dotUI Create 内置 Vercel preset；官方界面标识为 `Geist · 8px · default`，Export 会生成带固定 `preset` 参数的 registry URL。
- Dashboard 必须继续由现有 compiler 输出可离线运行的单个 HTML 文件。

### Assumptions

- “Vercel”指 dotUI 官方内置 preset，而不是手工模仿 Vercel 网站。
- React preview 可以在迁移阶段短期保留尚未替换的 Radix primitive，但最终 cutover gate 不允许两套 primitive system 并存。
- 产品密度以桌面 control plane 为主；触控尺寸通过 responsive adaptation 处理，不以放大所有桌面 control 为代价。

### Constraints

1. 不引入 Next.js、SSR、RSC、云端服务或新的 Web server。
2. 不增加 runtime registry fetch、remote font、CDN asset 或 dotUI credential。
3. dotUI source 进入仓库后由本项目维护；CI/release 不重新下载。
4. React Aria 的 `onPress`、`isDisabled`、selection 与 overlay semantics 必须显式迁移，禁止仅换 import 的伪迁移。
5. SVAR 继续拥有 Tree/Timeline canvas；dotUI 不包裹或重写其内部 renderer。
6. Generic controls 不再通过 `app.css` 仿制组件库；custom CSS 只表达产品结构与 SVAR integration。
7. 本阶段不引入 Agent Elements；会话 UI 在通用 UI system 稳定后单独集成。

### Success Criteria

1. `components.json` 固定 dotUI Vercel preset registry，团队生成结果一致。
2. React surface 不再 import Radix；所有实际存在的通用 Button、Select、SearchField、Tabs、Tooltip 与 Drawer/Dialog 由 dotUI 提供。Tree progress、Timeline bar 与状态映射属于产品数据表达，继续由 Tasks Recorder 定义。
3. 通用页面不再出现裸 `select` 或重复的 button/input/select visual overrides。
4. keyboard、focus、screen reader name、overlay dismissal 与 disabled/loading state 符合 React Aria semantics。
5. single-file/offline build、现有 checks 与 UI tests 通过；产物不含 remote URL。
6. Desktop 与 narrow desktop 的主要 route/state 完成 Playwright visual verification，无 Critical/High visual defect。
7. Legacy 正式入口在 React cutover 前不发生行为变化。

## 3. Target Architecture

```text
ui/react/
├── app/                         # providers, shell, route/view ownership
├── components/
│   └── ui/                      # dotUI source components only
├── features/
│   ├── tasks/                   # toolbar, gantt bridge, details, inbox
│   ├── scheduled/               # schedule list/editor/run review
│   └── settings/                # dashboard preferences
├── lib/                         # api, query, events, preferences
└── styles/
    ├── tokens.css               # dotUI Vercel preset + product aliases
    ├── app.css                  # app shell/layout only
    └── features/                # Tree/Timeline/product-specific styles
```

### Ownership boundaries

- dotUI owns generic control appearance, focus ring, overlay, menu, tooltip, selection, disabled/loading and motion behavior。
- Tasks Recorder owns information architecture, responsive layout, compact density decisions and domain status mapping。
- SVAR owns Tree/Timeline virtualization and row geometry；adapter owns typed projection、selection、scroll、splitter 与 NOW overlay。
- taskd remains the only mutation authority；component state 不复制 server facts。

## 4. Preset and Registry Contract

The approved official preset is:

- Name: `Vercel`
- Preset metadata: `Geist · 8px · default`
- Source: dotUI Create built-in preset gallery

The pinned initialization source is:

```text
https://dotui.org/r/init?preset=rVBrS8MwFP0r5frFQaJZO9fRf3PzWFuXNSGP6Rj97-a2qIggCuZCuI9z7uPcwEN3A4m6N-QE1GOO0AHnq8uP2VqYGSh3PuOkCRTT1RY0NDCXQqIU53FA7V64u5hg8Vqqojr412q7Lx_flS_08l5UZI-VeBC7DStuTZWmJszhO2a_AfbZWmHQ_9aXLqLFL9DVDKIxOlKISpmpXAR325aszJ9MTgEt5dqGDAhvjUqjmygrRFsfn6ijRHqg8urTBrDCTpR8iRKGLVZRihnXeDSBW0CxR6tSYn0fJ_E4NnJEueRD0Rd5V9YPTHs2A_pZ2rMMllD-PmDvOr3Kzp6_5XrnV82-SO9vDc
```

`components.json` 必须注册带同一 preset 的 `@dotui` registry。CLI 只作为显式开发工具使用；项目 build 不执行 init/add。

## 5. Component Mapping

| Current surface | Target dotUI primitive | Migration note |
| --- | --- | --- |
| `button.tsx` / raw buttons | Button / ToggleButton | update `onClick` to `onPress` where semantic activation matters |
| raw search input | SearchField | preserve controlled query and clear behavior |
| raw `select` | Select | use React Aria key selection, never read `event.target.value` |
| status/view/scale groups | SegmentedControl or ToggleButtonGroup | use single-selection semantics and compact size |
| Radix Tabs | Tabs | preserve controlled selected key |
| Radix DropdownMenu | Menu | preserve item names, disabled state and keyboard navigation |
| Radix Tooltip | Tooltip | icon buttons retain explicit accessible names |
| Radix Sheet | Drawer for contextual detail; Modal/Dialog for blocking settings/editor | choose by task semantics, not visual similarity |
| custom status badge/progress | Badge / ProgressBar | domain color mapping stays in feature adapter |
| native loading text | Loader / ProgressCircle | avoid alert-like transient prose |

## 6. Styling Strategy

1. Vercel preset tokens are authoritative for base, text, borders, radii, focus and semantic colors。
2. Existing Tasks Recorder tokens are reduced to product aliases only, such as timeline grid、active task、blocked state 与 NOW marker。
3. Existing generic selectors for `button`、`select`、toolbar tabs、popover 和 form control are deleted as their component migration lands。
4. Feature CSS is colocated or split by feature；`app.css` is no longer the catch-all stylesheet。
5. Geist is bundled locally or resolved to a system-safe fallback；the release artifact never downloads a web font。
6. Dark mode remains the default product mode；light token completeness is preserved by dotUI but is not a cutover requirement unless exposed in Settings。

## 7. Migration Sequence

### Phase 1 — Foundation

- Generate the Vercel preset in an isolated temporary project and review the output。
- Pin dependencies and `components.json` registry。
- Import dotUI base tokens/plugins without overwriting product-specific dirty changes。
- Replace the local Button foundation and migrate App Shell + Tasks Toolbar controls。
- Prove the custom compiler can produce an offline single-file bundle。

### Phase 2 — Navigation and Overlays

- Migrate Tabs、Menu、Tooltip。
- Split the current Sheet usage into Drawer or Modal/Dialog by semantics。
- Verify focus return、Escape、outside dismiss、portal stacking and narrow width behavior。

### Phase 3 — Forms and Status

- Replace all native Search/Input/Select controls。
- Migrate status selector、Scheduler editor、Settings and Inbox filters。
- Consolidate Badge、Progress、Loader and empty/error states。

### Phase 4 — CSS Debt Reduction

- Split feature styles and delete generic control overrides。
- Audit tokens, contrast, typography, density and motion。
- Confirm no Radix import, raw generic select or duplicate primitive remains。

### Phase 5 — Cutover Gate

- Run full existing tests、build、packaged runtime and Playwright multi-state verification。
- Compare Legacy and React feature contracts。
- Only then switch the production Dashboard entry; remove superseded Legacy renderer in a separate reviewable phase。

## 8. Error and Recovery

- Registry unavailable: existing checked-in components and build continue working；only explicit component update is blocked。
- Preset export changes upstream: keep the pinned URL and generated source until an explicit upgrade diff is reviewed。
- React Aria behavior differs: stop the affected component migration, retain the current React preview implementation, and fix the semantic adapter before continuing。
- Tailwind/compiler incompatibility: reproduce against the isolated generated preset, then adjust the build pipeline; do not patch emitted HTML。
- Visual regression: fix the token/component source or feature ownership boundary, not page-specific override chains。

## 9. Johari Review

### Open Area

- Product goal、Vercel preset、dotUI ownership、offline single-file constraint and unchanged backend boundaries are explicit。
- Official component coverage includes the required controls and overlays。

### Hidden Area

- No additional user-owned theme variants or light-mode requirement has been specified；the migration keeps the approved dark control-plane behavior。

### Blind Spots

- React Aria event/selection contracts can silently break existing handlers if treated as DOM controls。
- Official preset may introduce Tailwind plugins that the custom build pipeline has never compiled。
- Geist typography can change perceived density even when pixel heights remain unchanged。
- A compatibility wrapper can reduce short-term diff but become a permanent second API surface。

### Unknown Area and Early Validation

- Generate official output in a temporary directory before applying repository changes。
- Build immediately after foundation import to validate Tailwind plugin and single-file compatibility。
- Migrate one dense surface first（Tasks Toolbar），then inspect at desktop and narrow desktop widths。
- Search imports and raw controls after each phase rather than assuming replacement completeness。

## 10. Consistency Review

- All product choices required by this migration are resolved。
- “Single UI system” is a final-state rule；short-lived migration coexistence is explicitly limited to the React preview and removed by the cutover gate。
- “Vercel” is tied to the official preset export, not an informal visual reference。
- dotUI owns generic interaction；Tasks Recorder and SVAR ownership boundaries do not overlap。
- Runtime/offline requirements are compatible with source-registry installation because all generated source is checked in before build。

## 11. Sources

- [dotUI Installation](https://dotui.org/docs/installation.md)（accessed 2026-08-28）
- [dotUI Components](https://dotui.org/docs/components)（accessed 2026-08-28）
- [dotUI Create / Presets](https://dotui.org/create)（accessed 2026-08-28）
- [React Aria Components](https://react-spectrum.adobe.com/react-aria/components.html)（accessed 2026-08-28）
