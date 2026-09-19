# GridSync: ClimateChain Global Hackathon 2026
Track 2: Renewable Energy & Energy Trading. Submissions Oct 5-25, 2026. Submit by Oct 24.
Tagline: Run your devices in the greenest hour, and prove it on-chain.

## What it does
Household sets constraints ("car ready by 7am, 40 kWh"). AI schedules loads into the
cleanest grid hours. A simulated meter emits signed kWh readings. A contract mints an
hourly, meter-tied ERC-1155 certificate. Buyers retire certificates in a dashboard.

## Judging criteria (optimize for these)
Climate Impact, Innovation, Technical Execution (must actually work), Practical
Usefulness (buyers/orgs), Presentation. Devpost needs: track statement, description,
3-5 min demo video, public repo with docs, working prototype.

## Stack
Expo (mobile), Supabase (DB + Edge Functions as oracle/attester), Hardhat +
OpenZeppelin, Base Sepolia, Next.js dashboard, UK Carbon Intensity API (GB only;
present other regions as "plug in Electricity Maps").

## Contract: GreenHourRegistry
- registerMeter(meterId, owner, region)
- postGridHour(region, hourId, gCO2PerKwh, greenCapacityWh)   // oracle only
- attestUsage(meterId, hourId, wh, sig) -> mints ERC-1155
  reverts: AlreadyClaimed (key = hash(meterId, hourId)), HourNotGreen, CapacityExceeded
- retire(certId, amount, beneficiary) -> burn + Retired event
- Events: HourPosted, UsageAttested, Retired

## AI jobs
1. LLM: plain-language constraints -> structured schedule (JSON)
2. Small model: correct API forecast with history
3. Anomaly screen on meter readings before attestation
Final hour selection stays deterministic so the demo never surprises.

## Honest limits (state in README)
Simulated meter, trusted oracle. Production: signed meter data, multiple oracles.

## Rules for Claude
- Keep scope to the MVP above. No extra features.
- Small commits, tests for every revert path.
- Never commit private keys; use .env and a .env.example.