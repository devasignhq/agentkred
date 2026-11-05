# @agentkred/seller-middleware

Seller middleware for escrowed x402 jobs. A framework-free core with Express and Hono adapters that answers unpaid `POST /jobs` with a signed quote, verifies the escrow before handing off a job, and reports accept and delivery to AgentKred.
