# Request Interception Flow

```mermaid
flowchart TD
    Page[Page navigation / resource request] --> Route[context.route '**/*' handler]

    Route --> Parse[Extract URL, hostname, resourceType]

    Parse --> AdCheck{Ad blocking enabled?}
    AdCheck -->|no| ForceCheck
    AdCheck -->|yes| Match{URL matches ad patterns?}
    Match -->|yes| Abort[route.abort - block request]
    Match -->|no| ForceCheck

    ForceCheck{Force HTTP active?}
    ForceCheck -->|no| Continue[route.continue]
    ForceCheck -->|yes| IsHTTPS{URL starts with https://?}
    IsHTTPS -->|no| Continue
    IsHTTPS -->|yes| ShouldForce{forceHttp === true OR hostname in forceHttpHosts?}
    ShouldForce -->|no| Continue
    ShouldForce -->|yes| Fetch[route.fetch http:// URL]
    Fetch --> Fulfill[route.fulfill with response]
    Fetch --> Fail{Fetch failed?}
    Fail -->|yes| Continue
    Fail -->|no| Fulfill

    Abort --> Log1[Log: AdBlock blocked URL]
    Fulfill --> Log2[Log: ForceHTTP redirect URL → http://URL]
    Continue --> End[Request proceeds normally]

    classDef start fill:#1F4E79,stroke:#1F4E79,color:#FFFFFF
    classDef decision fill:#FEF9E7,stroke:#B7950B,color:#7D6608
    classDef block fill:#C0392B,stroke:#922B21,color:#FFFFFF
    classDef redirect fill:#2E75B6,stroke:#1F4E79,color:#FFFFFF
    classDef normal fill:#D5F5E3,stroke:#1A7A4A,color:#145A32

    class Page,Route,Parse start
    class AdCheck,ForceCheck,Match,IsHTTPS,ShouldForce,Fail decision
    class Abort,Log1 block
    class Fetch,Fulfill,Log2 redirect
    class Continue,End normal
```
