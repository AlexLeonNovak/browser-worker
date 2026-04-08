# Session Lifecycle

```mermaid
flowchart TD
    Client[Client POST /execute] --> Check{sessionId?}
    Check -->|yes| Lookup{Session exists?}
    Check -->|no| Create[Create new session]

    Lookup -->|yes| Reuse[Reuse existing session]
    Lookup -->|no| Expire[404 Session expired]

    Create --> Launch[chromium.launch headless Chrome]
    Launch --> Context[New browser context with stealth/CSS/JS]
    Context --> Page[Create page]
    Page --> Store[Store in sessions Map with TTL timer]

    Reuse --> UpdateTTL[Update TTL if provided]

    Create --> Execute
    Reuse --> Execute

    Execute[Execute steps sequentially] --> Step{For each step}
    Step --> Action[action: goto, click, fill, screenshot...]
    Action --> Result[Collect result or error]
    Result --> StopOnError{error & stopOnError?}
    StopOnError -->|yes| Break[Stop execution]
    StopOnError -->|no| Step
    Step -->|no more steps| Response

    Break --> Response[Return JSON response]
    Response --> ResetTTL[Reset TTL timer]
    ResetTTL --> Done[Client receives response]

    Store -.->|TTL expires| Cleanup[browser.close + delete from Map]

    classDef client fill:#1F4E79,stroke:#1F4E79,color:#FFFFFF
    classDef process fill:#F0F0F0,stroke:#888888,color:#444444
    classDef decision fill:#FEF9E7,stroke:#B7950B,color:#7D6608
    classDef cleanup fill:#C0392B,stroke:#922B21,color:#FFFFFF
    classDef response fill:#D5F5E3,stroke:#1A7A4A,color:#145A32
    classDef loop fill:#D6E4F0,stroke:#2E75B6,color:#1F4E79

    class Client,Done client
    class Create,Launch,Context,Page,Store,Reuse,UpdateTTL,Execute,Action,Result,Response,ResetTTL process
    class Step loop
    class Check,Lookup,StopOnError decision
    class Cleanup,Cleanup2 cleanup
    class Response response
```
