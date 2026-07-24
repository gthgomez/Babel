<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Mermaid Templates — Visualization Skill

**Purpose:** Full template library with domain-specific examples, styling presets, and anti-patterns. Load when the standard templates in SKILL.md need customization for a specific domain or data shape.

---

## 1. Styling Presets

Use these consistent color schemes across all diagrams:

| Context | Fill | Stroke | Use For |
|---------|------|--------|---------|
| Meta | `#1a1a2e` | `#e94560` | Meta-tools, OLS-MCC layer |
| Skill | `#16213e` | `#0f3460` | Regular skills |
| Domain | `#16213e` | `#4e9f3d` | Domain architects |
| Game | `#1a1a2e` | `#e94560` | Godot, game dev skills |
| Mobile | `#1a1a2e` | `#0f3460` | Android, mobile skills |
| Governance | `#1a1a2e` | `#4e9f3d` | Governance, safety skills |
| Overlay | `#1a1a2e` | `#f5a623` | Project/task overlays |
| Deprecated | `#333` | `#666` | Deprecated/superseded skills |

```mermaid
%% Usage:
classDef meta fill:#1a1a2e,stroke:#e94560,color:#fff
class myNode meta
```

---

## 2. Skill Activation Graph — Full Domain Example

### domain_android_kotlin (actual catalog data, June 2026)

```mermaid
graph TD
  android[domain_android_kotlin] --> bundle[skill_android_app_bundle]
  android --> release[skill_android_release_build]
  android --> play[skill_google_play_store]
  android --> comply[skill_android_play_store_compliance]
  android --> amazon[skill_amazon_appstore]
  android --> samsung[skill_samsung_galaxy_store]
  android --> rc[skill_revenuecat_iap]
  android --> billing[skill_google_play_billing]
  android --> compose[skill_jetpack_compose]
  android --> room[skill_android_room]
  android --> game[skill_android_game_development]
  android --> tv[skill_android_tv_game_ux]
  android --> guard[skill_untrusted_input_guard]
  android --> state[skill_autonomous_agent_state_machine]
  android --> async[skill_async_task_delivery]

  guard --> state
  state --> async

  classDef domain fill:#16213e,stroke:#0f3460,color:#fff
  classDef skill fill:#16213e,stroke:#0f3460,color:#fff
  class android domain
  class bundle,release,play,comply,amazon,samsung,rc,billing,compose,room,game,tv,guard,state,async skill
```

### domain_godot_game_dev (actual catalog data, June 2026)

```mermaid
graph TD
  godot[domain_godot_game_dev] --> arch[skill_godot_gdscript_arch]
  godot --> theme[skill_godot_ui_theme]
  godot --> data[skill_godot_data_resources]
  godot --> runtime[skill_godot_ui_runtime]
  godot --> test[skill_godot_testing_ci]
  godot --> export[skill_godot_android_export]
  godot --> input[skill_godot_input_save_audio]
  godot --> perf[skill_godot_performance_mobile]
  godot --> hd2d_render[skill_godot_hd2d_mobile_rendering]
  godot --> hd2d_map[skill_godot_hd2d_map_design]
  godot --> hd2d_ui[skill_godot_hd2d_rpg_ui]
  godot --> jrpg[skill_godot_mobile_jrpg_ux]

  classDef domain fill:#16213e,stroke:#e94560,color:#fff
  classDef skill fill:#16213e,stroke:#e94560,color:#fff
  class godot domain
  class arch,theme,data,runtime,test,export,input,perf,hd2d_render,hd2d_map,hd2d_ui,jrpg skill
```

---

## 3. Meta-Tool Handoff Graph (Static)

```mermaid
graph LR
  ols[ols-compiler<br/>Create/Harden] -->|produces| skills[Skills]
  skills -->|tested by| pt[prompt-tester<br/>Adversarial Test]
  pt -->|critique feeds| sa[skill-auditor<br/>Semantic Audit]
  sa -->|gaps fed back| ols
  skills -->|loaded via| dci[dynamic-context-injector<br/>Relevance Route]
  sa -->|contradictions to| cl[coherence-linter<br/>Cross-Skill Lint]
  cl -->|harmonize via| ols
  skills -->|observed by| obs[ops-observability<br/>Runtime Trace]
  obs -->|drift reports to| ols
  skills -->|visualized by| viz[visualization<br/>Graph Generation]

  classDef meta fill:#1a1a2e,stroke:#e94560,color:#fff
  classDef skill fill:#16213e,stroke:#0f3460,color:#fff
  class ols,pt,sa,dci,cl,obs,viz meta
  class skills skill
```

