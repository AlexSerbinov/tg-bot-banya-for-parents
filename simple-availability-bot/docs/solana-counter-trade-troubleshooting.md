# Solana Counter-Trade Troubleshooting & Notes

## 1. Current Status Recap
- Solana counter-trade implementation exists but **untested** on MyNet.
- Watcher `a966e8c4-...` for bot 472 is marked `active` after manual DB edit; ensure services respect this on restart.
- Swap script still incomplete (min output + ATA). No on-chain tx executed yet from automated flow.
- USD price + fill-percent values are missing in Solana watcher payloads, so downstream filters relying on them will currently evaluate to `null` or default values.

## 2. Requirements for Further Work
- Access to `SOLANA_FUNDER_PRIVATE_KEY_JSON` contents (already resident in `.env`).
- Permission to send low-value Raydium swaps on mainnet (~$5 budget). Keep 0.01–0.02 SOL reserved for fees.
- Stable Solana RPC endpoint; websockets recommended for watcher responsiveness.
- Postgres credentials (from `.env`) for running SQL diagnostics + migrations if needed.

## 3. Common Failure Modes
| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| Watcher remains `stopped` after restart | API auto-stops watchers on create | Manually run `UPDATE pool_watchers SET status='active' WHERE id='<watcher_uuid>'` then restart pool-indexer. Track upstream issue.
| Swap script throws `Cannot read properties of undefined (poolKeys)` | Raydium pool metadata missing fields | Refresh metadata from Raydium REST; ensure `mintA`, `mintB`, `ammConfig` parsed.
| Transaction fails `0x1` | Missing ATA, wrong `amountOutMin`, compute budget too low | Pre-create ATAs, compute quotes, add `ComputeBudgetProgram.setComputeUnitLimit(250000)` + priority fee.
| Counter-trade not triggered | Watcher filter requires USD price/fill percent | Temporarily patch strategy config to ignore missing fields or implement USD price fetcher.
| `dex-trade-service` rejects order | Strategy config invalid / thresholds not met | Re-check config stored in `DexStrategyConfig` vs spec doc (#11). Ensure amounts/percents align with Raydium decimals.

## 4. Debugging Workflow
1. **Watcher telemetry**: `tail -f apps/pool-indexer-service/logs/*.log | rg 472`.
2. **API inspection**:
   - `curl http://localhost:3343/api/watchers` to verify runtime state.
   - `curl http://localhost:3339/dex-bots/472/strategies` to confirm attached strategy.
3. **DB snapshots**: use `psql $DATABASE_URL` and run queries from test plan.
4. **On-chain tracing**:
   - Use `solana confirm <sig>`
   - Fetch Raydium transaction logs: `connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })`.
5. **Raydium SDK debugging**: set `DEBUG=raydium:*` env var before running swap script to inspect quoting internals.

## 5. Follow-up Enhancements (post-MVP)
1. Implement USD price oracle for Solana pools (TPM or Pyth) to unblock filters requiring USD denominated comparisons.
2. Add fill-percent calculation within pool indexer (needs pool liquidity + swap size).
3. Expand automated tests to cover Solana flows inside CI (mock RPC / local validator) before hitting MyNet.
4. Harden swap script with retry + fee bump logic.

## 6. Artifacts to Capture During Execution
- Shell logs for service startups.
- Swap transaction json (both forward + reverse) saved under `artifacts/swaps/<timestamp>.json`.
- API responses proving watcher + strategy states.
- SQL outputs verifying DB rows before/after tests.
- Summary of SOL spent vs remaining balance.

## 7. When Escalation Is Needed
- If SOL balance <0.02: pause testing, request top-up.
- If RPC unstable (high slot lag), switch endpoint before continuing.
- If watchers still fail after restart + metadata refresh, capture DB rows + service logs and open issue referencing `solana-counter-trade-troubleshooting.md`.
