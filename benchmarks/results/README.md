# MLX speculative-decoding measurements

This is a local, single-machine benchmark—not a claim about all models or devices. The runner and methodology are in [`scripts/mlx_speculative_benchmark.py`](../../scripts/mlx_speculative_benchmark.py); the full per-trial data is in the adjacent JSON reports.

## Final run

- Hardware: Apple M5, 16 GiB unified memory, macOS 27.2.1
- Runtime: Python 3.12.16, MLX 0.32.5, mlx-lm 0.32.2
- Target: `mlx-community/Qwen2.5-1.5B-Instruct-4bit`, revision `8b403126fc14f14cfc99bb4cfa72ecbc129ea677`
- Draft: `mlx-community/Qwen2.5-0.5B-Instruct-4bit`, revision `a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3`
- Workload: one fixed chat prompt, greedy decoding, maximum 128 tokens, batch size 1; 2 warmups and 20 measured paired iterations per mode, with mode order alternated
- Tested draft length: 2 tokens

| Mode | Mean decode throughput | Throughput 95% CI | p50 generation latency | p95 generation latency | p50 time-to-first-token |
|---|---:|---:|---:|---:|---:|
| Project-configured baseline (`kv_bits=4`) | 115.07 tok/s | 114.54–115.60 | 1.066 s | 1.083 s | 27.0 ms |
| Cache-matched baseline (explicit KV options removed) | 114.07 tok/s | 113.83–114.30 | 1.077 s | 1.086 s | 27.2 ms |
| Speculative (2 draft tokens; target + draft resident) | 130.18 tok/s | 129.88–130.49 | 0.944 s | 0.952 s | 42.1 ms |

The paired speculative speedup was **1.131× versus the configured baseline** (mean gain **13.14%**, paired 95% CI **12.50%–13.78%**) and **1.141× versus the cache-matched baseline** (mean gain **14.13%**, paired 95% CI **13.80%–14.46%**). All 20 speculative outputs exactly matched the configured-baseline output for this prompt. Draft-token acceptance was 52.8%.

The throughput improvement comes with a first-token tradeoff: speculative p50 TTFT was about 56% higher (42.1 ms vs. 27.0 ms), while total generation latency was lower. Loading the draft increased active Metal memory from about 0.872 GB after the target load to 1.153 GB after both models were loaded (approximately 268 MiB additional active memory). This is a decode-throughput optimization, not a universal latency or memory win.

The configured baseline retained the project’s effective `kv_bits=4` option. The speculative path removes explicit KV-cache options for compatibility with MLX speculative generation. The cache-matched baseline removes those same options without speculative decoding to help separate the draft-decoding effect from that cache-setting difference.

## Draft-length screening

The screening reports use 5 measured paired iterations per draft length; treat them as tuning data, not final estimates. The final 20-iteration result above uses the best screening setting.

| Draft tokens | Gain vs configured baseline | Paired 95% CI | Gain vs cache-matched baseline | Paired 95% CI |
|---:|---:|---:|---:|---:|
| 1 | +11.52% | +11.10% to +11.95% | +12.14% | +10.69% to +13.60% |
| 2 | +13.90% | +13.78% to +14.02% | +13.93% | +13.75% to +14.11% |
| 3 | +0.77% | −2.63% to +4.17% | −0.26% | −4.11% to +3.59% |
| 4 | −10.48% | −11.16% to −9.80% | −10.50% | −10.97% to −10.03% |
| 6 | −23.96% | −24.95% to −22.96% | −24.22% | −24.82% to −23.62% |
| 8 | −36.48% | −41.16% to −31.79% | −36.99% | −38.92% to −35.06% |

That result motivated the opt-in default of 2 draft tokens in `config.json`; larger draft lengths were slower for this target/draft pair and workload.

## Reproduction

Download the same model revisions to local MLX model directories, then run:

```bash
python scripts/mlx_speculative_benchmark.py \
  --model /path/to/Qwen2.5-1.5B-Instruct-4bit \
  --draft-model /path/to/Qwen2.5-0.5B-Instruct-4bit \
  --warmup-rounds 2 \
  --iterations 20 \
  --max-tokens 128 \
  --num-draft-tokens 2 \
  --json-output benchmarks/results/my-run.json
```

Speculative decoding remains opt-in because it loads a second model and increases memory use. To use the measured setting, set `mlx_speculative_decoding.enabled` to `true`, set `draft_model` to a compatible local MLX model directory, and keep `num_draft_tokens` at `2` (or benchmark a different value for the intended model pair).

## Scope

The result is specific to this Apple M5, these model revisions, one prompt, greedy batch-1 decoding, and this runtime. It does not establish gains for other prompts, target/draft pairs, context lengths, serving concurrency, or hardware. The exact-match observation is limited to the measured prompt; broader quality and task-level evaluation is still needed for research claims.
