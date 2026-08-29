# dotUI source component provenance

Tasks Recorder uses checked-in source components from the official dotUI registry. dotUI is a development-time source registry, not a runtime or release dependency. The selected registry preset is the official `Vercel · Geist · 8px · default` preset pinned in `ui/components.json`.

| Component family | Source | Retrieved | License | Local owner | Local changes |
| --- | --- | --- | --- | --- | --- |
| Button, Loader, Text | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted to `@/lib/cn`; Button API otherwise follows React Aria semantics. |
| Field, Input, SearchField | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted; SearchField forwards the official compact `size` variant. |
| ListBox, Popover, Select | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted; feature adapters map React Aria keys to domain values. |
| Tabs, Tooltip, Separator | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Import aliases adapted; product copy remains local. |
| Drawer, Dialog | [dotUI registry](https://dotui.org/docs/components) | 2026-08-28 | MIT, copyright dotLabs | Tasks Recorder UI | Drawer supports a non-modal contextual inspector; close-label copy is localized. |
| Conversation, Message, MessageResponse | [Vercel AI Elements](https://github.com/vercel/ai-elements/tree/main/packages/elements/src) | 2026-08-29 | Apache-2.0, copyright Vercel, Inc. | Tasks Recorder UI | Reduced to presentation-only Conversation/Message exports; dotUI owns the scroll control; AI SDK types, downloads, branches, actions, attachments, math, Mermaid and runtime transport are intentionally excluded. Streamdown with the CJK plugin renders streaming Markdown for coding-agent output. The optional Shiki plugin is excluded because it imports the full bundled-language registry and increased the offline single-file Dashboard from 1.3 MiB to 11.5 MiB. |

The upstream license is recorded at [mehdibha/dotUI LICENSE](https://github.com/mehdibha/dotUI/blob/main/LICENSE). CI and release builds use these checked-in files and must remain network-independent. Before adding another registry component, record its source, retrieval date, license, owner, and local behavior changes here.

The AI Elements upstream license is recorded at [vercel/ai-elements LICENSE](https://github.com/vercel/ai-elements/blob/main/LICENSE). Its checked-in adapters never contact Vercel, AI Gateway, or another external service at runtime.
