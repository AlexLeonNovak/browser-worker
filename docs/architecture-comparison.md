# Architecture Comparison

```mermaid
flowchart LR
    subgraph BEFORE["Before: Two-Container Architecture"]
        direction TB
        N8N[n8n / Client] -->|REST| Worker[Express Worker]
        Worker -->|WebSocket/CDP| Browserless[Browserless Container]
        Browserless -->|Launches| Chrome1[Chromium (no codecs)]
        Worker -.->|Heartbeat 1s| Browserless
        Browserless -.->|OOM crashes| OOM[❌ Memory leak on VOD]
    end

    subgraph AFTER["After: Single-Container Architecture"]
        direction TB
        N8N2[n8n / Client] -->|REST| Worker2[Express Worker + Playwright]
        Worker2 -->|chromium.launch| Chrome2[Google Chrome (full codecs)]
        Worker2 -.->|Direct process control| Clean[✅ Explicit cleanup on TTL]
    end

    BEFORE ~~~ AFTER

    classDef client fill:#1a1a2e,color:#eee,stroke:#00d4ff
    classDef worker fill:#16213e,color:#eee,stroke:#0f3460
    classDef browser fill:#0f3460,color:#eee,stroke:#533483
    classDef problem fill:#3d0000,color:#eee,stroke:#ff0000
    classDef solution fill:#003d00,color:#eee,stroke:#00ff00

    class N8N,N8N2 client
    class Worker,Worker2 worker
    class Browserless,Chrome1,Chrome2 browser
    class OOM problem
    class Clean solution
```
