# dotUI source component provenance

Tasks Recorder uses checked-in source components from the official dotUI registry. dotUI is a development-time source registry, not a runtime or release dependency. The selected registry preset is the official `Vercel · Geist · 8px · default` preset pinned in `ui/components.json`.

| Component family | Source | Retrieved | License | Local owner | Local changes |
| --- | --- | --- | --- | --- | --- |
| Button, Loader, Text | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted to `@/lib/cn`; Button API otherwise follows React Aria semantics. |
| Field, Input, SearchField | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted; SearchField forwards the official compact `size` variant. |
| ListBox, Popover, Select | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted; feature adapters map React Aria keys to domain values. |
| Tabs, Tooltip, Separator | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted; product copy remains local. |
| Drawer, Dialog | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Drawer supports a non-modal contextual inspector; close-label copy is localized. |

The upstream license is recorded at [mehdibha/dotUI LICENSE](https://github.com/mehdibha/dotUI/blob/main/LICENSE). CI and release builds use these checked-in files and must remain network-independent. Before adding another registry component, record its source, retrieval date, license, owner, and local behavior changes here.
