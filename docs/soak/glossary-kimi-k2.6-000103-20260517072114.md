# OpenCode + Kimi K2.6 Dispatcher

The current default execution provider routes requests through **OpenCode**, a local AI agent framework, to **Kimi K2.6** (powered by Moonshot AI) via the **OpenRouter** API gateway.  
OpenRouter handles model selection, load balancing, and transparent failover across multiple upstream providers, ensuring high availability and competitive token pricing.  
Before any prompt is dispatched, OpenCode performs aggressive **environment scrubbing**: it redacts secrets, strips raw env vars from logs, and masks sensitive configuration so that no credentials leak into model context or telemetry.  
The dispatcher manages context-window budgeting, streaming responses, and tool-use loops for the K2.6 model family, which natively supports long-context reasoning and multimodal inputs.  
All outbound traffic is funneled through a single OpenRouter API key, making credential rotation and rate-limit management straightforward and centralized.  
This stack is the soak-test benchmark default because it balances low latency, long-context capability, and robust safety guardrails.