# Registry component provenance

21st.dev is treated as a source registry, not as a runtime or build dependency. A copied component is admitted only when a concrete product interaction needs it and the following record is complete.

| Component | Source | Retrieved | License | Local owner | Local changes |
| --- | --- | --- | --- | --- | --- |
| None admitted | — | — | — | Tasks Recorder UI | The foundation currently uses audited shadcn-compatible primitives only. |

Before adding a component, record its canonical source URL, retrieval date, license, owner, and every behavior or styling change. CI and release builds must remain network-independent.