---

## 4. Workflow Trace Template

### From a real OBSERVE mode run (genericized)

```mermaid
sequenceDiagram
  participant Orchestrator
  participant SWE as SWE Agent
  participant QA as QA Reviewer
  participant Exec as Executor
  participant Obs as OBSERVE

  Orchestrator->>Obs: activate (skill_ops_observability, DESIGN)
  Obs-->>Orchestrator: OPERATIONAL contract emitted
  Orchestrator->>SWE: dispatch plan task
  SWE->>SWE: evidence gathering
  SWE->>SWE: produce plan v1
  Orchestrator->>QA: review plan v1
  QA-->>Orchestrator: REJECT [EVIDENCE-GATE]
  Orchestrator->>SWE: revise → plan v2
  SWE->>SWE: add missing evidence
  Orchestrator->>QA: review plan v2
  QA-->>Orchestrator: PASS
  Orchestrator->>Exec: execute plan v2
  Exec->>Exec: file_write x3
  Exec-->>Orchestrator: EXECUTION_COMPLETE
  Orchestrator->>Obs: activate (skill_ops_observability, OBSERVE)
  Obs->>Obs: capture trace, cost, drift
  Note over Obs: Run: abc123 | Duration: 120s<br/>Cost: 4500 tokens | Verdict: CLEAN
```

### Anti-pattern to avoid

Don't render every tool call individually in a long trace — the diagram becomes unreadable past ~15 interactions. For long runs, group tool calls by category:

```mermaid
sequenceDiagram
  participant Agent
  participant Skills
  participant Tools

  Agent->>Skills: activate (3 skills)
  Skills->>Tools: read x5, write x3, search x2
  Tools-->>Skills: all successful
  Note over Agent: Run: xyz789 | Duration: 300s | Verdict: CLEAN
```

---

## 5. Catalog Heatmap Template

### Current ecosystem (June 2026, approximate)

```mermaid
graph TD
  subgraph Governance [Governance ~45 skills]
    safety[safety: 7]
    pipeline[pipeline: 8]
    audit[audit: 6]
    release[release: 5]
    compliance[compliance: 4]
    ops[ops: 3]
    authoring[authoring: 3]
    workflow[workflow: 4]
    other_gov[other: 5]
  end
  subgraph Mobile [Mobile ~25 skills]
    android[Android Core: 16]
    store[Store: 5]
    testing[mobile testing: 4]
  end
  subgraph Framework [Framework ~10 skills]
    web[Web: 4]
    edge[Edge: 3]
    lang[Language: 3]
  end
  subgraph Game [Game ~12 skills]
    godot_core[Godot Core: 5]
    hd2d[HD-2D: 4]
    platform[Platform: 3]
  end
  subgraph Meta [Meta ~7 skills]
    ols_mcc[OLS-MCC: 6]
    viz[visualization: 1]
  end

  classDef gov fill:#1a1a2e,stroke:#4e9f3d,color:#fff
  classDef mob fill:#1a1a2e,stroke:#0f3460,color:#fff
  classDef fw fill:#1a1a2e,stroke:#16213e,color:#fff
  classDef game fill:#1a1a2e,stroke:#e94560,color:#fff
  classDef meta fill:#1a1a2e,stroke:#f5a623,color:#fff
  class Governance gov
  class Mobile mob
  class Framework fw
  class Game game
  class Meta meta
```

---

## 6. Dependency Graph — Skill Chain Example

Render the full dependency chain for a specific skill to show all transitive deps:

```mermaid
graph LR
  guard[skill_untrusted_input_guard] --> state[skill_autonomous_agent_state_machine]
  state --> async[skill_async_task_delivery]
  state --> lock[skill_workspace_locking]
  lock --> swarm[skill_parallel_swarm_governance]
  swarm --> pipeline[skill_multi_agent_pipeline]
  async --> json[skill_json_output_contract]

  classDef skill fill:#16213e,stroke:#0f3460,color:#fff
  class guard,state,async,lock,swarm,pipeline,json skill
```

---

## 7. Anti-Patterns

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| >20 nodes in a single graph | Unreadable wall of boxes | Split by domain or render aggregated counts |
| Mermaid `graph TD` for sequences | Wrong chart type — arrows don't show temporal order | Use `sequenceDiagram` for traces |
| Inline CSS via `style` attribute | Brittle, doesn't scale | Use `classDef` with consistent presets |
| Fabricating data for missing skills | Misleading diagram | Render empty graph with note, don't guess |
| Embedding raw Mermaid in prose without code fence | Won't render | Always wrap in ` ```mermaid ` fence |
