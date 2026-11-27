import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "mlx_backend.py"


class FakeTokenizer:
    bos_token_id = 1
    eos_token_id = 2
    pad_token_id = 0
    unk_token_id = 3

    def __init__(self, vocab=None):
        self.vocab = vocab or {"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "hello": 4}

    def get_vocab(self):
        return self.vocab


class MLXSpeculativeTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.sampler_calls = []
        self.processor_calls = []
        mlx = types.ModuleType("mlx")
        mx = types.ModuleType("mlx.core")
        setattr(mx, "metal", types.SimpleNamespace(set_memory_limit=lambda limit: None))
        setattr(mx, "set_memory_limit", lambda limit: None)
        setattr(mx, "eval", lambda value: None)
        setattr(mx, "zeros", lambda shape: None)
        setattr(mlx, "core", mx)

        mlx_lm = types.ModuleType("mlx_lm")

        def stream_generate(
            prompt=None, model=None, tokenizer=None, max_tokens=None, kv_bits=None,
            key_bits=None, value_bits=None, kv_group_size=None,
            quantized_kv_start=None, max_kv_size=None, draft_model=None,
            sampler=None, **kwargs
        ):
            self.calls.append({
                "draft_model": draft_model,
                "num_draft_tokens": kwargs.get("num_draft_tokens"),
                "key_bits": key_bits,
                "value_bits": value_bits,
                "max_kv_size": max_kv_size,
                "kv_bits": kv_bits,
            })
            return iter(())

        setattr(mlx_lm, "stream_generate", stream_generate)
        setattr(mlx_lm, "load", lambda path: (object(), FakeTokenizer()))
        sample_utils = types.ModuleType("mlx_lm.sample_utils")

        def make_sampler(temp=0.0, top_p=0.0, min_p=0.0):
            self.sampler_calls.append({"temp": temp, "top_p": top_p, "min_p": min_p})
            return object()

        def make_logits_processors(repetition_penalty=None, repetition_context_size=20):
            self.processor_calls.append({
                "repetition_penalty": repetition_penalty,
                "repetition_context_size": repetition_context_size,
            })
            return ["repetition-processor"] if repetition_penalty else []

        setattr(sample_utils, "make_sampler", make_sampler)
        setattr(sample_utils, "make_logits_processors", make_logits_processors)
        setattr(mlx_lm, "sample_utils", sample_utils)

        self.original_modules = {
            name: sys.modules.get(name)
            for name in ("mlx", "mlx.core", "mlx_lm", "mlx_lm.sample_utils")
        }
        sys.modules["mlx"] = mlx
        sys.modules["mlx.core"] = mx
        sys.modules["mlx_lm"] = mlx_lm
        sys.modules["mlx_lm.sample_utils"] = sample_utils

        spec = importlib.util.spec_from_file_location("mlx_backend_spec_test", SCRIPT_PATH)
        if spec is None or spec.loader is None:
            raise ImportError(f"Could not load test backend from {SCRIPT_PATH}")
        self.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.backend)

    def tearDown(self):
        sys.modules.pop("mlx_backend_spec_test", None)
        for name, module in self.original_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_speculative_generation_drops_incompatible_kv_options(self):
        draft = object()
        self.backend._stream_generate({
            "model": object(),
            "tokenizer": FakeTokenizer(),
            "prompt": "hello",
            "key_bits": 8,
            "value_bits": 4,
            "max_kv_size": 8192,
        }, {"model": draft, "num_tokens": 3})

        self.assertEqual(len(self.calls), 1)
        self.assertIs(self.calls[0]["draft_model"], draft)
        self.assertEqual(self.calls[0]["num_draft_tokens"], 3)
        self.assertIsNone(self.calls[0]["key_bits"])
        self.assertIsNone(self.calls[0]["value_bits"])
        self.assertIsNone(self.calls[0]["max_kv_size"])

    def test_generation_kwargs_match_current_mlx_sampler_api(self):
        generation_kwargs = self.backend.get_mlx_generation_kwargs({
            "temperature": 0.35,
            "top_p": 0.8,
            "min_p": 0.05,
            "repeat_penalty": 1.25,
            "mlx_sampling": {"repetition_context_size": 16},
        })

        self.assertEqual(self.sampler_calls, [{"temp": 0.35, "top_p": 0.8, "min_p": 0.05}])
        self.assertEqual(self.processor_calls, [{"repetition_penalty": 1.25, "repetition_context_size": 16}])
        self.assertEqual(generation_kwargs["logits_processors"], ["repetition-processor"])

    def test_tokenizer_vocab_mismatch_disables_compatibility(self):
        target = FakeTokenizer()
        draft = FakeTokenizer({"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "hello": 5})
        self.assertFalse(self.backend._tokenizers_compatible(target, draft))
        self.assertTrue(self.backend._tokenizers_compatible(target, FakeTokenizer()))

    def test_draft_load_is_opt_in_and_requires_local_model(self):
        tokenizer = FakeTokenizer()
        self.assertIsNone(self.backend._load_speculative_draft({"mlx_speculative_decoding": {"enabled": False}}, tokenizer))
        self.assertIsNone(self.backend._load_speculative_draft({
            "mlx_speculative_decoding": {"enabled": True, "draft_model": "missing-local-model"}
        }, tokenizer))

        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text("{}", encoding="utf-8")
            result = self.backend._load_speculative_draft({
                "mlx_speculative_decoding": {
                    "enabled": True,
                    "draft_model": directory,
                    "num_draft_tokens": 4,
                }
            }, tokenizer)
        self.assertIsNotNone(result)
        self.assertEqual(result["num_tokens"], 4)


if __name__ == "__main__":
    unittest.main()
