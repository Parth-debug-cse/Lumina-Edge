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
        mlx = types.ModuleType("mlx")
        mx = types.ModuleType("mlx.core")
        mx.metal = types.SimpleNamespace(set_memory_limit=lambda limit: None)
        mx.eval = lambda value: None
        mx.zeros = lambda shape: None
        mlx.core = mx

        mlx_lm = types.ModuleType("mlx_lm")

        def stream_generate(
            prompt=None, model=None, tokenizer=None, max_tokens=None, kv_bits=None,
            key_bits=None, value_bits=None, kv_group_size=None,
            quantized_kv_start=None, max_kv_size=None, draft_model=None,
            num_draft_tokens=None, sampler=None, **kwargs
        ):
            self.calls.append({
                "draft_model": draft_model,
                "num_draft_tokens": num_draft_tokens,
                "key_bits": key_bits,
                "value_bits": value_bits,
                "max_kv_size": max_kv_size,
                "kv_bits": kv_bits,
            })
            return iter(())

        mlx_lm.stream_generate = stream_generate
        mlx_lm.load = lambda path: (object(), FakeTokenizer())
        sample_utils = types.ModuleType("mlx_lm.sample_utils")
        sample_utils.make_sampler = lambda **kwargs: object()
        mlx_lm.sample_utils = sample_utils

        self.original_modules = {
            name: sys.modules.get(name)
            for name in ("mlx", "mlx.core", "mlx_lm", "mlx_lm.sample_utils")
        }
        sys.modules["mlx"] = mlx
        sys.modules["mlx.core"] = mx
        sys.modules["mlx_lm"] = mlx_lm
        sys.modules["mlx_lm.sample_utils"] = sample_utils

        spec = importlib.util.spec_from_file_location("mlx_backend_spec_test", SCRIPT_PATH)
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
