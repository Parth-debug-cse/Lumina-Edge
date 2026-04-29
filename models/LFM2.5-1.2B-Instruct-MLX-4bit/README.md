---
library_name: mlx
license: other
license_name: lfm1.0
license_link: LICENSE
language:
- en
- ja
- ko
- fr
- es
- de
- it
- pt
- ar
- zh
pipeline_tag: text-generation
tags:
- liquid
- lfm2.5
- edge
- mlx
base_model: LiquidAI/LFM2.5-1.2B-Instruct
---

<div align="center">
  <img 
    src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/2b08LKpev0DNEk6DlnWkY.png" 
    alt="Liquid AI" 
    style="width: 100%; max-width: 100%; height: auto; display: inline-block; margin-bottom: 0.5em; margin-top: 0.5em;"
  />
  <div style="display: flex; justify-content: center; gap: 0.5em; margin-bottom: 1em;">
    <a href="https://playground.liquid.ai/"><strong>Try LFM</strong></a> • 
    <a href="https://docs.liquid.ai/lfm"><strong>Documentation</strong></a> • 
    <a href="https://leap.liquid.ai/"><strong>LEAP</strong></a>
  </div>
</div>

# LFM2.5-1.2B-Instruct-4bit

MLX export of [LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) for Apple Silicon inference.

## Model Details

| Property | Value |
|----------|-------|
| Parameters | 1.2B |
| Precision | 4-bit |
| Group Size | 64 |
| Size | 628 MB |
| Context Length | 128K |

## Recommended Sampling Parameters

| Parameter | Value |
|-----------|-------|
| temperature | 0.1 |
| top_k | 50 |
| top_p | 0.1 |
| repetition_penalty | 1.05 |
| max_tokens | 512 |

## Use with mlx

```bash
pip install mlx-lm
```

```python
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler, make_logits_processors

model, tokenizer = load("LiquidAI/LFM2.5-1.2B-Instruct-4bit")

prompt = "What is the capital of France?"

if tokenizer.chat_template is not None:
    messages = [{"role": "user", "content": prompt}]
    prompt = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )

sampler = make_sampler(temp=0.1, top_k=50, top_p=0.1)
logits_processors = make_logits_processors(repetition_penalty=1.05)

response = generate(
    model,
    tokenizer,
    prompt=prompt,
    max_tokens=512,
    sampler=sampler,
    logits_processors=logits_processors,
    verbose=True,
)
```

## License

This model is released under the [LFM 1.0 License](LICENSE).
